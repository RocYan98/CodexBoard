import { assertPrivateFileSync } from "../../../scripts/private-file-permissions.mjs";
import { fileURLToPath } from "node:url";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";
import { isIP } from "node:net";
import { normalizeCodexBoardEnvironment } from "@codexboard/contracts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const CANONICAL_IPV4_HTTP_ORIGIN =
  /^http:\/\/((?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3})(?::([1-9]\d{0,4}))?$/;

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet > 255)) {
    return false;
  }
  const [first = 0, second = 0, third = 0] = octets;
  if (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  ) {
    return false;
  }
  return true;
}

function isPublicHttpOrigin(origin: string): boolean {
  const domain = /^http:\/\/([a-zA-Z0-9.-]+)(?::([1-9]\d{0,4}))?$/.exec(origin);
  if (
    domain &&
    domain[1] &&
    !isIP(new URL(origin).hostname) &&
    /[a-z]/i.test(domain[1].split(".").at(-1) || "") &&
    domain[1].length <= 253 &&
    domain[1].includes(".") &&
    domain[1].split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) &&
    Number(domain[2] || 80) <= 65535
  )
    return true;
  const match = CANONICAL_IPV4_HTTP_ORIGIN.exec(origin);
  if (!match) return false;
  const port = match[2] ? Number(match[2]) : 80;
  return port <= 65_535 && isPublicIpv4(match[1] ?? "");
}

function isLocalDevelopmentOrigin(origin: string): boolean {
  const parsed = new URL(origin);
  return parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname);
}

