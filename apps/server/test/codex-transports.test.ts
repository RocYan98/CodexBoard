import { ensurePrivateFileSync } from "../../../scripts/private-file-permissions.mjs";
import { bridgeSocketPath, isWindowsPipePath } from "../../../scripts/codex-local-endpoint.mjs";
import { createServer, type Server } from "node:http";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  JsonlStreamTransport,
  TcpWebSocketTransport,
  UnixWebSocketTransport,
  type JsonRpcMessage,
} from "../src/modules/codex/index.js";

const servers: Server[] = [];
const socketDirectories: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of socketDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Codex transports", () => {
  it("allows loopback but rejects arbitrary TCP hosts", () => {
    expect(
      () =>
        new TcpWebSocketTransport({
          endpoint: "ws://127.0.0.1:47825",
          tokenFile: "/run/secrets/codex-token",
        }),
    ).not.toThrow();
    expect(
      () =>
        new TcpWebSocketTransport({
          endpoint: "ws://192.168.1.10:47825",
          tokenFile: "/run/secrets/codex-token",
        }),
    ).toThrow(/本机地址/);
  });

  it("frames stdio as JSONL across split chunks and closes on malformed input", async () => {
    const serverOutput = new PassThrough();
    const serverInput = new PassThrough();
    const transport = new JsonlStreamTransport({
      input: serverOutput,
      output: serverInput,
      description: "stdio-test",
    });
    const messages: unknown[] = [];
    const closed: Error[] = [];
    transport.onMessage((message) => messages.push(message));
    transport.onClose((error) => error && closed.push(error));
    await transport.connect();

    serverOutput.write('{"id":1,"res');
    serverOutput.write('ult":{"ok":true}}\n{"method":"turn/started","params":{}}\n');
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages).toEqual([
      { id: 1, result: { ok: true } },
      { method: "turn/started", params: {} },
    ]);

    await transport.send({ id: 2, method: "thread/read", params: { threadId: "thread-1" } });
    await vi.waitFor(() => expect(serverInput.readableLength).toBeGreaterThan(0));
    expect(serverInput.read()?.toString("utf8")).toBe(
      '{"id":2,"method":"thread/read","params":{"threadId":"thread-1"}}\n',
    );

    serverOutput.write("not-json\n");
    await vi.waitFor(() => expect(closed).toHaveLength(1));
    expect(closed[0]?.message).toMatch(/Invalid JSONL/);
    await transport.close();
  });

  it("uses one JSON-RPC message per WebSocket frame over a Unix socket", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexboard-ws-"));
    socketDirectories.push(directory);
    const socketPath = bridgeSocketPath(directory);
    const pipeToken = isWindowsPipePath(socketPath) ? "test-only-pipe-capability" : undefined;
    const server = createServer();
    servers.push(server);
    const webSocketServer = new WebSocketServer({ server });
    const receivedByServer: JsonRpcMessage[] = [];
    let requestedExtensions: string | undefined;
    let pipeAuthorization: string | undefined;
    webSocketServer.on("connection", (socket, request) => {
      pipeAuthorization = request.headers.authorization;
      requestedExtensions = request.headers["sec-websocket-extensions"];
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString("utf8")) as JsonRpcMessage;
        receivedByServer.push(message);
        socket.send(JSON.stringify({ id: 9, result: { ok: true } }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });

    const transport = new UnixWebSocketTransport({
      socketPath,
      ...(pipeToken ? { token: pipeToken } : {}),
    });
    const receivedByClient: unknown[] = [];
    transport.onMessage((message) => receivedByClient.push(message));
    await transport.connect();
    await transport.send({ id: 9, method: "thread/read", params: { threadId: "thread-1" } });

    await vi.waitFor(() => expect(receivedByServer).toHaveLength(1));
    await vi.waitFor(() => expect(receivedByClient).toHaveLength(1));
    expect(receivedByServer[0]).toEqual({
      id: 9,
      method: "thread/read",
      params: { threadId: "thread-1" },
    });
    expect(receivedByClient[0]).toEqual({ id: 9, result: { ok: true } });
    expect(requestedExtensions).toBeUndefined();
    expect(pipeAuthorization).toBe(pipeToken ? `Bearer ${pipeToken}` : undefined);
    await transport.close();
    await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
  });

  it("authenticates a loopback TCP WebSocket with a private capability token", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexboard-ws-token-"));
    socketDirectories.push(directory);
    const tokenFile = join(directory, "codex-token");
    writeFileSync(tokenFile, "capability-token\n", { mode: 0o600 });
    ensurePrivateFileSync(tokenFile);
    const server = createServer();
    servers.push(server);
    const webSocketServer = new WebSocketServer({ server });
    let authorization: string | undefined;
    let requestedExtensions: string | undefined;
    const receivedByServer: JsonRpcMessage[] = [];
    webSocketServer.on("connection", (socket, request) => {
      authorization = request.headers.authorization;
      requestedExtensions = request.headers["sec-websocket-extensions"];
      socket.on("message", (data) => {
        receivedByServer.push(JSON.parse(data.toString("utf8")) as JsonRpcMessage);
        socket.send(JSON.stringify({ id: 12, result: { ok: true } }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TCP test server did not bind");

    const transport = new TcpWebSocketTransport({
      endpoint: `ws://127.0.0.1:${address.port}`,
      tokenFile,
    });
    const receivedByClient: unknown[] = [];
    transport.onMessage((message) => receivedByClient.push(message));
    await transport.connect();
    await transport.send({ id: 12, method: "thread/read", params: { threadId: "thread-12" } });

    await vi.waitFor(() => expect(receivedByServer).toHaveLength(1));
    await vi.waitFor(() => expect(receivedByClient).toHaveLength(1));
    expect(authorization).toBe("Bearer capability-token");
    expect(requestedExtensions).toBeUndefined();
    expect(receivedByServer[0]).toEqual({
      id: 12,
      method: "thread/read",
      params: { threadId: "thread-12" },
    });
    await transport.close();
    await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
  });
});

it("requires authentication for a Windows named-pipe transport", () => {
  expect(() => new UnixWebSocketTransport({ socketPath: "\\\\.\\pipe\\codexboard-test" })).toThrow(
    /capability token/,
  );
});
