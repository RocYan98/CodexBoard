import {
  identityKey,
  identityFromKey,
  sameIdentity,
  IdentityKeySchema,
  UserIdentityRefSchema,
  type UserIdentityRef,
} from "@codexboard/contracts";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  BoardViewSchema,
  ProjectViewSchema,
  ProjectTaskCreationOptionsViewSchema,
  TaskConflictSummarySchema,
  TaskLabelsSchema,
  TaskMutationResultSchema,
  TaskRecurrenceRuleSchema,
  TaskViewBaseSchema,
  TaskViewSchema,
  TEMPORARY_PROJECT_ID,
  ALL_PROJECT_ID,
  type PrincipalView,
  type ArchiveTaskCommand,
  type BoardView,
  type CreateTaskCommand,
  type MoveTaskCommand,
  type LocalDevelopmentContextView,
  type ProjectTaskCreationOptionsView,
  type ProjectView,
  type RestoreTaskCommand,
  type ReassignTaskCommand,
  type TaskMutationResult,
  type TaskStatus,
  type TaskView,
  type UpdateTaskCommand,
} from "@codexboard/contracts";
import { z } from "zod";

import { AppError } from "../../app-error.js";
import {
  assertBoardAccess,
  hasBoardAccess,
  assertUserAssignee,
  FEISHU_IDENTITY_SQL,
} from "../identity/identity-policy.js";
import { withTransaction, type SqliteDatabase } from "../database/index.js";
import type { IdentityService } from "../identity/index.js";
import { formatTaskIdentifier } from "../project-sync/project-key.js";
import { assertTaskEditable } from "./task-readonly.js";
import { assertTaskDeletionAvailable } from "./task-delete-lease.js";
import { assertWorkspaceLifecycleAvailable } from "./task-lifecycle-guard.js";
import { insertTaskRelation, normalizeTaskRelation } from "./task-relations.js";

const RawProjectRowSchema = z.object({
  id: z.uuid(),
  projectKey: z.string().nullable(),
  name: z.string(),
  description: z.string(),
  membershipRole: z.enum(["owner", "editor", "executor", "viewer"]).nullable(),
  sourceKind: z.enum(["legacy", "codex", "system"]),
  systemKind: z.enum(["all", "temporary"]).nullable(),
  rootPathsJson: z.string(),
  syncPosition: z.number().int().nullable(),
  syncDeletedAt: z.string().datetime().nullable(),
  syncState: z.enum(["synced", "stale"]),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
});

