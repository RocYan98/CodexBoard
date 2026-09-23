import type { CodexRecoveredOutcome, CodexThreadHistory } from "./codex-executor.js";
import { TaskModelOptionsSchema, type TaskModelOptions } from "@codexboard/contracts";
import { identityKey, identityFromKey, IdentityKeySchema } from "@codexboard/contracts";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  JobViewSchema,
  normalizeCodexBoardEnvironment,
  JobWorkContextSchema,
  type PrincipalView,
  type JobKind,
  type JobStatus,
  type JobView,
  type JobWorkContext,
} from "@codexboard/contracts";
import { z } from "zod";

import { AppError } from "../../app-error.js";
import { withTransaction, type SqliteDatabase } from "../database/index.js";
import { assertTaskDeletionAvailable } from "../taskboard/task-delete-lease.js";
import { MODEL_CAPACITY_NOTICE } from "./model-capacity.js";
import { recordJobWorkspaceStart, recordJobWorkspaceStop } from "../taskboard/task-git-evidence.js";
import {
  assertWorkspaceLifecycleAvailable,
  hasTaskLifecycleIntent,
} from "../taskboard/task-lifecycle-guard.js";

const RawJobRowSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  taskThreadId: z.uuid().nullable(),
  targetJobId: z.uuid().nullable(),
  kind: z.enum(["start", "continue", "cancel"]),
  status: z.enum([
    "queued",
    "running",
    "waiting_approval",
    "waiting_input",
    "canceling",
    "succeeded",
    "failed",
    "failed_recoverable",
    "canceled",
  ]),
  executionKey: z.string(),
  requestedBy: IdentityKeySchema.nullable(),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  leaseOwner: z.string().nullable(),
  leaseExpiresAt: z.string().datetime().nullable(),
  errorCode: z.string().nullable(),
  errorSummary: z.string().nullable(),
  workContextJson: z.string(),
  recoveryCheckpointJson: z.string().nullable(),
  queuedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  cancelRequestedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});

const RawJobEventRowSchema = z.object({
  id: z.uuid(),
  seq: z.number().int().positive(),
  kind: z.string(),
  summary: z.string(),
  safePayloadJson: z.string(),
  createdAt: z.string().datetime(),
});

