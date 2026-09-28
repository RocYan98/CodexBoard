import { WebAccountService } from "./modules/identity/web-account-service.js";
import { CliAuthService } from "./modules/identity/cli-auth-service.js";
import { registerRemoteRoutes, type RemoteClient } from "./modules/codex/remote-routes.js";
import { GitManagement } from "./modules/project-registry/git-management.js";
import { registerGitManagementRoutes } from "./modules/project-registry/git-management-routes.js";
import { join } from "node:path";

import { HealthResponseSchema } from "@codexboard/contracts";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";

import { AppError } from "./app-error.js";
import type { AppConfig, LogLevel } from "./config.js";
import { AttachmentService, AttachmentVault } from "./modules/attachments/index.js";
import { isDatabaseHealthy, type SqliteDatabase } from "./modules/database/index.js";
import { EventFeed, registerEventFeedRoutes } from "./modules/event-feed/index.js";
import {
  ExecutionOrchestrator,
  ExecutionQueue,
  InteractionService,
  registerExecutionRoutes,
  type CodexExecutor,
  type CodexThreadProvisioner,
} from "./modules/execution/index.js";
import {
  DevelopmentIdentityAdapter,
  DEVELOPMENT_IDENTITY,
  FeishuIdentityAdapter,
  IdentityService,
  type IdentityProvider,
  registerIdentityRoutes,
  registerRequestBoundary,
} from "./modules/identity/index.js";
import { LabelCatalog, registerLabelRoutes } from "./modules/labels/index.js";
import {
  registerTaskboardRoutes,
  Taskboard,
  TaskCreationService,
  TaskDeletionService,
  TaskLifecycleService,
  TaskGitFinalizer,
  TaskWorkspace,
} from "./modules/taskboard/index.js";
import { ProjectRegistry } from "./modules/project-registry/index.js";
import { ProjectSnapshotWatcher, ProjectSyncService } from "./modules/project-sync/index.js";
import {
  BackupService,
  createLoggerOptions,
  OperationsHealthService,
  RequestMetrics,
  type OperationsRuntimeHealth,
} from "./modules/operations/index.js";
import { registerHttpErrorHandling } from "./transports/http-error-handling.js";
import { registerProductionWeb } from "./transports/production-web.js";

const SERVER_VERSION = "0.1.0";

import type { WorkspaceCommandRunner } from "./modules/taskboard/task-git-finalizer.js";

import type { GitOriginReader } from "./modules/project-registry/git-origin.js";

interface CreateAppOptions {
  remoteClient?: RemoteClient;
  gitOriginReader?: GitOriginReader;
  workspaceCommandRunner?: WorkspaceCommandRunner;
  config: AppConfig;
  database: SqliteDatabase;
  identityProvider?: IdentityProvider;
  logger?: boolean | ReturnType<typeof createLoggerOptions>;
  logLevel?: LogLevel;
  closeDatabaseOnClose?: boolean;
  codexExecutor?: CodexExecutor;
  codexThreadProvisioner?: CodexThreadProvisioner;
  projectRegistry?: ProjectRegistry;
  runtimeHealth?: OperationsRuntimeHealth;
}

export interface AppControl {
  readonly scheduleExecution: () => void;
  readonly notifyRevisionCommitted: (revision: number) => void;
  readonly services: AppServices;
}

export interface AppServices {
  readonly cliAuth: CliAuthService;
  readonly identityService: IdentityService;
  readonly taskboard: Taskboard;
  readonly taskCreation: TaskCreationService | null;
  readonly taskDeletion: TaskDeletionService;
  readonly taskLifecycle: TaskLifecycleService;
  readonly workspace: TaskWorkspace;
  readonly attachments: AttachmentService;
  readonly labels: LabelCatalog;
  readonly gitManagement: GitManagement;
  readonly projectRegistry: ProjectRegistry;
  readonly queue: ExecutionQueue;
  readonly interactions: InteractionService;
  readonly operations: OperationsHealthService;
  readonly requestMetrics: RequestMetrics;
  readonly backups: BackupService;
  readonly projectSync: ProjectSyncService;
}

