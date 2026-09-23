import { describe, expect, it, vi } from "vitest";

import {
  CodexJsonRpcClient,
  type CodexTransport,
  type JsonRpcMessage,
} from "../src/modules/codex/index.js";
import { AppServerCodexExecutor } from "../src/modules/execution/index.js";

class FakeTransport implements CodexTransport {
  readonly description = "executor-fake";
  readonly sent: JsonRpcMessage[] = [];
  readonly #messageListeners = new Set<(message: unknown) => void>();
  readonly #closeListeners = new Set<(error?: Error) => void>();

  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async send(message: JsonRpcMessage): Promise<void> {
    this.sent.push(message);
    if ("method" in message && "id" in message && message.method === "thread/unsubscribe") {
      queueMicrotask(() => this.receive({ id: message.id, result: { status: "unsubscribed" } }));
    }
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
    for (const listener of this.#messageListeners) listener(message);
  }
}

async function waitForMessage(transport: FakeTransport, index: number): Promise<JsonRpcMessage> {
  await vi.waitFor(() => expect(transport.sent.length).toBeGreaterThan(index));
  return transport.sent[index]!;
}

describe("read-only outcome recovery", () => {
  it.each(["exact", "client-id", "running", "wrong-turn", "wrong-thread", "no-client-id"])(
    "reads only the identified terminal turn: %s",
    async (mode) => {
      const transport = new FakeTransport();
      const client = new CodexJsonRpcClient({ transport, requestTimeoutMs: 1000 });
      const executor = new AppServerCodexExecutor(client);
      const reading = executor.readOutcome({
        jobId: "job",
        threadId: "thread",
        ...(["client-id", "no-client-id"].includes(mode) ? {} : { turnId: "original" }),
      });
      const initialize = (await waitForMessage(transport, 0)) as { id: number };
      transport.receive({ id: initialize.id, result: {} });
      const read = (await waitForMessage(transport, 2)) as { id: number };
      expect(read).toMatchObject({
        method: "thread/read",
        params: { threadId: "thread", includeTurns: true },
      });
      transport.receive({
        id: read.id,
        result: {
          thread: {
            id: mode === "wrong-thread" ? "other" : "thread",
            turns: [
              {
                id: mode === "wrong-turn" ? "other" : "original",
                status: mode === "running" ? "inProgress" : "completed",
                items: [
                  { type: "userMessage", clientId: mode === "no-client-id" ? "other-job" : "job" },
                  { id: "progress", type: "agentMessage", phase: "commentary", text: "progress" },
                  {
                    id: "answer",
                    type: "agentMessage",
                    phase: "final_answer",
                    text: "full result",
                  },
                ],
              },
              { id: "newer", status: "inProgress", items: [] },
            ],
          },
        },
      });
      const result = await reading;
      if (["exact", "client-id"].includes(mode))
        expect(result).toMatchObject({
          turnId: "original",
          status: "completed",
          events: [
            {
              cursor: "original:item/completed:answer",
              safePayload: { text: "full result", phase: "final_answer" },
            },
          ],
        });
      else expect(result).toBeNull();
      expect(
        transport.sent.filter(
          (message) => "method" in message && /thread\/(resume|start)|turn\//.test(message.method),
        ),
      ).toHaveLength(0);
      await client.close();
    },
  );
});

describe("App Server Codex executor", () => {
  it.each([true, false])(
    "stops waiting without retry when Desktop loses the turn stream (early=%s)",
    async (early) => {
      const transport = new FakeTransport();
      const client = new CodexJsonRpcClient({ transport, requestTimeoutMs: 1000 });
      const executor = new AppServerCodexExecutor(client);
      const running = executor.start(
        { jobId: "lost", cwd: "/recent", prompt: "test" },
        {
          onThread() {},
          onTurn() {},
          onEvent() {},
          onInteraction: async () => ({ type: "decline" }),
        },
      );
      const initialized = (await waitForMessage(transport, 0)) as { id: number };
      transport.receive({ id: initialized.id, result: {} });
      const start = (await waitForMessage(transport, 2)) as { id: number };
      transport.receive({ id: start.id, result: { thread: { id: "thread-lost" } } });
      const turn = (await waitForMessage(transport, 3)) as { id: number };
      transport.receive({ id: turn.id, result: { turn: { id: "turn-lost" } } });
      if (!early) await new Promise((resolve) => setTimeout(resolve, 0));
      transport.receive({
        method: "taskboard/sessionLost",
        params: { threadId: "thread-lost", turnId: "turn-lost" },
      });
      await expect(
        Promise.race([
          running,
          new Promise((_, reject) => setTimeout(() => reject(new Error("hung")), 300)),
        ]),
      ).rejects.toMatchObject({ code: -32003 });
      await client.close();
    },
  );

  it("creates a temporary draft in its own host workspace instead of inheriting the server project", async () => {
    const transport = new FakeTransport();
    const client = new CodexJsonRpcClient({ transport, requestTimeoutMs: 1_000 });
    const executor = new AppServerCodexExecutor(client, "/Users/test/Documents/Codex");
    const creating = executor.createDraft({ cwd: null, name: "SYS-TEMP-1 临时任务" });

    const initialize = (await waitForMessage(transport, 0)) as { id: number };
    transport.receive({ id: initialize.id, result: { codexHome: "/custom/codex-home" } });
    const mkdir = (await waitForMessage(transport, 2)) as {
      id: number;
      method: string;
      params: { path: string; recursive: boolean };
    };
    expect(mkdir.method).toBe("fs/createDirectory");
    expect(mkdir.params.path.replaceAll("\\", "/")).toMatch(
      /^\/Users\/test\/Documents\/Codex\/\d{4}-\d{2}-\d{2}\/task-[a-f0-9-]{36}$/,
    );
    expect(mkdir.params.recursive).toBe(true);
    transport.receive({ id: mkdir.id, result: {} });
    const threadStart = (await waitForMessage(transport, 3)) as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    for (const key of ["approvalPolicy", "approvalsReviewer", "sandbox", "sandboxPolicy"])
      expect(threadStart.params).not.toHaveProperty(key);
    expect(threadStart).toMatchObject({
      method: "thread/start",
      params: {
        cwd: mkdir.params.path,
        ephemeral: false,
      },
    });
    transport.receive({
      id: threadStart.id,
      result: { thread: { id: "thread-draft" }, cwd: mkdir.params.path },
    });
    const setName = (await waitForMessage(transport, 4)) as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    expect(setName).toMatchObject({
      method: "thread/name/set",
      params: { threadId: "thread-draft", name: "SYS-TEMP-1 临时任务" },
    });
    transport.receive({ id: setName.id, result: {} });

    await expect(creating).resolves.toEqual({
      threadId: "thread-draft",
      cwd: mkdir.params.path,
    });
    expect(transport.sent).toContainEqual(
      expect.objectContaining({
        method: "thread/unsubscribe",
        params: { threadId: "thread-draft" },
      }),
    );
    expect(
      transport.sent.some((message) => "method" in message && message.method === "turn/start"),
    ).toBe(false);
    await client.close();
  });

  it("does not create a temporary Thread if the host workspace cannot be created", async () => {
    const transport = new FakeTransport();
    const client = new CodexJsonRpcClient({ transport, requestTimeoutMs: 1_000 });
    const executor = new AppServerCodexExecutor(client, "/Users/test/Documents/Codex");
    const creating = executor.createDraft({ cwd: null, name: "TEMP-001 test" });
    const rejected = expect(creating).rejects.toThrow("permission denied");
    const initialize = (await waitForMessage(transport, 0)) as { id: number };
    transport.receive({ id: initialize.id, result: { codexHome: "/custom/codex-home" } });
    const mkdir = (await waitForMessage(transport, 2)) as { id: number; method: string };
    expect(mkdir.method).toBe("fs/createDirectory");
    transport.receive({ id: mkdir.id, error: { code: -32603, message: "permission denied" } });
    await rejected;
    expect(transport.sent.some((m) => "method" in m && m.method === "thread/start")).toBe(false);
    await client.close();
  });

  it("refuses to create a temporary draft without a configured host root", async () => {
    const transport = new FakeTransport();
    const client = new CodexJsonRpcClient({ transport, requestTimeoutMs: 1_000 });
    const executor = new AppServerCodexExecutor(client);
    const creating = executor.createDraft({ cwd: null, name: "TEMP-001 test" });
    const rejected = expect(creating).rejects.toThrow("临时项目根目录");
    const initialize = (await waitForMessage(transport, 0)) as { id: number };
    transport.receive({ id: initialize.id, result: {} });
    await rejected;
    expect(transport.sent.some((m) => "method" in m && m.method === "thread/start")).toBe(false);
    await client.close();
  });

  it.each(["valid", "model", "effort", "tier", "hidden"])(
    "validates draft model settings (%s)",
    async (variant) => {
      const transport = new FakeTransport();
      const client = new CodexJsonRpcClient({ transport, requestTimeoutMs: 1000 });
      const executor = new AppServerCodexExecutor(client);
      const modelOptions = {
        model: variant === "model" ? "missing" : "test-model",
        effort: variant === "effort" ? "ultra" : "high",
        serviceTier: variant === "tier" ? "missing" : "priority",
      };
      const creating = executor.createDraft({
        cwd: "/workspace/project",
        name: "TASK-1 模型",
        modelOptions,
      });
      const outcome = creating.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      const initialize = (await waitForMessage(transport, 0)) as { id: number };
      transport.receive({ id: initialize.id, result: {} });
      const list = (await waitForMessage(transport, 2)) as { id: number };
      expect(list).toMatchObject({ method: "model/list" });
      transport.receive({
        id: list.id,
        result: {
          data: [
            {
              model: "test-model",
              displayName: "Test",
              hidden: variant === "hidden",
              supportedReasoningEfforts: [{ reasoningEffort: "high" }],
              defaultReasoningEffort: "high",
              serviceTiers: [{ id: "priority", name: "Fast" }],
            },
          ],
        },
      });
      if (variant !== "valid") {
        expect((await outcome).error).toMatchObject({ message: expect.stringContaining("不可用") });
        expect(transport.sent.some((m) => "method" in m && m.method === "thread/start")).toBe(
          false,
        );
      } else {
        const start = (await waitForMessage(transport, 3)) as { id: number };
        expect(start).toMatchObject({
          method: "thread/start",
          params: {
            model: "test-model",
            serviceTier: "priority",
            config: { model_reasoning_effort: "high" },
          },
        });
        transport.receive({
          id: start.id,
          result: { thread: { id: "selected" }, cwd: "/workspace/project" },
        });
        const name = (await waitForMessage(transport, 4)) as { id: number };
        transport.receive({ id: name.id, result: {} });
        expect((await outcome).value).toMatchObject({ threadId: "selected" });
      }
      await client.close();
    },
  );

  it("archives a newly created draft Thread when naming fails", async () => {
    const transport = new FakeTransport();
    const client = new CodexJsonRpcClient({ transport, requestTimeoutMs: 1_000 });
    const executor = new AppServerCodexExecutor(client);
    const creating = executor.createDraft({ cwd: "/workspace/project", name: "TASK-1 任务" });

    const initialize = (await waitForMessage(transport, 0)) as { id: number };
    transport.receive({ id: initialize.id, result: {} });
    const threadStart = (await waitForMessage(transport, 2)) as { id: number };
    transport.receive({
      id: threadStart.id,
      result: { thread: { id: "thread-orphan" }, cwd: "/workspace/project" },
    });
    const setName = (await waitForMessage(transport, 3)) as { id: number };
    transport.receive({ id: setName.id, error: { code: -32_603, message: "name failed" } });
    const archive = (await waitForMessage(transport, 4)) as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    expect(archive).toMatchObject({
      method: "thread/archive",
      params: { threadId: "thread-orphan" },
    });
    transport.receive({ id: archive.id, result: {} });

    await expect(creating).rejects.toThrow("name failed");
    await client.close();
  });

  it("uses reviewed start/turn methods, normalizes events and never grants session approval", async () => {
    const transport = new FakeTransport();
    const client = new CodexJsonRpcClient({ transport, requestTimeoutMs: 1_000 });
    const executor = new AppServerCodexExecutor(client);
    const threads: string[] = [];
    const turns: string[] = [];
    const events: unknown[] = [];
    const running = executor.start(
      { jobId: "job-real", cwd: "/workspace/project", prompt: "完成任务" },
      {
        onThread: (id) => threads.push(id),
        onTurn: (id) => turns.push(id),
        onEvent: (event) => events.push(event),
        onInteraction: async () => ({ type: "accept" }),
      },
    );

    const initialize = (await waitForMessage(transport, 0)) as { id: number; method: string };
    transport.receive({ id: initialize.id, result: {} });
    const threadStart = (await waitForMessage(transport, 2)) as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    for (const key of ["approvalPolicy", "approvalsReviewer", "sandbox", "sandboxPolicy"])
      expect(threadStart.params).not.toHaveProperty(key);
    expect(threadStart).toMatchObject({
      method: "thread/start",
      params: {
        cwd: "/workspace/project",
        ephemeral: false,
      },
    });
    transport.receive({ id: threadStart.id, result: { thread: { id: "thread-real" } } });
    const turnStart = (await waitForMessage(transport, 3)) as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    for (const key of ["approvalPolicy", "approvalsReviewer", "sandbox", "sandboxPolicy"])
      expect(turnStart.params).not.toHaveProperty(key);
    expect(turnStart).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "thread-real",
        cwd: "/workspace/project",
        clientUserMessageId: "job-real",
        input: [{ type: "text", text: "完成任务", text_elements: [] }],
      },
    });
    transport.receive({ id: turnStart.id, result: { turn: { id: "turn-real" } } });
    transport.receive({
      id: 80,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-real", turnId: "turn-real", command: "npm test" },
    });
    expect(await waitForMessage(transport, 4)).toEqual({ id: 80, result: { decision: "accept" } });
    transport.receive({
      method: "item/completed",
      params: {
        threadId: "thread-real",
        turnId: "turn-real",
        item: {
          id: "message-1",
          type: "agentMessage",
          phase: "final_answer",
          text: "已完成" + "长内容".repeat(1000),
        },
      },
    });
    transport.receive({
      method: "error",
      params: {
        threadId: "thread-real",
        turnId: "turn-real",
        code: 503,
        message: "socket /Users/secret/private/codex.sock leaked Bearer very-secret-token",
      },
    });
    transport.receive({
      method: "turn/completed",
      params: {
        threadId: "thread-real",
        turn: { id: "turn-real", status: "completed", error: null },
      },
    });

    await expect(running).resolves.toEqual({
      threadId: "thread-real",
      turnId: "turn-real",
      status: "completed",
    });
    expect(transport.sent).toContainEqual(
      expect.objectContaining({
        method: "thread/unsubscribe",
        params: { threadId: "thread-real" },
      }),
    );
    expect(threads).toEqual(["thread-real"]);
    expect(turns).toEqual(["turn-real"]);
    expect(events).toEqual([
      expect.objectContaining({
        kind: "codex.agent_message",
        safePayload: { text: "已完成" + "长内容".repeat(1000), phase: "final_answer" },
      }),
      expect.objectContaining({
        kind: "codex.error",
        summary: "Codex 执行报告错误（代码 503）",
        safePayload: { code: 503 },
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("/Users/secret/private");
    expect(JSON.stringify(events)).not.toContain("very-secret-token");
    expect(JSON.stringify(transport.sent)).not.toContain("acceptForSession");
    await client.close();
  });

  it.each(["completed", "failed", "interrupted", "start-error"] as const)(
    "releases the thread after %s, including immediate completion",
    async (status) => {
      const transport = new FakeTransport();
      const client = new CodexJsonRpcClient({ transport, requestTimeoutMs: 1000 });
      const executor = new AppServerCodexExecutor(client);
      const running = executor.continue(
        {
          jobId: "test",
          threadId: "thread-test",
          cwd: "/workspace",
          prompt: "test",
          modelOptions: { model: "test-model", effort: "high", serviceTier: null },
        },
        {
          onThread() {},
          onTurn() {},
          onEvent() {},
          onInteraction: async () => ({ type: "decline" }),
        },
      );
      const outcome = running.then(
        (result) => ({ status: result.status }),
        (error) => ({ error: error.message }),
      );
      const initialize = (await waitForMessage(transport, 0)) as { id: number };
      transport.receive({ id: initialize.id, result: {} });
      const resume = (await waitForMessage(transport, 2)) as {
        id: number;
        params: Record<string, unknown>;
      };
      for (const key of ["approvalPolicy", "approvalsReviewer", "sandbox", "sandboxPolicy"])
        expect(resume.params).not.toHaveProperty(key);
      transport.receive({ id: resume.id, result: { thread: { id: "thread-test" } } });
      const start = (await waitForMessage(transport, 3)) as {
        id: number;
        params: Record<string, unknown>;
      };
      for (const key of ["approvalPolicy", "approvalsReviewer", "sandbox", "sandboxPolicy"])
        expect(start.params).not.toHaveProperty(key);
      expect(start).toMatchObject({
        method: "turn/start",
        params: { model: "test-model", effort: "high", serviceTier: null },
      });
      expect(transport.sent.some((m) => "method" in m && m.method === "thread/unsubscribe")).toBe(
        false,
      );
      if (status === "start-error")
        transport.receive({ id: start.id, error: { code: -32603, message: "start failed" } });
      else {
        transport.receive({ id: start.id, result: { turn: { id: "turn-test" } } });
        transport.receive({
          method: "turn/completed",
          params: { threadId: "thread-test", turn: { id: "turn-test", status } },
        });
      }
      await vi.waitFor(() =>
        expect(transport.sent).toContainEqual(
          expect.objectContaining({
            method: "thread/unsubscribe",
            params: { threadId: "thread-test" },
          }),
        ),
      );
      expect(await outcome).toEqual(
        status === "start-error" ? { error: "start failed" } : { status },
      );
      await client.close();
    },
  );

  it("waits for the final interrupted notification after turn/interrupt", async () => {
    const transport = new FakeTransport();
    const client = new CodexJsonRpcClient({ transport, requestTimeoutMs: 1_000 });
    const executor = new AppServerCodexExecutor(client);
    const connecting = client.connect();
    const initialize = (await waitForMessage(transport, 0)) as { id: number };
    transport.receive({ id: initialize.id, result: {} });
    await connecting;

    const interrupted = executor.interrupt("thread-1", "turn-1");
    const resume = (await waitForMessage(transport, 2)) as {
      id: number;
      params: { threadId: string };
    };
    expect(resume).toMatchObject({ method: "thread/resume" });
    transport.receive({ id: resume.id, result: { thread: { id: resume.params.threadId } } });
    const request = (await waitForMessage(transport, 3)) as { id: number; method: string };
    expect(request.method).toBe("turn/interrupt");
    transport.receive({ id: request.id, result: {} });
    let settled = false;
    void interrupted.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    transport.receive({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } },
    });
    await expect(interrupted).resolves.toBeUndefined();
    await client.close();
  });

  it("treats an already terminal turn as an idempotent interrupt", async () => {
    const transport = new FakeTransport();
    const client = new CodexJsonRpcClient({ transport, requestTimeoutMs: 1_000 });
    const executor = new AppServerCodexExecutor(client);
    const connecting = client.connect();
    const initialize = (await waitForMessage(transport, 0)) as { id: number };
    transport.receive({ id: initialize.id, result: {} });
    await connecting;

    const interrupted = executor.interrupt("thread-finished", "turn-finished");
    const resume = (await waitForMessage(transport, 2)) as {
      id: number;
      params: { threadId: string };
    };
    expect(resume).toMatchObject({ method: "thread/resume" });
    transport.receive({ id: resume.id, result: { thread: { id: resume.params.threadId } } });
    const request = (await waitForMessage(transport, 3)) as { id: number; method: string };
    expect(request.method).toBe("turn/interrupt");
    transport.receive({
      id: request.id,
      error: { code: -32602, message: "no active turn to interrupt" },
    });

    await expect(interrupted).resolves.toBeUndefined();
    await client.close();
  });

  it("does not hide a different JSON-RPC error that reuses the terminal-turn message", async () => {
    const transport = new FakeTransport();
    const client = new CodexJsonRpcClient({ transport, requestTimeoutMs: 1_000 });
    const executor = new AppServerCodexExecutor(client);
    const connecting = client.connect();
    const initialize = (await waitForMessage(transport, 0)) as { id: number };
    transport.receive({ id: initialize.id, result: {} });
    await connecting;

    const interrupted = executor.interrupt("thread-error", "turn-error");
    const resume = (await waitForMessage(transport, 2)) as {
      id: number;
      params: { threadId: string };
    };
    expect(resume).toMatchObject({ method: "thread/resume" });
    transport.receive({ id: resume.id, result: { thread: { id: resume.params.threadId } } });
    const request = (await waitForMessage(transport, 3)) as { id: number };
    transport.receive({
      id: request.id,
      error: { code: -32_603, message: "no active turn to interrupt" },
    });

    await expect(interrupted).rejects.toMatchObject({ code: -32_603 });
    await client.close();
  });

  it("does not hide a longer invalid-params error that only contains the terminal-turn text", async () => {
    const transport = new FakeTransport();
    const client = new CodexJsonRpcClient({ transport, requestTimeoutMs: 1_000 });
    const executor = new AppServerCodexExecutor(client);
    const connecting = client.connect();
    const initialize = (await waitForMessage(transport, 0)) as { id: number };
    transport.receive({ id: initialize.id, result: {} });
    await connecting;

    const interrupted = executor.interrupt("thread-error", "turn-error");
    const resume = (await waitForMessage(transport, 2)) as {
      id: number;
      params: { threadId: string };
    };
    expect(resume).toMatchObject({ method: "thread/resume" });
    transport.receive({ id: resume.id, result: { thread: { id: resume.params.threadId } } });
    const request = (await waitForMessage(transport, 3)) as { id: number };
    transport.receive({
      id: request.id,
      error: {
        code: -32_602,
        message: "validation failed: no active turn to interrupt for mismatched thread",
      },
    });

    await expect(interrupted).rejects.toMatchObject({ code: -32_602 });
    await client.close();
  });

  it("settles the active execution when interrupt reports that the turn already ended", async () => {
    const transport = new FakeTransport();
    const client = new CodexJsonRpcClient({ transport, requestTimeoutMs: 1_000 });
    const executor = new AppServerCodexExecutor(client);
    const running = executor.start(
      { jobId: "job-raced", cwd: "/workspace/project", prompt: "等待取消" },
      {
        onThread() {},
        onTurn() {},
        onEvent() {},
        onInteraction: async () => ({ type: "decline" }),
      },
    );

    const initialize = (await waitForMessage(transport, 0)) as { id: number };
    transport.receive({ id: initialize.id, result: {} });
    const threadStart = (await waitForMessage(transport, 2)) as { id: number };
    transport.receive({ id: threadStart.id, result: { thread: { id: "thread-raced" } } });
    const turnStart = (await waitForMessage(transport, 3)) as { id: number };
    transport.receive({ id: turnStart.id, result: { turn: { id: "turn-raced" } } });

    const interrupted = executor.interrupt("thread-raced", "turn-raced");
    const interruptRequest = (await waitForMessage(transport, 4)) as { id: number };
    transport.receive({
      id: interruptRequest.id,
      error: { code: -32602, message: "no active turn to interrupt" },
    });

    await expect(interrupted).resolves.toBeUndefined();
    await expect(running).resolves.toMatchObject({ status: "interrupted" });
    await client.close();
  });

  it("settles both the active execution and interrupt waiters for the same turn", async () => {
    const transport = new FakeTransport();
    const client = new CodexJsonRpcClient({ transport, requestTimeoutMs: 1_000 });
    const executor = new AppServerCodexExecutor(client);
    const running = executor.start(
      { jobId: "job-interrupted", cwd: "/workspace/project", prompt: "继续任务" },
      {
        onThread() {},
        onTurn() {},
        onEvent() {},
        onInteraction: async () => ({ type: "decline" }),
      },
    );

    const initialize = (await waitForMessage(transport, 0)) as { id: number };
    transport.receive({ id: initialize.id, result: {} });
    const threadStart = (await waitForMessage(transport, 2)) as { id: number };
    transport.receive({ id: threadStart.id, result: { thread: { id: "thread-shared" } } });
    const turnStart = (await waitForMessage(transport, 3)) as { id: number };
    transport.receive({ id: turnStart.id, result: { turn: { id: "turn-shared" } } });

    const interrupted = executor.interrupt("thread-shared", "turn-shared");
    const interruptRequest = (await waitForMessage(transport, 4)) as {
      id: number;
      method: string;
    };
    expect(interruptRequest.method).toBe("turn/interrupt");
    transport.receive({ id: interruptRequest.id, result: {} });
    transport.receive({
      method: "turn/completed",
      params: {
        threadId: "thread-shared",
        turn: { id: "turn-shared", status: "interrupted", error: null },
      },
    });

    await expect(interrupted).resolves.toBeUndefined();
    await expect(running).resolves.toEqual({
      threadId: "thread-shared",
      turnId: "turn-shared",
      status: "interrupted",
    });
    await client.close();
  });
  it("reports an unknown outcome when the accepted turn response cannot be parsed", async () => {
    const transport = new FakeTransport();
    const client = new CodexJsonRpcClient({ transport, requestTimeoutMs: 1000 });
    const executor = new AppServerCodexExecutor(client);
    const running = executor
      .start(
        { jobId: "malformed", cwd: "/recent", prompt: "task" },
        {
          onThread() {},
          onTurn() {},
          onEvent() {},
          onInteraction: async () => ({ type: "decline" }),
        },
      )
      .catch((error: unknown) => error);
    const initialize = (await waitForMessage(transport, 0)) as { id: number };
    transport.receive({ id: initialize.id, result: {} });
    const thread = (await waitForMessage(transport, 2)) as { id: number };
    transport.receive({ id: thread.id, result: { thread: { id: "thread-malformed" } } });
    const turn = (await waitForMessage(transport, 3)) as { id: number };
    transport.receive({ id: turn.id, result: { accepted: true } });
    expect(await running).toMatchObject({ code: -32003 });
    await client.close();
  });
  it.each([true, false])(
    "isolates old-turn events, session loss and approvals before/after the response (early=%s)",
    async (early) => {
      const transport = new FakeTransport();
      const client = new CodexJsonRpcClient({ transport, requestTimeoutMs: 1000 });
      const executor = new AppServerCodexExecutor(client);
      const events: unknown[] = [];
      const interactions: unknown[] = [];
      const running = executor
        .continue(
          { jobId: "new-job", threadId: "shared", cwd: "/tmp", prompt: "new" },
          {
            onThread() {},
            onTurn() {},
            onEvent(event) {
              events.push(event);
            },
            onInteraction: async (request) => {
              interactions.push(request.params);
              return { type: "accept" };
            },
          },
        )
        .catch((error: unknown) => error);
      const initialize = (await waitForMessage(transport, 0)) as { id: number };
      transport.receive({ id: initialize.id, result: {} });
      const resume = (await waitForMessage(transport, 2)) as { id: number };
      transport.receive({ id: resume.id, result: { thread: { id: "shared" } } });
      const start = (await waitForMessage(transport, 3)) as { id: number };
      if (!early) {
        transport.receive({ id: start.id, result: { turn: { id: "new-turn" } } });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      transport.receive({
        method: "item/completed",
        params: {
          threadId: "shared",
          turnId: "old-turn",
          item: { id: "stale", type: "agentMessage", text: "old" },
        },
      });
      transport.receive({
        id: 801,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "shared", turnId: "old-turn", command: "old" },
      });
      transport.receive({
        method: "taskboard/sessionLost",
        params: { threadId: "shared", turnId: "old-turn" },
      });
      transport.receive({
        method: "item/completed",
        params: {
          threadId: "shared",
          turnId: "new-turn",
          item: { id: "fresh", type: "agentMessage", text: "new" },
        },
      });
      if (early) transport.receive({ id: start.id, result: { turn: { id: "new-turn" } } });
      transport.receive({
        method: "turn/completed",
        params: { threadId: "shared", turn: { id: "new-turn", status: "completed" } },
      });
      expect(await running).toMatchObject({ status: "completed", turnId: "new-turn" });
      expect(events).toEqual([expect.objectContaining({ summary: "new" })]);
      expect(interactions).toEqual([]);
      expect(transport.sent).toContainEqual(
        expect.objectContaining({ id: 801, error: expect.objectContaining({ code: -32602 }) }),
      );
      await client.close();
    },
  );
});

