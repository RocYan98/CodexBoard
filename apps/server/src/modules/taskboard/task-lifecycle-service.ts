import { hasActiveDesktopTurn } from "./desktop-execution-state.js";
import {
  identityKey,
  identityFromKey,
  IdentityKeySchema,
  TEMPORARY_PROJECT_ID,
} from "@codexboard/contracts";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  PrincipalViewSchema,
  TaskLifecycleCommandSchema,
  TaskLifecycleViewSchema,
  TaskMutationResultSchema,
  type PrincipalView,
  type TaskLifecycleCommand,
  type TaskLifecycleView,
  type TaskMutationResult,
} from "@codexboard/contracts";
import { z } from "zod";
import { AppError } from "../../app-error.js";
import type { SqliteDatabase } from "../database/index.js";
import type { ExecutionQueue } from "../execution/index.js";
import {
  canonicalGitDirectory,
  type TaskGitFinalizer,
  type TaskGitSnapshot,
} from "./task-git-finalizer.js";
import { assertGitManagementAvailable, workspaceResourceKeys } from "./task-lifecycle-guard.js";
import { assertTaskEditable } from "./task-readonly.js";
import type { MutationContext, Taskboard } from "./taskboard.js";

const ACTIVE = "'queued', 'running', 'waiting_approval', 'waiting_input', 'canceling'";
const OperationSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  principalKey: IdentityKeySchema,
  requestHash: z.string(),
  targetStatus: z.enum(["done", "canceled"]),
  status: z.enum(["pending", "running", "failed", "succeeded", "abandoned"]),
  phase: z.enum(["checking", "canceling", "committing", "cleaning", "completed"]),
  expectedVersion: z.number(),
  snapshotJson: z.string().nullable(),
  errorSummary: z.string().nullable(),
  resultJson: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
type Operation = z.infer<typeof OperationSchema>;
interface Options {
  readonly database: SqliteDatabase;
  readonly taskboard: Taskboard;
  readonly queue: ExecutionQueue;
  readonly gitFinalizer: Pick<TaskGitFinalizer, "inspect" | "verify">;
  readonly scheduleExecution: () => void;
  readonly onRevisionCommitted?: (revision: number) => void;
  readonly cancellationTimeoutMs?: number;
}

export class TaskLifecycleService {
  readonly #options: Options;
  readonly #running = new Map<string, Promise<TaskMutationResult>>();
  #closing = false;
  constructor(options: Options) {
    this.#options = options;
  }

  request(
    taskId: string,
    input: TaskLifecycleCommand,
    context: MutationContext,
  ): TaskLifecycleView {
    const command = TaskLifecycleCommandSchema.parse(input);
    const { database, taskboard } = this.#options;
    const visible = taskboard.readTask(taskId, context.actor);
    if (!visible.permissions.canWrite) throw new AppError("FORBIDDEN", 403, "没有该任务写入权限");
    const hash = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    const operationId = database
      .transaction(() => {
        const replay = database
          .prepare(
            "SELECT id, request_hash AS hash FROM task_lifecycle_operations WHERE task_id = ? AND identity_key = ? AND idempotency_key = ?",
          )
          .get(taskId, identityKey(context.actor.identity), context.idempotencyKey) as
          { id: string; hash: string } | undefined;
        if (replay) {
          if (replay.hash !== hash)
            throw new AppError("DUPLICATE_REQUEST", 409, "幂等键已用于其他任务操作");
          return replay.id;
        }
        const task = taskboard.readTask(taskId, context.actor);
        assertTaskEditable(task);
        if (task.version !== command.expectedVersion)
          throw new AppError("VERSION_CONFLICT", 409, "任务版本已变化，请重新加载");
        if (task.archivedAt) throw new AppError("INVALID_REQUEST", 409, "已归档任务不能取消或收尾");
        if (
          database
            .prepare("SELECT 1 FROM projects WHERE id = ? AND archived_at IS NOT NULL")
            .get(task.projectId)
        )
          throw new AppError("INVALID_REQUEST", 409, "已归档项目不能取消或收尾任务");
        if (database.prepare("SELECT 1 FROM task_delete_leases WHERE task_id = ?").get(taskId))
          throw new AppError("VERSION_CONFLICT", 409, "任务正在删除");
        const previous = database
          .prepare(
            "SELECT id FROM task_lifecycle_operations WHERE task_id = ? AND status IN ('pending', 'running', 'failed')",
          )
          .get(taskId) as { id: string } | undefined;
        if (previous) {
          const current = this.#operation(previous.id);
          if (current.targetStatus === command.targetStatus) return current.id;
          if (current.status !== "failed" || command.targetStatus !== "canceled")
            throw new AppError("VERSION_CONFLICT", 409, "任务已有进行中的终态操作");
          database
            .prepare(
              "UPDATE task_lifecycle_operations SET status = 'abandoned', updated_at = ? WHERE id = ?",
            )
            .run(new Date().toISOString(), current.id);
          database
            .prepare("DELETE FROM task_lifecycle_resources WHERE operation_id = ?")
            .run(current.id);
        }
        if (command.targetStatus === "done") this.#assertReadyToComplete(taskId);
        const id = randomUUID();
        const timestamp = new Date().toISOString();
        database
          .prepare(
            `INSERT INTO task_lifecycle_operations (id, task_id, identity_key, idempotency_key, request_hash, target_status, status, phase, expected_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', 'checking', ?, ?, ?)`,
          )
          .run(
            id,
            taskId,
            identityKey(context.actor.identity),
            context.idempotencyKey,
            hash,
            command.targetStatus,
            task.version,
            timestamp,
            timestamp,
          );
        return id;
      })
      .immediate();
    const operation = this.#operation(operationId);
    if (["pending", "failed"].includes(operation.status)) this.#launch(operationId);
    return this.#view(this.#operation(operationId));
  }

