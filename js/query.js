#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("./netgraph-client.js");
const hierarchy = require("./hierarchy.js");

const SOURCE_EXT = /\.(v|sv|vh|svh)$/i;
const PROJECT_MARKER_EXTS = new Set([".xpr", ".xise", ".qpf", ".qsf", ".gprj", ".prj", ".spj"]);
const SOURCE_DIR_NAMES = new Set(["rtl", "rtl_src", "src", "srcs", "sources", "source", "hdl", "verilog", "sv", "v"]);
const SCAN_DIR_NAMES = new Set([...SOURCE_DIR_NAMES, "tests", "test", "tb", "sim"]);
const SKIP_DIR_NAMES = new Set(["node_modules", "__pycache__", "xsim.dir", "outputs", "backup", "_work"]);
const SKIP_DIR_SUFFIXES = [".cache", ".runs", ".hw", ".sim", ".ip_user_files", ".gen"];
const DEFAULT_UP_LEVELS = 2;
const DEFAULT_DOWN_LEVELS = 8;
const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_INDEX_MS = 2000;
const DEFAULT_EXCLUDE_DIRS = ["archive", "backup", "doc", "ai_output", ".xil"];
const MARKER_SEARCH_LEVELS = 6;
const SCOPE_PROBE_MS = 300;
const MAX_SOURCE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_MS = 4000;
const NETGRAPH_CACHE_DIR = ".rtl-peek";
const NETGRAPH_MANIFEST = "manifest.json";
const NETGRAPH_STALE_TOLERANCE_MS = 2000;
const NETGRAPH_HASH_LIMIT_BYTES = 8 * 1024 * 1024;
const NETGRAPH_HASH_MAX_FILES = 400;

function isSourceDirName(name) {
  return SOURCE_DIR_NAMES.has(name) || /^(sources|sim)_\d+$/.test(name);
}

function isScanDirName(name) {
  return SCAN_DIR_NAMES.has(name) || /^(sources|sim)_\d+$/.test(name);
}

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

function numberArg(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function parseList(value, fallback) {
  if (value === undefined || value === true) return fallback.slice();
  return String(value)
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
}

function clean(value) {
  return String(value == null ? "" : value)
    .replace(/[\t\r\n]+/g, " ")
    .trim();
}

function readText(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
}

function splitLines(file) {
  return readText(file).split("\n");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWithin(file, root) {
  if (!file || !root) return false;
  const target = path.resolve(file).toLowerCase();
  const base = path.resolve(root).toLowerCase().replace(/[\\/]+$/, "");
  return target === base || target.startsWith(`${base}${path.sep}`);
}

function fileSize(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat.size : -1;
  } catch (_) {
    return -1;
  }
}

function resolveRoots(value) {
  if (typeof value !== "string") return [];
  return String(value || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
}

function findConfiguredRoot(file, roots) {
  let match = "";
  for (const root of roots) {
    if (isWithin(file, root) && root.length > match.length) match = root;
  }
  return match;
}

function hasProjectMarker(dir, file) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return false;
  }
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    if (entry.isDirectory()) {
      if (name.endsWith(".srcs")) {
        if (!file || isWithin(file, path.join(dir, entry.name))) return true;
      } else if (name.endsWith(".runs")) {
        return true;
      }
    } else if (PROJECT_MARKER_EXTS.has(path.extname(name))) {
      return true;
    }
  }
  return false;
}

function isProtectedRoot(dir) {
  const resolved = path.resolve(dir).toLowerCase();
  if (path.dirname(resolved) === resolved) return true;
  const home = process.env.USERPROFILE ? path.resolve(process.env.USERPROFILE).toLowerCase() : "";
  if (home) {
    if (resolved === home) return true;
    if (resolved === path.dirname(home)) return true;
    for (const name of ["desktop", "documents", "downloads", "onedrive"]) {
      if (resolved === path.join(home, name)) return true;
    }
  }
  const publicDir = process.env.PUBLIC ? path.resolve(process.env.PUBLIC).toLowerCase() : "";
  return Boolean(publicDir && resolved === publicDir);
}

