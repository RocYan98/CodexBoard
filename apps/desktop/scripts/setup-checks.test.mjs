import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { requestJson, runSetupChecks } from "./setup-checks.mjs";
import { assertPrivateFileSync } from "#private-file-permissions";

const secret = "synthetic-app-secret-never-display";
const token = "synthetic-frpc-token-never-display";
const frpc = `serverAddr = "relay.example.test"
serverPort = 7123
auth.token = "${token}"
[[proxies]]
name = "taskboard"
type = "https"
localIP = "127.0.0.1"
localPort = 8443
customDomains = ["tasks.example.test"]
`;
const tcpFrpc = `serverAddr = "8.8.8.8"
serverPort = 7123
auth.token = "${token}"
[[proxies]]
name = "taskboard-http"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8443
remotePort = 18080
`;
const input = {
  section: "all",
  appId: "cli_example",
  appSecret: secret,
  frpc,
  caddyPort: 8443,
  codexPath: "/fixture/codex",
  frpcBinary: "/fixture/frpc",
  servicesRunning: true,
  restartRequired: false,
};
const health = {
  status: "ok",
  service: "codexboard-server",
  version: "0.1.0",
  timestamp: "2026-09-12T12:00:00.000Z",
  checks: { http: "ok", sqlite: "ok" },
};
function deps(overrides = {}) {
  return {
    timeoutMs: 1000,
    publicTimeoutMs: 1000,
    requestJson: async (url) => ({
      status: 200,
      body: url.includes("open.feishu.cn")
        ? { code: 0, app_access_token: "discarded-app-token", expire: 7200 }
        : health,
    }),
    execFile: async (file) => ({
      stdout: file.endsWith("codex") ? "Logged in using ChatGPT\n" : "valid",
      stderr: "",
    }),
    lookup: async () => [{ address: "203.0.113.1", family: 4 }],
    connectTcp: async () => {},
    resolve4: async () => ["203.0.113.20"],
    resolve6: async () => ["2001:db8::20"],
    resolveCname: async () => ["gateway.example.test"],
    ...overrides,
  };
}
function one(results, id) {
  const result = results.find((item) => item.id === id);
  assert.ok(result, `Missing result ${id}`);
  return result;
}
function safe(results) {
  const text = JSON.stringify(results);
  for (const value of [secret, token, "discarded-app-token", "private-remote-output"])
    assert.equal(text.includes(value), false);
}

async function localHealthServer(t, respond) {
  const server = createServer(respond);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return { server, url: `http://127.0.0.1:${server.address().port}/api/health` };
}

test("requestJson uses plain HTTP for an HTTP URL", async () => {
  const calls = [];
  const transport = (name) => (url, options, callback) => {
    calls.push({ name, url: url.href, options });
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      callback(response);
      queueMicrotask(() => {
        response.emit("data", Buffer.from('{"transport":"http"}'));
        response.emit("end");
      });
    };
    return request;
  };
  const response = await requestJson(
    "http://8.8.8.8:18080/probe",
    { timeoutMs: 1000 },
    { http: transport("http"), https: transport("https") },
  );
  assert.deepEqual(response, { status: 200, body: { transport: "http" } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "http");
  assert.equal(calls[0].url, "http://8.8.8.8:18080/probe");
  assert.equal("rejectUnauthorized" in calls[0].options, false);
});

test("Feishu validates credentials only at its fixed official endpoint and keeps deployment manual", async () => {
  const calls = [];
  const results = await runSetupChecks(
    { ...input, section: "feishu" },
    deps({
      requestJson: async (url, options) => {
        calls.push({ url, options });
        return { status: 200, body: { code: 0, app_access_token: "discarded-app-token" } };
      },
    }),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    app_id: "cli_example",
    app_secret: secret,
  });
  assert.equal(one(results, "feishu.credentials").status, "passed");
  assert.equal(
    results.some((result) => result.id === "feishu.deployment"),
    false,
  );
  safe(results);
});

