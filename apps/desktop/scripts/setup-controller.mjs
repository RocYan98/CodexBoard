import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";
import { promisify } from "node:util";
import { runSetupChecks } from "./setup-checks.mjs";
import { readFrpcOrigin, readFrpcDnsTarget } from "./frpc-config.mjs";
import {
  findWindowsCodexCli,
  findWindowsCodexPackage,
  windowsOpenArguments,
} from "#codex-windows-app";

const appPaths = () => [
  "/Applications/Codex.app",
  "/Applications/ChatGPT.app",
  posix.join(homedir(), "Applications/Codex.app"),
  posix.join(homedir(), "Applications/ChatGPT.app"),
];

export function detectCodexPath(
  exists = existsSync,
  {
    platform = process.platform,
    env = process.env,
    localAppData,
    findWindowsPackage = findWindowsCodexPackage,
  } = {},
) {
  if (platform === "win32")
    return findWindowsCodexCli({ env, localAppData, exists, findWindowsPackage }) || "";
  const candidates = [
    ...appPaths().map((path) => posix.join(path, "Contents/Resources/codex")),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ];
  return candidates.find(exists) || candidates[0];
}

const targets = {
  "feishu-console": ["飞书开发者后台", "https://open.feishu.cn/app"],
  "frp-docs": ["FRP 官方文档", "https://gofrp.org/zh-cn/docs/examples/vhost-http/"],
  "codex-download": ["Codex 下载页面", "https://developers.openai.com/codex/app/"],
};

export async function openSetupTarget(
  target,
  {
    execute = promisify(execFile),
    exists = existsSync,
    platform = process.platform,
    findWindowsPackage = findWindowsCodexPackage,
  } = {},
) {
  let args,
    label,
    command = "/usr/bin/open";
  if (target === "codex-app") {
    const app = platform === "win32" ? findWindowsPackage({ exists }) : appPaths().find(exists);
    if (!app) throw new Error("未找到 Codex 应用，请先下载并安装，再打开应用完成登录。");
    if (platform === "win32") {
      command = "explorer.exe";
      args = [`shell:AppsFolder\\${app.appUserModelId}`];
    } else args = ["-a", app];
    label = "Codex";
  } else if (Object.hasOwn(targets, target)) {
    [label] = targets[target];
    if (platform === "win32") {
      command = "powershell.exe";
      args = windowsOpenArguments(targets[target][1]);
    } else args = [targets[target][1]];
  } else throw new Error("不支持打开此引导入口。");
  try {
    await execute(command, args, { timeout: 5000, maxBuffer: 8192, windowsHide: true });
  } catch {
    throw new Error("无法打开引导入口，请检查浏览器或 Codex 是否已安装。");
  }
  return `已打开${label}，完成操作后返回此处重新检查。`;
}

function fingerprint(input) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.appId,
        input.appSecret,
        input.frpc,
        input.caddyPort,
        input.codexPath,
        input.servicesRunning,
        input.restartRequired,
      ]),
    )
    .digest("hex");
}

export function createSetupController({
  getConfiguration,
  onChange = () => {},
  check = runSetupChecks,
  readWebAccounts,
  open = openSetupTarget,
}) {
  const state = {
    checking: false,
    section: "all",
    results: [],
    checkedAt: "",
    stale: false,
    error: "",
    notice: "",
    requestKey: "",
  };
  let savedAtCheck = "",
    lastInput = "";
  const refresh = () => {
    if (savedAtCheck && fingerprint(getConfiguration()) !== savedAtCheck) state.stale = true;
  };
  return {
    state,
    refresh,
    async check(settings = {}) {
      if (state.checking) return;
      state.error = "";
      if (typeof settings?.requestKey === "string" && settings.requestKey.length <= 128)
        state.requestKey = settings.requestKey;
      try {
        const section = settings.section || "all";
        const limits = {
          accessMode: 16,
          appId: 256,
          appSecret: 4096,
          frpc: 262144,
          requestKey: 128,
        };
        if (
          (settings.accessMode !== undefined && !["web", "feishu"].includes(settings.accessMode)) ||
          !settings ||
          typeof settings !== "object" ||
          !["all", "feishu", "web", "tunnel", "dns", "codex"].includes(section) ||
          Object.keys(settings).some((key) => key !== "section" && !Object.hasOwn(limits, key)) ||
          Object.entries(limits).some(
            ([key, limit]) =>
              settings[key] !== undefined &&
              (typeof settings[key] !== "string" || Buffer.byteLength(settings[key]) > limit),
          )
        ) {
          state.error = "检查参数无效，请重新打开使用引导后重试。";
          state.stale = true;
          return;
        }
        const saved = getConfiguration();
        const input = { ...saved, section };
        for (const key of ["accessMode", "appId", "appSecret", "frpc"])
          if (settings[key] !== undefined) input[key] = settings[key];
        const currentInput = fingerprint(input);
        savedAtCheck = fingerprint(saved);
        const checkKey = `${currentInput}:${input.accessMode || "feishu"}`;
        if (checkKey !== lastInput || section === "all") state.results = [];
        else state.results = state.results.filter((item) => item.section !== section);
        lastInput = checkKey;
        state.section = section;
        state.requestKey = settings.requestKey || "";
        state.checking = true;
        state.stale = false;
        state.notice =
          currentInput !== savedAtCheck
            ? "检查当前填写内容；保存并重启后，服务才使用这些配置。"
            : "";
        input.restartRequired ||= currentInput !== savedAtCheck;
        let origin = "";
        try {
          origin = readFrpcOrigin(input.frpc, input.caddyPort);
        } catch {
          // Incomplete drafts still receive actionable check results.
        }
        state.context = {
          ...readFrpcDnsTarget(input.frpc),
          origin,
          domain: origin ? new URL(origin).hostname : "",
          protocol: origin ? new URL(origin).protocol : "",
          publicPort: origin ? new URL(origin).port : "",
          caddyPort: input.caddyPort,
        };
        onChange();
        const onResult = (result) => {
          state.results = [...state.results.filter((item) => item.id !== result.id), result];
          onChange();
        };
        const results = await check(input, { onResult, readWebAccounts });
        for (const result of results) onResult(result);
        state.checkedAt = new Date().toISOString();
        refresh();
      } catch {
        state.error = "检查未完成，请检查本机网络后重试；也可逐项检查定位问题。";
        state.stale = true;
      } finally {
        state.checking = false;
        onChange();
      }
    },
    async open(target) {
      state.error = "";
      state.notice = "";
      try {
        state.notice = await open(target);
      } catch (error) {
        state.error = /^(未找到 Codex 应用|不支持打开此引导入口|无法打开引导入口)/.test(
          error.message,
        )
          ? error.message
          : "无法打开引导入口，请检查浏览器或 Codex 是否已安装。";
      }
      onChange();
    },
  };
}