  readLatest(taskId: string, actor: PrincipalView): TaskLifecycleView | null {
    this.#options.taskboard.readTask(taskId, actor);
    const row = this.#options.database
      .prepare(
        "SELECT id FROM task_lifecycle_operations WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(taskId) as { id: string } | undefined;
    return row ? this.#view(this.#operation(row.id)) : null;
  }

  async wait(operationId: string): Promise<TaskMutationResult> {
    const active = this.#running.get(operationId);
    if (active) return active;
    const operation = this.#operation(operationId);
    if (operation.resultJson && operation.status === "succeeded")
      return TaskMutationResultSchema.parse(JSON.parse(operation.resultJson));
    throw new AppError("INVALID_REQUEST", 409, operation.errorSummary ?? "任务操作尚未完成");
  }

  async resumePending(): Promise<void> {
    // Failed operations from the former cleanup workflow must not hold Git
    // management locks now that users perform cleanup before retrying checks.
    this.#options.database
      .prepare(
        `DELETE FROM task_lifecycle_resources WHERE operation_id IN (
      SELECT id FROM task_lifecycle_operations WHERE status = 'failed'
    )`,
      )
      .run();
    const rows = this.#options.database
      .prepare("SELECT id FROM task_lifecycle_operations WHERE status IN ('pending', 'running')")
      .all() as { id: string }[];
    for (const row of rows) this.#launch(row.id);
    await Promise.allSettled(rows.map((row) => this.wait(row.id)));
  }

  async close(): Promise<void> {
    this.#closing = true;
    await Promise.allSettled(this.#running.values());
  }

  #launch(id: string): void {
    if (this.#running.has(id) || this.#closing) return;
    const running = Promise.resolve()
      .then(() => this.#run(id))
      .finally(() => this.#running.delete(id));
    this.#running.set(id, running);
    void running.catch(() => {
      /* The durable failure is exposed through readLatest and wait. */
    });
  }

  async #run(id: string): Promise<TaskMutationResult> {
    let operation = this.#operation(id);
    try {
      const task = this.#options.taskboard.readTask(
        operation.taskId,
        this.#actor(operation.principalKey),
      );
      if (
        !task.permissions.canWrite ||
        task.archivedAt ||
        this.#options.database
          .prepare("SELECT 1 FROM projects WHERE id = ? AND archived_at IS NOT NULL")
          .get(task.projectId)
      )
        throw new AppError("INVALID_REQUEST", 409, "任务或项目已归档或权限已变化，无法执行操作");
      if (operation.snapshotJson) {
        // Preserve branch identity across transient inspection failures, but do
        // not reuse an old commit/cleanup checkpoint as proof of completion.
        const previous = JSON.parse(operation.snapshotJson) as TaskGitSnapshot;
        this.#options.database
          .prepare("UPDATE task_lifecycle_operations SET snapshot_json = ? WHERE id = ?")
          .run(JSON.stringify({ ...previous, commitSha: null, archiveRef: null, notes: [] }), id);
      }
      this.#update(id, "running", "checking");
      if (operation.targetStatus === "canceled") {
        this.#update(id, "running", "canceling");
        await this.#cancelExecutions(operation);
      } else {
        this.#assertReadyToComplete(operation.taskId);
      }
      this.#update(id, "running", "checking");
      // Reinspect on every retry, including operations persisted by the old
      // automatic commit/cleanup flow. Historical delivery refs are irrelevant.
      const directory = this.#taskDirectory(operation.taskId);
      if (directory) {
        const allowTemporaryProjectRoot = task.projectId === TEMPORARY_PROJECT_ID;
        const project = this.#options.database
          .prepare("SELECT workspace_realpath AS cwd FROM projects WHERE id = ?")
          .get(task.projectId) as { cwd: string | null };
        let snapshot = await this.#options.gitFinalizer.inspect(
          directory,
          operation.taskId,
          operation.id,
          project.cwd,
          this.#taskBranch(operation.taskId, directory, operation.snapshotJson),
          allowTemporaryProjectRoot,
        );
        if (snapshot) {
          this.#lockResources(operation, snapshot);
          this.#update(id, "running", "checking", snapshot);
          snapshot = await this.#options.gitFinalizer.verify(
            snapshot,
            operation.targetStatus === "canceled" ? operation.taskId : undefined,
            allowTemporaryProjectRoot,
          );
          this.#update(id, "running", "checking", snapshot);
        }
      }
      operation = this.#operation(id);
      return this.#finish(operation);
    } catch (cause) {
      const prefix = operation.targetStatus === "canceled" ? "任务未取消" : "任务未完成";
      const detail =
        cause instanceof AppError
          ? cause.message.replace(/^任务未完成：/, "")
          : "检查失败，请检查工作目录后重试";
      const message = `${prefix}：${detail}${operation.targetStatus === "canceled" ? "。请处理后重试；系统不会自动删除分支、工作树或文件。" : ""}`;
      this.#options.database
        .prepare(
          "UPDATE task_lifecycle_operations SET status = 'failed', error_summary = ?, updated_at = ? WHERE id = ? AND status <> 'succeeded'",
        )
        .run(message, new Date().toISOString(), id);
      // A failed read-only check must not prevent the user from cleaning up Git resources.
      this.#options.database
        .prepare("DELETE FROM task_lifecycle_resources WHERE operation_id = ?")
        .run(id);
      this.#notify(id);
      throw cause instanceof AppError
        ? cause
        : new AppError("UPSTREAM_ERROR", 502, message, { cause });
    }
  }

