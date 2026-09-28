import { desktopCommentBody } from "./desktop-comment-body.js";
import { hasActiveDesktopTurn } from "./desktop-execution-state.js";
import { assertCommentsMutable } from "./comment-mutation-guard.js";
import { identityKey, identityFromKey, IdentityKeySchema } from "@codexboard/contracts";
import { createHash, randomUUID } from "node:crypto";

import {
  ActivityViewSchema,
  CommentViewSchema,
  CreateCommentCommandSchema,
  CreateTaskRelationCommandSchema,
  DashboardViewSchema,
  DeleteCommentCommandSchema,
  TaskRelationViewSchema,
  TaskWorkspaceViewSchema,
  UpdateCommentCommandSchema,
  WorkspaceMutationResultSchema,
  type ActivityView,
  type PrincipalView,
  type CommentView,
  type CreateCommentCommand,
  type CreateTaskRelationCommand,
  type DashboardView,
  type DeleteCommentCommand,
  type TaskRelationView,
  type TaskView,
  type TaskWorkspaceView,
  type UpdateCommentCommand,
  type WorkspaceMutationResult,
} from "@codexboard/contracts";
import { z } from "zod";

import { AppError } from "../../app-error.js";
import { withTransaction, type SqliteDatabase } from "../database/index.js";
import { assertUserAssignee } from "../identity/identity-policy.js";
import type { IdentityService } from "../identity/index.js";
import { Taskboard, type MutationContext } from "./taskboard.js";
import { assertTaskEditable } from "./task-readonly.js";
import { assertTaskDeletionAvailable } from "./task-delete-lease.js";
import { insertTaskRelation, normalizeTaskRelation } from "./task-relations.js";

const IdempotencyRowSchema = z.object({
  requestHash: z.string().length(64),
  responseJson: z.string(),
});

const TaskReadResultSchema = z.object({
  taskId: z.uuid(),
  lastReadVersion: z.number().int().positive(),
});

const CommentRowSchema = z.object({
  executedAt: z.string().nullable(),
  id: z.uuid(),
  taskId: z.uuid(),
  projectId: z.uuid(),
  authorKey: IdentityKeySchema.nullable(),
  authorName: z.string().nullable(),
  authorAvatarUrl: z.string().url().nullable(),
  body: z.string(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
});

const RelationRowSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  type: z.enum(["parent", "blocks", "related"]),
  sourceTaskId: z.uuid(),
  targetTaskId: z.uuid(),
  sourceIdentifier: z.string(),
  sourceTitle: z.string(),
  targetIdentifier: z.string(),
  targetTitle: z.string(),
  createdByKey: IdentityKeySchema.nullable(),
  createdByName: z.string().nullable(),
  createdByAvatarUrl: z.string().url().nullable(),
  createdAt: z.string().datetime(),
});

const ActivityRowSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  principalKey: IdentityKeySchema.nullable(),
  actorName: z.string().nullable(),
  actorAvatarUrl: z.string().url().nullable(),
  kind: z.string(),
  changesJson: z.string(),
  createdAt: z.string().datetime(),
});

const AttachmentRowSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  commentId: z.uuid().nullable(),
  uploaderKey: IdentityKeySchema.nullable(),
  uploaderName: z.string().nullable(),
  uploaderAvatarUrl: z.string().url().nullable(),
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string(),
  createdAt: z.string().datetime(),
});

const JobSummaryRowSchema = z.object({
  id: z.uuid(),
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
  updatedAt: z.string().datetime(),
  errorSummary: z.string().nullable(),
});

interface TaskWorkspaceOptions {
  readonly database: SqliteDatabase;
  readonly identityService: IdentityService;
  readonly taskboard?: Taskboard;
  readonly now?: () => Date;
  readonly onRevisionCommitted?: (revision: number) => void;
  readonly attachmentUrlPrefix?: string;
}

type RelationDirection = CreateTaskRelationCommand["relationType"];

const ACTIVE_JOB_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "waiting_input",
  "canceling",
] as const;

export class TaskWorkspace {
  readonly #database: SqliteDatabase;
  readonly #taskboard: Taskboard;
  readonly #now: () => Date;
  readonly #onRevisionCommitted: ((revision: number) => void) | undefined;
  readonly #attachmentUrlPrefix: string;

