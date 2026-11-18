"use strict";

const fs = require("fs");
const path = require("path");

const MAX_INDEX_MS = 2500;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 4;
const MAX_NODES = 80;
const MAX_RECORDS = 160;
const MAX_MODULE_RECORDS = 64;
const MAX_LINE_CACHE = 12;

const KEYWORDS = new Set([
  "module", "endmodule", "input", "output", "inout", "wire", "reg", "logic",
  "signed", "unsigned", "integer", "bit", "var", "tri", "wand", "wor",
  "supply0", "supply1", "parameter", "localparam", "assign", "always",
  "always_ff", "always_comb", "always_latch", "initial", "final", "begin",
  "end", "if", "else", "case", "casex", "casez", "endcase", "for", "while",
  "repeat", "forever", "function", "endfunction", "task", "endtask",
  "generate", "endgenerate", "genvar", "ifdef", "ifndef", "endif", "define",
  "include", "timescale", "default_nettype", "posedge", "negedge", "or",
  "and", "not", "xor", "nand", "nor", "xnor", "buf", "bufif0", "bufif1",
  "notif0", "notif1", "primitive", "endprimitive", "interface",
  "endinterface", "package", "endpackage", "modport", "typedef", "struct",
  "enum", "union", "return", "break", "continue", "fork", "join", "join_any",
  "join_none", "wait", "disable", "edge", "default", "property",
  "endproperty", "assert", "assume", "cover", "sequence", "endsequence"
]);

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskCode(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (match) => " ".repeat(match.length))
    .replace(/"(?:\\.|[^"\\])*"/g, (match) => " ".repeat(match.length));
}

function maskLine(line) {
  return line
    .replace(/\/\/[^\n]*/g, (match) => " ".repeat(match.length))
    .replace(/"(?:\\.|[^"\\])*"/g, (match) => " ".repeat(match.length));
}

function buildLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function lineAt(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle - 1;
  }
  return Math.max(1, low);
}

function findMatching(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractPorts(body, baseOffset, starts) {
  const ports = new Map();
  const re = /\b(input|output|inout)\b([^;]*?)(?=\b(?:input|output|inout)\b|;)/g;
  let match;
  while ((match = re.exec(body))) {
    const direction = match[1];
    const line = lineAt(starts, baseOffset + match.index);
    const cleaned = match[2]
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/\b(wire|reg|logic|signed|unsigned|integer|bit|var|tri|wand|wor|supply0|supply1)\b/g, " ");
    for (const part of cleaned.split(",")) {
      const nameMatch = part.match(/([A-Za-z_$][\w$]*)\s*$/);
      if (!nameMatch || KEYWORDS.has(nameMatch[1])) continue;
      ports.set(nameMatch[1], { name: nameMatch[1], direction, line });
    }
  }
  return ports;
}

function extractPins(text, baseOffset, starts) {
  const pins = [];
  let cursor = 0;
  while (cursor < text.length) {
    const dot = text.indexOf(".", cursor);
    if (dot < 0) break;
    const match = /^\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(text.slice(dot));
    if (!match) {
      cursor = dot + 1;
      continue;
    }
    const open = dot + match[0].length - 1;
    const close = findMatching(text, open);
    if (close < 0) break;
    pins.push({
      port: match[1],
      expr: text.slice(open + 1, close).trim(),
      line: lineAt(starts, baseOffset + dot)
    });
    cursor = close + 1;
  }
  return pins;
}

function extractInstances(body, baseOffset, starts) {
  const instances = [];
  const startRe = /(?:^|[;\n])\s*([A-Za-z_$][\w$]*)\b/g;
  let match;
  while ((match = startRe.exec(body))) {
    const type = match[1];
    if (KEYWORDS.has(type)) continue;
    let cursor = startRe.lastIndex;
    const skipSpace = () => {
      while (cursor < body.length && /\s/.test(body[cursor])) cursor += 1;
    };
    skipSpace();
    if (body[cursor] === "#") {
      cursor += 1;
      skipSpace();
      if (body[cursor] !== "(") continue;
      const paramClose = findMatching(body, cursor);
      if (paramClose < 0) continue;
      cursor = paramClose + 1;
      skipSpace();
    }
    const nameMatch = /^([A-Za-z_$][\w$]*)/.exec(body.slice(cursor));
    if (!nameMatch || KEYWORDS.has(nameMatch[1])) continue;
    const name = nameMatch[1];
    cursor += name.length;
    skipSpace();
    if (body[cursor] !== "(") continue;
    const close = findMatching(body, cursor);
    if (close < 0) continue;
    let after = close + 1;
    while (after < body.length && /\s/.test(body[after])) after += 1;
    if (body[after] !== ";") continue;
    instances.push({
      type,
      name,
      line: lineAt(starts, baseOffset + match.index),
      pins: extractPins(body.slice(cursor + 1, close), baseOffset + cursor + 1, starts)
    });
    startRe.lastIndex = close + 1;
  }
  return instances;
}

