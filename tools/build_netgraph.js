#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const core = require("./netgraph-core.js");
const hierarchy = require("../js/hierarchy.js");

const SOURCE_EXT = /\.(v|sv)$/i;
const HASH_FILE_LIMIT = 400;
const HASH_BYTE_LIMIT = 8 * 1024 * 1024;
const MULTI_ARGS = new Set(["rtl", "include", "blackbox", "blackbox-port", "exclude"]);
const SKIP_DIRS = new Set([
  ".git", ".svn", ".hg", ".rtl-peek", ".xil", ".cache", ".gen", ".runs", ".hw",
  ".sim", ".ip_user_files", "ip_user_files", "xsim.dir", "node_modules",
  "_work", "backup", "outputs"
]);
const SKIP_DIR_SUFFIXES = [".runs", ".cache", ".gen", ".hw", ".sim", ".ip_user_files"];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    let value = true;
    if (next && !next.startsWith("--")) {
      value = next;
      i += 1;
    }
    if (MULTI_ARGS.has(key)) {
      if (!Array.isArray(args[key])) args[key] = [];
      args[key].push(value);
    } else {
      args[key] = value;
    }
  }
  return args;
}

function readText(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
}

function hashText(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function isGeneratedSource(name) {
  return /(_sim_netlist|_syn_rfs|_rfs)\.(v|sv)$/i.test(name) || /_lparam\.vh$/i.test(name);
}

function isTestbench(name) {
  return /^tb_/i.test(name) || /_tb\.(v|sv)$/i.test(name);
}

function shouldSkipDir(name) {
  const lower = name.toLowerCase();
  if (lower.startsWith(".")) return true;
  if (SKIP_DIRS.has(lower)) return true;
  return SKIP_DIR_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function collectFiles(dirs, options) {
  const files = [];
  const seen = new Set();
  const includeTb = Boolean(options && options.includeTb);
  const excludes = (options && options.excludes) || [];

  const add = (file) => {
    const resolved = path.resolve(file);
    const key = resolved.toLowerCase();
    if (seen.has(key)) return;
    const base = path.basename(resolved);
    if (!SOURCE_EXT.test(base)) return;
    if (/\.bak$/i.test(base) || isGeneratedSource(base)) return;
    if (!includeTb && isTestbench(base)) return;
    if (excludes.some((item) => resolved.toLowerCase().includes(String(item).toLowerCase()))) return;
    seen.add(key);
    files.push(resolved);
  };

  const walk = (dir, depth) => {
    if (depth > 16) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) walk(full, depth + 1);
      } else if (entry.isFile()) {
        add(full);
      }
    }
  };

  for (const dir of dirs) {
    const resolved = path.resolve(dir);
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch (_) {
      continue;
    }
    if (stat.isDirectory()) walk(resolved, 0);
    else if (stat.isFile()) add(resolved);
  }
  return files;
}

function defaultRtlDirs(sourceRoot) {
  let entries = [];
  try {
    entries = fs.readdirSync(sourceRoot, { withFileTypes: true });
  } catch (_) {
    return [sourceRoot];
  }
  const srcs = entries.filter((entry) => entry.isDirectory() && /\.srcs$/i.test(entry.name));
  const dirs = [];
  for (const srcsDir of srcs) {
    const root = path.join(sourceRoot, srcsDir.name);
    let inner = [];
    try {
      inner = fs.readdirSync(root, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of inner) {
      if (entry.isDirectory() && /^sources(_\d+)?$/i.test(entry.name)) dirs.push(path.join(root, entry.name));
    }
  }
  return dirs.length ? dirs : [sourceRoot];
}

function moduleIndex(files) {
  const modules = new Map();
  const sources = {};
  for (const file of files) {
    let text;
    try {
      text = readText(file);
    } catch (_) {
      continue;
    }
    sources[path.resolve(file)] = text.split("\n");
    for (const item of hierarchy.parseFile(file, text)) {
      if (!modules.has(item.name)) {
        modules.set(item.name, {
          name: item.name,
          file: path.resolve(file),
          start: item.startLine,
          end: item.endLine
        });
      }
    }
  }
  return { modules, sources };
}

function maskComments(text) {
  let output = "";
  let state = "code";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (state === "code" && char === "/" && next === "/") {
      state = "line";
      output += "  ";
      i += 1;
    } else if (state === "code" && char === "/" && next === "*") {
      state = "block";
      output += "  ";
      i += 1;
    } else if (state === "line" && char === "\n") {
      state = "code";
      output += char;
    } else if (state === "block" && char === "*" && next === "/") {
      state = "code";
      output += "  ";
      i += 1;
    } else {
      output += state === "code" ? char : (char === "\n" ? "\n" : " ");
    }
  }
  return output;
}