const RawIdempotentJobSchema = z.object({ id: z.uuid(), requestHash: z.string().length(64) });
const RawTaskSchema = z.object({
  projectId: z.uuid(),
  identifier: z.string(),
  status: z.enum(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"]),
  archivedAt: z.string().datetime().nullable(),
});

const JOB_COLUMNS = `
  id,
  task_id AS taskId,
  task_thread_id AS taskThreadId,
  target_job_id AS targetJobId,
  kind,
  status,
  execution_key AS executionKey,
  requested_by_identity_key AS requestedBy,
  attempt,
  max_attempts AS maxAttempts,
  lease_owner AS leaseOwner,
  lease_expires_at AS leaseExpiresAt,
  error_code AS errorCode,
  error_summary AS errorSummary,
  work_context_json AS workContextJson,
  recovery_checkpoint_json AS recoveryCheckpointJson,
  queued_at AS queuedAt,
  started_at AS startedAt,
  cancel_requested_at AS cancelRequestedAt,
  completed_at AS completedAt,
  updated_at AS updatedAt
`;

export interface JobRequestContext {
  readonly actor: PrincipalView;
  readonly idempotencyKey: string;
  readonly requestId?: string;
}

export type JobClaimScope = "any" | "execution" | "cancel";

export interface SubmitJobCommand {
  readonly taskId: string;
  readonly taskThreadId?: string | null;
  readonly kind: "start" | "continue";
  readonly executionKey: string;
  readonly workContext: JobWorkContext;
  readonly maxAttempts?: number;
  readonly explicitPrompt?: boolean;
}

interface ExecutionQueueOptions {
  readonly dataDirectory?: string;
  readonly executorNodePath?: string | undefined;
  readonly executorTaskctlPath?: string | undefined;
  readonly executorDataDirectory?: string | undefined;
  readonly database: SqliteDatabase;
  readonly now?: () => Date;
  readonly leaseDurationMs?: number;
  readonly onRevisionCommitted?: (revision: number) => void;
}

interface MutationResult<Result> {
  readonly result: Result;
  readonly revision: number | null;
}

export interface TaskThreadBinding {
  readonly id: string;
  readonly taskId: string;
  readonly threadId: string;
  readonly cwd: string;
  readonly modelOptions?: TaskModelOptions;
  readonly lastTurnId: string | null;
  readonly lastEventCursor: string | null;
  readonly status: "active" | "idle" | "completed" | "failed" | "archived";
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function requestHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function quoteShellArgument(value: string): string {
  return "'" + value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''") + "'";
}

export class ExecutionQueue {
  readonly #database: SqliteDatabase;
  readonly #taskctlCommand: string;
  readonly #now: () => Date;
  readonly #leaseDurationMs: number;
  readonly #onRevisionCommitted: ((revision: number) => void) | undefined;

  constructor(options: ExecutionQueueOptions) {
    this.#database = options.database;
    const quote = quoteShellArgument;
    const cli = fileURLToPath(
      new URL("../../../../../packages/taskctl/dist/cli.js", import.meta.url),
    );
    const data = quote(
      resolve(
        options.executorDataDirectory ??
          options.dataDirectory ??
          normalizeCodexBoardEnvironment(process.env).CODEXBOARD_DATA_DIR ??
          ".data",
      ),
    );
    const executable = `${quote(options.executorNodePath ?? process.execPath)} ${quote(options.executorTaskctlPath ?? cli)}`;
    this.#taskctlCommand =
      process.platform === "win32"
        ? `$env:CODEXBOARD_DATA_DIR=${data}; & ${executable}`
        : `CODEXBOARD_DATA_DIR=${data} ${executable}`;
    this.#now = options.now ?? (() => new Date());
    this.#leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.#onRevisionCommitted = options.onRevisionCommitted;
  }

  submit(command: SubmitJobCommand, context: JobRequestContext): JobView {
    const workContext = JobWorkContextSchema.parse(command.workContext);
    const maxAttempts = z
      .number()
      .int()
      .min(1)
      .max(10)
      .parse(command.maxAttempts ?? 1);
    const hash = requestHash({ ...command, workContext, maxAttempts });
    const replay = this.#idempotentJob(context.idempotencyKey);
    if (replay) {
      if (replay.requestHash !== hash) {
        throw new AppError("DUPLICATE_REQUEST", 409, "幂等键已用于不同执行请求");
      }
      return this.readJob(replay.id);
    }

    const timestamp = this.#now().toISOString();
    const jobId = randomUUID();
    let mutation: MutationResult<JobView>;
    try {
      mutation = withTransaction(this.#database, () => {
        assertTaskDeletionAvailable(this.#database, command.taskId);
        if (typeof workContext.cwd === "string")
          assertWorkspaceLifecycleAvailable(this.#database, workContext.cwd);
        const task = this.#readTask(command.taskId);
        if (task.status === "done" || task.status === "canceled") {
          throw new AppError("INVALID_REQUEST", 409, "已结束任务不能启动 Codex");
        }
        if (task.archivedAt) {
          throw new AppError("INVALID_REQUEST", 409, "已归档任务不能启动 Codex");
        }
        if (
          command.kind === "continue" &&
          !(command.explicitPrompt && String(workContext.prompt ?? "").trim())
        ) {
          const latest = this.listTaskJobs(command.taskId).find((job) => job.kind !== "cancel");
          const pending = this.#database
            .prepare(
              "SELECT 1 FROM comments WHERE task_id = ? AND deleted_at IS NULL AND executed_at IS NULL LIMIT 1",
            )
            .get(command.taskId);
          if (latest?.status === "succeeded" && !pending) {
            throw new AppError("INVALID_REQUEST", 409, "没有待执行评论，请添加新指令后继续");
          }
        }
        const snapshotContext = this.#snapshotWorkContext(command.taskId, workContext);
        this.#database
          .prepare(
            `INSERT INTO jobs (
              id, task_id, task_thread_id, kind, status, execution_key,
              idempotency_key, request_hash, requested_by_identity_key, max_attempts,
              work_context_json, queued_at, updated_at
            ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            jobId,
            command.taskId,
            command.taskThreadId ?? null,
            command.kind,
            command.executionKey,
            context.idempotencyKey,
            hash,
            identityKey(context.actor.identity),
            maxAttempts,
            JSON.stringify(snapshotContext),
            timestamp,
            timestamp,
          );
        const snapshotAttachments = z
          .array(z.object({ id: z.uuid(), originalAttachmentId: z.uuid() }))
          .parse(snapshotContext.attachmentSnapshot);
        const persistSnapshot = this.#database.prepare(`INSERT INTO job_attachment_snapshots (
          id, job_id, task_id, original_attachment_id, comment_id, uploader_identity_key, filename,
          content_type, size_bytes, sha256, storage_key, created_at
        ) SELECT ?, ?, task_id, id, comment_id, uploader_identity_key, filename,
          content_type, size_bytes, sha256, storage_key, ? FROM attachments WHERE id = ? AND task_id = ?`);
        for (const attachment of snapshotAttachments)
          persistSnapshot.run(
            attachment.id,
            jobId,
            timestamp,
            attachment.originalAttachmentId,
            command.taskId,
          );
        this.#appendEvent(jobId, "job.queued", "执行已进入队列", {}, timestamp);
        let revision = this.#recordChange(
          "job",
          jobId,
          "job.queued",
          { projectId: task.projectId, taskId: command.taskId, status: "queued" },
          timestamp,
        );
        if (!["done", "canceled", "in_progress"].includes(task.status)) {
          this.#database
            .prepare(
              `UPDATE tasks
              SET status = 'in_progress', version = version + 1, updated_at = ?
              WHERE id = ?`,
            )
            .run(timestamp, command.taskId);
          this.#database
            .prepare(
              `INSERT INTO activities (id, task_id, identity_key, kind, changes_json, created_at)
              VALUES (?, ?, ?, 'task.execution_started', ?, ?)`,
            )
            .run(
              randomUUID(),
              command.taskId,
              identityKey(context.actor.identity),
              JSON.stringify({ status: { from: task.status, to: "in_progress" }, jobId }),
              timestamp,
            );
          revision = this.#recordChange(
            "task",
            command.taskId,
            "task.execution_started",
            { projectId: task.projectId, taskId: command.taskId, jobId, status: "in_progress" },
            timestamp,
          );
        }
        this.#recordAudit(
          context,
          "job.submit",
          jobId,
          { taskId: command.taskId, kind: command.kind },
          timestamp,
        );
        return { result: this.readJob(jobId), revision };
      });
    } catch (error: unknown) {
      if (this.#isConstraint(error)) {
        throw new AppError("DUPLICATE_REQUEST", 409, "该工作上下文已有活动执行");
      }
      throw error;
    }
    this.#notify(mutation.revision);
    return mutation.result;
  }

  async captureWorkspaceStart(jobId: string): Promise<void> {
    const job = this.readJob(jobId);
    if (typeof job.workContext.cwd === "string")
      await recordJobWorkspaceStart(this.#database, jobId, job.workContext.cwd);
  }

  async captureWorkspaceStop(jobId: string): Promise<void> {
    await recordJobWorkspaceStop(this.#database, jobId);
  }

  readJob(jobId: string): JobView {
    const row = RawJobRowSchema.safeParse(
      this.#database.prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`).get(jobId),
    );
    if (!row.success) {
      throw new AppError("NOT_FOUND", 404, "执行作业不存在");
    }
    const events = this.#database
      .prepare(
        `SELECT id, seq, kind, summary, safe_payload_json AS safePayloadJson,
          created_at AS createdAt
        FROM job_events WHERE job_id = ? ORDER BY seq`,
      )
      .all(jobId)
      .map((event) => {
        const parsed = RawJobEventRowSchema.parse(event);
        return {
          id: parsed.id,
          seq: parsed.seq,
          kind: parsed.kind,
          summary: parsed.summary,
          safePayload: JSON.parse(parsed.safePayloadJson) as Record<string, unknown>,
          createdAt: parsed.createdAt,
        };
      });
    return JobViewSchema.parse({
      ...row.data,
      requestedBy: row.data.requestedBy ? identityFromKey(row.data.requestedBy) : null,
      workContext: JSON.parse(row.data.workContextJson),
      recoveryCheckpoint: row.data.recoveryCheckpointJson
        ? JSON.parse(row.data.recoveryCheckpointJson)
        : null,
      events,
    });
  }

  listTaskJobs(taskId: string): readonly JobView[] {
    const ids = this.#database
      .prepare("SELECT id FROM jobs WHERE task_id = ? ORDER BY queued_at DESC, rowid DESC")
      .pluck()
      .all(taskId) as string[];
    return ids.map((id) => this.readJob(id));
  }

  primaryThread(taskId: string): TaskThreadBinding | null {
    const row = this.#database
      .prepare(
        `SELECT id, task_id AS taskId, thread_id AS threadId, cwd,
          last_turn_id AS lastTurnId, last_event_cursor AS lastEventCursor, status, model_options_json AS modelOptionsJson
        FROM task_threads WHERE task_id = ? AND is_primary = 1`,
      )
      .get(taskId) as (TaskThreadBinding & { modelOptionsJson: string | null }) | undefined;
    if (!row) return null;
    const { modelOptionsJson, ...binding } = row;
    return {
      ...binding,
      ...(modelOptionsJson
        ? { modelOptions: TaskModelOptionsSchema.parse(JSON.parse(modelOptionsJson)) }
        : {}),
    };
  }

  bindDraftThread(
    taskId: string,
    binding: {
      readonly threadId: string;
      readonly cwd: string;
      readonly codexVersion?: string;
      readonly modelOptions?: TaskModelOptions;
    },
  ): { readonly thread: TaskThreadBinding; readonly revision: number | null } {
    const timestamp = this.#now().toISOString();
    const mutation = withTransaction(this.#database, () => {
      const task = this.#database
        .prepare(
          "SELECT project_id AS projectId, archived_at AS archivedAt FROM tasks WHERE id = ?",
        )
        .get(taskId) as { projectId: string; archivedAt: string | null } | undefined;
      if (!task) throw new AppError("NOT_FOUND", 404, "任务不存在");
      if (task.archivedAt)
        throw new AppError("INVALID_REQUEST", 409, "已归档任务不能绑定 Codex Thread");

      const existing = this.primaryThread(taskId);
      if (existing) {
        if (existing.threadId !== binding.threadId) {
          throw new AppError("INVALID_REQUEST", 409, "任务已绑定其他主 Thread");
        }
        return { result: existing, revision: null };
      }

      this.#database
        .prepare(
          `INSERT INTO task_threads (
            id, task_id, thread_id, cwd, codex_version, model_options_json, is_primary, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, 'idle', ?, ?)`,
        )
        .run(
          randomUUID(),
          taskId,
          binding.threadId,
          binding.cwd,
          binding.codexVersion ?? null,
          binding.modelOptions
            ? JSON.stringify(TaskModelOptionsSchema.parse(binding.modelOptions))
            : null,
          timestamp,
          timestamp,
        );
      const revision = this.#recordChange(
        "task",
        taskId,
        "codex.thread_created",
        { projectId: task.projectId, taskId, status: "draft" },
        timestamp,
      );
      return { result: this.primaryThread(taskId) as TaskThreadBinding, revision };
    });
    this.#notify(mutation.revision);
    return { thread: mutation.result, revision: mutation.revision };
  }

  activeJobForThread(threadId: string): JobView | null {
    const id = this.#database
      .prepare(
        `SELECT jobs.id FROM jobs
        JOIN task_threads ON task_threads.id = jobs.task_thread_id
        WHERE task_threads.thread_id = ?
          AND jobs.status IN ('running', 'waiting_approval', 'waiting_input', 'canceling')
        ORDER BY jobs.started_at DESC, jobs.rowid DESC LIMIT 1`,
      )
      .pluck()
      .get(threadId) as string | undefined;
    return id ? this.readJob(id) : null;
  }

  bindThread(
    jobId: string,
    owner: string,
    binding: { readonly threadId: string; readonly cwd: string; readonly codexVersion?: string },
  ): TaskThreadBinding {
    const current = this.#assertOwned(jobId, owner, ["running", "canceling"]);
    const timestamp = this.#now().toISOString();
    const mutation = withTransaction(this.#database, () => {
      const existing = this.primaryThread(current.taskId);
      if (existing && existing.threadId !== binding.threadId) {
        throw new AppError("INVALID_REQUEST", 409, "任务已绑定其他主 Thread");
      }
      const taskThreadId = existing?.id ?? randomUUID();
      if (!existing) {
        this.#database
          .prepare(
            `INSERT INTO task_threads (
              id, task_id, thread_id, cwd, codex_version, is_primary, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 1, 'active', ?, ?)`,
          )
          .run(
            taskThreadId,
            current.taskId,
            binding.threadId,
            binding.cwd,
            binding.codexVersion ?? null,
            timestamp,
            timestamp,
          );
      } else {
        this.#database
          .prepare("UPDATE task_threads SET status = 'active', updated_at = ? WHERE id = ?")
          .run(timestamp, taskThreadId);
      }
      this.#database
        .prepare("UPDATE jobs SET task_thread_id = ?, updated_at = ? WHERE id = ?")
        .run(taskThreadId, timestamp, jobId);
      this.#appendEvent(jobId, "codex.thread_bound", "Codex Thread 已绑定", {}, timestamp);
      const task = this.#taskForJob(jobId);
      const revision = this.#recordChange(
        "job",
        jobId,
        "codex.thread_bound",
        { projectId: task.projectId, taskId: current.taskId, status: "running" },
        timestamp,
      );
      return { result: this.primaryThread(current.taskId) as TaskThreadBinding, revision };
    });
    this.#notify(mutation.revision);
    return mutation.result;
  }

  bindExistingThread(jobId: string, owner: string, taskThreadId: string): JobView {
    const current = this.#assertOwned(jobId, owner, ["running"]);
    const thread = this.primaryThread(current.taskId);
    if (!thread || thread.id !== taskThreadId) {
      throw new AppError("INVALID_REQUEST", 409, "任务没有可继续的主 Thread");
    }
    const timestamp = this.#now().toISOString();
    this.#database
      .prepare("UPDATE jobs SET task_thread_id = ?, updated_at = ? WHERE id = ?")
      .run(taskThreadId, timestamp, jobId);
    return this.readJob(jobId);
  }

  recordDispatchState(jobId: string, owner: string, state: "not_sent" | "sent"): void {
    const job = this.#assertOwned(jobId, owner, ["running"]);
    this.#database.prepare("UPDATE jobs SET recovery_checkpoint_json = ? WHERE id = ?").run(
      JSON.stringify({
        ...job.recoveryCheckpoint,
        ...(state === "not_sent" ? { turnId: null } : {}),
        dispatchState: state,
        clientUserMessageId: jobId,
      }),
      jobId,
    );
  }

  recordReconciledTurn(cancelJobId: string, owner: string, turnId: string): void {
    const cancel = this.#assertOwned(cancelJobId, owner, ["running"]);
    if (!cancel.targetJobId) throw new AppError("INVALID_REQUEST", 409, "取消目标不存在");
    const target = this.readJob(cancel.targetJobId);
    if (target.status !== "canceling") throw new AppError("INVALID_REQUEST", 409, "取消目标已变化");
    this.#database
      .prepare("UPDATE jobs SET recovery_checkpoint_json = ? WHERE id = ? AND status = 'canceling'")
      .run(JSON.stringify({ ...target.recoveryCheckpoint, turnId, reconciled: true }), target.id);
  }

  recordTurn(jobId: string, owner: string, turnId: string): TaskThreadBinding {
    const current = this.#assertOwned(jobId, owner, [
      "running",
      "waiting_approval",
      "waiting_input",
      "canceling",
    ]);
    if (!current.taskThreadId) {
      throw new AppError("INVALID_REQUEST", 409, "作业尚未绑定 Codex Thread");
    }
    const timestamp = this.#now().toISOString();
    const mutation = withTransaction(this.#database, () => {
      this.#database
        .prepare(
          `UPDATE task_threads SET last_turn_id = ?, status = 'active', updated_at = ? WHERE id = ?`,
        )
        .run(turnId, timestamp, current.taskThreadId);
      this.#database
        .prepare("UPDATE jobs SET recovery_checkpoint_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify({ ...(current.recoveryCheckpoint ?? {}), turnId }), timestamp, jobId);
      this.#appendEvent(jobId, "codex.turn_started", "Codex Turn 已启动", {}, timestamp);
      const task = this.#taskForJob(jobId);
      const revision = this.#recordChange(
        "job",
        jobId,
        "codex.turn_started",
        { projectId: task.projectId, taskId: current.taskId, status: current.status },
        timestamp,
      );
      return { result: this.primaryThread(current.taskId) as TaskThreadBinding, revision };
    });
    this.#notify(mutation.revision);
    return mutation.result;
  }

  appendExecutionEvent(
    jobId: string,
    owner: string,
    event: {
      readonly cursor: string;
      readonly kind: string;
      readonly summary: string;
      readonly safePayload?: Record<string, unknown>;
    },
  ): JobView {
    const current = this.#assertOwned(jobId, owner, [
      "running",
      "waiting_approval",
      "waiting_input",
    ]);
    if (!current.taskThreadId) {
      throw new AppError("INVALID_REQUEST", 409, "作业尚未绑定 Codex Thread");
    }
    const thread = this.primaryThread(current.taskId);
    const alreadyRecorded = this.#database
      .prepare(
        `SELECT 1 FROM job_events
        WHERE job_id = ? AND json_extract(safe_payload_json, '$.eventCursor') = ? LIMIT 1`,
      )
      .get(jobId, event.cursor);
    if (thread?.lastEventCursor === event.cursor || alreadyRecorded) {
      return current;
    }
    const timestamp = this.#now().toISOString();
    const mutation = withTransaction(this.#database, () => {
      this.#database
        .prepare("UPDATE task_threads SET last_event_cursor = ?, updated_at = ? WHERE id = ?")
        .run(event.cursor, timestamp, current.taskThreadId);
      this.#appendEvent(
        jobId,
        event.kind,
        event.summary.slice(0, 2_000),
        { ...(event.safePayload ?? {}), eventCursor: event.cursor },
        timestamp,
      );
      const task = this.#taskForJob(jobId);
      const revision = this.#recordChange(
        "job",
        jobId,
        event.kind,
        { projectId: task.projectId, taskId: current.taskId, status: current.status },
        timestamp,
      );
      return { result: this.readJob(jobId), revision };
    });
    this.#notify(mutation.revision);
    return mutation.result;
  }

  waitForInteraction(
    jobId: string,
    owner: string,
    status: "waiting_approval" | "waiting_input",
  ): JobView {
    const current = this.#assertOwned(jobId, owner, ["running"]);
    return this.#transitionOwned(
      current,
      owner,
      status,
      status === "waiting_input" ? "job.waiting_input" : "job.waiting_approval",
      status === "waiting_input" ? "等待用户输入" : "等待用户审批",
      null,
      null,
    );
  }

  resumeAfterInteraction(jobId: string, owner: string): JobView {
    const current = this.#assertOwned(jobId, owner, ["waiting_approval", "waiting_input"]);
    return this.#transitionOwned(
      current,
      owner,
      "running",
      "job.interaction_resolved",
      "用户响应已送回 Codex",
      null,
      null,
    );
  }

  fail(jobId: string, owner: string, code: string, summary: string): JobView {
    const current = this.#assertOwned(jobId, owner, [
      "running",
      "waiting_approval",
      "waiting_input",
    ]);
    return this.#transitionOwned(
      current,
      owner,
      "failed",
      "job.failed",
      "Codex 执行失败",
      code,
      summary.slice(0, 2_000),
    );
  }

  succeedAndRequestReview(
    jobId: string,
    owner: string,
    payload: Record<string, unknown> = {},
  ): JobView {
    const current = this.#assertOwned(jobId, owner, ["running"]);
    if (
      typeof payload.turnId === "string" &&
      current.recoveryCheckpoint?.turnId !== payload.turnId
    ) {
      throw new AppError("INVALID_REQUEST", 409, "完成事件不属于当前执行轮次");
    }
    const timestamp = this.#now().toISOString();
    const mutation = withTransaction(this.#database, () => {
      const update = this.#database
        .prepare(
          `UPDATE jobs SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
            completed_at = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND status = 'running'`,
        )
        .run(timestamp, timestamp, jobId, owner);
      if (update.changes !== 1) {
        throw new AppError("INVALID_REQUEST", 409, "作业状态或租约已变化");
      }
      const snapshot = z
        .array(z.object({ id: z.uuid(), version: z.number().int().positive() }))
        .parse(current.workContext.commentSnapshot ?? []);
      const consume = this.#database.prepare(
        `UPDATE comments SET executed_at = ? WHERE id = ? AND task_id = ? AND version = ?
         AND deleted_at IS NULL AND executed_at IS NULL`,
      );
      for (const comment of snapshot)
        consume.run(timestamp, comment.id, current.taskId, comment.version);
      this.#appendEvent(jobId, "job.succeeded", "执行已完成", payload, timestamp);
      if (current.taskThreadId) {
        this.#database
          .prepare("UPDATE task_threads SET status = 'completed', updated_at = ? WHERE id = ?")
          .run(timestamp, current.taskThreadId);
      }
      const task = this.#readTask(current.taskId);
      if (
        !["done", "canceled"].includes(task.status) &&
        !hasTaskLifecycleIntent(this.#database, current.taskId)
      ) {
        const hasPendingComments = this.#database
          .prepare(
            `SELECT 1 FROM comments
          WHERE task_id = ? AND executed_at IS NULL AND deleted_at IS NULL LIMIT 1`,
          )
          .get(current.taskId);
        const nextStatus = hasPendingComments ? "todo" : "in_review";
        this.#database
          .prepare(
            `UPDATE tasks SET status = ?, version = version + 1, updated_at = ? WHERE id = ?`,
          )
          .run(nextStatus, timestamp, current.taskId);
        this.#database
          .prepare(
            `INSERT INTO activities (id, task_id, identity_key, kind, changes_json, created_at)
            VALUES (?, ?, NULL, 'task.execution_completed', ?, ?)`,
          )
          .run(
            randomUUID(),
            current.taskId,
            JSON.stringify({ status: { from: task.status, to: nextStatus }, jobId }),
            timestamp,
          );
      }
      const taskInfo = this.#taskForJob(jobId);
      const revision = this.#recordChange(
        "job",
        jobId,
        "job.succeeded",
        { projectId: taskInfo.projectId, taskId: current.taskId, status: "succeeded" },
        timestamp,
      );
      return { result: this.readJob(jobId), revision };
    });
    this.#notify(mutation.revision);
    return mutation.result;
  }

  claimNext(owner: string, scope: JobClaimScope = "any"): JobView | null {
    const timestamp = this.#now().toISOString();
    const leaseExpiresAt = new Date(this.#now().getTime() + this.#leaseDurationMs).toISOString();
    const kinds: readonly JobKind[] =
      scope === "cancel" ? ["cancel"] : scope === "execution" ? ["start", "continue"] : [];
    const mutation = withTransaction(this.#database, (): MutationResult<JobView | null> => {
      const jobId = this.#database
        .prepare(
          `SELECT id FROM jobs
          WHERE status = 'queued'
            AND (? = 0 OR kind IN (?, ?))
          ORDER BY CASE kind WHEN 'cancel' THEN 0 ELSE 1 END, queued_at, rowid
          LIMIT 1`,
        )
        .pluck()
        .get(kinds.length, kinds[0] ?? "", kinds[1] ?? "") as string | undefined;
      if (!jobId) {
        return { result: null, revision: null };
      }
      const update = this.#database
        .prepare(
          `UPDATE jobs SET
            status = 'running', attempt = attempt + 1, lease_owner = ?, lease_expires_at = ?,
            recovery_checkpoint_json = CASE WHEN kind <> 'cancel' THEN json_set(COALESCE(recovery_checkpoint_json, '{}'), '$.dispatchState', 'not_sent', '$.turnId', NULL) ELSE recovery_checkpoint_json END,
            started_at = COALESCE(started_at, ?), updated_at = ?, error_code = NULL, error_summary = NULL
          WHERE id = ? AND status = 'queued'`,
        )
        .run(owner, leaseExpiresAt, timestamp, timestamp, jobId);
      if (update.changes !== 1) {
        return { result: null, revision: null };
      }
      // Submission already froze input. Claim only updates execution status.
      const claimed = this.readJob(jobId);
      if (claimed.kind !== "cancel" && claimed.attempt === 1) {
        const comments = this.#database
          .prepare(
            "SELECT id FROM comments WHERE task_id = ? AND deleted_at IS NULL AND executed_at IS NULL",
          )
          .all(claimed.taskId) as { id: string }[];
        if (comments.length > 0 && !hasTaskLifecycleIntent(this.#database, claimed.taskId)) {
          const task = this.#readTask(claimed.taskId);
          this.#database
            .prepare(
              `UPDATE tasks SET status = 'in_progress',
            version = version + 1, updated_at = ? WHERE id = ? AND status = 'todo'`,
            )
            .run(timestamp, claimed.taskId);
          if (task.status === "todo") {
            this.#database
              .prepare(
                `INSERT INTO activities
              (id, task_id, identity_key, kind, changes_json, created_at)
              VALUES (?, ?, NULL, 'task.execution_started', ?, ?)`,
              )
              .run(
                randomUUID(),
                claimed.taskId,
                JSON.stringify({ status: { from: "todo", to: "in_progress" }, jobId }),
                timestamp,
              );
          }
          this.#recordChange(
            "task",
            claimed.taskId,
            "task.execution_started",
            {
              projectId: task.projectId,
              taskId: claimed.taskId,
              jobId,
              status: task.status === "todo" ? "in_progress" : task.status,
              commentIds: comments.map(({ id }) => id),
            },
            timestamp,
          );
        }
      }
      this.#appendEvent(
        jobId,
        "job.running",
        "执行器已领取作业",
        { attemptOwner: owner },
        timestamp,
      );
      const task = this.#taskForJob(jobId);
      const revision = this.#recordChange(
        "job",
        jobId,
        "job.running",
        { projectId: task.projectId, taskId: task.taskId, status: "running" },
        timestamp,
      );
      return { result: this.readJob(jobId), revision };
    });
    this.#notify(mutation.revision);
    return mutation.result;
  }

  #snapshotWorkContext(taskId: string, baseContext: JobWorkContext): JobWorkContext {
    const comments = this.#database
      .prepare(
        `SELECT id, body, version FROM comments
          WHERE task_id = ? AND deleted_at IS NULL AND executed_at IS NULL
          ORDER BY created_at, rowid`,
      )
      .all(taskId) as { id: string; body: string; version: number }[];
    const attachments = this.#database
      .prepare(
        `SELECT attachments.id, attachments.filename, attachments.comment_id AS commentId
           FROM attachments
           LEFT JOIN comments ON comments.id = attachments.comment_id AND comments.task_id = attachments.task_id
           WHERE attachments.task_id = ? AND attachments.pending_comment = 0 AND (attachments.comment_id IS NULL OR
             (comments.deleted_at IS NULL AND comments.executed_at IS NULL AND comments.id IS NOT NULL))
           ORDER BY attachments.created_at, attachments.id`,
      )
      .all(taskId) as { id: string; filename: string; commentId: string | null }[];
    const temporaryDirectory = resolve(String(baseContext.cwd ?? "."), ".tmp", "taskboard", taskId);
    const attachmentSnapshot = attachments.map((attachment) => {
      const snapshotId = randomUUID();
      const downloadPath = resolve(temporaryDirectory, `attachment-${snapshotId}`);
      const quotedDownloadPath = quoteShellArgument(downloadPath);
      return {
        ...attachment,
        id: snapshotId,
        originalAttachmentId: attachment.id,
        downloadPath,
        downloadUrl: `/api/v1/local/attachments/${snapshotId}`,
        downloadCommand: `${this.#taskctlCommand} attachment download ${snapshotId} --output ${quotedDownloadPath}`,
      };
    });
    const attachmentLines = (commentId: string | null) =>
      attachmentSnapshot
        .filter((attachment) => attachment.commentId === commentId)
        .map(
          (attachment) =>
            `附件名称：${JSON.stringify(attachment.filename)}\n本机管理 API（需 runtime 鉴权）：${attachment.downloadUrl}\n本机下载命令：${attachment.downloadCommand}`,
        );
    const previous = this.listTaskJobs(taskId).find((job) => job.kind !== "cancel");
    const superseded =
      previous && ["failed", "failed_recoverable", "canceled"].includes(previous.status)
        ? previous
        : null;
    const previousComments = z
      .array(z.object({ id: z.uuid(), version: z.number().int().positive() }))
      .parse(superseded?.workContext.commentSnapshot ?? []);
    {
      const modelOptions = this.primaryThread(taskId)?.modelOptions;
      const workContext = {
        ...baseContext,
        ...(modelOptions ? { modelOptions } : {}),
        commentSnapshot: comments.map(({ id, version }) => ({ id, version })),
        commentBodySnapshot: comments,
        attachmentSnapshot,
        ...(superseded ? { supersedesJobId: superseded.id } : {}),
        prompt: [
          "按 $manage-codexboard 执行。",
          String(baseContext.prompt ?? ""),
          ...(superseded
            ? [
                `\n本批次替代上一作业 ${superseded.id} 的未完成指令；以下是当前唯一有效的评论版本。`,
                ...previousComments.map((old) => {
                  const replacement = comments.find((comment) => comment.id === old.id);
                  return replacement
                    ? `评论 ${old.id} v${old.version} 被本批次 v${replacement.version} 替代。`
                    : `评论 ${old.id} v${old.version} 已删除或不再待执行，旧指令失效。`;
                }),
                "请先检查上一轮已产生的文件改动，按照当前指令修正后继续；取消并未回滚文件或外部副作用。",
              ]
            : []),
          ...(attachments.some(({ commentId }) => commentId === null)
            ? ["\n任务描述附件：", ...attachmentLines(null)]
            : []),
          ...(comments.length > 0 ? ["\n尚未执行的人类评论："] : []),
          ...comments.map((comment, index) =>
            [
              `\n${index + 1}. [${comment.id} v${comment.version}]\n${comment.body}`,
              ...attachmentLines(comment.id),
            ].join("\n"),
          ),
        ].join("\n"),
      };
      return JobWorkContextSchema.parse(workContext);
    }
  }

  heartbeat(jobId: string, owner: string, checkpoint?: Record<string, unknown>): JobView {
    const current = this.#assertOwned(jobId, owner, [
      "running",
      "waiting_approval",
      "waiting_input",
    ]);
    const timestamp = this.#now().toISOString();
    const leaseExpiresAt = new Date(this.#now().getTime() + this.#leaseDurationMs).toISOString();
    this.#database
      .prepare(
        `UPDATE jobs SET lease_expires_at = ?, recovery_checkpoint_json = ?, updated_at = ?
        WHERE id = ? AND lease_owner = ? AND status = ?`,
      )
      .run(
        leaseExpiresAt,
        checkpoint
          ? JSON.stringify({ ...current.recoveryCheckpoint, ...checkpoint })
          : JSON.stringify(current.recoveryCheckpoint),
        timestamp,
        jobId,
        owner,
        current.status,
      );
    return this.readJob(jobId);
  }

  releaseForRetry(jobId: string, owner: string, code: string, summary: string): JobView {
    const current = this.#assertOwned(jobId, owner, [
      "running",
      "waiting_approval",
      "waiting_input",
    ]);
    const nextStatus: JobStatus =
      current.attempt < current.maxAttempts ? "queued" : "failed_recoverable";
    return this.#transitionOwned(
      current,
      owner,
      nextStatus,
      nextStatus === "queued" ? "job.retry_queued" : "job.failed_recoverable",
      nextStatus === "queued" ? "执行失败，已等待重试" : "执行失败，需要人工重试",
      code,
      summary,
    );
  }

  holdUncertain(jobId: string, owner: string, code: string, summary: string): JobView {
    const current = this.#assertOwned(jobId, owner, [
      "running",
      "waiting_approval",
      "waiting_input",
    ]);
    return this.#transitionOwned(
      current,
      owner,
      "canceling",
      "job.outcome_unknown",
      "执行状态未确认，保留占用等待核对",
      code,
      summary,
    );
  }

  holdForModelCapacity(jobId: string, owner: string): JobView {
    const current = this.#assertOwned(jobId, owner, [
      "running",
      "waiting_approval",
      "waiting_input",
    ]);
    // This is a known stopped turn. Keep the task/resource active until its owner
    // explicitly cancels; never retry a possibly partially executed prompt here.
    this.heartbeat(jobId, owner, { capacityStopped: true });
    return this.#transitionOwned(
      current,
      owner,
      "running",
      "job.capacity_waiting",
      MODEL_CAPACITY_NOTICE,
      "MODEL_AT_CAPACITY",
      MODEL_CAPACITY_NOTICE,
    );
  }

  succeed(jobId: string, owner: string, payload: Record<string, unknown> = {}): JobView {
    const current = this.#assertOwned(jobId, owner, ["running"]);
    return this.#transitionOwned(
      current,
      owner,
      "succeeded",
      "job.succeeded",
      "执行已完成",
      null,
      null,
      payload,
    );
  }

  requestCancel(
    targetJobId: string,
    context: JobRequestContext,
  ): { readonly target: JobView; readonly cancel: JobView } {
    const hash = requestHash({ targetJobId, kind: "cancel" });
    const replay = this.#idempotentJob(context.idempotencyKey);
    if (replay) {
      if (replay.requestHash !== hash) {
        throw new AppError("DUPLICATE_REQUEST", 409, "幂等键已用于其他取消请求");
      }
      const cancel = this.readJob(replay.id);
      return { target: this.readJob(targetJobId), cancel };
    }
    const timestamp = this.#now().toISOString();
    const cancelJobId = randomUUID();
    let mutation: MutationResult<{ target: JobView; cancel: JobView }>;
    try {
      mutation = withTransaction(this.#database, () => {
        const target = this.readJob(targetJobId);
        if (target.kind === "cancel")
          throw new AppError("INVALID_REQUEST", 409, "取消请求不能作为执行目标");
        const existingId = this.#database
          .prepare(
            "SELECT id FROM jobs WHERE target_job_id = ? AND kind = 'cancel' ORDER BY queued_at DESC, rowid DESC LIMIT 1",
          )
          .pluck()
          .get(targetJobId) as string | undefined;
        if (existingId) {
          const existing = this.readJob(existingId);
          if (!["failed", "failed_recoverable"].includes(existing.status)) {
            return { result: { target, cancel: existing }, revision: null };
          }
        }
        const terminal = ["succeeded", "failed", "failed_recoverable", "canceled"].includes(
          target.status,
        );
        const immediate =
          target.status === "queued" ||
          terminal ||
          target.recoveryCheckpoint?.capacityStopped === true;
        if (!terminal)
          this.#database
            .prepare(
              `UPDATE jobs SET status = ?, cancel_requested_at = ?, completed_at = ?, updated_at = ?,
              error_code = NULL, error_summary = NULL WHERE id = ?`,
            )
            .run(
              immediate ? "canceled" : "canceling",
              timestamp,
              immediate ? timestamp : null,
              timestamp,
              targetJobId,
            );
        this.#database
          .prepare(
            `INSERT INTO jobs (
              id, task_id, task_thread_id, target_job_id, kind, status, execution_key,
              idempotency_key, request_hash, requested_by_identity_key, max_attempts,
              work_context_json, queued_at, started_at, completed_at, updated_at
            ) VALUES (?, ?, ?, ?, 'cancel', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
          )
          .run(
            cancelJobId,
            target.taskId,
            target.taskThreadId,
            targetJobId,
            immediate ? "succeeded" : "queued",
            `cancel:${targetJobId}`,
            context.idempotencyKey,
            hash,
            identityKey(context.actor.identity),
            JSON.stringify(target.workContext),
            timestamp,
            immediate ? timestamp : null,
            immediate ? timestamp : null,
            timestamp,
          );
        this.#appendEvent(
          targetJobId,
          "job.cancel_requested",
          terminal ? "作业已结束，无需取消" : immediate ? "排队作业已取消" : "已请求取消运行中作业",
          { cancelJobId },
          timestamp,
        );
        this.#appendEvent(
          cancelJobId,
          immediate ? "job.succeeded" : "job.queued",
          terminal ? "作业已结束，无需取消" : immediate ? "取消已完成" : "取消请求已进入队列",
          { targetJobId },
          timestamp,
        );
        if (immediate && !terminal) this.#returnTaskToTodo(target, timestamp);
        const task = this.#taskForJob(targetJobId);
        const revision = this.#recordChange(
          "job",
          targetJobId,
          terminal ? "job.cancel_noop" : immediate ? "job.canceled" : "job.canceling",
          {
            projectId: task.projectId,
            taskId: target.taskId,
            cancelJobId,
            status: terminal ? target.status : immediate ? "canceled" : "canceling",
          },
          timestamp,
        );
        this.#recordAudit(
          context,
          "job.cancel",
          targetJobId,
          { cancelJobId, immediate },
          timestamp,
        );
        return {
          result: { target: this.readJob(targetJobId), cancel: this.readJob(cancelJobId) },
          revision,
        };
      });
    } catch (error: unknown) {
      if (this.#isConstraint(error)) {
        throw new AppError("DUPLICATE_REQUEST", 409, "该作业已有活动取消请求");
      }
      throw error;
    }
    this.#notify(mutation.revision);
    return mutation.result;
  }

  confirmCancellationFromExecution(jobId: string, owner: string, turnId: string): JobView {
    const target = this.#assertOwned(jobId, owner, ["canceling"]);
    if (target.recoveryCheckpoint?.turnId !== turnId)
      throw new AppError("INVALID_REQUEST", 409, "停止事件不属于当前执行轮次");
    return this.#confirmStoppedCancellation(target, owner, { turnId });
  }

  confirmCancellationBeforeDispatch(jobId: string, owner: string): JobView {
    const target = this.#assertOwned(jobId, owner, ["canceling"]);
    if (target.recoveryCheckpoint?.turnId)
      throw new AppError("INVALID_REQUEST", 409, "执行已关联远端轮次，必须确认远端停止");
    return this.#confirmStoppedCancellation(target, owner, { beforeDispatch: true });
  }

  #confirmStoppedCancellation(
    target: JobView,
    owner: string,
    evidence: Record<string, unknown>,
  ): JobView {
    const jobId = target.id;
    const timestamp = this.#now().toISOString();
    const mutation = withTransaction(this.#database, () => {
      const changed = this.#database
        .prepare(
          `UPDATE jobs SET status = 'canceled', completed_at = ?,
        lease_owner = NULL, lease_expires_at = NULL, error_code = NULL, error_summary = NULL, updated_at = ?
        WHERE id = ? AND status = 'canceling' AND lease_owner = ?`,
        )
        .run(timestamp, timestamp, jobId, owner);
      if (changed.changes !== 1) throw new AppError("INVALID_REQUEST", 409, "作业状态或租约已变化");
      const cancelId = this.#database
        .prepare(
          "SELECT id FROM jobs WHERE target_job_id = ? AND kind = 'cancel' ORDER BY queued_at DESC, rowid DESC LIMIT 1",
        )
        .pluck()
        .get(jobId) as string | undefined;
      if (cancelId) {
        const cancellation = this.readJob(cancelId);
        if (["queued", "running"].includes(cancellation.status)) {
          if (cancellation.status === "queued")
            this.#database.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(cancelId);
          this.#database
            .prepare(
              `UPDATE jobs SET status = 'succeeded', completed_at = ?, lease_owner = NULL,
            lease_expires_at = NULL, error_code = NULL, error_summary = NULL, updated_at = ? WHERE id = ?`,
            )
            .run(timestamp, timestamp, cancelId);
          this.#appendEvent(cancelId, "job.succeeded", "当前轮次已确认停止", evidence, timestamp);
        }
      }
      this.#returnTaskToTodo(target, timestamp);
      this.#appendEvent(jobId, "job.canceled", "当前轮次已确认停止", evidence, timestamp);
      const task = this.#taskForJob(jobId);
      const revision = this.#recordChange(
        "job",
        jobId,
        "job.canceled",
        { ...task, status: "canceled" },
        timestamp,
      );
      return { result: this.readJob(jobId), revision };
    });
    this.#notify(mutation.revision);
    return mutation.result;
  }

  completeCancellation(
    cancelJobId: string,
    owner: string,
  ): { readonly target: JobView; readonly cancel: JobView } {
    const cancel = this.#assertOwned(cancelJobId, owner, ["running"]);
    if (cancel.kind !== "cancel" || !cancel.targetJobId) {
      throw new AppError("INVALID_REQUEST", 409, "该作业不是取消请求");
    }
    const timestamp = this.#now().toISOString();
    const mutation = withTransaction(this.#database, () => {
      const target = this.readJob(cancel.targetJobId as string);
      if (target.status !== "canceling") {
        throw new AppError("INVALID_REQUEST", 409, "目标作业不在取消中");
      }
      this.#database
        .prepare(
          `UPDATE jobs SET status = 'canceled', completed_at = ?, lease_owner = NULL,
            lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(timestamp, timestamp, target.id);
      this.#database
        .prepare(
          `UPDATE jobs SET status = 'succeeded', completed_at = ?, lease_owner = NULL,
            lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_owner = ?`,
        )
        .run(timestamp, timestamp, cancel.id, owner);
      this.#returnTaskToTodo(target, timestamp);
      this.#appendEvent(target.id, "job.canceled", "执行已取消", {}, timestamp);
      this.#appendEvent(cancel.id, "job.succeeded", "取消请求已完成", {}, timestamp);
      const task = this.#taskForJob(target.id);
      const revision = this.#recordChange(
        "job",
        target.id,
        "job.canceled",
        { projectId: task.projectId, taskId: target.taskId, status: "canceled" },
        timestamp,
      );
      return {
        result: { target: this.readJob(target.id), cancel: this.readJob(cancel.id) },
        revision,
      };
    });
    this.#notify(mutation.revision);
    return mutation.result;
  }

  failCancellation(
    cancelJobId: string,
    owner: string,
    code: string,
    summary: string,
  ): { readonly target: JobView; readonly cancel: JobView } {
    const cancel = this.#assertOwned(cancelJobId, owner, ["running"]);
    if (cancel.kind !== "cancel" || !cancel.targetJobId) {
      throw new AppError("INVALID_REQUEST", 409, "该作业不是取消请求");
    }
    const timestamp = this.#now().toISOString();
    const safeSummary = summary.slice(0, 2_000);
    const mutation = withTransaction(this.#database, () => {
      const target = this.readJob(cancel.targetJobId as string);
      if (target.status !== "canceling") {
        throw new AppError("INVALID_REQUEST", 409, "目标作业不在取消中");
      }
      this.#database
        .prepare(
          `UPDATE jobs SET error_code = ?, error_summary = ?,
            completed_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'canceling'`,
        )
        .run(code, safeSummary, timestamp, target.id);
      this.#database
        .prepare(
          `UPDATE jobs SET status = 'failed_recoverable', error_code = ?, error_summary = ?,
            completed_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE id = ? AND lease_owner = ? AND status = 'running'`,
        )
        .run(code, safeSummary, timestamp, timestamp, cancel.id, owner);
      this.#appendEvent(
        target.id,
        "job.canceling",
        "取消指令未能确认送达，仍保留执行占用，可重试取消以核对远端状态",
        {},
        timestamp,
      );
      this.#appendEvent(
        cancel.id,
        "job.failed_recoverable",
        "取消请求执行失败，需要人工处理",
        {},
        timestamp,
      );
      const task = this.#taskForJob(target.id);
      const revision = this.#recordChange(
        "job",
        target.id,
        "job.failed_recoverable",
        { projectId: task.projectId, taskId: target.taskId, status: "canceling" },
        timestamp,
      );
      return {
        result: { target: this.readJob(target.id), cancel: this.readJob(cancel.id) },
        revision,
      };
    });
    this.#notify(mutation.revision);
    return mutation.result;
  }

  observedJobs(): readonly JobView[] {
    const ids = this.#database
      .prepare(
        `SELECT jobs.id FROM jobs
      JOIN tasks ON tasks.id = jobs.task_id
      JOIN task_threads ON task_threads.id = jobs.task_thread_id AND task_threads.is_primary = 1
      WHERE tasks.archived_at IS NULL AND tasks.status NOT IN ('done', 'canceled')
      AND jobs.kind != 'cancel' AND jobs.rowid = (
        SELECT MAX(latest.rowid) FROM jobs latest WHERE latest.task_id = jobs.task_id AND latest.kind != 'cancel'
      ) ORDER BY jobs.rowid`,
      )
      .pluck()
      .all() as string[];
    return ids.map((id) => this.readJob(id));
  }

  syncThreadHistory(jobId: string, history: CodexThreadHistory): number {
    const mutation = withTransaction(this.#database, () => {
      const job = this.readJob(jobId);
      const thread = this.primaryThread(job.taskId);
      const task = this.#taskForJob(jobId);
      if (
        !thread ||
        thread.id !== job.taskThreadId ||
        thread.threadId !== history.threadId ||
        job.status === "canceled" ||
        hasTaskLifecycleIntent(this.#database, job.taskId) ||
        !this.observedJobs().some((candidate) => candidate.id === jobId)
      )
        return { count: 0, revision: null };
      const taskJobs = this.listTaskJobs(job.taskId);
      const boardClientIds = new Set(taskJobs.map((candidate) => candidate.id));
      const activeBoardJob = taskJobs.some((candidate) =>
        ["queued", "running", "waiting_input", "waiting_approval", "canceling"].includes(
          candidate.status,
        ),
      );
      const anchors = new Map(
        taskJobs
          .filter(
            (candidate) => candidate.kind !== "cancel" && candidate.taskThreadId === thread.id,
          )
          .map((candidate) => [candidate.recoveryCheckpoint?.turnId, candidate]),
      );
      if (!history.turns.some((turn) => anchors.has(turn.id))) return { count: 0, revision: null };
      const timestamp = this.#now().toISOString();
      const anchorIndex = history.turns.findIndex((turn) => anchors.has(turn.id));
      const desktopActive = history.turns
        .slice(anchorIndex)
        .some((turn) => !anchors.has(turn.id) && turn.status === "inProgress");
      // Only the latest turn can drive the task status; an older Desktop reply
      // must not override a later board-dispatched turn.
      const latestTurn = history.turns.at(-1);
      const desktopTurn = latestTurn && !anchors.has(latestTurn.id) ? latestTurn : undefined;
      const hasCurrentAnchor = history.turns.some(
        (turn) => turn.id === job.recoveryCheckpoint?.turnId,
      );
      const previousState = this.#database
        .prepare(
          `SELECT json_extract(job_events.safe_payload_json, '$.active') AS active,
          json_extract(job_events.safe_payload_json, '$.turnId') AS turnId,
          json_extract(job_events.safe_payload_json, '$.turnStatus') AS turnStatus
        FROM job_events JOIN jobs ON jobs.id = job_events.job_id WHERE jobs.task_thread_id = ? AND job_events.kind = 'codex.desktop_state'
        ORDER BY job_events.rowid DESC LIMIT 1`,
        )
        .get(thread.id) as
        { active: number; turnId: string | null; turnStatus: string | null } | undefined;
      const stateChanged =
        Boolean(previousState?.active) !== desktopActive ||
        (desktopTurn !== undefined &&
          (previousState?.turnId !== desktopTurn.id ||
            previousState?.turnStatus !== desktopTurn.status));
      if (stateChanged)
        this.#appendEvent(
          jobId,
          "codex.desktop_state",
          desktopActive ? "Desktop 对话正在执行" : "Desktop 对话执行已结束",
          {
            active: desktopActive,
            turnId: desktopTurn?.id ?? null,
            turnStatus: desktopTurn?.status ?? null,
          },
          timestamp,
        );
      const desktopFinished =
        desktopTurn && ["completed", "failed", "interrupted"].includes(desktopTurn.status);
      let taskStatusChanged = false;
      if (
        !activeBoardJob &&
        hasCurrentAnchor &&
        desktopTurn &&
        (desktopActive || (stateChanged && desktopFinished))
      ) {
        const currentTask = this.#readTask(job.taskId);
        const nextStatus = desktopActive ? "in_progress" : "in_review";
        if (currentTask.status !== nextStatus) {
          this.#database
            .prepare(
              `UPDATE tasks SET status = ?, blocked_from_status = NULL,
              version = version + 1, updated_at = ? WHERE id = ?`,
            )
            .run(nextStatus, timestamp, job.taskId);
          const kind = desktopActive ? "task.execution_started" : "task.execution_completed";
          this.#database
            .prepare(
              `INSERT INTO activities (id, task_id, identity_key, kind, changes_json, created_at)
              VALUES (?, ?, NULL, ?, ?, ?)`,
            )
            .run(
              randomUUID(),
              job.taskId,
              kind,
              JSON.stringify({
                status: { from: currentTask.status, to: nextStatus },
                jobId,
                source: "desktop",
                turnId: desktopTurn?.id,
              }),
              timestamp,
            );
          this.#recordChange(
            "task",
            job.taskId,
            kind,
            { projectId: task.projectId, taskId: job.taskId, status: nextStatus },
            timestamp,
          );
          taskStatusChanged = true;
        }
      }
      let count = 0;
      let source: JobView | undefined;
      for (const turn of history.turns) {
        source = anchors.get(turn.id) ?? source;
        if (!source) continue;
        for (const event of turn.events) {
          const user = event.kind === "codex.user_message";
          if (user) {
            const clientId = event.safePayload?.clientId;
            // Board-dispatched prompts already exist as task descriptions/comments.
            if (typeof clientId === "string" && boardClientIds.has(clientId)) continue;
            if (
              anchors.has(turn.id) &&
              !clientId &&
              event.safePayload?.itemType !== "steeringUserMessage"
            )
              continue;
          } else if (
            event.kind !== "codex.agent_message" ||
            event.safePayload?.phase !== "final_answer" ||
            !["completed", "failed", "interrupted"].includes(turn.status) ||
            !["succeeded", "failed", "failed_recoverable"].includes(source.status) ||
            activeBoardJob
          )
            continue;
          const exists = this.#database
            .prepare(
              `SELECT 1 FROM job_events JOIN jobs ON jobs.id = job_events.job_id
            WHERE jobs.task_thread_id = ? AND (
              json_extract(job_events.safe_payload_json, '$.eventCursor') = ? OR
              (? = 1 AND job_events.kind = 'codex.user_message' AND EXISTS (
                SELECT 1 FROM json_each(job_events.safe_payload_json, '$.messageIds') existing
                JOIN json_each(?) incoming ON incoming.value = existing.value
              ))
            )`,
            )
            .get(
              thread.id,
              event.cursor,
              user ? 1 : 0,
              JSON.stringify(event.safePayload?.messageIds ?? []),
            );
          if (exists) continue;
          this.#appendEvent(
            source.id,
            event.kind,
            event.summary,
            { ...event.safePayload, eventCursor: event.cursor },
            timestamp,
          );
          count++;
        }
      }
      const revision =
        count || stateChanged || taskStatusChanged
          ? this.#recordChange(
              "job",
              jobId,
              "codex.history_synced",
              { projectId: task.projectId, taskId: job.taskId, status: job.status },
              timestamp,
            )
          : null;
      return { count, revision };
    });
    this.#notify(mutation.revision);
    return mutation.count;
  }

  syncWorkspace(jobId: string, expectedCwd: string, context: { id: string; cwd: string }): boolean {
    const mutation = withTransaction(this.#database, () => {
      const job = this.readJob(jobId);
      const thread = this.primaryThread(job.taskId);
      const task = this.#taskForJob(jobId);
      if (
        !thread ||
        thread.id !== job.taskThreadId ||
        thread.cwd !== expectedCwd ||
        ["canceled", "canceling"].includes(job.status) ||
        hasTaskLifecycleIntent(this.#database, job.taskId) ||
        !this.observedJobs().some((candidate) => candidate.id === jobId)
      )
        return { result: false, revision: null };
      assertWorkspaceLifecycleAvailable(this.#database, context.cwd);
      const timestamp = this.#now().toISOString();
      this.#database
        .prepare("UPDATE task_threads SET cwd = ?, updated_at = ? WHERE id = ?")
        .run(context.cwd, timestamp, thread.id);
      this.#database
        .prepare(
          "UPDATE tasks SET development_context_json = ?, version = version + 1, updated_at = ? WHERE id = ?",
        )
        .run(JSON.stringify({ id: context.id }), timestamp, job.taskId);
      const revision = this.#recordChange(
        "task",
        job.taskId,
        "task.workspace_synced",
        { projectId: task.projectId, taskId: job.taskId, workingDirectory: context.cwd },
        timestamp,
      );
      return { result: true, revision };
    });
    this.#notify(mutation.revision);
    return mutation.result;
  }

  uncertainJobs(): readonly JobView[] {
    const ids = this.#database
      .prepare(
        `SELECT id FROM jobs WHERE kind != 'cancel' AND status = 'canceling'
      AND cancel_requested_at IS NULL AND error_code IN ('CODEX_OUTCOME_UNKNOWN', 'CONNECTOR_DISCONNECTED', 'RESTART_UNCERTAIN')
      ORDER BY updated_at, rowid`,
      )
      .pluck()
      .all() as string[];
    return ids.map((id) => this.readJob(id));
  }

  recoverableResultJobs(): readonly JobView[] {
    const ids = this.#database
      .prepare(
        `SELECT jobs.id FROM jobs JOIN tasks ON tasks.id = jobs.task_id
      WHERE jobs.kind != 'cancel' AND jobs.status = 'failed' AND jobs.cancel_requested_at IS NULL
      AND jobs.error_code IN ('TURN_INTERRUPTED', 'TURN_FAILED')
      AND json_extract(jobs.recovery_checkpoint_json, '$.recoveredTurnId') IS NOT NULL
      AND tasks.archived_at IS NULL AND tasks.status NOT IN ('done', 'canceled')`,
      )
      .pluck()
      .all() as string[];
    return [...this.uncertainJobs(), ...ids.map((id) => this.readJob(id))];
  }

  completeRecovered(jobId: string, owner: string, outcome: CodexRecoveredOutcome): JobView | null {
    return withTransaction(this.#database, () => {
      const current = this.readJob(jobId);
      const thread = this.primaryThread(current.taskId);
      if (
        !this.recoverableResultJobs().some((job) => job.id === jobId) ||
        !thread ||
        current.taskThreadId !== thread.id ||
        thread.threadId !== outcome.threadId ||
        (typeof current.recoveryCheckpoint?.turnId === "string" &&
          current.recoveryCheckpoint.turnId !== outcome.turnId) ||
        hasTaskLifecycleIntent(this.#database, current.taskId)
      )
        return null;
      if (current.status === "failed" && outcome.status !== "completed") return null;
      const timestamp = this.#now().toISOString();
      // Correct a historical recovery error without consuming a newer job's
      // comments, changing its lease, or moving the task underneath it.
      if (
        current.status === "failed" &&
        this.listTaskJobs(current.taskId).find((job) => job.kind !== "cancel")?.id !== jobId
      ) {
        this.#database
          .prepare(
            `UPDATE jobs SET status = 'succeeded', error_code = NULL,
          error_summary = NULL, recovery_checkpoint_json = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            JSON.stringify({ ...current.recoveryCheckpoint, correctedTurnId: outcome.turnId }),
            timestamp,
            jobId,
          );
        for (const event of outcome.events) {
          if (
            this.#database
              .prepare(
                `SELECT 1 FROM job_events WHERE job_id = ? AND json_extract(safe_payload_json, '$.eventCursor') = ?`,
              )
              .get(jobId, event.cursor)
          )
            continue;
          this.#appendEvent(
            jobId,
            event.kind,
            event.summary,
            { ...event.safePayload, eventCursor: event.cursor },
            timestamp,
          );
        }
        this.#appendEvent(
          jobId,
          "job.result_corrected",
          "Desktop 已确认原回合完成，修正先前恢复误判",
          { turnId: outcome.turnId },
          timestamp,
        );
        const task = this.#taskForJob(jobId);
        const revision = this.#recordChange(
          "job",
          jobId,
          "job.result_corrected",
          { projectId: task.projectId, taskId: current.taskId, status: "succeeded" },
          timestamp,
        );
        this.#notify(revision);
        return this.readJob(jobId);
      }
      this.#database
        .prepare(
          `UPDATE jobs SET status = 'running', lease_owner = ?, error_code = NULL, error_summary = NULL,
        recovery_checkpoint_json = ?, updated_at = ? WHERE id = ? AND status IN ('canceling', 'failed') AND cancel_requested_at IS NULL`,
        )
        .run(
          owner,
          JSON.stringify({
            ...current.recoveryCheckpoint,
            turnId: outcome.turnId,
            recoveredTurnId: outcome.turnId,
            ...(current.status === "failed" ? { correctedTurnId: outcome.turnId } : {}),
          }),
          timestamp,
          jobId,
        );
      this.#appendEvent(
        jobId,
        "job.result_recovered",
        "已从原 Codex 回合恢复执行结果",
        { turnId: outcome.turnId },
        timestamp,
      );
      for (const event of outcome.events) this.appendExecutionEvent(jobId, owner, event);
      if (outcome.status === "completed")
        return this.succeedAndRequestReview(jobId, owner, { turnId: outcome.turnId });
      return this.fail(
        jobId,
        owner,
        outcome.status === "interrupted" ? "TURN_INTERRUPTED" : "TURN_FAILED",
        outcome.status === "interrupted" ? "Codex Turn 已中断" : "Codex Turn 执行失败",
      );
    });
  }

  recoverAfterRestart(): readonly JobView[] {
    const candidates = this.#database
      .prepare(
        `SELECT id FROM jobs
        WHERE status IN ('running', 'waiting_approval', 'waiting_input', 'canceling')
          AND NOT (status = 'running' AND COALESCE(json_extract(recovery_checkpoint_json, '$.capacityStopped'), 0) = 1)
        ORDER BY queued_at, rowid`,
      )
      .pluck()
      .all() as string[];
    const recovered: JobView[] = [];
    for (const jobId of candidates) {
      const timestamp = this.#now().toISOString();
      const mutation = withTransaction(this.#database, () => {
        const isCancellation = this.readJob(jobId).kind === "cancel";
        const eventKind = isCancellation ? "job.failed_recoverable" : "job.outcome_unknown";
        this.#database
          .prepare(
            `UPDATE jobs SET status = CASE WHEN kind = 'cancel' THEN 'failed_recoverable' ELSE 'canceling' END, error_code = 'RESTART_UNCERTAIN',
              error_summary = '服务重启后无法证明该执行可安全恢复', completed_at = CASE WHEN kind = 'cancel' THEN ? ELSE NULL END,
              lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(timestamp, timestamp, jobId);
        this.#appendEvent(
          jobId,
          eventKind,
          "服务重启后执行状态不确定，需核对远端停止状态",
          {},
          timestamp,
        );
        const task = this.#taskForJob(jobId);
        const revision = this.#recordChange(
          "job",
          jobId,
          eventKind,
          {
            projectId: task.projectId,
            taskId: task.taskId,
            status: isCancellation ? "failed_recoverable" : "canceling",
          },
          timestamp,
        );
        return { result: this.readJob(jobId), revision };
      });
      recovered.push(mutation.result);
      this.#notify(mutation.revision);
    }
    return recovered;
  }

  #transitionOwned(
    current: JobView,
    owner: string,
    nextStatus: JobStatus,
    eventKind: string,
    eventSummary: string,
    errorCode: string | null,
    errorSummary: string | null,
    payload: Record<string, unknown> = {},
  ): JobView {
    const timestamp = this.#now().toISOString();
    const terminal = ["succeeded", "failed", "failed_recoverable", "canceled"].includes(nextStatus);
    const releaseLease = terminal || nextStatus === "queued";
    const mutation = withTransaction(this.#database, () => {
      const update = this.#database
        .prepare(
          `UPDATE jobs SET status = ?, error_code = ?, error_summary = ?,
            lease_owner = ?, lease_expires_at = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND lease_owner = ? AND status = ?`,
        )
        .run(
          nextStatus,
          errorCode,
          errorSummary,
          releaseLease ? null : owner,
          releaseLease ? null : current.leaseExpiresAt,
          terminal ? timestamp : null,
          timestamp,
          current.id,
          owner,
          current.status,
        );
      if (update.changes !== 1) {
        throw new AppError("INVALID_REQUEST", 409, "作业状态或租约已变化");
      }
      if (
        nextStatus === "queued" &&
        current.kind !== "cancel" &&
        !hasTaskLifecycleIntent(this.#database, current.taskId)
      ) {
        this.#database
          .prepare(
            "UPDATE tasks SET status = 'in_progress', version = version + 1, updated_at = ? WHERE id = ? AND status NOT IN ('done', 'canceled', 'in_progress')",
          )
          .run(timestamp, current.taskId);
      }
      if (terminal && current.kind !== "cancel" && nextStatus !== "succeeded")
        this.#returnTaskToTodo(current, timestamp);
      this.#appendEvent(current.id, eventKind, eventSummary, payload, timestamp);
      const task = this.#taskForJob(current.id);
      const revision = this.#recordChange(
        "job",
        current.id,
        eventKind,
        { projectId: task.projectId, taskId: current.taskId, status: nextStatus },
        timestamp,
      );
      return { result: this.readJob(current.id), revision };
    });
    this.#notify(mutation.revision);
    return mutation.result;
  }

  #returnTaskToTodo(job: JobView, timestamp: string): void {
    const task = this.#readTask(job.taskId);
    if (
      ["done", "canceled", "todo"].includes(task.status) ||
      hasTaskLifecycleIntent(this.#database, job.taskId)
    )
      return;
    this.#database
      .prepare(
        "UPDATE tasks SET status = 'todo', version = version + 1, updated_at = ? WHERE id = ?",
      )
      .run(timestamp, job.taskId);
    this.#recordChange(
      "task",
      job.taskId,
      "task.execution_stopped",
      { projectId: task.projectId, taskId: job.taskId, jobId: job.id, status: "todo" },
      timestamp,
    );
  }

  #assertOwned(jobId: string, owner: string, statuses: readonly JobStatus[]): JobView {
    const job = this.readJob(jobId);
    if (!statuses.includes(job.status) || job.leaseOwner !== owner) {
      throw new AppError("INVALID_REQUEST", 409, "作业状态或执行租约已变化");
    }
    return job;
  }

  #idempotentJob(idempotencyKey: string): { id: string; requestHash: string } | null {
    const row = this.#database
      .prepare("SELECT id, request_hash AS requestHash FROM jobs WHERE idempotency_key = ?")
      .get(idempotencyKey);
    return row ? RawIdempotentJobSchema.parse(row) : null;
  }

  #readTask(taskId: string) {
    const task = RawTaskSchema.safeParse(
      this.#database
        .prepare(
          `SELECT project_id AS projectId, identifier, status, archived_at AS archivedAt
          FROM tasks WHERE id = ?`,
        )
        .get(taskId),
    );
    if (!task.success) {
      throw new AppError("NOT_FOUND", 404, "任务不存在");
    }
    return task.data;
  }

  #taskForJob(jobId: string): { taskId: string; projectId: string } {
    const row = this.#database
      .prepare(
        `SELECT jobs.task_id AS taskId, tasks.project_id AS projectId
        FROM jobs JOIN tasks ON tasks.id = jobs.task_id WHERE jobs.id = ?`,
      )
      .get(jobId) as { taskId: string; projectId: string } | undefined;
    if (!row) {
      throw new AppError("NOT_FOUND", 404, "执行作业关联的任务不存在");
    }
    return row;
  }

  #appendEvent(
    jobId: string,
    kind: string,
    summary: string,
    safePayload: Record<string, unknown>,
    timestamp: string,
  ): void {
    const nextSequence = this.#database
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 FROM job_events WHERE job_id = ?")
      .pluck()
      .get(jobId) as number;
    this.#database
      .prepare(
        `INSERT INTO job_events (
          id, job_id, seq, kind, summary, safe_payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        jobId,
        nextSequence,
        kind,
        summary,
        JSON.stringify(safePayload),
        timestamp,
      );
  }

  #recordChange(
    aggregateType: "task" | "job",
    aggregateId: string,
    eventType: string,
    safePayload: Record<string, unknown>,
    timestamp: string,
  ): number {
    const result = this.#database
      .prepare(
        `INSERT INTO change_events (
          aggregate_type, aggregate_id, event_type, safe_payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(aggregateType, aggregateId, eventType, JSON.stringify(safePayload), timestamp);
    return Number(result.lastInsertRowid);
  }

  #recordAudit(
    context: JobRequestContext,
    action: string,
    resourceId: string,
    metadata: Record<string, unknown>,
    timestamp: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO audit_events (
          id, identity_key, action, resource_type, resource_id, outcome,
          request_id, safe_metadata_json, created_at
        ) VALUES (?, ?, ?, 'job', ?, 'allowed', ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        identityKey(context.actor.identity),
        action,
        resourceId,
        context.requestId ?? null,
        JSON.stringify(metadata),
        timestamp,
      );
  }

  #notify(revision: number | null): void {
    if (revision !== null) {
      this.#onRevisionCommitted?.(revision);
    }
  }

  #isConstraint(error: unknown): boolean {
    return (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      error.code.startsWith("SQLITE_CONSTRAINT")
    );
  }
}
