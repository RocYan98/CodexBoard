import { desktopUserEvent } from "./desktop-user-events.js";
import type { TaskModelOptions } from "@codexboard/contracts";
import { readModelCatalog } from "../codex/model-catalog.js";
import { AppError } from "../../app-error.js";
import type { InteractionDecision } from "@codexboard/contracts";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

import { CodexJsonRpcClient, CodexRequestError, type CodexServerRequest } from "../codex/index.js";

const ThreadResponseSchema = z.object({ thread: z.object({ id: z.string().min(1) }) });
const DraftThreadResponseSchema = z.object({
  thread: z.object({ id: z.string().min(1) }),
  cwd: z.string().min(1),
});
const TurnResponseSchema = z.object({ turn: z.object({ id: z.string().min(1) }) });
const TurnCompletedSchema = z.object({
  threadId: z.string(),
  turn: z.object({
    id: z.string(),
    status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
    error: z.object({ message: z.string().optional() }).passthrough().nullable().optional(),
  }),
});

export interface CodexExecutionEvent {
  readonly cursor: string;
  readonly kind: string;
  readonly summary: string;
  readonly safePayload?: Record<string, unknown>;
}

export interface CodexExecutionCallbacks {
  onDispatchState?(state: "not_sent" | "sent"): void;
  onThread(threadId: string): void;
  onTurn(turnId: string): void;
  onEvent(event: CodexExecutionEvent): void;
  onInteraction(request: CodexServerRequest): Promise<InteractionDecision>;
  onInteractionResolved?(requestId: string): void;
}

export interface CodexExecutionResult {
  readonly threadId: string;
  readonly turnId: string;
  readonly status: "completed" | "interrupted" | "failed";
  readonly errorSummary?: string;
}

export interface CodexRecoveredOutcome extends CodexExecutionResult {
  readonly events: readonly CodexExecutionEvent[];
}

export interface CodexExecutor {
  readHistory?(threadId: string): Promise<CodexThreadHistory | null>;
  readOutcome?(input: {
    readonly jobId: string;
    readonly threadId: string;
    readonly turnId?: string;
  }): Promise<CodexRecoveredOutcome | null>;
  start(
    input: {
      readonly jobId: string;
      readonly cwd: string;
      readonly prompt: string;
      readonly modelOptions?: TaskModelOptions;
    },
    callbacks: CodexExecutionCallbacks,
  ): Promise<CodexExecutionResult>;
  continue(
    input: {
      readonly jobId: string;
      readonly threadId: string;
      readonly cwd: string;
      readonly prompt: string;
      readonly modelOptions?: TaskModelOptions;
    },
    callbacks: CodexExecutionCallbacks,
  ): Promise<CodexExecutionResult>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  reconcile?(input: {
    readonly jobId: string;
    readonly threadId: string;
    readonly cwd: string;
  }): Promise<
    | { readonly status: "unknown" }
    | { readonly status: "running" | "stopped"; readonly turnId: string }
  >;
}

export interface CodexThreadHistory {
  readonly threadId: string;
  readonly turns: readonly {
    readonly id: string;
    readonly status: string;
    readonly events: readonly CodexExecutionEvent[];
    readonly workingDirectories: readonly string[];
  }[];
}

export interface CodexThreadProvisioner {
  createDraft(input: {
    readonly cwd: string | null;
    readonly name: string;
    readonly modelOptions?: TaskModelOptions;
  }): Promise<{ readonly threadId: string; readonly cwd: string }>;
  archiveThread(threadId: string): Promise<void>;
}

export class CodexDisconnectedError extends Error {
  constructor(message = "Codex App Server 连接已中断") {
    super(message);
    this.name = "CodexDisconnectedError";
  }
}

interface ActiveExecution {
  readonly callbacks: CodexExecutionCallbacks;
  turnId: string | null;
  readonly ready: Promise<string | null>;
  readonly resolveReady: (turnId: string | null) => void;
  readonly pendingNotifications: { method: string; params: unknown }[];
}

type TurnCompletion = z.infer<typeof TurnCompletedSchema>;

interface TurnCompletionState {
  readonly promise: Promise<TurnCompletion>;
  readonly resolve: (value: TurnCompletion) => void;
  readonly reject: (error: Error) => void;
}