  async #cancelExecutions(operation: Operation): Promise<void> {
    const { database, queue, scheduleExecution } = this.#options;
    const actor = this.#actor(operation.principalKey);
    const deadline = Date.now() + (this.#options.cancellationTimeoutMs ?? 30_000);
    const submitted = new Set<string>();
    while (true) {
      if (this.#closing) throw new AppError("UPSTREAM_ERROR", 503, "服务正在停止，可重试取消任务");
      const rows = database
        .prepare(
          `SELECT id FROM jobs WHERE task_id = ? AND kind <> 'cancel' AND status IN (${ACTIVE})`,
        )
        .all(operation.taskId) as { id: string }[];
      if (rows.length === 0) return;
      for (const row of rows) {
        if (!submitted.has(row.id)) {
          queue.requestCancel(row.id, {
            actor,
            idempotencyKey: `lifecycle:${operation.id}:${row.id}:${randomUUID()}`,
          });
          submitted.add(row.id);
        }
      }
      scheduleExecution();
      if (Date.now() >= deadline)
        throw new AppError(
          "UPSTREAM_ERROR",
          504,
          "尚未确认 Codex 停止，任务保持原状态，请重试取消任务",
        );
      await delay(100);
    }
  }

  #assertReadyToComplete(taskId: string): void {
    const db = this.#options.database;
    if (hasActiveDesktopTurn(db, taskId))
      throw new AppError(
        "INVALID_REQUEST",
        409,
        "任务未完成：Desktop 对话仍在执行，请等待结束后重试。",
      );
    if (!db.prepare("SELECT 1 FROM tasks WHERE id = ? AND status = 'in_review'").get(taskId))
      throw new AppError("INVALID_REQUEST", 409, "只有待验收状态的任务才能完成");
    if (
      db
        .prepare(`SELECT 1 FROM jobs WHERE task_id = ? AND status IN (${ACTIVE}) LIMIT 1`)
        .get(taskId)
    )
      throw new AppError("INVALID_REQUEST", 409, "任务仍有活动执行，请先取消或等待执行结束");
    if (
      db
        .prepare(
          "SELECT 1 FROM comments WHERE task_id = ? AND executed_at IS NULL AND deleted_at IS NULL LIMIT 1",
        )
        .get(taskId)
    )
      throw new AppError("INVALID_REQUEST", 409, "任务还有未执行的评论，请先处理后再完成");
  }

