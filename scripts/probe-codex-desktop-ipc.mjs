import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopIpcPath, isWindowsPipePath } from "./codex-local-endpoint.mjs";

// Initialize a temporary client only: no thread discovery, subscription, history
// reads, turns or settings writes. Never emit raw peer responses or client IDs.
export function probeDesktopIpc({
  socketPath = desktopIpcPath(process.env.CODEX_HOME || join(homedir(), ".codex")),
  timeoutMs = 5000,
} = {}) {
  return new Promise((resolveProbe, reject) => {
    const requestId = randomUUID();
    const socket = createConnection(socketPath);
    let buffer = Buffer.alloc(0),
      finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(new Error("Codex Desktop IPC initialization failed"));
      else
        resolveProbe({
          status: "ready",
          transport: isWindowsPipePath(socketPath) ? "named-pipe" : "unix-socket",
          framing: "uint32le-json",
          initialized: true,
        });
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    socket.once("error", () => finish(true));
    socket.once("close", () => finish(true));
    socket.once("connect", () => {
      const body = Buffer.from(
        JSON.stringify({
          type: "request",
          requestId,
          sourceClientId: "initializing-client",
          version: 0,
          method: "initialize",
          params: { clientType: "cli" },
          timeoutMs,
        }),
      );
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32LE(body.length);
      socket.write(Buffer.concat([prefix, body]));
    });
    socket.on("data", (chunk) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 1024 * 1024) return finish(true);
        while (buffer.length >= 4) {
          const length = buffer.readUInt32LE();
          if (length > 1024 * 1024) return finish(true);
          if (buffer.length < length + 4) return;
          const message = JSON.parse(buffer.subarray(4, length + 4).toString());
          buffer = buffer.subarray(length + 4);
          if (message.type !== "response" || message.requestId !== requestId) continue;
          return finish(
            message.resultType !== "success" ||
              typeof message.result?.clientId !== "string" ||
              !message.result.clientId,
          );
        }
      } catch {
        finish(true);
      }
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await probeDesktopIpc())}\n`);
  } catch {
    process.stdout.write('{"status":"failed","initialized":false}\n');
    process.exitCode = 1;
  }
}
