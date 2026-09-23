import assert from "node:assert/strict";
import fs, {
  fstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { assertPrivateFileSync } from "./private-file-permissions.mjs";

import {
  readCodexDesktopProjects,
  startCodexProjectSnapshotWriter,
  writeProjectSnapshot,
} from "./codex-project-snapshot.mjs";

const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "22222222-2222-4222-8222-222222222222";
const PROJECT_ROOT = resolve(tmpdir(), "codexboard-snapshot-fixture-projects");
const PROJECT_A_PATH = join(PROJECT_ROOT, "Projects", "codex-paper");

test("passes an absolute project snapshot path from the root development command", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(packageJson.scripts["dev:project-sync"], /--snapshot-file "\$PWD\//);
});

function state(projectOrder = [PROJECT_A], overrides = {}) {
  return {
    "local-projects": {
      [PROJECT_A]: {
        id: PROJECT_A,
        name: "论文",
        rootPaths: [PROJECT_A_PATH],
      },
      [PROJECT_B]: {
        id: PROJECT_B,
        name: "Docker",
        rootPaths: [join(PROJECT_ROOT, "Docker")],
      },
      internal: {
        id: "internal",
        name: "临时",
        rootPaths: [join(PROJECT_ROOT, ".codex", ".chatgpt-projects", "internal")],
      },
      ...overrides,
    },
    "project-order": projectOrder,
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "codexboard-project-snapshot-"));
  const stateFile = join(directory, ".codex-global-state.json");
  const snapshotFile = join(directory, "run", "codex-projects.json");
  writeFileSync(stateFile, `${JSON.stringify(state())}\n`, { mode: 0o600 });
  return { directory, stateFile, snapshotFile };
}

async function waitFor(check, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.fail("等待 Codex 项目快照更新超时");
}