test("missing credentials make no request; API failures and malformed successes never pass or leak", async () => {
  let called = false;
  const missing = await runSetupChecks(
    { ...input, section: "feishu", appSecret: "" },
    deps({
      requestJson: async () => {
        called = true;
        throw new Error(secret);
      },
    }),
  );
  assert.equal(called, false);
  assert.equal(one(missing, "feishu.credentials").status, "failed");
  for (const reply of [
    { status: 200, body: { code: 10003, msg: secret } },
    { status: 200, body: { code: 0 } },
    { status: 503, body: { msg: token } },
  ]) {
    const result = await runSetupChecks(
      { ...input, section: "feishu" },
      deps({ requestJson: async () => reply }),
    );
    assert.notEqual(one(result, "feishu.credentials").status, "passed");
    safe(result);
  }
});

test("credential network timeout is bounded and never returns upstream error text", async () => {
  for (const requestJson of [
    async () => {
      throw new Error(secret);
    },
    () => new Promise(() => {}),
  ]) {
    const result = await runSetupChecks(
      { ...input, section: "feishu" },
      deps({ timeoutMs: 10, requestJson }),
    );
    assert.equal(one(result, "feishu.credentials").status, "failed");
    safe(result);
  }
});

test("tunnel verify uses a private temporary file, cleans it, and probes only network reachability", async () => {
  let file;
  const calls = [];
  const results = await runSetupChecks(
    { ...input, section: "tunnel" },
    deps({
      execFile: async (binary, args, options) => {
        assert.equal(binary, "/fixture/frpc");
        assert.deepEqual(args.slice(0, 2), ["verify", "-c"]);
        file = args[2];
        assert.equal(readFileSync(file, "utf8"), frpc);
        assertPrivateFileSync(file);
        if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.ok(options.timeout > 0);
        assert.ok(options.maxBuffer > 0);
        return { stdout: `${secret} ${token}`, stderr: "" };
      },
      connectTcp: async (...args) => {
        calls.push(args);
      },
    }),
  );
  assert.equal(existsSync(file), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 7123);
  assert.equal(one(results, "tunnel.verify").status, "passed");
  assert.equal(one(results, "tunnel.server").status, "passed");
  assert.match(JSON.stringify(one(results, "tunnel.server")), /不代表.*认证/);
  safe(results);
});

test("failed frpc verification also removes secret-bearing files without echoing CLI output", async () => {
  let file;
  const results = await runSetupChecks(
    { ...input, section: "tunnel" },
    deps({
      execFile: async (_binary, args) => {
        file = args[2];
        throw Object.assign(new Error(token), { stderr: secret, stdout: "private-remote-output" });
      },
    }),
  );
  assert.equal(existsSync(file), false);
  assert.equal(one(results, "tunnel.verify").status, "failed");
  safe(results);
});

test("frpc verify timeout removes its private file and TCP probes accept either address family", async () => {
  let file;
  const attempted = [];
  const result = await runSetupChecks(
    { ...input, section: "tunnel" },
    deps({
      timeoutMs: 10,
      execFile: async (_binary, args) => {
        file = args[2];
        await new Promise(() => {});
      },
      lookup: async () => [
        { address: "2001:db8::1", family: 6 },
        { address: "203.0.113.1", family: 4 },
      ],
      connectTcp: async (host) => {
        attempted.push(host);
        if (host.includes(":")) throw new Error("IPv6 unavailable");
      },
    }),
  );
  assert.equal(existsSync(file), false);
  assert.equal(one(result, "tunnel.verify").status, "failed");
  assert.deepEqual(new Set(attempted), new Set(["2001:db8::1", "203.0.113.1"]));
  assert.equal(one(result, "tunnel.server").status, "passed");
});

