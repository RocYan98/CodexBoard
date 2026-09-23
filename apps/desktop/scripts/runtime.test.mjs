import test from "node:test";
import assert from "node:assert/strict";
import { parseEnv, nativeEnvironment, assertPortsFree, stopChildren } from "./runtime.mjs";
import net from "node:net";
import { EventEmitter } from "node:events";
import { join, resolve } from "node:path";
import {
  runtimeBinary,
  runtimeEnvironment,
  runtimeLogMessage,
  runtimeExitMessage,
} from "./runtime.mjs";

test("backend startup errors expose known diagnostic codes without stderr messages or secrets", () => {
  const line = JSON.stringify({
    level: "error",
    code: "INTERNAL_ERROR",
    errorName: "SqliteError",
    systemErrorCode: "SQLITE_CANTOPEN",
    message: "token=must-not-leak",
    stack: "private file contents",
    env: { APP_SECRET: "must-not-leak" },
  });
  assert.equal(
    runtimeLogMessage(line, true),
    "服务启动失败 [INTERNAL_ERROR; SqliteError; SQLITE_CANTOPEN]",
  );
  assert.equal(runtimeLogMessage(line), null);
  assert.equal(
    runtimeLogMessage(
      JSON.stringify({ level: "error", code: "CONFIG_INVALID", errorName: "ConfigError" }),
      true,
    ),
    "服务配置无效 [CONFIG_INVALID; ConfigError]",
  );
  assert.equal(
    runtimeLogMessage(
      JSON.stringify({ level: "error", code: "INTERNAL_ERROR", systemErrorCode: "ENOENT" }),
      true,
    ),
    "服务启动失败 [INTERNAL_ERROR; ENOENT]",
  );
});

test("runtime logs reject unknown startup fields and preserve existing structured message filtering", () => {
  for (const line of [
    "token=must-not-leak",
    "null",
    JSON.stringify({ message: "token=must-not-leak" }),
    JSON.stringify({ level: "error", code: "SECRET_VALUE", message: "must-not-leak" }),
    JSON.stringify({ level: "info", code: "CONFIG_INVALID", message: "must-not-leak" }),
  ])
    assert.equal(runtimeLogMessage(line, true), null);
  assert.equal(
    runtimeLogMessage(
      JSON.stringify({
        level: "error",
        code: "INTERNAL_ERROR",
        errorName: "SECRET_VALUE",
        systemErrorCode: "SECRET_VALUE",
        message: "must-not-leak",
        msg: "must-not-leak",
      }),
      true,
    ),
    "服务启动失败 [INTERNAL_ERROR]",
  );
  assert.equal(
    runtimeLogMessage('{"msg":"Public and local admin listeners are ready"}'),
    "Public and local admin listeners are ready",
  );
  for (const msg of ["incoming request", "request completed", "handled request"])
    assert.equal(runtimeLogMessage(JSON.stringify({ msg })), null);
});

test("owned process exit diagnostics accept only integer exit codes and known signals", () => {
  assert.equal(runtimeExitMessage(1, null), "服务意外退出（退出码 1），正在停止其余服务");
  assert.equal(
    runtimeExitMessage(3221225786, null),
    "服务意外退出（退出码 3221225786），正在停止其余服务",
  );
  assert.equal(
    runtimeExitMessage(null, "SIGTERM"),
    "服务意外退出（信号 SIGTERM），正在停止其余服务",
  );
  assert.equal(
    runtimeExitMessage("token=secret", "SECRET_VALUE"),
    "服务意外退出，正在停止其余服务",
  );
});

test("backend Node loader diagnostics keep only recognized codes and never raw paths or messages", () => {
  for (const [line, code] of [
    ["Error [ERR_MODULE_NOT_FOUND]: Cannot find token=must-not-leak", "ERR_MODULE_NOT_FOUND"],
    ["  code: 'MODULE_NOT_FOUND',", "MODULE_NOT_FOUND"],
    ["  code: 'ERR_DLOPEN_FAILED'", "ERR_DLOPEN_FAILED"],
    ["TypeError [ERR_UNKNOWN_FILE_EXTENSION]: secret path", "ERR_UNKNOWN_FILE_EXTENSION"],
    ["Error: EISDIR: illegal operation on private path", "EISDIR"],
  ]) {
    assert.equal(runtimeLogMessage(line, true), `Node 加载失败 [${code}]`);
    assert.equal(runtimeLogMessage(line), null);
  }
  for (const line of [
    "Error [TOKEN_SECRET]: must-not-leak",
    "  code: 'SECRET_VALUE',",
    "  code: 'MODULE_NOT_FOUND', token=must-not-leak",
    "A user said Error [ERR_MODULE_NOT_FOUND]: must-not-leak",
    "    at C:\\private\\must-not-leak.mjs:1:1",
  ])
    assert.equal(runtimeLogMessage(line, true), null);
});

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

test("Windows taskkill failure falls back to the owned child and a missing close is bounded", async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    exitCode: null,
    signalCode: null,
    connected: false,
  });
  const commands = [];
  const spawnKiller = (program, args) => {
    commands.push([program, args]);
    const killer = new EventEmitter();
    queueMicrotask(() => killer.emit("exit", 1));
    return killer;
  };
  child.kill = (signal) => {
    assert.equal(signal, "SIGKILL");
    child.signalCode = signal;
    child.emit("close");
  };
  await stopChildren([child], 10, { platform: "win32", spawnKiller, killWaitMs: 30 });
  assert.deepEqual(commands, [["taskkill.exe", ["/PID", "42", "/T", "/F"]]]);
  const stuck = Object.assign(new EventEmitter(), {
    pid: 43,
    exitCode: null,
    signalCode: null,
    connected: false,
    kill: () => false,
  });
  await assert.rejects(
    stopChildren([stuck], 10, { platform: "win32", spawnKiller, killWaitMs: 30 }),
    /限定时间/,
  );
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