const AppConfigSchema = z
  .object({
    CODEXBOARD_ENV: z.enum(["development", "test", "production"]).default("development"),
    CODEXBOARD_AUTH_MODE: z.enum(["development", "feishu", "web"]).default("development"),
    CODEXBOARD_HOST: z.string().min(1).default("127.0.0.1"),
    CODEXBOARD_PORT: z.coerce.number().int().min(1).max(65_535).default(47_823),
    CODEXBOARD_ADMIN_HOST: z.literal("127.0.0.1").default("127.0.0.1"),
    CODEXBOARD_ADMIN_PORT: z.coerce.number().int().min(1).max(65_535).default(47_824),
    CODEXBOARD_ORIGIN: z.url().default("http://localhost:5173"),
    CODEXBOARD_ALLOWED_HOSTS: z
      .string()
      .default("127.0.0.1:47823,localhost:47823")
      .transform((hosts) =>
        [...new Set(hosts.split(",").map((host) => host.trim().toLowerCase()))].filter(Boolean),
      )
      .pipe(z.array(z.string().min(1)).min(1)),
    CODEXBOARD_DATA_DIR: z
      .string()
      .trim()
      .min(1)
      .default(".data")
      .transform((directory) => resolve(REPOSITORY_ROOT, directory)),
    CODEXBOARD_WORKSPACE_ROOTS: z
      .string()
      .default(dirname(REPOSITORY_ROOT))
      .transform((roots) =>
        [...new Set(roots.split(",").map((root) => root.trim()))].filter(Boolean),
      )
      .pipe(
        z
          .array(z.string().min(1))
          .min(1)
          .refine((roots) => roots.every((root) => isAbsolute(root)), {
            message: "允许的工作区根目录必须全部使用绝对路径",
          }),
      ),
    CODEXBOARD_TEMPORARY_PROJECT_ROOT: z
      .string()
      .trim()
      .default("")
      .refine((path) => path === "" || isAbsolute(path), "临时项目展示目录必须使用绝对路径"),
    CODEXBOARD_LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    CODEXBOARD_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(28_800),
    CODEXBOARD_EVENT_HISTORY_LIMIT: z.coerce.number().int().min(10).max(1_000_000).default(10_000),
    CODEXBOARD_SSE_HEARTBEAT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
    CODEXBOARD_SSE_RETRY_MS: z.coerce.number().int().min(1_000).max(60_000).default(3_000),
    CODEXBOARD_SSE_WRITE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
    CODEXBOARD_FEISHU_APP_ID: z.string().trim().min(1).optional(),
    CODEXBOARD_FEISHU_APP_SECRET: z.string().trim().min(1).optional(),
    CODEXBOARD_FEISHU_CREDENTIALS_FILE: z
      .string()
      .trim()
      .min(1)
      .refine(isAbsolute, "飞书凭据文件必须使用绝对路径")
      .optional(),
    CODEXBOARD_FEISHU_APP_SECRET_FILE: z
      .string()
      .trim()
      .min(1)
      .refine(isAbsolute, "飞书 App Secret 文件必须使用绝对路径")
      .optional(),
    CODEXBOARD_FEISHU_API_BASE_URL: z.url().default("https://open.feishu.cn"),
    // Paths as seen by the Codex executor (which may run outside this container).
    CODEXBOARD_EXECUTOR_NODE_PATH: z.string().trim().min(1).refine(isAbsolute).optional(),
    CODEXBOARD_EXECUTOR_TASKCTL_PATH: z.string().trim().min(1).refine(isAbsolute).optional(),
    CODEXBOARD_EXECUTOR_DATA_DIR: z.string().trim().min(1).refine(isAbsolute).optional(),
    CODEXBOARD_CODEX_COMMAND: z.string().trim().min(1).default("codex"),
    CODEXBOARD_CODEX_TRANSPORT: z
      .enum(["managed-unix", "websocket", "embedded"])
      .default("managed-unix"),
    CODEXBOARD_CODEX_ENDPOINT: z
      .url()
      .default("ws://127.0.0.1:47825")
      .transform((endpoint, context) => {
        try {
          return new URL(endpoint).toString();
        } catch {
          context.addIssue({ code: "custom", message: "Codex Endpoint URL 无效" });
          return z.NEVER;
        }
      }),
    CODEXBOARD_CODEX_TOKEN_FILE: z
      .string()
      .trim()
      .min(1)
      .refine(isAbsolute, "Codex capability token 文件必须使用绝对路径")
      .optional(),
    CODEXBOARD_CODEX_PROJECT_STATE_FILE: z.string().trim().min(1).refine(isAbsolute).optional(),
    CODEXBOARD_CODEX_PROJECT_SNAPSHOT_FILE: z
      .string()
      .trim()
      .default("")
      .refine((path) => path === "" || isAbsolute(path), "Codex 项目快照文件必须使用绝对路径"),
    CODEXBOARD_PROJECT_SYNC_RECONCILE_MS: z.coerce
      .number()
      .int()
      .min(50)
      .max(300_000)
      .default(30_000),
    CODEXBOARD_ATTACHMENT_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(100 * 1024 * 1024)
      .default(25 * 1024 * 1024),
    CODEXBOARD_WEB_ROOT: z
      .string()
      .trim()
      .min(1)
      .default(join(REPOSITORY_ROOT, "apps/web/dist"))
      .transform((directory) => resolve(REPOSITORY_ROOT, directory)),
  })
  .superRefine((config, context) => {
    if (config.CODEXBOARD_HOST !== "127.0.0.1") {
      context.addIssue({
        code: "custom",
        path: ["CODEXBOARD_HOST"],
        message: "业务监听地址必须是本机回环地址",
      });
    }

    if (
      config.CODEXBOARD_HOST === config.CODEXBOARD_ADMIN_HOST &&
      config.CODEXBOARD_PORT === config.CODEXBOARD_ADMIN_PORT
    ) {
      context.addIssue({
        code: "custom",
        path: ["CODEXBOARD_ADMIN_PORT"],
        message: "本机管理端口不能与业务端口相同",
      });
    }

    if (
      config.CODEXBOARD_FEISHU_CREDENTIALS_FILE &&
      (config.CODEXBOARD_FEISHU_APP_ID ||
        config.CODEXBOARD_FEISHU_APP_SECRET ||
        config.CODEXBOARD_FEISHU_APP_SECRET_FILE)
    ) {
      context.addIssue({
        code: "custom",
        path: ["CODEXBOARD_FEISHU_CREDENTIALS_FILE"],
        message: "统一飞书凭据文件不能与单独的 App ID、App Secret 或 Secret 文件同时配置",
      });
    }

    if (
      config.CODEXBOARD_AUTH_MODE === "web" &&
      new URL(config.CODEXBOARD_ORIGIN).protocol !== "https:"
    ) {
      context.addIssue({
        code: "custom",
        path: ["CODEXBOARD_ORIGIN"],
        message: "Web 账号访问必须使用 HTTPS",
      });
    }
    if (config.CODEXBOARD_AUTH_MODE === "feishu") {
      if (!config.CODEXBOARD_FEISHU_APP_ID && !config.CODEXBOARD_FEISHU_CREDENTIALS_FILE) {
        context.addIssue({
          code: "custom",
          path: ["CODEXBOARD_FEISHU_APP_ID"],
          message: "飞书认证模式需要 App ID",
        });
      }
      if (
        !config.CODEXBOARD_FEISHU_APP_SECRET &&
        !config.CODEXBOARD_FEISHU_APP_SECRET_FILE &&
        !config.CODEXBOARD_FEISHU_CREDENTIALS_FILE
      ) {
        context.addIssue({
          code: "custom",
          path: ["CODEXBOARD_FEISHU_APP_SECRET"],
          message: "飞书认证模式需要 App Secret",
        });
      }
      if (
        new URL(config.CODEXBOARD_ORIGIN).protocol !== "https:" &&
        !isPublicHttpOrigin(config.CODEXBOARD_ORIGIN)
      ) {
        context.addIssue({
          code: "custom",
          path: ["CODEXBOARD_ORIGIN"],
          message: "飞书认证模式必须使用 HTTPS Origin 或公网域名或规范公网 IPv4 HTTP Origin",
        });
      }
    }

    if (
      config.CODEXBOARD_AUTH_MODE === "development" &&
      (config.CODEXBOARD_ENV === "production" ||
        !isLocalDevelopmentOrigin(config.CODEXBOARD_ORIGIN))
    ) {
      context.addIssue({
        code: "custom",
        path: ["CODEXBOARD_AUTH_MODE"],
        message: "开发身份适配器只能用于 localhost HTTP 开发环境",
      });
    }

    if (config.CODEXBOARD_CODEX_TRANSPORT === "embedded") {
      if (!isAbsolute(config.CODEXBOARD_CODEX_COMMAND)) {
        context.addIssue({
          code: "custom",
          path: ["CODEXBOARD_CODEX_COMMAND"],
          message: "内嵌桥接需要 Codex 程序的绝对路径",
        });
      }
      if (!config.CODEXBOARD_CODEX_PROJECT_STATE_FILE) {
        context.addIssue({
          code: "custom",
          path: ["CODEXBOARD_CODEX_PROJECT_STATE_FILE"],
          message: "内嵌桥接需要 Codex 项目状态文件",
        });
      }
    }

    if (config.CODEXBOARD_CODEX_TRANSPORT !== "managed-unix") {
      const endpoint = URL.parse(config.CODEXBOARD_CODEX_ENDPOINT);
      if (!endpoint) {
        context.addIssue({
          code: "custom",
          path: ["CODEXBOARD_CODEX_ENDPOINT"],
          message: "Codex Endpoint URL 无效",
        });
        return;
      }
      const port = Number(endpoint.port || 80);
      if (
        endpoint.protocol !== "ws:" ||
        endpoint.hostname !== "127.0.0.1" ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65_535 ||
        endpoint.username ||
        endpoint.password ||
        endpoint.href !== `${endpoint.origin}/`
      ) {
        context.addIssue({
          code: "custom",
          path: ["CODEXBOARD_CODEX_ENDPOINT"],
          message: "Codex Endpoint 必须是 ws://127.0.0.1:<1-65535>，不能包含凭据、路径、查询或片段",
        });
      }
      if (!config.CODEXBOARD_CODEX_TOKEN_FILE) {
        context.addIssue({
          code: "custom",
          path: ["CODEXBOARD_CODEX_TOKEN_FILE"],
          message: "外部 Codex WebSocket 需要 capability token 文件",
        });
      }
    }

    if (
      config.CODEXBOARD_ENV === "production" &&
      config.CODEXBOARD_CODEX_TRANSPORT === "managed-unix"
    ) {
      context.addIssue({
        code: "custom",
        path: ["CODEXBOARD_CODEX_TRANSPORT"],
        message: "生产环境必须使用受鉴权保护的外部或内嵌 Codex 桥接",
      });
    }
  });

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type LogLevel = AppConfig["CODEXBOARD_LOG_LEVEL"];

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super("服务配置无效");
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = AppConfigSchema.safeParse(normalizeCodexBoardEnvironment(environment));

  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }
  const config = result.data;
  if (isPublicHttpOrigin(config.CODEXBOARD_ORIGIN)) {
    config.CODEXBOARD_ORIGIN = new URL(config.CODEXBOARD_ORIGIN).origin;
  }
  if (!config.CODEXBOARD_CODEX_PROJECT_SNAPSHOT_FILE) {
    config.CODEXBOARD_CODEX_PROJECT_SNAPSHOT_FILE = join(
      config.CODEXBOARD_DATA_DIR,
      "run",
      "codex-projects.json",
    );
  }
  if (!config.CODEXBOARD_TEMPORARY_PROJECT_ROOT && process.platform === "darwin") {
    config.CODEXBOARD_TEMPORARY_PROJECT_ROOT = join(homedir(), "Documents", "Codex");
  }
  if (config.CODEXBOARD_FEISHU_APP_SECRET && config.CODEXBOARD_FEISHU_APP_SECRET_FILE) {
    throw new ConfigError([
      "CODEXBOARD_FEISHU_APP_SECRET_FILE: 不能同时配置明文 Secret 与 Secret 文件",
    ]);
  }
  if (config.CODEXBOARD_FEISHU_CREDENTIALS_FILE) {
    const path = config.CODEXBOARD_FEISHU_CREDENTIALS_FILE;
    try {
      assertPrivateFileSync(path);
      const credentials = z
        .strictObject({
          appId: z
            .string()
            .trim()
            .regex(/^cli_[A-Za-z0-9]+$/),
          appSecret: z
            .string()
            .trim()
            .min(1)
            .regex(/^[^\r\n\0]+$/),
        })
        .parse(JSON.parse(readFileSync(path, "utf8")));
      config.CODEXBOARD_FEISHU_APP_ID = credentials.appId;
      config.CODEXBOARD_FEISHU_APP_SECRET = credentials.appSecret;
    } catch {
      // JSON 解析异常可能包含凭据片段，只报告固定错误。
      throw new ConfigError([
        "CODEXBOARD_FEISHU_CREDENTIALS_FILE: 无法读取有效凭据，请检查文件为仅当前用户可访问的普通文件（POSIX 权限不宽于 0600），且 JSON 包含有效的 appId、appSecret",
      ]);
    }
  }
  if (config.CODEXBOARD_FEISHU_APP_SECRET_FILE) {
    const path = config.CODEXBOARD_FEISHU_APP_SECRET_FILE;
    try {
      assertPrivateFileSync(path);
      const secret = readFileSync(path, "utf8").trim();
      if (!secret) throw new Error("文件内容为空");
      config.CODEXBOARD_FEISHU_APP_SECRET = secret;
    } catch (error: unknown) {
      throw new ConfigError([
        `CODEXBOARD_FEISHU_APP_SECRET_FILE: ${error instanceof Error ? error.message : "无法读取"}`,
      ]);
    }
  }
  if (config.CODEXBOARD_CODEX_TOKEN_FILE) {
    const path = config.CODEXBOARD_CODEX_TOKEN_FILE;
    try {
      assertPrivateFileSync(path);
      if (!readFileSync(path, "utf8").trim()) throw new Error("文件内容为空");
    } catch (error: unknown) {
      throw new ConfigError([
        `CODEXBOARD_CODEX_TOKEN_FILE: ${error instanceof Error ? error.message : "无法读取"}`,
      ]);
    }
  }
  if (config.CODEXBOARD_ENV === "production") {
    const indexPath = join(config.CODEXBOARD_WEB_ROOT, "index.html");
    if (!existsSync(indexPath) || !lstatSync(indexPath).isFile()) {
      throw new ConfigError(["CODEXBOARD_WEB_ROOT: Web 构建目录缺少 index.html"]);
    }
  }
  return config;
}
