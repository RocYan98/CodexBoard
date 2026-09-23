import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, toNamespacedPath } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const wrapper = fileURLToPath(
  new URL("../../../skills/manage-codexboard/scripts/taskctl.ps1", import.meta.url),
);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "codexboard-wrapper-win-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const local = join(root, "Local App Data");
  const app = join(local, "CodexBoard Windows Test");
  const node = join(app, "runtime/bin/node.exe");
  const cli = join(app, "runtime/packages/taskctl/dist/cli.js");
  mkdirSync(dirname(node), { recursive: true });
  mkdirSync(dirname(cli), { recursive: true });
  cpSync(process.execPath, node);
  writeFileSync(join(app, "runtime/packages/taskctl/package.json"), '{"type":"module"}');
  writeFileSync(
    cli,
    "import process from 'node:process'; console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),data:process.env.CODEXBOARD_DATA_DIR}));process.exit(7)",
  );
  const cwd = join(root, "unrelated project");
  mkdirSync(cwd);
  const run = (env, args) =>
    spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$a=ConvertFrom-Json $env:CODEXBOARD_TEST_ARGS; & $env:CODEXBOARD_TEST_WRAPPER @a; exit $LASTEXITCODE",
      ],
      {
        cwd,
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...process.env,
          CODEXBOARD_DATA_DIR: undefined,
          CODEXBOARD_APP_PATH: undefined,
          LOCALAPPDATA: local,
          CODEXBOARD_TEST_WRAPPER: wrapper,
          CODEXBOARD_TEST_ARGS: JSON.stringify(args),
          ...env,
        },
      },
    );
  return { run, app, local, cwd };
}
test(
  "Windows Skill preserves arguments, working directory and bundled CLI exit status",
  { skip: process.platform !== "win32" },
  (t) => {
    const f = fixture(t);
    const args = [
      "--help",
      "",
      "space value",
      'quoted"value',
      "C:\\ends-with-slash\\",
      "$(not-a-command)",
      "line one\nline two",
    ];
    const result = f.run({ CODEXBOARD_APP_PATH: f.app }, args);
    assert.equal(result.status, 7, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      args,
      cwd: f.cwd,
      data: join(f.local, "CodexBoard/data"),
    });
  },
);
for (const [name, path] of [
  ["namespaced", toNamespacedPath],
  ["namespaced uppercase alias", (value) => toNamespacedPath(value.toUpperCase())],
]) {
  test(
    `Windows Skill runs the bundled CLI from a ${name} installation path`,
    { skip: process.platform !== "win32" },
    (t) => {
      const f = fixture(t);
      const result = f.run({ CODEXBOARD_APP_PATH: path(f.app) }, ["--help"]);
      assert.equal(result.status, 7, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        args: ["--help"],
        cwd: f.cwd,
        data: join(f.local, "CodexBoard/data"),
      });
    },
  );
}
test(
  "Windows Skill discovers the configured per-user installer and rejects incomplete overrides",
  { skip: process.platform !== "win32" },
  (t) => {
    const f = fixture(t);
    assert.equal(f.run({}, ["--help"]).status, 7);
    assert.equal(f.run({ CODEXBOARD_APP_PATH: join(f.app, "missing") }, []).status, 2);
  },
);
