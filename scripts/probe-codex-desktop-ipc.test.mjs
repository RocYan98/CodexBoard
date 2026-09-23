import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bridgeSocketPath } from "./codex-local-endpoint.mjs";
import { probeDesktopIpc } from "./probe-codex-desktop-ipc.mjs";

test("read-only probe sends only initialize and accepts fragmented length-prefixed replies", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-probe-"));
  const socketPath = bridgeSocketPath(directory);
  const requests = [];
  const server = createServer((socket) => {
    let input = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      input = Buffer.concat([input, chunk]);
      if (input.length < 4 || input.length < 4 + input.readUInt32LE()) return;
      const request = JSON.parse(input.subarray(4).toString());
      requests.push(request.method);
      const body = Buffer.from(
        JSON.stringify({
          type: "response",
          requestId: request.requestId,
          resultType: "success",
          result: { clientId: "private-client-identifier" },
        }),
      );
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32LE(body.length);
      socket.write(prefix.subarray(0, 2));
      socket.write(Buffer.concat([prefix.subarray(2), body]));
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const result = await probeDesktopIpc({ socketPath });
    assert.deepEqual(requests, ["initialize"]);
    assert.equal(result.initialized, true);
    assert.equal(result.framing, "uint32le-json");
    assert.doesNotMatch(JSON.stringify(result), /private-client-identifier/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("read-only probe failures are bounded and do not include native diagnostics", async () => {
  const socketPath = bridgeSocketPath(join(tmpdir(), `absent-${Date.now()}`));
  await assert.rejects(probeDesktopIpc({ socketPath, timeoutMs: 100 }), (error) => {
    assert.equal(error.message, "Codex Desktop IPC initialization failed");
    return true;
  });
});
