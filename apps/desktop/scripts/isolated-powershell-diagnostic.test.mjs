import assert from "node:assert/strict";
import test from "node:test";
import {
  isolatedPowerShellVariants,
  summarizePowerShellProbe,
} from "./isolated-powershell-diagnostic.mjs";

test("PowerShell 2x2 diagnostics preserve isolated paths and copy only fixed system fields", () => {
  const env = {
    SystemRoot: "C:\\Windows",
    HOME: "C:\\fixture\\home",
    USERPROFILE: "C:\\fixture\\home",
    APPDATA: "C:\\fixture\\home\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\fixture\\home\\AppData\\Local",
    PATH: "C:\\fixture\\bin;C:\\Windows\\System32",
  };
  const system = {
    systemdrive: "C:",
    ProgramFiles: "C:\\Program Files",
    ProgramW6432: "C:\\Program Files",
    ProgramData: "C:\\ProgramData",
    ALLUSERSPROFILE: "C:\\ProgramData",
    PSModulePath: "C:\\real-user\\untrusted-modules",
    HOME: "C:\\real-user",
    USERPROFILE: "C:\\real-user",
    APPDATA: "C:\\real-user\\AppData\\Roaming",
    NODE_OPTIONS: "--require=secret",
    SECRET_TOKEN: "must-not-copy",
  };
  const variants = isolatedPowerShellVariants(env, system);
  assert.deepEqual(
    variants.map(({ name, createProfileDirectories }) => [name, createProfileDirectories]),
    [
      ["baseline", false],
      ["system-env", false],
      ["profile-directories", true],
      ["system-env-and-profile-directories", true],
    ],
  );
  assert.deepEqual(variants[0].env, env);
  assert.deepEqual(variants[2].env, env);
  for (const { env: augmented } of [variants[1], variants[3]]) {
    for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATH"])
      assert.equal(augmented[name], env[name]);
    assert.equal(augmented.SystemDrive, "C:");
    assert.equal(
      augmented.PSModulePath,
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules;C:\\Program Files\\WindowsPowerShell\\Modules",
    );
    assert.equal(augmented.NODE_OPTIONS, undefined);
    assert.equal(augmented.SECRET_TOKEN, undefined);
    assert.equal(JSON.stringify(augmented).includes("real-user"), false);
  }
});

test("PowerShell diagnostic summaries never relay stdout, stderr, paths or arbitrary error values", () => {
  const result = summarizePowerShellProbe(
    {
      status: null,
      signal: "SECRET_SIGNAL",
      stdout: "READY secret contents",
      stderr: "secret stderr",
      error: { code: "ETIMEDOUT", message: "C:\\private\\token", path: "secret" },
    },
    20001.2,
    "READY",
  );
  assert.deepEqual(result, {
    status: "timeout",
    exitCode: null,
    signal: null,
    errorCode: "ETIMEDOUT",
    marker: null,
    durationMs: 20001,
  });
  const unknown = summarizePowerShellProbe(
    {
      status: "secret",
      signal: "secret",
      error: { code: "secret" },
      stdout: "secret",
    },
    NaN,
    "PRIVATE",
  );
  assert.equal(unknown.errorCode, null);
  assert.equal(unknown.durationMs, null);
  assert.equal(JSON.stringify(unknown).includes("secret"), false);
  assert.equal(
    summarizePowerShellProbe({ status: 0, stdout: "PRIVATE" }, 40, "PRIVATE").status,
    "ok",
  );
  assert.equal(
    summarizePowerShellProbe({ status: 0, stdout: "READY" }, 40, "PRIVATE").status,
    "probe-failed",
  );
  assert.equal(
    summarizePowerShellProbe({ status: 1, stdout: "ACL_FAILED" }, 40, "PRIVATE").marker,
    "ACL_FAILED",
  );
});
