import test from "node:test";
import assert from "node:assert/strict";
import { parseEnv, nativeEnvironment, assertPortsFree, stopChildren } from "./runtime.mjs";
import net from "node:net";
import { join, resolve } from "node:path";
import { runtimeBinary, runtimeEnvironment } from "./runtime.mjs";
test("configured ports reach the backend, admin listener and embedded bridge", () => {
  const result = nativeEnvironment(
    {},
    { CODEXBOARD_DATA_DIR: resolve("/data") },
    resolve("/bundle"),
    {
      api: 48023,
      admin: 48024,
      bridge: 48025,
      caddy: 9443,
    },
  );
  assert.equal(result.CODEXBOARD_PORT, "48023");
  assert.equal(result.CODEXBOARD_ADMIN_PORT, "48024");
  assert.equal(result.CODEXBOARD_CODEX_ENDPOINT, "ws://127.0.0.1:48025");
});
test("dotenv parser preserves quoted spaces, never evaluates shell code", () => {
  assert.deepEqual(parseEnv('A="a b"\nB=$(echo secret)\n# hi\nC=plain'), {
    A: "a b",
    B: "$(echo secret)",
    C: "plain",
  });
});
test("native config replaces container paths without leaking inherited secrets", () => {
  const result = nativeEnvironment(
    {
      CODEXBOARD_ENV: "production",
      CODEXBOARD_CODEX_PROJECT_SNAPSHOT_FILE: "/var/lib/codexboard/run/codex-projects.json",
    },
    {
      CODEXBOARD_DATA_DIR: resolve("/Users/example/data"),
      CODEXBOARD_FEISHU_CREDENTIALS_FILE: "/secrets/feishu",
      CODEXBOARD_CODEX_TOKEN_FILE: "/secrets/codex",
    },
    resolve("/app/runtime"),
  );
  assert.equal(result.CODEXBOARD_CODEX_TRANSPORT, "embedded");
  assert.ok(
    result.CODEXBOARD_CODEX_PROJECT_STATE_FILE.endsWith(join(".codex", ".codex-global-state.json")),
  );
  assert.equal(result.CODEXBOARD_CODEX_ENDPOINT, "ws://127.0.0.1:58980");
  assert.equal(
    result.CODEXBOARD_CODEX_PROJECT_SNAPSHOT_FILE,
    resolve("/Users/example/data/run/codex-projects.json"),
  );
  assert.equal(result.CODEXBOARD_WEB_ROOT, resolve("/app/runtime/apps/web/dist"));
  assert.equal(result.CODEXBOARD_FEISHU_CREDENTIALS_FILE, "/secrets/feishu");
});
test("occupied ports are rejected without stopping their owner", async () => {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(assertPortsFree([s.address().port]), /占用/);
    assert.equal(s.listening, true);
  } finally {
    await new Promise((r) => s.close(r));
  }
});

import { spawn } from "node:child_process";
test("native task execution uses bundled CLI instead of Docker", () => {
  const env = nativeEnvironment(
    { CODEXBOARD_EXECUTOR_TASKCTL_PATH: "/old/taskctl-docker.mjs" },
    { CODEXBOARD_DATA_DIR: resolve("/data"), CODEXBOARD_WORKSPACE_ROOT: "/project" },
    resolve("/bundle"),
  );
  assert.equal(
    env.CODEXBOARD_EXECUTOR_TASKCTL_PATH,
    resolve("/bundle/packages/taskctl/dist/cli.js"),
  );
  assert.equal(env.CODEXBOARD_EXECUTOR_NODE_PATH, runtimeBinary(resolve("/bundle"), "node"));
  assert.equal(env.CODEXBOARD_WORKSPACE_ROOTS, "/project");
});
test("stopping services waits for owned children and leaves unrelated processes alone", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore",
  });
  const other = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore",
  });
  try {
    await stopChildren([child], 200);
    assert.ok(child.signalCode || child.exitCode !== null);
    assert.equal(other.exitCode, null);
    assert.equal(other.signalCode, null);
  } finally {
    await stopChildren([other], 200);
  }
});