it.each(["inProgress", "completed", "interrupted", "failed", "sessionLost"])(
  "reconciles an unknown accepted request by client message identity (%s)",
  async (status) => {
    const transport = new FakeTransport();
    const client = new CodexJsonRpcClient({ transport, requestTimeoutMs: 1_000 });
    const executor = new AppServerCodexExecutor(client);
    const recovering = executor.reconcile({
      jobId: "accepted-job",
      threadId: "recover-thread",
      cwd: "/workspace",
    });
    const initialize = (await waitForMessage(transport, 0)) as { id: number };
    transport.receive({ id: initialize.id, result: {} });
    const read = (await waitForMessage(transport, 2)) as { id: number };
    expect(read).toMatchObject({
      method: "thread/read",
      params: { threadId: "recover-thread", includeTurns: true },
    });
    transport.receive({
      id: read.id,
      result: {
        thread: {
          id: "recover-thread",
          turns: [
            {
              id: "older-turn",
              status: "completed",
              items: [{ type: "userMessage", clientId: "older-job" }],
            },
            {
              id: "accepted-turn",
              status: status === "sessionLost" ? "inProgress" : status,
              items: [{ type: "userMessage", clientId: "accepted-job" }],
            },
          ],
        },
      },
    });
    if (status === "inProgress" || status === "sessionLost") {
      const resume = (await waitForMessage(transport, 3)) as { id: number };
      expect(resume).toMatchObject({
        method: "thread/resume",
        params: { threadId: "recover-thread", cwd: "/workspace" },
      });
      transport.receive({ id: resume.id, result: { thread: { id: "recover-thread" } } });
      await expect(recovering).resolves.toEqual({ status: "running", turnId: "accepted-turn" });
      const stopping = executor.interrupt("recover-thread", "accepted-turn");
      const interrupt = (await waitForMessage(transport, 4)) as { id: number };
      expect(interrupt).toMatchObject({
        method: "turn/interrupt",
        params: { threadId: "recover-thread", turnId: "accepted-turn" },
      });
      transport.receive({ id: interrupt.id, result: {} });
      if (status === "sessionLost") {
        const rejected = expect(stopping).rejects.toMatchObject({ code: -32003 });
        transport.receive({
          method: "taskboard/sessionLost",
          params: { threadId: "recover-thread", turnId: "accepted-turn" },
        });
        await rejected;
      } else {
        transport.receive({
          method: "turn/completed",
          params: {
            threadId: "recover-thread",
            turn: { id: "accepted-turn", status: "interrupted", error: null },
          },
        });
        await stopping;
      }
      expect(transport.sent).toContainEqual(
        expect.objectContaining({ method: "thread/unsubscribe" }),
      );
    } else {
      await expect(recovering).resolves.toEqual({ status: "stopped", turnId: "accepted-turn" });
      expect(transport.sent).toHaveLength(3);
    }
    await client.close();
  },
);
it.each([
  { turns: [] },
  {
    turns: [
      {
        id: "unrelated",
        status: "completed",
        items: [{ type: "userMessage", clientId: "other-job" }],
      },
    ],
  },
])(
  "keeps remote acceptance unknown when the message has no matching durable turn (%j)",
  async ({ turns }) => {
    const transport = new FakeTransport();
    const client = new CodexJsonRpcClient({ transport, requestTimeoutMs: 1_000 });
    const executor = new AppServerCodexExecutor(client);
    const recovering = executor.reconcile({
      jobId: "missing",
      threadId: "recover-thread",
      cwd: "/workspace",
    });
    const initialize = (await waitForMessage(transport, 0)) as { id: number };
    transport.receive({ id: initialize.id, result: {} });
    const read = (await waitForMessage(transport, 2)) as { id: number };
    transport.receive({ id: read.id, result: { thread: { id: "recover-thread", turns } } });
    await expect(recovering).resolves.toEqual({ status: "unknown" });
    expect(transport.sent).toHaveLength(3);
    await client.close();
  },
);