function identifierList(text) {
  const result = [];
  const re = /\b[A-Za-z_$][\w$]*\b/g;
  let match;
  while ((match = re.exec(text))) {
    if (KEYWORDS.has(match[0])) continue;
    result.push(match[0]);
  }
  return result;
}

function extractAssigns(body, baseOffset, starts) {
  const assigns = [];
  const re = /\bassign\s+([^;=]+?)\s*=\s*([^;]+);/g;
  let match;
  while ((match = re.exec(body))) {
    const lhs = match[1].replace(/\[[^\]]*\]/g, " ").trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(lhs)) continue;
    assigns.push({
      line: lineAt(starts, baseOffset + match.index),
      lhs,
      rhs: identifierList(match[2])
    });
  }
  return assigns;
}

function parseFile(file, text) {
  const masked = maskCode(text);
  const starts = buildLineStarts(masked);
  const modules = [];
  const re = /\bmodule\s+([A-Za-z_$][\w$]*)/g;
  let match;
  while ((match = re.exec(masked))) {
    const startOffset = match.index;
    const endRe = /\bendmodule\b/g;
    endRe.lastIndex = startOffset;
    const end = endRe.exec(masked);
    const endOffset = end ? end.index + end[0].length : masked.length;
    const body = masked.slice(startOffset, endOffset);
    modules.push({
      name: match[1],
      file,
      startLine: lineAt(starts, startOffset),
      endLine: lineAt(starts, Math.max(startOffset, endOffset - 1)),
      ports: extractPorts(body, startOffset, starts),
      instances: extractInstances(body, startOffset, starts),
      assigns: extractAssigns(body, startOffset, starts)
    });
    re.lastIndex = endOffset;
  }
  return modules;
}

function buildIndex(files, options = {}) {
  const started = Date.now();
  const maxIndexMs = Number(options.maxIndexMs) > 0 ? Number(options.maxIndexMs) : MAX_INDEX_MS;
  const maxIndexBytes = Number(options.maxIndexBytes) > 0 ? Number(options.maxIndexBytes) : MAX_INDEX_BYTES;
  const maxFileBytes = Number(options.maxFileBytes) > 0 ? Number(options.maxFileBytes) : MAX_FILE_BYTES;
  const modules = new Map();
  const byFile = new Map();
  const instancesByType = new Map();
  let totalBytes = 0;
  let partial = false;
  for (const file of files) {
    if (Date.now() - started > maxIndexMs) {
      partial = true;
      break;
    }
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (_) {
      continue;
    }
    if (!stat.isFile() || stat.size > maxFileBytes) continue;
    let text;
    try {
      text = fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
    } catch (_) {
      continue;
    }
    const size = Buffer.byteLength(text, "utf8");
    if (totalBytes + size > maxIndexBytes) {
      partial = true;
      break;
    }
    totalBytes += size;
    const parsed = parseFile(file, text);
    if (!parsed.length) continue;
    byFile.set(path.resolve(file).toLowerCase(), parsed);
    for (const module of parsed) {
      if (!modules.has(module.name)) modules.set(module.name, module);
      for (const instance of module.instances) {
        const list = instancesByType.get(instance.type) || [];
        list.push({ parentModule: module.name, parentFile: file, ...instance });
        instancesByType.set(instance.type, list);
      }
    }
  }
  return {
    modules,
    byFile,
    instancesByType,
    lineCache: new Map(),
    partial,
    bytes: totalBytes,
    files: files.length
  };
}

function getLines(index, file) {
  const key = path.resolve(file).toLowerCase();
  if (index.lineCache.has(key)) return index.lineCache.get(key);
  let lines = null;
  try {
    lines = fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n").split("\n");
  } catch (_) {
    lines = null;
  }
  if (index.lineCache.size >= MAX_LINE_CACHE) {
    index.lineCache.delete(index.lineCache.keys().next().value);
  }
  index.lineCache.set(key, lines);
  return lines;
}

