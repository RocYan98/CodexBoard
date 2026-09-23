import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { copyRuntimeScripts } from "./package-runtime.mjs";
import { copyBundledSkill } from "./package-skills.mjs";

const project = fileURLToPath(new URL("../../..", import.meta.url));
const windows = process.platform === "win32";
const variants = [
  ["ordinary", (path) => path],
  ...(windows
    ? [
        ["Windows verbatim", (path) => win32.toNamespacedPath(path)],
        ["Windows verbatim case alias", (path) => win32.toNamespacedPath(path.toUpperCase())],
      ]
    : [
        ["POSIX directory symlink", (path, f) => path.replace(f.root, f.alias)],
        [
          "POSIX preserved directory symlink",
          (path, f) => path.replace(f.root, f.alias),
          ["--preserve-symlinks-main"],
        ],
      ]),
];

function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "codexboard-entrypoints-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "安装资源 with spaces");
  const alias = join(directory, "linked resources");
  const home = join(directory, "isolated-home");
  const state = join(directory, "state");
  mkdirSync(home);
  copyRuntimeScripts(project, root);
  copyBundledSkill(project, root, "0.1.10");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      type: "module",
      imports: {
        "#private-file-permissions": "./scripts/private-file-permissions.mjs",
        "#codex-windows-app": "./scripts/codex-windows-app.mjs",
      },
    }),
  );
  symlinkSync(join(project, "node_modules"), join(root, "node_modules"), "junction");
  if (!windows) symlinkSync(root, alias, "dir");
  return {
    root,
    alias,
    state,
    home,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: join(home, ".codex"),
      NODE_OPTIONS: undefined,
      NODE_PATH: undefined,
      ...(windows
        ? {
            USERPROFILE: home,
            LOCALAPPDATA: join(home, "AppData/Local"),
            APPDATA: join(home, "AppData/Roaming"),
          }
        : {}),
    },
  };
}

for (const [name, path, nodeArgs = []] of variants) {
  test(`${name} runtime entry runs from a resource directory with spaces and Unicode`, async (t) => {
    const f = fixture(t);
    const child = spawn(
      process.execPath,
      [
        ...nodeArgs,
        path(join(f.root, "desktop/runtime.mjs"), f),
        windows ? path(f.root, f) : f.root,
        f.state,
      ],
      { cwd: f.home, env: f.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    const closed = once(child, "close");
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr = `${stderr}${chunk}`.slice(-4096)));
    const lines = createInterface({ input: child.stdout });
    let observedState = false;
    let requestedStop = false;
    try {
      await new Promise((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error("runtime entry timed out")),
          windows ? 60_000 : 5_000,
        );
        child.once("close", (code) => {
          clearTimeout(deadline);
          reject(new Error(`runtime exited before its response: ${code}; ${stderr}`));
        });
        child.once("error", reject);
        lines.on("line", (line) => {
          try {
            const record = JSON.parse(line);
            if (record.event === "state") {
              observedState = true;
              assert.deepEqual(record.data.services, []);
              if (!requestedStop) {
                requestedStop = true;
                child.stdin.write(JSON.stringify({ id: 41, action: "stop" }) + "\n");
              }
            }
            if (record.id === 41) {
              assert.equal(record.ok, true);
              clearTimeout(deadline);
              resolve();
            }
          } catch (error) {
            clearTimeout(deadline);
            reject(error);
          }
        });
      });
      assert.equal(observedState, true);
      child.stdin.end();
      assert.deepEqual(await closed, [0, null], stderr);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await closed;
      }
      lines.close();
    }
  });

  test(`${name} Skill CLI entry returns status without installing files`, (t) => {
    const f = fixture(t);
    const result = spawnSync(
      process.execPath,
      [
        ...nodeArgs,
        path(join(f.root, "desktop/skill-manager.mjs"), f),
        "status",
        windows ? path(f.root, f) : f.root,
        f.state,
        f.home,
        process.execPath,
      ],
      {
        cwd: f.home,
        env: f.env,
        encoding: "utf8",
        timeout: windows ? 30_000 : 5_000,
        windowsHide: true,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "notInstalled");
  });
}