const APP_CONTROLS = new WeakMap<FastifyInstance, AppControl>();

export function appControl(app: FastifyInstance): AppControl {
  const control = APP_CONTROLS.get(app);
  if (!control) throw new AppError("INTERNAL_ERROR", 500, "应用控制面尚未初始化");
  return control;
}

export function createApp(options: CreateAppOptions): FastifyInstance {
  const app = Fastify({
    logger:
      options.logger === true
        ? createLoggerOptions(options.logLevel ?? "info", "public-http")
        : (options.logger ?? false),
    bodyLimit: 1024 * 1024,
    requestIdHeader: "x-request-id",
  });
  const requestMetrics = new RequestMetrics();
  const operations = new OperationsHealthService({
    database: options.database,
    metrics: requestMetrics,
    ...options.runtimeHealth,
  });
  const backups = new BackupService({
    database: options.database,
    dataDirectory: options.config.CODEXBOARD_DATA_DIR,
  });
  app.addHook("onRequest", async (request, reply) => {
    requestMetrics.begin();
    void reply.header("X-Request-ID", request.id);
  });
  app.addHook("onResponse", async (_request, reply) => {
    requestMetrics.finish(reply.statusCode);
  });

  app.addContentTypeParser(
    /^(?:application\/(?:octet-stream|pdf|zip)|image\/[^;]+)(?:;.*)?$/i,
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  app.register(cookie);
  registerRequestBoundary(app, options.config);

  const identityProvider = options.identityProvider ?? createIdentityProvider(options.config);
  const identityService = new IdentityService({
    database: options.database,
    provider: identityProvider,
    sessionTtlSeconds: options.config.CODEXBOARD_SESSION_TTL_SECONDS,
  });
  if (options.config.CODEXBOARD_AUTH_MODE === "development") {
    identityService.ensureDevelopmentActor(DEVELOPMENT_IDENTITY);
  }
  const cliAuth = new CliAuthService({
    identityVersion: (identity) => identityService.cliIdentityVersion(identity),
  });
  registerIdentityRoutes(app, {
    webAccounts: new WebAccountService(options.database),
    config: options.config,
    service: identityService,
    cliAuth,
  });
  const eventFeed = new EventFeed({
    database: options.database,
    historyLimit: options.config.CODEXBOARD_EVENT_HISTORY_LIMIT,
  });
  const projectSync = new ProjectSyncService({
    database: options.database,
    onRevisionCommitted: (revision) => eventFeed.notifyCommitted(revision),
  });
  const labels = new LabelCatalog({
    database: options.database,
    onRevisionCommitted: (revision) => eventFeed.notifyCommitted(revision),
  });
  const projectSnapshotWatcher = new ProjectSnapshotWatcher({
    snapshotFile: options.config.CODEXBOARD_CODEX_PROJECT_SNAPSHOT_FILE,
    service: projectSync,
    reconcileMs: options.config.CODEXBOARD_PROJECT_SYNC_RECONCILE_MS,
  });
  const taskboard = new Taskboard({
    database: options.database,
    identityService,
    temporaryProjectRoot: options.config.CODEXBOARD_TEMPORARY_PROJECT_ROOT || undefined,
    onRevisionCommitted: (revision) => eventFeed.notifyCommitted(revision),
  });
  const workspace = new TaskWorkspace({
    database: options.database,
    identityService,
    taskboard,
    onRevisionCommitted: (revision) => eventFeed.notifyCommitted(revision),
  });
  const attachmentVault = new AttachmentVault({
    rootDirectory: join(options.config.CODEXBOARD_DATA_DIR, "attachments"),
    maxBytes: options.config.CODEXBOARD_ATTACHMENT_MAX_BYTES,
  });
  const attachments = new AttachmentService({
    database: options.database,
    identityService,
    taskboard,
    vault: attachmentVault,
    onRevisionCommitted: (revision) => eventFeed.notifyCommitted(revision),
  });
  const projectRegistry =
    options.projectRegistry ??
    new ProjectRegistry(options.database, options.config.CODEXBOARD_WORKSPACE_ROOTS);
  const executionQueue = new ExecutionQueue({
    database: options.database,
    dataDirectory: options.config.CODEXBOARD_DATA_DIR,
    executorNodePath: options.config.CODEXBOARD_EXECUTOR_NODE_PATH,
    executorTaskctlPath: options.config.CODEXBOARD_EXECUTOR_TASKCTL_PATH,
    executorDataDirectory: options.config.CODEXBOARD_EXECUTOR_DATA_DIR,
    onRevisionCommitted: (revision) => eventFeed.notifyCommitted(revision),
  });
  const taskCreation = options.codexThreadProvisioner
    ? new TaskCreationService({
        taskboard,
        queue: executionQueue,
        provisioner: options.codexThreadProvisioner,
        projectRegistry,
      })
    : null;
  const taskDeletion = new TaskDeletionService({
    database: options.database,
    taskboard,
    vault: attachmentVault,
    provisioner: options.codexThreadProvisioner ?? null,
    onRevisionCommitted: (revision) => eventFeed.notifyCommitted(revision),
  });
  const interactions = new InteractionService({
    database: options.database,
    queue: executionQueue,
    identityService,
    onRevisionCommitted: (revision) => eventFeed.notifyCommitted(revision),
  });
  const orchestrator = options.codexExecutor
    ? new ExecutionOrchestrator({
        queue: executionQueue,
        executor: options.codexExecutor,
        projectRegistry,
        interactions,
        owner: `server:${process.pid}`,
      })
    : undefined;
  let stopping = false;
  let activeExecutionWorkers = 0;
  let cancelWorkerActive = false;
  let executionSchedulePending = false;
  let cancelSchedulePending = false;
  const drainSchedule = () => {
    if (!orchestrator || stopping) return;
    if (executionSchedulePending && activeExecutionWorkers < 2) {
      executionSchedulePending = false;
      activeExecutionWorkers += 1;
      void (async () => {
        while (await orchestrator.runNext("execution")) {
          // Drain durable execution work assigned to this worker before releasing the slot.
        }
      })().finally(() => {
        activeExecutionWorkers -= 1;
        drainSchedule();
      });
    }
    if (cancelSchedulePending && !cancelWorkerActive) {
      cancelSchedulePending = false;
      cancelWorkerActive = true;
      void (async () => {
        while (await orchestrator.runNext("cancel")) {
          // Cancellation is a control path and must not wait for an execution slot.
        }
      })().finally(() => {
        cancelWorkerActive = false;
        drainSchedule();
      });
    }
  };
  const schedule = () => {
    executionSchedulePending = true;
    cancelSchedulePending = true;
    drainSchedule();
  };
  const taskLifecycle = new TaskLifecycleService({
    database: options.database,
    taskboard,
    queue: executionQueue,
    gitFinalizer: new TaskGitFinalizer(
      options.config.CODEXBOARD_WORKSPACE_ROOTS,
      undefined,
      options.config.CODEXBOARD_TEMPORARY_PROJECT_ROOT,
    ),
    scheduleExecution: schedule,
    onRevisionCommitted: (revision) => eventFeed.notifyCommitted(revision),
  });
  const gitManagement = new GitManagement(
    options.database,
    projectRegistry,
    options.config.CODEXBOARD_WORKSPACE_ROOTS,
    options.workspaceCommandRunner,
    options.gitOriginReader,
  );
  APP_CONTROLS.set(app, {
    scheduleExecution: schedule,
    notifyRevisionCommitted: (revision) => eventFeed.notifyCommitted(revision),
    services: {
      cliAuth,
      identityService,
      taskboard,
      taskCreation,
      taskDeletion,
      taskLifecycle,
      workspace,
      attachments,
      labels,
      gitManagement,
      projectRegistry,
      queue: executionQueue,
      interactions,
      operations,
      requestMetrics,
      backups,
      projectSync,
    },
  });
  let recoveryActive = false;
  const recoverUncertain = async () => {
    if (stopping || recoveryActive || !orchestrator) return;
    recoveryActive = true;
    try {
      if (await orchestrator.recoverUncertain()) schedule();
      await orchestrator.syncConversations();
    } catch {
      app.log.warn("Codex 执行结果恢复暂未成功，将保留原状态并稍后重试");
    } finally {
      recoveryActive = false;
    }
  };
  const recoveryTimer = orchestrator
    ? setInterval(() => void recoverUncertain(), 10_000)
    : undefined;
  recoveryTimer?.unref();
  interactions.expirePending("服务重启后原 Codex 请求已失效");
  executionQueue.recoverAfterRestart();
  if (orchestrator) {
    setImmediate(schedule);
    setImmediate(() => void recoverUncertain());
  }
  registerTaskboardRoutes(app, {
    config: options.config,
    identityService,
    taskboard,
    taskCreation,
    taskDeletion,
    taskLifecycle,
    workspace,
    attachments,
    projectRegistry,
  });
  registerGitManagementRoutes(app, {
    config: options.config,
    identityService,
    taskboard,
    gitManagement,
  });
  registerLabelRoutes(app, { config: options.config, identityService, labels });
  registerEventFeedRoutes(app, {
    config: options.config,
    eventFeed,
    identityService,
  });
  registerExecutionRoutes(app, {
    config: options.config,
    identityService,
    taskboard,
    projectRegistry,
    queue: executionQueue,
    interactions,
    schedule,
  });
  registerRemoteRoutes(app, {
    config: options.config,
    identityService,
    database: options.database,
    taskboard,
    projectRegistry,
    ...(options.remoteClient ? { client: options.remoteClient } : {}),
  });

  app.addHook("onReady", async () => {
    await projectSnapshotWatcher.start();
    void taskDeletion.resumePending();
    void taskLifecycle.resumePending();
  });

  app.addHook("onClose", async () => {
    stopping = true;
    if (recoveryTimer) clearInterval(recoveryTimer);
    orchestrator?.stop();
    APP_CONTROLS.delete(app);
    await projectSnapshotWatcher.close();
    await taskLifecycle.close();
    interactions.expirePending("服务正在停止");
    eventFeed.close();
    if ((options.closeDatabaseOnClose ?? true) && options.database.open) {
      options.database.close();
    }
  });

  app.get("/api/health", async () => {
    const sqliteHealthy = isDatabaseHealthy(options.database);

    return HealthResponseSchema.parse({
      status: sqliteHealthy ? "ok" : "degraded",
      service: "codexboard-server",
      version: SERVER_VERSION,
      timestamp: new Date().toISOString(),
      checks: {
        http: "ok",
        sqlite: sqliteHealthy ? "ok" : "unavailable",
      },
    });
  });

  registerProductionWeb(app, options.config);

  registerHttpErrorHandling(app);

  return app;
}

function createIdentityProvider(config: AppConfig): IdentityProvider {
  if (config.CODEXBOARD_AUTH_MODE === "web") {
    return {
      kind: "web",
      async exchangeCode() {
        throw new AppError("FORBIDDEN", 403, "请使用 Web 账号登录");
      },
    };
  }
  if (config.CODEXBOARD_AUTH_MODE === "development") {
    return new DevelopmentIdentityAdapter();
  }

  const appId = config.CODEXBOARD_FEISHU_APP_ID;
  const appSecret = config.CODEXBOARD_FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new AppError("CONFIG_INVALID", 500, "飞书认证配置不完整");
  }

  return new FeishuIdentityAdapter({
    appId,
    appSecret,
    apiBaseUrl: config.CODEXBOARD_FEISHU_API_BASE_URL,
  });
}
