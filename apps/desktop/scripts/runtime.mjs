import { manageWebAccounts } from "./web-accounts.mjs";
import { readFrpcOrigin, isSupportedOrigin, readFrpcDnsTarget } from "./frpc-config.mjs";
import { DEFAULT_PORTS, readLocalPorts, savePorts } from "./ports.mjs";
import { createSetupController, detectCodexPath } from "./setup-controller.mjs";
import {
  ensurePrivateDirectorySync,
  ensurePrivateFileSync,
  assertPrivateFileSync,
} from "#private-file-permissions";
import { createHash, randomUUID } from "node:crypto";
import {
  readFileSync,
  existsSync,
  writeFileSync,
  realpathSync,
  lstatSync,
  statSync,
  renameSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { join, resolve, isAbsolute, dirname, win32 } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import net from "node:net";
import https from "node:https";
import http from "node:http";

export function runtimeBinary(root, name, platform = process.platform) {
  return (platform === "win32" ? win32 : { join }).join(
    root,
    "bin",
    `${name}${platform === "win32" ? ".exe" : ""}`,
  );
}
export function runtimeEnvironment(root, env = process.env, platform = process.platform) {
  if (platform !== "win32")
    return {
      HOME: homedir(),
      TMPDIR: env.TMPDIR || tmpdir(),
      PATH: `${join(root, "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      LANG: "zh_CN.UTF-8",
    };
  const values = {};
  for (const key of [
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "HOME",
  ]) {
    const source = Object.keys(env).find(
      (candidate) => candidate.toLowerCase() === key.toLowerCase(),
    );
    if (source && env[source]) values[key] = env[source];
  }
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === "path");
  values.PATH = `${win32.join(root, "bin")};${key ? env[key] : win32.join(values.SystemRoot || "C:\\Windows", "System32")}`;
  return values;
}
function writePrivateNew(file, contents) {
  writeFileSync(file, "", { flag: "wx", mode: 0o600 });
  try {
    ensurePrivateFileSync(file);
    writeFileSync(file, contents);
  } catch (error) {
    rmSync(file, { force: true });
    throw error;
  }
}

export function renderCaddyfile(url, ports) {
  if (
    !isSupportedOrigin(url) ||
    ![ports.api, ports.caddy].every((port) => Number.isInteger(port) && port >= 1 && port <= 65535)
  ) {
    throw new Error("无效的公网地址或代理端口");
  }
  const plain = url.protocol === "http:";
  const global = plain
    ? "auto_https off"
    : `auto_https disable_redirects\n https_port ${ports.caddy}`;
  const tls = plain ? "" : " tls {\n issuer acme {\n disable_http_challenge\n }\n }\n";
  return `{\n admin off\n ${global}\n}\n${url.protocol}//${url.hostname}:${ports.caddy} {\n bind 127.0.0.1\n${tls} reverse_proxy 127.0.0.1:${ports.api} {\n flush_interval -1\n header_up Host ${url.host}\n header_up X-Forwarded-Proto ${plain ? "http" : "https"}\n }\n}\n`;
}

export function parseEnv(text) {
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) throw new Error("配置文件格式无效");
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    values[m[1]] = v;
  }
  return values;
}
export function nativeEnvironment(prod, desktop, root, ports = DEFAULT_PORTS) {
  const env = Object.fromEntries(
    Object.entries(prod).filter(([key]) => key.startsWith("CODEXBOARD_")),
  );
  const data = desktop.CODEXBOARD_DATA_DIR;
  if (!data || !isAbsolute(data)) throw new Error("请配置有效的数据目录");
  delete env.CODEXBOARD_TEMPORARY_PROJECT_ROOT;
  delete env.CODEXBOARD_FEISHU_APP_ID;
  delete env.CODEXBOARD_FEISHU_APP_SECRET;
  delete env.CODEXBOARD_FEISHU_APP_SECRET_FILE;
  return {
    ...env,
    CODEXBOARD_ENV: "production",
    CODEXBOARD_AUTH_MODE: prod.CODEXBOARD_AUTH_MODE === "web" ? "web" : "feishu",
    CODEXBOARD_HOST: "127.0.0.1",
    CODEXBOARD_PORT: String(ports.api),
    CODEXBOARD_ADMIN_HOST: "127.0.0.1",
    CODEXBOARD_ADMIN_PORT: String(ports.admin),
    CODEXBOARD_ALLOWED_HOSTS: env.CODEXBOARD_ORIGIN ? new URL(env.CODEXBOARD_ORIGIN).host : "",
    CODEXBOARD_CODEX_PROJECT_SNAPSHOT_FILE: join(data, "run/codex-projects.json"),
    CODEXBOARD_DATA_DIR: data,
    CODEXBOARD_WEB_ROOT: join(root, "apps/web/dist"),
    CODEXBOARD_FEISHU_CREDENTIALS_FILE:
      prod.CODEXBOARD_AUTH_MODE === "web" ? undefined : desktop.CODEXBOARD_FEISHU_CREDENTIALS_FILE,
    CODEXBOARD_CODEX_TOKEN_FILE: desktop.CODEXBOARD_CODEX_TOKEN_FILE,
    CODEXBOARD_CODEX_TRANSPORT: "embedded",
    CODEXBOARD_CODEX_ENDPOINT: `ws://127.0.0.1:${ports.bridge}`,
    CODEXBOARD_CODEX_PROJECT_STATE_FILE: join(homedir(), ".codex/.codex-global-state.json"),
    CODEXBOARD_WORKSPACE_ROOTS:
      desktop.CODEXBOARD_WORKSPACE_ROOTS || desktop.CODEXBOARD_WORKSPACE_ROOT,
    CODEXBOARD_EXECUTOR_NODE_PATH: runtimeBinary(root, "node"),
    CODEXBOARD_EXECUTOR_TASKCTL_PATH: join(root, "packages/taskctl/dist/cli.js"),
    CODEXBOARD_EXECUTOR_DATA_DIR: data,
  };
}
export async function assertPortsFree(ports) {
  for (const port of ports)
    await new Promise((ok, no) => {
      const server = net.createServer();
      server.once("error", () => no(new Error(`端口 ${port} 已被占用，请先停止占用端口的服务`)));
      server.listen(port, "127.0.0.1", () => server.close(ok));
    });
}
export async function stopChildren(children, graceMs = 12000) {
  const signal = (child, sig) => {
    if (child.exitCode !== null || child.signalCode) return;
    if (process.platform === "win32") {
      if (sig === "SIGTERM" && child.connected) {
        child.send({ type: "codexboard.shutdown" }, () => {});
      } else {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.on("error", () => child.kill());
      }
      return;
    }
    try {
      process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* Already exited. */
      }
    }
  };
  await Promise.all(
    children.map(
      (child) =>
        new Promise((done) => {
          if (child.exitCode !== null || child.signalCode) return done();
          const timer = setTimeout(() => signal(child, "SIGKILL"), graceMs);
          child.once("close", () => {
            clearTimeout(timer);
            done();
          });
          signal(child, "SIGTERM");
        }),
    ),
  );
}