test("invalid TOML, local target mismatch and invalid server port stop tunnel probes", async () => {
  for (const invalid of [
    frpc + 'broken="' + token,
    frpc.replace("8443", "9443"),
    frpc.replace("7123", "0"),
  ]) {
    let executed = false;
    const results = await runSetupChecks(
      { ...input, section: "tunnel", frpc: invalid },
      deps({
        execFile: async () => {
          executed = true;
        },
        connectTcp: async () => {
          executed = true;
        },
      }),
    );
    assert.equal(executed, false);
    assert.equal(one(results, "tunnel.configuration").status, "failed");
    assert.equal(
      results.some((result) => result.id === "tunnel.account"),
      false,
    );
    safe(results);
  }
});

test("omitted frpc serverPort defaults to 7000 and DNS/TCP failures stay actionable", async () => {
  let port;
  const result = await runSetupChecks(
    { ...input, section: "tunnel", frpc: frpc.replace("serverPort = 7123\n", "") },
    deps({
      connectTcp: async (_host, value) => {
        port = value;
        throw new Error(token);
      },
    }),
  );
  assert.equal(port, 7000);
  assert.equal(one(result, "tunnel.server").status, "failed");
  safe(result);
  let connected = false;
  const failedDns = await runSetupChecks(
    { ...input, section: "tunnel" },
    deps({
      lookup: async () => {
        throw new Error(secret);
      },
      connectTcp: async () => {
        connected = true;
      },
    }),
  );
  assert.equal(connected, false);
  assert.equal(one(failedDns, "tunnel.server").status, "failed");
});

test("DNS reports A/AAAA/CNAME and accepts an ingress address different from the FRP server", async () => {
  const result = await runSetupChecks(
    { ...input, section: "dns" },
    deps({
      lookup: async () => {
        assert.fail("Valid direct DNS records must not require a system lookup");
      },
    }),
  );
  assert.equal(one(result, "dns.records").status, "passed");
  assert.deepEqual(one(result, "dns.records").details, [
    "A：203.0.113.20",
    "AAAA：2001:db8::20",
    "CNAME：gateway.example.test",
  ]);
  assert.equal(one(result, "dns.https").status, "passed");
});

test("public health has an independent 10-second default and cap while commands keep their budget", async () => {
  for (const [publicTimeoutMs, expected] of [
    [undefined, 10_000],
    [60_000, 10_000],
    [250, 250],
  ]) {
    const results = await runSetupChecks(
      { ...input, section: "dns" },
      deps({
        timeoutMs: 10,
        publicTimeoutMs,
        requestJson: async (_url, options) => {
          assert.equal(options.timeoutMs, expected);
          return { status: 200, body: health };
        },
      }),
    );
    assert.equal(one(results, "dns.https").status, "passed");
  }
  const budgets = [];
  for (const section of ["feishu", "codex"])
    await runSetupChecks(
      { ...input, section },
      deps({
        timeoutMs: undefined,
        publicTimeoutMs: 10_000,
        requestJson: async (_url, options) => {
          budgets.push(options.timeoutMs);
          return { status: 200, body: { code: 0, app_access_token: "discarded-app-token" } };
        },
        execFile: async (_path, _args, options) => {
          budgets.push(options.timeout);
          return { stdout: "Logged in using ChatGPT" };
        },
      }),
    );
  assert.deepEqual(budgets, [3500, 3500]);
});

test("a real public health response can arrive after the general probe budget", async (t) => {
  let timer;
  t.after(() => clearTimeout(timer));
  const endpoint = await localHealthServer(t, (_request, response) => {
    timer = setTimeout(() => response.end(JSON.stringify(health)), 40);
    response.once("close", () => clearTimeout(timer));
  });
  const results = await runSetupChecks(
    { ...input, section: "dns", frpc: tcpFrpc },
    deps({
      timeoutMs: 10,
      publicTimeoutMs: 2000,
      requestJson: (_url, options) => {
        assert.equal(options.timeoutMs, 2000);
        return requestJson(endpoint.url, options);
      },
    }),
  );
  assert.equal(one(results, "dns.https").status, "passed");
});