  #lockResources(operation: Operation, snapshot: TaskGitSnapshot): void {
    assertGitManagementAvailable(this.#options.database, snapshot.cwd);
    assertGitManagementAvailable(this.#options.database, snapshot.mainCwd);
    const db = this.#options.database;
    const keys = [`cwd:${snapshot.cwd}`, `repo:${snapshot.commonDirectory}`];
    db.transaction(() => {
      for (const key of keys) {
        const row = db
          .prepare(
            "SELECT operation_id AS operationId FROM task_lifecycle_resources WHERE resource_key = ?",
          )
          .get(key) as { operationId: string } | undefined;
        if (row && row.operationId !== operation.id)
          throw new AppError("VERSION_CONFLICT", 409, "该仓库正在执行其他任务收尾");
      }
      const active = db
        .prepare(
          `SELECT work_context_json AS context FROM jobs WHERE status IN (${ACTIVE}) AND kind <> 'cancel'`,
        )
        .all() as { context: string }[];
      for (const job of active) {
        const context = JSON.parse(job.context) as { cwd?: string };
        if (context.cwd && workspaceResourceKeys(context.cwd).some((key) => keys.includes(key)))
          throw new AppError("VERSION_CONFLICT", 409, "该仓库仍有活动执行，无法收尾");
      }
      for (const key of keys)
        db.prepare(
          "INSERT OR IGNORE INTO task_lifecycle_resources (resource_key, operation_id) VALUES (?, ?)",
        ).run(key, operation.id);
    }).immediate();
  }

  #taskBranch(taskId: string, directory: string, previousSnapshot: string | null): string | null {
    const row = this.#options.database
      .prepare(
        `
      SELECT contexts.branch FROM tasks
      JOIN project_development_contexts contexts ON contexts.id = json_extract(tasks.development_context_json, '$.id')
      WHERE tasks.id = ?`,
      )
      .get(taskId) as { branch: string | null } | undefined;
    if (row?.branch) return row.branch;
    const job = this.#options.database
      .prepare(
        `
      SELECT json_extract(work_context_json, '$.branch') AS branch FROM jobs
      WHERE task_id = ? AND json_extract(work_context_json, '$.cwd') = ?
        AND json_extract(work_context_json, '$.branch') IS NOT NULL
      ORDER BY rowid DESC LIMIT 1`,
      )
      .get(taskId, directory) as { branch: string } | undefined;
    if (job?.branch) return job.branch;
    if (previousSnapshot) {
      const previous = JSON.parse(previousSnapshot) as { cwd?: string; branch?: string };
      if (
        previous.cwd &&
        canonicalGitDirectory(previous.cwd) === canonicalGitDirectory(directory) &&
        previous.branch
      )
        return previous.branch;
    }
    return null;
  }

