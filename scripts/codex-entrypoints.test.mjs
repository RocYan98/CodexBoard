import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const entrypoints = [
  ["run-codex-app-server.mjs", /CODEX_BRIDGE_START_FAILED/],
  ["codex-session-bridge.mjs", /Expected --codex and a local --listen endpoint/],
];

for (const [name, expectedError] of entrypoints) {
  const path = fileURLToPath(new URL(name, import.meta.url));
  const variants = [["ordinary", path]];
  if (process.platform === "win32") {
    variants.push(
      ["namespaced", toNamespacedPath(path)],
      ["namespaced uppercase alias", toNamespacedPath(path).toUpperCase()],
    );
  }
  for (const [variant, entrypoint] of variants) {
    test(`${name} executes its CLI from a ${variant} path`, () => {
      // Missing options must enter CLI validation. No server, Codex worker or
      // Desktop session is started, even on a developer's signed-in machine.
      const result = spawnSync(process.execPath, [entrypoint], {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, expectedError);
    });
  }
  if (process.platform !== "win32") {
    for (const flags of [[], ["--preserve-symlinks-main"]]) {
      test(`${name} executes from a symlinked directory ${flags.join(" ")}`, () => {
        const directory = mkdtempSync(join(tmpdir(), "codexboard-entrypoint-"));
        try {
          const linkedProject = join(directory, "linked project 中文 # %");
          symlinkSync(fileURLToPath(new URL("../", import.meta.url)), linkedProject, "dir");
          const result = spawnSync(
            process.execPath,
            [...flags, join(linkedProject, "scripts", name)],
            { encoding: "utf8", timeout: 10_000 },
          );
          assert.ifError(result.error);
          assert.equal(result.status, 1, result.stderr);
          assert.match(result.stderr, expectedError);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
  }
}

for (const name of [...entrypoints.map(([name]) => name), "probe-codex-desktop-ipc.mjs"]) {
  test(`${name} can be imported when the host has no existing entrypoint path`, () => {
    const moduleUrl = new URL(name, import.meta.url).href;
    const missingEntrypoint = join(tmpdir(), `codexboard-missing-entrypoint-${randomUUID()}.mjs`);
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `process.argv[1] = ${JSON.stringify(missingEntrypoint)}; await import(${JSON.stringify(moduleUrl)}); process.stdout.write("imported");`,
      ],
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "imported");
  });
}
