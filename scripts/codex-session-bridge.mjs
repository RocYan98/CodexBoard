import { desktopThreadPlacement } from "./codex-desktop-sidebar.mjs";
import { readDesktopPresets } from "./codex-desktop-models.mjs";
import { REMOTE_UPLOAD_MAX_BASE64_LENGTH, remoteTurnItems } from "@codexboard/contracts";
import { readTaskProgress } from "./codex-task-progress.mjs";
import { readRemoteImage } from "./codex-remote-image.mjs";
import { storeRemoteUpload, readRemoteUploadImage } from "./codex-remote-upload.mjs";
import { readRemoteReview } from "./codex-remote-review.mjs";
import { readCodexThreadTitle, readCodexThreadTitles } from "./codex-thread-title.mjs";
import { readGitOrigins } from "./git-origin-reader.mjs";
import { loadDesktopSession } from "./codex-desktop-loader.mjs";
import { connectDesktopSession } from "./codex-desktop-session.mjs";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { accessSync, chmodSync, constants, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { delimiter, isAbsolute, join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { isWindowsPipePath, localEndpointPath } from "./codex-local-endpoint.mjs";

export function buildCodexArguments() {
  return ["app-server", "--listen", "stdio://"];
}

// Helpers create and manage persisted threads; only Desktop executes turns.
export async function createCodexSessionBridge({
  codexPath,
  endpoint,
  token,
  desktopSessionConnector = loadDesktopSession,
  spawnProcess = spawn,
}) {
  const local = endpoint.startsWith("unix://") || endpoint.startsWith("npipe://");
  const address = local ? localEndpointPath(endpoint) : new URL(endpoint);
  const pipe = local && isWindowsPipePath(address);
  if (pipe && !token) throw new Error("Windows Codex 桥接需要认证令牌");
  const candidates = isAbsolute(codexPath)
    ? [codexPath]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .flatMap((directory) =>
          process.platform === "win32" && !codexPath.toLowerCase().endsWith(".exe")
            ? [join(directory, `${codexPath}.exe`), join(directory, codexPath)]
            : [join(directory, codexPath)],
        );
  codexPath = candidates.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (!codexPath) throw new Error("Codex App Server 进程启动失败");
  const connections = new Set();
  let closing = false;
  const server = createServer((request, response) => {
    response.writeHead(
      request.headers.origin ? 403 : ["/healthz", "/readyz"].includes(request.url) ? 200 : 404,
    );
    response.end();
  });
  const websockets = new WebSocketServer({
    noServer: true,
    maxPayload: REMOTE_UPLOAD_MAX_BASE64_LENGTH + 1024 * 1024,
  });
  server.on("upgrade", (request, socket, head) => {
    if (closing) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    const actual = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (
      request.headers.origin ||
      (token && (actual.length !== expected.length || !timingSafeEqual(actual, expected)))
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    websockets.handleUpgrade(request, socket, head, (ws) => websockets.emit("connection", ws));
  });
  websockets.on("connection", (socket) => {
    const workers = new Set();
    const threads = new Map();
    const readers = new Map();
    const operations = new Map();
    const lifetime = new AbortController();
    const serverRequests = new Map();
    let initializeParams;
    let codexHome;
    let control;
    let closed = false;
    let nextServerRequest = 0;
    const send = (message) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    const stop = async () => {
      closed = true;
      lifetime.abort();
      for (const reader of readers.values()) clearTimeout(reader.timer);
      readers.clear();
      await Promise.all([...workers].map((worker) => worker.stop()));
      socket.close();
      connections.delete(stop);
    };
    connections.add(stop);
    socket.on("close", () => {
      void stop();
    });
    socket.on("error", () => {
      void stop();
    });

    function makeWorker() {
      const child = spawnProcess(codexPath, buildCodexArguments(), {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const pending = new Map();
      let nextId = 0;
      let stopping;
      let exited = false;
      const exit = new Promise((resolveExit) => {
        const finish = () => {
          if (exited) return;
          exited = true;
          for (const waiter of pending.values()) waiter.reject(new Error("Codex 会话进程已退出"));
          pending.clear();
          workers.delete(worker);
          resolveExit();
          if (!stopping && !closed) socket.close(1011, "Codex session exited");
        };
        child.once("error", finish);
        child.once("close", finish);
      });
      const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
      child.stdin.on("error", () => {});
      // Keep raw diagnostics off the network and out of user-facing errors.
      child.stderr.on("data", () => {});
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          socket.close(1011, "invalid Codex response");
          return;
        }
        if ("id" in message && !("method" in message)) {
          const waiter = pending.get(message.id);
          if (!waiter) return;
          pending.delete(message.id);
          if (message.error)
            waiter.reject(
              Object.assign(new Error(message.error.message), { rpcError: message.error }),
            );
          else waiter.resolve(message.result);
        } else if ("id" in message) {
          const id = `bridge-request-${++nextServerRequest}`;
          serverRequests.set(id, { worker, id: message.id });
          send({ ...message, id });
        } else send(message);
      });
      const worker = {
        write,
        request(method, params) {
          if (exited) return Promise.reject(new Error("Codex 会话进程已退出"));
          return new Promise((resolveRequest, reject) => {
            const id = ++nextId;
            const timeout = setTimeout(() => {
              pending.delete(id);
              reject(new Error("Codex 会话请求超时"));
            }, 30_000);
            pending.set(id, {
              resolve: (value) => {
                clearTimeout(timeout);
                resolveRequest(value);
              },
              reject: (error) => {
                clearTimeout(timeout);
                reject(error);
              },
            });
            write({ id, method, params });
          });
        },
        stop() {
          stopping ??= (async () => {
            if (!exited) {
              // Windows SIGTERM terminates immediately. EOF lets the stdio
              // helper release its own locks before the existing kill deadline.
              if (process.platform === "win32") child.stdin.end();
              else child.kill("SIGTERM");
            }
            const timeout = setTimeout(() => {
              if (!exited) child.kill("SIGKILL");
            }, 5000);
            try {
              await exit;
            } finally {
              clearTimeout(timeout);
              lines.close();
            }
            for (const [id, request] of serverRequests)
              if (request.worker === worker) serverRequests.delete(id);
          })();
          return stopping;
        },
      };
      workers.add(worker);
      return worker;
    }
    async function initializeWorker(worker) {
      await worker.request("initialize", {
        ...initializeParams,
        capabilities: { ...initializeParams?.capabilities, experimentalApi: true },
      });
      worker.write({ method: "initialized", params: {} });
    }
    function isArchivedThreadPath(path) {
      if (typeof path !== "string") return false;
      const normalizedPath = path.replaceAll("\\", "/").replace(/\/+$/, "");
      const normalizedHome =
        typeof codexHome === "string" ? codexHome.replaceAll("\\", "/").replace(/\/+$/, "") : "";
      if (normalizedHome) {
        const archivedDirectory = `${normalizedHome}/archived_sessions`;
        return (
          normalizedPath === archivedDirectory || normalizedPath.startsWith(`${archivedDirectory}/`)
        );
      }
      return /(?:^|\/)archived_sessions(?:\/|$)/.test(normalizedPath);
    }
    async function archiveUnloadedThread(threadId, params) {
      const worker = makeWorker();
      let timeout;
      try {
        return await Promise.race([
          (async () => {
            await initializeWorker(worker);
            // Archive operates on an in-process rollout. Historical threads can
            // be readable from disk while absent from this bridge's worker map.
            const readResult = await worker.request("thread/read", { threadId });
            if (isArchivedThreadPath(readResult?.thread?.path)) return {};
            return await worker.request("thread/archive", params);
          })(),
          new Promise((_resolve, reject) => {
            // Leave time for the 5s shutdown before the client's 30s RPC deadline.
            timeout = setTimeout(() => reject(new Error("Codex 会话归档超时")), 20_000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
        await worker.stop();
      }
    }
    async function withHelper(action) {
      const worker = makeWorker();
      let timeout;
      try {
        return await Promise.race([
          (async () => {
            await initializeWorker(worker);
            if (closed) throw new Error("连接已关闭");
            return await action(worker);
          })(),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Codex 辅助操作超时")), 20_000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
        // Never return a new thread while its creator can still hold a writer lock.
        await worker.stop();
      }
    }
    async function desktopFor(threadId) {
      if (typeof threadId !== "string" || !threadId) throw new Error("缺少对话编号");
      if (threads.has(threadId)) return threads.get(threadId);
      let desktop;
      desktop = await desktopSessionConnector({
        codexHome,
        threadId,
        signal: lifetime.signal,
        onMessage: (notification) => {
          if ("id" in notification && "method" in notification) {
            const id = `bridge-request-${++nextServerRequest}`;
            serverRequests.set(id, { worker: desktop, id: notification.id });
            send({ ...notification, id });
          } else if (notification.method === "serverRequest/resolved") {
            for (const [id, request] of serverRequests) {
              if (request.worker !== desktop || request.id !== notification.params?.requestId)
                continue;
              serverRequests.delete(id);
              send({ ...notification, params: { ...notification.params, requestId: id } });
            }
          } else send(notification);
        },
        onDisconnect: (turnId) => {
          send({ method: "taskboard/sessionLost", params: { threadId, turnId } });
          if (threads.get(threadId) === desktop) threads.delete(threadId);
          workers.delete(desktop);
          for (const [id, request] of serverRequests)
            if (request.worker === desktop) serverRequests.delete(id);
        },
      });
      const stopDesktop = desktop.stop.bind(desktop);
      desktop.stop = async () => {
        await stopDesktop();
        workers.delete(desktop);
        if (threads.get(threadId) === desktop) threads.delete(threadId);
        for (const [id, request] of serverRequests)
          if (request.worker === desktop) serverRequests.delete(id);
      };
      workers.add(desktop);
      if (closed) {
        await desktop.stop();
        throw new Error("连接已关闭");
      }
      threads.set(threadId, desktop);
      return desktop;
    }
    async function handle(message, readOnlyOwner = false) {
      if (!("method" in message)) {
        const request = serverRequests.get(message.id);
        if (request) {
          serverRequests.delete(message.id);
          await request.worker.write({ ...message, id: request.id });
        }
        return;
      }
      if (closed) throw new Error("连接已关闭");
      if (message.method === "initialize") {
        if (control) throw new Error("Already initialized");
        initializeParams = message.params;
        control = makeWorker();
        const result = await control.request("initialize", initializeParams);
        codexHome = result.codexHome;
        return result;
      }
      if (!control) throw new Error("Not initialized");
      if (!("id" in message)) {
        if (message.method === "initialized") control.write(message);
        return;
      }
      if (message.method === "taskboard/remote/model-presets")
        return { presets: await readDesktopPresets(message.params?.models ?? []) };
      if (message.method === "taskboard/taskProgress")
        return await readTaskProgress(codexHome, message.params);
      if (message.method === "taskboard/gitOrigins")
        return await readGitOrigins(codexHome, message.params);
      if (message.method === "taskboard/remote/upload")
        return await storeRemoteUpload(codexHome, message.params);
      if (message.method === "taskboard/remote/upload/read")
        return await readRemoteUploadImage(codexHome, message.params);
      const threadId = message.params?.threadId;
      if (message.method === "taskboard/remote/rename") {
        const name = message.params?.name;
        if (
          typeof threadId !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(threadId) ||
          typeof name !== "string" ||
          !name.trim() ||
          name.trim().length > 120 ||
          /[\r\n]/.test(name)
        )
          throw new Error("对话编号或标题无效");
        // A metadata-only API: never create a helper or load/resume the target.
        await control.request("thread/name/set", { threadId, name: name.trim() });
        if ((await readCodexThreadTitle(codexHome, threadId)) !== name.trim())
          throw new Error("标题保存结果尚未确认，请刷新核实");
        return {};
      }

      if (
        [
          "taskboard/remote/read",
          "taskboard/remote/image",
          "taskboard/remote/review",
          "taskboard/remote/history",
          "taskboard/remote/send",
          "taskboard/remote/steer",
          "taskboard/remote/queue",
          "taskboard/remote/stop",
          "taskboard/remote/respond",
          "taskboard/remote/answer",
          "taskboard/remote/edit",
          "taskboard/remote/compact",
        ].includes(message.method)
      ) {
        // Independent follower subscriptions must not replace/release the
        // task executor's subscription or forward its approval RPC IDs.
        const keepReader = [
          "taskboard/remote/read",
          "taskboard/remote/image",
          "taskboard/remote/review",
          // Guidance must validate against the hydrated state shown by polling,
          // rather than a fresh follower's older initial snapshot.
          "taskboard/remote/steer",
          "taskboard/remote/queue",
          "taskboard/remote/answer",
          "taskboard/remote/edit",
        ].includes(message.method);
        let reader = keepReader ? readers.get(threadId) : undefined;
        if (!reader) {
          reader = { timer: undefined, promise: undefined, users: 0 };
          const entry = reader;
          if (keepReader) readers.set(threadId, entry);
          // Background reconciliation must not navigate Desktop to old tasks.
          const connector =
            readOnlyOwner && desktopSessionConnector === loadDesktopSession
              ? connectDesktopSession
              : desktopSessionConnector;
          entry.promise = connector({
            codexHome,
            threadId,
            signal: lifetime.signal,
            onMessage: () => {},
            onDisconnect: () => {
              if (readers.get(threadId) === entry) readers.delete(threadId);
              clearTimeout(entry.timer);
              void entry.promise?.then(
                (desktop) => workers.delete(desktop),
                () => {},
              );
            },
          })
            .then(async (desktop) => {
              if (closed) {
                await desktop.stop();
                throw new Error("连接已关闭");
              }
              workers.add(desktop);
              return desktop;
            })
            .catch((error) => {
              if (readers.get(threadId) === entry) readers.delete(threadId);
              throw error;
            });
        }
        clearTimeout(reader.timer);
        reader.users++;
        const desktop = await reader.promise;
        try {
          if (closed) throw new Error("连接已关闭");
          if (message.method === "taskboard/remote/image") {
            const snapshot = await desktop.request("taskboard/remote/read", { threadId });
            return await readRemoteImage(snapshot, message.params);
          }
          if (message.method === "taskboard/remote/review") {
            const snapshot = await desktop.request("taskboard/remote/read", { threadId });
            return await readRemoteReview(snapshot, message.params);
          }
          const result = await desktop.request(message.method, message.params);
          if (message.method === "taskboard/remote/read") {
            const title = await readCodexThreadTitle(codexHome, threadId);
            return title ? { ...result, title } : result;
          }
          return result;
        } finally {
          reader.users--;
          if (!keepReader || closed || readers.get(threadId) !== reader) {
            await desktop.stop();
            workers.delete(desktop);
          } else if (reader.users === 0) {
            // Polling keeps the follower alive long enough to receive Desktop's
            // hydration patches after its initial (possibly stale) snapshot.
            const entry = reader;
            entry.timer = setTimeout(() => {
              if (readers.get(threadId) === entry) readers.delete(threadId);
              workers.delete(desktop);
              void desktop.stop();
            }, 60_000);
            entry.timer.unref?.();
          }
        }
      }
      if (message.method === "thread/unsubscribe") {
        const desktop = threads.get(threadId);
        if (!desktop) return { status: "notLoaded" };
        await desktop.stop();
        return { status: "unsubscribed" };
      }
      if (message.method === "thread/start") {
        if (message.params?.ephemeral) throw new Error("桌面接续需要持久化对话");
        return await withHelper(async (worker) => {
          const result = await worker.request("thread/start", message.params);
          await worker.request("thread/section/move", {
            threadId: result.thread.id,
            sectionId: null,
          });
          return result;
        });
      }
      if (["thread/resume", "turn/start", "turn/interrupt"].includes(message.method)) {
        let params = message.params;
        if (message.method === "turn/start") {
          // Desktop can persist its default reviewer when loading an unstarted
          // draft, even when App Server's project config selects auto-review.
          // Resolve on every task turn so existing drafts and continued tasks
          // also honor configuration changes. Leave sandbox/policy inheritance
          // and Remote's explicit permission selection untouched.
          const { config } = await control.request("config/read", {
            cwd: params.cwd,
            includeLayers: false,
          });
          const reviewer = config?.approvals_reviewer;
          if (reviewer != null) {
            if (!["user", "auto_review", "guardian_subagent"].includes(reviewer))
              throw new Error("Codex 审批人配置无效，请检查项目配置");
            params = {
              ...params,
              approvalsReviewer: reviewer === "guardian_subagent" ? "auto_review" : reviewer,
            };
          }
        }
        const desktop = await desktopFor(threadId);
        return await desktop.request(message.method, params);
      }
      if (message.method === "thread/archive" && typeof threadId === "string" && threadId) {
        await threads.get(threadId)?.stop();
        return await archiveUnloadedThread(threadId, message.params);
      }
      if (message.method === "thread/read") {
        // Persisted App Server history can report an interrupted turn while its
        // Desktop owner is still working. Only the hydrated owner snapshot can
        // establish its outcome; an unreachable owner is not a failed turn.
        const state = await handle({ ...message, method: "taskboard/remote/read" }, true);
        const turns =
          state.turnHistory?.kind === "canonical"
            ? Object.values(state.turnHistory.history.entitiesByKey)
            : state.turns;
        if (state.id !== threadId || !Array.isArray(turns))
          throw new Error("Desktop 对话状态尚未确认");
        return {
          thread: {
            id: threadId,
            cwd: state.cwd,
            turns: turns
              .slice()
              .sort((a, b) => Number(a.turnStartedAtMs ?? 0) - Number(b.turnStartedAtMs ?? 0))
              .map((turn) => ({
                id: turn.turnId,
                status: turn.status,
                error: turn.error ?? null,
                items: remoteTurnItems(turn),
              })),
          },
        };
      }
      if (message.method === "thread/list") {
        const result = await control.request(message.method, message.params);
        const titles = await readCodexThreadTitles(
          codexHome,
          result.data.map((thread) => thread.id),
        );
        return {
          ...result,
          data: await desktopThreadPlacement(
            codexHome,
            result.data.map((thread) => ({
              ...thread,
              name: titles.get(thread.id) ?? thread.name,
            })),
          ),
        };
      }
      if (message.method === "thread/name/set") {
        return await withHelper((worker) => worker.request(message.method, message.params));
      }
      if (message.method === "model/list") {
        // A long-lived helper retains its startup catalog. A fresh read-only
        // helper loads the current host/account catalog without owning a thread.
        return await withHelper((worker) => worker.request(message.method, message.params));
      }
      if (
        ["fs/createDirectory", "account/rateLimits/read", "command/exec"].includes(message.method)
      ) {
        return await control.request(message.method, message.params);
      }
      throw Object.assign(new Error("不支持此桥接操作"), {
        rpcError: { code: -32601, message: "不支持此桥接操作" },
      });
    }
    // Serialize per-thread lifecycle changes, while approval replies remain independent.
    function dispatch(message) {
      const key = "id" in message && "method" in message ? message.params?.threadId : undefined;
      if (!key) return handle(message);
      const operation = (operations.get(key) ?? Promise.resolve())
        .catch(() => {})
        .then(() => handle(message));
      operations.set(key, operation);
      void operation
        .finally(() => {
          if (operations.get(key) === operation) operations.delete(key);
        })
        .catch(() => {});
      return operation;
    }
    socket.on("message", (data, binary) => {
      let message;
      try {
        if (binary) throw new Error();
        message = JSON.parse(data.toString());
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error();
      } catch {
        socket.close(1007, "invalid JSON request");
        return;
      }
      void dispatch(message)
        .then((result) => {
          if ("method" in message && "id" in message) send({ id: message.id, result });
        })
        .catch((error) => {
          if ("method" in message && "id" in message)
            send({
              id: message.id,
              error: error.rpcError ?? { code: -32603, message: "Codex 会话连接失败" },
            });
        });
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    if (local) server.listen(address, resolveListen);
    else server.listen(Number(address.port || 80), address.hostname, resolveListen);
  });
  if (local && !pipe) chmodSync(address, 0o600);
  return {
    endpoint: local ? endpoint : `ws://127.0.0.1:${server.address().port}`,
    async close() {
      closing = true;
      await Promise.all([...connections].map((stop) => stop()));
      for (const socket of websockets.clients) socket.terminate();
      websockets.close();
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
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
  const codexPath = process.argv[process.argv.indexOf("--codex") + 1];
  const endpoint = process.argv[process.argv.indexOf("--listen") + 1];
  if (!codexPath || (!endpoint?.startsWith("unix://") && !endpoint?.startsWith("npipe://")))
    throw new Error("Expected --codex and a local --listen endpoint");
  try {
    const token = process.env.CODEXBOARD_BRIDGE_TOKEN;
    delete process.env.CODEXBOARD_BRIDGE_TOKEN;
    const bridge = await createCodexSessionBridge({ codexPath, endpoint, token });
    if (endpoint.startsWith("npipe://")) {
      process.stdout.write("CODEXBOARD_BRIDGE_READY\n");
      // The owning supervisor closes stdin for graceful Windows shutdown;
      // Windows process signals otherwise terminate without running handlers.
      process.stdin.once("end", () => {
        void bridge.close();
      });
      process.stdin.resume();
    }
    for (const signal of ["SIGTERM", "SIGINT"])
      process.once(signal, () => {
        void bridge.close();
      });
  } catch {
    process.stderr.write("Codex App Server 进程启动失败");
    process.exitCode = 1;
  }
}
