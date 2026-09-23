import { describe, expect, it, vi } from "vitest";

import {
  CodexJsonRpcClient,
  CodexProtocolError,
  type CodexTransport,
  type JsonRpcMessage,
} from "../src/modules/codex/index.js";

class FakeTransport implements CodexTransport {
  readonly description = "fake";
  readonly sent: JsonRpcMessage[] = [];
  #messageListeners = new Set<(message: unknown) => void>();
  #closeListeners = new Set<(error?: Error) => void>();

  async connect(): Promise<void> {}

  async send(message: JsonRpcMessage): Promise<void> {
    this.sent.push(message);
  }

  async close(): Promise<void> {
    this.disconnect();
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  receive(message: unknown): void {
    for (const listener of this.#messageListeners) {
      listener(message);
    }
  }

  disconnect(error?: Error): void {
    for (const listener of this.#closeListeners) {
      listener(error);
    }
  }
}

async function waitForSent(transport: FakeTransport, count: number): Promise<void> {
  await vi.waitFor(() => expect(transport.sent).toHaveLength(count));
}

describe("Codex JSON-RPC client", () => {
  it("handshakes once and correlates out-of-order responses", async () => {
    const transport = new FakeTransport();
    const client = new CodexJsonRpcClient({ transport, requestTimeoutMs: 1_000 });
    const connecting = client.connect();
    await waitForSent(transport, 1);
    expect(transport.sent[0]).toMatchObject({ method: "initialize", id: 1 });
    transport.receive({
      id: 1,
      result: { userAgent: "codex-test", codexHome: "/Users/test/.codex" },
    });
    await connecting;
    expect(client.codexHome).toBe("/Users/test/.codex");
    expect(transport.sent[1]).toEqual({ method: "initialized", params: {} });

    const first = client.request("thread/start", { cwd: "/workspace" });
    const second = client.request("thread/resume", { threadId: "thread-1" });
    await waitForSent(transport, 4);
    const firstId = (transport.sent[2] as { id: number }).id;
    const secondId = (transport.sent[3] as { id: number }).id;
    transport.receive({ id: secondId, result: { thread: { id: "thread-1" } } });
    transport.receive({ id: firstId, result: { thread: { id: "thread-2" } } });

    await expect(first).resolves.toEqual({ thread: { id: "thread-2" } });
    await expect(second).resolves.toEqual({ thread: { id: "thread-1" } });
    await client.close();
  });

  it("emits notifications, exposes supported Server Requests and fails unknown ones closed", async () => {
    const transport = new FakeTransport();
    const notifications: unknown[] = [];
    const serverRequests: unknown[] = [];
    const client = new CodexJsonRpcClient({ transport, requestTimeoutMs: 1_000 });
    client.onNotification((notification) => notifications.push(notification));
    client.onServerRequest(async (request) => {
      serverRequests.push({ id: request.id, method: request.method, params: request.params });
      await request.respond({ decision: "decline" });
    });

    const connecting = client.connect();
    await waitForSent(transport, 1);
    transport.receive({ id: 1, result: {} });
    await connecting;
    transport.receive({ method: "turn/started", params: { turn: { id: "turn-1" } } });
    transport.receive({
      id: 80,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" },
    });
    await waitForSent(transport, 3);

    expect(notifications).toEqual([{ method: "turn/started", params: { turn: { id: "turn-1" } } }]);
    expect(serverRequests).toEqual([
      {
        id: 80,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" },
      },
    ]);
    expect(transport.sent[2]).toEqual({ id: 80, result: { decision: "decline" } });

    client.clearServerRequestHandler();
    transport.receive({ id: 81, method: "unknown/approval", params: {} });
    await waitForSent(transport, 4);
    expect(transport.sent[3]).toEqual({
      id: 81,
      error: { code: -32601, message: "Unsupported server request: unknown/approval" },
    });
    await client.close();
  });

  it("rejects pending requests on disconnect, times out and reports illegal messages", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      const protocolErrors: CodexProtocolError[] = [];
      const client = new CodexJsonRpcClient({ transport, requestTimeoutMs: 100 });
      client.onProtocolError((error) => protocolErrors.push(error));
      const connecting = client.connect();
      await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
      transport.receive({ id: 1, result: {} });
      await connecting;

      const timedOut = client.request("thread/read", { threadId: "thread-1" });
      const timeoutAssertion = expect(timedOut).rejects.toThrow(/timed out/);
      const largeRead = client.request("taskboard/remote/read", { threadId: "old" }, 500);
      const largeReadId = (transport.sent.at(-1) as { id: number }).id;
      await vi.advanceTimersByTimeAsync(101);
      await timeoutAssertion;
      transport.receive({ id: largeReadId, result: { id: "old" } });
      await expect(largeRead).resolves.toEqual({ id: "old" });

      transport.receive({ hello: "world" });
      expect(protocolErrors).toHaveLength(1);
      expect(protocolErrors[0]).toBeInstanceOf(CodexProtocolError);

      const interrupted = client.request("thread/read", { threadId: "thread-2" });
      const disconnectAssertion = expect(interrupted).rejects.toThrow(/socket closed/);
      transport.disconnect(new Error("socket closed"));
      await disconnectAssertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("repeats the handshake once after a transport disconnect", async () => {
    const transport = new FakeTransport();
    const protocolErrors: CodexProtocolError[] = [];
    const client = new CodexJsonRpcClient({ transport, requestTimeoutMs: 1_000 });
    client.onProtocolError((error) => protocolErrors.push(error));
    const firstConnect = client.connect();
    await waitForSent(transport, 1);
    transport.receive({ id: 1, result: { codexHome: "/Users/first/.codex" } });
    await firstConnect;
    expect(client.codexHome).toBe("/Users/first/.codex");

    transport.disconnect(new Error("temporary disconnect"));
    expect(client.codexHome).toBeUndefined();
    const reconnect = client.connect();
    await waitForSent(transport, 3);
    expect(transport.sent[2]).toMatchObject({ id: 2, method: "initialize" });
    transport.receive({ id: 2, result: { codexHome: "/Users/second/.codex" } });
    await reconnect;
    expect(client.codexHome).toBe("/Users/second/.codex");

    const request = client.request("thread/read", { threadId: "thread-1" });
    await waitForSent(transport, 5);
    transport.receive({ id: 3, result: { thread: { id: "thread-1" } } });
    await expect(request).resolves.toEqual({ thread: { id: "thread-1" } });
    expect(protocolErrors).toEqual([]);
    await client.close();
  });
});
