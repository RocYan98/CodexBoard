import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  WINDOWS_RUNTIME_ASSETS,
  WINDOWS_BUNDLE_CONFIG,
  verifyRuntimeArchive,
} from "./build-windows.mjs";

test("Windows runtime archives must pass their pinned hash before extraction", () => {
  const bytes = Buffer.from("synthetic verified archive");
  const hash = createHash("sha256").update(bytes).digest("hex");
  verifyRuntimeArchive(bytes, hash);
  assert.throws(() => verifyRuntimeArchive(Buffer.from("truncated download"), hash), /SHA-256/);
  assert.deepEqual(
    WINDOWS_RUNTIME_ASSETS.map((asset) => asset.name),
    ["node", "caddy", "frpc"],
  );
  for (const asset of WINDOWS_RUNTIME_ASSETS) {
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.match(asset.binary, /\.exe$/);
    assert.match(asset.url, /^https:\/\/(?:nodejs.org|github.com)\//);
  }
});
test("Windows test installer has a valid icon and an install directory separate from user data", () => {
  const config = JSON.parse(
    readFileSync(new URL("../src-tauri/tauri.windows.conf.json", import.meta.url)),
  );
  assert.deepEqual(config.bundle.targets, ["nsis"]);
  assert.equal(config.bundle.windows.nsis.installMode, "currentUser");
  assert.equal(config.productName, "CodexBoard Windows Test");
  assert.equal(config.bundle.resources, undefined);
  assert.equal(WINDOWS_BUNDLE_CONFIG.bundle.resources["../dist/windows-runtime/"], "runtime/");
  const icon = readFileSync(new URL("../src-tauri/icons/icon.ico", import.meta.url));
  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  assert.ok(icon.readUInt16LE(4) > 0);
});
