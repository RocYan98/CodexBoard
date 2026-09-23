import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  copyRuntimeDependencies,
  copyRuntimeDist,
  copyRuntimeScripts,
} from "./package-runtime.mjs";
import { smokePackagedServer } from "./server-smoke.mjs";

const project = fileURLToPath(new URL("../../..", import.meta.url));

test(
  "the packaged backend boots with isolated synthetic state, enforces auth, and stops over IPC",
  { timeout: 180_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "codexboard-packaged-server-"));
    t.after(() =>
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
    );
    const runtimeRoot = join(directory, "安装包 with spaces");
    // Windows Node is self-contained; a POSIX development Node may depend on
    // adjacent Homebrew shared libraries and cannot be copied alone.
    const nodePath =
      process.platform === "win32" ? join(runtimeRoot, "bin", "node.exe") : process.execPath;
    mkdirSync(join(runtimeRoot, "bin"), { recursive: true });
    if (process.platform === "win32") cpSync(process.execPath, nodePath);
    for (const workspace of ["apps/server", "packages/contracts", "packages/taskctl"]) {
      copyRuntimeDist(join(project, workspace, "dist"), join(runtimeRoot, workspace, "dist"));
      cpSync(
        join(project, workspace, "package.json"),
        join(runtimeRoot, workspace, "package.json"),
      );
    }
    copyRuntimeDist(join(project, "apps/web/dist"), join(runtimeRoot, "apps/web/dist"));
    copyRuntimeScripts(project, runtimeRoot);
    writeFileSync(
      join(runtimeRoot, "package.json"),
      JSON.stringify({
        type: "module",
        imports: JSON.parse(readFileSync(join(project, "package.json"), "utf8")).imports,
      }),
    );
    copyRuntimeDependencies(project, runtimeRoot);
    for (const name of ["contracts", "taskctl"])
      cpSync(
        join(runtimeRoot, "packages", name),
        join(runtimeRoot, "node_modules/@codexboard", name),
        { recursive: true },
      );
    const result = await smokePackagedServer({ runtimeRoot, nodePath });
    assert.deepEqual(result, {
      status: "passed",
      backendHealth: true,
      webAssets: true,
      authenticationRequired: true,
      gracefulShutdown: true,
      codexMode: "isolated-fake-websocket",
    });

    // A real package omission must be a failed smoke with a fixed diagnostic code,
    // not a successful import of the source checkout or a leaked native stack.
    rmSync(join(runtimeRoot, "scripts/node-script-arguments.mjs"));
    await assert.rejects(smokePackagedServer({ runtimeRoot, nodePath }), (error) => {
      assert.equal(error.code, "SMOKE_BACKEND_EXITED");
      assert.match(error.message, /ERR_MODULE_NOT_FOUND/);
      assert.equal(error.message.includes(runtimeRoot), false);
      return true;
    });
  },
);
