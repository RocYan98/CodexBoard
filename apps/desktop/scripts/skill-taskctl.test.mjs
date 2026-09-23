import { test as platformTest } from "node:test";
const test = (name, fn) =>
  platformTest(
    `macOS shell wrapper: ${name}`,
    {
      skip:
        process.platform !== "darwin" ? "Windows uses taskctl.ps1/.cmd with separate tests" : false,
    },
    fn,
  );
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const skill = fileURLToPath(new URL("../../../skills/manage-codexboard/", import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codexboard-skill-wrapper-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installed = join(root, "installed skill");
  mkdirSync(installed);
  cpSync(join(skill, "SKILL.md"), join(installed, "SKILL.md"));
  cpSync(join(skill, "scripts"), join(installed, "scripts"), { recursive: true });
  const wrapper = join(installed, "scripts/taskctl.sh");
  const userHome = join(root, "user home");
  const cwd = join(root, "unrelated project");
  const systemApp = join(root, "system applications/CodexBoard.app");
  mkdirSync(userHome);
  mkdirSync(cwd);
  function app(path, name = "fixture", exitCode = 0) {
    const runtime = join(path, "Contents/Resources/runtime");
    const node = join(runtime, "bin/node");
    const cli = join(runtime, "packages/taskctl/dist/cli.js");
    mkdirSync(dirname(node), { recursive: true });
    mkdirSync(dirname(cli), { recursive: true });
    // A synthetic bundled runtime: no PATH lookup, real service or credentials.
    writeFileSync(node, `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
    writeFileSync(
      cli,
      `console.log(JSON.stringify({app:${JSON.stringify(name)},args:process.argv.slice(2),cwd:process.cwd(),data:process.env.CODEXBOARD_DATA_DIR,legacyData:process.env.LARK_TASKBOARD_DATA_DIR}));process.exit(${exitCode});\n`,
    );
    return path;
  }
  function run(env = {}, args = []) {
    return spawnSync(wrapper, args, {
      cwd,
      encoding: "utf8",
      // Empty PATH ensures the wrapper cannot accidentally use a global node.
      env: { HOME: userHome, PATH: "", ...env },
    });
  }
  function relocateSystemProbe() {
    // Relocate only the fixed system directory in this isolated test copy.
    // The shipping wrapper remains unchanged, and /Applications is never used.
    const source = readFileSync(wrapper, "utf8");
    const declaration = "board_system_app=/Applications/CodexBoard.app";
    assert.ok(source.includes(declaration));
    writeFileSync(wrapper, source.replace(declaration, `board_system_app=${quote(systemApp)}`));
    chmodSync(wrapper, 0o755);
  }
  return { root, installed, wrapper, userHome, cwd, systemApp, app, run, relocateSystemProbe };
}

test("copied Skill runs bundled taskctl without source, global Node, or cwd changes and preserves every argument", (t) => {
  const f = fixture(t);
  const appPath = f.app(join(f.root, "custom app's path/CodexBoard.app"));
  const marker = join(f.root, "must-not-exist");
  const args = [
    "issue",
    "create",
    "--title",
    "中文 with spaces",
    "",
    "--body",
    `$(touch ${marker})`,
    "line one\nline two",
    "'quoted'",
    "--help",
  ];
  const result = f.run({ CODEXBOARD_APP_PATH: appPath }, args);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    app: "fixture",
    args,
    cwd: f.cwd,
    data: join(f.userHome, "Library/Application Support/CodexBoard/data"),
  });
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(join(f.installed, "packages")), false);
  assert.equal(existsSync(join(f.installed, "node_modules")), false);
});

test("explicit data directory is preserved, including caller-relative paths", (t) => {
  const f = fixture(t);
  const appPath = f.app(join(f.root, "explicit.app"));
  for (const data of [join(f.root, "custom data"), "relative-data"])
    assert.equal(
      JSON.parse(
        f.run({ CODEXBOARD_APP_PATH: appPath, CODEXBOARD_DATA_DIR: data }, ["context"]).stdout,
      ).data,
      data,
    );
});

test("renamed data variable takes priority while legacy-only callers retain their source", (t) => {
  const f = fixture(t);
  const appPath = f.app(join(f.root, "explicit.app"));
  const both = f.run({
    CODEXBOARD_APP_PATH: appPath,
    CODEXBOARD_DATA_DIR: "new-data",
    LARK_TASKBOARD_DATA_DIR: "old-data",
  });
  assert.equal(both.status, 0, both.stderr);
  assert.equal(JSON.parse(both.stdout).data, "new-data");
  const old = f.run({ CODEXBOARD_APP_PATH: appPath, LARK_TASKBOARD_DATA_DIR: "old-data" });
  assert.equal(old.status, 0, old.stderr);
  assert.equal(JSON.parse(old.stdout).data, undefined);
  assert.equal(JSON.parse(old.stdout).legacyData, "old-data");
  for (const vars of [
    { CODEXBOARD_DATA_DIR: "", LARK_TASKBOARD_DATA_DIR: "old-data" },
    { LARK_TASKBOARD_DATA_DIR: "" },
  ])
    assert.notEqual(f.run({ CODEXBOARD_APP_PATH: appPath, ...vars }).status, 0);
});

test("automatic discovery prefers a complete system app then falls back to the user's Applications", (t) => {
  const f = fixture(t);
  f.relocateSystemProbe();
  f.app(join(f.userHome, "Applications/CodexBoard.app"), "user");
  assert.equal(JSON.parse(f.run({}, ["--help"]).stdout).app, "user");
  f.app(f.systemApp, "system");
  assert.equal(JSON.parse(f.run({}, ["--help"]).stdout).app, "system");
  rmSync(join(f.systemApp, "Contents/Resources/runtime/packages/taskctl/dist/cli.js"));
  assert.equal(JSON.parse(f.run({}, ["--help"]).stdout).app, "user");
});

test("an invalid explicit application never falls back to another installation", (t) => {
  const f = fixture(t);
  f.relocateSystemProbe();
  f.app(f.systemApp);
  const result = f.run({ CODEXBOARD_APP_PATH: join(f.root, "missing.app") }, ["health"]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /指定位置缺少完整应用/);
});

test("missing applications report an actionable error without starting a runtime or creating data", (t) => {
  const f = fixture(t);
  f.relocateSystemProbe();
  const result = f.run({}, ["health"]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /未找到完整的 CodexBoard/);
  assert.equal(existsSync(join(f.userHome, "Library")), false);
});

test("empty explicit overrides are rejected rather than silently targeting a different app or data directory", (t) => {
  const f = fixture(t);
  const appPath = f.app(join(f.root, "valid.app"));
  for (const env of [
    { CODEXBOARD_APP_PATH: "" },
    { CODEXBOARD_APP_PATH: appPath, CODEXBOARD_DATA_DIR: "" },
  ]) {
    const result = f.run(env, ["--help"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /不能为空/);
    assert.equal(result.stdout, "");
  }
});

test("CLI failures retain their original exit code and stream", (t) => {
  const f = fixture(t);
  const appPath = f.app(join(f.root, "failure.app"), "failing-cli", 1);
  const result = f.run({ CODEXBOARD_APP_PATH: appPath }, ["auth", "status"]);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).app, "failing-cli");
});
