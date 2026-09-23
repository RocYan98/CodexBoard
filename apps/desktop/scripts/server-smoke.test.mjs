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
import { smokeConfigDiagnostics, smokePackagedServer } from "./server-smoke.mjs";

const project = fileURLToPath(new URL("../../..", import.meta.url));

test(
  "the packaged backend boots with isolated synthetic state, enforces auth, and stops over IPC",
  { timeout: 180_000 },
  async (t) => {
    const onStage = (stage) => process.stdout.write(`PACKAGED_SMOKE_STAGE ${stage}\n`);
    onStage("package-copy");
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
    const result = await smokePackagedServer({ runtimeRoot, nodePath, onStage });
    assert.deepEqual(result, {
      status: "passed",
      backendHealth: true,
      webAssets: true,
      authenticationRequired: true,
      gracefulShutdown: true,
      codexMode: "isolated-fake-websocket",
    });

    rmSync(join(runtimeRoot, "apps/web/dist/index.html"));
    await assert.rejects(smokePackagedServer({ runtimeRoot, nodePath, onStage }), (error) => {
      assert.equal(error.code, "SMOKE_BACKEND_EXITED");
      assert.match(error.message, /CONFIG_INVALID/);
      assert.match(error.message, /CODEXBOARD_WEB_ROOT/);
      assert.match(error.message, /WEB_INDEX_MISSING/);
      assert.equal(error.message.includes(runtimeRoot), false);
      return true;
    });

    // A real package omission must be a failed smoke with a fixed diagnostic code,
    // not a successful import of the source checkout or a leaked native stack.
    rmSync(join(runtimeRoot, "scripts/node-script-arguments.mjs"));
    await assert.rejects(smokePackagedServer({ runtimeRoot, nodePath, onStage }), (error) => {
      assert.equal(error.code, "SMOKE_BACKEND_EXITED");
      assert.match(error.message, /ERR_MODULE_NOT_FOUND/);
      assert.equal(error.message.includes(runtimeRoot), false);
      return true;
    });
  },
);

test("isolated config diagnostics keep only fixed codes and never forward native output", (t) => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "codexboard-config-diagnostic-"));
  t.after(() => rmSync(runtimeRoot, { recursive: true, force: true }));
  const directory = join(runtimeRoot, "apps/server/dist");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(runtimeRoot, "package.json"), JSON.stringify({ type: "module" }));
  const secret = "fake-secret-must-not-appear";
  writeFileSync(
    join(directory, "config.js"),
    `export function loadConfig() {
      console.error(${JSON.stringify(secret)});
      throw Object.assign(new Error(${JSON.stringify(secret)}), {issues: [
        'CODEXBOARD_CODEX_TOKEN_FILE: Windows 私有 ACL 检查失败 ${secret}',
        'UNTRUSTED_FIELD: ${secret}'
      ]});
    }`,
  );
  const options = {
    runtimeRoot,
    nodePath: process.execPath,
    env: { SystemRoot: process.env.SystemRoot, HOME: runtimeRoot, USERPROFILE: runtimeRoot },
  };
  assert.deepEqual(smokeConfigDiagnostics(options), [
    "SMOKE_CONFIG_RECHECK_FAILED",
    "CODEXBOARD_CODEX_TOKEN_FILE",
    "ACL_FAILED",
  ]);
  writeFileSync(
    join(directory, "config.js"),
    `console.log(${JSON.stringify(secret)});export function loadConfig() {}`,
  );
  assert.deepEqual(smokeConfigDiagnostics(options), ["SMOKE_CONFIG_DIAGNOSTIC_FAILED"]);
});