function splitTopLevel(text) {
  const items = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) {
      items.push(text.slice(start, i));
      start = i + 1;
    }
  }
  items.push(text.slice(start));
  return items.map((item) => item.trim()).filter(Boolean);
}

function parseBlackboxPorts(file) {
  const text = maskComments(readText(file));
  const header = /\bmodule\s+([A-Za-z_$][\w$]*)\s*(#\s*\([\s\S]*?\))?\s*\(([\s\S]*?)\)\s*;/.exec(text);
  if (!header) throw new Error(`${file} 中找不到端口声明的 module`);
  const name = header[1];
  const portOrder = splitTopLevel(header[3])
    .map((item) => item.replace(/\[[^\]]*\]/g, " ").trim())
    .map((item) => {
      const match = item.match(/([A-Za-z_$][\w$]*)\s*$/);
      return match ? match[1] : "";
    })
    .filter(Boolean);
  const declarations = new Map();
  const declRe = /\b(input|output|inout)\b([^;]*);/g;
  let decl;
  while ((decl = declRe.exec(text))) {
    const direction = decl[1];
    const body = decl[2];
    const range = (body.match(/\[[^\]]*\]/) || [""])[0];
    const names = body
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/\b(signed|unsigned|wire|reg|logic|tri|var|supply0|supply1)\b/g, " ")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => /^[A-Za-z_$][\w$]*$/.test(item));
    for (const item of names) declarations.set(item, { direction, range });
  }
  for (const item of splitTopLevel(header[3])) {
    const match = item.match(/\b(input|output|inout)\b\s*(\[[^\]]*\])?\s*(?:signed|unsigned|wire|reg|logic|tri|var)?\s*([A-Za-z_$][\w$]*)\s*$/);
    if (match) declarations.set(match[3], { direction: match[1], range: match[2] || "" });
  }
  const ports = [];
  for (const portName of portOrder) {
    const info = declarations.get(portName);
    if (!info) {
      throw new Error(`${file} 中端口 ${portName} 缺少方向声明，请用 --blackbox 手写黑盒`);
    }
    ports.push({ name: portName, direction: info.direction, range: info.range });
  }
  return { name, ports };
}

function blackboxSource(moduleName, ports) {
  const items = ports.map((port) => {
    const range = port.range ? `${port.range} ` : "";
    return `${port.direction} ${range}${port.name}`;
  });
  return `module ${moduleName} (${items.join(", ")});\nendmodule\n`;
}

function collectBlackboxModules(files) {
  const names = new Set();
  for (const file of files) {
    const text = maskComments(readText(file));
    const re = /\bmodule\s+([A-Za-z_$][\w$]*)/g;
    let match;
    while ((match = re.exec(text))) names.add(match[1]);
  }
  return names;
}