function moduleAt(index, file, line) {
  const modules = index.byFile.get(path.resolve(file).toLowerCase()) || [];
  return modules.find((module) => line >= module.startLine && line <= module.endLine) || modules[0] || null;
}

function isTestbench(name, file) {
  const moduleName = String(name || "").toLowerCase();
  const baseName = path.basename(String(file || "")).toLowerCase();
  return /^tb_/.test(moduleName) || /_tb$/.test(moduleName) ||
    /^tb_/.test(baseName) || /_tb\.(v|sv)$/.test(baseName);
}

function detectKind(maskedLine, signal) {
  if (/\b(input|output|inout)\b/.test(maskedLine)) return "port";
  if (/\.[A-Za-z_$][\w$]*\s*\(/.test(maskedLine)) return "instance";
  if (new RegExp(`\\b${escapeRegExp(signal)}\\b\\s*(<=|=)`).test(maskedLine)) return "assign-lhs";
  if (/[<>=]/.test(maskedLine)) return "assign-rhs";
  return "use";
}

function firstIdentifier(text) {
  const match = /\b[A-Za-z_$][\w$]*\b/.exec(String(text || ""));
  return match && !KEYWORDS.has(match[0]) ? match[0] : "";
}

function moduleRecords(index, module, signal, sink, options) {
  const lines = getLines(index, module.file);
  if (!lines) return;
  const word = new RegExp(`\\b${escapeRegExp(signal)}\\b`);
  const lean = Boolean(options && options.lean);
  for (let line = module.startLine; line <= Math.min(module.endLine, lines.length); line += 1) {
    const source = lines[line - 1];
    if (!source || !source.includes(signal)) continue;
    const masked = maskLine(source);
    if (!word.test(masked)) continue;
    if (/^\s*(wire|reg|logic|integer|genvar|localparam)\b/.test(masked) && !masked.includes("=")) continue;
    const occurrences = (masked.match(new RegExp(`\\b${escapeRegExp(signal)}\\b`, "g")) || []).length;
    if (occurrences === 1 && new RegExp(`\\.${escapeRegExp(signal)}\\s*\\(`).test(masked)) continue;
    const kind = detectKind(masked, signal);
    if (lean && kind === "use") continue;
    sink({
      file: module.file,
      line,
      module: module.name,
      instancePath: "",
      kind,
      lookupSignal: signal,
      detail: `模块索引 · ${signal}`,
      highlightSignals: [signal],
      hierarchy: true
    });
  }
}

function query({
  files,
  file,
  line,
  signal,
  maxDepth = MAX_DEPTH,
  maxNodes = MAX_NODES,
  maxRecords = MAX_RECORDS,
  maxIndexMs = MAX_INDEX_MS,
  maxIndexBytes = MAX_INDEX_BYTES,
  maxFileBytes = MAX_FILE_BYTES
}) {
  if (!file || !signal) return null;
  const index = buildIndex(files, { maxIndexMs, maxIndexBytes, maxFileBytes });
  const start = moduleAt(index, file, line);
  if (!start) return null;
  const startInTestbench = isTestbench(start.name, start.file);

  const records = [];
  const seen = new Map();
  const perModule = new Map();
  const visited = new Set();
  const queue = [{ module: start, signal, path: start.name, depth: 0, via: "start", parent: null }];
  let truncated = false;

  const push = (record) => {
    const key = `${record.file}|${record.line}|${record.kind}|${record.module}|${record.lookupSignal}`;
    const existing = seen.get(key);
    if (existing) {
      if (String(existing.detail).startsWith("模块索引") && !String(record.detail).startsWith("模块索引")) {
        existing.detail = record.detail;
        existing.highlightSignals = [...new Set([...(existing.highlightSignals || []), ...(record.highlightSignals || [])])];
      }
      return;
    }
    if (records.length >= maxRecords) {
      truncated = true;
      return;
    }
    if ((perModule.get(record.module) || 0) >= MAX_MODULE_RECORDS) {
      truncated = true;
      return;
    }
    seen.set(key, record);
    perModule.set(record.module, (perModule.get(record.module) || 0) + 1);
    records.push(record);
  };

  while (queue.length) {
    if (records.length >= maxRecords || visited.size >= maxNodes) {
      truncated = true;
      break;
    }
    const node = queue.shift();
    const nodeKey = `${node.path}|${node.signal}`;
    if (visited.has(nodeKey)) continue;
    visited.add(nodeKey);

    moduleRecords(index, node.module, node.signal, (record) => {
      push({ ...record, instancePath: node.path });
    }, { lean: node.via === "assign" });

    for (const instance of node.module.instances) {
      for (const pin of instance.pins) {
        if (!new RegExp(`\\b${escapeRegExp(node.signal)}\\b`).test(pin.expr)) continue;
        const pinSignals = identifierList(pin.expr);
        push({
          file: node.module.file,
          line: pin.line,
          module: node.module.name,
          instancePath: node.path,
          kind: "instance",
          lookupSignal: node.signal,
          detail: `${instance.name}.${pin.port}(${pin.expr || "..."})`,
          highlightSignals: [...new Set([node.signal, pin.port, ...pinSignals])],
          hierarchy: true
        });
        const child = index.modules.get(instance.type);
        if (!child) continue;
        const childPort = child.ports.get(pin.port);
        if (childPort) {
          push({
            file: child.file,
            line: childPort.line,
            module: child.name,
            instancePath: `${node.path}/${instance.name}`,
            kind: "port",
            lookupSignal: pin.port,
            detail: `${instance.type}.${pin.port} ${childPort.direction}`,
            highlightSignals: [pin.port, node.signal],
            hierarchy: true
          });
        }
        if (node.depth + 1 <= maxDepth) {
          queue.push({
            module: child,
            signal: pin.port,
            path: `${node.path}/${instance.name}`,
            depth: node.depth + 1,
            via: "instance",
            parent: { module: node.module, signal: node.signal, path: node.path }
          });
        }
      }
    }

    if (node.module.ports.has(node.signal)) {
      let parents = index.instancesByType.get(node.module.name) || [];
      if (!startInTestbench) {
        parents = parents.filter((item) => !isTestbench(item.parentModule, item.parentFile));
      }
      if (node.parent) {
        const instanceName = node.path.split("/").pop();
        const exact = parents.filter((item) =>
          item.parentModule === node.parent.module.name && item.name === instanceName);
        parents = exact.length ? exact : parents.filter((item) => item.parentModule === node.parent.module.name);
      }
      parents = parents.slice(0, node.parent ? 1 : 8);
      for (const parentInstance of parents) {
        const pin = parentInstance.pins.find((item) => item.port === node.signal);
        if (!pin) continue;
        const pinSignals = identifierList(pin.expr);
        const parentPath = node.path.includes("/")
          ? node.path.slice(0, node.path.lastIndexOf("/"))
          : parentInstance.parentModule;
        push({
          file: parentInstance.parentFile,
          line: pin.line,
          module: parentInstance.parentModule,
          instancePath: parentPath,
          kind: "instance",
          lookupSignal: firstIdentifier(pin.expr) || node.signal,
          detail: `${parentInstance.name}.${pin.port}(${pin.expr || "..."})`,
          highlightSignals: [...new Set([node.signal, ...pinSignals])],
          hierarchy: true
        });
        const parentModule = index.modules.get(parentInstance.parentModule);
        if (!parentModule || node.depth + 1 > maxDepth) continue;
        for (const name of pinSignals.slice(0, 3)) {
          queue.push({
            module: parentModule,
            signal: name,
            path: parentPath,
            depth: node.depth + 1,
            via: "instance",
            parent: null
          });
        }
      }
    }

    for (const assign of node.via === "assign" ? [] : node.module.assigns) {
      if (assign.lhs === node.signal && assign.rhs.length === 1 && assign.rhs[0] !== node.signal) {
        if (node.depth + 1 <= maxDepth) {
          queue.push({ module: node.module, signal: assign.rhs[0], path: node.path, depth: node.depth + 1, via: "assign", parent: node.parent });
        }
      } else if (assign.rhs.length === 1 && assign.rhs[0] === node.signal) {
        if (node.depth + 1 <= maxDepth) {
          queue.push({ module: node.module, signal: assign.lhs, path: node.path, depth: node.depth + 1, via: "assign", parent: node.parent });
        }
      }
    }
  }

  return {
    module: start.name,
    records,
    partial: index.partial,
    truncated,
    stats: {
      modules: index.modules.size,
      files: index.files,
      bytes: index.bytes,
      nodes: visited.size,
      visited: [...visited]
    }
  };
}

module.exports = { query, parseFile, buildIndex };
