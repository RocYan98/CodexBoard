import { WebAccountService } from "../modules/identity/web-account-service.js";
import { CliAuthService, cliAuthOperation } from "../modules/identity/cli-auth-service.js";
import { identityKey, sameIdentity } from "@codexboard/contracts";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  ArchiveTaskCommandSchema,
  RestoreTaskCommandSchema,
  CreateGlobalLabelCommandSchema,
  UpdateGlobalLabelCommandSchema,
  DeleteGlobalLabelCommandSchema,
  ReorderGlobalLabelsCommandSchema,
  CreateGitResourceCommandSchema,
  DeleteGitResourceCommandSchema,
  EventFeedQuerySchema,
  ProjectTaskCreationOptionsViewSchema,
  TEMPORARY_PROJECT_ID,
  AttachmentContentTypeSchema,
  CreateCommentCommandSchema,
  UpdateCommentCommandSchema,
  DeleteCommentCommandSchema,
  CreateTaskCommandSchema,
  CreateTaskRelationCommandSchema,
  DeleteTaskCommandSchema,
  EntityIdSchema,
  IdempotencyKeySchema,
  InteractionDecisionSchema,
  MoveTaskCommandSchema,
  ReassignTaskCommandSchema,
  SubmitExecutionCommandSchema,
  UpdateTaskCommandSchema,
  TaskLifecycleCommandSchema,
} from "@codexboard/contracts";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";

import { AppError } from "../app-error.js";
import type { AppServices } from "../app.js";
import type { AppConfig, LogLevel } from "../config.js";
import type { SqliteDatabase } from "../modules/database/index.js";
import { AttachmentService, AttachmentVault } from "../modules/attachments/index.js";
import {
  type CodexThreadProvisioner,
  ExecutionQueue,
  InteractionService,
} from "../modules/execution/index.js";
import {
  DevelopmentIdentityAdapter,
  IdentityService,
  assertUserAssignee,
  readIdentityAudit,
} from "../modules/identity/index.js";
import { ProjectRegistry } from "../modules/project-registry/index.js";
import {
  BackupService,
  type BackupRunner,
  createLoggerOptions,
  OperationsHealthService,
  RequestMetrics,
} from "../modules/operations/index.js";
import { GitManagement } from "../modules/project-registry/git-management.js";
import { LabelCatalog } from "../modules/labels/label-catalog.js";
import { EventFeed } from "../modules/event-feed/event-feed.js";
import { capabilitiesMatch } from "../modules/runtime/index.js";
import {
  Taskboard,
  TaskCreationService,
  TaskDeletionService,
  TaskWorkspace,
  TaskLifecycleService,
  TaskGitFinalizer,
  type MutationContext,
} from "../modules/taskboard/index.js";
import { registerHttpErrorHandling } from "./http-error-handling.js";

const ProjectParamsSchema = z.object({ projectId: EntityIdSchema });
const TaskParamsSchema = z.object({ taskId: EntityIdSchema });
const AttachmentParamsSchema = z.object({ attachmentId: EntityIdSchema });
const AttachmentDownloadQuerySchema = z.object({ preview: z.literal("1").optional() });
const JobParamsSchema = z.object({ jobId: EntityIdSchema });
const InteractionParamsSchema = z.object({ interactionId: EntityIdSchema });
const TaskctlCwdHeaderSchema = z.string().trim().min(1).max(4_096).refine(isAbsolute);
const TaskctlCwdWireHeaderSchema = z.string().trim().min(1).max(12_288);

interface CreateLocalAdminAppOptions {
  readonly config: AppConfig;
  readonly database: SqliteDatabase;
  readonly capabilityToken: string;
  readonly cliAuth?: CliAuthService;
  readonly projectRegistry?: ProjectRegistry;
  readonly logger?: boolean | ReturnType<typeof createLoggerOptions>;
  readonly logLevel?: LogLevel;
  readonly scheduleExecution?: () => void;
  readonly onRevisionCommitted?: (revision: number) => void;
  readonly services?: AppServices;
  readonly codexThreadProvisioner?: CodexThreadProvisioner;
  readonly backupRunner?: BackupRunner;
}

