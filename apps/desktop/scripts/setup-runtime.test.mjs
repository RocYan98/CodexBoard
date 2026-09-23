import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

test(
  "desktop command protocol publishes draft check results without saving config or starting services",
  { timeout: process.platform === "win32" ? 120_000 : 8_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexboard-setup-runtime-"));
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./runtime.mjs", import.meta.url)),
        join(directory, "bundle"),
        join(directory, "state"),
      ],
      {
        env: {
          ...process.env,
          HOME: directory,
          ...(process.platform === "win32"
            ? { USERPROFILE: directory, LOCALAPPDATA: join(directory, "LocalAppData") }
            : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const exit = once(child, "exit");
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4096);
    });
    const records = [];
    let onRecord;
    createInterface({ input: child.stdout }).on("line", (line) => {
      const record = JSON.parse(line);
      records.push(record);
      onRecord?.();
    });
    async function waitFor(predicate) {
      if (records.some(predicate)) return records.findLast(predicate);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => {
            onRecord = undefined;
            reject(
              new Error(`No matching desktop response; exit=${child.exitCode}; stderr=${stderr}`),
            );
          },
          process.platform === "win32" ? 30_000 : 3_000,
        );
        onRecord = () => {
          const record = records.findLast(predicate);
          if (!record) return;
          clearTimeout(timer);
          onRecord = undefined;
          resolve(record);
        };
      });
    }
    try {
      await waitFor((record) => record.event === "state");
      child.stdin.write(
        JSON.stringify({
          id: "check",
          action: "setup_check",
          settings: {
            section: "feishu",
            requestKey: "runtime-1",
            appId: "",
            appSecret: "unsaved-secret",
            frpc: "unsaved-toml",
          },
        }) + "\n",
      );
      await waitFor((record) => record.id === "check" && record.ok);
      const completed = records.findLast(
        (record) => record.data?.setup?.requestKey === "runtime-1" && !record.data.setup.checking,
      ).data;
      assert.equal(
        completed.setup.results.find((result) => result.id === "feishu.credentials").status,
        "failed",
      );
      assert.deepEqual(completed.ports, { api: 58978, admin: 58979, bridge: 58980, caddy: 58981 });
      assert.equal(completed.setupContext.caddyPort, 58981);
      assert.equal(completed.restartRequired, false);
      assert.equal(completed.services.length, 0);
      assert.doesNotMatch(JSON.stringify(records), /unsaved-secret|unsaved-toml/);
      const credentials = JSON.parse(
        await readFile(join(directory, "state/secrets/feishu-credentials.json"), "utf8"),
      );
      assert.deepEqual(credentials, { appId: "", appSecret: "" });
      child.stdin.write(
        JSON.stringify({
          id: "open",
          action: "setup_open",
          settings: { target: "untrusted-target" },
        }) + "\n",
      );
      await waitFor((record) => record.id === "open" && record.ok);
      assert.match(records.findLast((record) => record.data).data.setup.error, /不支持/);
      child.stdin.end();
      assert.deepEqual(await exit, [0, null]);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await exit;
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
