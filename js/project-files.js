"use strict";

const fs = require("fs");
const path = require("path");

const HDL_EXT = /\.(v|sv|vh|svh)$/i;
const XPR_EXT = ".xpr";
const CACHE_FILELIST = path.join(".rtl-peek", "filelist.txt");
const STALE_DIR_RE = new RegExp(
  "^(old|bak|deprecated|trash|备份|旧版|废弃)([_.-].*)?$" +
  "|^(backup|archive|copy)$" +
  "|^(backup|archive|copy)[_-]?(\\d{4,8}|v\\d+)([_.-].*)?$" +
  "|[_.-](old|bak|backup|archive|deprecated|copy|trash|备份|旧版|废弃)([_.-]?(\\d{4,8}|v\\d+))?$",
  "i"
);

function clean(value) {
  return String(value == null ? "" : value).trim();
}

function dedupeKey(file) {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function decodeXmlEntities(value) {
  return String(value).replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (match, body) => {
    const lower = body.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

function fileTags(text) {
  const tags = [];
  const re = /<File\b/gi;
  let match;
  while ((match = re.exec(text))) {
    let index = re.lastIndex;
    let quote = "";
    for (; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
    }
    if (index >= text.length) break;
    tags.push({ tag: text.slice(match.index, index + 1), index: match.index });
    re.lastIndex = index + 1;
  }
  return tags;
}

function fileSetRanges(text) {
  const ranges = [];
  const lower = text.toLowerCase();
  const re = /<FileSet\b[^>]*>/gi;
  let match;
  while ((match = re.exec(text))) {
    if (/\/\s*>$/.test(match[0])) continue;
    const start = re.lastIndex;
    const close = lower.indexOf("</fileset>", start);
    const end = close === -1 ? text.length : close;
    ranges.push({
      start,
      end,
      attributes: tagAttributesOf(match[0], "FileSet")
    });
    re.lastIndex = end;
  }
  return ranges;
}

function tagAttributes(tag) {
  return tagAttributesOf(tag, "File");
}

function tagAttributesOf(tag, name) {
  const attributes = {};
  const body = tag.replace(new RegExp(`^<${name}\\b`, "i"), "").replace(/\/?>$/, "");
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = re.exec(body))) {
    attributes[match[1]] = decodeXmlEntities(match[3] !== undefined ? match[3] : match[4]);
  }
  return attributes;
}

function readDirEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
}

function findCompanionDir(projectDir, base, suffix, allowSingle) {
  const wanted = `${base}${suffix}`.toLowerCase();
  const entries = readDirEntries(projectDir).filter((entry) => entry.isDirectory());
  const exact = entries.find((entry) => entry.name.toLowerCase() === wanted);
  if (exact) return path.join(projectDir, exact.name);
  if (allowSingle) {
    const matches = entries.filter((entry) => entry.name.toLowerCase().endsWith(suffix.toLowerCase()));
    if (matches.length === 1) return path.join(projectDir, matches[0].name);
  }
  return "";
}

function findProjectSrcsDir(projectDir, base) {
  const entries = readDirEntries(projectDir);
  const dirs = entries.filter((entry) => entry.isDirectory());
  const wanted = `${base}.srcs`.toLowerCase();
  const exact = dirs.find((entry) => entry.name.toLowerCase() === wanted);
  if (exact) return path.join(projectDir, exact.name);
  const srcsDirs = dirs.filter((entry) => entry.name.toLowerCase().endsWith(".srcs"));
  if (srcsDirs.length !== 1) return "";
  const owner = srcsDirs[0].name.slice(0, -".srcs".length).toLowerCase();
  const xprBases = entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === XPR_EXT)
    .map((entry) => path.basename(entry.name, path.extname(entry.name)).toLowerCase());
  if (owner !== base.toLowerCase() && xprBases.includes(owner)) return "";
  return path.join(projectDir, srcsDirs[0].name);
}

function isStaleDirName(name) {
  return STALE_DIR_RE.test(String(name || ""));
}

function findSrcsDirForXpr(xprFile) {
  const resolved = path.resolve(xprFile);
  return findProjectSrcsDir(path.dirname(resolved), path.basename(resolved, path.extname(resolved)));
}

function projectVariables(xprFile) {
  const projectDir = path.dirname(xprFile);
  const base = path.basename(xprFile, path.extname(xprFile));
  const srcsDir = findProjectSrcsDir(projectDir, base);
  return {
    PPRDIR: projectDir,
    PSRCDIR: srcsDir || projectDir,
    PGENDIR: findCompanionDir(projectDir, base, ".gen", false) || path.join(projectDir, `${base}.gen`),
    PRUNDIR: findCompanionDir(projectDir, base, ".runs", false) || path.join(projectDir, `${base}.runs`),
    PCACHEDIR: findCompanionDir(projectDir, base, ".cache", false) || path.join(projectDir, `${base}.cache`),
    PSIMDIR: findCompanionDir(projectDir, base, ".sim", false) || path.join(projectDir, `${base}.sim`)
  };
}