it("delivers a reconciled cancellation completion before the original turn response arrives", async () => {
  const transport = new FakeTransport();
  const client = new CodexJsonRpcClient({ transport, requestTimeoutMs: 2_000 });
  const executor = new AppServerCodexExecutor(client);
  const running = executor
    .start(
      { jobId: "pending-response-job", cwd: "/workspace", prompt: "task" },
      {
        onThread() {},
        onTurn() {},
        onEvent() {},
        onInteraction: async () => ({ type: "decline" }),
      },
    )
    .catch((error: unknown) => error);
  const init = (await waitForMessage(transport, 0)) as { id: number };
  transport.receive({ id: init.id, result: {} });
  const start = (await waitForMessage(transport, 2)) as { id: number };
  transport.receive({ id: start.id, result: { thread: { id: "pending-response-thread" } } });
  const original = (await waitForMessage(transport, 3)) as { id: number };
  const recovery = executor.reconcile({
    jobId: "pending-response-job",
    threadId: "pending-response-thread",
    cwd: "/workspace",
  });
  const read = (await waitForMessage(transport, 4)) as { id: number };
  transport.receive({
    id: read.id,
    result: {
      thread: {
        id: "pending-response-thread",
        turns: [
          {
            id: "accepted-turn",
            status: "inProgress",
            items: [{ type: "userMessage", clientId: "pending-response-job" }],
          },
        ],
      },
    },
  });
  const resume = (await waitForMessage(transport, 5)) as { id: number };
  transport.receive({ id: resume.id, result: { thread: { id: "pending-response-thread" } } });
  await recovery;
  const stopping = executor.interrupt("pending-response-thread", "accepted-turn");
  const interrupt = (await waitForMessage(transport, 6)) as { id: number };
  transport.receive({ id: interrupt.id, result: {} });
  transport.receive({
    method: "turn/completed",
    params: {
      threadId: "pending-response-thread",
      turn: { id: "accepted-turn", status: "interrupted", error: null },
    },
  });
  const stoppedBeforeResponse = await Promise.race([
    stopping.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  transport.receive({ id: original.id, result: { turn: { id: "accepted-turn" } } });
  await Promise.all([running, stopping]);
  await client.close();
  expect(stoppedBeforeResponse).toBe(true);
});

it("reads follow-up final answers and observed command directories without resuming the thread", async () => {
  const transport = new FakeTransport();
  const client = new CodexJsonRpcClient({ transport, requestTimeoutMs: 1000 });
  const executor = new AppServerCodexExecutor(client);
  const reading = executor.readHistory("thread");
  const initialize = (await waitForMessage(transport, 0)) as { id: number };
  transport.receive({ id: initialize.id, result: {} });
  const read = (await waitForMessage(transport, 2)) as { id: number };
  expect(read).toMatchObject({
    method: "thread/read",
    params: { threadId: "thread", includeTurns: true },
  });
  transport.receive({
    id: read.id,
    result: {
      thread: {
        id: "thread",
        turns: [
          {
            id: "first",
            status: "completed",
            items: [
              { id: "note", type: "agentMessage", phase: "commentary", text: "working" },
              {
                id: "command",
                type: "commandExecution",
                cwd: "/project/.worktrees/fix",
                command: "private command",
              },
              { id: "answer", type: "agentMessage", phase: "final_answer", text: "done" },
            ],
          },
          {
            id: "next",
            status: "inProgress",
            items: [
              { id: "user", type: "userMessage", content: [{ type: "text", text: "用户补充" }] },
              { id: "answer", type: "agentMessage", phase: "final_answer", text: "incomplete" },
            ],
          },
        ],
      },
    },
  });
  expect(await reading).toEqual({
    threadId: "thread",
    turns: [
      {
        id: "first",
        status: "completed",
        workingDirectories: ["/project/.worktrees/fix"],
        events: [
          {
            cursor: "first:item/completed:answer",
            kind: "codex.agent_message",
            summary: "done",
            safePayload: { text: "done", phase: "final_answer" },
          },
        ],
      },
      {
        id: "next",
        status: "inProgress",
        workingDirectories: [],
        events: [
          {
            cursor: "desktop-user:user",
            kind: "codex.user_message",
            summary: "用户补充",
            safePayload: { text: "用户补充", itemType: "userMessage", messageIds: ["user"] },
          },
        ],
      },
    ],
  });
  expect(
    transport.sent
      .filter((message) => "method" in message)
      .map((message) => "method" in message && message.method),
  ).toEqual(["initialize", "initialized", "thread/read"]);
  await client.close();
});