test(
  "POSIX shutdown allows cleanup and force-stops a child that ignores SIGTERM",
  { skip: process.platform === "win32" },
  async () => {
    const launch = async (script) => {
      const child = spawn(process.execPath, ["-e", script], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      await new Promise((resolve, reject) => {
        child.stdout.once("data", resolve);
        child.once("error", reject);
      });
      return child;
    };
    const graceful = await launch(
      "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),80));setInterval(()=>{},1000);console.log('ready')",
    );
    await stopChildren([graceful], 1500);
    assert.equal(graceful.exitCode, 0);
    const stubborn = await launch(
      "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);console.log('ready')",
    );
    await stopChildren([stubborn], 100);
    assert.equal(stubborn.signalCode, "SIGKILL");
  },
);

import http from "node:http";
import { checkLocalApi } from "./runtime.mjs";
test("local health check sends the configured Host header", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(req.headers.host === "tasks.example.test" ? 200 : 400);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    assert.equal(await checkLocalApi(server.address().port, "tasks.example.test"), true);
    assert.equal(await checkLocalApi(server.address().port, "wrong.test"), false);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

import { openFeishuBoard } from "./runtime.mjs";
test("opens the configured app in Feishu without a browser URL override", async () => {
  let opened;
  await openFeishuBoard(
    { phase: "ready", appId: "cli_test123", origin: "https://tasks.example.test" },
    {
      checkPublic: async () => true,
      openNative: async (...args) => {
        opened = args;
      },
    },
  );
  assert.deepEqual(opened, [
    "com.electron.lark",
    "https://applink.feishu.cn/client/web_app/open?appId=cli_test123",
  ]);
});
test("incomplete deployment never launches an application", async () => {
  for (const input of [
    { phase: "stopped", appId: "cli_test123", origin: "https://tasks.example.test" },
    { phase: "ready", appId: "", origin: "https://tasks.example.test" },
    { phase: "ready", appId: "cli_test123", origin: "ftp://tasks.example.test" },
  ]) {
    await assert.rejects(
      openFeishuBoard(input, {
        checkPublic: async () => {
          throw new Error("must not check");
        },
        openNative: async () => {
          throw new Error("must not launch");
        },
      }),
      /未部署完成/,
    );
  }
});
test("unreachable deployment never launches Feishu", async () => {
  await assert.rejects(
    openFeishuBoard(
      { phase: "ready", appId: "cli_test123", origin: "https://tasks.example.test" },
      {
        checkPublic: async () => false,
        openNative: async () => {
          throw new Error("must not launch");
        },
      },
    ),
    /未部署完成/,
  );
});
test("missing Feishu client reports an actionable error without browser fallback", async () => {
  await assert.rejects(
    openFeishuBoard(
      { phase: "ready", appId: "cli_test123", origin: "https://tasks.example.test" },
      {
        checkPublic: async () => true,
        openNative: async () => {
          throw new Error("native failure");
        },
      },
    ),
    /无法打开飞书/,
  );
});

test("health checks use fresh connections across backend restarts", async () => {
  let connections = 0;
  const server = http.createServer((_req, res) => res.end("ok"));
  server.on("connection", () => connections++);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await checkLocalApi(server.address().port, "tasks.example.test");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await checkLocalApi(server.address().port, "tasks.example.test");
    assert.equal(connections, 2);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("desktop owns internal settings even when legacy values are present", () => {
  const env = nativeEnvironment(
    {
      CODEXBOARD_ENV: "development",
      CODEXBOARD_AUTH_MODE: "development",
      CODEXBOARD_ORIGIN: "https://tasks.example.test",
      CODEXBOARD_ALLOWED_HOSTS: "stale.example.test",
      CODEXBOARD_HOST: "0.0.0.0",
      CODEXBOARD_PORT: "9000",
      CODEXBOARD_ADMIN_PORT: "9001",
      CODEXBOARD_CODEX_PROJECT_SNAPSHOT_FILE: "/legacy/snapshot.json",
      CODEXBOARD_TEMPORARY_PROJECT_ROOT: "/old/user/location",
    },
    { CODEXBOARD_DATA_DIR: resolve("/data") },
    resolve("/bundle"),
  );
  assert.equal(env.CODEXBOARD_ENV, "production");
  assert.equal(env.CODEXBOARD_AUTH_MODE, "feishu");
  assert.equal(env.CODEXBOARD_HOST, "127.0.0.1");
  assert.equal(env.CODEXBOARD_PORT, "58978");
  assert.equal(env.CODEXBOARD_ADMIN_PORT, "58979");
  assert.equal(env.CODEXBOARD_ALLOWED_HOSTS, "tasks.example.test");
  assert.equal(
    env.CODEXBOARD_CODEX_PROJECT_SNAPSHOT_FILE,
    resolve("/data/run/codex-projects.json"),
  );
  assert.equal(env.CODEXBOARD_TEMPORARY_PROJECT_ROOT, undefined);
});

test("HTTP proxy preserves public port and does not enable TLS", async () => {
  const { renderCaddyfile } = await import("./runtime.mjs");
  const content = renderCaddyfile(new URL("http://8.8.8.8:52480"), {
    api: 48823,
    caddy: 58981,
  });
  assert.match(content, /auto_https off/);
  assert.match(content, /http:\/\/8\.8\.8\.8:58981/);
  assert.match(content, /header_up Host 8\.8\.8\.8:52480/);
  assert.match(content, /header_up X-Forwarded-Proto http/);
  assert.doesNotMatch(content, /issuer acme/);
  const secure = renderCaddyfile(new URL("https://tasks.example.com"), {
    api: 48823,
    caddy: 58443,
  });
  assert.match(secure, /issuer acme/);
  assert.match(secure, /header_up X-Forwarded-Proto https/);
  assert.throws(() => renderCaddyfile(new URL("http://127.0.0.1:5000"), { api: 1, caddy: 2 }));
});

test("HTTP deployment opens the Feishu app after checking its public origin", async () => {
  let checked;
  let opened;
  await openFeishuBoard(
    { phase: "ready", appId: "cli_test123", origin: "http://8.8.8.8:52480" },
    {
      checkPublic: async (origin) => {
        checked = origin;
        return true;
      },
      openNative: async (...args) => {
        opened = args;
      },
    },
  );
  assert.equal(checked, "http://8.8.8.8:52480");
  assert.deepEqual(opened, [
    "com.electron.lark",
    "https://applink.feishu.cn/client/web_app/open?appId=cli_test123",
  ]);
});

test("Web native runtime does not require or forward a Feishu credentials file", () => {
  const env = nativeEnvironment(
    { CODEXBOARD_ORIGIN: "https://web.example.com", CODEXBOARD_AUTH_MODE: "web" },
    {
      CODEXBOARD_DATA_DIR: resolve("/data"),
      CODEXBOARD_FEISHU_CREDENTIALS_FILE: "/secrets/feishu.json",
    },
    resolve("/runtime"),
  );
  assert.equal(env.CODEXBOARD_AUTH_MODE, "web");
  assert.equal(env.CODEXBOARD_FEISHU_CREDENTIALS_FILE, undefined);
  assert.equal(env.CODEXBOARD_ENV, "production");
});

test("Windows runtime keeps executable suffixes, path delimiters and necessary OS variables", () => {
  assert.equal(
    runtimeBinary("C:\\Program Files\\CodexBoard\\runtime", "node", "win32"),
    "C:\\Program Files\\CodexBoard\\runtime\\bin\\node.exe",
  );
  const env = runtimeEnvironment(
    "C:\\runtime",
    {
      Path: "C:\\Git\\cmd;C:\\Windows\\System32",
      SYSTEMROOT: "C:\\Windows",
      USERPROFILE: "C:\\Users\\test",
      TEMP: "C:\\Temp",
      PRIVATE_SECRET: "do not forward",
    },
    "win32",
  );
  assert.equal(env.PATH, "C:\\runtime\\bin;C:\\Git\\cmd;C:\\Windows\\System32");
  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.equal(env.USERPROFILE, "C:\\Users\\test");
  assert.equal(env.PRIVATE_SECRET, undefined);
});

test(
  "Windows shutdown drains IPC children and kills an unresponsive owned child",
  { skip: process.platform !== "win32" },
  async () => {
    const launch = async (script) => {
      const child = spawn(process.execPath, ["-e", script], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore", "ipc"],
      });
      await new Promise((resolve, reject) => {
        child.stdout.once("data", resolve);
        child.once("error", reject);
      });
      return child;
    };
    const graceful = await launch(
      "process.on('message',m=>{if(m.type==='codexboard.shutdown')setTimeout(()=>process.exit(0),50)});setInterval(()=>{},1000);console.log('ready')",
    );
    await stopChildren([graceful], 1500);
    assert.equal(graceful.exitCode, 0);
    const stubborn = await launch("setInterval(()=>{},1000);console.log('ready')");
    await stopChildren([stubborn], 100);
    assert.ok(stubborn.exitCode !== null || stubborn.signalCode !== null);
  },
);