test(
  "public health deadline aborts and releases a real pending HTTP connection",
  { timeout: 5000 },
  async (t) => {
    const endpoint = await localHealthServer(t, () => {});
    let connected = false;
    const connectionClosed = new Promise((resolve) => {
      endpoint.server.once("connection", (socket) => {
        connected = true;
        socket.once("close", resolve);
      });
    });
    let signal;
    const results = await runSetupChecks(
      { ...input, section: "dns", frpc: tcpFrpc },
      deps({
        timeoutMs: 10,
        publicTimeoutMs: 1000,
        requestJson: (_url, options) => {
          assert.equal(options.timeoutMs, 1000);
          signal = options.signal;
          return requestJson(endpoint.url, options);
        },
      }),
    );
    assert.equal(one(results, "dns.https").status, "failed");
    assert.deepEqual(one(results, "dns.https").details, ["诊断代码：SETUP_TIMEOUT"]);
    assert.equal(signal.aborted, true);
    assert.equal(connected, true, "The pending HTTP probe must establish a real connection");
    await connectionClosed;
  },
);

test("a longer public health deadline does not extend DNS queries", async () => {
  const results = await runSetupChecks(
    { ...input, section: "dns" },
    deps({
      timeoutMs: 10,
      publicTimeoutMs: 250,
      resolve4: () => new Promise((resolve) => setTimeout(() => resolve(["203.0.113.20"]), 40)),
      resolve6: async () => [],
      resolveCname: async () => [],
      lookup: async () => [],
    }),
  );
  assert.equal(one(results, "dns.records").status, "failed");
  assert.equal(one(results, "dns.https").status, "passed");
});

test("direct DNS timeout falls back to bounded system resolution without claiming verified records", async () => {
  const calls = [];
  const result = await runSetupChecks(
    { ...input, section: "dns" },
    deps({
      timeoutMs: 10,
      resolve4: () => new Promise(() => {}),
      resolve6: () => new Promise(() => {}),
      resolveCname: () => new Promise(() => {}),
      lookup: async (...args) => {
        calls.push(args);
        return [
          { address: "203.0.113.20", family: 4 },
          { address: "2001:db8::20", family: 6 },
          { address: "private-remote-output", family: 4 },
          { address: "203.0.113.21", family: 6 },
        ];
      },
      requestJson: async () => {
        throw new Error("private-remote-output");
      },
    }),
  );
  assert.deepEqual(calls, [["tasks.example.test", { all: true }]]);
  assert.equal(one(result, "dns.records").status, "passed");
  assert.match(one(result, "dns.records").message, /系统域名解析可用.*直接 DNS 记录查询不可用/);
  assert.match(one(result, "dns.records").message, /尚未核验公网 DNS 记录/);
  assert.deepEqual(one(result, "dns.records").details, [
    "系统 IPv4：203.0.113.20",
    "系统 IPv6：2001:db8::20",
  ]);
  assert.equal(one(result, "dns.https").status, "failed");
  safe(result);
});

test("CNAME alone and invalid system addresses cannot pass even when HTTPS is healthy", async () => {
  for (const values of [
    [],
    [
      null,
      { address: "private-remote-output", family: 4 },
      { address: "203.0.113.20", family: 6 },
      { address: "2001:db8::20", family: "6" },
    ],
  ]) {
    const result = await runSetupChecks(
      { ...input, section: "dns" },
      deps({
        resolve4: async () => [],
        resolve6: async () => [],
        lookup: async () => values,
      }),
    );
    assert.equal(one(result, "dns.records").status, "failed");
    assert.match(one(result, "dns.records").message, /未得到可用的 IP 地址/);
    assert.deepEqual(one(result, "dns.records").details, ["CNAME：gateway.example.test"]);
    assert.equal(one(result, "dns.https").status, "passed");
    safe(result);
  }
});