function findProjectMarkerRoot(start, file, options) {
  let dir = path.resolve(start);
  for (let depth = 0; depth <= MARKER_SEARCH_LEVELS; depth += 1) {
    if (hasProjectMarker(dir, file)) {
      const probe = probeScope(dir, { ...options, smart: true });
      if (probe.count > 0 && !probe.capped) return dir;
      if (probe.capped) break;
    }
    if (isProtectedRoot(dir)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

function loadPinnedRoots(file) {
  if (!file) return [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (_) {
    return [];
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const roots = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const dir = line.slice(0, tab).trim();
    const root = line.slice(tab + 1).trim() || dir;
    try {
      roots.push({ dir: path.resolve(dir), root: path.resolve(root) });
    } catch (_) {
      // Ignore malformed entries.
    }
  }
  roots.sort((a, b) => b.dir.length - a.dir.length);
  return roots;
}

function findPinnedRoot(file, pinnedRoots) {
  return (pinnedRoots || []).find((item) => isWithin(file, item.dir)) || null;
}

function probeScope(root, options) {
  const probe = { ...options, maxFiles: options.maxFiles + 1, maxScanMs: SCOPE_PROBE_MS };
  const files = collectSourceFiles(root, probe);
  return {
    count: files.length,
    capped: files.length > options.maxFiles || probe.truncatedReason === "files",
    timedOut: probe.truncatedReason === "time"
  };
}

function chooseLocalRoot(start, options) {
  const resolvedStart = path.resolve(start);
  if (isProtectedRoot(resolvedStart)) {
    return { root: resolvedStart, kind: "container", container: true };
  }
  const candidates = [];
  let dir = resolvedStart;
  for (let level = 0; level <= options.upLevels; level += 1) {
    candidates.push(dir);
    if (isProtectedRoot(dir)) break;
    const parent = path.dirname(dir);
    if (parent === dir || isProtectedRoot(parent)) break;
    dir = parent;
  }
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    const probe = probeScope(candidate, options);
    if (probe.count > 0 && !probe.capped) return { root: candidate, kind: "local" };
  }
  return { root: candidates[0] || resolvedStart, kind: "local", truncated: true };
}

function resolveScope(file, configuredRoots, options) {
  const pinned = findPinnedRoot(file, options.pinnedRoots);
  const configured = findConfiguredRoot(file, configuredRoots);
  if (pinned && (!configured || pinned.dir.length > configured.length)) {
    return { root: pinned.root, kind: "pinned" };
  }
  if (configured) return { root: configured, kind: "config" };
  const start = path.dirname(path.resolve(file));
  const marker = findProjectMarkerRoot(start, file, options);
  if (marker) return { root: marker, kind: "marker" };
  return chooseLocalRoot(start, options);
}

function excludeDirMatch(name, full, options) {
  const excludes = options && options.excludeDirs;
  if (!excludes || !excludes.length) return false;
  const lowerName = name.toLowerCase();
  for (const raw of excludes) {
    const item = String(raw || "").trim();
    if (!item) continue;
    const lower = item.toLowerCase();
    if (lower.includes("/") || lower.includes("\\")) {
      if (isWithin(full, item)) return true;
    } else if (lower === lowerName) {
      return true;
    }
  }
  return false;
}

function shouldSkipDir(name, full, options) {
  if (name.startsWith(".")) return true;
  if (SKIP_DIR_NAMES.has(name)) return true;
  if (SKIP_DIR_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  if ((name === "ip" || name === "bd" || name === "ipshared") && /\.srcs[\\/]/i.test(full)) return true;
  if (excludeDirMatch(name, full, options)) return true;
  return false;
}

function isGeneratedSource(name) {
  return /(_sim_netlist|_syn_rfs|_rfs)\.(v|sv)$/i.test(name) || /_lparam\.vh$/i.test(name);
}

function readDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
}

function collectFromDir(root, files, started, options) {
  const maxFiles = options.maxFiles || DEFAULT_MAX_FILES;
  const maxDepth = Number.isFinite(options.downLevels) ? options.downLevels : DEFAULT_DOWN_LEVELS;
  const maxScanMs = Number(options.maxScanMs) > 0 ? options.maxScanMs : MAX_SCAN_MS;
  const markTruncated = (reason) => {
    if (!options.truncated) {
      options.truncated = true;
      options.truncatedReason = reason;
    }
  };
  const walk = (dir, depth) => {
    if (files.length >= maxFiles) {
      markTruncated("files");
      return;
    }
    if (Date.now() - started > maxScanMs) {
      markTruncated("time");
      return;
    }
    if (depth > maxDepth) return;
    const entries = readDir(dir);
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        markTruncated("files");
        return;
      }
      if (Date.now() - started > maxScanMs) {
        markTruncated("time");
        return;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name.toLowerCase(), full, options)) walk(full, depth + 1);
        continue;
      }
      if (entry.name.startsWith(".")) continue;
      if (!SOURCE_EXT.test(entry.name) || isGeneratedSource(entry.name)) continue;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch (_) {
        continue;
      }
      if (!stat.isFile() || stat.size > MAX_SOURCE_FILE_BYTES) continue;
      files.push(full);
    }
  };
  walk(root, 0);
}

