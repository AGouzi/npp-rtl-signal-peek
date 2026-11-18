#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const FORMAT_VERSION = 1;
const ASSIGN_TYPES = new Set(["ASSIGN", "ASSIGNW", "ASSIGNDLY"]);
const SKIP_OBJECT_KEYS = new Set([
  "type",
  "name",
  "addr",
  "loc",
  "origName",
  "verilogName",
  "dtypep",
  "modp",
  "varp",
  "varScopep",
  "classOrPackagep",
  "modVarp",
  "modPTypep",
  "sensIfacep",
  "classOrPackagep"
]);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function hashText(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function parseLoc(loc, filesByCode) {
  const match = String(loc || "").match(/^([^,]+),(\d+):(\d+),(\d+):(\d+)$/);
  if (!match) return null;
  const fileInfo = filesByCode.get(match[1]);
  if (!fileInfo) return null;
  return {
    file: fileInfo.canonical || fileInfo.filename,
    line: Number(match[2]),
    column: Number(match[3]),
    endLine: Number(match[4]),
    endColumn: Number(match[5])
  };
}

function sourceLine(sources, file, line) {
  const lines = sources[file];
  return lines ? lines[Number(line) - 1] || "" : "";
}

function sourceTextAt(sources, locInfo) {
  if (!locInfo) return "";
  const line = sourceLine(sources, locInfo.file, locInfo.line);
  if (!line) return "";
  if (locInfo.endLine === locInfo.line) {
    return line.slice(Math.max(0, locInfo.column - 1), Math.max(0, locInfo.endColumn - 1));
  }
  return line.slice(Math.max(0, locInfo.column - 1));
}

function widthFromSource(sources, locInfo) {
  const line = sourceLine(sources, locInfo && locInfo.file, locInfo && locInfo.line);
  const match = line.match(/\[[^\]]+\]/);
  return match ? match[0] : "";
}

function collectVarRefs(node, result, seen) {
  if (!node || typeof node !== "object") return result;
  if (seen.has(node)) return result;
  seen.add(node);
  if (node.type === "VARREF" && node.varp) {
    result.push({ name: node.name, varp: node.varp, loc: node.loc });
    return result;
  }
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_OBJECT_KEYS.has(key) || typeof value === "string") continue;
    if (Array.isArray(value)) {
      value.forEach((item) => collectVarRefs(item, result, seen));
    } else if (value && typeof value === "object") {
      collectVarRefs(value, result, seen);
    }
  }
  return result;
}

function collectLValueRefs(node, result, seen) {
  if (!node || typeof node !== "object" || seen.has(node)) return result;
  seen.add(node);
  if (node.type === "VARREF" && node.varp) {
    result.push({ name: node.name, varp: node.varp, loc: node.loc });
    return result;
  }
  if (node.type === "SEL" || node.type === "ARRAYSEL") {
    (node.fromp || []).forEach((item) => collectLValueRefs(item, result, seen));
    return result;
  }
  if (node.type === "CONCAT") {
    (node.lhsp || []).forEach((item) => collectLValueRefs(item, result, seen));
    (node.rhsp || []).forEach((item) => collectLValueRefs(item, result, seen));
    return result;
  }
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_OBJECT_KEYS.has(key) || typeof value === "string") continue;
    if (Array.isArray(value)) value.forEach((item) => collectLValueRefs(item, result, seen));
    else if (value && typeof value === "object") collectLValueRefs(value, result, seen);
  }
  return result;
}

function collectNodes(root, type) {
  const found = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (node.type === type) {
      found.push(node);
      return;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") walk(value);
    }
  };
  walk(root);
  return found;
}

function assignmentKind(type) {
  if (type === "ASSIGNDLY") return "时序赋值";
  if (type === "ASSIGNW") return "阻塞赋值";
  return "连续赋值";
}

function useKind(role) {
  if (role === "assign-lhs") return "赋值驱动";
  if (role === "assign-rhs") return "表达式使用";
  return "内部引用";
}

