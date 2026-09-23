import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assertDistributionClean } from "./release-macos.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "codexboard-release-scan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("release rejects actual credential filenames even without a local path in their contents", (t) => {
  const root = fixture(t);
  for (const name of [
    "updater.key",
    "feishu-credentials.json",
    "codex-app-server-token",
    "feishu-app-secret",
    "production.env",
    "taskboard.sqlite-wal",
  ]) {
    writeFileSync(join(root, name), "synthetic credential fixture");
    assert.throws(() => assertDistributionClean(root), /私人配置/);
    rmSync(join(root, name));
  }
});

test("release rejects compiler metadata containing the local home directory", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "config.gypi"), JSON.stringify({ cwd: join(homedir(), "build") }));
  assert.throws(() => assertDistributionClean(root), /本机路径/);
});

test("release preserves internal workspace links and rejects links outside the application", (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "runtime/packages/contracts"), { recursive: true });
  mkdirSync(join(root, "runtime/node_modules/@codexboard"), { recursive: true });
  const link = join(root, "runtime/node_modules/@codexboard/contracts");
  symlinkSync("../../packages/contracts", link, "dir");
  assert.doesNotThrow(() => assertDistributionClean(root));
  rmSync(link);
  symlinkSync("../../../../outside", link, "dir");
  assert.throws(() => assertDistributionClean(root), /应用外/);
  rmSync(link);
  symlinkSync(homedir(), link, "dir");
  assert.throws(() => assertDistributionClean(root), /应用外/);
});

test("release rejects chained links whose actual target escapes the application", (t) => {
  const root = fixture(t);
  const app = join(root, "App.app");
  mkdirSync(app);
  mkdirSync(join(root, "outside"));
  writeFileSync(join(root, "outside/fixture.txt"), "synthetic outside target");
  // Win32 resolves dot segments before following links; POSIX resolves them after.
  const windows = process.platform === "win32";
  symlinkSync(windows ? "../outside" : ".", join(app, "alias"), "dir");
  symlinkSync(windows ? "alias" : "alias/../outside", join(app, "indirect"), "dir");
  assert.equal(readFileSync(join(app, "indirect/fixture.txt"), "utf8"), "synthetic outside target");
  assert.throws(() => assertDistributionClean(app), /应用外/);
});

test("release rejects dangling links instead of skipping their unresolved targets", (t) => {
  const root = fixture(t);
  symlinkSync("missing", join(root, "dangling"));
  assert.throws(() => assertDistributionClean(root), /链接无法解析/);
});