const RawTaskRowSchema = z.object({
  id: z.uuid(),
  identifier: z.string(),
  projectId: z.uuid(),
  taskNumber: z.number().int().positive(),
  title: z.string(),
  description: z.string(),
  status: z.enum(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"]),
  blockedFromStatus: z.enum(["backlog", "todo", "in_progress", "in_review"]).nullable(),
  priority: z.enum(["none", "urgent", "high", "medium", "low"]),
  labelsJson: z.string(),
  assigneeIdentity: IdentityKeySchema.nullable(),
  assigneeName: z.string().nullable(),
  assigneeAvatarUrl: z.string().url().nullable(),
  creatorIdentity: IdentityKeySchema.nullable(),
  startAt: z.string().datetime().nullable(),
  dueAt: z.string().datetime().nullable(),
  recurrenceJson: z.string().nullable(),
  developmentContextJson: z.string().nullable(),
  linksJson: z.string(),
  sortOrder: z.number().finite(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
});

const InternalTaskViewSchema = TaskViewBaseSchema.omit({
  projectName: true,
  originProjectName: true,
  codexThreadState: true,
  descriptionLocked: true,
  developmentContextLocked: true,
  permissions: true,
});
type InternalTaskView = z.infer<typeof InternalTaskViewSchema>;

const DevelopmentContextReferenceSchema = z.object({ id: z.uuid() });

const IdempotencyRowSchema = z.object({
  requestHash: z.string().length(64),
  responseJson: z.string(),
});

const TaskCreationRollbackRecordSchema = z.object({
  scope: z.string(),
  responseJson: z.string(),
});

export interface MutationContext {
  readonly actor: PrincipalView;
  readonly idempotencyKey: string;
  readonly requestId?: string;
}

interface TaskboardOptions {
  readonly database: SqliteDatabase;
  readonly identityService: IdentityService;
  readonly temporaryProjectRoot?: string | undefined;
  readonly now?: () => Date;
  readonly onRevisionCommitted?: (revision: number) => void;
}

const TASK_COLUMNS = `
  tasks.id,
  tasks.identifier,
  tasks.project_id AS projectId,
  tasks.task_number AS taskNumber,
  tasks.title,
  tasks.description,
  tasks.status,
  tasks.blocked_from_status AS blockedFromStatus,
  tasks.priority,
  tasks.labels_json AS labelsJson,
  tasks.assignee_identity_key AS assigneeIdentity,
  (SELECT name FROM identities WHERE identities.identity_key = tasks.assignee_identity_key) AS assigneeName,
  (SELECT avatar_url FROM identities WHERE identities.identity_key = tasks.assignee_identity_key) AS assigneeAvatarUrl,
  tasks.creator_identity_key AS creatorIdentity,
  tasks.start_at AS startAt,
  tasks.due_at AS dueAt,
  tasks.recurrence_json AS recurrenceJson,
  tasks.development_context_json AS developmentContextJson,
  tasks.links_json AS linksJson,
  tasks.sort_order AS sortOrder,
  tasks.version,
  tasks.created_at AS createdAt,
  tasks.updated_at AS updatedAt,
  tasks.archived_at AS archivedAt
`;

const PROJECT_COLUMNS = `
  projects.id,
  projects.project_key AS projectKey,
  projects.name,
  projects.description,
  NULL AS membershipRole,
  projects.source_kind AS sourceKind,
  projects.system_kind AS systemKind,
  projects.root_paths_json AS rootPathsJson,
  projects.sync_position AS syncPosition,
  projects.sync_deleted_at AS syncDeletedAt,
  project_sync_state.status AS syncState,
  projects.version,
  projects.created_at AS createdAt,
  projects.updated_at AS updatedAt,
  projects.archived_at AS archivedAt
`;

export class Taskboard {
  readonly #database: SqliteDatabase;
  readonly #identityService: IdentityService;
  readonly #temporaryProjectRoot: string | undefined;
  readonly #now: () => Date;
  readonly #onRevisionCommitted: ((revision: number) => void) | undefined;

  constructor(options: TaskboardOptions) {
    this.#database = options.database;
    this.#identityService = options.identityService;
    this.#temporaryProjectRoot = options.temporaryProjectRoot;
    this.#now = options.now ?? (() => new Date());
    this.#onRevisionCommitted = options.onRevisionCommitted;
  }

  listProjects(actor: PrincipalView): readonly ProjectView[] {
    assertBoardAccess(this.#database, actor);
    const rows: unknown[] = this.#database
      .prepare(
        `SELECT ${PROJECT_COLUMNS}
        FROM projects
        CROSS JOIN project_sync_state
        WHERE projects.archived_at IS NULL
          AND (
            projects.source_kind = 'system'
            OR (
              projects.source_kind = 'codex'
              AND projects.sync_deleted_at IS NULL
            )
          )
        ORDER BY
          CASE projects.system_kind WHEN 'all' THEN 0 WHEN 'temporary' THEN 1 ELSE 2 END,
          projects.sync_position,
          projects.name COLLATE NOCASE`,
      )
      .all();

    return rows.map((row) => this.#projectView(row));
  }

  readBoard(projectId: string, actor: PrincipalView): BoardView {
    const project = this.#readProject(projectId, actor);
    const rows = this.#boardTaskRows(projectId, actor);
    return BoardViewSchema.parse({
      project,
      tasks: rows.map((row) => this.#taskViewForActor(row, actor)),
    });
  }

  readTaskCreationOptions(
    projectId: string,
    actor: PrincipalView,
    readDevelopmentContexts: () => readonly LocalDevelopmentContextView[],
    presentation: {
      readonly defaultDevelopmentContext?: {
        readonly id: string | null;
        readonly label: string;
        readonly branch: string | null;
      };
      readonly attachmentMaxBytes?: number;
    } = {},
  ): ProjectTaskCreationOptionsView {
    const project = this.#readProject(projectId, actor);
    if (project.kind === "all") {
      throw new AppError("INVALID_REQUEST", 409, "全部项目不能创建任务，请先选择实际项目");
    }
    const tasks = this.#boardTaskRows(projectId, actor).map((row) => this.#taskView(row));
    const assignees = this.#database
      .prepare(
        `SELECT
          identities.identity_key AS principalKey,
          identities.name,
          identities.avatar_url AS avatarUrl,
          'member' AS actorRole,
          NULL AS projectRole
        FROM identities
        WHERE identities.active = 1
          AND (${FEISHU_IDENTITY_SQL} OR (identities.kind = 'web' AND EXISTS (SELECT 1 FROM web_accounts WHERE id = identities.user_id)))
          AND identities.identity_key = ?`,
      )
      .all(identityKey(actor.identity));
    const labels = this.#database
      .prepare(
        `SELECT
          id,
          name,
          sort_order AS sortOrder,
          version,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM global_labels
        ORDER BY sort_order, id`,
      )
      .all();
    const relationCandidates = tasks
      .filter((task) => task.status !== "done" && task.status !== "canceled")
      .map(({ id, identifier, title }) => ({ id, identifier, title }))
      .sort(
        (left, right) =>
          left.identifier.localeCompare(right.identifier) || left.id.localeCompare(right.id),
      );

    return ProjectTaskCreationOptionsViewSchema.parse({
      projectId,
      currentIdentity: actor.identity,
      assignees: assignees.map((raw) => {
        const row = z.object({ principalKey: IdentityKeySchema }).passthrough().parse(raw);
        return { ...row, identity: identityFromKey(row.principalKey) };
      }),
      labels,
      developmentContexts: readDevelopmentContexts(),
      defaultDevelopmentContext: presentation.defaultDevelopmentContext ?? {
        id: null,
        label: "无",
        branch: null,
      },
      relationCandidates,
      attachmentMaxBytes: presentation.attachmentMaxBytes ?? 25 * 1024 * 1024,
    });
  }

  readTask(taskId: string, actor: PrincipalView): TaskView {
    const task = this.#taskViewForActor(this.#readTaskRow(taskId), actor);
    if (!task.permissions.canRead) throw new AppError("FORBIDDEN", 403, "没有该任务读取权限");
    return task;
  }

  createTask(command: CreateTaskCommand, context: MutationContext): TaskMutationResult {
    if (context.actor.identity.kind === "service") {
      throw new AppError("FORBIDDEN", 403, "创建任务需要已登录用户");
    }
    const assigneeIdentity = context.actor.identity;
    if (command.assigneeIdentity && !sameIdentity(command.assigneeIdentity, assigneeIdentity)) {
      throw new AppError("FORBIDDEN", 403, "新任务负责人必须是当前发起人");
    }
    this.#validateAssignee(command.projectId, assigneeIdentity);
    const visibleProject = this.#readProject(command.projectId, context.actor);
    if (visibleProject.kind === "all") {
      throw new AppError("INVALID_REQUEST", 409, "全部项目只能选择实际目标项目后创建任务");
    }
    if (visibleProject.kind === "codex") {
      this.#identityService.authorizeProject(context.actor, command.projectId, "write");
    }
    return this.#idempotentMutation(`task.create:${command.projectId}`, command, context, () => {
      const project = this.#readProject(command.projectId, context.actor);
      if (project.kind === "all") {
        throw new AppError("INVALID_REQUEST", 409, "全部项目只能选择实际目标项目后创建任务");
      }
      if (project.archivedAt) {
        throw new AppError("INVALID_REQUEST", 409, "不能在已归档项目中创建任务");
      }
      this.#validateAssignee(command.projectId, assigneeIdentity);
      this.#validateLabels(command.labels);
      this.#validateDevelopmentContext(command.projectId, command.developmentContextId);
      const initialRelations = this.#validatedInitialRelations(command, context.actor);
      for (const relation of initialRelations) {
        assertTaskDeletionAvailable(this.#database, relation.targetTaskId);
      }

      const timestamp = this.#now().toISOString();
      const taskId = randomUUID();
      const taskNumber = this.#database
        .prepare("SELECT next_task_number FROM projects WHERE id = ?")
        .pluck()
        .get(command.projectId) as number;
      const identifier = formatTaskIdentifier(project.projectKey, taskNumber);
      const blockedFromStatus = command.status === "blocked" ? ("in_progress" as const) : null;
      const sortOrder = this.#nextSortOrder(
        command.projectId,
        blockedFromStatus ?? command.status,
        null,
      );

      this.#database
        .prepare(`UPDATE projects SET next_task_number = next_task_number + 1 WHERE id = ?`)
        .run(command.projectId);
      this.#database
        .prepare(
          `INSERT INTO tasks (
              id, identifier, project_id, task_number, title, description, status, priority,
              blocked_from_status, labels_json, assignee_identity_key, creator_identity_key, start_at, due_at,
              recurrence_json, development_context_json, links_json, sort_order, version,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          taskId,
          identifier,
          command.projectId,
          taskNumber,
          command.title,
          command.description,
          command.status,
          command.priority,
          blockedFromStatus,
          JSON.stringify(command.labels),
          identityKey(assigneeIdentity),
          identityKey(context.actor.identity),
          this.#normalizedTimestamp(command.startAt),
          this.#normalizedTimestamp(command.dueAt),
          command.recurrence ? JSON.stringify(command.recurrence) : null,
          command.developmentContextId
            ? JSON.stringify({ id: command.developmentContextId })
            : null,
          JSON.stringify(command.links),
          sortOrder,
          timestamp,
          timestamp,
        );
      const task = this.#readTask(taskId, context.actor);
      this.#recordActivity(
        taskId,
        identityKey(context.actor.identity),
        "task.created",
        {
          identifier,
          fields: [
            "title",
            "description",
            "status",
            "priority",
            "labels",
            "assigneeIdentity",
            "startAt",
            "dueAt",
            "recurrence",
            "developmentContextId",
            "links",
          ],
        },
        timestamp,
      );
      let revision = this.#recordChange(task, "task.created", timestamp);
      for (const initialRelation of initialRelations) {
        const relationId = randomUUID();
        const normalized = normalizeTaskRelation(
          taskId,
          initialRelation.targetTaskId,
          initialRelation.relationType,
        );
        insertTaskRelation(this.#database, {
          id: relationId,
          projectId: command.projectId,
          ...normalized,
          createdBy: identityKey(context.actor.identity),
          createdAt: timestamp,
        });
        this.#recordActivity(
          taskId,
          identityKey(context.actor.identity),
          "relation.created",
          {
            relationId,
            relationType: initialRelation.relationType,
            targetTaskId: initialRelation.targetTaskId,
            initial: true,
          },
          timestamp,
        );
        revision = this.#recordRelationChange(
          task,
          "relation.created",
          relationId,
          initialRelation.targetTaskId,
          timestamp,
        );
        this.#recordRelationAudit(relationId, task.projectId, context, timestamp);
      }
      this.#recordAudit("task.create", task, context, timestamp);
      return TaskMutationResultSchema.parse({ task, revision });
    });
  }

  rollbackTaskCreation(taskId: string, context: MutationContext): number {
    const timestamp = this.#now().toISOString();
    const revision = withTransaction(this.#database, () => {
      assertTaskDeletionAvailable(this.#database, taskId);
      const rollbackRecord = TaskCreationRollbackRecordSchema.safeParse(
        this.#database
          .prepare(
            `SELECT scope, response_json AS responseJson FROM request_idempotency
            WHERE identity_key = ? AND idempotency_key = ?
              AND scope LIKE 'task.create:%'
              AND json_extract(response_json, '$.task.id') = ?`,
          )
          .get(identityKey(context.actor.identity), context.idempotencyKey, taskId),
      );
      if (!rollbackRecord.success) {
        throw new AppError("INVALID_REQUEST", 409, "任务创建记录不能撤销");
      }
      const creationResult = TaskMutationResultSchema.parse(
        JSON.parse(rollbackRecord.data.responseJson),
      );
      const task = this.#readTask(taskId);
      if (!sameIdentity(task.creatorIdentity, context.actor.identity)) {
        throw new AppError("FORBIDDEN", 403, "只能撤销当前请求创建的任务");
      }
      this.#assertExpectedVersion(task, creationResult.task.version);
      const dependentCount = this.#database
        .prepare(
          `SELECT
            (SELECT count(*) FROM task_threads WHERE task_id = ?) +
            (SELECT count(*) FROM jobs WHERE task_id = ?) +
            (SELECT count(*) FROM comments WHERE task_id = ?) +
            (SELECT count(*) FROM attachments WHERE task_id = ?)`,
        )
        .pluck()
        .get(taskId, taskId, taskId, taskId) as number;
      if (dependentCount !== 0) {
        throw new AppError("INVALID_REQUEST", 409, "任务已有后续数据，不能撤销创建");
      }
      const initialRelationIds = new Set(
        this.#database
          .prepare(
            `SELECT json_extract(changes_json, '$.relationId')
            FROM activities
            WHERE task_id = ?
              AND kind = 'relation.created'
              AND json_extract(changes_json, '$.initial') = 1`,
          )
          .pluck()
          .all(taskId) as string[],
      );
      const relations = this.#database
        .prepare(
          `SELECT id, source_task_id AS sourceTaskId, target_task_id AS targetTaskId
          FROM task_relations WHERE source_task_id = ? OR target_task_id = ?
          ORDER BY created_at, id`,
        )
        .all(taskId, taskId) as Array<{
        id: string;
        sourceTaskId: string;
        targetTaskId: string;
      }>;
      if (relations.some((relation) => !initialRelationIds.has(relation.id))) {
        throw new AppError("INVALID_REQUEST", 409, "任务已有后续数据，不能撤销创建");
      }
      for (const relation of relations.filter(({ id }) => initialRelationIds.has(id))) {
        const relatedTaskId =
          relation.sourceTaskId === taskId ? relation.targetTaskId : relation.sourceTaskId;
        this.#database.prepare("DELETE FROM task_relations WHERE id = ?").run(relation.id);
        this.#recordActivity(
          taskId,
          identityKey(context.actor.identity),
          "relation.deleted",
          { relationId: relation.id, relatedTaskId, initial: true },
          timestamp,
        );
        this.#recordRelationChange(task, "relation.deleted", relation.id, relatedTaskId, timestamp);
      }
      this.#database
        .prepare(
          "DELETE FROM request_idempotency WHERE identity_key = ? AND scope = ? AND idempotency_key = ?",
        )
        .run(
          identityKey(context.actor.identity),
          rollbackRecord.data.scope,
          context.idempotencyKey,
        );
      const archived = this.#database
        .prepare(
          `UPDATE tasks SET status = 'canceled', archived_at = ?, version = version + 1,
            updated_at = ? WHERE id = ? AND version = ? AND archived_at IS NULL`,
        )
        .run(timestamp, timestamp, taskId, creationResult.task.version);
      this.#assertMutationApplied(archived.changes, taskId, creationResult.task.version);
      this.#recordActivity(
        taskId,
        identityKey(context.actor.identity),
        "task.creation_failed",
        { archivedAt: timestamp },
        timestamp,
      );
      const result = this.#database
        .prepare(
          `INSERT INTO change_events (
            aggregate_type, aggregate_id, event_type, safe_payload_json, created_at
          ) VALUES ('task', ?, 'task.creation_failed', ?, ?)`,
        )
        .run(taskId, JSON.stringify({ projectId: task.projectId, taskId }), timestamp);
      return Number(result.lastInsertRowid);
    });
    this.#onRevisionCommitted?.(revision);
    return revision;
  }

  finalizeTaskCreation(
    taskId: string,
    revision: number,
    context: MutationContext,
  ): TaskMutationResult {
    return withTransaction(this.#database, () => {
      assertTaskDeletionAvailable(this.#database, taskId);
      const task = this.readTask(taskId, context.actor);
      const result = TaskMutationResultSchema.parse({ task, revision });
      const updated = this.#database
        .prepare(
          `UPDATE request_idempotency SET response_json = ?
          WHERE identity_key = ? AND idempotency_key = ?
            AND scope LIKE 'task.create:%'
            AND json_extract(response_json, '$.task.id') = ?`,
        )
        .run(
          JSON.stringify(result),
          identityKey(context.actor.identity),
          context.idempotencyKey,
          taskId,
        );
      if (updated.changes !== 1) {
        throw new AppError("INVALID_REQUEST", 409, "任务创建幂等记录不存在");
      }
      return result;
    });
  }

  updateTask(
    taskId: string,
    command: UpdateTaskCommand,
    context: MutationContext,
  ): TaskMutationResult {
    const visible = this.readTask(taskId, context.actor);
    if (!visible.permissions.canWrite) throw new AppError("FORBIDDEN", 403, "没有该任务写入权限");
    return this.#idempotentMutation(`task.update:${taskId}`, command, context, () => {
      assertTaskDeletionAvailable(this.#database, taskId);
      const current = this.#readTask(taskId);
      this.#assertProjectMutable(current.projectId, context.actor);
      this.#assertExpectedVersion(current, command.expectedVersion);
      this.#assertTaskMutable(current);
      assertTaskEditable(current);

      if (
        command.description !== undefined &&
        command.description !== current.description &&
        this.#descriptionLocked(taskId)
      ) {
        throw new AppError("INVALID_REQUEST", 409, "任务描述已锁定，请通过评论提出后续修改");
      }
      if (
        command.developmentContextId !== undefined &&
        command.developmentContextId !== current.developmentContextId &&
        this.#developmentContextLocked(taskId)
      ) {
        throw new AppError("INVALID_REQUEST", 409, "任务已开始执行，不能切换分支");
      }
      const next = {
        title: command.title ?? current.title,
        description: command.description ?? current.description,
        priority: command.priority ?? current.priority,
        labels: command.labels ?? current.labels,
        assigneeIdentity:
          command.assigneeIdentity === undefined
            ? current.assigneeIdentity
            : command.assigneeIdentity,
        startAt: command.startAt === undefined ? current.startAt : command.startAt,
        dueAt: command.dueAt === undefined ? current.dueAt : command.dueAt,
        recurrence: command.recurrence === undefined ? current.recurrence : command.recurrence,
        links: command.links ?? current.links,
        developmentContextId:
          command.developmentContextId === undefined
            ? current.developmentContextId
            : command.developmentContextId,
      };
      this.#validateDateRange(next.startAt, next.dueAt);
      if (command.assigneeIdentity !== undefined) {
        if (
          context.actor.identity.kind === "service" ||
          !sameIdentity(command.assigneeIdentity, context.actor.identity)
        ) {
          throw new AppError("FORBIDDEN", 403, "负责人必须是当前登录用户");
        }
        this.#validateAssignee(current.projectId, command.assigneeIdentity);
      }
      this.#validateLabels(next.labels);
      this.#validateDevelopmentContext(current.projectId, next.developmentContextId);
      const timestamp = this.#now().toISOString();

      const update = this.#database
        .prepare(
          `UPDATE tasks SET
            title = ?,
            description = ?,
            priority = ?,
            labels_json = ?,
            assignee_identity_key = ?,
            start_at = ?,
            due_at = ?,
            recurrence_json = ?,
            development_context_json = ?,
            links_json = ?,
            version = version + 1,
            updated_at = ?
          WHERE id = ? AND version = ? AND archived_at IS NULL`,
        )
        .run(
          next.title,
          next.description,
          next.priority,
          JSON.stringify(next.labels),
          next.assigneeIdentity ? identityKey(next.assigneeIdentity) : null,
          this.#normalizedTimestamp(next.startAt),
          this.#normalizedTimestamp(next.dueAt),
          next.recurrence ? JSON.stringify(next.recurrence) : null,
          next.developmentContextId ? JSON.stringify({ id: next.developmentContextId }) : null,
          JSON.stringify(next.links),
          timestamp,
          taskId,
          command.expectedVersion,
        );
      this.#assertMutationApplied(update.changes, taskId, command.expectedVersion);
      const task = this.#readTask(taskId, context.actor);
      const fields = (Object.keys(next) as Array<keyof typeof next>).filter(
        (field) => stableStringify(current[field]) !== stableStringify(task[field]),
      );
      const values = Object.fromEntries(
        fields.map((field) => [
          field,
          {
            from:
              field === "assigneeIdentity"
                ? (current.assignee ?? current.assigneeIdentity)
                : current[field],
            to:
              field === "assigneeIdentity" ? (task.assignee ?? task.assigneeIdentity) : task[field],
          },
        ]),
      );
      if (fields.length > 0)
        this.#recordActivity(
          taskId,
          identityKey(context.actor.identity),
          "task.updated",
          { fields, values },
          timestamp,
        );
      const revision = this.#recordChange(task, "task.updated", timestamp);
      this.#recordAudit("task.update", task, context, timestamp);
      return TaskMutationResultSchema.parse({ task, revision });
    });
  }

  moveTask(taskId: string, command: MoveTaskCommand, context: MutationContext): TaskMutationResult {
    const visible = this.readTask(taskId, context.actor);
    if (!visible.permissions.canWrite) throw new AppError("FORBIDDEN", 403, "没有该任务写入权限");
    return this.#idempotentMutation(`task.move:${taskId}`, command, context, () => {
      assertTaskDeletionAvailable(this.#database, taskId);
      const current = this.#readTask(taskId);
      this.#assertProjectMutable(current.projectId, context.actor);
      this.#assertExpectedVersion(current, command.expectedVersion);
      this.#assertTaskMutable(current);
      this.#validateDevelopmentContext(current.projectId, current.developmentContextId);
      const threadDirectory = this.#database
        .prepare("SELECT cwd FROM task_threads WHERE task_id = ? AND is_primary = 1")
        .get(taskId) as { cwd: string } | undefined;
      if (threadDirectory) assertWorkspaceLifecycleAvailable(this.#database, threadDirectory.cwd);
      if (
        command.targetStatus === "blocked" &&
        (current.status === "done" || current.status === "canceled")
      ) {
        throw new AppError(
          "INVALID_REQUEST",
          409,
          "已完成或已取消任务必须先恢复到活动状态，再标记为已阻塞",
        );
      }
      assertTaskEditable(current);
      const nextBlockedFromStatus =
        command.targetStatus === "blocked"
          ? current.status === "blocked"
            ? current.blockedFromStatus
            : current.status
          : null;
      if (command.targetStatus === "blocked" && nextBlockedFromStatus === null) {
        throw new AppError("INVALID_REQUEST", 409, "任务缺少可恢复的阻塞前状态");
      }
      const sortOrder = this.#calculateSortOrder(
        current.projectId,
        nextBlockedFromStatus ?? command.targetStatus,
        taskId,
        context.actor,
        command.boardProjectId,
        command.beforeTaskId,
        command.afterTaskId,
      );
      const timestamp = this.#now().toISOString();

      const update = this.#database
        .prepare(
          `UPDATE tasks SET
            status = ?,
            blocked_from_status = ?,
            sort_order = ?,
            version = version + 1,
            updated_at = ?
          WHERE id = ? AND version = ? AND archived_at IS NULL`,
        )
        .run(
          command.targetStatus,
          nextBlockedFromStatus,
          sortOrder,
          timestamp,
          taskId,
          command.expectedVersion,
        );
      this.#assertMutationApplied(update.changes, taskId, command.expectedVersion);
      const task = this.#readTask(taskId, context.actor);
      this.#recordActivity(
        taskId,
        identityKey(context.actor.identity),
        "task.moved",
        {
          status: { from: current.status, to: task.status },
          sortOrder: { from: current.sortOrder, to: task.sortOrder },
        },
        timestamp,
      );
      const revision = this.#recordChange(task, "task.moved", timestamp);
      this.#recordAudit("task.move", task, context, timestamp);
      return TaskMutationResultSchema.parse({ task, revision });
    });
  }

  archiveTask(
    taskId: string,
    command: ArchiveTaskCommand,
    context: MutationContext,
  ): TaskMutationResult {
    return this.#setArchived(taskId, command, context, true);
  }

  restoreTask(
    taskId: string,
    command: RestoreTaskCommand,
    context: MutationContext,
    prepareRestore?: () => void,
  ): TaskMutationResult {
    return this.#setArchived(taskId, command, context, false, prepareRestore);
  }

  reassignTask(
    taskId: string,
    command: ReassignTaskCommand,
    context: MutationContext,
  ): TaskMutationResult {
    const visible = this.readTask(taskId, context.actor);
    if (visible.projectId !== TEMPORARY_PROJECT_ID || !visible.permissions.canReassign) {
      throw new AppError("INVALID_REQUEST", 409, "只有临时项目中的历史任务可以重新分配");
    }
    this.#assertExpectedVersion(visible, command.expectedVersion);
    const target = this.#readProject(command.targetProjectId, context.actor);
    if (target.kind !== "codex") {
      throw new AppError("INVALID_REQUEST", 409, "只能重新分配到有效的 Codex 项目");
    }
    this.#identityService.authorizeProject(context.actor, target.id, "write");

    return this.#idempotentMutation(`task.reassign:${taskId}`, command, context, () => {
      assertTaskDeletionAvailable(this.#database, taskId);
      const orphan = this.#database
        .prepare(
          `SELECT source_project_id AS sourceProjectId
          FROM project_orphaned_tasks WHERE task_id = ?`,
        )
        .get(taskId) as { sourceProjectId: string } | undefined;
      if (!orphan) throw new AppError("INVALID_REQUEST", 409, "任务已不再等待重新分配");
      const taskIds =
        command.mode === "origin_group"
          ? (this.#database
              .prepare(
                `SELECT orphan.task_id
                FROM project_orphaned_tasks AS orphan
                JOIN tasks ON tasks.id = orphan.task_id
                WHERE orphan.source_project_id = ? AND tasks.project_id = ?
                ORDER BY orphan.source_task_number`,
              )
              .pluck()
              .all(orphan.sourceProjectId, TEMPORARY_PROJECT_ID) as string[])
          : [taskId];
      const selected = new Set(taskIds);
      for (const movingTaskId of taskIds) {
        assertTaskDeletionAvailable(this.#database, movingTaskId);
        assertTaskEditable(this.#readTask(movingTaskId));
      }
      const placeholders = taskIds.map(() => "?").join(",");
      const relations = this.#database
        .prepare(
          `SELECT source_task_id AS sourceTaskId, target_task_id AS targetTaskId
          FROM task_relations
          WHERE source_task_id IN (${placeholders}) OR target_task_id IN (${placeholders})`,
        )
        .all(...taskIds, ...taskIds) as { sourceTaskId: string; targetTaskId: string }[];
      if (
        relations.some(
          (relation) =>
            !selected.has(relation.sourceTaskId) || !selected.has(relation.targetTaskId),
        )
      ) {
        throw new AppError("INVALID_REQUEST", 409, "任务关系要求按原项目整组重新分配");
      }
      for (const movingTaskId of taskIds) {
        const cwd = this.#database
          .prepare("SELECT cwd FROM task_threads WHERE task_id = ? AND is_primary = 1")
          .pluck()
          .get(movingTaskId) as string | undefined;
        if (cwd && !this.#pathBelongsToRoots(cwd, target.rootPaths)) {
          throw new AppError("INVALID_REQUEST", 409, "任务 Thread 目录不属于目标项目");
        }
      }

      this.#database.pragma("defer_foreign_keys = ON");
      const timestamp = this.#now().toISOString();
      let nextTaskNumber = this.#database
        .prepare("SELECT next_task_number FROM projects WHERE id = ?")
        .pluck()
        .get(target.id) as number;
      let revision = 0;
      for (const movingTaskId of taskIds) {
        this.#database
          .prepare(
            `UPDATE tasks SET
              project_id = ?, task_number = ?, development_context_json = NULL,
              version = version + 1, updated_at = ?
            WHERE id = ? AND project_id = ?`,
          )
          .run(target.id, nextTaskNumber, timestamp, movingTaskId, TEMPORARY_PROJECT_ID);
        nextTaskNumber += 1;
      }
      this.#database
        .prepare(
          `UPDATE task_relations SET project_id = ?
          WHERE project_id = ?
            AND source_task_id IN (${placeholders})
            AND target_task_id IN (${placeholders})`,
        )
        .run(target.id, TEMPORARY_PROJECT_ID, ...taskIds, ...taskIds);
      this.#database
        .prepare(`DELETE FROM project_orphaned_tasks WHERE task_id IN (${placeholders})`)
        .run(...taskIds);
      this.#database
        .prepare("UPDATE projects SET next_task_number = ?, updated_at = ? WHERE id = ?")
        .run(nextTaskNumber, timestamp, target.id);
      for (const movingTaskId of taskIds) {
        const moved = this.#readTask(movingTaskId, context.actor);
        this.#recordActivity(
          movingTaskId,
          identityKey(context.actor.identity),
          "task.reassigned",
          { targetProjectId: target.id, mode: command.mode },
          timestamp,
        );
        revision = this.#recordChange(moved, "task.reassigned", timestamp);
      }
      const task = this.#readTask(taskId, context.actor);
      this.#recordAudit("task.reassign", task, context, timestamp);
      return TaskMutationResultSchema.parse({ task, revision });
    });
  }

  #setArchived(
    taskId: string,
    command: ArchiveTaskCommand,
    context: MutationContext,
    archived: boolean,
    prepareRestore?: () => void,
  ): TaskMutationResult {
    const visible = this.readTask(taskId, context.actor);
    if (!visible.permissions.canWrite) throw new AppError("FORBIDDEN", 403, "没有该任务写入权限");
    const action = archived ? "archive" : "restore";
    return this.#idempotentMutation(`task.${action}:${taskId}`, command, context, () => {
      const current = this.#readTask(taskId);
      this.#assertProjectMutable(current.projectId, context.actor);
      this.#assertExpectedVersion(current, command.expectedVersion);
      // Runs inside the restore transaction, after authorization/version checks.
      // A failed restore rolls back release of any abandoned deletion lease.
      if (!archived) prepareRestore?.();
      assertTaskDeletionAvailable(this.#database, taskId);
      if (!archived && !current.archivedAt && current.status === "canceled") {
        this.#assertTaskMutable(current);
        // Restoring status must work after the task worktree has been cleaned up.
        // Keep workspace locks and project ownership checks, but allow inactive contexts.
        this.#validateDevelopmentContext(current.projectId, current.developmentContextId, true);
        const thread = this.#database
          .prepare("SELECT cwd FROM task_threads WHERE task_id = ? AND is_primary = 1")
          .get(taskId) as { cwd: string } | undefined;
        if (thread) assertWorkspaceLifecycleAvailable(this.#database, thread.cwd);
        const previous = this.#database
          .prepare(
            "SELECT status, blocked_from_status AS blockedFromStatus, sort_order AS sortOrder FROM task_cancellation_states WHERE task_id = ?",
          )
          .get(taskId) as
          { status: TaskStatus; blockedFromStatus: string | null; sortOrder: number } | undefined;
        const timestamp = this.#now().toISOString();
        this.#database
          .prepare(
            "UPDATE tasks SET status = ?, blocked_from_status = ?, sort_order = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
          )
          .run(
            previous?.status ?? "todo",
            previous?.blockedFromStatus ?? null,
            previous?.sortOrder ?? current.sortOrder,
            timestamp,
            taskId,
            command.expectedVersion,
          );
        const task = this.#readTask(taskId, context.actor);
        this.#recordActivity(
          taskId,
          identityKey(context.actor.identity),
          "task.restored",
          { status: { from: current.status, to: task.status } },
          timestamp,
        );
        const revision = this.#recordChange(task, "task.restored", timestamp);
        this.#recordAudit("task.restore", task, context, timestamp);
        return TaskMutationResultSchema.parse({ task, revision });
      }
      if (archived === (current.archivedAt !== null)) {
        throw new AppError("INVALID_REQUEST", 409, archived ? "任务已经归档" : "任务尚未归档");
      }
      const timestamp = this.#now().toISOString();
      const update = this.#database
        .prepare(
          `UPDATE tasks SET
            archived_at = ?,
            version = version + 1,
            updated_at = ?
          WHERE id = ? AND version = ?`,
        )
        .run(archived ? timestamp : null, timestamp, taskId, command.expectedVersion);
      this.#assertMutationApplied(update.changes, taskId, command.expectedVersion);
      const task = this.#readTask(taskId, context.actor);
      this.#recordActivity(
        taskId,
        identityKey(context.actor.identity),
        archived ? "task.archived" : "task.restored",
        { archivedAt: { from: current.archivedAt, to: task.archivedAt } },
        timestamp,
      );
      const revision = this.#recordChange(
        task,
        archived ? "task.archived" : "task.restored",
        timestamp,
      );
      this.#recordAudit(archived ? "task.archive" : "task.restore", task, context, timestamp);
      return TaskMutationResultSchema.parse({ task, revision });
    });
  }

  #idempotentMutation(
    scope: string,
    request: unknown,
    context: MutationContext,
    operation: () => TaskMutationResult,
  ): TaskMutationResult {
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
        return {
          result: TaskMutationResultSchema.parse(JSON.parse(existing.data.responseJson)),
          committed: false,
        };
      }

      const result = operation();
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
    if (outcome.committed) {
      this.#onRevisionCommitted?.(outcome.result.revision);
    }
    return outcome.result;
  }

  #readProject(projectId: string, actor: PrincipalView): ProjectView {
    assertBoardAccess(this.#database, actor);
    const raw: unknown = this.#database
      .prepare(
        `SELECT ${PROJECT_COLUMNS}
        FROM projects
        CROSS JOIN project_sync_state
        WHERE projects.id = ?
          AND (projects.source_kind != 'codex' OR projects.sync_deleted_at IS NULL)`,
      )
      .get(projectId);
    if (!raw) {
      throw new AppError("NOT_FOUND", 404, "项目不存在");
    }
    const row = RawProjectRowSchema.parse(raw);
    if (row.sourceKind !== "system") {
      this.#identityService.authorizeProject(actor, projectId, "read");
    }
    return this.#projectView(row);
  }

  #projectView(raw: unknown): ProjectView {
    const row = RawProjectRowSchema.parse(raw);
    const roots: unknown = JSON.parse(row.rootPathsJson);
    return ProjectViewSchema.parse({
      ...row,
      kind: row.sourceKind === "system" ? row.systemKind : "codex",
      rootPaths:
        row.sourceKind === "system" && row.systemKind === "temporary" && this.#temporaryProjectRoot
          ? [this.#temporaryProjectRoot]
          : roots,
    });
  }

  #readTaskRow(taskId: string): unknown {
    const raw: unknown = this.#database
      .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`)
      .get(taskId);
    if (!raw) {
      throw new AppError("NOT_FOUND", 404, "任务不存在");
    }
    return raw;
  }

  #readTask(taskId: string): InternalTaskView;
  #readTask(taskId: string, actor: PrincipalView): TaskView;
  #readTask(taskId: string, actor?: PrincipalView): InternalTaskView | TaskView {
    const row = this.#readTaskRow(taskId);
    return actor ? this.#taskViewForActor(row, actor) : this.#taskView(row);
  }

  #taskView(raw: unknown): InternalTaskView {
    const row = RawTaskRowSchema.parse(raw);
    const labels: unknown = JSON.parse(row.labelsJson);
    const recurrence: unknown = row.recurrenceJson ? JSON.parse(row.recurrenceJson) : null;
    const developmentContext: unknown = row.developmentContextJson
      ? JSON.parse(row.developmentContextJson)
      : null;
    const links: unknown = JSON.parse(row.linksJson);
    return InternalTaskViewSchema.parse({
      ...row,
      assigneeIdentity: row.assigneeIdentity ? identityFromKey(row.assigneeIdentity) : null,
      creatorIdentity: row.creatorIdentity ? identityFromKey(row.creatorIdentity) : null,
      assignee:
        row.assigneeIdentity && row.assigneeName
          ? {
              identity: identityFromKey(row.assigneeIdentity),
              name: row.assigneeName,
              avatarUrl: row.assigneeAvatarUrl,
            }
          : null,
      labels: TaskLabelsSchema.parse(labels),
      recurrence: recurrence === null ? null : TaskRecurrenceRuleSchema.parse(recurrence),
      developmentContextId:
        developmentContext === null
          ? null
          : DevelopmentContextReferenceSchema.parse(developmentContext).id,
      links,
    });
  }

  #taskViewForActor(raw: unknown, actor: PrincipalView): TaskView {
    const task = this.#taskView(raw);
    const context = this.#database
      .prepare(
        `SELECT
          current.name AS projectName,
          orphan.source_project_id AS sourceProjectId,
          source.name AS originProjectName,
          task_threads.thread_id AS threadId,
          task_threads.last_turn_id AS lastTurnId,
          task_threads.cwd AS workingDirectory
        FROM projects AS current
        LEFT JOIN project_orphaned_tasks AS orphan ON orphan.task_id = ?
        LEFT JOIN projects AS source ON source.id = orphan.source_project_id
        LEFT JOIN task_threads ON task_threads.task_id = ? AND task_threads.is_primary = 1
        WHERE current.id = ?`,
      )
      .get(task.id, task.id, task.projectId) as
      | {
          projectName: string;
          sourceProjectId: string | null;
          originProjectName: string | null;
          threadId: string | null;
          lastTurnId: string | null;
          workingDirectory: string | null;
        }
      | undefined;
    if (!context) throw new AppError("NOT_FOUND", 404, "任务所属项目不存在");
    const canRead = hasBoardAccess(this.#database, actor);
    const canWrite = canRead;
    const canExecute = canRead;
    return TaskViewSchema.parse({
      ...task,
      descriptionLocked: this.#descriptionLocked(task.id),
      developmentContextLocked: this.#developmentContextLocked(task.id),
      projectName: context.projectName,
      originProjectName: context.originProjectName,
      workingDirectory: context.workingDirectory,
      codexThreadState: context.threadId ? (context.lastTurnId ? "started" : "draft") : "none",
      permissions: {
        canRead,
        canWrite,
        canExecute,
        canReassign:
          canWrite && task.projectId === TEMPORARY_PROJECT_ID && context.sourceProjectId !== null,
      },
    });
  }

  #developmentContextLocked(taskId: string): boolean {
    return Boolean(
      this.#database
        .prepare(
          "SELECT 1 FROM jobs WHERE task_id = ? AND kind <> 'cancel' UNION ALL SELECT 1 FROM task_threads WHERE task_id = ? AND last_turn_id IS NOT NULL LIMIT 1",
        )
        .get(taskId, taskId),
    );
  }

  #descriptionLocked(taskId: string): boolean {
    return Boolean(
      this.#database
        .prepare(
          "SELECT 1 FROM jobs WHERE task_id = ? AND kind <> 'cancel' AND status IN ('queued', 'running', 'waiting_approval', 'waiting_input', 'canceling', 'succeeded') LIMIT 1",
        )
        .get(taskId),
    );
  }

  #boardTaskRows(projectId: string, actor: PrincipalView): unknown[] {
    const order = `ORDER BY
      CASE COALESCE(tasks.blocked_from_status, tasks.status)
        WHEN 'backlog' THEN 0 WHEN 'todo' THEN 1 WHEN 'in_progress' THEN 2
        WHEN 'in_review' THEN 3 WHEN 'done' THEN 4 WHEN 'canceled' THEN 5
      END,
      tasks.sort_order,
      tasks.task_number,
      tasks.id`;
    assertBoardAccess(this.#database, actor);
    if (projectId === ALL_PROJECT_ID) {
      return this.#database
        .prepare(
          `SELECT ${TASK_COLUMNS}
        FROM tasks JOIN projects AS current ON current.id = tasks.project_id
        WHERE tasks.archived_at IS NULL AND (
          (current.source_kind = 'codex' AND current.sync_deleted_at IS NULL)
          OR tasks.project_id = ?
        ) ${order}`,
        )
        .all(TEMPORARY_PROJECT_ID);
    }
    return this.#database
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM tasks WHERE project_id = ? AND archived_at IS NULL ${order}`,
      )
      .all(projectId);
  }

  #pathBelongsToRoots(cwd: string, roots: readonly string[]): boolean {
    if (!isAbsolute(cwd)) return false;
    const path = this.#canonicalPath(cwd);
    return roots.some((root) => {
      const relativePath = relative(this.#canonicalPath(root), path);
      return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`));
    });
  }

  #canonicalPath(path: string): string {
    try {
      return realpathSync.native(path);
    } catch {
      return resolve(path);
    }
  }

  #validateAssignee(_projectId: string, identity: UserIdentityRef | null): void {
    if (!identity) {
      return;
    }
    assertUserAssignee(this.#database, identityKey(UserIdentityRefSchema.parse(identity)));
  }

  #validateLabels(labels: readonly string[]): void {
    if (labels.length === 0) return;
    const placeholders = labels.map(() => "?").join(", ");
    const existing = this.#database
      .prepare(`SELECT name FROM global_labels WHERE name IN (${placeholders})`)
      .pluck()
      .all(...labels) as string[];
    if (existing.length !== labels.length) {
      throw new AppError("INVALID_REQUEST", 400, "任务标签必须来自全局标签库");
    }
  }

  #validateDevelopmentContext(
    projectId: string,
    contextId: string | null,
    allowInactive = false,
  ): void {
    const location = this.#database
      .prepare(
        `SELECT COALESCE(contexts.worktree_realpath, projects.workspace_realpath) AS cwd FROM projects LEFT JOIN project_development_contexts contexts ON contexts.project_id = projects.id AND contexts.id = ? WHERE projects.id = ?`,
      )
      .get(contextId, projectId) as { cwd: string | null } | undefined;
    if (location?.cwd) assertWorkspaceLifecycleAvailable(this.#database, location.cwd);
    if (!contextId) {
      return;
    }
    const context = this.#database
      .prepare(
        `SELECT 1 FROM project_development_contexts
        WHERE id = ? AND project_id = ? AND (active = 1 OR ? = 1)`,
      )
      .get(contextId, projectId, Number(allowInactive));
    if (!context) {
      throw new AppError("INVALID_REQUEST", 400, "开发上下文不属于当前项目或已失效");
    }
  }

  #validatedInitialRelations(command: CreateTaskCommand, actor: PrincipalView) {
    const candidates = [
      ...(command.initialRelations.parentTaskId
        ? [
            {
              relationType: "parent" as const,
              targetTaskId: command.initialRelations.parentTaskId,
            },
          ]
        : []),
      ...(command.initialRelations.childTaskId
        ? [
            {
              relationType: "child" as const,
              targetTaskId: command.initialRelations.childTaskId,
            },
          ]
        : []),
      ...(command.initialRelations.childTaskIds ?? []).map((targetTaskId) => ({
        relationType: "child" as const,
        targetTaskId,
      })),
      ...[...command.initialRelations.relatedTaskIds]
        .sort((left, right) => left.localeCompare(right))
        .map((targetTaskId) => ({ relationType: "related" as const, targetTaskId })),
    ];
    if (new Set(candidates.map(({ targetTaskId }) => targetTaskId)).size !== candidates.length) {
      throw new AppError("INVALID_REQUEST", 400, "父任务、子任务和关联任务不能指向同一任务");
    }
    for (const candidate of candidates) {
      const target = this.readTask(candidate.targetTaskId, actor);
      assertTaskEditable(target);
      if (target.projectId !== command.projectId) {
        throw new AppError("INVALID_REQUEST", 400, "任务关系必须位于同一项目");
      }
      if (target.archivedAt) {
        throw new AppError("INVALID_REQUEST", 409, "不能关联已归档任务");
      }
    }
    return candidates;
  }

  #assertExpectedVersion(task: InternalTaskView | TaskView, expectedVersion: number): void {
    if (task.version !== expectedVersion) {
      throw new AppError("VERSION_CONFLICT", 409, "任务版本已变化，请重新加载", {
        details: { current: TaskConflictSummarySchema.parse(task) },
      });
    }
  }

  #assertMutationApplied(changes: number, taskId: string, expectedVersion: number): void {
    if (changes === 1) {
      return;
    }
    const current = this.#readTask(taskId);
    this.#assertExpectedVersion(current, expectedVersion);
    throw new AppError("INTERNAL_ERROR", 500, "任务写入未生效");
  }

  #assertTaskMutable(task: InternalTaskView | TaskView): void {
    if (task.archivedAt) {
      throw new AppError("INVALID_REQUEST", 409, "已归档任务不能编辑或移动");
    }
  }

  #assertProjectMutable(projectId: string, actor: PrincipalView): void {
    if (this.#readProject(projectId, actor).archivedAt) {
      throw new AppError("INVALID_REQUEST", 409, "已归档项目不能修改任务");
    }
  }

  #validateDateRange(startAt: string | null, dueAt: string | null): void {
    if (startAt && dueAt && new Date(startAt).getTime() > new Date(dueAt).getTime()) {
      throw new AppError("INVALID_REQUEST", 400, "任务截止时间不能早于开始时间");
    }
  }

  #normalizedTimestamp(timestamp: string | null): string | null {
    return timestamp ? new Date(timestamp).toISOString() : null;
  }

  #nextSortOrder(projectId: string, status: TaskStatus, excludingTaskId: string | null): number {
    const maximum = this.#database
      .prepare(
        `SELECT max(sort_order)
        FROM tasks
        WHERE project_id = ?
          AND (status = ? OR (status = 'blocked' AND blocked_from_status = ?))
          AND archived_at IS NULL
          AND (? IS NULL OR id <> ?)`,
      )
      .pluck()
      .get(projectId, status, status, excludingTaskId, excludingTaskId) as number | null;
    return (maximum ?? 0) + 1_024;
  }

  #calculateSortOrder(
    projectId: string,
    status: TaskStatus,
    currentTaskId: string,
    actor: PrincipalView,
    boardProjectId?: string,
    beforeTaskId?: string,
    afterTaskId?: string,
  ): number {
    const scopeProjectId = boardProjectId ?? projectId;
    if (scopeProjectId !== projectId && scopeProjectId !== ALL_PROJECT_ID) {
      throw new AppError("INVALID_REQUEST", 400, "排序看板与任务所属项目不匹配");
    }
    if (beforeTaskId === currentTaskId || afterTaskId === currentTaskId) {
      throw new AppError("INVALID_REQUEST", 400, "任务不能以自身作为排序锚点");
    }

    const visibleRows = this.#boardTaskRows(scopeProjectId, actor).map((row) =>
      RawTaskRowSchema.parse(row),
    );
    if (scopeProjectId === ALL_PROJECT_ID && !visibleRows.some((row) => row.id === currentTaskId)) {
      throw new AppError("INVALID_REQUEST", 400, "任务不在排序看板中");
    }
    const targetRows = visibleRows
      .filter((row) => (row.status === "blocked" ? row.blockedFromStatus : row.status) === status)
      .filter((row) => row.id !== currentTaskId);
    const sortOrderByTaskId = new Map(targetRows.map((row) => [row.id, row.sortOrder]));
    const orderedTaskIds = targetRows.map((row) => row.id);
    const beforeIndex = beforeTaskId ? orderedTaskIds.indexOf(beforeTaskId) : -1;
    const afterIndex = afterTaskId ? orderedTaskIds.indexOf(afterTaskId) : -1;
    if ((beforeTaskId && beforeIndex === -1) || (afterTaskId && afterIndex === -1)) {
      throw new AppError("INVALID_REQUEST", 400, "排序锚点不在目标状态列中");
    }
    if (beforeTaskId && afterTaskId && afterIndex >= beforeIndex) {
      throw new AppError("INVALID_REQUEST", 400, "排序锚点顺序无效");
    }

    const insertionIndex = beforeTaskId
      ? beforeIndex
      : afterTaskId
        ? afterIndex + 1
        : orderedTaskIds.length;
    orderedTaskIds.splice(insertionIndex, 0, currentTaskId);

    const previousTaskId = orderedTaskIds[insertionIndex - 1];
    const followingTaskId = orderedTaskIds[insertionIndex + 1];
    const lower = previousTaskId ? (sortOrderByTaskId.get(previousTaskId) as number) : null;
    const upper = followingTaskId ? (sortOrderByTaskId.get(followingTaskId) as number) : null;
    const candidate =
      lower === null
        ? upper === null
          ? 1_024
          : upper - 512
        : upper === null
          ? lower + 1_024
          : lower + (upper - lower) / 2;
    if (
      Number.isFinite(candidate) &&
      (lower === null || candidate > lower) &&
      (upper === null || candidate < upper)
    ) {
      return candidate;
    }

    const updateSortOrder = this.#database.prepare("UPDATE tasks SET sort_order = ? WHERE id = ?");
    for (const [index, taskId] of orderedTaskIds.entries()) {
      updateSortOrder.run((index + 1) * 1_024, taskId);
    }
    return (insertionIndex + 1) * 1_024;
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

  #recordChange(task: TaskView, eventType: string, timestamp: string): number {
    const result = this.#database
      .prepare(
        `INSERT INTO change_events (
          aggregate_type, aggregate_id, event_type, safe_payload_json, created_at
        ) VALUES ('task', ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        eventType,
        JSON.stringify({
          projectId: task.projectId,
          identifier: task.identifier,
          title: task.title,
          status: task.status,
          blockedFromStatus: task.blockedFromStatus,
          priority: task.priority,
          sortOrder: task.sortOrder,
          version: task.version,
          archived: task.archivedAt !== null,
        }),
        timestamp,
      );
    return Number(result.lastInsertRowid);
  }

  #recordRelationChange(
    task: InternalTaskView | TaskView,
    eventType: "relation.created" | "relation.deleted",
    relationId: string,
    relatedTaskId: string,
    timestamp: string,
  ): number {
    const result = this.#database
      .prepare(
        `INSERT INTO change_events (
          aggregate_type, aggregate_id, event_type, safe_payload_json, created_at
        ) VALUES ('task', ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        eventType,
        JSON.stringify({ projectId: task.projectId, taskId: task.id, relatedTaskId, relationId }),
        timestamp,
      );
    return Number(result.lastInsertRowid);
  }

  #recordRelationAudit(
    relationId: string,
    projectId: string,
    context: MutationContext,
    timestamp: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO audit_events (
          id, identity_key, action, resource_type, resource_id, outcome,
          request_id, safe_metadata_json, created_at
        ) VALUES (?, ?, 'relation.create', 'relation', ?, 'allowed', ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        identityKey(context.actor.identity),
        relationId,
        context.requestId ?? null,
        JSON.stringify({ projectId }),
        timestamp,
      );
  }

  #recordAudit(action: string, task: TaskView, context: MutationContext, timestamp: string): void {
    this.#database
      .prepare(
        `INSERT INTO audit_events (
          id, identity_key, action, resource_type, resource_id, outcome,
          request_id, safe_metadata_json, created_at
        ) VALUES (?, ?, ?, 'task', ?, 'allowed', ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        identityKey(context.actor.identity),
        action,
        task.id,
        context.requestId ?? null,
        JSON.stringify({ projectId: task.projectId, version: task.version }),
        timestamp,
      );
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
