import { createHash } from "node:crypto";
import { join, win32 } from "node:path";

const pipePrefix = "\\\\.\\pipe\\";
const pipeName = /^[a-zA-Z0-9._-]+$/;

export function isWindowsPipePath(path) {
  return (
    typeof path === "string" &&
    path.startsWith(pipePrefix) &&
    pipeName.test(path.slice(pipePrefix.length))
  );
}

export function desktopIpcPath(codexHome, platform = process.platform) {
  return platform === "win32" ? `${pipePrefix}codex-ipc` : join(codexHome, "ipc", "ipc.sock");
}

// This is CodexBoard's authenticated bridge, not Desktop's owner/follower IPC.
export function bridgeSocketPath(dataDirectory, platform = process.platform) {
  if (platform !== "win32") return join(dataDirectory, "codex-app-server.sock");
  const identity = win32.resolve(dataDirectory).toLowerCase();
  return `${pipePrefix}codexboard-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

export function localEndpoint(path) {
  return isWindowsPipePath(path)
    ? `npipe://./pipe/${path.slice(pipePrefix.length)}`
    : `unix://${path}`;
}

export function localEndpointPath(endpoint) {
  if (endpoint.startsWith("unix://") && endpoint.length > 7) return endpoint.slice(7);
  const prefix = "npipe://./pipe/";
  if (endpoint.startsWith(prefix) && pipeName.test(endpoint.slice(prefix.length)))
    return `${pipePrefix}${endpoint.slice(prefix.length)}`;
  throw new Error("Invalid local IPC endpoint");
}