function expandProjectVariables(value, variables) {
  return String(value).replace(/\$(?:\{)?(PPRDIR|PSRCDIR|PGENDIR|PRUNDIR|PCACHEDIR|PSIMDIR)(?:\})?/gi, (match, name) => {
    const replacement = variables[String(name).toUpperCase()];
    return replacement === undefined ? match : replacement;
  });
}

function resolveProjectPath(value, projectDir, variables) {
  const expanded = expandProjectVariables(value, variables).replace(/\\/g, "/");
  return path.resolve(projectDir, expanded);
}

function isHdlFile(file) {
  return HDL_EXT.test(file);
}

function statFile(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat : null;
  } catch (_) {
    return null;
  }
}

function addListFile(files, seen, warnings, file, label, quietNonHdl) {
  const resolved = path.resolve(file);
  if (!isHdlFile(resolved)) {
    if (!quietNonHdl) warnings.push(`跳过非 HDL 文件：${label || resolved}`);
    return;
  }
  if (!statFile(resolved)) {
    warnings.push(`文件表缺失 HDL 文件：${label || resolved}`);
    return;
  }
  const key = dedupeKey(resolved);
  if (seen.has(key)) return;
  seen.add(key);
  files.push(resolved);
}

function parseXprFileList(xprFile, options = {}) {
  const resolvedXpr = path.resolve(xprFile);
  const includeSimulation = Boolean(options.includeSimulation);
  const result = {
    source: "xpr",
    path: resolvedXpr,
    files: [],
    includeDirs: [],
    warnings: []
  };
  let text;
  try {
    text = fs.readFileSync(resolvedXpr, "utf8");
  } catch (_) {
    result.warnings.push(`xpr 文件不存在或无法读取：${resolvedXpr}`);
    return result;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const projectDir = path.dirname(resolvedXpr);
  const variables = projectVariables(resolvedXpr);
  const tags = fileTags(text);
  if (!tags.length) {
    result.warnings.push(`xpr 中没有找到 <File> 条目：${resolvedXpr}`);
    return result;
  }
  const ranges = fileSetRanges(text);
  const seen = new Set();
  for (const item of tags) {
    if (ranges.length) {
      const range = ranges.find((candidate) => item.index >= candidate.start && item.index < candidate.end);
      if (!range) continue;
      const type = clean(range.attributes.Type).toLowerCase();
      if (type) {
        const design = type === "designsrcs" || type === "source" || type === "sources";
        const simulation = type === "simulationsrcs" || type === "simulation" || type === "sim";
        if (!design && !(includeSimulation && simulation)) continue;
      }
    }
    const attributes = tagAttributes(item.tag);
    if (attributes.Path === undefined) {
      result.warnings.push(`跳过没有 Path 属性的 <File> 条目：${resolvedXpr}`);
      continue;
    }
    const enabled = attributes.IsEnabled;
    if (enabled !== undefined && /^(0|false)$/i.test(clean(enabled))) continue;
    const rawPath = attributes.Path;
    const absolute = resolveProjectPath(rawPath, projectDir, variables);
    addListFile(result.files, seen, result.warnings, absolute, rawPath, true);
  }
  return result;
}

function unquote(value) {
  const text = clean(value);
  const double = /^"(.*)"$/.exec(text);
  if (double) return double[1];
  const single = /^'(.*)'$/.exec(text);
  if (single) return single[1];
  return text;
}

function resolveListPath(value, baseDir) {
  const normalized = String(value).replace(/\\/g, "/");
  if (path.isAbsolute(normalized)) return path.resolve(normalized);
  return path.resolve(baseDir, normalized);
}

function parseGenericFilelist(filelistFile) {
  const resolvedList = path.resolve(filelistFile);
  const result = {
    source: "filelist",
    path: resolvedList,
    files: [],
    includeDirs: [],
    warnings: []
  };
  const seenFiles = new Set();
  const seenIncludes = new Set();
  const stack = new Set();

  const addInclude = (dir) => {
    const resolved = path.resolve(dir);
    const key = dedupeKey(resolved);
    if (!seenIncludes.has(key)) {
      seenIncludes.add(key);
      result.includeDirs.push(resolved);
    }
  };

  const readList = (listFile) => {
    const current = path.resolve(listFile);
    const key = dedupeKey(current);
    if (stack.has(key)) {
      result.warnings.push(`嵌套文件表循环引用，已跳过：${current}`);
      return;
    }
    let text;
    try {
      text = fs.readFileSync(current, "utf8");
    } catch (_) {
      result.warnings.push(`文件表不存在或无法读取：${current}`);
      return;
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    stack.add(key);
    try {
      const baseDir = path.dirname(current);
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith("#") || line.startsWith("//")) continue;
        const incdir = /^\+incdir\+(.+)$/i.exec(line);
        if (incdir) {
          for (const part of incdir[1].split("+")) {
            const dir = unquote(part);
            if (dir) addInclude(resolveListPath(dir, baseDir));
          }
          continue;
        }
        const idir = /^-[iI]\s*(.+)$/.exec(line);
        if (idir) {
          addInclude(resolveListPath(unquote(idir[1]), baseDir));
          continue;
        }
        const nested = /^-[fF]\s+(.+)$/.exec(line);
        if (nested) {
          readList(resolveListPath(unquote(nested[1]), baseDir));
          continue;
        }
        if (line.startsWith("-")) {
          result.warnings.push(`跳过未识别的文件表选项：${line}`);
          continue;
        }
        const rawPath = unquote(line);
        if (!rawPath) continue;
        addListFile(result.files, seenFiles, result.warnings, resolveListPath(rawPath, baseDir), rawPath);
      }
    } finally {
      stack.delete(key);
    }
  };

  readList(resolvedList);
  return result;
}

