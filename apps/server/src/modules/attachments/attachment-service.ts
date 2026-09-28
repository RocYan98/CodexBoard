import { assertCommentsMutable } from "../taskboard/comment-mutation-guard.js";
import { identityKey, identityFromKey, IdentityKeySchema } from "@codexboard/contracts";
import { createHash, randomUUID } from "node:crypto";

import {
  AttachmentViewSchema,
  WorkspaceMutationResultSchema,
  type PrincipalView,
  type AttachmentView,
  type TaskView,
  type WorkspaceMutationResult,
} from "@codexboard/contracts";
import { z } from "zod";

import { AppError } from "../../app-error.js";
import { withTransaction, type SqliteDatabase } from "../database/index.js";
import type { IdentityService } from "../identity/index.js";
import { Taskboard, type MutationContext } from "../taskboard/index.js";
import { assertTaskEditable } from "../taskboard/task-readonly.js";
import { assertTaskDeletionAvailable } from "../taskboard/task-delete-lease.js";
import {
  AttachmentVault,
  type AttachmentUpload,
  type QuarantinedAttachments,
} from "./attachment-vault.js";

const IdempotencyRowSchema = z.object({ requestHash: z.string(), responseJson: z.string() });
const AttachmentRecordSchema = z.object({
  id: z.uuid(),
  isSnapshot: z.boolean().default(false),
  taskId: z.uuid(),
  projectId: z.uuid(),
  commentId: z.uuid().nullable(),
  pendingComment: z.number().int(),
  uploaderKey: IdentityKeySchema.nullable(),
  uploaderName: z.string().nullable(),
  uploaderAvatarUrl: z.string().url().nullable(),
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string(),
  storageKey: z.string(),
  createdAt: z.string().datetime(),
});

interface AttachmentServiceOptions {
  readonly database: SqliteDatabase;
  readonly identityService: IdentityService;
  readonly taskboard: Taskboard;
  readonly vault: AttachmentVault;
  readonly now?: () => Date;
  readonly onRevisionCommitted?: (revision: number) => void;
  readonly attachmentUrlPrefix?: string;
}

export class AttachmentService {
  readonly #database: SqliteDatabase;
  readonly #taskboard: Taskboard;
  readonly #vault: AttachmentVault;
  readonly #now: () => Date;
  readonly #onRevisionCommitted: ((revision: number) => void) | undefined;
  readonly #attachmentUrlPrefix: string;

  constructor(options: AttachmentServiceOptions) {
    this.#database = options.database;
    this.#taskboard = options.taskboard;
    this.#vault = options.vault;
    this.#now = options.now ?? (() => new Date());
    this.#onRevisionCommitted = options.onRevisionCommitted;
    this.#attachmentUrlPrefix = options.attachmentUrlPrefix ?? "/api/v1/attachments";
  }

