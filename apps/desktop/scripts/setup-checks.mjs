import { HealthResponseSchema } from "@codexboard/contracts";
import { execFile as execFileCallback } from "node:child_process";
import { lookup, resolve4, resolve6, resolveCname } from "node:dns/promises";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { ensurePrivateDirectorySync, ensurePrivateFileSync } from "#private-file-permissions";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createConnection, isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse } from "smol-toml";
import { readFrpcOrigin } from "./frpc-config.mjs";

export const SETUP_SECTIONS = Object.freeze(["feishu", "web", "tunnel", "dns", "codex"]);
const FEISHU_ENDPOINT = "https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal";
const MAX_BYTES = 64 * 1024;
const NETWORK_TIMEOUT_CODES = new Set(["SETUP_TIMEOUT", "ETIMEDOUT", "ABORT_ERR"]);
const NETWORK_CERTIFICATE_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_SIGNATURE_FAILURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);
const NETWORK_CONNECTION_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);
const execFile = promisify(execFileCallback);
function timeoutError() {
  return Object.assign(new Error("Probe timed out"), { code: "SETUP_TIMEOUT" });
}
async function limited(operation, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(timeoutError());
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// TLS verification is explicit, even if the launching shell has disabled it globally.
// Responses and subprocess output are never logged or copied into user-facing results.
export function requestJson(
  url,
  { method = "GET", body, signal, timeoutMs } = {},
  transports = { http: httpRequest, https: httpsRequest },
) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport =
      target.protocol === "http:"
        ? transports.http
        : target.protocol === "https:"
          ? transports.https
          : null;
    if (!transport) {
      reject(new Error("Unsupported request protocol"));
      return;
    }
    const request = transport(
      target,
      {
        method,
        signal,
        ...(target.protocol === "https:" ? { rejectUnauthorized: true } : {}),
        headers: {
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
      },
      (response) => {
        let length = 0;
        const chunks = [];
        response.on("error", reject);
        response.on("data", (chunk) => {
          length += chunk.length;
          if (length > MAX_BYTES) request.destroy(new Error("Response too large"));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch {
            reject(new Error("Invalid JSON response"));
          }
        });
      },
    );
    request.on("error", reject);
    request.setTimeout(timeoutMs, () => request.destroy(timeoutError()));
    request.end(body);
  });
}

function connectTcp(host, port, { signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port, signal });
    socket.once("error", reject);
    socket.setTimeout(timeoutMs, () => socket.destroy(timeoutError()));
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
  });
}

function tunnelConfiguration(input) {
  const origin = readFrpcOrigin(input.frpc, input.caddyPort);
  const config = parse(input.frpc);
  const server = config.serverAddr;
  const port = config.serverPort ?? 7000;
  if (
    typeof server !== "string" ||
    !server ||
    server.length > 253 ||
    (!isIP(server) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(server)) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error("Invalid tunnel endpoint");
  }
  return { origin, server, port };
}
function loggedIn(output) {
  return /^\s*Logged in using (?:ChatGPT|an API key(?:[ \t]+-[ \t]+\S+)?)[ \t]*$/im.test(output);
}
function loggedOut(output) {
  return /^\s*Not logged in\s*$/im.test(output);
}

