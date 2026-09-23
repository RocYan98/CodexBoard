import { createCodexSessionBridge } from "./codex-session-bridge.mjs";
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertPrivateFileSync } from "./private-file-permissions.mjs";

import {
  readCodexDesktopProjects,
  startCodexProjectSnapshotWriter,
  writeProjectSnapshot,
} from "./codex-project-snapshot.mjs";

export { readCodexDesktopProjects, writeProjectSnapshot };

export function validateCodexBridgeOptions(options) {
  const codexPath = String(options.codexPath ?? "");
  const tokenFile = String(options.tokenFile ?? "");
  const projectStateFile = String(options.projectStateFile ?? "");
  const projectSnapshotFile = String(options.projectSnapshotFile ?? "");
  const endpoint = new URL(String(options.endpoint ?? ""));
  if (!isAbsolute(codexPath)) throw new Error("Codex 路径必须是绝对路径");
  const codexStat = lstatSync(codexPath);
  if (!codexStat.isFile() || codexStat.isSymbolicLink()) {
    throw new Error("Codex 路径必须是普通文件");
  }
  accessSync(codexPath, constants.X_OK);
  if (!isAbsolute(tokenFile)) throw new Error("Codex Token 文件必须是绝对路径");
  assertPrivateFileSync(tokenFile);
  if (!readFileSync(tokenFile, "utf8").trim()) throw new Error("Codex Token 文件为空");
  if (!isAbsolute(projectStateFile)) throw new Error("Codex 项目状态文件必须是绝对路径");
  const projectStateStat = lstatSync(projectStateFile);
  if (!projectStateStat.isFile() || projectStateStat.isSymbolicLink()) {
    throw new Error("Codex 项目状态文件必须是普通文件");
  }
  accessSync(projectStateFile, constants.R_OK);
  if (!isAbsolute(projectSnapshotFile)) throw new Error("Codex 项目快照文件必须是绝对路径");
  const port = Number(endpoint.port || 80);
  if (
    endpoint.protocol !== "ws:" ||
    endpoint.hostname !== "127.0.0.1" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    endpoint.username ||
    endpoint.password ||
    endpoint.href !== `${endpoint.origin}/`
  ) {
    throw new Error(
      "Codex App Server 必须监听 ws://127.0.0.1:<1-65535>，不能包含凭据、路径、查询或片段",
    );
  }
  return {
    codexPath: resolve(codexPath),
    tokenFile: resolve(tokenFile),
    projectStateFile: resolve(projectStateFile),
    projectSnapshotFile: resolve(projectSnapshotFile),
    endpoint: endpoint.origin,
  };
}

export { buildCodexArguments } from "./codex-session-bridge.mjs";

function argumentValue(arguments_, name) {
  const index = arguments_.indexOf(name);
  const value = index >= 0 ? arguments_[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`选项 ${name} 缺少值`);
  return value;
}

export async function startCodexBridge(input, dependencies = {}) {
  const options = validateCodexBridgeOptions(input);
  const startSnapshotWriter = dependencies.startSnapshotWriter ?? startCodexProjectSnapshotWriter;
  const createBridge = dependencies.createBridge ?? createCodexSessionBridge;
  const snapshotWriter = startSnapshotWriter({
    stateFile: options.projectStateFile,
    snapshotFile: options.projectSnapshotFile,
    onError: () => {},
  });
  try {
    const bridge = await createBridge({
      codexPath: options.codexPath,
      endpoint: options.endpoint,
      token: readFileSync(options.tokenFile, "utf8").trim(),
    });
    let closing;
    return {
      close() {
        closing ??= (async () => {
          try {
            await bridge.close();
          } finally {
            snapshotWriter.close();
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    snapshotWriter.close();
    throw error;
  }
}

export async function runCodexAppServer(arguments_) {
  const bridge = await startCodexBridge({
    codexPath: argumentValue(arguments_, "--codex"),
    tokenFile: argumentValue(arguments_, "--token-file"),
    endpoint: argumentValue(arguments_, "--endpoint"),
    projectStateFile: argumentValue(arguments_, "--project-state-file"),
    projectSnapshotFile: argumentValue(arguments_, "--project-snapshot-file"),
  });
  try {
    await new Promise((resolveExit) => {
      const stop = () => {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        resolveExit();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return 0;
  } finally {
    await bridge.close();
  }
}

let isEntrypoint = false;
try {
  isEntrypoint = Boolean(
    process.argv[1] &&
    (pathToFileURL(process.argv[1]).href === import.meta.url ||
      pathToFileURL(realpathSync.native(process.argv[1])).href === import.meta.url),
  );
} catch {
  // Importing this module does not require the host's argv[1] to exist.
}
if (isEntrypoint) {
  try {
    process.exitCode = await runCodexAppServer(process.argv.slice(2));
  } catch {
    process.stderr.write(
      `${JSON.stringify({ ok: false, code: "CODEX_BRIDGE_START_FAILED", message: "Codex App Server 启动失败" })}\n`,
    );
    process.exitCode = 1;
  }
}