test("filters the Desktop state strictly by project-order", () => {
  const value = fixture();
  try {
    assert.deepEqual(readCodexDesktopProjects(value.stateFile), [
      {
        codexProjectId: PROJECT_A,
        name: "论文",
        rootPaths: [PROJECT_A_PATH],
        position: 0,
      },
    ]);
    writeFileSync(
      value.stateFile,
      `${JSON.stringify(
        state([PROJECT_A], {
          [PROJECT_A]: { id: PROJECT_A, name: "论文", rootPaths: ["relative/path"] },
        }),
      )}\n`,
    );
    assert.throws(() => readCodexDesktopProjects(value.stateFile), /绝对路径/);
    writeFileSync(value.stateFile, `${JSON.stringify(state(["missing-project"]))}\n`);
    assert.throws(() => readCodexDesktopProjects(value.stateFile), /记录无效/);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("flushes each snapshot file before atomic replacement and syncs directories where supported", (t) => {
  const value = fixture();
  const snapshot = {
    schemaVersion: 1,
    generatedAt: "2026-09-01T12:00:00.000Z",
    projects: readCodexDesktopProjects(value.stateFile),
  };
  const operations = [];
  const originalFsync = fs.fsyncSync;
  const originalRename = fs.renameSync;
  const sync = t.mock.method(fs, "fsyncSync", (descriptor) => {
    operations.push(fstatSync(descriptor).isDirectory() ? "directory-flush" : "file-flush");
    return originalFsync(descriptor);
  });
  const rename = t.mock.method(fs, "renameSync", (source, destination) => {
    assert.equal(operations.at(-1), "file-flush");
    assert.equal(dirname(source), dirname(destination));
    operations.push("rename");
    return originalRename(source, destination);
  });
  syncBuiltinESMExports();
  try {
    const expected =
      process.platform === "win32"
        ? ["file-flush", "rename"]
        : ["file-flush", "rename", "directory-flush"];
    assert.equal(writeProjectSnapshot(value.snapshotFile, snapshot), true);
    assert.deepEqual(JSON.parse(readFileSync(value.snapshotFile, "utf8")), snapshot);
    assert.deepEqual(operations, expected);
    operations.length = 0;
    const replacement = { ...snapshot, generatedAt: "2026-09-02T12:00:00.000Z", projects: [] };
    assert.equal(writeProjectSnapshot(value.snapshotFile, replacement), true);
    assert.deepEqual(JSON.parse(readFileSync(value.snapshotFile, "utf8")), replacement);
    assert.deepEqual(operations, expected);
    assert.deepEqual(readdirSync(dirname(value.snapshotFile)), ["codex-projects.json"]);
  } finally {
    sync.mock.restore();
    rename.mock.restore();
    syncBuiltinESMExports();
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("propagates a file flush failure and preserves the previous snapshot without temporary files", (t) => {
  const value = fixture();
  const snapshot = {
    schemaVersion: 1,
    generatedAt: "2026-09-01T12:00:00.000Z",
    projects: readCodexDesktopProjects(value.stateFile),
  };
  try {
    writeProjectSnapshot(value.snapshotFile, snapshot);
    const lastGood = readFileSync(value.snapshotFile, "utf8");
    const failure = Object.assign(new Error("simulated file flush failure"), { code: "EIO" });
    const sync = t.mock.method(fs, "fsyncSync", (descriptor) => {
      assert.equal(fstatSync(descriptor).isFile(), true);
      throw failure;
    });
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => writeProjectSnapshot(value.snapshotFile, { ...snapshot, projects: [] }),
        (error) => error === failure,
      );
      assert.equal(readFileSync(value.snapshotFile, "utf8"), lastGood);
      assert.deepEqual(readdirSync(dirname(value.snapshotFile)), ["codex-projects.json"]);
    } finally {
      sync.mock.restore();
      syncBuiltinESMExports();
    }
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("keeps the last good snapshot and reports only a safe error code", () => {
  const value = fixture();
  const errors = [];
  const writer = startCodexProjectSnapshotWriter({
    stateFile: value.stateFile,
    snapshotFile: value.snapshotFile,
    reconcileMs: 60_000,
    now: () => new Date("2026-09-01T12:00:00.000Z"),
    onError: (error) => errors.push(error),
  });
  try {
    const lastGood = readFileSync(value.snapshotFile, "utf8");
    writeFileSync(value.stateFile, '{"local-projects":');
    assert.equal(writer.refresh(), false);
    assert.equal(readFileSync(value.snapshotFile, "utf8"), lastGood);
    assert.deepEqual(errors.at(-1), { code: "CODEX_PROJECT_STATE_INVALID" });
    assertPrivateFileSync(value.snapshotFile);
    if (process.platform !== "win32")
      assert.equal(statSync(value.snapshotFile).mode & 0o777, 0o600);
  } finally {
    writer.close();
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("continues watching after Codex atomically replaces its state file", async () => {
  const value = fixture();
  let notifyChange;
  let watchedDirectory;
  let watcherClosed = false;
  const writer = startCodexProjectSnapshotWriter({
    stateFile: value.stateFile,
    snapshotFile: value.snapshotFile,
    debounceMs: 5,
    reconcileMs: 60_000,
    watchFactory: (directory, listener) => {
      watchedDirectory = directory;
      notifyChange = listener;
      return {
        close() {
          watcherClosed = true;
        },
        on() {},
      };
    },
  });
  try {
    assert.equal(watchedDirectory, value.directory);
    const replacement = join(value.directory, ".codex-global-state.replacement.json");
    writeFileSync(replacement, `${JSON.stringify(state([PROJECT_B, PROJECT_A]))}\n`, {
      mode: 0o600,
    });
    renameSync(replacement, value.stateFile);
    notifyChange("rename", ".codex-global-state.json");
    await waitFor(() => {
      const snapshot = JSON.parse(readFileSync(value.snapshotFile, "utf8"));
      return (
        snapshot.projects.map((project) => project.codexProjectId).join(",") ===
        `${PROJECT_B},${PROJECT_A}`
      );
    });
  } finally {
    writer.close();
    assert.equal(watcherClosed, true);
    rmSync(value.directory, { recursive: true, force: true });
  }
});
