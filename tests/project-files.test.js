#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const projectFiles = require("../js/project-files.js");
const buildNetgraph = require("../tools/build_netgraph.js");
const queryScript = require("../js/query.js");

const repoRoot = path.resolve(__dirname, "..");
const fixturesRoot = path.join(__dirname, "fixtures");
const fixtureRoot = path.join(fixturesRoot, "project-filelist");
const xprPath = path.join(fixtureRoot, "proj.xpr");
const filelistPath = path.join(fixtureRoot, "filelist.f");
const queryPath = path.join(repoRoot, "js", "query.js");

let passed = 0;
let failed = 0;

function test(name, run) {
  try {
    run();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(`  ${String(error && error.stack ? error.stack : error).replace(/\n/g, "\n  ")}`);
  }
}

function normalize(files) {
  return files.map((file) => path.resolve(file));
}

function assertFiles(actual, expected) {
  assert.deepStrictEqual(normalize(actual), normalize(expected));
}

function assertHasWarning(warnings, text) {
  assert(
    warnings.some((warning) => warning.includes(text)),
    `missing warning containing ${JSON.stringify(text)} in ${JSON.stringify(warnings)}`
  );
}

function scanFixtureProject(root) {
  return {
    files: [
      path.join(root, "rtl", "top.v"),
      path.join(root, "rtl_old", "stale.v")
    ],
    truncated: false
  };
}

test("xpr resolves PPRDIR/PSRCDIR, relative paths, entities and disabled entries", () => {
  const parsed = projectFiles.parseXprFileList(xprPath);
  assert.strictEqual(parsed.source, "xpr");
  assertFiles(parsed.files, [
    path.join(fixtureRoot, "rtl", "top.v"),
    path.join(fixtureRoot, "rtl", "gate&and.v"),
    path.join(fixturesRoot, "shared", "child.v")
  ]);
  assert(!parsed.files.some((file) => file.toLowerCase().endsWith("stale.v")), "disabled stale file was included");
  assert(!parsed.warnings.some((warning) => warning.includes("top.xdc")), "constraints file should be skipped silently");
  assertHasWarning(parsed.warnings, "missing.v");
});

test("xpr resolves Vivado $PSRCDIR and keeps only design source filesets", () => {
  const layoutRoot = path.join(fixturesRoot, "vivado-layout");
  const projectFile = path.join(layoutRoot, "proj.xpr");
  const parsed = projectFiles.parseXprFileList(projectFile);
  assertFiles(parsed.files, [
    path.join(layoutRoot, "proj.srcs", "sources_1", "new", "top.v"),
    path.join(layoutRoot, "proj.srcs", "sources_1", "new", "helper.v")
  ]);
  assert.deepStrictEqual(parsed.warnings, []);

  const withSimulation = projectFiles.parseXprFileList(projectFile, { includeSimulation: true });
  assertFiles(withSimulation.files, [
    path.join(layoutRoot, "proj.srcs", "sources_1", "new", "top.v"),
    path.join(layoutRoot, "proj.srcs", "sources_1", "new", "helper.v"),
    path.join(layoutRoot, "proj.srcs", "sim_1", "new", "tb_top.v")
  ]);
});

test("netgraph passes only .v/.sv files to the compiler", () => {
  const headers = [
    path.join(fixtureRoot, "include", "defs.vh"),
    path.join(fixtureRoot, "include", "pkg.svh")
  ];
  const partitioned = buildNetgraph.partitionCompileFiles([
    path.join(fixtureRoot, "rtl", "top.v"),
    ...headers,
    path.join(fixtureRoot, "rtl", "gate&and.sv")
  ]);
  assertFiles(partitioned.sources, [
    path.join(fixtureRoot, "rtl", "top.v"),
    path.join(fixtureRoot, "rtl", "gate&and.sv")
  ]);
  assertFiles(partitioned.headers, headers);
});

test("netgraph keeps parent-folder files distinct in the manifest key", () => {
  const shared = path.join(fixturesRoot, "shared", "child.v");
  assert.strictEqual(buildNetgraph.sourceKey(shared, fixtureRoot), "../shared/child.v");
  assert.strictEqual(
    buildNetgraph.sourceKey(path.join(fixtureRoot, "rtl", "top.v"), fixtureRoot),
    "rtl/top.v"
  );
});

test("stale directory heuristic keeps real copy/backup module folders", () => {
  for (const name of [
    "rtl_old", "rtl.old", "backup_2024", "backup_2024_foo", "archive2024",
    "archive_2024_foo", "rtl_backup", "old_rtl"
  ]) {
    assert(projectFiles.isStaleDirName(name), `${name} should be treated as stale`);
  }
  for (const name of ["copy_engine", "backup_ram", "copyright", "oldtown", "bold", "gold"]) {
    assert(!projectFiles.isStaleDirName(name), `${name} should be kept`);
  }
});