export class AppServerCodexExecutor implements CodexExecutor, CodexThreadProvisioner {
  readonly #client: CodexJsonRpcClient;
  readonly #temporaryProjectRoot: string | undefined;
  readonly #active = new Map<string, ActiveExecution>();
  readonly #sessionErrors = new Map<string, Error>();
  readonly #turnCompletions = new Map<string, TurnCompletionState>();
  readonly #turnThreads = new Map<string, string>();
  readonly #reconciledThreads = new Set<string>();

  constructor(client: CodexJsonRpcClient, temporaryProjectRoot?: string) {
    this.#client = client;
    this.#temporaryProjectRoot = temporaryProjectRoot;
    client.onNotification((notification) =>
      this.#handleNotification(notification.method, notification.params),
    );
    client.onServerRequest(async (request) => this.#handleServerRequest(request));
    client.onDisconnect((error) => {
      const disconnected = new CodexDisconnectedError(error.message);
      for (const completion of this.#turnCompletions.values()) completion.reject(disconnected);
      this.#turnCompletions.clear();
      this.#active.clear();
    });
  }

  async createDraft(input: {
    readonly cwd: string | null;
    readonly name: string;
    readonly modelOptions?: TaskModelOptions;
  }): Promise<{ readonly threadId: string; readonly cwd: string }> {
    await this.#client.connect();
    const modelOptions = input.modelOptions;
    if (modelOptions) {
      const catalog = await readModelCatalog((method, params) =>
        this.#client.request(method, params),
      );
      const selected = catalog.data.find(
        (model) => !model.hidden && model.model === modelOptions.model,
      );
      if (
        !selected ||
        !selected.supportedReasoningEfforts.some(
          ({ reasoningEffort }) => reasoningEffort === modelOptions.effort,
        ) ||
        (input.modelOptions.serviceTier !== null &&
          !selected.serviceTiers.some(({ id }) => id === modelOptions.serviceTier))
      ) {
        throw new AppError("INVALID_REQUEST", 400, "所选模型、推理强度或速度不可用，请重新选择");
      }
    }
    // A null cwd inherits the App Server's project. Allocate on the Codex host,
    // not in the Taskboard container, so Desktop keeps temporary tasks in Recent.
    const cwd = input.cwd ?? (await this.#createRecentWorkspace());
    // Omit permission overrides so new drafts use Codex's configured defaults.
    const response = DraftThreadResponseSchema.parse(
      await this.#client.request("thread/start", {
        cwd,
        ephemeral: false,
        ...(input.modelOptions
          ? {
              model: input.modelOptions.model,
              serviceTier: input.modelOptions.serviceTier,
              config: { model_reasoning_effort: input.modelOptions.effort },
            }
          : {}),
      }),
    );
    try {
      await this.#client.request("thread/name/set", {
        threadId: response.thread.id,
        name: input.name,
      });
    } catch (error: unknown) {
      try {
        await this.archiveThread(response.thread.id);
      } catch (archiveError: unknown) {
        throw new AggregateError(
          [error, archiveError],
          "Codex Thread 命名失败，且新 Thread 无法归档",
          { cause: archiveError },
        );
      }
      throw error;
    } finally {
      await this.#releaseThread(response.thread.id);
    }
    return { threadId: response.thread.id, cwd: response.cwd };
  }

  async #createRecentWorkspace(): Promise<string> {
    const root = this.#temporaryProjectRoot;
    if (!root || !isAbsolute(root)) {
      throw new Error(
        "临时项目根目录不可用，请配置 CODEXBOARD_TEMPORARY_PROJECT_ROOT 为宿主机绝对路径",
      );
    }
    // Use the same host root for workspace creation and the project header.
    // CODEX_HOME is configuration storage, independent of Desktop workspaces.
    const cwd = join(root, new Date().toISOString().slice(0, 10), `task-${randomUUID()}`);
    await this.#client.request("fs/createDirectory", { path: cwd, recursive: true });
    return cwd;
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.#client.connect();
    try {
      await this.#client.request("thread/archive", { threadId });
    } finally {
      await this.#releaseThread(threadId);
    }
  }

  async start(
    input: {
      readonly jobId: string;
      readonly cwd: string;
      readonly prompt: string;
      readonly modelOptions?: TaskModelOptions;
    },
    callbacks: CodexExecutionCallbacks,
  ): Promise<CodexExecutionResult> {
    callbacks.onDispatchState?.("not_sent");
    await this.#client.connect();
    const response = ThreadResponseSchema.parse(
      await this.#client.request("thread/start", {
        cwd: input.cwd,
        ephemeral: false,
      }),
    );
    try {
      callbacks.onThread(response.thread.id);
      return await this.#startTurn(response.thread.id, input, callbacks);
    } finally {
      await this.#releaseThread(response.thread.id);
    }
  }

  async continue(
    input: {
      readonly jobId: string;
      readonly threadId: string;
      readonly cwd: string;
      readonly prompt: string;
      readonly modelOptions?: TaskModelOptions;
    },
    callbacks: CodexExecutionCallbacks,
  ): Promise<CodexExecutionResult> {
    callbacks.onDispatchState?.("not_sent");
    await this.#client.connect();
    const response = ThreadResponseSchema.parse(
      await this.#client.request("thread/resume", {
        threadId: input.threadId,
        cwd: input.cwd,
      }),
    );
    try {
      if (response.thread.id !== input.threadId) throw new Error("Codex 恢复了非预期 Thread");
      callbacks.onThread(response.thread.id);
      return await this.#startTurn(response.thread.id, input, callbacks);
    } finally {
      await this.#releaseThread(response.thread.id);
    }
  }

  async readHistory(threadId: string): Promise<CodexThreadHistory | null> {
    await this.#client.connect();
    const result = z
      .object({
        thread: z.object({
          id: z.string(),
          turns: z.array(
            z.object({ id: z.string(), status: z.string(), items: z.array(z.unknown()) }),
          ),
        }),
      })
      .safeParse(await this.#client.request("thread/read", { threadId, includeTurns: true }));
    if (!result.success || result.data.thread.id !== threadId) return null;
    return {
      threadId,
      turns: result.data.thread.turns.map((turn) => ({
        id: turn.id,
        status: turn.status,
        events: turn.items.flatMap((raw): CodexExecutionEvent[] => {
          const user = desktopUserEvent(raw, threadId);
          if (user) return [user];
          const item = z
            .object({
              type: z.literal("agentMessage"),
              id: z.string(),
              text: z.string(),
              phase: z.literal("final_answer"),
            })
            .safeParse(raw);
          if (!item.success || !["completed", "failed", "interrupted"].includes(turn.status))
            return [];
          return [
            {
              cursor: `${turn.id}:item/completed:${item.data.id}`,
              kind: "codex.agent_message",
              summary: item.data.text.slice(0, 2000),
              safePayload: { text: item.data.text, phase: item.data.phase },
            },
          ];
        }),
        workingDirectories: turn.items.flatMap((raw) => {
          const item = z
            .object({ type: z.literal("commandExecution"), cwd: z.string().min(1) })
            .safeParse(raw);
          return item.success ? [item.data.cwd] : [];
        }),
      })),
    };
  }

  async readOutcome(input: {
    readonly jobId: string;
    readonly threadId: string;
    readonly turnId?: string;
  }): Promise<CodexRecoveredOutcome | null> {
    // Read persisted history only. Never resume, start or interrupt a thread here.
    await this.#client.connect();
    const response = z
      .object({
        thread: z.object({
          id: z.string(),
          turns: z.array(
            z.object({
              id: z.string(),
              status: z.enum(["completed", "failed", "interrupted", "inProgress"]),
              items: z.array(z.unknown()),
              error: z.object({ message: z.string().optional() }).nullish(),
            }),
          ),
        }),
      })
      .safeParse(
        await this.#client.request("thread/read", { threadId: input.threadId, includeTurns: true }),
      );
    if (!response.success || response.data.thread.id !== input.threadId) return null;
    const matches = response.data.thread.turns.filter((turn) =>
      input.turnId
        ? turn.id === input.turnId
        : turn.items.some((raw) => {
            const item = z
              .object({ type: z.literal("userMessage"), clientId: z.string() })
              .safeParse(raw);
            return item.success && item.data.clientId === input.jobId;
          }),
    );
    if (matches.length !== 1 || matches[0]!.status === "inProgress") return null;
    const turn = matches[0]!;
    const events = turn.items.flatMap((raw): CodexExecutionEvent[] => {
      const item = z
        .object({
          type: z.literal("agentMessage"),
          id: z.string(),
          text: z.string(),
          phase: z.literal("final_answer"),
        })
        .safeParse(raw);
      if (!item.success) return [];
      return [
        {
          cursor: `${turn.id}:item/completed:${item.data.id}`,
          kind: "codex.agent_message",
          summary: item.data.text.slice(0, 2000),
          safePayload: { text: item.data.text, phase: item.data.phase },
        },
      ];
    });
    return {
      threadId: input.threadId,
      turnId: turn.id,
      status: turn.status as "completed" | "failed" | "interrupted",
      events,
      ...(turn.error?.message ? { errorSummary: turn.error.message } : {}),
    };
  }

  async #releaseThread(threadId: string): Promise<void> {
    if (!this.#client.connected) return;
    await this.#client.request("thread/unsubscribe", { threadId });
  }

  async reconcile(input: {
    readonly jobId: string;
    readonly threadId: string;
    readonly cwd: string;
  }): Promise<
    | { readonly status: "unknown" }
    | { readonly status: "running" | "stopped"; readonly turnId: string }
  > {
    await this.#client.connect();
    const response = z
      .object({
        thread: z.object({
          id: z.string(),
          turns: z.array(
            z.object({
              id: z.string(),
              status: z.enum(["inProgress", "completed", "interrupted", "failed"]),
              items: z.array(z.unknown()),
            }),
          ),
        }),
      })
      .safeParse(
        await this.#client.request("thread/read", { threadId: input.threadId, includeTurns: true }),
      );
    if (!response.success || response.data.thread.id !== input.threadId)
      return { status: "unknown" };
    const matching = response.data.thread.turns.filter((turn) =>
      turn.items.some((raw) => {
        const item = z
          .object({ type: z.literal("userMessage"), clientId: z.string() })
          .safeParse(raw);
        return item.success && item.data.clientId === input.jobId;
      }),
    );
    if (matching.length !== 1) return { status: "unknown" };
    const turn = matching[0]!;
    if (turn.status !== "inProgress") return { status: "stopped", turnId: turn.id };
    this.#turnThreads.set(turn.id, input.threadId);
    this.#completionForTurn(turn.id);
    const resumed = ThreadResponseSchema.parse(
      await this.#client.request("thread/resume", { threadId: input.threadId, cwd: input.cwd }),
    );
    if (resumed.thread.id !== input.threadId) return { status: "unknown" };
    this.#reconciledThreads.add(input.threadId);
    return { status: "running", turnId: turn.id };
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.#client.connect();
    this.#turnThreads.set(turnId, threadId);
    const completionState = this.#completionForTurn(turnId);
    try {
      // A restarted executor has no owning worker. Restore it before interpreting
      // "no active turn"; the control worker alone cannot establish remote stop.
      if (!this.#active.has(threadId) && !this.#reconciledThreads.has(threadId)) {
        const response = ThreadResponseSchema.parse(
          await this.#client.request("thread/resume", { threadId }),
        );
        if (response.thread.id !== threadId) throw new Error("Codex 恢复了非预期 Thread");
        this.#reconciledThreads.add(threadId);
      }
      try {
        await this.#client.request("turn/interrupt", { threadId, turnId });
      } catch (error: unknown) {
        if (
          error instanceof CodexRequestError &&
          error.code === -32602 &&
          error.message.trim().toLowerCase() === "no active turn to interrupt"
        ) {
          completionState.resolve({
            threadId,
            turn: { id: turnId, status: "interrupted", error: null },
          });
          return;
        }
        throw error;
      }
      const completion = await completionState.promise;
      if (!["interrupted", "completed", "failed"].includes(completion.turn.status)) {
        throw new Error("Codex 取消后未返回确定终态");
      }
    } finally {
      if (!this.#active.has(threadId)) {
        this.#turnCompletions.delete(turnId);
        this.#turnThreads.delete(turnId);
      }
      if (this.#reconciledThreads.delete(threadId)) await this.#releaseThread(threadId);
    }
  }

  async #startTurn(
    threadId: string,
    input: {
      readonly jobId: string;
      readonly cwd: string;
      readonly prompt: string;
      readonly modelOptions?: TaskModelOptions;
    },
    callbacks: CodexExecutionCallbacks,
  ): Promise<CodexExecutionResult> {
    let resolveReady!: (turnId: string | null) => void;
    const ready = new Promise<string | null>((resolve) => {
      resolveReady = resolve;
    });
    const execution: ActiveExecution = {
      callbacks,
      turnId: null,
      ready,
      resolveReady,
      pendingNotifications: [],
    };
    this.#active.set(threadId, execution);
    let turnId: string | undefined;
    try {
      callbacks.onDispatchState?.("sent");
      const response = TurnResponseSchema.parse(
        await this.#client.request("turn/start", {
          threadId,
          clientUserMessageId: input.jobId,
          ...(input.modelOptions ?? {}),
          cwd: input.cwd,
          input: [{ type: "text", text: input.prompt, text_elements: [] }],
        }),
      );
      turnId = response.turn.id;
      execution.turnId = turnId;
      this.#turnThreads.set(turnId, threadId);
      callbacks.onTurn(turnId);
      execution.resolveReady(turnId);
      for (const event of execution.pendingNotifications.splice(0))
        this.#handleNotification(event.method, event.params);
      const sessionError = this.#sessionErrors.get(threadId);
      if (sessionError) throw sessionError;
      const completion = await this.#waitForTurn(turnId);
      const status = completion.turn.status;
      if (status === "inProgress") {
        throw new Error("Codex Turn 完成通知包含非法进行中状态");
      }
      return {
        threadId,
        turnId,
        status,
        ...(completion.turn.error?.message ? { errorSummary: completion.turn.error.message } : {}),
      };
    } catch (error: unknown) {
      if (error instanceof CodexRequestError || error instanceof CodexDisconnectedError)
        throw error;
      // Once turn/start is sent, transport or response parsing errors cannot prove rejection.
      throw new CodexRequestError(-32003, "Codex 执行请求结果未确认，请先核对远端轮次");
    } finally {
      execution.resolveReady(null);
      if (this.#active.get(threadId) === execution) this.#active.delete(threadId);
      this.#sessionErrors.delete(threadId);
      if (turnId) {
        this.#turnCompletions.delete(turnId);
        this.#turnThreads.delete(turnId);
      }
    }
  }

  #waitForTurn(turnId: string): Promise<TurnCompletion> {
    const existing = this.#turnCompletions.get(turnId);
    if (existing) return existing.promise;
    let resolve!: TurnCompletionState["resolve"];
    let reject!: TurnCompletionState["reject"];
    const promise = new Promise<TurnCompletion>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    void promise.catch(() => undefined);
    const completion = { promise, resolve, reject };
    this.#turnCompletions.set(turnId, completion);
    return promise;
  }

  #completionForTurn(turnId: string): TurnCompletionState {
    const existing = this.#turnCompletions.get(turnId);
    if (existing) return existing;
    let resolve!: TurnCompletionState["resolve"];
    let reject!: TurnCompletionState["reject"];
    const promise = new Promise<TurnCompletion>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    void promise.catch(() => undefined);
    const completion = { promise, resolve, reject };
    this.#turnCompletions.set(turnId, completion);
    return completion;
  }

  #handleNotification(method: string, params: unknown): void {
    const value = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const threadId =
      typeof value.threadId === "string"
        ? value.threadId
        : typeof value.conversationId === "string"
          ? value.conversationId
          : undefined;
    const execution = threadId ? this.#active.get(threadId) : undefined;
    const nestedTurn =
      value.turn && typeof value.turn === "object" ? (value.turn as Record<string, unknown>) : {};
    const eventTurnId =
      typeof value.turnId === "string"
        ? value.turnId
        : typeof nestedTurn.id === "string"
          ? nestedTurn.id
          : undefined;
    const reconciledTerminal =
      threadId &&
      eventTurnId &&
      this.#turnThreads.get(eventTurnId) === threadId &&
      (method === "turn/completed" || method === "taskboard/sessionLost");
    if (execution && !execution.turnId && !reconciledTerminal) {
      if (execution.pendingNotifications.length < 1000)
        execution.pendingNotifications.push({ method, params });
      return;
    }
    if (method === "turn/completed") {
      const completion = TurnCompletedSchema.safeParse(params);
      if (!completion.success) return;
      if (this.#turnThreads.get(completion.data.turn.id) === completion.data.threadId) {
        this.#completionForTurn(completion.data.turn.id).resolve(completion.data);
      }
      return;
    }
    if (
      method === "taskboard/sessionLost" &&
      threadId &&
      eventTurnId &&
      this.#turnThreads.get(eventTurnId) === threadId
    ) {
      const error = new CodexRequestError(-32003, "桌面会话连接已中断，执行结果尚未确认");
      if (execution?.turnId === eventTurnId) this.#sessionErrors.set(threadId, error);
      this.#turnCompletions.get(eventTurnId)?.reject(error);
      return;
    }
    if (!execution || !eventTurnId || eventTurnId !== execution.turnId) return;
    if (
      method === "serverRequest/resolved" &&
      (typeof value.requestId === "string" || typeof value.requestId === "number")
    ) {
      execution.callbacks.onInteractionResolved?.(String(value.requestId));
      return;
    }
    const turnId = typeof value.turnId === "string" ? value.turnId : "turn";
    const item =
      value.item && typeof value.item === "object" ? (value.item as Record<string, unknown>) : {};
    const itemId = typeof item.id === "string" ? item.id : method;
    if (method === "error") {
      const code =
        typeof value.code === "number" && Number.isFinite(value.code) ? value.code : null;
      execution.callbacks.onEvent({
        cursor: `${turnId}:${method}:${code ?? itemId}`,
        kind: "codex.error",
        summary: code === null ? "Codex 执行报告错误" : `Codex 执行报告错误（代码 ${code}）`,
        ...(code === null ? {} : { safePayload: { code } }),
      });
      return;
    }
    if (method !== "item/completed") {
      if (!method.endsWith("/delta") && method !== "turn/started" && method !== "item/started") {
        execution.callbacks.onEvent({
          cursor: `${turnId}:${method}:${itemId}`,
          kind: "codex.notification",
          summary: `Codex 通知：${method}`,
          safePayload: { method },
        });
      }
      return;
    }
    const type = typeof item.type === "string" ? item.type : "item";
    if (type === "agentMessage") {
      execution.callbacks.onEvent({
        cursor: `${turnId}:${method}:${itemId}`,
        kind: "codex.agent_message",
        summary: String(item.text ?? "Agent 消息").slice(0, 2_000),
        safePayload: {
          text: String(item.text ?? "Agent 消息"),
          phase: item.phase === "final_answer" || item.phase === "commentary" ? item.phase : null,
        },
      });
    } else if (type === "commandExecution") {
      execution.callbacks.onEvent({
        cursor: `${turnId}:${method}:${itemId}`,
        kind: "codex.command",
        summary: `命令执行${item.status ? `：${String(item.status)}` : ""}`,
        safePayload: { exitCode: typeof item.exitCode === "number" ? item.exitCode : null },
      });
    } else if (type === "fileChange") {
      execution.callbacks.onEvent({
        cursor: `${turnId}:${method}:${itemId}`,
        kind: "codex.file_change",
        summary: `文件变更${item.status ? `：${String(item.status)}` : ""}`,
        safePayload: { changeCount: Array.isArray(item.changes) ? item.changes.length : 0 },
      });
    }
  }

  async #handleServerRequest(request: CodexServerRequest): Promise<void> {
    const value =
      request.params && typeof request.params === "object"
        ? (request.params as Record<string, unknown>)
        : {};
    const threadId =
      typeof value.threadId === "string"
        ? value.threadId
        : typeof value.conversationId === "string"
          ? value.conversationId
          : undefined;
    const execution = threadId ? this.#active.get(threadId) : undefined;
    if (!execution) {
      await request.fail(-32602, "No active task is bound to this Codex request");
      return;
    }
    const turnId = await execution.ready;
    if (!turnId || value.turnId !== turnId || this.#active.get(threadId as string) !== execution) {
      await request.fail(-32602, "Request does not belong to the active turn");
      return;
    }
    const decision = await execution.callbacks.onInteraction(request);
    await request.respond(this.#responseFor(request.method, request.params, decision));
  }

  #responseFor(method: string, params: unknown, decision: InteractionDecision): unknown {
    if (method === "execCommandApproval" || method === "applyPatchApproval") {
      return {
        decision:
          decision.type === "accept"
            ? "approved"
            : decision.type === "cancel"
              ? "abort"
              : { denied: { rejection: "用户拒绝" } },
      };
    }
    if (method === "item/tool/requestUserInput") {
      if (decision.type !== "input") return { answers: {} };
      return {
        answers: Object.fromEntries(
          Object.entries(decision.answers).map(([id, answers]) => [id, { answers }]),
        ),
      };
    }
    if (method === "mcpServer/elicitation/request") {
      return {
        action: decision.type === "accept" || decision.type === "input" ? "accept" : decision.type,
        content: decision.type === "input" ? decision.answers : null,
        _meta: null,
      };
    }
    if (method === "item/permissions/requestApproval") {
      const value = params as Record<string, unknown>;
      if (decision.type !== "accept") {
        throw new Error("权限请求已被拒绝或取消");
      }
      return { permissions: value.permissions ?? {}, scope: "turn" };
    }
    return { decision: decision.type === "input" ? "decline" : decision.type };
  }
}
