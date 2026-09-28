import { randomUUID } from "node:crypto";
import { mkdir, readFile as readFileFs, writeFile as writeFileFs } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  UserIdentityRefSchema,
  RuntimeDescriptorSchema,
  type RuntimeDescriptor,
} from "@codexboard/contracts";

import { z } from "zod";
import {
  credentialPaths,
  authFileLocations,
  compatibleCredentialStore,
  defaultAuthFile,
  PendingCredentialSchema,
  readCredential,
  SessionCredentialSchema,
  TaskctlAuthError,
  validateRuntimeTarget,
  type CredentialStore,
} from "./auth.js";
import { runtimeDataDirectory } from "./runtime-path.js";

export const TASKCTL_PACKAGE_NAME = "@codexboard/taskctl";

export interface TaskctlDependencies {
  readonly readRuntimeDescriptor: () => Promise<RuntimeDescriptor>;
  readonly fetch: typeof fetch;
  readonly credentials: CredentialStore;
  readonly authFile: () => string;
  readonly now: () => number;
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly cwd: () => string;
  readonly codexThreadId?: () => string | undefined;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, string>>;
}

interface RequestCommand {
  readonly path: string;
  readonly method?: string;
  readonly body?: unknown;
  readonly uploadPath?: string;
  readonly uploadComment?: string;
  readonly pendingComment?: string;
  readonly downloadPath?: string;
}

export const TASKCTL_HELP = `taskctl — Taskboard 本机命令行（结果为 JSON；help 为文本）
  auth login --label TEXT | auth complete | auth status | auth logout
  context | health | backup create
  project list | project scan ID | project dashboard ID | project options ID
  issue list --project ID | issue get ID
  issue create --project ID --title TEXT [--description TEXT --status STATUS --priority PRIORITY --labels A,B --assignee USER_ID --tenant KEY --start ISO --due ISO --context ID]
  issue update ID --version N [上述可编辑字段，不含 project/status]
  issue move ID --version N --status STATUS [--before ID --after ID]
  issue reassign ID --version N --project ID [--mode single|origin_group]
  issue archive ID --version N | issue restore ID --version N | issue delete ID --version N
  issue read ID
  lifecycle get TASK_ID | lifecycle request TASK_ID --version N --status done|canceled
  relation add --task ID --target ID --type parent|child|blocks|blocked_by|related
  relation delete ID --task ID
  attachment upload --task ID --file PATH [--comment ID --pending true|false]
  attachment download ID --output PATH | attachment delete ID
  job list --task ID | job get ID | job start --task ID [--prompt TEXT]
  job continue --task ID [--prompt TEXT] | job cancel ID
  interaction list --job ID | interaction respond ID --decision accept|decline|cancel|input [--answers JSON]
  label list | label create --name TEXT | label update ID --version N --name TEXT
  label delete ID --version N | label order --ids ID,ID
  git list --project ID
  git create --project ID --kind branch|worktree --branch NAME [--base NAME --directory NAME --existing true|false]
  git delete --project ID --head SHA [--branch NAME --path PATH]
  events list --project ID [--after REVISION --limit 1..200]
  member audit
  comment add --task ID --body TEXT [--attachments ID,ID]
  comment update ID --version N --body TEXT | comment delete ID --version N
看板查询和写入均需要已授权的 Web 或飞书用户会话；health、backup create、attachment download 仅需本机连接认证。
评论作者固定为当前登录用户；Codex 执行结果由执行事件自动同步。
更新时 --start/--due/--context null 清空字段；--labels "" 清空标签。
--description "" 清空描述。版本冲突需重新读取，命令不会自动重试。
退出码：0 成功；1 服务/运行错误；2 命令用法错误。
`;

class UsageError extends Error {}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const options: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new UsageError(`选项 --${name} 缺少值`);
    options[name] = value;
    index += 1;
  }
  return { positionals, options };
}

function requireValue(value: string | undefined, label: string): string {
  if (!value) throw new UsageError(`缺少 ${label}`);
  return value;
}

function numberValue(value: string | undefined, label: string): number {
  const parsed = Number(requireValue(value, label));
  if (!Number.isInteger(parsed) || parsed < 1) throw new UsageError(`${label} 必须是正整数`);
  return parsed;
}

function optionalJson(value: string | undefined, label: string): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new UsageError(`${label} 必须是合法 JSON`);
  }
}