test("system lookup errors and timeouts remain distinct from a negative DNS answer", async () => {
  const unavailable = async () => {
    throw Object.assign(new Error("private-remote-output"), { code: "ETIMEOUT" });
  };
  for (const lookup of [unavailable, () => new Promise(() => {})]) {
    const result = await runSetupChecks(
      { ...input, section: "dns" },
      deps({ timeoutMs: 10, resolve4: unavailable, resolve6: unavailable, lookup }),
    );
    assert.equal(one(result, "dns.records").status, "failed");
    assert.match(one(result, "dns.records").message, /均不可用.*无法确认/);
    safe(result);
  }
  const result = await runSetupChecks(
    { ...input, section: "dns" },
    deps({
      resolve4: unavailable,
      resolve6: unavailable,
      lookup: async () => {
        throw Object.assign(new Error("private-remote-output"), { code: "ENOTFOUND" });
      },
    }),
  );
  assert.equal(one(result, "dns.records").status, "failed");
  assert.match(one(result, "dns.records").message, /未得到可用的 IP 地址/);
  safe(result);
});

test("public IPv4 TCP ingress skips DNS and checks the explicit HTTP remote port", async () => {
  const urls = [];
  let dnsCalls = 0;
  const result = await runSetupChecks(
    { ...input, section: "dns", frpc: tcpFrpc },
    deps({
      resolve4: async () => {
        dnsCalls++;
        throw new Error("DNS must not run for an IP literal");
      },
      resolve6: async () => {
        dnsCalls++;
        throw new Error("DNS must not run for an IP literal");
      },
      resolveCname: async () => {
        dnsCalls++;
        throw new Error("DNS must not run for an IP literal");
      },
      requestJson: async (url) => {
        urls.push(url);
        return { status: 200, body: health };
      },
    }),
  );
  assert.equal(dnsCalls, 0);
  assert.deepEqual(urls, ["http://8.8.8.8:18080/api/health"]);
  assert.equal(one(result, "dns.records").status, "passed");
  assert.match(one(result, "dns.records").message, /公网 IP.*无需.*DNS/);
  assert.equal(one(result, "dns.https").title, "公网 HTTP");
  assert.equal(one(result, "dns.https").status, "passed");
  assert.match(one(result, "dns.https").message, /HTTP.*明文.*测试/);
});

test("public IPv4 TCP ingress reports HTTP port 80 when URL normalization omits it", async () => {
  const result = await runSetupChecks(
    { ...input, section: "dns", frpc: tcpFrpc.replace("remotePort = 18080", "remotePort = 80") },
    deps(),
  );
  assert.deepEqual(one(result, "dns.records").details, ["IPv4：8.8.8.8", "公网端口：80"]);
  assert.equal(one(result, "dns.https").title, "公网 HTTP");
});

test("missing DNS and HTTPS network/TLS errors do not pass or leak", async () => {
  const fail = async () => {
    throw new Error("private-remote-output");
  };
  const result = await runSetupChecks(
    { ...input, section: "dns" },
    deps({
      resolve4: fail,
      resolve6: fail,
      resolveCname: fail,
      lookup: fail,
      requestJson: fail,
    }),
  );
  assert.equal(one(result, "dns.records").status, "failed");
  assert.equal(one(result, "dns.https").status, "failed");
  safe(result);
});

test("public probe failures distinguish timeout, connection and certificate codes without native output", async () => {
  for (const [code, message] of [
    ["SETUP_TIMEOUT", /探测超时/],
    ["ETIMEDOUT", /探测超时/],
    ["ABORT_ERR", /探测超时/],
    ["ECONNRESET", /连接失败或已中断/],
    ["ECONNREFUSED", /连接失败或已中断/],
    ["EHOSTUNREACH", /连接失败或已中断/],
    ["ENETUNREACH", /连接失败或已中断/],
    ["ENOTFOUND", /连接失败或已中断/],
    ["EAI_AGAIN", /连接失败或已中断/],
    ["CERT_HAS_EXPIRED", /证书校验失败/],
    ["ERR_TLS_CERT_ALTNAME_INVALID", /证书校验失败/],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", /证书校验失败/],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", /证书校验失败/],
  ]) {
    const results = await runSetupChecks(
      { ...input, section: "dns" },
      deps({
        timeoutMs: 10,
        publicTimeoutMs: 250,
        requestJson: async () => {
          throw Object.assign(new Error(secret), { code, cause: new Error(token) });
        },
      }),
    );
    const failure = one(results, "dns.https");
    assert.equal(failure.status, "failed");
    assert.match(failure.message, message);
    assert.deepEqual(failure.details, [`诊断代码：${code}`]);
    safe(results);
  }
});