function quoteWindowsArgument(value) {
  const text = String(value);
  return /[\s"&|<>^()\\]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function runTool(command, args, options) {
  if (process.platform !== "win32") return spawnSync(command, args, options);
  const commandLine = [command, ...args].map(quoteWindowsArgument).join(" ");
  return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", commandLine], options);
}

function runVerilator(tempDir, top, fileList, includes, extraFiles, prefix) {
  const treeName = `${prefix}.tree.json`;
  const metaName = `${prefix}.meta.json`;
  const args = [
    "--json-only",
    "--Wno-fatal",
    "--top-module",
    top,
    "--json-only-output",
    treeName,
    "--json-only-meta-output",
    metaName,
    "-f",
    "compile.f"
  ];
  const lines = [];
  for (const dir of includes) lines.push(`-I"${path.resolve(dir).replace(/\\/g, "/")}"`);
  for (const file of [...fileList, ...extraFiles]) lines.push(`"${path.resolve(file).replace(/\\/g, "/")}"`);
  fs.writeFileSync(path.join(tempDir, "compile.f"), `${lines.join("\n")}\n`, "utf8");
  const command = process.platform === "win32" ? "verilator.cmd" : "verilator";
  const result = runTool(command, args, {
    cwd: tempDir,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  const treePath = path.join(tempDir, treeName);
  const metaPath = path.join(tempDir, metaName);
  const diagnostics = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (!fs.existsSync(treePath) || !fs.existsSync(metaPath)) {
    throw new Error(`Verilator 没有生成 JSON AST\n${diagnostics}`);
  }
  return { treePath, metaPath, diagnostics };
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

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    const repaired = text.replace(/("filename"\s*:\s*")([^"]*)(")/g, (match, head, value, tail) =>
      head + value.replace(/\\/g, "\\\\") + tail
    );
    return JSON.parse(repaired);
  }
}

function canonicalMap(files) {
  const map = new Map();
  for (const file of files) map.set(path.normalize(path.resolve(file)).toLowerCase(), path.resolve(file));
  return map;
}

function pathKey(file, sourceRoot) {
  const relative = path.relative(sourceRoot, file);
  if (!relative) return ".";
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.replace(/\\/g, "/");
  }
  return null;
}

function resolveInput(value, base) {
  const text = String(value);
  if (path.isAbsolute(text)) return path.resolve(text);
  const fromCwd = path.resolve(text);
  if (fs.existsSync(fromCwd)) return fromCwd;
  return path.resolve(base, text);
}

function emptyShard(name) {
  return {
    name,
    file: "<blackbox>",
    start: 0,
    end: 0,
    ports: [],
    signals: [],
    cells: [],
    assignments: [],
    uses: {}
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceRoot = path.resolve(args["source-root"] || process.cwd());
  const rtlDirs = (args.rtl && args.rtl.length ? args.rtl : defaultRtlDirs(sourceRoot))
    .map((dir) => resolveInput(dir, sourceRoot));
  const outputDir = path.resolve(sourceRoot, args.out || path.join(".rtl-peek", "netgraph"));
  const top = String(args.top || "");
  if (!top) throw new Error("缺少 --top <顶层模块>");

  const includes = (args.include || []).map((dir) => resolveInput(dir, sourceRoot));
  const blackboxFiles = (args.blackbox || []).map((file) => resolveInput(file, sourceRoot));
  const blackboxPortFiles = (args["blackbox-port"] || []).map((file) => resolveInput(file, sourceRoot));
  const files = collectFiles(rtlDirs, { includeTb: args["include-tb"], excludes: args.exclude || [] });
  if (!files.length) throw new Error(`扫描范围内没有找到 .v/.sv：${rtlDirs.join(", ")}`);

  const indexed = moduleIndex(files);
  if (!indexed.modules.has(top)) throw new Error(`扫描结果中找不到顶层模块 ${top}`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-netgraph-"));
  try {
    const generatedBlackboxes = [];
    for (const file of blackboxPortFiles) {
      const parsed = parseBlackboxPorts(file);
      generatedBlackboxes.push(parsed.name);
      fs.writeFileSync(path.join(tempDir, `bb_${parsed.name}.v`), blackboxSource(parsed.name, parsed.ports), "utf8");
    }
    for (const file of blackboxFiles) {
      if (!fs.existsSync(file)) throw new Error(`黑盒文件不存在：${file}`);
    }
    const extraFiles = [
      ...blackboxFiles,
      ...generatedBlackboxes.map((name) => path.join(tempDir, `bb_${name}.v`))
    ];
    const version = getVerilatorVersion(tempDir);
    const canonical = canonicalMap(files);
    const shards = new Map();
    const addTree = (run) => {
      const tree = parseJsonLoose(fs.readFileSync(run.treePath, "utf8"));
      const meta = parseJsonLoose(fs.readFileSync(run.metaPath, "utf8"));
      const filesByCode = new Map();
      for (const [code, info] of Object.entries(meta.files || {})) {
        const filename = path.resolve(String(info.filename || ""));
        filesByCode.set(code, {
          ...info,
          canonical: canonical.get(path.normalize(filename).toLowerCase()) || filename
        });
      }
      const treeModules = (tree.modulesp || []).filter((module) => indexed.modules.has(module.name));
      const modulesByAddr = new Map((tree.modulesp || []).map((module) => [module.addr, module]));
      const context = {
        filesByCode,
        modulesByAddr,
        modulesByName: indexed.modules,
        sources: indexed.sources
      };
      let added = 0;
      treeModules.forEach((module) => {
        if (!shards.has(module.name)) {
          const shard = core.buildModuleShard(module, context);
          const absoluteFile = path.isAbsolute(shard.file)
            ? shard.file
            : path.resolve(sourceRoot, shard.file);
          shard.file = pathKey(absoluteFile, sourceRoot) || path.basename(absoluteFile);
          shards.set(module.name, shard);
          added += 1;
        }
      });
      return { added, diagnostics: run.diagnostics };
    };

    const mainRun = addTree(runVerilator(tempDir, top, files, includes, extraFiles, "main"));
    let designModuleCount = mainRun.added;
    let allDiagnostics = mainRun.diagnostics;

    const sourceIndex = hierarchy.buildIndex(files);
    const missing = [...indexed.modules.keys()].filter((name) => !shards.has(name));
    const missingSet = new Set(missing);
    const extraRoots = missing.filter((name) =>
      !(sourceIndex.instancesByType.get(name) || [])
        .some((parent) => missingSet.has(parent.parentModule))
    );
    for (const root of extraRoots) {
      try {
        const prefix = `root_${root.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
        const run = runVerilator(tempDir, root, files, includes, extraFiles, prefix);
        const result = addTree(run);
        designModuleCount += result.added;
        allDiagnostics += `\n${result.diagnostics}`;
      } catch (error) {
        allDiagnostics += `\n%Warning: extra root ${root} skipped: ${String(error.message || error).split("\n")[0]}`;
      }
    }

    const blackboxNames = new Set([
      ...generatedBlackboxes,
      ...collectBlackboxModules(blackboxFiles)
    ]);
    for (const name of blackboxNames) {
      if (!shards.has(name)) shards.set(name, emptyShard(name));
    }

    const modules = Object.fromEntries(shards);
    const instances = [];
    const instanceByPath = {};
    for (const root of [top, ...extraRoots]) {
      if (!shards.has(root)) continue;
      const info = core.instantiateModules(modules, root);
      for (const item of info.instances) {
        if (instanceByPath[item.path]) continue;
        instanceByPath[item.path] = item;
        instances.push(item);
      }
    }
    if (!instances.length) throw new Error(`没有找到顶层实例：${top}`);

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
    let hashBytes = 0;
    for (const file of files) hashBytes += fs.statSync(file).size;
    const withHashes = files.length <= HASH_FILE_LIMIT && hashBytes <= HASH_BYTE_LIMIT;
    for (const file of files) {
      const key = pathKey(file, sourceRoot);
      if (withHashes && key) sourceHashes[key] = hashText(fs.readFileSync(file));
    }
    const sourceMtimes = {};
    for (const file of [...files, ...blackboxFiles]) {
      const key = pathKey(file, sourceRoot);
      if (key) sourceMtimes[key] = fs.statSync(file).mtimeMs;
    }
    for (const file of blackboxPortFiles) {
      const key = pathKey(file, sourceRoot);
      if (key) sourceMtimes[key] = fs.statSync(file).mtimeMs;
    }
    const combinedHash = hashText(Object.entries(sourceHashes).map(([file, hash]) => `${file}:${hash}`).join("\n"));
    const signalCount = [...shards.values()].reduce((sum, shard) => sum + shard.signals.length, 0);
    const assignmentCount = [...shards.values()].reduce((sum, shard) => sum + shard.assignments.length, 0);
    const cellCount = [...shards.values()].reduce((sum, shard) => sum + shard.cells.length, 0);

    const manifest = {
      formatVersion: core.FORMAT_VERSION,
      parser: version,
      generatedAt: new Date().toISOString(),
      top,
      sourceHash: combinedHash,
      sourceFiles: sourceHashes,
      sourceMtimes,
      modules: moduleManifest,
      instances,
      instanceByPath,
      scope: {
        sourceRoot: ".",
        rtlDirs: rtlDirs.map((dir) => pathKey(dir, sourceRoot)).filter(Boolean),
        includes: includes.map((dir) => pathKey(dir, sourceRoot)).filter(Boolean),
        blackboxes: [...blackboxNames].sort()
      },
      stats: {
        modules: shards.size,
        designModules: designModuleCount,
        roots: [top, ...extraRoots],
        instances: instances.length,
        signals: signalCount,
        cells: cellCount,
        assignments: assignmentCount,
        sourceFiles: files.length,
        hashed: withHashes,
        sourceLines: files.reduce((sum, file) => sum + indexed.sources[path.resolve(file)].length, 0)
      },
      boundary: "端口连接来自 Verilator elaborate AST；内部引用来自赋值 AST。IP/BD 黑盒只保留边界端口，不展开内部。复杂位选、拼接和宏展开保留为表达式连接，不做形式化等价证明。"
    };

    core.writeGraph(outputDir, manifest, shards);
    console.log(`netgraph: ${outputDir}`);
    console.log(`${manifest.parser} · ${manifest.stats.designModules} design modules · ${manifest.stats.instances} instances · ${manifest.stats.signals} signals`);
    console.log(`source files: ${files.length}${withHashes ? " (sha256)" : " (mtime only)"} · blackboxes: ${[...blackboxNames].sort().join(", ") || "none"}`);
    const warningLines = allDiagnostics.split(/\r?\n/).filter((line) => /^%(Error|Warning)/.test(line));
    if (warningLines.length) {
      console.log(`verilator diagnostics: ${warningLines.length} (first: ${warningLines[0]})`);
    }
  } finally {
    if (!args["keep-temp"]) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } else {
      console.log(`temp: ${tempDir}`);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(`build_netgraph: ${error.message}`);
  process.exitCode = 1;
}
