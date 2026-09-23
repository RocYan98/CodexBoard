import test from "node:test";
import assert from "node:assert/strict";
import { createSetupController, detectCodexPath, openSetupTarget } from "./setup-controller.mjs";

const configuration = () => ({
  appId: "cli_example",
  appSecret: "saved-secret",
  frpc: "saved-toml",
  caddyPort: 8443,
  codexPath: "/Applications/Codex.app/Contents/Resources/codex",
  frpcBinary: "/bundle/frpc",
  servicesRunning: true,
  restartRequired: false,
});
const result = (section = "feishu") => ({
  id: `${section}-test`,
  section,
  title: "检查",
  status: "passed",
  message: "已验证",
});

test("checks drafts without saving or accepting executable/port overrides; snapshot never contains inputs", async () => {
  const saved = configuration();
  let input;
  const controller = createSetupController({
    getConfiguration: () => saved,
    check: async (value, { onResult }) => {
      input = value;
      onResult(result());
      return [result()];
    },
  });
  await controller.check({
    section: "feishu",
    requestKey: "1",
    appId: "",
    appSecret: "draft-secret",
    frpc: "draft-toml",
  });
  assert.equal(input.appId, "");
  assert.equal(input.appSecret, "draft-secret");
  assert.equal(input.restartRequired, true);
  assert.equal(saved.appSecret, "saved-secret");
  assert.equal(controller.state.requestKey, "1");
  assert.equal(controller.state.results.length, 1);
  assert.equal(controller.state.stale, false);
  assert.match(controller.state.notice, /当前填写/);
  assert.doesNotMatch(JSON.stringify(controller.state), /draft-secret|saved-secret|draft-toml/);
  await controller.check({
    section: "codex",
    requestKey: "invalid-2",
    codexPath: "/tmp/untrusted",
    caddyPort: 1,
  });
  assert.match(controller.state.error, /检查参数/);
  assert.equal(controller.state.requestKey, "invalid-2");
});

test("configuration changes during a check make results stale and a new check replaces old-input results", async () => {
  const saved = configuration();
  let finish;
  const controller = createSetupController({
    getConfiguration: () => saved,
    check: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const checking = controller.check({ section: "all", requestKey: "2" });
  assert.equal(controller.state.checking, true);
  saved.caddyPort = 9443;
  finish([result()]);
  await checking;
  assert.equal(controller.state.stale, true);
  const next = controller.check({ section: "codex", requestKey: "3" });
  finish([result("codex")]);
  await next;
  assert.equal(controller.state.stale, false);
  assert.deepEqual(
    controller.state.results.map((item) => item.section),
    ["codex"],
  );
});

test("failed checks always clear busy state and suppress raw error content", async () => {
  const controller = createSetupController({
    getConfiguration: configuration,
    check: async () => {
      throw new Error("private-token");
    },
  });
  await controller.check({ section: "all" });
  assert.equal(controller.state.checking, false);
  assert.match(controller.state.error, /检查未完成/);
  assert.doesNotMatch(JSON.stringify(controller.state), /private-token/);
});

test("opening setup targets uses a fixed allowlist and opens only installed Codex apps", async () => {
  const calls = [];
  const deps = {
    platform: "darwin",
    execute: async (...args) => calls.push(args),
    exists: (path) => path === "/Applications/ChatGPT.app",
  };
  await openSetupTarget("feishu-console", deps);
  assert.deepEqual(calls[0][1], ["https://open.feishu.cn/app"]);
  await openSetupTarget("codex-app", deps);
  assert.deepEqual(calls[1][1], ["-a", "/Applications/ChatGPT.app"]);
  await assert.rejects(openSetupTarget("https://evil.example", deps), /不支持/);
  await assert.rejects(openSetupTarget("codex-app", { ...deps, exists: () => false }), /安装/);
  assert.equal(calls.length, 2);
});

test("Codex detection can discover a new installation without restarting the desktop app", () => {
  const installed = new Set();
  assert.equal(
    detectCodexPath((path) => installed.has(path), { platform: "darwin" }),
    "/Applications/Codex.app/Contents/Resources/codex",
  );
  installed.add("/Applications/ChatGPT.app/Contents/Resources/codex");
  assert.equal(
    detectCodexPath((path) => installed.has(path), { platform: "darwin" }),
    "/Applications/ChatGPT.app/Contents/Resources/codex",
  );
});

test("Windows setup uses the registered app CLI and activation identity", async () => {
  const app = {
    cliPath: "C:\\Program Files\\WindowsApps\\Codex\\app\\resources\\codex.exe",
    appUserModelId: "OpenAI.Codex_2p2nqsd0c76g0!App",
  };
  const calls = [];
  const deps = {
    platform: "win32",
    findWindowsPackage: () => app,
    execute: async (...args) => calls.push(args),
  };
  assert.equal(
    detectCodexPath(() => true, deps),
    app.cliPath,
  );
  await openSetupTarget("codex-app", deps);
  assert.equal(calls[0][0], "explorer.exe");
  assert.deepEqual(calls[0][1], [`shell:AppsFolder\\${app.appUserModelId}`]);
  await openSetupTarget("codex-download", deps);
  assert.equal(calls[1][0], "powershell.exe");
  assert.match(calls[1][1].at(-1), /https:\/\/developers\.openai\.com\/codex\/app\//);
  await assert.rejects(
    openSetupTarget("codex-app", { ...deps, findWindowsPackage: () => undefined }),
    /安装/,
  );
});

test("guide addresses follow the checked draft and an invalid draft clears older addresses", async () => {
  const controller = createSetupController({
    getConfiguration: configuration,
    check: async () => [],
  });
  const frpc = `serverAddr = "node.example.com"
[[proxies]]
name = "board"
type = "https"
localIP = "127.0.0.1"
localPort = 8443
customDomains = ["draft.example.com"]
`;
  await controller.check({ section: "codex", frpc });
  assert.deepEqual(controller.state.context, {
    dnsTarget: "node.example.com",
    dnsRecordType: "CNAME",
    origin: "https://draft.example.com",
    domain: "draft.example.com",
    protocol: "https:",
    publicPort: "",
    caddyPort: 8443,
  });
  await controller.check({ section: "codex", frpc: "" });
  assert.deepEqual(controller.state.context, {
    origin: "",
    domain: "",
    protocol: "",
    publicPort: "",
    caddyPort: 8443,
  });
});

test("guide context preserves the TCP public origin remote port and protocol", async () => {
  const controller = createSetupController({
    getConfiguration: configuration,
    check: async () => [],
  });
  const frpc = `serverAddr = "8.8.8.8"
[[proxies]]
name = "board"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8443
remotePort = 18080
`;
  await controller.check({ section: "dns", frpc });
  assert.deepEqual(controller.state.context, {
    dnsTarget: "8.8.8.8",
    dnsRecordType: "A",
    origin: "http://8.8.8.8:18080",
    domain: "8.8.8.8",
    protocol: "http:",
    publicPort: "18080",
    caddyPort: 8443,
  });
});

test("switching guide content does not mark saved connections as unapplied", async () => {
  let checked;
  const controller = createSetupController({
    getConfiguration: () => ({ ...configuration(), accessMode: "feishu" }),
    check: async (input) => {
      checked = input;
      return [];
    },
  });
  await controller.check({ section: "all", accessMode: "web" });
  assert.equal(checked.restartRequired, false);
  assert.equal(controller.state.notice, "");
});
