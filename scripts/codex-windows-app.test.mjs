import assert from "node:assert/strict";
import test from "node:test";
import { findWindowsCodexCli, findWindowsCodexPackage } from "./codex-windows-app.mjs";

const location = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.915.4065.0_x64__2p2nqsd0c76g0";
const metadata = { InstallLocation: location, PackageFamilyName: "OpenAI.Codex_2p2nqsd0c76g0" };

test("discovers the CLI inside the current-user registered Codex package", () => {
  const paths = [];
  const app = findWindowsCodexPackage({
    execute: (command, args, options) => {
      assert.equal(command, "powershell.exe");
      assert.ok(args.includes("-NoProfile"));
      assert.match(args.at(-1), /Get-AppxPackage -Name OpenAI.Codex/);
      assert.doesNotMatch(args.join(" "), /AllUsers|auth\.json|ExecutionPolicy/);
      assert.equal(options.timeout, 5000);
      return JSON.stringify(metadata);
    },
    exists: (path) => {
      paths.push(path);
      return true;
    },
  });
  assert.equal(app.cliPath, `${location}\\app\\resources\\codex.exe`);
  assert.equal(app.appUserModelId, "OpenAI.Codex_2p2nqsd0c76g0!App");
  assert.deepEqual(paths, [app.cliPath, app.appPath]);
});

test("does not return a missing, malformed or failed installation", () => {
  for (const output of [
    "",
    "private diagnostic",
    "null",
    JSON.stringify({ ...metadata, InstallLocation: "relative" }),
    JSON.stringify({ ...metadata, PackageFamilyName: "Other.App_foo" }),
  ])
    assert.equal(findWindowsCodexPackage({ execute: () => output, exists: () => true }), undefined);
  assert.equal(
    findWindowsCodexPackage({ execute: () => JSON.stringify(metadata), exists: () => false }),
    undefined,
  );
  assert.equal(
    findWindowsCodexPackage({
      execute: () => {
        throw new Error("private diagnostic");
      },
    }),
    undefined,
  );
});

test("prefers only the existing official standalone CLI without querying or executing the app", () => {
  const base = "C:\\Users\\Windows 用户\\AppData\\Local";
  const expected = `${base}\\Programs\\OpenAI\\Codex\\bin\\codex.exe`;
  const paths = [];
  assert.equal(
    findWindowsCodexCli({
      env: { LocalAppData: base, PATH: "C:\\untrusted", CODEX_PATH: "C:\\untrusted\\codex.exe" },
      exists: (path) => {
        paths.push(path);
        return path === expected;
      },
      findWindowsPackage: () => assert.fail("Standalone CLI discovery must not execute a probe"),
    }),
    expected,
  );
  assert.deepEqual(paths, [expected]);
});

test("a missing standalone CLI falls back to the registered package, never PATH or an alias", () => {
  const app = { cliPath: `${location}\\app\\resources\\codex.exe` };
  const paths = [];
  const exists = (path) => {
    paths.push(path);
    return false;
  };
  const options = { env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }, exists };
  assert.equal(
    findWindowsCodexCli({
      ...options,
      findWindowsPackage: (received) => {
        assert.equal(received.exists, exists);
        return app;
      },
    }),
    app.cliPath,
  );
  assert.equal(findWindowsCodexCli({ ...options, findWindowsPackage: () => undefined }), undefined);
  assert.deepEqual(paths, [
    "C:\\Users\\test\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
    "C:\\Users\\test\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
  ]);
});

test("rejects missing, relative, drive-relative, rooted and malformed standalone base paths", () => {
  for (const localAppData of [
    undefined,
    null,
    "",
    "relative",
    "C:relative",
    "\\Users\\test",
    "/Users/test",
    "C:\\Users\\..\\elsewhere",
    "C:\\Users\\test\nprivate-output",
    "C:\\Users\\test\0suffix",
    "C:\\Users\\test:stream",
    "C:\\Users\\*\\AppData",
    "\\\\.\\pipe\\Codex",
  ]) {
    assert.equal(
      findWindowsCodexCli({
        env: {},
        localAppData,
        exists: () => assert.fail("Invalid standalone roots must not probe the filesystem"),
        findWindowsPackage: () => ({ cliPath: "registered-package-cli" }),
      }),
      "registered-package-cli",
    );
  }
});

test("accepts fully qualified namespace and UNC base paths without changing the fixed suffix", () => {
  for (const base of ["\\\\?\\C:\\Users\\test\\AppData\\Local", "\\\\server\\profiles\\test"])
    assert.equal(
      findWindowsCodexCli({
        env: {},
        localAppData: base,
        exists: () => true,
        findWindowsPackage: () => assert.fail("The existing standalone path takes priority"),
      }),
      `${base}\\Programs\\OpenAI\\Codex\\bin\\codex.exe`,
    );
});