function collectRootSources(root, entries, files, started, options) {
  const maxFiles = options.maxFiles || DEFAULT_MAX_FILES;
  const maxScanMs = Number(options.maxScanMs) > 0 ? options.maxScanMs : MAX_SCAN_MS;
  const knownDirs = new Set(
    entries
      .filter((entry) => entry.isDirectory() && isScanDirName(entry.name.toLowerCase()))
      .map((entry) => entry.name.toLowerCase())
  );
  for (const entry of entries) {
    if (files.length >= maxFiles) {
      options.truncated = true;
      options.truncatedReason = "files";
      return;
    }
    if (Date.now() - started > maxScanMs) {
      options.truncated = true;
      options.truncatedReason = "time";
      return;
    }
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (knownDirs.has(entry.name.toLowerCase())) collectFromDir(full, files, started, options);
      continue;
    }
    if (entry.name.startsWith(".") || !SOURCE_EXT.test(entry.name) || isGeneratedSource(entry.name)) continue;
    let stat;
    try {
      stat = fs.statSync(full);
    } catch (_) {
      continue;
    }
    if (stat.isFile() && stat.size <= MAX_SOURCE_FILE_BYTES) files.push(full);
  }
}

function collectSourceFiles(root, options = {}) {
  const files = [];
  if (!root || !fs.existsSync(root)) return files;
  options.truncated = false;
  options.truncatedReason = "";
  const smart = Boolean(options.smart);
  const maxFiles = options.maxFiles || DEFAULT_MAX_FILES;
  const started = Date.now();
  const entries = readDir(root);

  const srcsDirs = entries.filter((entry) => entry.isDirectory() && entry.name.toLowerCase().endsWith(".srcs"));
  if (srcsDirs.length) {
    for (const srcs of srcsDirs) {
      const srcsPath = path.join(root, srcs.name);
      for (const sub of readDir(srcsPath)) {
        if (!sub.isDirectory()) continue;
        const name = sub.name.toLowerCase();
        if (/^(sources|sim)_\d+$/.test(name) || name === "sources" || name === "sim") {
          collectFromDir(path.join(srcsPath, sub.name), files, started, options);
        }
      }
    }
    if (files.length < maxFiles) collectRootSources(root, entries, files, started, options);
    files.sort();
    return files;
  }

  const knownDirs = entries.filter((entry) => entry.isDirectory() && isScanDirName(entry.name.toLowerCase()));
  if (smart && knownDirs.length) {
    collectRootSources(root, entries, files, started, options);
    files.sort();
    return files;
  }

  collectFromDir(root, files, started, options);
  files.sort();
  return files;
}

function sourceMapFromFiles(files) {
  const map = new Map();
  for (const file of files) {
    const base = path.basename(file);
    if (!map.has(base)) map.set(base, file);
    const lower = base.toLowerCase();
    if (!map.has(lower)) map.set(lower, file);
  }
  return map;
}

function sourceMap(root, options) {
  return sourceMapFromFiles(collectSourceFiles(root, options));
}

function moduleAtLine(manifest, file, line) {
  const base = path.basename(file);
  const candidates = Object.entries(manifest.modules || {})
    .filter(([, info]) => path.basename(info.file || "") === base)
    .filter(([, info]) => Number(line) >= Number(info.start || 1) && Number(line) <= Number(info.end || Number.MAX_SAFE_INTEGER))
    .map(([name, info]) => ({ name, info }));
  if (candidates.length) {
    return candidates.sort((a, b) => Number(a.info.start) - Number(b.info.start))[0].name;
  }

  let lines;
  try {
    lines = splitLines(file);
  } catch (_) {
    return "";
  }
  let current = "";
  for (let i = 0; i < Math.min(lines.length, Number(line)); i += 1) {
    const match = lines[i].match(/\bmodule\s+([A-Za-z_]\w*)/);
    if (match) current = match[1];
    if (/\bendmodule\b/.test(lines[i]) && i + 1 >= Number(line)) break;
  }
  return current;
}