function isLoopback(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function decodeFilenameHeader(value: unknown): string {
  const encoded = z.string().min(1).parse(value);
  try {
    return decodeURIComponent(encoded);
  } catch (cause: unknown) {
    throw new AppError("INVALID_REQUEST", 400, "附件文件名编码无效", { cause });
  }
}

function decodeTaskctlCwdHeader(value: unknown): string {
  const encoded = TaskctlCwdWireHeaderSchema.parse(value);
  try {
    return decodeURIComponent(encoded);
  } catch (cause: unknown) {
    throw new AppError("INVALID_REQUEST", 400, "taskctl 工作目录编码无效", { cause });
  }
}

export function createLocalAdminApp(options: CreateLocalAdminAppOptions): FastifyInstance {
  const app = Fastify({
    logger:
      options.logger === true
        ? createLoggerOptions(options.logLevel ?? "info", "local-admin")
        : (options.logger ?? false),
    bodyLimit: 1024 * 1024,
    requestIdHeader: "x-request-id",
  });
  const requestMetrics = options.services?.requestMetrics ?? new RequestMetrics();
  const operations =
    options.services?.operations ??
    new OperationsHealthService({ database: options.database, metrics: requestMetrics });
  const backups =
    options.services?.backups ??
    new BackupService({
      database: options.database,
      dataDirectory: options.config.CODEXBOARD_DATA_DIR,
    });
  const backupRunner =
    options.backupRunner ??
    ({
      async create() {
        const destination = backups.automaticDestination();
        return {
          backupId: basename(destination),
          manifest: await backups.create(destination),
        };
      },
    } satisfies BackupRunner);
  app.addHook("onRequest", async (request, reply) => {
    requestMetrics.begin();
    void reply.header("X-Request-ID", request.id);
  });
  app.addHook("onResponse", async (_request, reply) => {
    requestMetrics.finish(reply.statusCode);
  });
  app.addContentTypeParser(
    /^(?:application\/(?:octet-stream|pdf|zip)|image\/[^;]+|text\/[^;]+)(?:;.*)?$/i,
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  const registry =
    options.services?.projectRegistry ??
    options.projectRegistry ??
    new ProjectRegistry(options.database, options.config.CODEXBOARD_WORKSPACE_ROOTS);
  const identityService =
    options.services?.identityService ??
    new IdentityService({
      database: options.database,
      provider: new DevelopmentIdentityAdapter(),
      sessionTtlSeconds: options.config.CODEXBOARD_SESSION_TTL_SECONDS,
    });
  const cliAuth =
    options.services?.cliAuth ??
    options.cliAuth ??
    new CliAuthService({
      identityVersion: (identity) => identityService.cliIdentityVersion(identity),
    });
  function requestActor(
    request: FastifyRequest,
  ): ReturnType<IdentityService["authenticatedUserPrincipal"]> {
    const token = request.headers["x-taskctl-session"];
    if (typeof token !== "string" || !token)
      throw new AppError("UNAUTHENTICATED", 401, "请先完成 taskctl auth login 和网页用户授权");
    return identityService.authenticatedUserPrincipal(
      cliAuthOperation(() => cliAuth.authenticate(token)),
    );
  }
  const revisionOption = options.onRevisionCommitted
    ? { onRevisionCommitted: options.onRevisionCommitted }
    : {};
  const taskboard =
    options.services?.taskboard ??
    new Taskboard({
      database: options.database,
      identityService,
      temporaryProjectRoot: options.config.CODEXBOARD_TEMPORARY_PROJECT_ROOT || undefined,
      ...revisionOption,
    });
  const workspace =
    options.services?.workspace ??
    new TaskWorkspace({
      database: options.database,
      identityService,
      taskboard,
      attachmentUrlPrefix: "/api/v1/local/attachments",
      ...revisionOption,
    });
  const attachments =
    options.services?.attachments ??
    new AttachmentService({
      database: options.database,
      identityService,
      taskboard,
      vault: new AttachmentVault({
        rootDirectory: join(options.config.CODEXBOARD_DATA_DIR, "attachments"),
        maxBytes: options.config.CODEXBOARD_ATTACHMENT_MAX_BYTES,
      }),
      attachmentUrlPrefix: "/api/v1/local/attachments",
      ...revisionOption,
    });
  const queue =
    options.services?.queue ??
    new ExecutionQueue({
      database: options.database,
      dataDirectory: options.config.CODEXBOARD_DATA_DIR,
      executorNodePath: options.config.CODEXBOARD_EXECUTOR_NODE_PATH,
      executorTaskctlPath: options.config.CODEXBOARD_EXECUTOR_TASKCTL_PATH,
      executorDataDirectory: options.config.CODEXBOARD_EXECUTOR_DATA_DIR,
      ...revisionOption,
    });
  const taskCreation =
    options.services?.taskCreation ??
    (options.codexThreadProvisioner
      ? new TaskCreationService({
          taskboard,
          queue,
          provisioner: options.codexThreadProvisioner,
          projectRegistry: registry,
        })
      : null);
  const taskDeletion =
    options.services?.taskDeletion ??
    new TaskDeletionService({
      database: options.database,
      taskboard,
      vault: new AttachmentVault({
        rootDirectory: join(options.config.CODEXBOARD_DATA_DIR, "attachments"),
        maxBytes: options.config.CODEXBOARD_ATTACHMENT_MAX_BYTES,
      }),
      provisioner: options.codexThreadProvisioner ?? null,
      ...revisionOption,
    });
  const taskLifecycle =
    options.services?.taskLifecycle ??
    new TaskLifecycleService({
      database: options.database,
      taskboard,
      queue,
      gitFinalizer: new TaskGitFinalizer(options.config.CODEXBOARD_WORKSPACE_ROOTS),
      scheduleExecution: options.scheduleExecution ?? (() => {}),
      ...revisionOption,
    });
  if (!options.services?.taskLifecycle) {
    app.addHook("onReady", async () => {
      void taskLifecycle.resumePending();
    });
    app.addHook("onClose", async () => {
      await taskLifecycle.close();
    });
  }
  const interactions =
    options.services?.interactions ??
    new InteractionService({
      database: options.database,
      queue,
      identityService,
      ...revisionOption,
    });
  const labels =
    options.services?.labels ?? new LabelCatalog({ database: options.database, ...revisionOption });
  const eventFeed = new EventFeed({ database: options.database });
  const gitManagement =
    options.services?.gitManagement ??
    new GitManagement(options.database, registry, options.config.CODEXBOARD_WORKSPACE_ROOTS);
  const expectedHost = `${options.config.CODEXBOARD_ADMIN_HOST}:${options.config.CODEXBOARD_ADMIN_PORT}`;

  app.addHook("onRequest", async (request) => {
    const host = request.headers.host?.trim().toLowerCase();
    const matchesHost =
      host === expectedHost ||
      (options.config.CODEXBOARD_ADMIN_PORT === 80 &&
        host === options.config.CODEXBOARD_ADMIN_HOST);
    if (!matchesHost || !isLoopback(request.ip)) {
      throw new AppError("FORBIDDEN", 403, "本机管理接口只接受 loopback 请求");
    }
    if (request.headers.origin) {
      throw new AppError("FORBIDDEN", 403, "本机管理接口不接受浏览器 Origin");
    }

    const authorization = request.headers.authorization;
    const match = /^Bearer (\S+)$/.exec(authorization ?? "");
    if (!match || !capabilitiesMatch(options.capabilityToken, match[1] as string)) {
      options.database
        .prepare(
          `INSERT INTO audit_events (
            id, identity_key, action, resource_type, resource_id, outcome,
            request_id, safe_metadata_json
          ) VALUES (?, NULL, 'local_admin.authenticate', 'local_admin', NULL, 'denied', ?, '{}')`,
        )
        .run(randomUUID(), request.id);
      throw new AppError("FORBIDDEN", 403, "本机管理能力令牌无效");
    }
    const route = request.routeOptions.url ?? "";
    // The capability authenticates the local transport, never a board user. Keep
    // bootstrap and machine operations explicit so new business routes fail closed.
    const machineOperation =
      ((request.method === "GET" || request.method === "HEAD") &&
        (route === "/api/v1/local/health" || route === "/api/v1/local/web-accounts")) ||
      (request.method === "POST" &&
        [
          "/api/v1/local/backups",
          "/api/v1/local/web-accounts",
          "/api/v1/local/auth/requests",
          "/api/v1/local/auth/complete",
        ].includes(route)) ||
      (request.method === "PATCH" && route === "/api/v1/local/web-accounts/:id");
    if (!machineOperation) requestActor(request);
  });

  const webAccounts = new WebAccountService(options.database);
  function requireAccountManager(request: FastifyRequest) {
    if (request.headers["x-taskctl-session"] !== undefined)
      throw new AppError("FORBIDDEN", 403, "账号管理仅允许本机应用操作");
  }
  app.get("/api/v1/local/web-accounts", async (request, reply) => {
    requireAccountManager(request);
    reply.header("Cache-Control", "no-store");
    return { data: webAccounts.list() };
  });
  app.post("/api/v1/local/web-accounts", async (request, reply) => {
    requireAccountManager(request);
    reply.header("Cache-Control", "no-store");
    return reply.code(201).send({ data: await webAccounts.create(request.body) });
  });
  app.patch("/api/v1/local/web-accounts/:id", async (request, reply) => {
    requireAccountManager(request);
    reply.header("Cache-Control", "no-store");
    return {
      data: await webAccounts.update(
        z.object({ id: z.uuid() }).parse(request.params).id,
        request.body,
      ),
    };
  });

  app.post("/api/v1/local/auth/requests", async (request, reply) => {
    const { label } = z
      .object({ label: z.string().min(1).max(120) })
      .strict()
      .parse(request.body);
    const created = cliAuthOperation(() => cliAuth.create(label));
    const verificationUrl = new URL(options.config.CODEXBOARD_ORIGIN);
    verificationUrl.search = "";
    verificationUrl.hash = "";
    verificationUrl.searchParams.set("taskctlLogin", created.requestId);
    return reply
      .header("Cache-Control", "no-store")
      .code(201)
      .send({ data: { ...created, verificationUrl: verificationUrl.href } });
  });
  app.post("/api/v1/local/auth/complete", async (request, reply) => {
    const { requestId, claimSecret } = z
      .object({ requestId: z.string().min(1).max(200), claimSecret: z.string().min(1).max(200) })
      .strict()
      .parse(request.body);
    const result = cliAuthOperation(() => cliAuth.complete(requestId, claimSecret));
    if ("token" in result) {
      try {
        identityService.authenticatedUserPrincipal(result.identity);
      } catch (error) {
        cliAuth.revoke(result.token);
        throw error;
      }
    }
    return reply.header("Cache-Control", "no-store").send({ data: result });
  });
  app.get("/api/v1/local/auth/session", async (request, reply) => {
    const actor = requestActor(request);
    return reply
      .header("Cache-Control", "no-store")
      .send({ data: { identity: actor.identity, name: actor.name, role: actor.role } });
  });
  app.post("/api/v1/local/auth/logout", async (request, reply) => {
    const token = request.headers["x-taskctl-session"];
    if (typeof token !== "string" || !token)
      throw new AppError("UNAUTHENTICATED", 401, "请先完成 CLI 用户登录");
    cliAuthOperation(() => cliAuth.revoke(token));
    return reply.header("Cache-Control", "no-store").send({ data: { revoked: true } });
  });

  app.get("/api/v1/local/health", async () => ({
    data: { listener: "local-admin", ...operations.snapshot() },
  }));

  app.post("/api/v1/local/backups", async (_request, reply) => {
    const result = await backupRunner.create();
    await reply.code(201).send({ data: result });
  });

  const mutationContext = (request: FastifyRequest): MutationContext => {
    const header = request.headers["idempotency-key"];
    return {
      actor: requestActor(request),
      idempotencyKey: IdempotencyKeySchema.parse(typeof header === "string" ? header : undefined),
      requestId: request.id,
    };
  };

  app.get("/api/v1/local/events", async (request) => {
    const query = EventFeedQuerySchema.parse(request.query);
    identityService.authorizeProject(requestActor(request), query.projectId, "read");
    return { data: eventFeed.readSince(query) };
  });
  app.get("/api/v1/local/labels", async (request) => ({
    data: labels.list(requestActor(request)),
  }));
  app.post("/api/v1/local/labels", async (request, reply) => {
    const result = labels.create(
      CreateGlobalLabelCommandSchema.parse(request.body),
      mutationContext(request),
    );
    return reply.code(201).send({ data: result.label, meta: { revision: result.revision } });
  });
  app.patch("/api/v1/local/labels/:labelId", async (request) => {
    const { labelId } = z.object({ labelId: EntityIdSchema }).parse(request.params);
    const result = labels.update(
      labelId,
      UpdateGlobalLabelCommandSchema.parse(request.body),
      mutationContext(request),
    );
    return { data: result.label, meta: { revision: result.revision } };
  });
  app.delete("/api/v1/local/labels/:labelId", async (request) => {
    const { labelId } = z.object({ labelId: EntityIdSchema }).parse(request.params);
    const result = labels.delete(
      labelId,
      DeleteGlobalLabelCommandSchema.parse(request.body),
      mutationContext(request),
    );
    return { data: { labelId: result.labelId }, meta: { revision: result.revision } };
  });
  app.put("/api/v1/local/labels/order", async (request) => {
    const result = labels.reorder(
      ReorderGlobalLabelsCommandSchema.parse(request.body),
      mutationContext(request),
    );
    return { data: { labels: result.labels }, meta: { revision: result.revision } };
  });
  function gitProject(request: FastifyRequest): string {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    if (
      !taskboard
        .listProjects(requestActor(request))
        .some(
          (project) =>
            project.id === projectId && project.kind === "codex" && project.syncState === "synced",
        )
    )
      throw new AppError("INVALID_REQUEST", 409, "请选择可用的本地项目");
    return projectId;
  }
  app.get("/api/v1/local/projects/:projectId/git", async (request) => ({
    data: await gitManagement.read(gitProject(request)),
  }));
  app.post("/api/v1/local/projects/:projectId/git", async (request, reply) => {
    const command = CreateGitResourceCommandSchema.parse(request.body);
    await gitManagement.create(
      gitProject(request),
      command,
      identityKey(requestActor(request).identity),
      command.codexThreadId
        ? { kind: "codex", threadId: command.codexThreadId }
        : { kind: "terminal" },
    );
    return reply.code(201).send({ data: { ok: true } });
  });
  app.delete("/api/v1/local/projects/:projectId/git", async (request) => {
    await gitManagement.remove(
      gitProject(request),
      DeleteGitResourceCommandSchema.parse(request.body),
      identityKey(requestActor(request).identity),
    );
    return { data: { ok: true } };
  });
  app.get("/api/v1/local/projects/:projectId/dashboard", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    return { data: workspace.readDashboard(projectId, requestActor(request)) };
  });
  app.get("/api/v1/local/projects/:projectId/task-creation-options", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    const view = taskboard.readTaskCreationOptions(projectId, requestActor(request), () => [], {
      attachmentMaxBytes: options.config.CODEXBOARD_ATTACHMENT_MAX_BYTES,
    });
    if (projectId === TEMPORARY_PROJECT_ID) return { data: view };
    const executionContext = await registry.resolveExecutionContext(projectId);
    const developmentContexts = executionContext.headSha
      ? (await registry.scanDevelopmentContexts(projectId)).filter(
          (context) =>
            context.active &&
            context.executable &&
            context.worktreeRealpath !== null &&
            context.branch !== executionContext.branch,
        )
      : [];
    return {
      data: ProjectTaskCreationOptionsViewSchema.parse({
        ...view,
        developmentContexts,
        defaultDevelopmentContext: {
          id: null,
          label: executionContext.branch ?? "无",
          branch: executionContext.branch,
        },
      }),
    };
  });
  app.post("/api/v1/local/tasks/:taskId/archive", async (request) => {
    const { taskId } = TaskParamsSchema.parse(request.params);
    const result = taskboard.archiveTask(
      taskId,
      ArchiveTaskCommandSchema.parse(request.body),
      mutationContext(request),
    );
    return { data: result.task, meta: { revision: result.revision } };
  });
  app.post("/api/v1/local/tasks/:taskId/restore", async (request) => {
    const { taskId } = TaskParamsSchema.parse(request.params);
    const result = taskDeletion.restoreTask(
      taskId,
      RestoreTaskCommandSchema.parse(request.body),
      mutationContext(request),
    );
    return { data: result.task, meta: { revision: result.revision } };
  });
  app.post("/api/v1/local/tasks/:taskId/read", async (request, reply) => {
    const { taskId } = TaskParamsSchema.parse(request.params);
    const result = workspace.markTaskRead(taskId, mutationContext(request));
    return reply.header("X-Event-Revision", String(result.revision)).code(204).send();
  });
  app.get("/api/v1/local/jobs/:jobId", async (request) => {
    const { jobId } = JobParamsSchema.parse(request.params);
    const job = queue.readJob(jobId);
    taskboard.readTask(job.taskId, requestActor(request));
    return { data: job };
  });

  app.get("/api/v1/local/context", async (request) => {
    const header = request.headers["x-taskctl-cwd"];
    const requestedCwd = TaskctlCwdHeaderSchema.parse(
      decodeTaskctlCwdHeader(typeof header === "string" ? header : undefined),
    );
    let cwd: string;
    try {
      cwd = resolve(realpathSync.native(requestedCwd));
    } catch (cause: unknown) {
      throw new AppError("INVALID_REQUEST", 400, "taskctl 工作目录不存在", { cause });
    }
    const projects = taskboard
      .listProjects(requestActor(request))
      .filter((candidate) => candidate.kind === "codex");
    const project =
      projects
        .filter((candidate) => {
          return candidate.rootPaths.some((root) => {
            const path = relative(root, cwd);
            return (
              path === "" || (!isAbsolute(path) && !path.startsWith(`..${sep}`) && path !== "..")
            );
          });
        })
        .sort(
          (left, right) =>
            Math.max(...right.rootPaths.map((root) => root.length)) -
            Math.max(...left.rootPaths.map((root) => root.length)),
        )[0] ?? null;
    return { data: { cwd, project, projects } };
  });

  app.get("/api/v1/local/projects", async (request) => ({
    data: taskboard.listProjects(requestActor(request)),
  }));

  app.get("/api/v1/local/members/audit", async (request) => {
    requestActor(request);
    return { data: readIdentityAudit(options.database) };
  });

  app.post("/api/v1/local/projects/:projectId/contexts/scan", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    identityService.authorizeProject(requestActor(request), projectId, "write");
    return { data: await registry.scanDevelopmentContexts(projectId) };
  });

  app.get("/api/v1/local/projects/:projectId/board", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    return { data: taskboard.readBoard(projectId, requestActor(request)) };
  });

  app.get("/api/v1/local/tasks/:taskId/workspace", async (request) => {
    const { taskId } = TaskParamsSchema.parse(request.params);
    return { data: workspace.readTaskWorkspace(taskId, requestActor(request)) };
  });

  app.post("/api/v1/local/tasks", async (request, reply) => {
    const actor = requestActor(request);
    if (!taskCreation) {
      throw new AppError("UPSTREAM_ERROR", 503, "Codex App Server 当前不可用，无法创建任务");
    }
    const command = CreateTaskCommandSchema.parse(request.body);
    if (command.assigneeIdentity && !sameIdentity(command.assigneeIdentity, actor.identity))
      throw new AppError("FORBIDDEN", 403, "CLI 创建任务的负责人必须是当前登录用户");
    command.assigneeIdentity = actor.identity;
    assertUserAssignee(options.database, identityKey(actor.identity));
    const result = await taskCreation.create(command, mutationContext(request));
    await reply.code(201).send({ data: result.task, meta: { revision: result.revision } });
  });

  app.delete("/api/v1/local/tasks/:taskId", async (request) => {
    const { taskId } = TaskParamsSchema.parse(request.params);
    const result = await taskDeletion.delete(
      taskId,
      DeleteTaskCommandSchema.parse(request.body),
      mutationContext(request),
    );
    return { data: result, meta: { revision: result.revision } };
  });

  app.patch("/api/v1/local/tasks/:taskId", async (request) => {
    const { taskId } = TaskParamsSchema.parse(request.params);
    const result = taskboard.updateTask(
      taskId,
      UpdateTaskCommandSchema.parse(request.body),
      mutationContext(request),
    );
    return { data: result.task, meta: { revision: result.revision } };
  });

  app.post("/api/v1/local/tasks/:taskId/move", async (request) => {
    const { taskId } = TaskParamsSchema.parse(request.params);
    const command = MoveTaskCommandSchema.parse(request.body);
    const context = mutationContext(request);
    const result =
      command.targetStatus === "done" || command.targetStatus === "canceled"
        ? await taskLifecycle.wait(
            taskLifecycle.request(
              taskId,
              { expectedVersion: command.expectedVersion, targetStatus: command.targetStatus },
              context,
            ).id,
          )
        : taskboard.moveTask(taskId, command, context);
    return { data: result.task, meta: { revision: result.revision } };
  });

  app.get("/api/v1/local/tasks/:taskId/lifecycle", async (request) => {
    const { taskId } = TaskParamsSchema.parse(request.params);
    return { data: taskLifecycle.readLatest(taskId, requestActor(request)) };
  });

  app.post("/api/v1/local/tasks/:taskId/lifecycle", async (request, reply) => {
    const { taskId } = TaskParamsSchema.parse(request.params);
    const operation = taskLifecycle.request(
      taskId,
      TaskLifecycleCommandSchema.parse(request.body),
      mutationContext(request),
    );
    await reply.code(202).send({ data: operation });
  });

  app.post("/api/v1/local/tasks/:taskId/reassign", async (request) => {
    const { taskId } = TaskParamsSchema.parse(request.params);
    const result = taskboard.reassignTask(
      taskId,
      ReassignTaskCommandSchema.parse(request.body),
      mutationContext(request),
    );
    return { data: result.task, meta: { revision: result.revision } };
  });

  app.post("/api/v1/local/tasks/:taskId/comments", async (request, reply) => {
    const { taskId } = TaskParamsSchema.parse(request.params);
    const result = workspace.createComment(
      taskId,
      CreateCommentCommandSchema.strict().parse(request.body),
      mutationContext(request),
    );
    return reply.code(201).send({ data: result.data, meta: { revision: result.revision } });
  });
  app.patch("/api/v1/local/comments/:commentId", async (request) => {
    const { commentId } = z.object({ commentId: EntityIdSchema }).parse(request.params);
    const result = workspace.updateComment(
      commentId,
      UpdateCommentCommandSchema.strict().parse(request.body),
      mutationContext(request),
    );
    return { data: result.data, meta: { revision: result.revision } };
  });
  app.delete("/api/v1/local/comments/:commentId", async (request) => {
    const { commentId } = z.object({ commentId: EntityIdSchema }).parse(request.params);
    const result = workspace.deleteComment(
      commentId,
      DeleteCommentCommandSchema.strict().parse(request.body),
      mutationContext(request),
    );
    return { data: result.data, meta: { revision: result.revision } };
  });

  app.post("/api/v1/local/tasks/:taskId/relations", async (request, reply) => {
    const { taskId } = TaskParamsSchema.parse(request.params);
    const result = workspace.createRelation(
      taskId,
      CreateTaskRelationCommandSchema.parse(request.body),
      mutationContext(request),
    );
    await reply.code(201).send({ data: result.data, meta: { revision: result.revision } });
  });

  app.delete("/api/v1/local/tasks/:taskId/relations/:relationId", async (request) => {
    const params = z
      .object({ taskId: EntityIdSchema, relationId: EntityIdSchema })
      .parse(request.params);
    const result = workspace.deleteRelation(
      params.taskId,
      params.relationId,
      mutationContext(request),
    );
    return { data: result.data, meta: { revision: result.revision } };
  });

  app.post(
    "/api/v1/local/tasks/:taskId/attachments",
    { bodyLimit: options.config.CODEXBOARD_ATTACHMENT_MAX_BYTES },
    async (request, reply) => {
      const { taskId } = TaskParamsSchema.parse(request.params);
      const filename = decodeFilenameHeader(request.headers["x-filename"]);
      const contentType = AttachmentContentTypeSchema.parse(request.headers["x-content-type"]);
      const pendingComment =
        z.literal("1").optional().parse(request.headers["x-pending-comment"]) === "1";
      const bytes = Buffer.isBuffer(request.body) ? request.body : undefined;
      if (!bytes) throw new AppError("INVALID_REQUEST", 400, "附件请求体必须是二进制内容");
      const result = attachments.upload(
        taskId,
        {
          filename,
          contentType,
          bytes,
          pendingComment,
          commentId:
            request.headers["x-comment-id"] === undefined
              ? null
              : EntityIdSchema.parse(request.headers["x-comment-id"]),
        },
        mutationContext(request),
      );
      await reply.code(201).send({ data: result.data, meta: { revision: result.revision } });
    },
  );

  app.get("/api/v1/local/attachments/:attachmentId", async (request, reply) => {
    const { attachmentId } = AttachmentParamsSchema.parse(request.params);
    const { preview } = AttachmentDownloadQuerySchema.parse(request.query);
    const opened = attachments.open(attachmentId, requestActor(request));
    await reply
      .header("Content-Type", opened.metadata.contentType)
      .header(
        "Content-Disposition",
        `${preview === "1" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(opened.metadata.filename)}`,
      )
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "private, no-store")
      .send(opened.bytes);
  });

  app.delete("/api/v1/local/attachments/:attachmentId", async (request) => {
    const { attachmentId } = AttachmentParamsSchema.parse(request.params);
    const result = attachments.delete(attachmentId, mutationContext(request));
    return { data: result.data, meta: { revision: result.revision } };
  });

  app.get("/api/v1/local/tasks/:taskId/jobs", async (request) => {
    const { taskId } = TaskParamsSchema.parse(request.params);
    taskboard.readTask(taskId, requestActor(request));
    return { data: queue.listTaskJobs(taskId) };
  });

  for (const kind of ["start", "continue"] as const) {
    app.post(`/api/v1/local/tasks/:taskId/jobs/${kind}`, async (request, reply) => {
      const { taskId } = TaskParamsSchema.parse(request.params);
      const task = taskboard.readTask(taskId, requestActor(request));
      const command = SubmitExecutionCommandSchema.parse(request.body ?? {});
      const thread = queue.primaryThread(taskId);
      if (kind === "start" && thread)
        throw new AppError("INVALID_REQUEST", 409, "任务已有主 Thread，请使用继续执行");
      if (kind === "continue" && !thread)
        throw new AppError("INVALID_REQUEST", 409, "任务尚未绑定 Codex Thread");
      if (!task.permissions.canExecute) throw new AppError("FORBIDDEN", 403, "没有该任务执行权限");
      if (kind === "start" && task.projectId === "00000000-0000-4000-8000-0000000000a2") {
        throw new AppError("INVALID_REQUEST", 409, "临时任务需要先分配到 Codex 项目才能启动");
      }
      const execution =
        kind === "continue" && task.projectId === "00000000-0000-4000-8000-0000000000a2"
          ? {
              projectId: task.projectId,
              developmentContextId: null,
              cwd: (thread as NonNullable<typeof thread>).cwd,
              branch: null,
              headSha: null,
            }
          : await registry.resolveExecutionContext(
              task.projectId,
              task.developmentContextId ?? undefined,
            );
      const job = queue.submit(
        {
          taskId,
          taskThreadId: kind === "continue" ? (thread as NonNullable<typeof thread>).id : null,
          kind,
          executionKey: execution.cwd,
          explicitPrompt: command.prompt !== undefined,
          workContext: {
            projectId: task.projectId,
            developmentContextId: task.developmentContextId,
            cwd: execution.cwd,
            branch: execution.branch,
            headSha: execution.headSha,
            prompt:
              command.prompt ??
              (kind === "start"
                ? [`请完成任务 ${task.identifier}：${task.title}`, task.description]
                    .filter(Boolean)
                    .join("\n\n")
                : `继续处理 ${task.identifier}：${task.title}`),
          },
          maxAttempts: 2,
        },
        mutationContext(request),
      );
      options.scheduleExecution?.();
      await reply.code(202).send({ data: job });
    });
  }

  app.post("/api/v1/local/jobs/:jobId/cancel", async (request, reply) => {
    const { jobId } = JobParamsSchema.parse(request.params);
    const job = queue.readJob(jobId);
    const task = taskboard.readTask(job.taskId, requestActor(request));
    if (!task.permissions.canExecute) throw new AppError("FORBIDDEN", 403, "没有该任务执行权限");
    const result = queue.requestCancel(jobId, mutationContext(request));
    options.scheduleExecution?.();
    await reply.code(202).send({ data: result });
  });

  app.get("/api/v1/local/jobs/:jobId/interactions", async (request) => {
    const { jobId } = JobParamsSchema.parse(request.params);
    const job = queue.readJob(jobId);
    taskboard.readTask(job.taskId, requestActor(request));
    return { data: interactions.listForJob(jobId) };
  });

  app.post("/api/v1/local/interactions/:interactionId/respond", async (request) => {
    const { interactionId } = InteractionParamsSchema.parse(request.params);
    return {
      data: interactions.respond(
        interactionId,
        InteractionDecisionSchema.parse(request.body),
        requestActor(request),
        request.id,
      ),
    };
  });

  registerHttpErrorHandling(app);
  return app;
}