test("the actual probe deadline and AbortError name produce only fixed timeout diagnostics", async () => {
  for (const [requestJson, code] of [
    [() => new Promise(() => {}), "SETUP_TIMEOUT"],
    [
      async () => {
        throw Object.assign(new Error(secret), {
          name: "AbortError",
          code: "private-remote-output",
        });
      },
      "ABORT_ERR",
    ],
  ]) {
    const results = await runSetupChecks(
      { ...input, section: "dns" },
      deps({ timeoutMs: 10, publicTimeoutMs: 10, requestJson }),
    );
    assert.match(one(results, "dns.https").message, /探测超时/);
    assert.deepEqual(one(results, "dns.https").details, [`诊断代码：${code}`]);
    safe(results);
  }
});

test("unknown public probe errors never expose raw codes, names, messages or nested diagnostics", async () => {
  const results = await runSetupChecks(
    { ...input, section: "dns" },
    deps({
      requestJson: async () => {
        throw Object.assign(new Error(secret), {
          code: "private-remote-output",
          name: token,
          cause: Object.assign(new Error(token), { code: "ECONNRESET" }),
        });
      },
    }),
  );
  assert.equal(one(results, "dns.https").status, "failed");
  assert.match(one(results, "dns.https").message, /原因尚未确定/);
  assert.deepEqual(one(results, "dns.https").details, ["诊断代码：OTHER"]);
  assert.doesNotMatch(one(results, "dns.https").message, /证书|超时/);
  safe(results);
});

test("Codex execution denial is reported without exposing command output or suggesting ACL changes", async () => {
  for (const code of ["EACCES", "EPERM"]) {
    const result = await runSetupChecks(
      { ...input, section: "codex" },
      deps({
        execFile: async () => {
          throw Object.assign(new Error(secret), {
            code,
            stdout: "Not logged in",
            stderr: "private-remote-output",
          });
        },
      }),
    );
    assert.equal(one(result, "codex.login").status, "failed");
    assert.match(one(result, "codex.login").message, /系统拒绝执行 Codex 命令.*无法检查登录状态/);
    assert.doesNotMatch(one(result, "codex.login").message, /尚未登录|ACL|修改权限/);
    safe(result);
  }
});

test("HTTPS requires the exact healthy project schema instead of any HTTP 200", async () => {
  for (const body of [
    { status: "ok" },
    "<html>OK</html>",
    { ...health, service: "other-service" },
    { ...health, checks: { http: "ok", sqlite: "unavailable" } },
    { ...health, status: "degraded" },
    { ...health, timestamp: "invalid" },
  ]) {
    const result = await runSetupChecks(
      { ...input, section: "dns" },
      deps({
        timeoutMs: 10,
        publicTimeoutMs: 250,
        requestJson: async () => ({ status: 200, body }),
      }),
    );
    assert.equal(one(result, "dns.https").status, "failed");
  }
  const redirect = await runSetupChecks(
    { ...input, section: "dns" },
    deps({ requestJson: async () => ({ status: 302, body: health }) }),
  );
  assert.equal(one(redirect, "dns.https").status, "failed");
});

test("public health does not claim saved settings are active while stopped or awaiting restart", async () => {
  for (const state of [{ servicesRunning: false }, { restartRequired: true }]) {
    const result = await runSetupChecks({ ...input, ...state, section: "dns" }, deps());
    assert.equal(one(result, "dns.https").status, "warning");
  }
});

test("HTTP health warnings still identify the plaintext test transport", async () => {
  const result = await runSetupChecks(
    { ...input, section: "dns", frpc: tcpFrpc, restartRequired: true },
    deps(),
  );
  assert.equal(one(result, "dns.https").status, "warning");
  assert.match(one(result, "dns.https").message, /HTTP.*明文.*待重启/);
});

