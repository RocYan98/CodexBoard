import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import {
  bridgeSocketPath,
  desktopIpcPath,
  isWindowsPipePath,
  localEndpoint,
  localEndpointPath,
} from "./codex-local-endpoint.mjs";

test("Desktop and the authenticated bridge use distinct Windows named pipes", () => {
  const desktop = desktopIpcPath("C:\\Users\\Yan\\.codex", "win32");
  const bridge = bridgeSocketPath("C:\\Users\\Yan\\AppData\\Local\\CodexBoard\\data", "win32");
  assert.equal(desktop, "\\\\.\\pipe\\codex-ipc");
  assert.match(bridge, /^\\\\\.\\pipe\\codexboard-[a-f0-9]{24}$/);
  assert.notEqual(bridge, desktop);
  assert.equal(
    bridge,
    bridgeSocketPath("c:\\users\\yan\\AppData\\Local\\CodexBoard\\data", "win32"),
  );
  assert.notEqual(bridge, bridgeSocketPath("C:\\Users\\Other\\CodexBoard\\data", "win32"));
  assert.equal(localEndpointPath(localEndpoint(bridge)), bridge);
});

test("POSIX paths stay unchanged and pipe URLs cannot target remote hosts or alternate paths", () => {
  const path = join("/tmp", "data", "codex-app-server.sock");
  assert.equal(bridgeSocketPath("/tmp/data", "darwin"), path);
  assert.equal(desktopIpcPath("/tmp/codex", "darwin"), join("/tmp/codex", "ipc", "ipc.sock"));
  assert.equal(localEndpointPath(localEndpoint(path)), path);
  for (const endpoint of [
    "npipe://other/pipe/test",
    "npipe://./pipe/",
    "npipe://./pipe/a/b",
    "npipe://./pipe/a?b",
    "ws://127.0.0.1:80",
  ]) {
    assert.throws(() => localEndpointPath(endpoint));
  }
  assert.equal(isWindowsPipePath("\\\\other\\pipe\\name"), false);
});