export function checkLocalApi(port, host) {
  return new Promise((done) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path: "/api/health", headers: { host }, agent: false },
      (res) => {
        res.resume();
        done(res.statusCode === 200);
      },
    );
    req.setTimeout(1000, () => req.destroy());
    req.on("error", () => done(false));
  });
}

function checkPublicBoard(origin) {
  return new Promise((resolve) => {
    const request = (new URL(origin).protocol === "http:" ? http : https).get(
      new URL("/api/health", origin),
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    request.setTimeout(8000, () => request.destroy());
    request.on("error", () => resolve(false));
  });
}
function openNativeApp(bundle, url) {
  return new Promise((resolve, reject) => {
    const windows = process.platform === "win32";
    const child = spawn(
      windows ? "rundll32.exe" : "/usr/bin/open",
      windows ? ["url.dll,FileProtocolHandler", url] : bundle ? ["-b", bundle, url] : [url],
      { stdio: "ignore", windowsHide: true },
    );
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error("open failed"))));
  });
}
export async function openFeishuBoard(input, dependencies = {}) {
  let origin;
  try {
    origin = new URL(input.origin);
  } catch {
    /* Incomplete configuration. */
  }
  if (
    input.phase !== "ready" ||
    !/^cli_[a-zA-Z0-9]+$/.test(input.appId || "") ||
    !origin ||
    !isSupportedOrigin(origin)
  )
    throw new Error("未部署完成：请先完成飞书应用配置并启动服务。");
  const reachable = await (dependencies.checkPublic || checkPublicBoard)(origin.origin);
  if (!reachable) throw new Error("未部署完成：公网入口尚不可用，请检查部署或网络连接。");
  const appLink = new URL("https://applink.feishu.cn/client/web_app/open");
  appLink.searchParams.set("appId", input.appId);
  try {
    await (dependencies.openNative || openNativeApp)("com.electron.lark", appLink.toString());
  } catch {
    throw new Error("无法打开飞书：请确认已安装飞书客户端并完成登录。");
  }
}