  #taskDirectory(taskId: string): string | null {
    const row = this.#options.database
      .prepare(
        `SELECT COALESCE((SELECT cwd FROM task_threads WHERE task_id = tasks.id AND is_primary = 1 LIMIT 1), contexts.worktree_realpath, projects.workspace_realpath) AS cwd FROM tasks JOIN projects ON projects.id = tasks.project_id LEFT JOIN project_development_contexts contexts ON contexts.id = json_extract(tasks.development_context_json, '$.id') WHERE tasks.id = ?`,
      )
      .get(taskId) as { cwd: string | null };
    return row.cwd;
  }
  #finish(operation: Operation): TaskMutationResult {
    const { database, taskboard } = this.#options;
    const result = database
      .transaction(() => {
        const actor = this.#actor(operation.principalKey);
        const current = taskboard.readTask(operation.taskId, actor);
        if (
          current.archivedAt ||
          database
            .prepare("SELECT 1 FROM projects WHERE id = ? AND archived_at IS NOT NULL")
            .get(current.projectId)
        )
          throw new AppError("INVALID_REQUEST", 409, "任务或项目已归档，无法完成操作");
        if (current.version !== operation.expectedVersion)
          throw new AppError("VERSION_CONFLICT", 409, "收尾期间任务版本已变化");
        if (operation.targetStatus === "done") this.#assertReadyToComplete(operation.taskId);
        const timestamp = new Date().toISOString();
        database
          .prepare(
            "UPDATE tasks SET status = ?, blocked_from_status = NULL, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
          )
          .run(operation.targetStatus, timestamp, operation.taskId, current.version);
        const task = taskboard.readTask(operation.taskId, actor);
        const change = database
          .prepare(
            "INSERT INTO change_events (aggregate_type, aggregate_id, event_type, safe_payload_json, created_at) VALUES ('task', ?, 'task.lifecycle_completed', ?, ?)",
          )
          .run(
            task.id,
            JSON.stringify({
              taskId: task.id,
              projectId: task.projectId,
              status: task.status,
              operationId: operation.id,
            }),
            timestamp,
          );
        const result = TaskMutationResultSchema.parse({
          task,
          revision: Number(change.lastInsertRowid),
        });
        database
          .prepare(
            "UPDATE task_lifecycle_operations SET status = 'succeeded', phase = 'completed', result_json = ?, error_summary = NULL, updated_at = ? WHERE id = ?",
          )
          .run(JSON.stringify(result), timestamp, operation.id);
        database
          .prepare("DELETE FROM task_lifecycle_resources WHERE operation_id = ?")
          .run(operation.id);
        database
          .prepare(
            "INSERT INTO activities (id, task_id, identity_key, kind, changes_json, created_at) VALUES (?, ?, ?, 'task.moved', ?, ?)",
          )
          .run(
            randomUUID(),
            task.id,
            identityKey(actor.identity),
            JSON.stringify({
              status: { from: current.status, to: task.status },
              operationId: operation.id,
            }),
            timestamp,
          );
        database
          .prepare(
            "INSERT INTO audit_events (id, identity_key, action, resource_type, resource_id, outcome, safe_metadata_json, created_at) VALUES (?, ?, 'task.lifecycle', 'task', ?, 'allowed', ?, ?)",
          )
          .run(
            randomUUID(),
            identityKey(actor.identity),
            task.id,
            JSON.stringify({ targetStatus: task.status, operationId: operation.id }),
            timestamp,
          );
        return result;
      })
      .immediate();
    this.#options.onRevisionCommitted?.(result.revision);
    return result;
  }

  #update(
    id: string,
    status: "running",
    phase: Operation["phase"],
    snapshot?: TaskGitSnapshot,
  ): void {
    this.#options.database
      .prepare(
        "UPDATE task_lifecycle_operations SET status = ?, phase = ?, snapshot_json = COALESCE(?, snapshot_json), error_summary = NULL, updated_at = ? WHERE id = ?",
      )
      .run(status, phase, snapshot ? JSON.stringify(snapshot) : null, new Date().toISOString(), id);
    this.#notify(id);
  }
  #notify(id: string): void {
    const op = this.#operation(id);
    const task = this.#options.taskboard.readTask(op.taskId, this.#actor(op.principalKey));
    const result = this.#options.database
      .prepare(
        "INSERT INTO change_events (aggregate_type, aggregate_id, event_type, safe_payload_json, created_at) VALUES ('task', ?, 'task.lifecycle_updated', ?, ?)",
      )
      .run(
        op.taskId,
        JSON.stringify({ taskId: task.id, projectId: task.projectId, operationId: id }),
        new Date().toISOString(),
      );
    this.#options.onRevisionCommitted?.(Number(result.lastInsertRowid));
  }
  #actor(id: string): PrincipalView {
    const row = this.#options.database
      .prepare("SELECT name, avatar_url AS avatarUrl, role FROM identities WHERE identity_key = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw new AppError("FORBIDDEN", 403, "收尾操作的发起人不存在");
    return PrincipalViewSchema.parse({ ...row, identity: identityFromKey(id) });
  }
  #operation(id: string): Operation {
    return OperationSchema.parse(
      this.#options.database
        .prepare(
          `SELECT id, task_id AS taskId, identity_key AS principalKey, request_hash AS requestHash, target_status AS targetStatus, status, phase, expected_version AS expectedVersion, snapshot_json AS snapshotJson, error_summary AS errorSummary, result_json AS resultJson, created_at AS createdAt, updated_at AS updatedAt FROM task_lifecycle_operations WHERE id = ?`,
        )
        .get(id),
    );
  }
  #view(operation: Operation): TaskLifecycleView {
    const snapshot = operation.snapshotJson
      ? (JSON.parse(operation.snapshotJson) as TaskGitSnapshot)
      : null;
    return TaskLifecycleViewSchema.parse({
      ...operation,
      commitSha: snapshot?.commitSha ?? null,
      archiveRef: snapshot?.archiveRef ?? null,
      notes:
        snapshot?.notes ??
        (operation.targetStatus === "done" && operation.status === "succeeded"
          ? ["无 Git 工作区，无需 Git 检查；原目录已保留"]
          : []),
    });
  }
}
