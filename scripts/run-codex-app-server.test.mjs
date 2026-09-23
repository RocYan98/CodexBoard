import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import test from "node:test";

import * as codexBridge from "./run-codex-app-server.mjs";
import { assertPrivateFileSync, ensurePrivateFileSync } from "./private-file-permissions.mjs";
import { makePublicReadableSync } from "./test-support/private-access.mjs";

const { buildCodexArguments, validateCodexBridgeOptions } = codexBridge;
const PROJECT_ROOT = join(tmpdir(), "codexboard-runner-fixture-projects");

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "codexboard-codex-bridge-"));
  const codexPath = join(directory, "codex");
  const tokenFile = join(directory, "codex-token");
  const projectStateFile = join(directory, ".codex-global-state.json");
  const projectSnapshotFile = join(directory, "run", "codex-projects.json");
  writeFileSync(codexPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeFileSync(tokenFile, "capability-token\n", { mode: 0o600 });
  ensurePrivateFileSync(tokenFile);
  writeFileSync(projectStateFile, "{}\n", { mode: 0o600 });
  return { directory, codexPath, tokenFile, projectStateFile, projectSnapshotFile };
}

test("builds stdio session workers behind the authenticated loopback bridge", () => {
  const value = fixture();
  try {
    const options = validateCodexBridgeOptions({
      codexPath: value.codexPath,
      tokenFile: value.tokenFile,
      endpoint: "ws://127.0.0.1:47825",
      projectStateFile: value.projectStateFile,
      projectSnapshotFile: value.projectSnapshotFile,
    });
    assert.deepEqual(buildCodexArguments(options), ["app-server", "--listen", "stdio://"]);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("rejects non-loopback endpoints and unsafe token files", () => {
  const value = fixture();
  try {
    assert.throws(
      () =>
        validateCodexBridgeOptions({
          codexPath: value.codexPath,
          tokenFile: value.tokenFile,
          endpoint: "ws://0.0.0.0:47825",
          projectStateFile: value.projectStateFile,
          projectSnapshotFile: value.projectSnapshotFile,
        }),
      /ws:\/\/127\.0\.0\.1/,
    );
    makePublicReadableSync(value.tokenFile);
    assert.throws(
      () =>
        validateCodexBridgeOptions({
          codexPath: value.codexPath,
          tokenFile: value.tokenFile,
          endpoint: "ws://127.0.0.1:47825",
          projectStateFile: value.projectStateFile,
          projectSnapshotFile: value.projectSnapshotFile,
        }),
      /0600|ACL|符号链接/,
    );
    ensurePrivateFileSync(value.tokenFile);
    const symlink = join(value.directory, "token-link");
    symlinkSync(value.tokenFile, symlink);
    assert.throws(
      () =>
        validateCodexBridgeOptions({
          codexPath: value.codexPath,
          tokenFile: symlink,
          endpoint: "ws://127.0.0.1:47825",
          projectStateFile: value.projectStateFile,
          projectSnapshotFile: value.projectSnapshotFile,
        }),
      /0600|ACL|符号链接/,
    );
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("accepts allocated loopback ports and rejects unsafe bridge URLs", () => {
  const value = fixture();
  try {
    for (const port of [1, 80, 47826, 65535]) {
      const endpoint = `ws://127.0.0.1:${port}`;
      assert.equal(
        validateCodexBridgeOptions({ ...value, endpoint }).endpoint,
        new URL(endpoint).origin,
      );
    }
    for (const endpoint of [
      "invalid-url",
      "ws://127.0.0.1:0",
      "ws://127.0.0.1:65536",
      "wss://127.0.0.1:47826",
      "ws://localhost:47826",
      "ws://192.168.1.1:47826",
      "ws://user:secret@127.0.0.1:47826",
      "ws://127.0.0.1:47826/path",
      "ws://127.0.0.1:47826/?q=1",
      "ws://127.0.0.1:47826/#fragment",
      "ws://127.0.0.1:47826/?",
      "ws://127.0.0.1:47826/#",
    ])
      assert.throws(() => validateCodexBridgeOptions({ ...value, endpoint }));
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("starts the real authenticated bridge on a non-default allocated port", async () => {
  const value = fixture();
  const projectId = "11111111-1111-4111-8111-111111111111";
  writeFileSync(
    value.projectStateFile,
    JSON.stringify({
      "local-projects": {
        [projectId]: { id: projectId, name: "Test project", rootPaths: [value.directory] },
      },
      "project-order": [projectId],
    }),
  );
  const reservation = createServer();
  let running;
  try {
    await new Promise((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", resolve);
    });
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    running = await codexBridge.startCodexBridge({ ...value, endpoint: `ws://127.0.0.1:${port}` });
    const response = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(response.status, 200);
    await response.text();
  } finally {
    reservation.close();
    await running?.close();
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("reads only Codex Desktop projects present in project-order", () => {
  const value = fixture();
  try {
    writeFileSync(
      value.projectStateFile,
      `${JSON.stringify({
        "local-projects": {
          "11111111-1111-4111-8111-111111111111": {
            id: "11111111-1111-4111-8111-111111111111",
            name: "论文",
            rootPaths: [join(PROJECT_ROOT, "Projects", "codex-paper")],
          },
          "22222222-2222-4222-8222-222222222222": {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Docker",
            rootPaths: [join(PROJECT_ROOT, "Docker"), join(PROJECT_ROOT, "Docker", "tools")],
          },
          "g-p-internal": {
            id: "g-p-internal",
            name: "临时",
            rootPaths: [join(PROJECT_ROOT, ".codex", ".chatgpt-projects", "g-p-internal")],
          },
          "33333333-3333-4333-8333-333333333333": {
            id: "33333333-3333-4333-8333-333333333333",
            name: "残留项目",
            rootPaths: [join(PROJECT_ROOT, "stale")],
          },
        },
        "project-order": [
          "22222222-2222-4222-8222-222222222222",
          "11111111-1111-4111-8111-111111111111",
        ],
      })}\n`,
    );
    const actual =
      typeof codexBridge.readCodexDesktopProjects === "function"
        ? codexBridge.readCodexDesktopProjects(value.projectStateFile)
        : null;
    assert.deepEqual(actual, [
      {
        codexProjectId: "22222222-2222-4222-8222-222222222222",
        name: "Docker",
        rootPaths: [join(PROJECT_ROOT, "Docker"), join(PROJECT_ROOT, "Docker", "tools")],
        position: 0,
      },
      {
        codexProjectId: "11111111-1111-4111-8111-111111111111",
        name: "论文",
        rootPaths: [join(PROJECT_ROOT, "Projects", "codex-paper")],
        position: 1,
      },
    ]);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("atomically writes a private minimal project snapshot", () => {
  const value = fixture();
  try {
    const snapshot = {
      schemaVersion: 1,
      generatedAt: "2026-09-01T12:00:00.000Z",
      projects: [
        {
          codexProjectId: "11111111-1111-4111-8111-111111111111",
          name: "论文",
          rootPaths: [join(PROJECT_ROOT, "Projects", "codex-paper")],
          position: 0,
        },
      ],
    };
    const written =
      typeof codexBridge.writeProjectSnapshot === "function"
        ? codexBridge.writeProjectSnapshot(value.projectSnapshotFile, snapshot)
        : false;
    assert.equal(written, true);
    assert.deepEqual(JSON.parse(readFileSync(value.projectSnapshotFile, "utf8")), snapshot);
    assertPrivateFileSync(value.projectSnapshotFile);
    if (process.platform !== "win32")
      assert.equal(statSync(value.projectSnapshotFile).mode & 0o777, 0o600);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("validates controlled project state and snapshot paths", () => {
  const value = fixture();
  try {
    const options = validateCodexBridgeOptions({
      codexPath: value.codexPath,
      tokenFile: value.tokenFile,
      endpoint: "ws://127.0.0.1:47825",
      projectStateFile: value.projectStateFile,
      projectSnapshotFile: value.projectSnapshotFile,
    });
    assert.equal(options.projectStateFile, value.projectStateFile);
    assert.equal(options.projectSnapshotFile, value.projectSnapshotFile);
    assert.throws(
      () =>
        validateCodexBridgeOptions({
          codexPath: value.codexPath,
          tokenFile: value.tokenFile,
          endpoint: "ws://127.0.0.1:47825",
          projectStateFile: "relative-state.json",
          projectSnapshotFile: value.projectSnapshotFile,
        }),
      /Codex 项目状态文件必须是绝对路径/,
    );
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("embedded bridge exposes an idempotent close without installing process signal handlers", async () => {
  const value = fixture();
  const before = process.listenerCount("SIGTERM");
  let bridgeClosed = 0;
  let watcherClosed = 0;
  try {
    const running = await codexBridge.startCodexBridge(
      { ...value, endpoint: "ws://127.0.0.1:47825" },
      {
        startSnapshotWriter: () => ({
          close: () => {
            watcherClosed++;
          },
        }),
        createBridge: async () => ({
          close: async () => {
            bridgeClosed++;
          },
        }),
      },
    );
    assert.equal(process.listenerCount("SIGTERM"), before);
    await Promise.all([running.close(), running.close()]);
    assert.equal(bridgeClosed, 1);
    assert.equal(watcherClosed, 1);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("failed embedded bridge startup and shutdown both release the project watcher", async () => {
  const value = fixture();
  let closed = 0;
  const options = { ...value, endpoint: "ws://127.0.0.1:47825" };
  try {
    await assert.rejects(
      codexBridge.startCodexBridge(options, {
        startSnapshotWriter: () => ({
          close: () => {
            closed++;
          },
        }),
        createBridge: async () => {
          throw new Error("port occupied");
        },
      }),
      /port occupied/,
    );
    assert.equal(closed, 1);
    const bridge = await codexBridge.startCodexBridge(options, {
      startSnapshotWriter: () => ({
        close: () => {
          closed++;
        },
      }),
      createBridge: async () => ({
        close: async () => {
          throw new Error("close failed");
        },
      }),
    });
    await assert.rejects(bridge.close(), /close failed/);
    assert.equal(closed, 2);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});