function optionalList(value: string | undefined): string[] | undefined {
  return value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function assigneeIdentity(option: Readonly<Record<string, string>>) {
  if (option.assignee === undefined) return undefined;
  if (option.assignee === "null") throw new UsageError("负责人固定为已登录的飞书用户，不能清空");
  return {
    kind: "feishu",
    tenantKey: requireValue(option.tenant, "--tenant"),
    userId: requireValue(option.assignee, "--assignee"),
  };
}

function commandFor(parsed: ParsedArguments, codexThreadId?: string): RequestCommand {
  const [resource, action, id] = parsed.positionals;
  const option = parsed.options;
  const entity = (value: string | undefined, label: string) =>
    encodeURIComponent(requireValue(value, label));
  const taskPath = () => `/api/v1/local/tasks/${entity(id, "task id")}`;
  if (resource === "health" && !action) return { path: "/api/v1/local/health" };
  if (resource === "member" && action === "audit") return { path: "/api/v1/local/members/audit" };
  if (resource === "backup" && action === "create")
    return { path: "/api/v1/local/backups", method: "POST", body: {} };
  if (resource === "events" && action === "list") {
    const query = new URLSearchParams({
      projectId: requireValue(option.project, "--project"),
      afterRevision: option.after ?? "0",
      limit: option.limit ?? "100",
    });
    return { path: `/api/v1/local/events?${query}` };
  }
  if (resource === "lifecycle") {
    if (action === "get") return { path: `${taskPath()}/lifecycle` };
    if (action === "request")
      return {
        path: `${taskPath()}/lifecycle`,
        method: "POST",
        body: {
          expectedVersion: numberValue(option.version, "--version"),
          targetStatus: requireValue(option.status, "--status"),
        },
      };
  }
  if (resource === "relation") {
    const path = `/api/v1/local/tasks/${entity(option.task, "--task")}/relations`;
    if (action === "add")
      return {
        path,
        method: "POST",
        body: {
          targetTaskId: requireValue(option.target, "--target"),
          relationType: requireValue(option.type, "--type"),
        },
      };
    if (action === "delete")
      return { path: `${path}/${entity(id, "relation id")}`, method: "DELETE", body: {} };
  }
  if (resource === "label") {
    const path = "/api/v1/local/labels";
    if (action === "list") return { path };
    if (action === "create")
      return { path, method: "POST", body: { name: requireValue(option.name, "--name") } };
    if (action === "order")
      return {
        path: `${path}/order`,
        method: "PUT",
        body: { labelIds: optionalList(requireValue(option.ids, "--ids")) },
      };
    if (action === "update" || action === "delete")
      return {
        path: `${path}/${entity(id, "label id")}`,
        method: action === "update" ? "PATCH" : "DELETE",
        body: compact({
          expectedVersion: numberValue(option.version, "--version"),
          name: action === "update" ? requireValue(option.name, "--name") : undefined,
        }),
      };
  }
  if (resource === "git") {
    const path = `/api/v1/local/projects/${entity(option.project, "--project")}/git`;
    if (action === "list") return { path };
    if (action === "create") {
      if (option.existing !== undefined && !["true", "false"].includes(option.existing))
        throw new UsageError("--existing 必须是 true 或 false");
      return {
        path,
        method: "POST",
        body: compact({
          kind: requireValue(option.kind, "--kind"),
          codexThreadId,
          branch: requireValue(option.branch, "--branch"),
          baseBranch: option.base,
          directoryName: option.directory,
          existingBranch: option.existing === undefined ? undefined : option.existing === "true",
        }),
      };
    }
    if (action === "delete")
      return {
        path,
        method: "DELETE",
        body: {
          branch: option.branch ?? null,
          path: option.path ?? null,
          expectedHead: requireValue(option.head, "--head"),
        },
      };
  }
  if (resource === "context" && !action) return { path: "/api/v1/local/context" };

  if (resource === "project") {
    if (action === "dashboard" || action === "options")
      return {
        path: `/api/v1/local/projects/${entity(id, "project id")}/${action === "options" ? "task-creation-options" : "dashboard"}`,
      };
    if (action === "list") return { path: "/api/v1/local/projects" };
    if (action === "scan")
      return {
        path: `/api/v1/local/projects/${encodeURIComponent(requireValue(id, "project id"))}/contexts/scan`,
        method: "POST",
        body: {},
      };
  }

  if (resource === "issue") {
    if (action === "archive" || action === "restore")
      return {
        path: `${taskPath()}/${action}`,
        method: "POST",
        body: { expectedVersion: numberValue(option.version, "--version") },
      };
    if (action === "read") return { path: `${taskPath()}/read`, method: "POST", body: {} };
    if (action === "list")
      return {
        path: `/api/v1/local/projects/${encodeURIComponent(requireValue(option.project, "--project"))}/board`,
      };
    if (action === "get")
      return {
        path: `/api/v1/local/tasks/${encodeURIComponent(requireValue(id, "task id"))}/workspace`,
      };
    if (action === "create")
      return {
        path: "/api/v1/local/tasks",
        method: "POST",
        body: compact({
          projectId: requireValue(option.project, "--project"),
          title: requireValue(option.title, "--title"),
          description: option.description ?? "",
          status: option.status ?? "backlog",
          priority: option.priority ?? "none",
          labels: optionalList(option.labels),
          assigneeIdentity: assigneeIdentity(option),
          startAt: option.start ?? null,
          dueAt: option.due ?? null,
          developmentContextId: option.context ?? null,
        }),
      };
    if (action === "delete")
      return {
        path: `/api/v1/local/tasks/${encodeURIComponent(requireValue(id, "task id"))}`,
        method: "DELETE",
        body: { expectedVersion: numberValue(option.version, "--version") },
      };
    if (action === "update")
      return {
        path: `/api/v1/local/tasks/${encodeURIComponent(requireValue(id, "task id"))}`,
        method: "PATCH",
        body: compact({
          expectedVersion: numberValue(option.version, "--version"),
          title: option.title,
          description: option.description,
          priority: option.priority,
          labels: optionalList(option.labels),
          assigneeIdentity: assigneeIdentity(option),
          startAt: option.start === "null" ? null : option.start,
          dueAt: option.due === "null" ? null : option.due,
          developmentContextId: option.context === "null" ? null : option.context,
        }),
      };
    if (action === "move")
      return {
        path: `/api/v1/local/tasks/${encodeURIComponent(requireValue(id, "task id"))}/move`,
        method: "POST",
        body: compact({
          expectedVersion: numberValue(option.version, "--version"),
          targetStatus: requireValue(option.status, "--status"),
          beforeTaskId: option.before,
          afterTaskId: option.after,
        }),
      };
    if (action === "reassign")
      return {
        path: `/api/v1/local/tasks/${encodeURIComponent(requireValue(id, "task id"))}/reassign`,
        method: "POST",
        body: {
          expectedVersion: numberValue(option.version, "--version"),
          targetProjectId: requireValue(option.project, "--project"),
          mode: option.mode ?? "single",
        },
      };
  }

  if (resource === "comment") {
    const allowedOptions =
      action === "add"
        ? ["task", "body", "attachments"]
        : action === "update"
          ? ["version", "body"]
          : ["version"];
    if (Object.keys(option).some((key) => !allowedOptions.includes(key)))
      throw new UsageError("评论仅支持正文、附件与版本参数；作者由已登录的用户会话确定");
    if (action === "add")
      return {
        path: `/api/v1/local/tasks/${entity(option.task, "--task")}/comments`,
        method: "POST",
        body: compact({
          body: requireValue(option.body, "--body"),
          attachmentIds: optionalList(option.attachments),
        }),
      };
    if (action === "update")
      return {
        path: `/api/v1/local/comments/${entity(id, "comment id")}`,
        method: "PATCH",
        body: {
          expectedVersion: numberValue(option.version, "--version"),
          body: requireValue(option.body, "--body"),
        },
      };
    if (action === "delete")
      return {
        path: `/api/v1/local/comments/${entity(id, "comment id")}`,
        method: "DELETE",
        body: { expectedVersion: numberValue(option.version, "--version") },
      };
  }

  if (resource === "attachment") {
    if (action === "delete")
      return {
        path: `/api/v1/local/attachments/${entity(id, "attachment id")}`,
        method: "DELETE",
        body: {},
      };
    if (action === "upload")
      return {
        path: `/api/v1/local/tasks/${encodeURIComponent(requireValue(option.task, "--task"))}/attachments`,
        method: "POST",
        uploadPath: requireValue(option.file, "--file"),
        ...compact({ uploadComment: option.comment, pendingComment: option.pending }),
      };
    if (action === "download")
      return {
        path: `/api/v1/local/attachments/${encodeURIComponent(requireValue(id, "attachment id"))}`,
        downloadPath: requireValue(option.output, "--output"),
      };
  }

  if (resource === "job") {
    if (action === "get") return { path: `/api/v1/local/jobs/${entity(id, "job id")}` };
    if (action === "list")
      return {
        path: `/api/v1/local/tasks/${encodeURIComponent(requireValue(option.task, "--task"))}/jobs`,
      };
    if (action === "start" || action === "continue")
      return {
        path: `/api/v1/local/tasks/${encodeURIComponent(requireValue(option.task, "--task"))}/jobs/${action}`,
        method: "POST",
        body: compact({ prompt: option.prompt }),
      };
    if (action === "cancel")
      return {
        path: `/api/v1/local/jobs/${encodeURIComponent(requireValue(id, "job id"))}/cancel`,
        method: "POST",
        body: {},
      };
  }

  if (resource === "interaction") {
    if (action === "list")
      return {
        path: `/api/v1/local/jobs/${encodeURIComponent(requireValue(option.job, "--job"))}/interactions`,
      };
    if (action === "respond") {
      const decision = requireValue(option.decision, "--decision");
      const body =
        decision === "input"
          ? {
              type: "input",
              answers: optionalJson(requireValue(option.answers, "--answers"), "--answers"),
            }
          : { type: decision };
      return {
        path: `/api/v1/local/interactions/${encodeURIComponent(requireValue(id, "interaction id"))}/respond`,
        method: "POST",
        body,
      };
    }
  }
  throw new UsageError("未知命令");
}

function contentType(path: string): string {
  const extension = path.toLowerCase().split(".").at(-1);
  return (
    (
      {
        pdf: "application/pdf",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        zip: "application/zip",
        txt: "text/plain",
        md: "text/markdown",
        csv: "text/csv",
        json: "application/json",
      } as Record<string, string>
    )[extension ?? ""] ?? "application/octet-stream"
  );
}

function output(writer: (value: string) => void, value: unknown): void {
  writer(`${JSON.stringify(value, null, 2)}\n`);
}

export async function readDefaultRuntimeDescriptor(): Promise<RuntimeDescriptor> {
  const dataDirectory = runtimeDataDirectory();
  const raw = await readFileFs(join(dataDirectory, "run", "runtime.json"), "utf8");
  return RuntimeDescriptorSchema.parse(JSON.parse(raw) as unknown);
}

export function defaultTaskctlDependencies(): TaskctlDependencies {
  return {
    readRuntimeDescriptor: readDefaultRuntimeDescriptor,
    fetch,
    credentials: {
      read: (path) => compatibleCredentialStore(authFileLocations()).read(path),
      write: (path, value) => compatibleCredentialStore(authFileLocations()).write(path, value),
      remove: (path) => compatibleCredentialStore(authFileLocations()).remove(path),
    },
    authFile: defaultAuthFile,
    now: Date.now,
    readFile: async (path) => readFileFs(path),
    writeFile: async (path, bytes) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFileFs(path, bytes);
    },
    cwd: () => process.cwd(),
    codexThreadId: () => process.env.CODEX_THREAD_ID,
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  };
}

