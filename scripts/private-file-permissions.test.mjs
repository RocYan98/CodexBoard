import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertPrivateDirectorySync,
  assertPrivateFileSync,
  ensurePrivateDirectorySync,
  ensurePrivateFileSync,
} from "./private-file-permissions.mjs";
import { makePublicReadableSync } from "./test-support/private-access.mjs";

test("private files survive atomic replacement and reject an actual public read grant", () => {
  const root = mkdtempSync(join(tmpdir(), "codexboard-private-"));
  const directory = join(root, "私有 [data] ' literal");
  try {
    ensurePrivateDirectorySync(directory);
    assertPrivateDirectorySync(directory);
    const temporary = join(directory, "token.tmp");
    const final = join(directory, "token");
    writeFileSync(temporary, "fixture-only", { flag: "wx", mode: 0o600 });
    ensurePrivateFileSync(temporary);
    renameSync(temporary, final);
    assertPrivateFileSync(final);
    assert.equal(readFileSync(final, "utf8"), "fixture-only");
    if (process.platform !== "win32") {
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      assert.equal(statSync(final).mode & 0o777, 0o600);
    }
    makePublicReadableSync(final);
    assert.throws(() => assertPrivateFileSync(final), /0600|ACL/);
    ensurePrivateFileSync(final);
    assertPrivateFileSync(final);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects non-files and symlinked directories without changing the target", () => {
  const root = mkdtempSync(join(tmpdir(), "codexboard-private-link-"));
  try {
    const target = join(root, "target");
    mkdirSync(target);
    const link = join(root, "link");
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => ensurePrivateDirectorySync(link), /符号链接/);
    assert.throws(() => assertPrivateFileSync(target), /普通文件/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "Windows ACL independently contains only current-user grants with inheritance disabled",
  { skip: process.platform !== "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "codexboard-private-dacl-"));
    try {
      ensurePrivateDirectorySync(root);
      const file = join(root, "fixture-token");
      writeFileSync(file, "fixture-only");
      ensurePrivateFileSync(file);
      const script = String.raw`
$ErrorActionPreference='Stop'
$path=[Console]::In.ReadToEnd()
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl=Get-Acl -LiteralPath $path
$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { @{ sid=$_.IdentityReference.Value; inherited=$_.IsInherited; type=$_.AccessControlType.ToString() } })
@{ sid=$sid; owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; protected=$acl.AreAccessRulesProtected; rules=$rules } | ConvertTo-Json -Depth 4 -Compress
`;
      const result = spawnSync(
        join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { input: file, encoding: "utf8", timeout: 20_000, windowsHide: true },
      );
      assert.equal(result.status, 0);
      const acl = JSON.parse(result.stdout);
      assert.equal(acl.owner, acl.sid);
      assert.equal(acl.protected, true);
      assert.deepEqual(acl.rules, [{ sid: acl.sid, inherited: false, type: "Allow" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