export function desktopPaths(
  directory = process.platform === "win32"
    ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData/Local"), "CodexBoard/deploy")
    : join(homedir(), "Library/Application Support/CodexBoard/deploy"),
) {
  const base = dirname(directory);
  return {
    CODEXBOARD_DATA_DIR: join(base, "data"),
    CODEXBOARD_FEISHU_CREDENTIALS_FILE: join(base, "secrets/feishu-credentials.json"),
    CODEXBOARD_CODEX_TOKEN_FILE: join(base, "secrets/codex-app-server-token"),
    CODEXBOARD_FRPC_CONFIG_FILE: join(base, "secrets/frpc.toml"),
    CODEXBOARD_PORTS_FILE: join(directory, "ports.json"),
    CODEXBOARD_CADDY_DATA_DIR: join(base, "caddy/data"),
    CODEXBOARD_CADDY_CONFIG_DIR: join(base, "caddy/config"),
  };
}
export function initializeDeployment(directory, defaults = DEFAULT_PORTS) {
  const paths = desktopPaths(directory);
  for (const dir of [
    directory,
    paths.CODEXBOARD_DATA_DIR,
    dirname(paths.CODEXBOARD_FEISHU_CREDENTIALS_FILE),
    paths.CODEXBOARD_CADDY_DATA_DIR,
    paths.CODEXBOARD_CADDY_CONFIG_DIR,
  ])
    ensurePrivateDirectorySync(dir);
  for (const [file, content] of [
    [paths.CODEXBOARD_FRPC_CONFIG_FILE, ""],
    [paths.CODEXBOARD_CODEX_TOKEN_FILE, randomUUID() + randomUUID() + "\n"],
    [
      paths.CODEXBOARD_PORTS_FILE,
      JSON.stringify(
        existsSync(paths.CODEXBOARD_PORTS_FILE)
          ? readLocalPorts(paths.CODEXBOARD_PORTS_FILE)
          : defaults,
        null,
        2,
      ) + "\n",
    ],
  ]) {
    try {
      writePrivateNew(file, content);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  // Import the old two-file layout once; never replace existing credentials.
  const legacyEnv = join(directory, "production.env");
  const legacySecret = join(dirname(paths.CODEXBOARD_FEISHU_CREDENTIALS_FILE), "feishu-app-secret");
  const legacy = { appId: "", appSecret: "" };
  if (existsSync(legacyEnv)) {
    assertRegularFile(legacyEnv);
    const values = parseEnv(readFileSync(legacyEnv, "utf8"));
    // Compare all published key generations before importing credentials.
    const ids = [
      values.CODEXBOARD_FEISHU_APP_ID,
      values.LARK_CODEX_FEISHU_APP_ID,
      values.LARK_TASKBOARD_FEISHU_APP_ID,
    ].filter((id) => id !== undefined);
    if (new Set(ids).size > 1)
      throw new Error("新旧飞书 App ID 配置不一致，旧文件已保留，请核对迁移内容");
    legacy.appId = ids[0] ?? "";
  }
  if (existsSync(legacySecret)) {
    assertRegularFile(legacySecret);
    legacy.appSecret = readFileSync(legacySecret, "utf8").trim();
  }
  const credentialsFile = paths.CODEXBOARD_FEISHU_CREDENTIALS_FILE;
  if (!existsSync(credentialsFile)) {
    validateCredentials(legacy);
    const temp = join(dirname(credentialsFile), `.codexboard-config-${randomUUID()}.json`);
    try {
      writePrivateNew(temp, JSON.stringify(legacy, null, 2) + "\n");
      renameSync(temp, credentialsFile);
    } finally {
      rmSync(temp, { force: true });
    }
  }
  const current = readCredentials(credentialsFile);
  if (
    (legacy.appId && legacy.appId !== current.appId) ||
    (legacy.appSecret && legacy.appSecret !== current.appSecret)
  )
    throw new Error("新旧飞书凭据不一致，旧文件已保留，请核对迁移内容");
  for (const file of [legacyEnv, legacySecret]) rmSync(file, { force: true });
}
function assertRegularFile(path) {
  if (!path || !isAbsolute(path)) throw new Error("部署文件路径无效");
  if (existsSync(path) && !lstatSync(path).isFile())
    throw new Error("部署配置必须保存到普通文件，不能使用符号链接");
}
function validateCredentials(value) {
  if (
    !value ||
    Object.keys(value).some((key) => !["appId", "appSecret"].includes(key)) ||
    typeof value.appId !== "string" ||
    typeof value.appSecret !== "string" ||
    (value.appId && !/^cli_[A-Za-z0-9]+$/.test(value.appId)) ||
    value.appSecret.length > 4096 ||
    /[\r\n\0]/.test(value.appSecret)
  )
    throw new Error("飞书凭据文件格式无效，请检查 App ID 和 App Secret");
  return { appId: value.appId, appSecret: value.appSecret };
}
function readCredentials(path) {
  assertRegularFile(path);
  try {
    assertPrivateFileSync(path);
  } catch {
    throw new Error("飞书凭据文件必须具有当前用户私有权限（POSIX 0600 / Windows ACL）");
  }
  try {
    return validateCredentials(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new Error("飞书凭据文件格式无效，请检查 App ID 和 App Secret");
  }
}
function deploymentPaths(directory) {
  const desktop = desktopPaths(directory);
  const paths = {
    credentials: desktop.CODEXBOARD_FEISHU_CREDENTIALS_FILE,
    frpc: desktop.CODEXBOARD_FRPC_CONFIG_FILE,
  };
  for (const path of Object.values(paths)) assertRegularFile(path);
  return paths;
}
export function readDeploymentConfiguration(directory) {
  const paths = deploymentPaths(directory);
  let credentials = { appId: "", appSecret: "" },
    credentialsError = "";
  try {
    credentials = readCredentials(paths.credentials);
  } catch (error) {
    credentialsError = error.message;
  }
  const frpc = readFileSync(paths.frpc, "utf8");
  let origin = "",
    originError = "";
  if (frpc.trim()) {
    try {
      origin = readFrpcOrigin(
        frpc,
        readLocalPorts(desktopPaths(directory).CODEXBOARD_PORTS_FILE).caddy,
      );
    } catch (error) {
      originError = error.message;
    }
  }
  const accessMode =
    credentialsError || credentials.appId || credentials.appSecret ? "feishu" : "web";
  return { ...credentials, accessMode, credentialsError, origin, originError, frpc, paths };
}
export async function saveDeploymentConfiguration(directory, values, verifyFrpc) {
  const current = readDeploymentConfiguration(directory);
  const appId = String(values.appId ?? current.appId ?? "").trim();
  const secret = String(values.appSecret ?? current.appSecret ?? "").trim();
  const frpc = String(values.frpc || "").trim();
  if (appId && !/^cli_[A-Za-z0-9]+$/.test(appId))
    throw new Error("App ID 格式无效，应以 cli_ 开头");
  if (secret.length > 4096 || /[\r\n\0]/.test(secret)) throw new Error("App Secret 格式无效");
  if (Buffer.byteLength(frpc) > 262144 || frpc.includes("\0"))
    throw new Error("frpc.toml 内容过大或包含无效字符");
  const paths = deploymentPaths(directory);
  if (Boolean(appId) !== Boolean(secret))
    throw new Error("飞书 App ID 和 App Secret 请同时填写，或同时留空以仅使用 Web 账号");
  const accessMode = appId && secret ? "feishu" : "web";
  if (!frpc) throw new Error("请填写 frpc.toml 配置");
  const origin = readFrpcOrigin(
    frpc,
    readLocalPorts(desktopPaths(directory).CODEXBOARD_PORTS_FILE).caddy,
  );
  if (accessMode === "web" && !origin.startsWith("https://"))
    throw new Error("Web 账号访问必须使用 HTTPS 隧道");
  function clearLegacyCredentials() {
    // An explicit save confirms these credentials over legacy copies.
    for (const file of [
      join(directory, "production.env"),
      join(dirname(paths.credentials), "feishu-app-secret"),
    ])
      rmSync(file, { force: true });
  }
  if (
    current.accessMode === accessMode &&
    !current.credentialsError &&
    current.appId === appId &&
    current.appSecret === secret &&
    current.frpc.trim() === frpc
  ) {
    clearLegacyCredentials();
    return { ...current, changed: false };
  }
  const changes = [
    {
      path: paths.credentials,
      content: JSON.stringify({ appId, appSecret: secret }, null, 2) + "\n",
    },
    { path: paths.frpc, content: frpc + "\n" },
  ];
  const staged = [];
  const written = [];
  try {
    for (const change of changes) {
      const temp = join(dirname(change.path), `.codexboard-config-${randomUUID()}.toml`);
      const previous = existsSync(change.path) ? readFileSync(change.path) : null;
      const mode = previous === null ? 0o600 : statSync(change.path).mode & 0o777;
      writePrivateNew(temp, change.content);
      staged.push({ ...change, temp, previous, mode });
    }
    if (frpc) {
      try {
        await verifyFrpc(staged.find((item) => item.path === paths.frpc).temp);
      } catch {
        throw new Error("frpc.toml 配置无效，请检查 TOML 内容及隧道参数");
      }
    }
    for (const item of staged) {
      renameSync(item.temp, item.path);
      written.push(item);
    }
  } catch (error) {
    for (const item of written.reverse()) {
      if (item.previous === null) rmSync(item.path, { force: true });
      else {
        writeFileSync(item.path, item.previous);
        if (process.platform === "win32") ensurePrivateFileSync(item.path);
        else chmodSync(item.path, item.mode);
      }
    }
    throw error;
  } finally {
    for (const item of staged) rmSync(item.temp, { force: true });
  }
  const result = readDeploymentConfiguration(directory);
  clearLegacyCredentials();
  return { ...result, changed: true };
}
function verifyFrpcFile(binary, file) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["verify", "-c", file], { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timeout"));
    }, 5000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error("invalid config"));
    });
  });
}

