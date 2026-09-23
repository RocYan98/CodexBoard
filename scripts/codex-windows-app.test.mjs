import assert from "node:assert/strict";
import test from "node:test";
import { findWindowsCodexPackage } from "./codex-windows-app.mjs";

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