  constructor(options: TaskWorkspaceOptions) {
    this.#database = options.database;
    this.#taskboard =
      options.taskboard ??
      new Taskboard({ database: options.database, identityService: options.identityService });
    this.#now = options.now ?? (() => new Date());
    this.#onRevisionCommitted = options.onRevisionCommitted;
    this.#attachmentUrlPrefix = options.attachmentUrlPrefix ?? "/api/v1/attachments";
  }

  createComment(
    taskId: string,
    input: CreateCommentCommand,
    context: MutationContext,
  ): WorkspaceMutationResult<CommentView> {
    if (context.actor.identity.kind === "service") {
      throw new AppError("FORBIDDEN", 403, "发布评论需要已登录用户");
    }
    assertUserAssignee(this.#database, identityKey(context.actor.identity));
    const command = CreateCommentCommandSchema.parse(input);
    const task = this.#writableTask(taskId, context.actor);
    return this.#idempotent(
      `comment.create:${taskId}`,
      command,
      context,
      WorkspaceMutationResultSchema(CommentViewSchema),
      () => {
        assertTaskDeletionAvailable(this.#database, taskId);
        const timestamp = this.#now().toISOString();
        const commentId = randomUUID();
        this.#database
          .prepare(
            `INSERT INTO comments (id, task_id, author_identity_key, body, version, created_at, updated_at)
            VALUES (?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(
            commentId,
            taskId,
            identityKey(context.actor.identity),
            command.body,
            timestamp,
            timestamp,
          );
        // Conditional updates both authorize and bind; any failure rolls back the entire batch.
        for (const attachmentId of command.attachmentIds ?? []) {
          const linked = this.#database
            .prepare(
              `UPDATE attachments SET comment_id = ?, pending_comment = 0
             WHERE id = ? AND task_id = ? AND uploader_identity_key = ? AND comment_id IS NULL`,
            )
            .run(commentId, attachmentId, taskId, identityKey(context.actor.identity));
          if (linked.changes !== 1) {
            throw new AppError(
              "INVALID_REQUEST",
              400,
              "附件不存在、重复、已绑定或不属于当前任务和上传者",
            );
          }
        }
        const currentTask = this.#taskboard.readTask(taskId, context.actor);
        if (currentTask.status !== "todo") {
          this.#database
            .prepare(
              `UPDATE tasks SET status = 'todo', blocked_from_status = NULL,
            version = version + 1, updated_at = ? WHERE id = ?`,
            )
            .run(timestamp, taskId);
          this.#recordActivity(
            taskId,
            identityKey(context.actor.identity),
            "task.comment_pending",
            { status: { from: currentTask.status, to: "todo" }, commentId },
            timestamp,
          );
          this.#recordChange(
            "task",
            taskId,
            "task.comment_pending",
            { projectId: task.projectId, taskId, status: "todo" },
            timestamp,
          );
        }
        const comment = this.#readComment(commentId);
        this.#recordActivity(
          taskId,
          identityKey(context.actor.identity),
          "comment.created",
          { commentId },
          timestamp,
        );
        const revision = this.#recordChange(
          "comment",
          comment.id,
          "comment.created",
          { projectId: task.projectId, taskId, commentId, version: comment.version },
          timestamp,
        );
        this.#recordAudit(
          "comment.create",
          "comment",
          comment.id,
          task.projectId,
          context,
          timestamp,
        );
        return { data: comment, revision };
      },
    );
  }

  updateComment(
    commentId: string,
    input: UpdateCommentCommand,
    context: MutationContext,
  ): WorkspaceMutationResult<CommentView> {
    const command = UpdateCommentCommandSchema.parse(input);
    const visible = this.#readCommentRow(commentId);
    const task = this.#writableTask(visible.taskId, context.actor);
    this.#assertCommentOwner(visible, context.actor);
    return this.#idempotent(
      `comment.update:${commentId}`,
      command,
      context,
      WorkspaceMutationResultSchema(CommentViewSchema),
      () => {
        assertTaskDeletionAvailable(this.#database, visible.taskId);
        assertCommentsMutable(this.#database, visible.taskId);
        const current = this.#readCommentRow(commentId);
        if (current.executedAt)
          throw new AppError("INVALID_REQUEST", 409, "已用于执行的评论不能编辑或删除");
        this.#assertCommentVersion(current, command.expectedVersion);
        if (current.deletedAt) throw new AppError("INVALID_REQUEST", 409, "已删除评论不能编辑");
        const timestamp = this.#now().toISOString();
        const result = this.#database
          .prepare(
            `UPDATE comments SET body = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND version = ? AND deleted_at IS NULL`,
          )
          .run(command.body, timestamp, commentId, command.expectedVersion);
        if (result.changes !== 1) this.#throwCommentConflict(commentId, command.expectedVersion);
        const comment = this.#readComment(commentId);
        this.#recordActivity(
          task.id,
          identityKey(context.actor.identity),
          "comment.updated",
          { commentId, version: comment.version },
          timestamp,
        );
        const revision = this.#recordChange(
          "comment",
          comment.id,
          "comment.updated",
          { projectId: task.projectId, taskId: task.id, commentId, version: comment.version },
          timestamp,
        );
        this.#recordAudit(
          "comment.update",
          "comment",
          comment.id,
          task.projectId,
          context,
          timestamp,
        );
        return { data: comment, revision };
      },
    );
  }

  deleteComment(
    commentId: string,
    input: DeleteCommentCommand,
    context: MutationContext,
  ): WorkspaceMutationResult<CommentView> {
    const command = DeleteCommentCommandSchema.parse(input);
    const visible = this.#readCommentRow(commentId);
    const task = this.#writableTask(visible.taskId, context.actor);
    this.#assertCommentOwner(visible, context.actor);
    return this.#idempotent(
      `comment.delete:${commentId}`,
      command,
      context,
      WorkspaceMutationResultSchema(CommentViewSchema),
      () => {
        assertTaskDeletionAvailable(this.#database, visible.taskId);
        assertCommentsMutable(this.#database, visible.taskId);
        const current = this.#readCommentRow(commentId);
        if (current.executedAt)
          throw new AppError("INVALID_REQUEST", 409, "已用于执行的评论不能编辑或删除");
        this.#assertCommentVersion(current, command.expectedVersion);
        if (current.deletedAt) throw new AppError("INVALID_REQUEST", 409, "评论已经删除");
        const timestamp = this.#now().toISOString();
        const result = this.#database
          .prepare(
            `UPDATE comments
            SET body = '[已删除]', deleted_at = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND version = ? AND deleted_at IS NULL`,
          )
          .run(timestamp, timestamp, commentId, command.expectedVersion);
        if (result.changes !== 1) this.#throwCommentConflict(commentId, command.expectedVersion);
        const comment = this.#readComment(commentId);
        this.#recordActivity(
          task.id,
          identityKey(context.actor.identity),
          "comment.deleted",
          { commentId, version: comment.version },
          timestamp,
        );
        const revision = this.#recordChange(
          "comment",
          comment.id,
          "comment.deleted",
          { projectId: task.projectId, taskId: task.id, commentId, version: comment.version },
          timestamp,
        );
        this.#recordAudit(
          "comment.delete",
          "comment",
          comment.id,
          task.projectId,
          context,
          timestamp,
        );
        return { data: comment, revision };
      },
    );
  }

  createRelation(
    taskId: string,
    input: CreateTaskRelationCommand,
    context: MutationContext,
  ): WorkspaceMutationResult<TaskRelationView> {
    const command = CreateTaskRelationCommandSchema.parse(input);
    const task = this.#writableTask(taskId, context.actor);
    const target = this.#taskboard.readTask(command.targetTaskId, context.actor);
    assertTaskEditable(target);
    if (task.id === target.id) throw new AppError("INVALID_REQUEST", 400, "任务不能关联自身");
    if (task.projectId !== target.projectId) {
      throw new AppError("INVALID_REQUEST", 400, "任务关系必须位于同一项目");
    }
    if (target.archivedAt) {
      throw new AppError("INVALID_REQUEST", 409, "不能关联已归档任务");
    }
    return this.#idempotent(
      `relation.create:${taskId}`,
      command,
      context,
      WorkspaceMutationResultSchema(TaskRelationViewSchema),
      () => {
        assertTaskDeletionAvailable(this.#database, task.id);
        assertTaskDeletionAvailable(this.#database, target.id);
        const normalized = normalizeTaskRelation(task.id, target.id, command.relationType);
        const timestamp = this.#now().toISOString();
        const relationId = randomUUID();
        insertTaskRelation(this.#database, {
          id: relationId,
          projectId: task.projectId,
          ...normalized,
          createdBy: identityKey(context.actor.identity),
          createdAt: timestamp,
        });
        const relation = this.#directionalRelation(this.#readRelationRow(relationId), task.id);
        this.#recordActivity(
          task.id,
          identityKey(context.actor.identity),
          "relation.created",
          { relationId, relationType: command.relationType, targetTaskId: target.id },
          timestamp,
        );
        const revision = this.#recordChange(
          "task",
          task.id,
          "relation.created",
          { projectId: task.projectId, taskId: task.id, relatedTaskId: target.id, relationId },
          timestamp,
        );
        this.#recordAudit(
          "relation.create",
          "relation",
          relationId,
          task.projectId,
          context,
          timestamp,
        );
        return { data: relation, revision };
      },
    );
  }

  deleteRelation(
    taskId: string,
    relationId: string,
    context: MutationContext,
  ): WorkspaceMutationResult<{ readonly id: string }> {
    const task = this.#writableTask(taskId, context.actor);
    return this.#idempotent(
      `relation.delete:${relationId}`,
      { taskId, relationId },
      context,
      WorkspaceMutationResultSchema(z.object({ id: z.uuid() })),
      () => {
        assertTaskDeletionAvailable(this.#database, taskId);
        const relation = this.#readRelationRow(relationId);
        assertTaskDeletionAvailable(this.#database, relation.sourceTaskId);
        assertTaskDeletionAvailable(this.#database, relation.targetTaskId);
        if (relation.sourceTaskId !== taskId && relation.targetTaskId !== taskId) {
          throw new AppError("NOT_FOUND", 404, "任务关系不存在");
        }
        const timestamp = this.#now().toISOString();
        const relatedTaskId =
          relation.sourceTaskId === taskId ? relation.targetTaskId : relation.sourceTaskId;
        assertTaskEditable(this.#taskboard.readTask(relatedTaskId, context.actor));
        this.#database.prepare("DELETE FROM task_relations WHERE id = ?").run(relationId);
        this.#recordActivity(
          taskId,
          identityKey(context.actor.identity),
          "relation.deleted",
          { relationId },
          timestamp,
        );
        const revision = this.#recordChange(
          "task",
          taskId,
          "relation.deleted",
          { projectId: task.projectId, taskId, relatedTaskId, relationId },
          timestamp,
        );
        this.#recordAudit(
          "relation.delete",
          "relation",
          relationId,
          task.projectId,
          context,
          timestamp,
        );
        return { data: { id: relationId }, revision };
      },
    );
  }

  readTaskWorkspace(taskId: string, actor: PrincipalView): TaskWorkspaceView {
    const task = this.#taskboard.readTask(taskId, actor);
    const comments = this.#readComments(taskId);
    const attachments = this.#readAttachments(taskId);
    const relationRows: unknown[] = this.#database
      .prepare(
        `SELECT
          relations.id, relations.project_id AS projectId, relations.type,
          relations.source_task_id AS sourceTaskId, relations.target_task_id AS targetTaskId,
          source.identifier AS sourceIdentifier, source.title AS sourceTitle,
          target.identifier AS targetIdentifier, target.title AS targetTitle,
          identities.identity_key AS createdByKey, identities.name AS createdByName,
          identities.avatar_url AS createdByAvatarUrl,
          relations.created_at AS createdAt
        FROM task_relations AS relations
        JOIN tasks AS source ON source.id = relations.source_task_id
        JOIN tasks AS target ON target.id = relations.target_task_id
        LEFT JOIN identities ON identities.identity_key = relations.created_by_identity_key
        WHERE relations.source_task_id = ? OR relations.target_task_id = ?
        ORDER BY relations.created_at, relations.id`,
      )
      .all(taskId, taskId);
    const relations = relationRows.map((row) =>
      this.#directionalRelation(RelationRowSchema.parse(row), taskId),
    );
    const activities = this.#readActivities(taskId);
    const jobs = this.#readJobSummaries(taskId);
    return TaskWorkspaceViewSchema.parse({
      task,
      comments,
      attachments,
      relations,
      activities,
      executionSummary: {
        total: jobs.length,
        active: Math.max(
          jobs.filter((job) => ACTIVE_JOB_STATUSES.includes(job.status as never)).length,
          hasActiveDesktopTurn(this.#database, taskId) ? 1 : 0,
        ),
        latest: jobs[0] ?? null,
      },
    });
  }

  readDashboard(projectId: string, actor: PrincipalView): DashboardView {
    const board = this.#taskboard.readBoard(projectId, actor);
    const now = this.#now().getTime();
    const dueBoundary = now + 7 * 24 * 60 * 60 * 1_000;
    const taskIds = board.tasks.map((task) => task.id);
    const unreadRows = new Set(
      this.#database
        .prepare(
          `SELECT tasks.id
          FROM tasks
          LEFT JOIN task_reads
            ON task_reads.task_id = tasks.id AND task_reads.identity_key = ?
          WHERE tasks.archived_at IS NULL
            AND (task_reads.last_read_version IS NULL OR task_reads.last_read_version < tasks.version)`,
        )
        .pluck()
        .all(identityKey(actor.identity)) as string[],
    );
    const dashboardTasks = board.tasks.filter(
      (task) => task.status !== "done" && task.status !== "canceled",
    );
    const blockedOrUnreadTasks = dashboardTasks.filter(
      (task) => task.status === "blocked" || unreadRows.has(task.id),
    );
    const dueSoonTasks = dashboardTasks
      .filter((task) => {
        if (!task.dueAt) return false;
        const due = new Date(task.dueAt).getTime();
        return due >= now && due <= dueBoundary;
      })
      .sort((left, right) => (left.dueAt as string).localeCompare(right.dueAt as string));
    const activeCount =
      taskIds.length === 0
        ? 0
        : Number(
            this.#database
              .prepare(
                `SELECT count(*) FROM jobs
                WHERE task_id IN (${taskIds.map(() => "?").join(",")})
                  AND kind IN ('start', 'continue')
                  AND status IN ('queued', 'running', 'waiting_approval', 'waiting_input', 'canceling')`,
              )
              .pluck()
              .get(...taskIds),
          );
    const completedTasks = board.tasks.filter((task) => task.status === "done").length;
    const priorityCounts = { none: 0, urgent: 0, high: 0, medium: 0, low: 0 };
    for (const task of board.tasks) priorityCounts[task.priority] += 1;
    return DashboardViewSchema.parse({
      projectId,
      totalTasks: board.tasks.length,
      completedTasks,
      completionPercent:
        board.tasks.length === 0 ? 0 : Math.round((completedTasks / board.tasks.length) * 100),
      priorityCounts,
      blockedOrUnreadCount: blockedOrUnreadTasks.length,
      runningConversationCount: activeCount,
      blockedOrUnreadTasks,
      dueSoonTasks,
    });
  }

  markTaskRead(
    taskId: string,
    context: MutationContext,
  ): WorkspaceMutationResult<z.infer<typeof TaskReadResultSchema>> {
    const task = this.#taskboard.readTask(taskId, context.actor);
    return this.#idempotent(
      `task.read:${taskId}`,
      { taskId, taskVersion: task.version },
      context,
      WorkspaceMutationResultSchema(TaskReadResultSchema),
      () => {
        assertTaskDeletionAvailable(this.#database, taskId);
        const timestamp = this.#now().toISOString();
        this.#database
          .prepare(
            `INSERT INTO task_reads (task_id, identity_key, last_read_version, read_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (task_id, identity_key) DO UPDATE SET
              last_read_version = excluded.last_read_version,
              read_at = excluded.read_at`,
          )
          .run(taskId, identityKey(context.actor.identity), task.version, timestamp);
        const revision = this.#recordChange(
          "task",
          taskId,
          "task.read",
          { projectId: task.projectId, taskId },
          timestamp,
        );
        this.#recordAudit("task.read", "task", taskId, task.projectId, context, timestamp);
        return { data: { taskId, lastReadVersion: task.version }, revision };
      },
    );
  }

  #writableTask(taskId: string, actor: PrincipalView): TaskView {
    const task = this.#taskboard.readTask(taskId, actor);
    if (!task.permissions.canWrite) throw new AppError("FORBIDDEN", 403, "没有该任务写入权限");
    if (task.archivedAt) throw new AppError("INVALID_REQUEST", 409, "已归档任务不能修改");
    assertTaskDeletionAvailable(this.#database, taskId);
    assertTaskEditable(task);
    return task;
  }

  #readCommentRow(commentId: string) {
    const raw: unknown = this.#database
      .prepare(
        `SELECT comments.id, comments.task_id AS taskId, tasks.project_id AS projectId,
          comments.author_identity_key AS authorKey, identities.name AS authorName,
          identities.avatar_url AS authorAvatarUrl,
          comments.body, comments.version, comments.created_at AS createdAt,
          comments.updated_at AS updatedAt, comments.deleted_at AS deletedAt,
          comments.executed_at AS executedAt
        FROM comments
        JOIN tasks ON tasks.id = comments.task_id
        LEFT JOIN identities ON identities.identity_key = comments.author_identity_key
        WHERE comments.id = ?`,
      )
      .get(commentId);
    const parsed = CommentRowSchema.safeParse(raw);
    if (!parsed.success) throw new AppError("NOT_FOUND", 404, "评论不存在");
    return parsed.data;
  }

  #readComment(commentId: string): CommentView {
    const row = this.#readCommentRow(commentId);
    return CommentViewSchema.parse({
      id: row.id,
      taskId: row.taskId,
      source: "user",
      executedAt: row.executedAt,
      codexThreadId: null,
      author:
        row.authorKey && row.authorName
          ? {
              identity: identityFromKey(row.authorKey),
              name: row.authorName,
              avatarUrl: row.authorAvatarUrl,
            }
          : null,
      body: row.deletedAt ? "" : row.body,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    });
  }

  #readComments(taskId: string): readonly CommentView[] {
    const ids = this.#database
      .prepare(
        "SELECT id FROM comments WHERE task_id = ? AND deleted_at IS NULL ORDER BY created_at, id",
      )
      .pluck()
      .all(taskId) as string[];
    // Desktop user messages are read-only event projections; assistant messages
    // require an explicit final-answer phase. Neither becomes a pending comment.
    const replies = this.#database
      .prepare(
        `
      SELECT job_events.id, job_events.kind, job_events.summary, job_events.safe_payload_json AS payload,
        job_events.created_at AS createdAt, task_threads.thread_id AS codexThreadId
      FROM job_events JOIN jobs ON jobs.id = job_events.job_id
      LEFT JOIN task_threads ON task_threads.id = jobs.task_thread_id
      WHERE jobs.task_id = ? AND job_events.kind IN ('codex.agent_message', 'codex.user_message')
      ORDER BY job_events.created_at, jobs.queued_at, job_events.seq
    `,
      )
      .all(taskId) as {
      id: string;
      kind: string;
      summary: string;
      payload: string;
      createdAt: string;
      codexThreadId: string | null;
    }[];
    const codexComments = replies.flatMap((reply) => {
      const payload = JSON.parse(reply.payload) as Record<string, unknown>;
      const desktop = reply.kind === "codex.user_message";
      if (!desktop && payload.phase !== "final_answer") return [];
      const text = typeof payload.text === "string" ? payload.text : reply.summary;
      const body = desktop ? desktopCommentBody(text) : text;
      if (!body.trim()) return [];
      return [
        {
          id: reply.id,
          taskId,
          source: desktop ? ("desktop" as const) : ("codex" as const),
          executedAt: null,
          codexThreadId: reply.codexThreadId,
          author: null,
          body,
          version: 1,
          createdAt: reply.createdAt,
          updatedAt: reply.createdAt,
          deletedAt: null,
        },
      ];
    });
    return [...ids.map((id) => this.#readComment(id)), ...codexComments].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }

  #readAttachments(taskId: string) {
    const rows: unknown[] = this.#database
      .prepare(
        `SELECT attachments.id, attachments.task_id AS taskId,
          attachments.comment_id AS commentId, attachments.uploader_identity_key AS uploaderKey,
          identities.name AS uploaderName, identities.avatar_url AS uploaderAvatarUrl,
          attachments.filename,
          attachments.content_type AS contentType, attachments.size_bytes AS sizeBytes,
          attachments.sha256, attachments.created_at AS createdAt
        FROM attachments
        LEFT JOIN identities ON identities.identity_key = attachments.uploader_identity_key
        WHERE attachments.task_id = ? AND attachments.pending_comment = 0
          AND (attachments.comment_id IS NULL OR EXISTS (
            SELECT 1 FROM comments WHERE comments.id = attachments.comment_id
              AND comments.task_id = attachments.task_id AND comments.deleted_at IS NULL
          ))
        ORDER BY attachments.created_at, attachments.id`,
      )
      .all(taskId);
    return rows.map((raw) => {
      const row = AttachmentRowSchema.parse(raw);
      return {
        id: row.id,
        taskId: row.taskId,
        commentId: row.commentId,
        uploader:
          row.uploaderKey && row.uploaderName
            ? {
                identity: identityFromKey(row.uploaderKey),
                name: row.uploaderName,
                avatarUrl: row.uploaderAvatarUrl,
              }
            : null,
        filename: row.filename,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
        sha256: row.sha256,
        createdAt: row.createdAt,
        downloadUrl: `${this.#attachmentUrlPrefix}/${row.id}`,
      };
    });
  }

  #readActivities(taskId: string): readonly ActivityView[] {
    const rows: unknown[] = this.#database
      .prepare(
        `SELECT activities.id, activities.task_id AS taskId,
          activities.identity_key AS principalKey, identities.name AS actorName,
          identities.avatar_url AS actorAvatarUrl,
          activities.kind, activities.changes_json AS changesJson,
          activities.created_at AS createdAt
        FROM activities
        LEFT JOIN identities ON identities.identity_key = activities.identity_key
        WHERE activities.task_id = ?
        ORDER BY activities.created_at DESC, activities.rowid DESC
        LIMIT 200`,
      )
      .all(taskId);
    return rows.map((raw) => {
      const row = ActivityRowSchema.parse(raw);
      return ActivityViewSchema.parse({
        id: row.id,
        taskId: row.taskId,
        actor:
          row.principalKey && row.actorName
            ? {
                identity: identityFromKey(row.principalKey),
                name: row.actorName,
                avatarUrl: row.actorAvatarUrl,
              }
            : null,
        kind: row.kind,
        changes: JSON.parse(row.changesJson),
        createdAt: row.createdAt,
      });
    });
  }

  #readJobSummaries(taskId: string) {
    const rows: unknown[] = this.#database
      .prepare(
        `SELECT id, status, updated_at AS updatedAt, error_summary AS errorSummary
        FROM jobs WHERE task_id = ? AND kind IN ('start', 'continue')
        ORDER BY queued_at DESC, rowid DESC`,
      )
      .all(taskId);
    return rows.map((row) => JobSummaryRowSchema.parse(row));
  }

  #readRelationRow(relationId: string) {
    const raw: unknown = this.#database
      .prepare(
        `SELECT
          relations.id, relations.project_id AS projectId, relations.type,
          relations.source_task_id AS sourceTaskId, relations.target_task_id AS targetTaskId,
          source.identifier AS sourceIdentifier, source.title AS sourceTitle,
          target.identifier AS targetIdentifier, target.title AS targetTitle,
          identities.identity_key AS createdByKey, identities.name AS createdByName,
          identities.avatar_url AS createdByAvatarUrl,
          relations.created_at AS createdAt
        FROM task_relations AS relations
        JOIN tasks AS source ON source.id = relations.source_task_id
        JOIN tasks AS target ON target.id = relations.target_task_id
        LEFT JOIN identities ON identities.identity_key = relations.created_by_identity_key
        WHERE relations.id = ?`,
      )
      .get(relationId);
    const parsed = RelationRowSchema.safeParse(raw);
    if (!parsed.success) throw new AppError("NOT_FOUND", 404, "任务关系不存在");
    return parsed.data;
  }