function configurationFingerprint(deployment, ports, codexPath) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        deployment.accessMode,
        deployment.appId,
        deployment.appSecret,
        deployment.frpc,
        ports,
        codexPath,
      ]),
    )
    .digest("hex");
}

async function main() {
  const root = resolve(process.argv[2]);
  const stateDir = resolve(process.argv[3]);
  ensurePrivateDirectorySync(stateDir);
  const defaults = {
    configDirectory: join(stateDir, "deploy"),
    codexPath: detectCodexPath(),
  };
  const settings = defaults;
  let initializationError = "";
  try {
    initializeDeployment(settings.configDirectory, {
      ...DEFAULT_PORTS,
      caddy: 58981,
    });
  } catch {
    initializationError = "配置初始化失败，请在连接配置中检查飞书凭据或文件权限";
  }
  const state = {
    phase: "stopped",
    message: "服务尚未启动",
    settings,
    services: [],
    webAccounts: [],
    webAccountsBusy: false,
    webAccountsMessage: "",
    webAccountsRevision: 0,
    url: "",
    deployment: {},
    deploymentSaving: false,
    deploymentMessage: initializationError,
    deploymentRevision: 0,
    ports: { ...DEFAULT_PORTS },
    portsSaving: false,
    portsMessage: "",
    portsRevision: 0,
    configRevision: 0,
    restartRequired: false,
    boardOpening: false,
    boardOpenError: "",
    setupContext: { origin: "", domain: "", caddyPort: DEFAULT_PORTS.caddy },
    logs: [],
  };
  let setupController;
  let config;
  let children = [];
  const savedFingerprint = () =>
    configurationFingerprint(state.deployment, state.ports, settings.codexPath);
  function refreshDeployment() {
    settings.codexPath = detectCodexPath();
    try {
      state.deployment = readDeploymentConfiguration(settings.configDirectory);
    } catch {
      state.deployment = {};
    }
    try {
      const paths = desktopPaths(settings.configDirectory);
      state.ports = readLocalPorts(paths.CODEXBOARD_PORTS_FILE);
    } catch (error) {
      state.portsMessage = error.message;
    }
    const origin = state.deployment.origin || "";
    state.setupContext = {
      ...readFrpcDnsTarget(state.deployment.frpc || ""),
      origin,
      domain: origin ? new URL(origin).hostname : "",
      caddyPort: state.ports.caddy,
    };
    if (children.length && config && config.fingerprint !== savedFingerprint())
      state.restartRequired = true;
    setupController?.refresh();
  }
  refreshDeployment();
  const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
  const publish = () => {
    setupController?.refresh();
    send({ event: "state", data: state });
  };
  function log(component, message) {
    state.logs.push({
      time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
      component,
      message: String(message).slice(0, 300),
    });
    state.logs = state.logs.slice(-120);
    publish();
  }
  let busy = false;
  let quitting = false;
  let healthBusy = false;
  setupController = createSetupController({
    readWebAccounts: () =>
      manageWebAccounts(desktopPaths(settings.configDirectory).CODEXBOARD_DATA_DIR, "list"),
    getConfiguration: () => ({
      accessMode: state.deployment.accessMode,
      appId: state.deployment.appId || "",
      appSecret: state.deployment.appSecret || "",
      frpc: state.deployment.frpc || "",
      caddyPort: state.ports.caddy,
      codexPath: settings.codexPath,
      frpcBinary: runtimeBinary(root, "frpc"),
      servicesRunning: children.length === 3,
      restartRequired: state.restartRequired,
    }),
    onChange: publish,
  });
  state.setup = setupController.state;
  function configuration() {
    settings.codexPath = detectCodexPath();
    if (!isAbsolute(settings.configDirectory) || !isAbsolute(settings.codexPath))
      throw new Error("配置目录和 Codex 路径必须是绝对路径");
    const c = desktopPaths(settings.configDirectory);
    try {
      const desktopState = JSON.parse(
        readFileSync(join(homedir(), ".codex/.codex-global-state.json"), "utf8"),
      );
      c.CODEXBOARD_WORKSPACE_ROOTS = [
        ...new Set(
          Object.values(desktopState["local-projects"] || {}).flatMap(
            (project) => project.rootPaths || [],
          ),
        ),
      ]
        .filter((path) => typeof path === "string" && isAbsolute(path) && !/[\r\n,]/.test(path))
        .join(",");
    } catch {
      /* Codex may not have been configured yet. */
    }
    const deployment = readDeploymentConfiguration(settings.configDirectory);
    const ports = readLocalPorts(c.CODEXBOARD_PORTS_FILE);
    const env = nativeEnvironment(
      { CODEXBOARD_ORIGIN: deployment.origin, CODEXBOARD_AUTH_MODE: deployment.accessMode },
      c,
      root,
      ports,
    );
    if (!existsSync(settings.codexPath))
      throw new Error("未找到 Codex 程序，请先安装并登录 Codex Desktop");
    if (deployment.accessMode === "feishu" && deployment.credentialsError)
      throw new Error(deployment.credentialsError);
    if (
      (deployment.accessMode === "feishu" && (!deployment.appId || !deployment.appSecret)) ||
      !deployment.frpc.trim()
    )
      throw new Error("请在连接配置中填写 App ID、App Secret 和 frpc 信息");
    if (deployment.originError) throw new Error(deployment.originError);
    const url = new URL(env.CODEXBOARD_ORIGIN);
    if (deployment.accessMode === "web" && url.protocol !== "https:")
      throw new Error("Web 账号访问必须使用 HTTPS");
    if (!isSupportedOrigin(url)) throw new Error("公网地址必须是 HTTP/HTTPS 域名或 HTTP 公网 IPv4");
    return {
      c,
      env,
      url,
      ports,
      revision: state.configRevision,
      fingerprint: configurationFingerprint(deployment, ports, settings.codexPath),
      appId: deployment.appId,
      codex: realpathSync(settings.codexPath),
    };
  }
  async function stop() {
    if (!children.length) {
      state.phase = "stopped";
      state.message = "服务已停止";
      publish();
      return;
    }
    state.phase = "stopping";
    state.message = "正在停止后台服务…";
    publish();
    const owned = children;
    children = [];
    await stopChildren(owned);
    state.phase = "stopped";
    state.message = "服务已停止";
    state.services = state.services.map((s) => ({ ...s, status: "stopped" }));
    publish();
  }
  function launch(name, command, args, env, ipc = false) {
    const child = spawn(command, args, {
      cwd: root,
      env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    state.services.push({ name, status: "starting" });
    child.on("error", () => log(name, "进程启动失败"));
    for (const stream of [child.stdout, child.stderr])
      createInterface({ input: stream }).on("line", (line) => {
        // Log only known message fields; never include headers, env, tokens or request bodies.
        try {
          const record = JSON.parse(line);
          if (
            record.msg &&
            !["incoming request", "request completed", "handled request"].includes(record.msg)
          )
            log(name, record.msg);
        } catch {
          /* Native diagnostics can contain credentials; suppress raw lines. */
        }
      });
    child.on("close", () => {
      if (!children.includes(child)) return;
      log(name, "服务意外退出，正在停止其余服务");
      void stop().then(() => {
        state.phase = "error";
        state.message = `${name} 意外退出，请检查配置后重试`;
        publish();
      });
    });
  }
  async function start() {
    if (children.length) return;
    refreshDeployment();
    state.phase = "starting";
    state.message = "正在检查配置与端口…";
    state.services = [];
    publish();
    try {
      config = configuration();
      const { c, env, url, ports, codex } = config;
      env.CODEXBOARD_CODEX_COMMAND = codex;
      await assertPortsFree([ports.api, ports.admin, ports.bridge, ports.caddy]);
      ensurePrivateDirectorySync(join(c.CODEXBOARD_DATA_DIR, "run"));
      const caddyPath = join(stateDir, "Caddyfile");
      writeFileSync(caddyPath, renderCaddyfile(url, ports), { mode: 0o600 });
      const common = {
        ...runtimeEnvironment(root),
        ...env,
        XDG_DATA_HOME: c.CODEXBOARD_CADDY_DATA_DIR,
        XDG_CONFIG_HOME: c.CODEXBOARD_CADDY_CONFIG_DIR,
      };
      const node = runtimeBinary(root, "node");
      launch(
        "CodexBoard 后端",
        node,
        ["apps/server/dist/main.js"],
        common,
        process.platform === "win32",
      );
      // Do not let Caddy establish a keep-alive connection to another process
      // sharing the wildcard port while our loopback backend is still starting.
      const backendDeadline = Date.now() + 15000;
      while (!(await checkLocalApi(ports.api, url.host))) {
        if (!children.length || Date.now() >= backendDeadline)
          throw new Error("后端未能就绪，请检查端口占用或运行日志");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      launch(
        "Caddy",
        runtimeBinary(root, "caddy"),
        ["run", "--config", caddyPath, "--adapter", "caddyfile"],
        common,
      );
      launch(
        "公网隧道",
        runtimeBinary(root, "frpc"),
        ["-c", c.CODEXBOARD_FRPC_CONFIG_FILE],
        common,
      );
      state.url = url.origin;
      state.message = "服务启动中，等待健康检查…";
      publish();
    } catch (e) {
      await stop();
      state.phase = "error";
      state.message = e.code === "ENOENT" ? "找不到部署配置，请检查配置目录" : e.message;
      publish();
    }
  }
  async function health() {
    if (!children.length || healthBusy) return;
    healthBusy = true;
    const active = config;
    const owned = children;
    try {
      const api = await checkLocalApi(active.ports.api, active.url.host);
      const bridge = await fetch(`http://127.0.0.1:${active.ports.bridge}/readyz`, {
        signal: AbortSignal.timeout(1000),
      })
        .then((r) => r.ok)
        .catch(() => false);
      const tls = await new Promise((ok) => {
        const req = (active.url.protocol === "http:" ? http : https).get(
          {
            hostname: "127.0.0.1",
            port: active.ports.caddy,
            servername: active.url.hostname,
            path: "/api/health",
            headers: { host: active.url.host },
            agent: false,
          },
          (res) => {
            res.resume();
            ok(res.statusCode === 200);
          },
        );
        req.setTimeout(1000, () => req.destroy());
        req.on("error", () => ok(false));
      });
      if (!children.length || children !== owned || config !== active) return;
      const checks = [bridge && api, tls, true];
      state.services = state.services.map((s, i) => ({
        ...s,
        status: i === 2 ? "running" : checks[i] ? "ready" : "waiting",
      }));
      state.phase = checks.every(Boolean) ? "ready" : "starting";
      if (
        state.phase === "ready" &&
        active.revision === state.configRevision &&
        active.fingerprint === savedFingerprint()
      )
        state.restartRequired = false;
      state.message = checks.every(Boolean) ? "本机服务运行正常" : "服务运行中，部分连接尚未就绪";
      publish();
    } finally {
      healthBusy = false;
    }
  }
  const lines = createInterface({ input: process.stdin });
  let queue = Promise.resolve();
  lines.on("line", (line) => {
    queue = queue.then(async () => {
      let request;
      try {
        request = JSON.parse(line);
        busy = true;
        if (request.action === "start") await start();
        else if (request.action === "restart") {
          await stop();
          await start();
        } else if (request.action === "stop") await stop();
        else if (request.action === "open_board") {
          state.boardOpening = true;
          state.boardOpenError = "";
          publish();
          try {
            await openFeishuBoard({
              phase: state.phase,
              appId: config?.appId,
              origin: config?.url.origin,
            });
          } catch (error) {
            state.boardOpenError = error.message;
          } finally {
            state.boardOpening = false;
            publish();
          }
        } else if (request.action === "open_web_board") {
          try {
            if (state.phase !== "ready" || config?.url.protocol !== "https:")
              throw new Error("请先启动服务并配置 HTTPS 公网地址。");
            await openNativeApp(null, config.url.origin);
            state.webAccountsMessage = "已在默认浏览器打开登录页面。";
          } catch {
            state.webAccountsMessage =
              "无法打开 Web 看板，请确认服务已启动、已配置 HTTPS 和默认浏览器。";
          }
          publish();
        } else if (request.action === "web_accounts") {
          state.webAccountsBusy = true;
          state.webAccountsMessage = "正在处理…";
          publish();
          try {
            const data = desktopPaths(settings.configDirectory).CODEXBOARD_DATA_DIR;
            const { operation, ...input } = request.settings || {};
            const result = await manageWebAccounts(data, operation, input);
            state.webAccounts =
              operation === "list" ? result : await manageWebAccounts(data, "list");
            state.webAccountsMessage =
              operation === "list" ? "账号列表已刷新。" : "已保存，立即生效。";
            state.webAccountsRevision += 1;
          } catch (error) {
            state.webAccountsMessage = error.message;
          } finally {
            request.settings = null;
            state.webAccountsBusy = false;
            publish();
          }
        } else if (request.action === "setup_check") {
          refreshDeployment();
          await setupController.check(request.settings || {});
        } else if (request.action === "setup_open") {
          await setupController.open(request.settings?.target);
        } else if (request.action === "deployment") {
          state.deploymentSaving = true;
          state.deploymentMessage = "正在校验并保存…";
          publish();
          try {
            state.deployment = await saveDeploymentConfiguration(
              settings.configDirectory,
              request.settings || {},
              (file) => verifyFrpcFile(runtimeBinary(root, "frpc"), file),
            );
            state.deploymentRevision += 1;
            const changed = state.deployment.changed;
            if (changed) {
              state.configRevision += 1;
              state.restartRequired = true;
            }
            refreshDeployment();
            state.deploymentMessage = changed ? "配置已保存，重启服务后生效。" : "配置未更改。";
          } catch (error) {
            state.deploymentMessage =
              /公网|App ID|App Secret|frpc|请填写|部署.*路径|普通文件|凭据/.test(error.message)
                ? error.message
                : "保存失败，请检查配置目录和文件写入权限。";
          } finally {
            request.settings = null;
            state.deploymentSaving = false;
            publish();
          }
        } else if (request.action === "ports") {
          state.portsSaving = true;
          state.portsMessage = "正在校验并保存…";
          publish();
          try {
            const paths = desktopPaths(settings.configDirectory);
            const savedPorts = await savePorts(
              paths.CODEXBOARD_PORTS_FILE,
              paths.CODEXBOARD_FRPC_CONFIG_FILE,
              request.settings || {},
              (file) => verifyFrpcFile(runtimeBinary(root, "frpc"), file),
            );
            state.ports = savedPorts.ports;
            state.portsRevision += 1;
            if (savedPorts.changed) {
              state.configRevision += 1;
              state.restartRequired = true;
            }
            refreshDeployment();
            state.portsMessage = savedPorts.changed
              ? "配置已保存，重启服务后生效。"
              : "配置未更改。";
          } catch (error) {
            state.portsMessage = /端口|frpc|普通文件|公网/.test(error.message)
              ? error.message
              : "保存失败，请检查文件写入权限。";
          } finally {
            request.settings = null;
            state.portsSaving = false;
            publish();
          }
        }
        send({ id: request.id, ok: true });
      } catch {
        send({ id: request?.id, ok: false, error: "操作失败，请检查配置或停止服务后重试" });
      } finally {
        if (request) request.settings = null;
        busy = false;
      }
    });
  });
  const timer = setInterval(() => {
    if (!busy) {
      refreshDeployment();
      publish();
      void health();
    }
  }, 2500);
  async function quit() {
    if (quitting) return;
    quitting = true;
    clearInterval(timer);
    await queue;
    await stop();
    process.exit(0);
  }
  lines.on("close", () => void quit());
  process.once("SIGTERM", () => void quit());
  process.once("SIGINT", () => void quit());
  publish();
  if (!initializationError) queue = queue.then(() => start());
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