function buildModuleShard(moduleNode, context) {
  const {
    filesByCode,
    modulesByAddr,
    modulesByName,
    sources
  } = context;
  const moduleInfo = modulesByName.get(moduleNode.name);
  const vars = collectNodes(moduleNode, "VAR");
  const cells = collectNodes(moduleNode, "CELL");
  const varByAddr = new Map(vars.map((item) => [item.addr, item]));
  const varNames = new Set(vars
    .filter((item) => item.varType !== "GPARAM" && item.varType !== "LPARAM")
    .map((item) => item.name));

  const signals = vars
    .filter((item) => item.varType !== "GPARAM" && item.varType !== "LPARAM")
    .map((item) => {
      const loc = parseLoc(item.loc, filesByCode);
      return {
        name: item.name,
        kind: String(item.varType || "").toLowerCase(),
        direction: String(item.direction || "NONE").toLowerCase(),
        width: widthFromSource(sources, loc),
        line: loc ? loc.line : 0
      };
    })
    .filter((item) => item.line)
    .sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));

  const ports = signals
    .filter((item) => item.direction !== "none")
    .map((item) => ({ ...item }));
  const portNames = new Set(ports.map((item) => item.name));

  const uses = new Map();
  const assignments = [];
  const assignmentKeys = new Set();
  const useKeys = new Set();
  const traversalSeen = new Set();

  const addUse = (ref, line, role) => {
    if (!ref || !varNames.has(ref.name) || !line) return;
    const key = `${ref.name}|${line}|${role}`;
    if (useKeys.has(key)) return;
    useKeys.add(key);
    if (!uses.has(ref.name)) uses.set(ref.name, []);
    uses.get(ref.name).push({
      line,
      role,
      kind: useKind(role)
    });
  };

  const resolveRefs = (nodes) => {
    const refs = [];
    const seen = new Set();
    (nodes || []).forEach((node) => collectVarRefs(node, refs, seen));
    const unique = [];
    const keys = new Set();
    refs.forEach((ref) => {
      if (!varByAddr.has(ref.varp) || !varNames.has(ref.name)) return;
      const key = `${ref.name}|${ref.varp}`;
      if (keys.has(key)) return;
      keys.add(key);
      unique.push(ref);
    });
    return unique;
  };

  const resolveTargetRefs = (nodes) => {
    const refs = [];
    const seen = new Set();
    (nodes || []).forEach((node) => collectLValueRefs(node, refs, seen));
    const unique = [];
    const keys = new Set();
    refs.forEach((ref) => {
      if (!varByAddr.has(ref.varp) || !varNames.has(ref.name)) return;
      const key = `${ref.name}|${ref.varp}`;
      if (keys.has(key)) return;
      keys.add(key);
      unique.push(ref);
    });
    return unique;
  };

  const walk = (node) => {
    if (!node || typeof node !== "object" || traversalSeen.has(node)) return;
    traversalSeen.add(node);

    if (node.type === "VARREF") {
      const loc = parseLoc(node.loc, filesByCode);
      addUse({ name: node.name }, loc && loc.line, "use");
      return;
    }
    if (node.type === "CELL" || node.type === "VAR") return;

    if (ASSIGN_TYPES.has(node.type)) {
      const loc = parseLoc(node.loc, filesByCode);
      const line = loc && loc.line;
      const lhsAll = resolveRefs(node.lhsp);
      const lhs = resolveTargetRefs(node.lhsp);
      const rhs = resolveRefs(node.rhsp);
      lhs.forEach((ref) => addUse(ref, line, "assign-lhs"));
      const targetKeys = new Set(lhs.map((ref) => `${ref.name}|${ref.varp}`));
      lhsAll
        .filter((ref) => !targetKeys.has(`${ref.name}|${ref.varp}`))
        .forEach((ref) => addUse(ref, line, "assign-rhs"));
      rhs.forEach((ref) => addUse(ref, line, "assign-rhs"));
      if (line && lhs.length && rhs.length) {
        const key = `${line}|${lhs.map((ref) => ref.name).join(",")}|${rhs.map((ref) => ref.name).join(",")}`;
        if (!assignmentKeys.has(key)) {
          assignmentKeys.add(key);
          assignments.push({
            line,
            kind: assignmentKind(node.type),
            lhs: [...new Set(lhs.map((ref) => ref.name))],
            rhs: [...new Set(rhs.map((ref) => ref.name))]
          });
        }
      }
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      if (SKIP_OBJECT_KEYS.has(key) || typeof value === "string") continue;
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") walk(value);
    }
  };

  (moduleNode.stmtsp || []).forEach(walk);

  const signalNames = new Set(signals.map((item) => item.name));
  const normalizedUses = {};
  [...uses.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([name, rows]) => {
      if (!signalNames.has(name)) return;
      normalizedUses[name] = rows
        .filter((row, index, all) => all.findIndex((other) =>
          other.line === row.line && other.role === row.role
        ) === index)
        .sort((a, b) => a.line - b.line || a.role.localeCompare(b.role));
    });

  const normalizedCells = cells
    .map((cell) => {
      const loc = parseLoc(cell.loc, filesByCode);
      const child = modulesByAddr.get(cell.modp);
      if (!loc || !child) return null;
      const childVars = collectNodes(child, "VAR");
      const childVarByAddr = new Map(childVars.map((item) => [item.addr, item]));
      const pins = (cell.pinsp || []).map((pin) => {
        const pinLoc = parseLoc(pin.loc, filesByCode);
        const modVar = childVarByAddr.get(pin.modVarp);
        const refs = resolveRefs(pin.exprp);
        return {
          port: pin.name,
          line: pinLoc ? pinLoc.line : 0,
          direction: modVar ? String(modVar.direction || "NONE").toLowerCase() : "none",
          expr: pin.exprp && pin.exprp[0]
            ? sourceTextAt(sources, parseLoc(pin.exprp[0].loc, filesByCode)).trim()
            : "",
          refs: [...new Set(refs.map((ref) => ref.name))]
        };
      }).filter((pin) => pin.line && pin.port);
      return {
        name: cell.name,
        module: child.name,
        line: loc.line,
        pins
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));

  return {
    name: moduleNode.name,
    file: moduleInfo.file,
    start: moduleInfo.start,
    end: moduleInfo.end,
    ports,
    signals,
    cells: normalizedCells,
    assignments: assignments.sort((a, b) => a.line - b.line),
    uses: normalizedUses
  };
}