  authorizeUpload(taskId: string, actor: PrincipalView): TaskView {
    const task = this.#taskboard.readTask(taskId, actor);
    if (!task.permissions.canWrite) throw new AppError("FORBIDDEN", 403, "没有该任务写入权限");
    assertTaskEditable(task);
    if (task.archivedAt) throw new AppError("INVALID_REQUEST", 409, "已归档任务不能添加附件");
    assertTaskDeletionAvailable(this.#database, taskId);
    return task;
  }

  upload(
    taskId: string,
    upload: AttachmentUpload & {
      readonly commentId?: string | null;
      readonly pendingComment?: boolean;
    },
    context: MutationContext,
  ): WorkspaceMutationResult<AttachmentView> {
    const task = this.authorizeUpload(taskId, context.actor);
    if (upload.pendingComment && upload.commentId)
      throw new AppError("INVALID_REQUEST", 400, "草稿附件不能指定评论");
    const requestHash = createHash("sha256")
      .update(upload.filename)
      .update("\0")
      .update(upload.contentType)
      .update("\0")
      .update(upload.commentId ?? "")
      .update("\0")
      .update(upload.bytes)
      .digest("hex");
    // Preserve legacy hashes for ordinary uploads while separating draft requests.
    const effectiveRequestHash = upload.pendingComment
      ? createHash("sha256").update(requestHash).update(":pending-comment").digest("hex")
      : requestHash;
    const scope = `attachment.create:${taskId}`;
    const replay = this.#readReplay(scope, context, effectiveRequestHash);
    if (replay) return replay;

    const stored = this.#vault.store(upload);
    try {
      const outcome = withTransaction(this.#database, () => {
        assertTaskDeletionAvailable(this.#database, taskId);
        const repeated = this.#readReplay(scope, context, effectiveRequestHash);
        if (repeated) return { result: repeated, committed: false };
        if (!upload.commentId && !upload.pendingComment)
          this.#assertDescriptionMutable(taskId, context.actor);
        if (upload.commentId) this.#assertCommentMutable(upload.commentId, taskId, context.actor);
        const id = randomUUID();
        const timestamp = this.#now().toISOString();
        this.#database
          .prepare(
            `INSERT INTO attachments (
              id, task_id, comment_id, uploader_identity_key, filename, content_type,
              size_bytes, sha256, storage_key, created_at, pending_comment
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            taskId,
            upload.commentId ?? null,
            identityKey(context.actor.identity),
            stored.filename,
            stored.contentType,
            stored.sizeBytes,
            stored.sha256,
            stored.storageKey,
            timestamp,
            upload.pendingComment ? 1 : 0,
          );
        if (upload.commentId)
          this.#database
            .prepare("UPDATE comments SET version = version + 1, updated_at = ? WHERE id = ?")
            .run(timestamp, upload.commentId);
        if (!upload.pendingComment)
          this.#database
            .prepare(
              `INSERT INTO activities (id, task_id, identity_key, kind, changes_json, created_at)
            VALUES (?, ?, ?, 'attachment.created', ?, ?)`,
            )
            .run(
              randomUUID(),
              taskId,
              identityKey(context.actor.identity),
              JSON.stringify({ attachmentId: id, filename: stored.filename }),
              timestamp,
            );
        const change = this.#database
          .prepare(
            `INSERT INTO change_events (
              aggregate_type, aggregate_id, event_type, safe_payload_json, created_at
            ) VALUES ('attachment', ?, 'attachment.created', ?, ?)`,
          )
          .run(
            id,
            JSON.stringify({
              projectId: task.projectId,
              taskId,
              attachmentId: id,
              ...(upload.pendingComment
                ? {}
                : { filename: stored.filename, sizeBytes: stored.sizeBytes }),
            }),
            timestamp,
          );
        this.#database
          .prepare(
            `INSERT INTO audit_events (
              id, identity_key, action, resource_type, resource_id, outcome,
              request_id, safe_metadata_json, created_at
            ) VALUES (?, ?, 'attachment.create', 'attachment', ?, 'allowed', ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            identityKey(context.actor.identity),
            id,
            context.requestId ?? null,
            JSON.stringify({ projectId: task.projectId, sizeBytes: stored.sizeBytes }),
            timestamp,
          );
        const result = WorkspaceMutationResultSchema(AttachmentViewSchema).parse({
          data: this.#view(this.#readRecord(id)),
          revision: Number(change.lastInsertRowid),
        });
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
            effectiveRequestHash,
            JSON.stringify(result),
            timestamp,
          );
        return { result, committed: true };
      });
      if (!outcome.committed) this.#vault.remove(stored.storageKey);
      else this.#onRevisionCommitted?.(outcome.result.revision);
      return outcome.result;
    } catch (error: unknown) {
      this.#vault.remove(stored.storageKey);
      throw error;
    }
  }

  open(
    attachmentId: string,
    actor: PrincipalView,
  ): { readonly metadata: AttachmentView; readonly bytes: Buffer } {
    const record = this.#readRecord(attachmentId);
    this.#taskboard.readTask(record.taskId, actor);
    this.#assertDraftOwner(record, actor);
    return { metadata: this.#view(record), bytes: this.#vault.open(record.storageKey) };
  }

  openLocal(attachmentId: string): { readonly metadata: AttachmentView; readonly bytes: Buffer } {
    const record = this.#readRecord(attachmentId);
    return { metadata: this.#view(record), bytes: this.#vault.open(record.storageKey) };
  }

  delete(attachmentId: string, context: MutationContext): WorkspaceMutationResult<AttachmentView> {
    const scope = `attachment.delete:${attachmentId}`;
    const requestHash = createHash("sha256").update(attachmentId).digest("hex");
    const replay = this.#readReplay(scope, context, requestHash);
    if (replay) return replay;

    const record = this.#readRecord(attachmentId);
    if (record.isSnapshot) throw new AppError("INVALID_REQUEST", 409, "执行附件快照不可删除");
    this.#assertDraftOwner(record, context.actor);
    const task = this.#taskboard.readTask(record.taskId, context.actor);
    if (!task.permissions.canWrite) throw new AppError("FORBIDDEN", 403, "没有该任务写入权限");
    assertTaskEditable(task);
    if (task.archivedAt) throw new AppError("INVALID_REQUEST", 409, "已归档任务不能删除附件");
    assertTaskDeletionAvailable(this.#database, task.id);

    let quarantine: QuarantinedAttachments | null = null;
    let outcome: {
      readonly result: WorkspaceMutationResult<AttachmentView>;
      readonly committed: boolean;
    };
    try {
      outcome = withTransaction(this.#database, () => {
        const repeated = this.#readReplay(scope, context, requestHash);
        if (repeated) return { result: repeated, committed: false };
        assertTaskDeletionAvailable(this.#database, task.id);
        const retained = this.#database
          .prepare("SELECT 1 FROM job_attachment_snapshots WHERE storage_key = ? LIMIT 1")
          .get(record.storageKey);
        quarantine = this.#vault.quarantine(retained ? [] : [record.storageKey]);
        const current = this.#readRecord(attachmentId);
        this.#assertDraftOwner(current, context.actor);
        if (!current.commentId && !current.pendingComment)
          this.#assertDescriptionMutable(task.id, context.actor);
        if (current.commentId) {
          this.#assertCommentMutable(current.commentId, task.id, context.actor);
          const comment = this.#database
            .prepare("SELECT body FROM comments WHERE id = ?")
            .get(current.commentId) as { body: string };
          const count = this.#database
            .prepare("SELECT count(*) FROM attachments WHERE comment_id = ?")
            .pluck()
            .get(current.commentId) as number;
          if (!comment.body.trim() && count <= 1)
            throw new AppError(
              "INVALID_REQUEST",
              409,
              "不能删除仅附件评论的最后一个附件，请直接删除评论",
            );
        }
        const timestamp = this.#now().toISOString();
        const removed = this.#database
          .prepare("DELETE FROM attachments WHERE id = ?")
          .run(attachmentId);
        if (removed.changes !== 1) {
          throw new AppError("VERSION_CONFLICT", 409, "附件已被其他成员删除");
        }
        if (current.commentId)
          this.#database
            .prepare("UPDATE comments SET version = version + 1, updated_at = ? WHERE id = ?")
            .run(timestamp, current.commentId);
        if (!current.pendingComment)
          this.#database
            .prepare(
              `INSERT INTO activities (id, task_id, identity_key, kind, changes_json, created_at)
            VALUES (?, ?, ?, 'attachment.deleted', ?, ?)`,
            )
            .run(
              randomUUID(),
              task.id,
              identityKey(context.actor.identity),
              JSON.stringify({ attachmentId, filename: current.filename }),
              timestamp,
            );
        const change = this.#database
          .prepare(
            `INSERT INTO change_events (
              aggregate_type, aggregate_id, event_type, safe_payload_json, created_at
            ) VALUES ('attachment', ?, 'attachment.deleted', ?, ?)`,
          )
          .run(
            attachmentId,
            JSON.stringify({
              projectId: task.projectId,
              taskId: task.id,
              attachmentId,
              ...(current.pendingComment
                ? {}
                : { filename: current.filename, sizeBytes: current.sizeBytes }),
            }),
            timestamp,
          );
        this.#database
          .prepare(
            `INSERT INTO audit_events (
              id, identity_key, action, resource_type, resource_id, outcome,
              request_id, safe_metadata_json, created_at
            ) VALUES (?, ?, 'attachment.delete', 'attachment', ?, 'allowed', ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            identityKey(context.actor.identity),
            attachmentId,
            context.requestId ?? null,
            JSON.stringify({ projectId: task.projectId, taskId: task.id }),
            timestamp,
          );
        const result = WorkspaceMutationResultSchema(AttachmentViewSchema).parse({
          data: this.#view(current),
          revision: Number(change.lastInsertRowid),
        });
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
            timestamp,
          );
        return { result, committed: true };
      });
    } catch (error: unknown) {
      if (quarantine) this.#vault.restore(quarantine);
      throw error;
    }

    if (outcome.committed) {
      if (quarantine) this.#vault.discard(quarantine);
      this.#onRevisionCommitted?.(outcome.result.revision);
    } else {
      if (quarantine) this.#vault.restore(quarantine);
    }
    return outcome.result;
  }

  #assertDescriptionMutable(taskId: string, actor: PrincipalView): void {
    if (this.#taskboard.readTask(taskId, actor).descriptionLocked)
      throw new AppError("INVALID_REQUEST", 409, "任务描述已锁定，请通过评论补充附件");
  }

  #assertDraftOwner(record: z.infer<typeof AttachmentRecordSchema>, actor: PrincipalView): void {
    if (record.pendingComment && record.uploaderKey !== identityKey(actor.identity))
      throw new AppError("NOT_FOUND", 404, "附件不存在");
  }

  #assertCommentMutable(commentId: string, taskId: string, actor: PrincipalView): void {
    assertCommentsMutable(this.#database, taskId);
    const comment = this.#database
      .prepare(
        `SELECT author_identity_key AS authorKey, executed_at AS executedAt FROM comments
       WHERE id = ? AND task_id = ? AND deleted_at IS NULL`,
      )
      .get(commentId, taskId) as
      { authorKey: string | null; executedAt: string | null } | undefined;
    if (!comment) throw new AppError("INVALID_REQUEST", 400, "附件评论不存在或不属于当前任务");
    if (comment.authorKey !== identityKey(actor.identity))
      throw new AppError("FORBIDDEN", 403, "只能修改自己评论的附件");
    if (comment.executedAt !== null)
      throw new AppError("INVALID_REQUEST", 409, "已用于执行的评论不能修改附件");
  }

  #readReplay(
    scope: string,
    context: MutationContext,
    requestHash: string,
  ): WorkspaceMutationResult<AttachmentView> | undefined {
    const raw: unknown = this.#database
      .prepare(
        `SELECT request_hash AS requestHash, response_json AS responseJson
        FROM request_idempotency
        WHERE identity_key = ? AND scope = ? AND idempotency_key = ?`,
      )
      .get(identityKey(context.actor.identity), scope, context.idempotencyKey);
    const existing = IdempotencyRowSchema.safeParse(raw);
    if (!existing.success) return undefined;
    if (existing.data.requestHash !== requestHash) {
      throw new AppError("DUPLICATE_REQUEST", 409, "幂等键已用于不同请求");
    }
    return WorkspaceMutationResultSchema(AttachmentViewSchema).parse(
      JSON.parse(existing.data.responseJson),
    );
  }

  #readRecord(attachmentId: string) {
    const raw: unknown = this.#database
      .prepare(
        `SELECT attachments.id, attachments.task_id AS taskId, tasks.project_id AS projectId,
          attachments.comment_id AS commentId, attachments.pending_comment AS pendingComment, attachments.uploader_identity_key AS uploaderKey,
          identities.name AS uploaderName, identities.avatar_url AS uploaderAvatarUrl,
          attachments.filename,
          attachments.content_type AS contentType, attachments.size_bytes AS sizeBytes,
          attachments.sha256, attachments.storage_key AS storageKey,
          attachments.created_at AS createdAt
        FROM attachments
        JOIN tasks ON tasks.id = attachments.task_id
        LEFT JOIN identities ON identities.identity_key = attachments.uploader_identity_key
        WHERE attachments.id = ?
          AND (attachments.comment_id IS NULL OR EXISTS (
            SELECT 1 FROM comments WHERE comments.id = attachments.comment_id
              AND comments.task_id = attachments.task_id AND comments.deleted_at IS NULL
          ))`,
      )
      .get(attachmentId);
    const parsed = AttachmentRecordSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    const snapshot = this.#database
      .prepare(
        `SELECT snapshots.id, snapshots.task_id AS taskId,
      tasks.project_id AS projectId, snapshots.comment_id AS commentId, 0 AS pendingComment,
      snapshots.uploader_identity_key AS uploaderKey, identities.name AS uploaderName, identities.avatar_url AS uploaderAvatarUrl,
      snapshots.filename, snapshots.content_type AS contentType, snapshots.size_bytes AS sizeBytes,
      snapshots.sha256, snapshots.storage_key AS storageKey, snapshots.created_at AS createdAt
      FROM job_attachment_snapshots AS snapshots JOIN jobs ON jobs.id = snapshots.job_id AND jobs.task_id = snapshots.task_id
      JOIN tasks ON tasks.id = snapshots.task_id LEFT JOIN identities ON identities.identity_key = snapshots.uploader_identity_key
      WHERE snapshots.id = ?`,
      )
      .get(attachmentId);
    const parsedSnapshot = AttachmentRecordSchema.safeParse(snapshot);
    if (!parsedSnapshot.success) throw new AppError("NOT_FOUND", 404, "附件不存在");
    return { ...parsedSnapshot.data, isSnapshot: true };
  }

  #view(record: z.infer<typeof AttachmentRecordSchema>): AttachmentView {
    return AttachmentViewSchema.parse({
      id: record.id,
      taskId: record.taskId,
      commentId: record.commentId,
      uploader:
        record.uploaderKey && record.uploaderName
          ? {
              identity: identityFromKey(record.uploaderKey),
              name: record.uploaderName,
              avatarUrl: record.uploaderAvatarUrl,
            }
          : null,
      filename: record.filename,
      contentType: record.contentType,
      sizeBytes: record.sizeBytes,
      sha256: record.sha256,
      createdAt: record.createdAt,
      downloadUrl: `${this.#attachmentUrlPrefix}/${record.id}`,
    });
  }
}
