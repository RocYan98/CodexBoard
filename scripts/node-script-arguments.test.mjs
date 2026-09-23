import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, win32 } from "node:path";
import test from "node:test";
import { nodeScriptArguments } from "./node-script-arguments.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "node-main 安装资源 with spaces-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("the real ESM entry accepts filename aliases and preserves application arguments", (t) => {
  const directory = fixture(t);
  const script = join(directory, "entry.mjs");
  writeFileSync(
    script,
    "import { argv } from 'node:process'; process.stdout.write(JSON.stringify(argv.slice(2)));",
  );
  const args = Object.freeze(["argument with spaces", 'Unicode 中文 and quotes \\"', "--option"]);
  const input =
    process.platform === "win32" ? win32.toNamespacedPath(script).toUpperCase() : script;
  const launch = nodeScriptArguments(input, args);
  if (process.platform === "win32") {
    assert.equal(basename(launch[1]), "entry.mjs");
    assert.equal(launch[1].startsWith("\\\\?\\"), true);
  }
  const result = spawnSync(process.execPath, launch, {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test("missing entrypoints keep Node's normal failure instead of failing command construction", (t) => {
  const script = join(fixture(t), "missing.mjs");
  const result = spawnSync(process.execPath, nodeScriptArguments(script), {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MODULE_NOT_FOUND/);
  assert.match(result.stderr, /missing\.mjs/);
});

if (process.platform !== "win32") {
  test("simulating Windows arguments never resolves a foreign path on a POSIX host", (t) => {
    const realpath = t.mock.method(realpathSync, "native", () => {
      throw new Error("unexpected host filesystem access");
    });
    const script = "\\\\?\\C:\\Program Files\\CodexBoard\\ENTRY.MJS";
    assert.deepEqual(nodeScriptArguments(script, ["argument"], "win32"), [
      "--preserve-symlinks-main",
      script,
      "argument",
    ]);
    assert.equal(realpath.mock.callCount(), 0);
  });
}