export async function runTaskctl(
  argv: readonly string[],
  dependencies: TaskctlDependencies = defaultTaskctlDependencies(),
): Promise<number> {
  const secrets: string[] = [];
  const redact = (value: string) =>
    secrets.reduce(
      (text, secret) => (secret ? text.replaceAll(secret, "[REDACTED]") : text),
      value,
    );
  const original = dependencies;
  dependencies = {
    ...original,
    stdout: (value) => original.stdout(redact(value)),
    stderr: (value) => original.stderr(redact(value)),
  };
  try {
    if (argv.length === 0 || argv.includes("--help") || argv[0] === "help") {
      dependencies.stdout(TASKCTL_HELP);
      return 0;
    }
    const parsed = parseArguments(argv);
    const isAuth = parsed.positionals[0] === "auth";
    const command = isAuth
      ? authCommand(parsed)
      : commandFor(parsed, dependencies.codexThreadId?.());
    const runtime = RuntimeDescriptorSchema.parse(await dependencies.readRuntimeDescriptor());
    validateRuntimeTarget(runtime);
    secrets.push(runtime.capabilityToken);
    const paths = credentialPaths(runtime, dependencies.authFile());
    if (isAuth) return await runAuth(parsed, command, runtime, dependencies, secrets);
    const requiresUserSession = !(
      (command.path === "/api/v1/local/health" && !command.method) ||
      (command.path === "/api/v1/local/backups" && command.method === "POST") ||
      (command.downloadPath !== undefined &&
        command.path.startsWith("/api/v1/local/attachments/") &&
        !command.method)
    );
    const session = requiresUserSession
      ? await readCredential(
          dependencies.credentials,
          paths.session,
          SessionCredentialSchema,
          paths.scope,
          dependencies.now(),
        )
      : null;
    if (requiresUserSession && !session)
      throw new TaskctlAuthError(
        "CLI_AUTH_NO_SESSION",
        "看板操作需要先运行 taskctl auth login，并使用 Web 或飞书账号在看板确认授权",
      );
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${runtime.capabilityToken}`,
    });
    if (session) {
      secrets.push(session.token);
      headers.set("X-Taskctl-Session", session.token);
    }
    if (command.path === "/api/v1/local/context") {
      headers.set("X-Taskctl-Cwd", encodeURIComponent(dependencies.cwd()));
    }
    let body: BodyInit | undefined;
    if (command.uploadPath) {
      body = Buffer.from(await dependencies.readFile(command.uploadPath));
      headers.set("Content-Type", "application/octet-stream");
      headers.set("X-Content-Type", contentType(command.uploadPath));
      headers.set("X-Filename", encodeURIComponent(basename(command.uploadPath)));
      if (command.uploadComment) headers.set("X-Comment-ID", command.uploadComment);
      if (command.pendingComment !== undefined) {
        if (!["true", "false"].includes(command.pendingComment))
          throw new UsageError("--pending 必须是 true 或 false");
        if (command.pendingComment === "true") headers.set("X-Pending-Comment", "1");
      }
    } else if (command.body !== undefined) {
      body = JSON.stringify(command.body);
      headers.set("Content-Type", "application/json");
    }
    if ((command.method ?? "GET") !== "GET") headers.set("Idempotency-Key", randomUUID());
    const request: RequestInit = { method: command.method ?? "GET", headers, redirect: "error" };
    if (body !== undefined) request.body = body;
    const response = await dependencies.fetch(
      `${runtime.localAdminBaseUrl}${command.path}`,
      request,
    );
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string };
      };
      output(dependencies.stderr, {
        error: {
          code: payload.error?.code ?? "HTTP_ERROR",
          message: payload.error?.message ?? `请求失败（${response.status}）`,
          status: response.status,
        },
      });
      return 1;
    }
    if (command.downloadPath) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      await dependencies.writeFile(command.downloadPath, bytes);
      output(dependencies.stdout, {
        data: { path: command.downloadPath, sizeBytes: bytes.byteLength },
      });
    } else {
      const payload: unknown = response.status === 204 ? { data: null } : await response.json();
      output(dependencies.stdout, payload);
    }
    return 0;
  } catch (error: unknown) {
    const usage = error instanceof UsageError;
    output(dependencies.stderr, {
      error: {
        code: usage
          ? "USAGE_ERROR"
          : error instanceof TaskctlAuthError
            ? error.code
            : "TASKCTL_ERROR",
        message: error instanceof Error ? error.message : "taskctl 执行失败",
      },
    });
    return usage ? 2 : 1;
  }
}

function authCommand(parsed: ParsedArguments): RequestCommand {
  const action = parsed.positionals[1];
  if (action === "login")
    return {
      path: "/api/v1/local/auth/requests",
      method: "POST",
      body: { label: requireValue(parsed.options.label, "--label") },
    };
  if (action === "complete") return { path: "/api/v1/local/auth/complete", method: "POST" };
  if (action === "status") return { path: "/api/v1/local/auth/session" };
  if (action === "logout") return { path: "/api/v1/local/auth/logout", method: "POST", body: {} };
  throw new UsageError("未知 auth 命令");
}
const LoginResponseSchema = z.object({
  requestId: z.string().min(1),
  claimSecret: z.string().min(1),
  verificationCode: z.string().min(1),
  verificationUrl: z.url(),
  expiresAt: z.iso.datetime(),
});
const CompleteResponseSchema = z.object({
  token: z.string().min(1),
  identity: UserIdentityRefSchema,
  expiresAt: z.iso.datetime(),
});
async function runAuth(
  parsed: ParsedArguments,
  command: RequestCommand,
  runtime: RuntimeDescriptor,
  dependencies: TaskctlDependencies,
  secrets: string[],
): Promise<number> {
  const action = parsed.positionals[1];
  const paths = credentialPaths(runtime, dependencies.authFile());
  const clearCredentials = async () => {
    await dependencies.credentials.remove(paths.session);
    await dependencies.credentials.remove(paths.pending);
    output(dependencies.stdout, { data: { revoked: true } });
  };
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${runtime.capabilityToken}`,
  });
  let body = command.body;
  if (action === "complete") {
    const pending = await readCredential(
      dependencies.credentials,
      paths.pending,
      PendingCredentialSchema,
      paths.scope,
      dependencies.now(),
    );
    if (!pending)
      throw new TaskctlAuthError("CLI_AUTH_NO_REQUEST", "请先运行 taskctl auth login --label TEXT");
    secrets.push(pending.claimSecret);
    body = { requestId: pending.requestId, claimSecret: pending.claimSecret };
  }
  if (action === "status" || action === "logout") {
    const session = await readCredential(
      dependencies.credentials,
      paths.session,
      SessionCredentialSchema,
      paths.scope,
      action === "logout" ? Number.NEGATIVE_INFINITY : dependencies.now(),
    );
    if (!session && action === "logout") {
      await clearCredentials();
      return 0;
    }
    if (!session)
      throw new TaskctlAuthError(
        "CLI_AUTH_NO_SESSION",
        "尚未登录，请先运行 taskctl auth login --label TEXT",
      );
    secrets.push(session.token);
    headers.set("X-Taskctl-Session", session.token);
  }
  const init: RequestInit = { method: command.method ?? "GET", headers, redirect: "error" };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers.set("Content-Type", "application/json");
  }
  const response = await dependencies.fetch(`${runtime.localAdminBaseUrl}${command.path}`, init);
  if (action === "logout" && response.status === 401) {
    await clearCredentials();
    return 0;
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: { code?: string } };
    // Authentication response messages may reflect input. Never print remote secret-bearing text.
    throw new TaskctlAuthError(
      /^CLI_AUTH_[A-Z_]+$/.test(payload.error?.code ?? "")
        ? payload.error!.code!
        : "CLI_AUTH_FAILED",
      `CLI 认证请求失败（${response.status}），请检查授权状态或重新登录`,
    );
  }
  const payload =
    response.status === 204 ? { data: null } : ((await response.json()) as { data?: unknown });
  if (action === "login") {
    const result = LoginResponseSchema.safeParse(payload.data);
    if (!result.success) throw new TaskctlAuthError("CLI_AUTH_RESPONSE_INVALID", "登录响应无效");
    const { requestId, claimSecret, verificationCode, verificationUrl, expiresAt } = result.data;
    secrets.push(claimSecret);
    const url = new URL(verificationUrl);
    if (
      url.origin !== new URL(runtime.publicBaseUrl).origin ||
      url.username ||
      url.password ||
      url.hash ||
      url.searchParams.get("taskctlLogin") !== requestId ||
      [...url.searchParams.keys()].length !== 1
    )
      throw new TaskctlAuthError("CLI_AUTH_RESPONSE_INVALID", "登录确认地址与当前 runtime 不匹配");
    await dependencies.credentials.write(
      paths.pending,
      JSON.stringify({ scope: paths.scope, requestId, claimSecret, expiresAt }),
    );
    output(dependencies.stdout, {
      data: { requestId, verificationCode, verificationUrl, expiresAt },
    });
  } else if (action === "complete") {
    if ((payload.data as { status?: string } | null)?.status === "pending")
      throw new TaskctlAuthError(
        "CLI_AUTH_PENDING",
        "登录请求尚未在看板确认，请确认后再次运行 taskctl auth complete",
      );
    const result = CompleteResponseSchema.safeParse(payload.data);
    if (!result.success) throw new TaskctlAuthError("CLI_AUTH_RESPONSE_INVALID", "会话响应无效");
    secrets.push(result.data.token);
    await dependencies.credentials.write(
      paths.session,
      JSON.stringify({ scope: paths.scope, ...result.data }),
    );
    await dependencies.credentials.remove(paths.pending);
    output(dependencies.stdout, {
      data: { identity: result.data.identity, expiresAt: result.data.expiresAt },
    });
  } else if (action === "logout") {
    await clearCredentials();
  } else {
    const identity = UserIdentityRefSchema.safeParse(
      (payload.data as { identity?: unknown } | null)?.identity,
    );
    if (!identity.success)
      throw new TaskctlAuthError("CLI_AUTH_RESPONSE_INVALID", "会话身份响应无效");
    output(dependencies.stdout, { data: { identity: identity.data } });
  }
  return 0;
}