function instantiateModules(modules, top) {
  const instances = [];
  const paths = new Map();
  const stack = new Set();

  const walk = (moduleName, instancePath, parent, cell) => {
    const module = modules[moduleName];
    if (!module || paths.has(instancePath)) return;
    const record = {
      path: instancePath,
      module: moduleName,
      parent: parent || null,
      cell: cell || null,
      depth: instancePath.split("/").length - 1
    };
    paths.set(instancePath, record);
    instances.push(record);
    if (stack.has(moduleName)) return;
    const nextStack = new Set(stack);
    nextStack.add(moduleName);
    module.cells.forEach((item) => {
      walk(item.module, `${instancePath}/${item.name}`, instancePath, item.name);
    });
  };

  walk(top, top, null, null);
  return {
    instances,
    instanceByPath: Object.fromEntries(instances.map((item) => [item.path, item]))
  };
}

function quoteWindowsArgument(value) {
  const text = String(value);
  if (!/[\s"&|<>^()]/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function runTool(command, args, options) {
  if (process.platform !== "win32") {
    return spawnSync(command, args, options);
  }
  const commandLine = [command, ...args].map(quoteWindowsArgument).join(" ");
  return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", commandLine], options);
}

function runVerilator(tempDir, top, files) {
  const args = [
    "--json-only",
    "--Wno-fatal",
    "--top-module",
    top,
    "--json-only-output",
    "netgraph.tree.json",
    "--json-only-meta-output",
    "netgraph.meta.json",
    ...files
  ];
  const command = process.platform === "win32" ? "verilator.cmd" : "verilator";
  const result = runTool(command, args, {
    cwd: tempDir,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024
  });
  const treePath = path.join(tempDir, "netgraph.tree.json");
  const metaPath = path.join(tempDir, "netgraph.meta.json");
  if (!fs.existsSync(treePath) || !fs.existsSync(metaPath)) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`Verilator 没有生成 JSON AST\n${details}`);
  }
  return {
    treePath,
    metaPath,
    warnings: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
    command: `${command} ${args.join(" ")}`
  };
}

function getVerilatorVersion(tempDir) {
  const command = process.platform === "win32" ? "verilator.cmd" : "verilator";
  const result = runTool(command, ["--version"], {
    cwd: tempDir,
    encoding: "utf8",
    windowsHide: true
  });
  return String(result.stdout || result.stderr || "verilator-unknown").trim();
}

