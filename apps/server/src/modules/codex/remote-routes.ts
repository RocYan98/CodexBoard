import { cleanUserText, remoteDisplayTitle } from "./remote-title.js";
import { readModelCatalog } from "./model-catalog.js";
import {
  RemoteUploadChunks,
  RemoteChunkQuery,
  REMOTE_CHUNK_BYTES,
} from "./remote-upload-chunks.js";
import { randomUUID, createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import {
  identityKey,
  TaskProgressSchema,
  IdempotencyKeySchema,
  RemoteActionSchema,
  RemoteCreateSchema,
  RemoteUploadSchema,
  REMOTE_UPLOAD_MAX_BASE64_LENGTH,
  RemoteAttachmentSchema,
  RemoteModelSchema,
  RemoteThreadListSchema,
  RemoteUsageSchema,
  RemoteReviewSchema,
  RemoteReviewContentSchema,
  RemoteReviewScopeSchema,
} from "@codexboard/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../../app-error.js";
import type { AppConfig } from "../../config.js";
import { sessionCookieNames, type IdentityService } from "../identity/index.js";
import type { SqliteDatabase } from "../database/index.js";
import type { Taskboard } from "../taskboard/index.js";
import type { ProjectRegistry } from "../project-registry/index.js";
import { CodexRequestError } from "./json-rpc-client.js";
import { RemoteCommands } from "./remote-commands.js";
import { desktopRemoteView } from "./remote-view.js";

export interface RemoteClient {
  connect(): Promise<void>;
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
}
const UsageWindow = z.object({
  usedPercent: z.number(),
  windowDurationMins: z.number().nullable(),
  resetsAt: z.number().nullable(),
});
const UsageBucket = z.object({
  limitName: z.string().nullish(),
  primary: UsageWindow.nullish(),
  secondary: UsageWindow.nullish(),
});
const UsageResponse = z.object({
  rateLimits: UsageBucket.nullish(),
  rateLimitsByLimitId: z.record(z.string(), UsageBucket).nullish(),
});
const Params = z.object({ threadId: z.uuid() });
const ThreadList = z.object({
  data: z.array(
    z.object({
      id: z.uuid(),
      name: z.string().nullable().optional(),
      preview: z.string(),
      cwd: z.string(),
      updatedAt: z.number(),
      recencyAt: z.number().nullish(),
      desktopProjectId: z.string().nullable().optional(),
      desktopOrder: z.number().int().optional(),
      status: z.object({ type: z.string() }).optional(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export function registerRemoteRoutes(
  app: FastifyInstance,
  options: {
    config: AppConfig;
    identityService: IdentityService;
    database: SqliteDatabase;
    taskboard: Taskboard;
    projectRegistry: ProjectRegistry;
    client?: RemoteClient;
  },
) {
  const { config, identityService, client } = options;
  const commands = new RemoteCommands(options.database);
  function authenticate(request: FastifyRequest, write = false) {
    const names = sessionCookieNames(config, request.cookies);
    const session = identityService.authenticate(request.cookies[names.session]);
    identityService.assertBoardAccess(session.actor);
    if (write)
      identityService.assertCsrf(
        session,
        typeof request.headers["x-csrf-token"] === "string"
          ? request.headers["x-csrf-token"]
          : undefined,
        request.cookies[names.csrf],
      );
    return session;
  }
  async function rpc(method: string, params: unknown): Promise<unknown> {
    if (!client) throw new AppError("REMOTE_UNAVAILABLE", 503, "桌面连接尚未配置");
    try {
      await client.connect();
      // A cold Desktop read may need discovery, a large initial snapshot, and
      // a confirmed history revision. Mutation deadlines remain unchanged.
      const reading = [
        "taskboard/remote/read",
        "taskboard/remote/image",
        "taskboard/remote/review",
      ].includes(method);
      return await (reading
        ? client.request(method, params, 120_000)
        : client.request(method, params));
    } catch (error) {
      if (error instanceof CodexRequestError && error.code === -32002)
        throw new AppError("INVALID_REQUEST", 409, error.message);
      throw new AppError(
        "REMOTE_UNAVAILABLE",
        503,
        "桌面连接不可用或操作结果尚未确认，请刷新核实；不会自动重发",
      );
    }
  }
  async function models(includeDefaults = false) {
    const result = await readModelCatalog(rpc);
    const defaults = includeDefaults
      ? await rpc("taskboard/remote/model-presets", { models: result.data })
          .then(
            (value) =>
              z
                .object({ presets: z.array(z.object({ model: z.string(), effort: z.string() })) })
                .parse(value).presets,
          )
          .catch(() => [])
      : [];
    return result.data
      .filter((m) => !m.hidden)
      .map((m) =>
        RemoteModelSchema.parse({
          id: m.model,
          name: m.displayName,
          efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
          defaultEffort: m.defaultReasoningEffort,
          isDefault: m.isDefault,
          defaultPresets: defaults.flatMap((p, order) =>
            p.model === m.model &&
            m.supportedReasoningEfforts.some((e) => e.reasoningEffort === p.effort)
              ? [{ effort: p.effort, order }]
              : [],
          ),
          serviceTiers: m.serviceTiers,
        }),
      );
  }
  function mutate(
    request: FastifyRequest,
    input: unknown,
    operation: (key: string) => Promise<unknown>,
  ) {
    const session = authenticate(request, true);
    const key = IdempotencyKeySchema.parse(request.headers["idempotency-key"]);
    return commands.run(identityKey(session.actor.identity), key, input, () => operation(key));
  }
  app.get("/api/v1/tasks/:taskId/progress", async (request, reply) => {
    const session = identityService.authenticate(
      request.cookies[sessionCookieNames(config, request.cookies).session],
    );
    const { taskId } = z.object({ taskId: z.uuid() }).parse(request.params);
    const task = options.taskboard.readTask(taskId, session.actor);
    reply.header("Cache-Control", "no-store");
    if (task.status !== "in_progress" || !client) return { data: null };
    const thread = options.database
      .prepare(
        "SELECT thread_id AS threadId FROM task_threads WHERE task_id = ? AND is_primary = 1",
      )
      .get(taskId) as { threadId: string } | undefined;
    if (!thread) return { data: null };
    const result = await rpc("taskboard/taskProgress", { threadId: thread.threadId });
    return { data: TaskProgressSchema.nullable().parse(result) };
  });
  app.get("/api/v1/remote/threads", async (request) => {
    authenticate(request);
    const query = z
      .object({ cursor: z.string().max(2000).optional(), search: z.string().max(200).optional() })
      .parse(request.query);
    const result = ThreadList.parse(
      await rpc("thread/list", {
        limit: 50,
        sortKey: "recency_at",
        archived: false,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.search ? { searchTerm: query.search } : {}),
      }),
    );
    const projectIds = new Map(
      (
        options.database
          .prepare(
            "SELECT id, codex_project_id AS desktopId FROM projects WHERE source_kind = 'codex' AND sync_deleted_at IS NULL",
          )
          .all() as { id: string; desktopId: string }[]
      ).map((project) => [project.desktopId, project.id]),
    );
    return {
      data: RemoteThreadListSchema.parse({
        threads: result.data.map((thread) => ({
          id: thread.id,
          title: remoteDisplayTitle(thread.name, thread.preview),
          preview: cleanUserText(thread.preview).slice(0, 300),
          cwd: thread.cwd,
          updatedAt: thread.updatedAt,
          recencyAt: thread.recencyAt ?? thread.updatedAt,
          ...(thread.desktopProjectId !== undefined
            ? {
                projectId:
                  thread.desktopProjectId === null
                    ? null
                    : (projectIds.get(thread.desktopProjectId) ?? null),
              }
            : {}),
          desktopOrder: thread.desktopOrder,
          status: thread.status?.type ?? "unknown",
        })),
        nextCursor: result.nextCursor,
      }),
    };
  });
  app.get("/api/v1/remote/usage", async (request, reply) => {
    authenticate(request);
    reply.header("Cache-Control", "no-store");
    const result = UsageResponse.parse(await rpc("account/rateLimits/read", {}));
    const buckets = Object.entries(result.rateLimitsByLimitId ?? {});
    if (!buckets.length && result.rateLimits) buckets.push(["codex", result.rateLimits]);
    return {
      data: RemoteUsageSchema.parse({
        windows: buckets.flatMap(([id, bucket]) =>
          (["primary", "secondary"] as const).flatMap((key) => {
            const window = bucket[key];
            return window
              ? [
                  {
                    id: `${id}:${key}`,
                    name: bucket.limitName || id,
                    remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent)),
                    windowDurationMins: window.windowDurationMins,
                    resetsAt: window.resetsAt,
                  },
                ]
              : [];
          }),
        ),
      }),
    };
  });
  app.get("/api/v1/remote/models", async (request) => {
    authenticate(request);
    return { data: await models(true) };
  });
  const uploadChunks = new RemoteUploadChunks();
  app.post(
    "/api/v1/remote/uploads/chunks",
    {
      bodyLimit: REMOTE_CHUNK_BYTES,
      onRequest: async (request) => {
        authenticate(request, true);
      },
    },
    async (request) => {
      const session = authenticate(request, true);
      const ownerKey = createHash("sha256")
        .update(identityKey(session.actor.identity))
        .digest("hex");
      const id = IdempotencyKeySchema.parse(request.headers["idempotency-key"]);
      const upload = uploadChunks.add(
        ownerKey,
        id,
        RemoteChunkQuery.parse(request.query),
        request.body,
      );
      if (!upload) return { data: null };
      const data = await mutate(request, { upload }, async (key) =>
        RemoteAttachmentSchema.parse(
          await rpc("taskboard/remote/upload", { ...upload, ownerKey, id: key }),
        ),
      );
      uploadChunks.complete(ownerKey, id);
      return { data };
    },
  );
  app.post("/api/v1/remote/uploads", { bodyLimit: 12 * 1024 * 1024 }, async (request) => {
    const session = authenticate(request, true);
    const upload = RemoteUploadSchema.parse(request.body);
    const ownerKey = createHash("sha256").update(identityKey(session.actor.identity)).digest("hex");
    return {
      data: await mutate(request, { upload }, async (key) =>
        RemoteAttachmentSchema.parse(
          await rpc("taskboard/remote/upload", { ...upload, ownerKey, id: key }),
        ),
      ),
    };
  });
  app.get("/api/v1/remote/uploads/:id/preview", async (request, reply) => {
    const session = authenticate(request);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const ownerKey = createHash("sha256").update(identityKey(session.actor.identity)).digest("hex");
    const result = z
      .object({
        mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
        base64: z.string().max(REMOTE_UPLOAD_MAX_BASE64_LENGTH),
      })
      .parse(await rpc("taskboard/remote/upload/read", { id, ownerKey }));
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.type(result.mimeType).send(Buffer.from(result.base64, "base64"));
  });
  app.get("/api/v1/remote/threads/:threadId", async (request, reply) => {
    authenticate(request);
    const { threadId } = Params.parse(request.params);
    reply.header("Cache-Control", "no-store");
    return { data: desktopRemoteView(await rpc("taskboard/remote/read", { threadId })) };
  });
  app.get("/api/v1/remote/threads/:threadId/review", async (request, reply) => {
    authenticate(request);
    const { threadId } = Params.parse(request.params);
    const query = z
      .object({
        scope: RemoteReviewScopeSchema.default("branch"),
        turnId: z.string().min(1).max(200).optional(),
        all: z.enum(["0", "1"]).default("0"),
        path: z.string().min(1).max(4095).optional(),
        view: z.enum(["diff", "file"]).default("diff"),
      })
      .parse(request.query);
    reply.header("Cache-Control", "no-store");
    const data = await rpc("taskboard/remote/review", {
      threadId,
      scope: query.scope,
      ...(query.turnId == null ? {} : { turnId: query.turnId }),
      all: query.all === "1",
      ...(query.path == null ? {} : { path: query.path }),
      ...(query.view === "file" ? { view: "file" } : {}),
    });
    return {
      data: (query.path == null ? RemoteReviewSchema : RemoteReviewContentSchema).parse(data),
    };
  });
  app.get("/api/v1/remote/threads/:threadId/images/:itemId/:imageIndex", async (request, reply) => {
    authenticate(request);
    const params = z
      .object({
        threadId: z.uuid(),
        itemId: z.string().min(1).max(300),
        imageIndex: z.coerce.number().int().min(0).max(100),
      })
      .parse(request.params);
    const result = z
      .object({
        mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
        base64: z.string().max(12_000_000),
      })
      .parse(await rpc("taskboard/remote/image", params));
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.type(result.mimeType).send(Buffer.from(result.base64, "base64"));
  });
  app.post("/api/v1/remote/threads", async (request) => {
    const session = authenticate(request, true);
    const command = RemoteCreateSchema.parse(request.body);
    return {
      data: await mutate(request, { create: command }, async () => {
        let cwd: string;
        if (command.projectId) {
          if (
            !options.taskboard
              .listProjects(session.actor)
              .some((p) => p.id === command.projectId && p.kind === "codex")
          )
            throw new AppError("NOT_FOUND", 404, "项目不可用");
          cwd = (await options.projectRegistry.resolveExecutionContext(command.projectId)).cwd;
        } else {
          const root = config.CODEXBOARD_TEMPORARY_PROJECT_ROOT;
          if (!root || !isAbsolute(root))
            throw new AppError("INVALID_REQUEST", 409, "临时工作目录尚未配置");
          cwd = join(root, new Date().toISOString().slice(0, 10), `task-${randomUUID()}`);
          await rpc("fs/createDirectory", { path: cwd, recursive: true });
        }
        const result = z.object({ thread: z.object({ id: z.uuid() }) }).parse(
          await rpc("thread/start", {
            cwd,
            ephemeral: false,
          }),
        );
        // Creation returns the original ID before any desktop deep-link loading.
        return { threadId: result.thread.id };
      }),
    };
  });
  app.post("/api/v1/remote/threads/:threadId/actions", async (request) => {
    const session = authenticate(request, true);
    const { threadId } = Params.parse(request.params);
    const action = RemoteActionSchema.parse(request.body);
    if (action.type === "send" && !action.text && !action.attachments?.length)
      throw new AppError("INVALID_REQUEST", 400, "请输入消息或添加附件");
    return {
      data: await mutate(request, { threadId, action }, async (key) => {
        if (
          action.type === "send" &&
          (action.model || action.effort || action.serviceTier != null)
        ) {
          const available = await models();
          const selected = action.model ? available.find((m) => m.id === action.model) : undefined;
          if (
            !selected ||
            (action.effort && !selected.efforts.includes(action.effort)) ||
            (action.serviceTier != null &&
              !selected.serviceTiers.some((tier) => tier.id === action.serviceTier))
          )
            throw new AppError("INVALID_REQUEST", 400, "模型或推理强度不可用，请重新选择");
        }
        await rpc(`taskboard/remote/${action.type}`, {
          ...action,
          threadId,
          clientUserMessageId: key,
          ...((action.type === "send" || action.type === "queue") && action.attachments?.length
            ? {
                ownerKey: createHash("sha256")
                  .update(identityKey(session.actor.identity))
                  .digest("hex"),
              }
            : {}),
        });
        return {};
      }),
    };
  });
}