function findRootXpr(root, currentFile) {
  const resolvedRoot = path.resolve(root);
  let entries;
  try {
    entries = fs.readdirSync(resolvedRoot, { withFileTypes: true });
  } catch (_) {
    return { path: "", warnings: [] };
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === XPR_EXT)
    .map((entry) => path.join(resolvedRoot, entry.name))
    .sort((a, b) => {
      const aName = path.basename(a).toLowerCase();
      const bName = path.basename(b).toLowerCase();
      if (aName !== bName) return aName < bName ? -1 : 1;
      return a < b ? -1 : 1;
    });
  if (!candidates.length) return { path: "", warnings: [] };
  const file = currentFile ? path.resolve(currentFile) : "";
  const matched = file
    ? candidates.find((xpr) => {
      const srcsDir = findSrcsDirForXpr(xpr);
      if (!srcsDir) return false;
      const relative = path.relative(srcsDir, file);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    })
    : null;
  const rootBase = path.basename(resolvedRoot).toLowerCase();
  const preferred = candidates.find((file) => path.basename(file, path.extname(file)).toLowerCase() === rootBase);
  const selected = matched || preferred || candidates[0];
  const warnings = [];
  if (candidates.length > 1) {
    warnings.push(
      `发现 ${candidates.length} 个 .xpr，已选择 ${path.basename(selected)}` +
      (matched ? "（匹配当前文件所在 .srcs）" : preferred ? "（与目录同名）" : "（按文件名排序取第一个）")
    );
  }
  return { path: selected, warnings };
}

function dedupeFiles(files) {
  const result = [];
  const seen = new Set();
  for (const file of files || []) {
    const resolved = path.resolve(file);
    const key = dedupeKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function resolveProjectFiles(options = {}) {
  const root = options.root ? path.resolve(options.root) : "";
  const maxFiles = Number.isFinite(options.maxFiles) && options.maxFiles > 0
    ? Math.trunc(options.maxFiles)
    : 0;
  const warnings = [];

  const runScan = () => {
    if (typeof options.scanFallback !== "function") {
      return { files: [], includeDirs: [], source: "scan", path: "", warnings, truncated: false };
    }
    const scanned = options.scanFallback() || {};
    let files = dedupeFiles(scanned.files || []);
    let truncated = Boolean(scanned.truncated);
    if (maxFiles && files.length > maxFiles) {
      files = files.slice(0, maxFiles);
      truncated = true;
    }
    return {
      files,
      includeDirs: [],
      source: "scan",
      path: "",
      warnings,
      truncated
    };
  };

  const finish = (parsed) => {
    warnings.push(...(parsed.warnings || []));
    let files = dedupeFiles(parsed.files || []);
    let truncated = false;
    if (maxFiles && files.length > maxFiles) {
      warnings.push(`工程文件表共有 ${files.length} 个文件，超过 maxFiles=${maxFiles}，已限制为前 ${maxFiles} 个`);
      files = files.slice(0, maxFiles);
      truncated = true;
    }
    if (!files.length) {
      warnings.push(`工程文件表没有可用的 HDL 文件（${parsed.path}），回退目录扫描`);
      return runScan();
    }
    return {
      files,
      includeDirs: dedupeFiles(parsed.includeDirs || []),
      source: parsed.source,
      path: parsed.path,
      warnings,
      truncated
    };
  };

  if (options.explicitFilelist) {
    return finish(parseGenericFilelist(options.explicitFilelist));
  }
  if (options.explicitXpr) {
    return finish(parseXprFileList(options.explicitXpr));
  }
  if (root && options.allowAutoCache !== false) {
    const cacheFilelist = path.join(root, CACHE_FILELIST);
    if (statFile(cacheFilelist)) return finish(parseGenericFilelist(cacheFilelist));
  }
  if (root) {
    const rootXpr = findRootXpr(root, options.currentFile);
    if (rootXpr.path) {
      const parsed = parseXprFileList(rootXpr.path);
      parsed.warnings.unshift(...rootXpr.warnings);
      return finish(parsed);
    }
  }
  return runScan();
}

module.exports = {
  CACHE_FILELIST,
  HDL_EXT,
  decodeXmlEntities,
  findSrcsDirForXpr,
  findRootXpr,
  isStaleDirName,
  parseGenericFilelist,
  parseXprFileList,
  resolveProjectFiles
};