function writeGraph(outputDir, manifest, shards) {
  const resolvedOutput = path.resolve(outputDir);
  const modulesDir = path.join(resolvedOutput, "modules");
  if (path.dirname(modulesDir) !== resolvedOutput) {
    throw new Error(`拒绝写入异常目录: ${modulesDir}`);
  }
  ensureDir(modulesDir);
  shards.forEach((shard, name) => {
    const fileName = manifest.modules[name].shard.split("/").pop();
    fs.writeFileSync(path.join(modulesDir, fileName), JSON.stringify(shard), "utf8");
  });
  fs.writeFileSync(path.join(resolvedOutput, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = path.resolve(__dirname, "..");
  const dataPath = path.resolve(projectRoot, args.data || "data.js");
  const outputDir = path.resolve(projectRoot, args.out || "netgraph");
  const top = String(args.top || "demo_top");
  const snapshot = loadSnapshot(dataPath);
  const designModules = snapshot.modules.filter((module) => module.file);
  const designFiles = [...new Set(designModules.map((module) => module.file))];
  if (!designFiles.length) throw new Error("快照中没有设计模块源码");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-netgraph-"));
  try {
    designFiles.forEach((file) => {
      const info = snapshot.files[file];
      if (!info) throw new Error(`缺少源码文件: ${file}`);
      fs.writeFileSync(path.join(tempDir, path.basename(file)), String(info.code || ""), "utf8");
    });

    const compileFiles = designFiles.map((file) => path.basename(file));
    const verilator = runVerilator(tempDir, top, compileFiles);
    const version = getVerilatorVersion(tempDir);
    const tree = JSON.parse(fs.readFileSync(verilator.treePath, "utf8"));
    const meta = JSON.parse(fs.readFileSync(verilator.metaPath, "utf8"));
    const filesByCode = new Map(Object.entries(meta.files || {}));
    const modulesByName = new Map(snapshot.modules.map((module) => [module.name, module]));
    const treeModules = (tree.modulesp || []).filter((module) => modulesByName.has(module.name));
    const modulesByAddr = new Map(treeModules.map((module) => [module.addr, module]));

    const sources = {};
    designFiles.forEach((file) => {
      sources[file] = String(snapshot.files[file].code || "").replace(/\r\n?/g, "\n").split("\n");
    });

    const context = {
      filesByCode,
      modulesByAddr,
      modulesByName,
      sources
    };
    const shards = new Map();
    treeModules.forEach((module) => {
      shards.set(module.name, buildModuleShard(module, context));
    });

    const modules = Object.fromEntries([...shards.entries()].map(([name, shard]) => [name, shard]));
    const hierarchy = instantiateModules(modules, top);
    if (!hierarchy.instances.length) throw new Error(`没有找到顶层实例: ${top}`);

    const moduleManifest = {};
    shards.forEach((shard, name) => {
      const fileName = `${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`;
      moduleManifest[name] = {
        file: shard.file,
        start: shard.start,
        end: shard.end,
        ports: shard.ports.length,
        signals: shard.signals.length,
        cells: shard.cells.length,
        assignments: shard.assignments.length,
        shard: `modules/${fileName}`
      };
    });

    const sourceHashes = {};
    designFiles.sort().forEach((file) => {
      sourceHashes[file] = hashText(String(snapshot.files[file].code || ""));
    });
    const combinedHash = hashText(Object.entries(sourceHashes).map(([file, hash]) => `${file}:${hash}`).join("\n"));
    const signalCount = [...shards.values()].reduce((sum, shard) => sum + shard.signals.length, 0);
    const assignmentCount = [...shards.values()].reduce((sum, shard) => sum + shard.assignments.length, 0);
    const cellCount = [...shards.values()].reduce((sum, shard) => sum + shard.cells.length, 0);

    const manifest = {
      formatVersion: FORMAT_VERSION,
      parser: version,
      generatedAt: new Date().toISOString(),
      top,
      sourceHash: combinedHash,
      sourceFiles: sourceHashes,
      modules: moduleManifest,
      instances: hierarchy.instances,
      instanceByPath: hierarchy.instanceByPath,
      stats: {
        modules: shards.size,
        instances: hierarchy.instances.length,
        signals: signalCount,
        cells: cellCount,
        assignments: assignmentCount,
        sourceLines: designFiles.reduce((sum, file) => sum + sources[file].length, 0)
      },
      boundary: "端口连接来自 Verilator elaborate AST；内部引用来自赋值 AST。复杂位选、拼接和宏展开保留为表达式连接，不做形式化等价证明。"
    };

    writeGraph(outputDir, manifest, shards);
    console.log(`netgraph: ${outputDir}`);
    console.log(`${manifest.parser} · ${manifest.stats.modules} modules · ${manifest.stats.instances} instances · ${manifest.stats.signals} signals`);
    if (verilator.warnings) {
      const warningLines = verilator.warnings.split(/\r?\n/).filter((line) => /^%Warning|^%Error/.test(line));
      if (warningLines.length) {
        console.log(`verilator diagnostics: ${warningLines.length} (first: ${warningLines[0]})`);
      }
    }
  } finally {
    if (!args["keep-temp"]) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

module.exports = {
  FORMAT_VERSION,
  buildModuleShard,
  instantiateModules,
  parseLoc,
  hashText,
  ensureDir,
  writeGraph
};