  #directionalRelation(row: z.infer<typeof RelationRowSchema>, taskId: string): TaskRelationView {
    const sourceSide = row.sourceTaskId === taskId;
    let relationType: RelationDirection;
    if (row.type === "parent") relationType = sourceSide ? "child" : "parent";
    else if (row.type === "blocks") relationType = sourceSide ? "blocks" : "blocked_by";
    else relationType = "related";
    return TaskRelationViewSchema.parse({
      id: row.id,
      taskId,
      targetTaskId: sourceSide ? row.targetTaskId : row.sourceTaskId,
      relationType,
      targetIdentifier: sourceSide ? row.targetIdentifier : row.sourceIdentifier,
      targetTitle: sourceSide ? row.targetTitle : row.sourceTitle,
      createdBy:
        row.createdByKey && row.createdByName
          ? {
              identity: identityFromKey(row.createdByKey),
              name: row.createdByName,
              avatarUrl: row.createdByAvatarUrl,
            }
          : null,
      createdAt: row.createdAt,
    });
  }

  #assertCommentOwner(comment: z.infer<typeof CommentRowSchema>, actor: PrincipalView): void {
    if (comment.authorKey !== identityKey(actor.identity)) {
      throw new AppError("FORBIDDEN", 403, "只能编辑或删除自己的评论");
    }
  }

  #assertCommentVersion(comment: z.infer<typeof CommentRowSchema>, expected: number): void {
    if (comment.version !== expected) {
      throw new AppError("VERSION_CONFLICT", 409, "评论版本已变化，请重新加载", {
        details: { current: this.#readComment(comment.id) },
      });
    }
  }

  #throwCommentConflict(commentId: string, expected: number): never {
    this.#assertCommentVersion(this.#readCommentRow(commentId), expected);
    throw new AppError("INTERNAL_ERROR", 500, "评论写入未生效");
  }

  #recordActivity(
    taskId: string,
    principalKey: string,
    kind: string,
    changes: Record<string, unknown>,
    timestamp: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO activities (id, task_id, identity_key, kind, changes_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), taskId, principalKey, kind, JSON.stringify(changes), timestamp);
  }

  #recordChange(
    aggregateType: "task" | "comment" | "attachment",
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
    action: string,
    resourceType: string,
    resourceId: string,
    projectId: string,
    context: MutationContext,
    timestamp: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO audit_events (
          id, identity_key, action, resource_type, resource_id, outcome,
          request_id, safe_metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, 'allowed', ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        identityKey(context.actor.identity),
        action,
        resourceType,
        resourceId,
        context.requestId ?? null,
        JSON.stringify({ projectId }),
        timestamp,
      );
  }

  #idempotent<Data>(
    scope: string,
    request: unknown,
    context: MutationContext,
    schema: z.ZodType<WorkspaceMutationResult<Data>>,
    operation: () => WorkspaceMutationResult<Data>,
  ): WorkspaceMutationResult<Data> {
    const requestHash = createHash("sha256").update(stableStringify(request)).digest("hex");
    const outcome = withTransaction(this.#database, () => {
      const existingRaw: unknown = this.#database
        .prepare(
          `SELECT request_hash AS requestHash, response_json AS responseJson
          FROM request_idempotency
          WHERE identity_key = ? AND scope = ? AND idempotency_key = ?`,
        )
        .get(identityKey(context.actor.identity), scope, context.idempotencyKey);
      const existing = IdempotencyRowSchema.safeParse(existingRaw);
      if (existing.success) {
        if (existing.data.requestHash !== requestHash) {
          throw new AppError("DUPLICATE_REQUEST", 409, "幂等键已用于不同请求");
        }
        return { result: schema.parse(JSON.parse(existing.data.responseJson)), committed: false };
      }
      const result = schema.parse(operation());
      this.#database
        .prepare(
          `INSERT INTO request_idempotency (
            identity_key, scope, idempotency_key, request_hash, response_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          identityKey(context.actor.identity),
          scope,
          context.idempotencyKey,
          requestHash,
          JSON.stringify(result),
          this.#now().toISOString(),
        );
      return { result, committed: true };
    });
    if (outcome.committed) this.#onRevisionCommitted?.(outcome.result.revision);
    return outcome.result;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