/** Checks the supplied form values; never persists config or starts a tunnel/service. */
export async function runSetupChecks(input, options = {}) {
  const deps = {
    requestJson,
    execFile,
    lookup,
    resolve4,
    resolve6,
    resolveCname,
    connectTcp,
    ...options,
  };
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.min(options.timeoutMs, 5000)
      : 3500;
  const selected =
    input.section === "all" || !input.section
      ? SETUP_SECTIONS.filter((section) =>
          input.accessMode === "web" ? section !== "feishu" : section !== "web",
        )
      : [input.section];
  if (selected.some((section) => !SETUP_SECTIONS.includes(section)))
    throw new Error("不支持的检查项目");
  async function run(section) {
    const results = [];
    function emit(id, title, status, message, details) {
      const result = {
        id,
        section,
        title,
        status,
        message,
        ...(details?.length ? { details } : {}),
      };
      results.push(result);
      options.onResult?.(result);
    }
    const network = (url, request = {}) =>
      limited((signal) => deps.requestJson(url, { ...request, signal, timeoutMs }), timeoutMs);
    const command = (file, args) =>
      limited(
        (signal) =>
          deps.execFile(file, args, {
            timeout: timeoutMs,
            maxBuffer: MAX_BYTES,
            windowsHide: true,
            killSignal: "SIGKILL",
            signal,
          }),
        timeoutMs,
      );

    if (section === "web") {
      let secure = false;
      try {
        secure = new URL(readFrpcOrigin(input.frpc, input.caddyPort)).protocol === "https:";
      } catch {
        /* Invalid drafts are reported below. */
      }
      emit(
        "web.https",
        "HTTPS 访问",
        secure ? "passed" : "failed",
        secure ? "已配置 HTTPS 公网入口。" : "Web 账号访问必须配置 HTTPS 隧道。",
      );
      if (!input.servicesRunning || input.restartRequired) {
        emit("web.account", "Web 账号", "warning", "请先保存配置并启动或重启服务，再检查账号。");
      } else {
        try {
          if (typeof deps.readWebAccounts !== "function") throw new Error("Unavailable");
          const accounts = await limited(() => deps.readWebAccounts(), timeoutMs);
          if (!Array.isArray(accounts)) throw new Error("Invalid account list");
          const count = accounts.filter(
            (account) => account.active === true || account.active === 1,
          ).length;
          emit(
            "web.account",
            "Web 账号",
            count ? "passed" : "failed",
            count
              ? `已检测到 ${count} 个启用的 Web 账号。账号配置可用；实际密码登录需在浏览器验证。`
              : "尚无启用的 Web 账号，请在本机应用设置中创建或启用账号。",
          );
        } catch {
          emit("web.account", "Web 账号", "failed", "无法读取本机账号状态，请确认服务正常后重试。");
        }
      }
    }
    if (section === "feishu") {
      if (!input.appId?.trim() || !input.appSecret?.trim()) {
        emit(
          "feishu.credentials",
          "飞书应用凭据",
          "failed",
          "请先填写 App ID 和 App Secret，再重新检查。",
        );
      } else {
        try {
          const response = await network(FEISHU_ENDPOINT, {
            method: "POST",
            body: JSON.stringify({
              app_id: input.appId.trim(),
              app_secret: input.appSecret.trim(),
            }),
          });
          if (
            response.status === 200 &&
            response.body?.code === 0 &&
            typeof response.body.app_access_token === "string" &&
            response.body.app_access_token.length > 0
          ) {
            emit(
              "feishu.credentials",
              "飞书应用凭据",
              "passed",
              "App ID 与 App Secret 验证通过。",
              ["仅验证应用凭据，不代表权限、应用发布或用户登录已完成。"],
            );
          } else if (response.status === 429 || response.status >= 500) {
            emit(
              "feishu.credentials",
              "飞书应用凭据",
              "failed",
              "飞书服务暂时无法完成验证，请稍后重试。",
            );
          } else {
            emit(
              "feishu.credentials",
              "飞书应用凭据",
              "failed",
              "飞书应用凭据未通过验证，请核对 App ID 与 App Secret 是否属于同一个应用。",
            );
          }
        } catch (error) {
          emit(
            "feishu.credentials",
            "飞书应用凭据",
            "failed",
            error?.code === "SETUP_TIMEOUT"
              ? "飞书凭据验证超时，请检查网络后重试。"
              : "无法完成飞书凭据验证，请检查网络和系统时间后重试。",
          );
        }
      }
    }
    if (section === "tunnel") {
      let config;
      try {
        config = tunnelConfiguration(input);
        const protocol = new URL(config.origin).protocol;
        emit(
          "tunnel.configuration",
          "frpc 配置",
          "passed",
          protocol === "http:"
            ? "配置格式、公网 HTTP 地址和本机转发端口一致。"
            : "配置格式、HTTPS 域名和本机转发端口一致。",
        );
      } catch {
        emit(
          "tunnel.configuration",
          "frpc 配置",
          "failed",
          "请检查 frpc.toml 格式、serverAddr、服务端口，以及与 Caddy 端口一致的唯一 HTTPS 或 TCP 代理。",
        );
        return results;
      }
      let directory;
      try {
        if (!input.frpcBinary) throw new Error("Missing frpc executable");
        directory = await mkdtemp(join(tmpdir(), "codexboard-setup-check-"));
        ensurePrivateDirectorySync(directory);
        const file = join(directory, "frpc.toml");
        await writeFile(file, "", { mode: 0o600, flag: "wx" });
        ensurePrivateFileSync(file);
        await writeFile(file, input.frpc);
        await command(input.frpcBinary, ["verify", "-c", file]);
        emit(
          "tunnel.verify",
          "frpc 官方校验",
          "passed",
          "内置 frpc 配置校验通过；未启动额外隧道连接。",
        );
      } catch (error) {
        emit(
          "tunnel.verify",
          "frpc 官方校验",
          "failed",
          error?.code === "SETUP_TIMEOUT"
            ? "frpc 配置校验超时，请重新检查；仍失败时重新安装应用。"
            : "frpc 配置校验未通过，请核对服务商提供的完整配置和本机转发信息；缺少内置组件时请重新安装应用。",
        );
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
      try {
        const addresses = isIP(config.server)
          ? [{ address: config.server }]
          : await limited(() => deps.lookup(config.server, { all: true }), timeoutMs);
        const available = [
          ...new Set(addresses.filter((item) => isIP(item.address)).map((item) => item.address)),
        ];
        if (!available.length) throw new Error("No server address");
        // Try both address families within one deadline; a broken IPv6 route must
        // not hide an available IPv4 endpoint. Abort remaining sockets on success.
        const firstByFamily = [4, 6]
          .map((family) => available.find((address) => isIP(address) === family))
          .filter(Boolean);
        const targets = [...new Set([...firstByFamily, ...available])].slice(0, 4);
        await limited(
          (signal) =>
            Promise.any(
              targets.map((address) =>
                deps.connectTcp(address, config.port, { signal, timeoutMs }),
              ),
            ),
          timeoutMs,
        );
        emit(
          "tunnel.server",
          "隧道服务器网络",
          "passed",
          "服务器地址可以解析，服务端口网络可达。",
          ["网络可达不代表隧道账号认证成功、代理已注册或公网服务已发布。"],
        );
      } catch {
        emit(
          "tunnel.server",
          "隧道服务器网络",
          "failed",
          "无法连接隧道服务器，请检查 serverAddr、服务商提供的端口和本机网络。",
        );
      }
      if (!input.servicesRunning || input.restartRequired)
        emit(
          "tunnel.runtime",
          "运行配置",
          "warning",
          input.restartRequired
            ? "配置尚未应用，请由你决定重启服务后再确认隧道连接状态。"
            : "本机服务未运行，请启动服务后再确认隧道连接状态。",
        );
    }
    if (section === "dns") {
      let origin;
      try {
        origin = readFrpcOrigin(input.frpc, input.caddyPort);
      } catch {
        emit(
          "dns.configuration",
          "公网域名",
          "failed",
          "无法确定公网域名，请先检查 frpc 中与 Caddy 端口一致的 HTTPS 代理和 customDomains。",
        );
        return results;
      }
      const hostname = new URL(origin).hostname;
      const url = new URL(origin);
      const publicPort = url.port || (url.protocol === "http:" ? "80" : "443");
      if (isIP(hostname)) {
        emit("dns.records", "公网 IP", "passed", "入口使用公网 IP，无需配置或等待 DNS 解析。", [
          `IPv4：${hostname}`,
          `公网端口：${publicPort}`,
        ]);
      } else {
        const queries = [deps.resolve4, deps.resolve6, deps.resolveCname];
        const answers = await Promise.allSettled(
          queries.map((query) => limited(() => query(hostname), timeoutMs)),
        );
        const records = answers.map((answer, index) =>
          answer.status === "fulfilled" && Array.isArray(answer.value)
            ? answer.value
                .filter(
                  (value) =>
                    typeof value === "string" &&
                    (index === 2
                      ? value.length <= 253 && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9.]|)$/i.test(value)
                      : isIP(value) === (index === 0 ? 4 : 6)),
                )
                .slice(0, 10)
            : [],
        );
        const details = records.flatMap((values, index) =>
          values.map((value) => `${["A", "AAAA", "CNAME"][index]}：${value}`),
        );
        if (records[0].length || records[1].length) {
          emit(
            "dns.records",
            "公网 DNS",
            "passed",
            "域名已解析到可用的 IP 地址；入口地址可与隧道节点不同。",
            details,
          );
        } else {
          const directAnswered = answers
            .slice(0, 2)
            .some(
              (answer) =>
                (answer.status === "fulfilled" && Array.isArray(answer.value)) ||
                (answer.status === "rejected" &&
                  ["ENODATA", "ENOTFOUND"].includes(answer.reason?.code)),
            );
          let systemAnswered;
          let addresses = [];
          try {
            // lookup follows the OS resolver (including its cache/hosts), unlike
            // resolve*. Its success is not proof of a public A/AAAA DNS record.
            const values = await limited(() => deps.lookup(hostname, { all: true }), timeoutMs);
            systemAnswered = true;
            if (Array.isArray(values))
              addresses = values
                .filter(
                  (value) =>
                    typeof value?.address === "string" &&
                    [4, 6].includes(value.family) &&
                    isIP(value.address) === value.family,
                )
                .slice(0, 10);
          } catch (error) {
            systemAnswered = ["ENODATA", "ENOTFOUND"].includes(error?.code);
          }
          emit(
            "dns.records",
            "域名解析",
            addresses.length ? "passed" : "failed",
            addresses.length
              ? `系统域名解析可用；${directAnswered ? "直接 DNS 查询未得到可用的 A/AAAA 记录" : "直接 DNS 记录查询不可用"}，尚未核验公网 DNS 记录。`
              : directAnswered || systemAnswered
                ? "域名解析未得到可用的 IP 地址，请检查域名配置及系统解析设置后重试。"
                : "直接 DNS 查询与系统域名解析均不可用，暂时无法确认域名是否已解析，请检查网络后重试。",
            [
              ...details,
              ...addresses.map(({ address, family }) => `系统 IPv${family}：${address}`),
            ],
          );
        }
      }
      const protocolName = url.protocol === "http:" ? "HTTP" : "HTTPS";
      try {
        const response = await network(new URL("/api/health", origin).href);
        const parsed = HealthResponseSchema.safeParse(response.body);
        if (
          response.status !== 200 ||
          !parsed.success ||
          parsed.data.status !== "ok" ||
          parsed.data.checks.http !== "ok" ||
          parsed.data.checks.sqlite !== "ok"
        ) {
          emit(
            "dns.https",
            `公网 ${protocolName}`,
            "failed",
            `公网 ${protocolName} 未返回有效且健康的看板服务，请检查 Caddy、frpc 转发和后端状态。`,
          );
        } else if (!input.servicesRunning || input.restartRequired) {
          emit(
            "dns.https",
            `公网 ${protocolName}`,
            "warning",
            input.restartRequired
              ? `${url.protocol === "http:" ? "HTTP 明文测试入口" : "公网"}当前返回健康的看板服务，但待重启配置尚未应用，重启后需重新检查。`
              : `${url.protocol === "http:" ? "HTTP 明文测试入口" : "公网"}返回健康的看板服务，但本机服务未运行，无法确认响应来自当前应用。`,
          );
        } else {
          emit(
            "dns.https",
            `公网 ${protocolName}`,
            "passed",
            url.protocol === "http:"
              ? "HTTP 明文测试入口已返回健康的 CodexBoard 看板服务；此连接不受 TLS 加密保护。"
              : "TLS 证书有效，公网已返回健康的 CodexBoard 看板服务。",
          );
        }
      } catch (error) {
        let code = error?.name === "AbortError" ? "ABORT_ERR" : error?.code;
        let message;
        if (NETWORK_TIMEOUT_CODES.has(code))
          message = `公网 ${protocolName} 探测超时，请检查网络、隧道连接和后端响应后重试。`;
        else if (NETWORK_CERTIFICATE_CODES.has(code))
          message = "HTTPS 证书校验失败，请检查域名、Caddy 证书和系统时间。";
        else if (NETWORK_CONNECTION_CODES.has(code))
          message =
            url.protocol === "http:"
              ? "HTTP 公网连接失败，请检查公网 IP、remotePort、隧道连接和后端状态。"
              : "HTTPS 公网连接失败或已中断，请检查域名解析、隧道连接和网络后重试。";
        else {
          code = "OTHER";
          message = `公网 ${protocolName} 探测失败，原因尚未确定，请稍后重试。`;
        }
        emit("dns.https", `公网 ${protocolName}`, "failed", message, [`诊断代码：${code}`]);
      }
    }
    if (section === "codex") {
      if (!input.codexPath) {
        emit(
          "codex.login",
          "Codex 本地登录",
          "failed",
          "未找到 Codex 可执行文件，请检查已安装的 Codex 应用路径。",
        );
        return results;
      }
      try {
        const output = await command(input.codexPath, ["login", "status"]);
        const text = `${output.stdout ?? ""}\n${output.stderr ?? ""}`;
        if (loggedOut(text))
          emit(
            "codex.login",
            "Codex 本地登录",
            "failed",
            "Codex 尚未登录，请在 Codex 中完成登录后重试。",
          );
        else if (loggedIn(text))
          emit("codex.login", "Codex 本地登录", "passed", "Codex 本地登录状态已确认。", [
            "未验证在线令牌是否有效或账号额度是否可用；请通过一次实际 Codex 请求确认。",
          ]);
        else
          emit(
            "codex.login",
            "Codex 本地登录",
            "warning",
            "Codex 命令已执行，但无法确认此版本的登录状态，请打开 Codex 检查账号。",
          );
      } catch (error) {
        const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
        emit(
          "codex.login",
          "Codex 本地登录",
          "failed",
          error?.code === "ENOENT"
            ? "未找到 Codex 可执行文件，请检查已安装的 Codex 应用路径。"
            : error?.code === "EACCES" || error?.code === "EPERM"
              ? "系统拒绝执行 Codex 命令，无法检查登录状态；请确认 Codex 已正确安装并能正常打开。"
              : error?.code === "SETUP_TIMEOUT" || error?.killed || error?.name === "AbortError"
                ? "Codex 登录状态检查超时，请打开 Codex 确认运行正常后重试。"
                : loggedOut(output)
                  ? "Codex 尚未登录，请在 Codex 中完成登录后重试。"
                  : "Codex 登录状态检查失败，请打开 Codex 检查账号后重试。",
        );
      }
    }
    return results;
  }
  return (await Promise.all(selected.map(run))).flat();
}
