import { randomBytes } from "node:crypto";
import { bridgeSocketPath, isWindowsPipePath } from "../../../scripts/codex-local-endpoint.mjs";
import {
  startEmbeddedCodexBridge,
  type EmbeddedCodexBridge,
} from "./modules/codex/embedded-bridge.js";
import {
  resolveLegacyIdentities,
  IdentityMigrationPreflightError,
} from "./modules/identity/identity-migration-preflight.js";
import { join } from "node:path";
import {
  hostWorkspaceCommand,
  hostGitOriginReader,
} from "./modules/taskboard/task-git-host-command.js";

import type { FastifyInstance } from "fastify";

import { appControl, createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import {
  CodexAppServerSupervisor,
  CodexJsonRpcClient,
  TcpWebSocketTransport,
  UnixWebSocketTransport,
} from "./modules/codex/index.js";
import { identityMigrations, MigrationError, openDatabase } from "./modules/database/index.js";
import { AppServerCodexExecutor } from "./modules/execution/index.js";
import {
  acquireDataDirectoryLock,
  BackgroundBackupRunner,
  BackupService,
  recoverInterruptedRestore,
  runMigrationsWithBackup,
} from "./modules/operations/index.js";
import {
  createRuntimeCapability,
  publishRuntimeDescriptor,
  type RuntimeDescriptorHandle,
} from "./modules/runtime/index.js";
import { safeStartupErrorDetails } from "./startup-error.js";
import { createLocalAdminApp } from "./transports/local-admin-http.js";

interface RunningServers {
  readonly publicApp: FastifyInstance;
  readonly localAdminApp: FastifyInstance;
  readonly stopCodex: () => Promise<void>;
}

async function startServer(): Promise<RunningServers> {
  const config = loadConfig();
  const dataLock = acquireDataDirectoryLock(config.CODEXBOARD_DATA_DIR, "server");
  let database: ReturnType<typeof openDatabase> | undefined;
  let codexSupervisor: CodexAppServerSupervisor | undefined;
  let codexClient: CodexJsonRpcClient | undefined;
  let embeddedBridge: EmbeddedCodexBridge | undefined;
  const stopCodex = async () => {
    await Promise.allSettled([codexClient?.close(), codexSupervisor?.stop()]);
    await Promise.allSettled([embeddedBridge?.close()]);
  };
  let publicApp: FastifyInstance | undefined;
  let localAdminApp: FastifyInstance | undefined;
  let runtimeDescriptor: RuntimeDescriptorHandle | undefined;
  try {
    recoverInterruptedRestore(config.CODEXBOARD_DATA_DIR);
    database = openDatabase(join(config.CODEXBOARD_DATA_DIR, "taskboard.sqlite"));
    await runMigrationsWithBackup(
      database,
      identityMigrations(
        await resolveLegacyIdentities(database, {
          appId: config.CODEXBOARD_FEISHU_APP_ID,
          appSecret: config.CODEXBOARD_FEISHU_APP_SECRET,
          apiBaseUrl: config.CODEXBOARD_FEISHU_API_BASE_URL,
        }),
      ),
      new BackupService({ database, dataDirectory: config.CODEXBOARD_DATA_DIR }),
    );
    const codexSocketPath = bridgeSocketPath(config.CODEXBOARD_DATA_DIR);
    const pipeToken = isWindowsPipePath(codexSocketPath)
      ? randomBytes(32).toString("hex")
      : undefined;
    if (config.CODEXBOARD_CODEX_TRANSPORT === "managed-unix") {
      codexSupervisor = new CodexAppServerSupervisor({
        socketPath: codexSocketPath,
        ...(pipeToken ? { token: pipeToken } : {}),
        codexCommand: config.CODEXBOARD_CODEX_COMMAND,
      });
      await codexSupervisor.start();
    }
    if (config.CODEXBOARD_CODEX_TRANSPORT === "embedded") {
      embeddedBridge = await startEmbeddedCodexBridge(config);
    }
    codexClient = new CodexJsonRpcClient({
      transport:
        config.CODEXBOARD_CODEX_TRANSPORT !== "managed-unix"
          ? new TcpWebSocketTransport({
              endpoint: config.CODEXBOARD_CODEX_ENDPOINT,
              tokenFile: config.CODEXBOARD_CODEX_TOKEN_FILE as string,
            })
          : new UnixWebSocketTransport({
              socketPath: codexSocketPath,
              ...(pipeToken ? { token: pipeToken } : {}),
            }),
    });
    const codexExecutor = new AppServerCodexExecutor(
      codexClient,
      config.CODEXBOARD_TEMPORARY_PROJECT_ROOT,
    );
    const capabilityToken = createRuntimeCapability();
    publicApp = createApp({
      config,
      database,
      logger: true,
      logLevel: config.CODEXBOARD_LOG_LEVEL,
      closeDatabaseOnClose: false,
      codexExecutor,
      remoteClient: codexClient,
      workspaceCommandRunner: hostWorkspaceCommand(codexClient),
      gitOriginReader: hostGitOriginReader(codexClient),
      codexThreadProvisioner: codexExecutor,
      runtimeHealth: {
        connectorHealth: () => ({ connected: codexClient?.connected ?? false }),
        appServerHealth: () =>
          codexSupervisor?.health() ??
          (codexClient?.connected
            ? { status: "ready", pid: null, error: null }
            : { status: "offline", pid: null, error: null }),
      },
    });
    const control = appControl(publicApp);
    localAdminApp = createLocalAdminApp({
      config,
      database,
      capabilityToken,
      logger: true,
      logLevel: config.CODEXBOARD_LOG_LEVEL,
      scheduleExecution: control.scheduleExecution,
      onRevisionCommitted: control.notifyRevisionCommitted,
      services: control.services,
      backupRunner: new BackgroundBackupRunner(config.CODEXBOARD_DATA_DIR),
    });
    await publicApp.listen({
      host: config.CODEXBOARD_HOST,
      port: config.CODEXBOARD_PORT,
    });
    await localAdminApp.listen({
      host: config.CODEXBOARD_ADMIN_HOST,
      port: config.CODEXBOARD_ADMIN_PORT,
    });
    runtimeDescriptor = publishRuntimeDescriptor(config, capabilityToken);
    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (signal: NodeJS.Signals): Promise<void> => {
      shutdownPromise ??= (async () => {
        publicApp?.log.info({ signal }, "Shutting down server");
        await Promise.allSettled([publicApp?.close(), localAdminApp?.close()]);
        await stopCodex();
        runtimeDescriptor?.remove();
        if (database?.open) database.close();
        dataLock.release();
      })();
      return shutdownPromise;
    };
    if (codexSupervisor) {
      codexSupervisor.onUnexpectedExit(() => {
        publicApp?.log.error(
          { component: "codex-app-server" },
          "Managed Codex App Server exited unexpectedly",
        );
        void shutdown("SIGTERM").then(() => {
          process.exitCode = 1;
        });
      });
    }
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    if (process.connected) {
      process.on("message", (message: unknown) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "codexboard.shutdown"
        ) {
          void shutdown("SIGTERM").finally(() => {
            if (process.connected) process.disconnect?.();
          });
        }
      });
    }
    publicApp.log.info(
      {
        publicAddress: `${config.CODEXBOARD_HOST}:${config.CODEXBOARD_PORT}`,
        localAdminAddress: `${config.CODEXBOARD_ADMIN_HOST}:${config.CODEXBOARD_ADMIN_PORT}`,
        runtimeDescriptor: runtimeDescriptor.path,
      },
      "Public and local admin listeners are ready",
    );
    return {
      publicApp,
      localAdminApp,
      stopCodex,
    };
  } catch (error: unknown) {
    await Promise.allSettled([publicApp?.close(), localAdminApp?.close()]);
    await stopCodex();
    runtimeDescriptor?.remove();
    if (database?.open) database.close();
    dataLock.release();
    throw error;
  }
}

try {
  await startServer();
} catch (error: unknown) {
  const code =
    error instanceof IdentityMigrationPreflightError
      ? error.code
      : error instanceof ConfigError
        ? "CONFIG_INVALID"
        : error instanceof MigrationError
          ? "MIGRATION_FAILED"
          : "INTERNAL_ERROR";
  const startupError = {
    level: "error",
    code,
    ...safeStartupErrorDetails(error),
    message:
      error instanceof IdentityMigrationPreflightError
        ? error.message
        : code === "CONFIG_INVALID"
          ? "服务配置无效"
          : code === "MIGRATION_FAILED"
            ? "数据库迁移失败"
            : "服务启动失败",
  };

  process.stderr.write(`${JSON.stringify(startupError)}\n`);
  process.exitCode = 1;
}