test("record file resolution prefers an existing manifest path over current basename", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-peek-record-"));
  try {
    const rtlDir = path.join(tempDir, "rtl");
    fs.mkdirSync(rtlDir, { recursive: true });
    const leaf = path.join(tempDir, "top.v");
    const top = path.join(rtlDir, "top.v");
    fs.writeFileSync(leaf, "module leaf; endmodule\n", "utf8");
    fs.writeFileSync(top, "module top; leaf u_leaf(); endmodule\n", "utf8");
    assert.strictEqual(
      path.resolve(queryScript.resolveRecordFile("top.v", top, new Map(), tempDir)),
      path.resolve(leaf)
    );

    const mapped = path.join(rtlDir, "controller.v");
    fs.writeFileSync(mapped, "module controller; endmodule\n", "utf8");
    const other = path.join(tempDir, "other.v");
    fs.writeFileSync(other, "module other; endmodule\n", "utf8");
    assert.strictEqual(
      path.resolve(queryScript.resolveRecordFile(
        "controller.v",
        other,
        new Map([["controller.v", mapped]]),
        tempDir
      )),
      path.resolve(mapped)
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("directory scan fallback skips stale backup folders", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-peek-stale-"));
  try {
    fs.writeFileSync(path.join(tempDir, "fallback.v"), "module fallback;\n  wire engine_data;\nendmodule\n", "utf8");
    for (const dir of ["rtl_old", "backup_2024", "archive"]) {
      fs.mkdirSync(path.join(tempDir, dir), { recursive: true });
      fs.writeFileSync(path.join(tempDir, dir, "stale.v"), "module stale;\n  wire engine_data;\nendmodule\n", "utf8");
    }
    fs.writeFileSync(
      path.join(tempDir, "proj.xpr"),
      '<Project><FileSet Type="DesignSrcs"><File Path="missing.v"/></FileSet></Project>\n',
      "utf8"
    );
    const output = execFileSync(
      process.execPath,
      [
        queryPath,
        "--file", path.join(tempDir, "fallback.v"),
        "--line", "1",
        "--signal", "engine_data",
        "--text-index", "1"
      ],
      { cwd: repoRoot, encoding: "utf8" }
    );
    assert(output.includes("目录扫描（1 文件）"), `stale dirs were scanned:\n${output}`);
    assert(!output.includes("stale.v"), `stale file leaked into output:\n${output}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("xpr uses an orphan .srcs directory even when other .xpr files exist", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-peek-srcs-"));
  try {
    const xpr = (name) => [
      "<Project>",
      '  <FileSet Name="sources_1" Type="DesignSrcs">',
      `    <File Path="$PSRCDIR/sources_1/new/${name}.v"/>`,
      "  </FileSet>",
      "</Project>"
    ].join("\n");
    fs.writeFileSync(path.join(tempDir, "main.xpr"), xpr("top"), "utf8");
    fs.writeFileSync(path.join(tempDir, "main_old.xpr"), xpr("top"), "utf8");
    const rtlDir = path.join(tempDir, "proj.srcs", "sources_1", "new");
    fs.mkdirSync(rtlDir, { recursive: true });
    const top = path.join(rtlDir, "top.v");
    fs.writeFileSync(top, "module top; endmodule\n", "utf8");
    const parsed = projectFiles.parseXprFileList(path.join(tempDir, "main.xpr"));
    assertFiles(parsed.files, [top]);
    assert.deepStrictEqual(parsed.warnings, []);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("xpr does not borrow another project's .srcs directory", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-peek-srcs-owner-"));
  try {
    fs.writeFileSync(path.join(tempDir, "alpha.xpr"), [
      "<Project>",
      '  <FileSet Type="DesignSrcs">',
      '    <File Path="$PSRCDIR/sources_1/new/top.v"/>',
      "  </FileSet>",
      "</Project>"
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(tempDir, "beta.xpr"), "<Project/>\n", "utf8");
    const rtlDir = path.join(tempDir, "beta.srcs", "sources_1", "new");
    fs.mkdirSync(rtlDir, { recursive: true });
    fs.writeFileSync(path.join(rtlDir, "top.v"), "module beta_top; endmodule\n", "utf8");
    const parsed = projectFiles.parseXprFileList(path.join(tempDir, "alpha.xpr"));
    assert.deepStrictEqual(parsed.files, []);
    assertHasWarning(parsed.warnings, "top.v");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("findRootXpr prefers the xpr whose .srcs owns the current file", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-peek-xpr-owner-"));
  try {
    fs.writeFileSync(path.join(tempDir, "alpha.xpr"), "<Project/>\n", "utf8");
    fs.writeFileSync(path.join(tempDir, "beta.xpr"), "<Project/>\n", "utf8");
    const rtlDir = path.join(tempDir, "beta.srcs", "sources_1", "new");
    fs.mkdirSync(rtlDir, { recursive: true });
    const top = path.join(rtlDir, "top.v");
    fs.writeFileSync(top, "module beta_top; endmodule\n", "utf8");
    const selected = projectFiles.findRootXpr(tempDir, top);
    assert.strictEqual(path.basename(selected.path), "beta.xpr");
    assertHasWarning(selected.warnings, "匹配当前文件所在 .srcs");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("query does not exceed maxFiles after inserting the current file", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-peek-maxfiles-"));
  try {
    const rtlDir = path.join(tempDir, "rtl");
    fs.mkdirSync(rtlDir, { recursive: true });
    const entries = [];
    for (let index = 0; index < 11; index += 1) {
      const name = `mod${index}.v`;
      fs.writeFileSync(
        path.join(rtlDir, name),
        `module mod${index};\n  wire engine_data;\nendmodule\n`,
        "utf8"
      );
      entries.push(`    <File Path="$PPRDIR/rtl/${name}"/>`);
    }
    const xpr = path.join(tempDir, "proj.xpr");
    fs.writeFileSync(
      xpr,
      `<Project>\n  <FileSet Type="DesignSrcs">\n${entries.join("\n")}\n  </FileSet>\n</Project>\n`,
      "utf8"
    );
    const outside = path.join(tempDir, "outside.v");
    fs.writeFileSync(outside, "module outside;\n  wire engine_data;\nendmodule\n", "utf8");
    const output = execFileSync(
      process.execPath,
      [
        queryPath,
        "--file", outside,
        "--line", "1",
        "--signal", "engine_data",
        "--text-index", "1",
        "--xpr", xpr,
        "--max-files", "10"
      ],
      { cwd: repoRoot, encoding: "utf8" }
    );
    assert(output.includes("10 文件，已限制"), `maxFiles was exceeded:\n${output}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("generic filelist handles comments, quotes, incdir and nested -f", () => {
  const parsed = projectFiles.parseGenericFilelist(filelistPath);
  assert.strictEqual(parsed.source, "filelist");
  assertFiles(parsed.files, [
    path.join(fixtureRoot, "rtl", "top.v"),
    path.join(fixtureRoot, "shared", "child.v")
  ]);
  assert(!parsed.files.some((file) => file.includes("+incdir+")), "incdir was treated as a source file");
  assertFiles(parsed.includeDirs, [
    path.join(fixtureRoot, "include"),
    path.join(fixturesRoot, "include")
  ]);
});

test("generic filelist is BOM tolerant and protects against nested cycles", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-peek-filelist-"));
  try {
    fs.writeFileSync(path.join(tempDir, "only.v"), "module only; endmodule\n", "utf8");
    fs.writeFileSync(path.join(tempDir, "a.f"), "\ufeffonly.v\n-f b.f\n", "utf8");
    fs.writeFileSync(path.join(tempDir, "b.f"), "-f a.f\n", "utf8");
    const parsed = projectFiles.parseGenericFilelist(path.join(tempDir, "a.f"));
    assertFiles(parsed.files, [path.join(tempDir, "only.v")]);
    assertHasWarning(parsed.warnings, "循环引用");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolver priority prefers explicit filelist over explicit xpr", () => {
  const resolved = projectFiles.resolveProjectFiles({
    root: fixtureRoot,
    explicitFilelist: filelistPath,
    explicitXpr: xprPath,
    scanFallback: () => scanFixtureProject(fixtureRoot)
  });
  assert.strictEqual(resolved.source, "filelist");
  assert.strictEqual(path.resolve(resolved.path), path.resolve(filelistPath));
  assertFiles(resolved.files, [
    path.join(fixtureRoot, "rtl", "top.v"),
    path.join(fixtureRoot, "shared", "child.v")
  ]);
});

test("resolver priority prefers explicit xpr over automatic discovery", () => {
  const resolved = projectFiles.resolveProjectFiles({
    root: fixtureRoot,
    explicitXpr: xprPath,
    scanFallback: () => scanFixtureProject(fixtureRoot)
  });
  assert.strictEqual(resolved.source, "xpr");
  assertStrictEqualFiles(resolved.files);
});

function assertStrictEqualFiles(files) {
  assertFiles(files, [
    path.join(fixtureRoot, "rtl", "top.v"),
    path.join(fixtureRoot, "rtl", "gate&and.v"),
    path.join(fixturesRoot, "shared", "child.v")
  ]);
}

test("resolver auto-detects root .xpr before falling back to scan", () => {
  const resolved = projectFiles.resolveProjectFiles({
    root: fixtureRoot,
    scanFallback: () => scanFixtureProject(fixtureRoot)
  });
  assert.strictEqual(resolved.source, "xpr");
  assertStrictEqualFiles(resolved.files);
});

test("resolver prefers .rtl-peek/filelist.txt over a root .xpr", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-peek-cachefilelist-"));
  try {
    fs.mkdirSync(path.join(tempDir, ".rtl-peek"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "a.v"), "module a; endmodule\n", "utf8");
    fs.writeFileSync(path.join(tempDir, "b.v"), "module b; endmodule\n", "utf8");
    fs.writeFileSync(path.join(tempDir, ".rtl-peek", "filelist.txt"), "../a.v\n", "utf8");
    fs.writeFileSync(
      path.join(tempDir, "proj.xpr"),
      "<Project><FileSet><File Path=\"b.v\"/></FileSet></Project>\n",
      "utf8"
    );
    const resolved = projectFiles.resolveProjectFiles({
      root: tempDir,
      scanFallback: () => ({ files: [path.join(tempDir, "b.v")], truncated: false })
    });
    assert.strictEqual(resolved.source, "filelist");
    assertFiles(resolved.files, [path.join(tempDir, "a.v")]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolver falls back to scan when the selected list has no usable files", () => {
  const fallbackRoot = path.join(fixturesRoot, "fallback-project");
  const resolved = projectFiles.resolveProjectFiles({
    root: fallbackRoot,
    scanFallback: () => ({ files: [path.join(fallbackRoot, "fallback.v")], truncated: false })
  });
  assert.strictEqual(resolved.source, "scan");
  assert.strictEqual(resolved.path, "");
  assertFiles(resolved.files, [path.join(fallbackRoot, "fallback.v")]);
  assertHasWarning(resolved.warnings, "回退目录扫描");
});

test("resolver marks filelist truncation when maxFiles is exceeded", () => {
  const resolved = projectFiles.resolveProjectFiles({
    root: fixtureRoot,
    explicitXpr: xprPath,
    maxFiles: 2,
    scanFallback: () => scanFixtureProject(fixtureRoot)
  });
  assert.strictEqual(resolved.files.length, 2);
  assert.strictEqual(resolved.truncated, true);
  assertHasWarning(resolved.warnings, "maxFiles=2");
});

test("findRootXpr prefers the directory basename and warns on multiple candidates", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-peek-xpr-"));
  try {
    const projectDir = path.join(tempDir, "proj");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "alpha.xpr"), "<Project/>\n", "utf8");
    fs.writeFileSync(path.join(projectDir, "proj.xpr"), "<Project/>\n", "utf8");
    const selected = projectFiles.findRootXpr(projectDir);
    assert.strictEqual(path.basename(selected.path), "proj.xpr");
    assertHasWarning(selected.warnings, "已选择 proj.xpr");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("query integration reports the xpr filelist source and excludes stale modules", () => {
  const output = execFileSync(
    process.execPath,
    [
      queryPath,
      "--file", path.join(fixtureRoot, "rtl", "top.v"),
      "--line", "2",
      "--signal", "engine_data",
      "--text-index", "1"
    ],
    { cwd: repoRoot, encoding: "utf8" }
  );
  assert(output.includes("工程文件表 .xpr"), `META did not report xpr source:\n${output}`);
  assert(output.includes("top.v"), `expected top.v in output:\n${output}`);
  assert(!output.toLowerCase().includes("stale.v"), `stale module leaked into output:\n${output}`);
});

test("query integration reports directory scan for an empty xpr fallback", () => {
  const fallbackRoot = path.join(fixturesRoot, "fallback-project");
  const output = execFileSync(
    process.execPath,
    [
      queryPath,
      "--file", path.join(fallbackRoot, "fallback.v"),
      "--line", "2",
      "--signal", "engine_data",
      "--text-index", "1"
    ],
    { cwd: repoRoot, encoding: "utf8" }
  );
  assert(output.includes("目录扫描"), `META did not report scan source:\n${output}`);
  assert(output.includes("fallback.v"), `expected fallback.v in output:\n${output}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