test("Codex recognizes local login without claiming online token or usage verification", async () => {
  for (const stdout of [
    "Logged in using ChatGPT",
    "Logged in using an API key - sk-private-remote-output",
  ]) {
    const result = await runSetupChecks(
      { ...input, section: "codex" },
      deps({
        execFile: async (file, args, options) => {
          assert.equal(file, input.codexPath);
          assert.deepEqual(args, ["login", "status"]);
          assert.ok(options.timeout > 0 && options.maxBuffer > 0);
          return { stdout, stderr: "" };
        },
      }),
    );
    assert.equal(one(result, "codex.login").status, "passed");
    assert.match(JSON.stringify(result), /未验证.*在线.*额度/);
    safe(result);
  }
});

test("Codex missing executable, logged-out, unknown output and timeout remain distinct", async () => {
  const cases = [
    [
      async () => {
        throw Object.assign(new Error(secret), { code: "ENOENT" });
      },
      "failed",
      /安装|路径/,
    ],
    [
      async () => {
        throw Object.assign(new Error(secret), { code: 1, stderr: "Not logged in" });
      },
      "failed",
      /登录/,
    ],
    [async () => ({ stdout: "private-remote-output", stderr: "" }), "warning", /无法确认/],
    [
      async () => ({ stdout: "Logged in using ChatGPT (unknown future status)", stderr: "" }),
      "warning",
      /无法确认/,
    ],
    [() => new Promise(() => {}), "failed", /超时/],
  ];
  for (const [execFile, status, message] of cases) {
    const result = await runSetupChecks(
      { ...input, section: "codex" },
      deps({ execFile, timeoutMs: 10 }),
    );
    assert.equal(one(result, "codex.login").status, status);
    assert.match(one(result, "codex.login").message, message);
    safe(result);
  }
});

test("all runs independent sections concurrently and reports each result as it completes", async () => {
  const callbacks = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const running = runSetupChecks(
    input,
    deps({
      timeoutMs: 1000,
      onResult: (item) => callbacks.push(item),
      requestJson: async (url) => {
        if (url.includes("open.feishu.cn")) {
          await gate;
          return { status: 200, body: { code: 0, app_access_token: "discarded-app-token" } };
        }
        return { status: 200, body: health };
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    callbacks.some((item) => item.section === "codex"),
    true,
  );
  release();
  const results = await running;
  assert.equal(callbacks.length, results.length);
  assert.deepEqual(
    new Set(results.map((item) => item.section)),
    new Set(["feishu", "tunnel", "dns", "codex"]),
  );
  safe(results);
});

test("Web all-checks skip Feishu and report HTTPS/account steps", async () => {
  const results = await runSetupChecks(
    { ...input, accessMode: "web", section: "all" },
    {
      ...deps(),
    },
  );
  assert.equal(
    results.some((r) => r.section === "feishu"),
    false,
  );
  assert.equal(
    results.some((r) => r.id === "web.account" && r.status === "failed"),
    true,
  );
});

for (const [label, accounts, expected] of [
  ["enabled", [{ active: 1 }], "passed"],
  ["disabled", [{ active: 0 }], "failed"],
  ["empty", [], "failed"],
]) {
  test(`Web account check reads fresh local ${label} state`, async () => {
    let calls = 0;
    const results = await runSetupChecks(
      { ...input, section: "web" },
      deps({
        readWebAccounts: async () => {
          calls++;
          return accounts;
        },
      }),
    );
    assert.equal(calls, 1);
    assert.equal(one(results, "web.account").status, expected);
  });
}
test("Web account check cannot pass when local lookup fails", async () => {
  const results = await runSetupChecks(
    { ...input, section: "web" },
    deps({
      readWebAccounts: async () => {
        throw Error("private details");
      },
    }),
  );
  assert.equal(one(results, "web.account").status, "failed");
  assert.doesNotMatch(JSON.stringify(results), /private details/);
});