function chooseInstance(manifest, moduleName, requested) {
  const instances = (manifest.instances || []).filter((item) => item.module === moduleName);
  if (requested) {
    const normalized = String(requested).replace(/^\/+/, "");
    const exact = instances.find((item) => item.path === normalized || item.path.endsWith(`/${normalized}`));
    if (exact) return exact.path;
  }
  if (moduleName === manifest.top) return manifest.top;
  if (instances.length) {
    return instances.slice().sort((a, b) => Number(a.depth) - Number(b.depth) || a.path.localeCompare(b.path))[0].path;
  }
  return manifest.top;
}

function resolveRecordFile(fileName, currentFile, files) {
  if (path.basename(currentFile) === path.basename(fileName)) return path.resolve(currentFile);
  return files.get(path.basename(fileName)) || files.get(path.basename(fileName).toLowerCase()) || fileName;
}

function findProjectNetgraph(sourceRoot) {
  let dir = path.resolve(sourceRoot);
  for (let depth = 0; depth < 4; depth += 1) {
    const candidateDir = path.join(dir, NETGRAPH_CACHE_DIR, "netgraph");
    if (fs.existsSync(path.join(candidateDir, NETGRAPH_MANIFEST))) {
      return { dir: candidateDir, sourceRoot: dir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function netgraphFreshness(manifest, sourceRoot, options = {}) {
  if (!manifest || !sourceRoot) return { state: "unknown" };
  const mtimes = manifest.sourceMtimes;
  if (mtimes && typeof mtimes === "object" && Object.keys(mtimes).length) {
    for (const [relative, stamp] of Object.entries(mtimes)) {
      const absolute = path.resolve(sourceRoot, relative);
      let stat;
      try {
        stat = fs.statSync(absolute);
      } catch (_) {
        return { state: "stale", file: relative, missing: true };
      }
      if (!stat.isFile()) continue;
      if (stat.mtimeMs > Number(stamp) + NETGRAPH_STALE_TOLERANCE_MS) {
        return { state: "stale", file: relative };
      }
    }
    return { state: "fresh" };
  }
  return netgraphHashFreshness(manifest, sourceRoot, options);
}

function netgraphHashFreshness(manifest, sourceRoot, options = {}) {
  const hashes = manifest.sourceFiles;
  if (!hashes || typeof hashes !== "object") return { state: "unknown" };
  const names = Object.keys(hashes);
  if (!names.length || names.length > NETGRAPH_HASH_MAX_FILES) return { state: "unknown" };
  let index = null;
  let totalBytes = 0;
  const entries = [];
  for (const relative of names) {
    const nested = relative.includes("/") || relative.includes("\\");
    let absolute = nested ? path.resolve(sourceRoot, relative) : "";
    if (!absolute) {
      if (!index) index = sourceMap(sourceRoot, options);
      absolute = index.get(relative) || index.get(relative.toLowerCase()) || "";
    }
    if (!absolute || !fs.existsSync(absolute)) return { state: "stale", file: relative, missing: true };
    totalBytes += fs.statSync(absolute).size;
    if (totalBytes > NETGRAPH_HASH_LIMIT_BYTES) return { state: "unknown" };
    entries.push([absolute, String(hashes[relative])]);
  }
  for (const [absolute, expected] of entries) {
    const actual = crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
    if (actual !== expected) return { state: "stale", file: path.basename(absolute) };
  }
  return { state: "fresh" };
}

function kindLabel(kind) {
  return ({ port: "端口", instance: "例化", "assign-lhs": "赋值", "assign-rhs": "使用", use: "引用" })[kind] || "引用";
}

async function loadClient(netgraphDir) {
  const manifestPath = path.join(netgraphDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const cache = new Map();
  const loadModule = (name, info) => {
    if (!cache.has(name)) {
      cache.set(name, JSON.parse(fs.readFileSync(path.join(netgraphDir, info.shard), "utf8")));
    }
    return cache.get(name);
  };
  return createClient(manifest, loadModule);
}

function maskCodeLine(line) {
  let output = "";
  let inString = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (inString) {
      output += " ";
      if (ch === "\\") {
        output += " ";
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === "/" && next === "/") break;
    if (ch === '"') {
      inString = true;
      output += " ";
      continue;
    }
    output += ch;
  }
  return output;
}

function fallbackTextIndex(options) {
  const files = options.files || collectSourceFiles(options.sourceRoot, {
    smart: options.smart,
    maxFiles: options.maxFiles,
    downLevels: options.downLevels,
    maxScanMs: options.maxScanMs,
    excludeDirs: options.excludeDirs
  });
  if (options.currentFile) {
    const current = path.resolve(options.currentFile);
    const currentLower = current.toLowerCase();
    const index = files.findIndex((file) => file.toLowerCase() === currentLower);
    if (index > 0) {
      files.splice(index, 1);
      files.unshift(current);
    } else if (index < 0 && fs.existsSync(current) && fileSize(current) <= MAX_SOURCE_FILE_BYTES) {
      files.unshift(current);
    }
  }
  const records = [];
  const started = Date.now();
  const maxIndexMs = Number(options.maxIndexMs) > 0 ? Number(options.maxIndexMs) : DEFAULT_MAX_INDEX_MS;
  const needle = options.signal;
  const word = new RegExp(`\\b${escapeRegExp(needle)}\\b`);
  const lhs = new RegExp(`\\b${escapeRegExp(needle)}\\b\\s*(<=|=)`);
  for (const file of files) {
    if (Date.now() - started > maxIndexMs) {
      options.partial = true;
      break;
    }
    let lines;
    try {
      lines = splitLines(file);
    } catch (_) {
      continue;
    }
    let moduleName = "";
    for (let i = 0; i < lines.length; i += 1) {
      const source = lines[i];
      const moduleMatch = source.match(/\bmodule\s+([A-Za-z_]\w*)/);
      if (moduleMatch) moduleName = moduleMatch[1];
      if (!source.includes(needle)) continue;
      const code = maskCodeLine(source);
      if (!word.test(code)) continue;
      let kind = "use";
      if (/^\s*(input|output|inout)\b/.test(source)) kind = "port";
      else if (/\.[A-Za-z_]\w*\s*\(/.test(source)) kind = "instance";
      else if (lhs.test(code)) kind = "assign-lhs";
      else if (/[<>=]/.test(source)) kind = "assign-rhs";
      records.push({
        file,
        line: i + 1,
        module: moduleName || "unknown",
        instancePath: "",
        kind,
        lookupSignal: options.signal,
        detail: "文本索引",
        highlightSignals: [options.signal]
      });
      if (records.length >= 160) break;
    }
    if (records.length >= 160) break;
  }
  return records;
}

function fallbackModule(file, line, manifest) {
  let lines = [];
  try {
    lines = file && fs.existsSync(file) ? splitLines(file) : [];
  } catch (_) {
    lines = [];
  }
  let moduleName = "";
  for (let i = 0; i < Math.min(lines.length, Math.max(1, Number(line))); i += 1) {
    const match = lines[i].match(/\bmodule\s+([A-Za-z_]\w*)/);
    if (match) moduleName = match[1];
  }
  if (!moduleName) {
    for (const text of lines) {
      const match = text.match(/\bmodule\s+([A-Za-z_]\w*)/);
      if (match) {
        moduleName = match[1];
        break;
      }
    }
  }
  return moduleName || (manifest && manifest.top) || "unknown";
}

function formatScopeLabel(scope) {
  const name = path.basename(scope.root) || scope.root;
  let label;
  if (scope.kind === "config") label = `配置根 ${name}`;
  else if (scope.kind === "pinned") label = `固定工程根 ${name}`;
  else if (scope.kind === "marker") label = `工程根 ${name}`;
  else if (scope.kind === "container") label = `容器目录 ${name}（仅当前层）`;
  else label = `范围 ${name}`;
  if (Number.isFinite(scope.fileCount)) {
    label += `（${scope.fileCount} 文件${scope.truncated ? "，已限制" : ""}）`;
  }
  return label;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scriptDir = __dirname;
  const file = args.file ? path.resolve(String(args.file)) : "";
  const line = Math.max(1, Number(args.line) || 1);
  const signal = clean(args.signal || "");
  const configuredRoots = resolveRoots(args["source-roots"]);
  if (args["source-root"]) configuredRoots.unshift(path.resolve(String(args["source-root"])));
  const options = {
    upLevels: numberArg(args["up-levels"], DEFAULT_UP_LEVELS, 0, 8),
    downLevels: numberArg(args["down-levels"], DEFAULT_DOWN_LEVELS, 0, 32),
    maxFiles: numberArg(args["max-files"], DEFAULT_MAX_FILES, 10, 20000),
    maxIndexMs: numberArg(args["max-index-ms"], DEFAULT_MAX_INDEX_MS, 100, 15000),
    excludeDirs: parseList(args["exclude-dirs"], DEFAULT_EXCLUDE_DIRS),
    pinnedRoots: loadPinnedRoots(args["scopes-file"] ? String(args["scopes-file"]) : "")
  };
  const scope = resolveScope(file, configuredRoots, options);
  const sourceRoot = scope.root;
  const collectionOptions = scope.container
    ? { ...options, downLevels: 0 }
    : { ...options };
  let netgraphDir = path.resolve(args.netgraph ? String(args.netgraph) : path.join(scriptDir, "..", "demo", "netgraph"));
  let netgraphSourceRoot = path.resolve(args["netgraph-source-root"]
    ? String(args["netgraph-source-root"])
    : sourceRoot);
  let autoNetgraph = false;
  if (!isWithin(file, netgraphSourceRoot)) {
    const projectNetgraph = findProjectNetgraph(sourceRoot);
    if (projectNetgraph) {
      netgraphDir = projectNetgraph.dir;
      netgraphSourceRoot = projectNetgraph.sourceRoot;
      autoNetgraph = true;
    }
  }
  const top = clean(args.top || "demo_top");
  const forceTextIndex = args["text-index"] === true || String(args["text-index"]) === "1" || !isWithin(file, netgraphSourceRoot);
  const smartScope = scope.kind === "marker";
  if (!signal) throw new Error("missing --signal");

  let client = null;
  let manifest = null;
  let mode = "文本索引（连接图不可用）";
  let moduleName = "";
  let instancePath = "";
  let records = [];

  if (forceTextIndex) {
    const size = fileSize(file);
    if (size > MAX_SOURCE_FILE_BYTES) {
      moduleName = "";
      records = [];
      mode = `文件 ${(size / (1024 * 1024)).toFixed(1)} MB 超过 4 MB，未执行索引`;
    } else {
      const scanOptions = { ...collectionOptions, smart: smartScope };
      const files = collectSourceFiles(sourceRoot, scanOptions);
      scope.fileCount = files.length;
      scope.truncated = Boolean(scope.truncated || scanOptions.truncated);
      const resolvedFile = path.resolve(file);
      if (file && !files.some((item) => path.resolve(item).toLowerCase() === resolvedFile.toLowerCase())) {
        files.unshift(file);
      }
      let hierarchyResult = null;
      if (args["text-index"] !== true && String(args["text-index"]) !== "1") {
        try {
          hierarchyResult = hierarchy.query({ files, file, line, signal, maxIndexMs: collectionOptions.maxIndexMs });
        } catch (_) {
          hierarchyResult = null;
        }
      }
      if (hierarchyResult && hierarchyResult.records.length) {
        moduleName = hierarchyResult.module;
        records = hierarchyResult.records;
        mode = hierarchyResult.partial ? "模块索引（部分源码）" : "模块索引";
        if (hierarchyResult.truncated) mode += " · 已限制 4 层/80 节点";
        if (process.env.RTL_PEEK_DEBUG) fs.writeSync(2, `${JSON.stringify(hierarchyResult.stats)}\n`);
      } else {
        moduleName = fallbackModule(file, line, null);
        const fallbackOptions = { sourceRoot, signal, currentFile: file, smart: smartScope, files, ...collectionOptions };
        records = fallbackTextIndex(fallbackOptions);
        mode = fallbackOptions.partial ? "文本索引（部分）" : "文本索引";
      }
    }
  } else {
    try {
      client = await loadClient(netgraphDir);
      manifest = client.manifest;
      const freshness = netgraphFreshness(manifest, netgraphSourceRoot, collectionOptions);
      if (freshness.state === "stale") {
        const reason = freshness.file
          ? `${freshness.file} ${freshness.missing ? "已不存在" : "已修改"}`
          : "源文件已变化";
        throw new Error(`连接图已过期：${reason}`);
      }
      moduleName = moduleAtLine(manifest, file, line) || fallbackModule(file, line, null);
      if (!manifest.modules || !manifest.modules[moduleName]) {
        throw new Error(`模块 ${moduleName || "未知"} 不在连接图中，可重新生成 netgraph 纳入该文件`);
      }
      instancePath = chooseInstance(manifest, moduleName, args.instance);
      const result = await client.trace({
        module: moduleName,
        signal,
        instancePath,
        maxDepth: 5,
        maxNodes: 96
      });
      mode = autoNetgraph ? "Verilator AST 真实连接 · 工程连接图" : "Verilator AST 真实连接";
      if (freshness.state === "unknown") mode += " · 连接图未校验";
      const scanOptions = { ...collectionOptions, smart: smartScope };
      const sourceFiles = collectSourceFiles(sourceRoot, scanOptions);
      scope.fileCount = sourceFiles.length;
      scope.truncated = Boolean(scope.truncated || scanOptions.truncated);
      const files = sourceMapFromFiles(sourceFiles);
      records = [];
      for (const group of result.groups) {
        for (const item of group.items) {
          records.push({
            file: resolveRecordFile(item.file, file, files),
            line: item.line,
            module: item.module,
            instancePath: item.instancePath || group.path,
            kind: item.traceKind,
            lookupSignal: item.lookupSignal || signal,
            detail: item.detail || kindLabel(item.traceKind),
            highlightSignals: item.highlightSignals && item.highlightSignals.length ? item.highlightSignals : [signal]
          });
        }
      }
      if (result.stats && result.stats.truncated) {
        mode += ` · 已限制 ${result.stats.maxDepth} 层/${result.stats.maxNodes} 节点`;
      }
    } catch (error) {
      moduleName = fallbackModule(file, line, null);
      instancePath = "";
      const fallbackOptions = { sourceRoot, signal, currentFile: file, smart: smartScope, ...collectionOptions };
      records = fallbackTextIndex(fallbackOptions);
      mode = `文本索引（${error.message || "netgraph 不可用"}${fallbackOptions.partial ? "，部分" : ""}）`;
    }
  }

  const aliases = new Set([signal]);
  let aliasChanged = true;
  while (aliasChanged) {
    aliasChanged = false;
    for (const record of records) {
      if (record.kind !== "instance") continue;
      const names = (record.highlightSignals || []).filter(Boolean);
      if (names.length > 2 || !names.some((name) => aliases.has(name))) continue;
      for (const name of names) {
        if (!aliases.has(name)) {
          aliases.add(name);
          aliasChanged = true;
        }
      }
    }
  }

  const unique = [];
  const keys = new Set();
  const hierarchyMode = records.some((record) => record.hierarchy);
  const hasInstance = records.some((item) => item.kind === "instance");
  for (const record of records) {
    if (!hierarchyMode && hasInstance && !aliases.has(record.lookupSignal)) continue;
    const key = [record.file, record.line, record.kind, record.lookupSignal].join("|");
    if (keys.has(key)) continue;
    keys.add(key);
    unique.push(record);
    if (unique.length >= 120) break;
  }
  unique.sort((a, b) => {
    const moduleKey = (item) => String(item.module || path.parse(String(item.file || "")).name || "").toLowerCase();
    const aModule = moduleKey(a);
    const bModule = moduleKey(b);
    if (aModule !== bModule) return aModule < bModule ? -1 : 1;
    const lineDiff = Number(a.line) - Number(b.line);
    if (lineDiff) return lineDiff;
    const aFile = String(a.file || "").toLowerCase();
    const bFile = String(b.file || "").toLowerCase();
    if (aFile !== bFile) return aFile < bFile ? -1 : 1;
    return String(a.kind).localeCompare(String(b.kind));
  });

  const output = [];
  output.push(`META\t${clean(signal)}\t${clean(moduleName)}\t${clean(instancePath)}\t${unique.length}\t${clean(`${mode} · ${formatScopeLabel(scope)}`)}`);
  for (const record of unique) {
    output.push([
      "R",
      clean(record.file),
      Number(record.line) || 1,
      clean(record.module),
      clean(record.instancePath),
      clean(record.kind),
      clean(record.lookupSignal),
      clean(record.detail),
      clean((record.highlightSignals || []).join(","))
    ].join("\t"));
  }
  fs.writeSync(1, Buffer.from(output.join("\n") + "\n", "utf8"));
}

main().catch((error) => {
  fs.writeSync(2, Buffer.from(`${error.stack || error.message || error}\n`, "utf8"));
  process.exitCode = 1;
});
