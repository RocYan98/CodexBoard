import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import {
  assertPrivateDirectorySync,
  assertPrivateFileSync,
  ensurePrivateDirectorySync,
  ensurePrivateFileSync,
} from "../../../scripts/private-file-permissions.mjs";
import {
  UserIdentityRefSchema,
  normalizeCodexBoardEnvironment,
  type RuntimeDescriptor,
} from "@codexboard/contracts";

export interface CredentialStore {
  read(path: string): Promise<string | null>;
  write(path: string, value: string): Promise<void>;
  remove(path: string): Promise<void>;
}
export class TaskctlAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function validateRuntimeTarget(runtime: RuntimeDescriptor): void {
  const local = new URL(runtime.localAdminBaseUrl);
  const publicUrl = new URL(runtime.publicBaseUrl);
  if (
    !["http:", "https:"].includes(local.protocol) ||
    !["127.0.0.1", "[::1]"].includes(local.hostname) ||
    local.username ||
    local.password ||
    local.hash ||
    local.search ||
    local.pathname !== "/" ||
    !["http:", "https:"].includes(publicUrl.protocol) ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.hash
  )
    throw new TaskctlAuthError(
      "UNSAFE_RUNTIME_TARGET",
      "runtime 地址无效；凭据只允许发送到本机 loopback 接口",
    );
}
export function runtimeScope(runtime: RuntimeDescriptor): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        new URL(runtime.publicBaseUrl).href,
        new URL(runtime.localAdminBaseUrl).href,
      ]),
    )
    .digest("hex");
}
export function authFileLocations(
  environment: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): { current: string; legacy?: string | readonly string[] } {
  const env = normalizeCodexBoardEnvironment(environment);
  if (env.CODEXBOARD_AUTH_FILE !== undefined) {
    if (!env.CODEXBOARD_AUTH_FILE.trim())
      throw new TaskctlAuthError("CLI_AUTH_FILE_INVALID", "CODEXBOARD_AUTH_FILE 不能为空");
    return { current: env.CODEXBOARD_AUTH_FILE };
  }
  const directory = env.XDG_CONFIG_HOME ?? join(userHome, ".config");
  return {
    current: join(directory, "codexboard", "taskctl-auth"),
    legacy: ["lark-codex", "lark-taskboard"].map((name) => join(directory, name, "taskctl-auth")),
  };
}
export function defaultAuthFile(): string {
  return authFileLocations().current;
}

/** Read only the matching runtime scope from the previous default location.
 * Existing new credentials, including invalid/expired ones, never fall back. */
export function compatibleCredentialStore(
  locations: { current: string; legacy?: string | readonly string[] },
  store: CredentialStore = defaultCredentialStore,
): CredentialStore {
  const oldPaths = (path: string): string[] => {
    const suffix = path.slice(locations.current.length);
    if (!path.startsWith(locations.current) || !/^\.[a-f0-9]{64}(?:\.pending)?\.json$/.test(suffix))
      return [];
    const legacy =
      typeof locations.legacy === "string" ? [locations.legacy] : (locations.legacy ?? []);
    return legacy.map((base) => `${base}${suffix}`);
  };
  return {
    async read(path) {
      const value = await store.read(path);
      if (value !== null) return value;
      for (const legacy of oldPaths(path)) {
        const previous = await store.read(legacy);
        if (previous !== null) return previous;
      }
      return null;
    },
    write: (path, value) => store.write(path, value),
    async remove(path) {
      // Clear all older generations first so logout cannot revive old credentials.
      for (const legacy of oldPaths(path)) await store.remove(legacy);
      await store.remove(path);
    },
  };
}

export function credentialPaths(runtime: RuntimeDescriptor, base: string) {
  const scope = runtimeScope(runtime);
  return { scope, session: `${base}.${scope}.json`, pending: `${base}.${scope}.pending.json` };
}
export const defaultCredentialStore: CredentialStore = {
  async read(path) {
    try {
      const entry = await lstat(path);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("unsafe credential entry");
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) ||
          (process.getuid && stat.uid !== process.getuid())
        )
          throw new TaskctlAuthError(
            "CLI_AUTH_FILE_PERMISSIONS",
            "CLI 凭据文件必须由当前用户拥有且权限为 0600",
          );
        if (process.platform === "win32") {
          try {
            assertPrivateFileSync(resolve(path));
            const checked = await lstat(path);
            if (checked.ino !== stat.ino || checked.dev !== stat.dev || checked.isSymbolicLink()) {
              throw new Error("credential changed during validation");
            }
          } catch {
            throw new TaskctlAuthError(
              "CLI_AUTH_FILE_PERMISSIONS",
              "CLI 凭据文件必须仅允许当前用户访问",
            );
          }
        }
        return await file.readFile("utf8");
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof TaskctlAuthError) throw error;
      throw new TaskctlAuthError("CLI_AUTH_FILE_READ", "无法安全读取 CLI 凭据文件");
    }
  },
  async write(path, value) {
    const created = await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    if (process.platform === "win32") {
      // Never rewrite permissions on an arbitrary pre-existing parent directory.
      if (created !== undefined) ensurePrivateDirectorySync(resolve(dirname(path)));
      else assertPrivateDirectorySync(resolve(dirname(path)));
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        if (process.platform === "win32") ensurePrivateFileSync(resolve(temporary));
        await file.writeFile(value, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  },
  async remove(path) {
    await rm(path, { force: true });
  },
};
const Shared = { scope: z.string(), expiresAt: z.iso.datetime() };
export const PendingCredentialSchema = z
  .object({ ...Shared, requestId: z.string().min(1), claimSecret: z.string().min(1) })
  .strict();
export const SessionCredentialSchema = z
  .object({ ...Shared, token: z.string().min(1), identity: UserIdentityRefSchema })
  .strict();
export async function readCredential<T>(
  store: CredentialStore,
  path: string,
  schema: z.ZodType<T>,
  scope: string,
  now: number,
): Promise<T | null> {
  const raw = await store.read(path);
  if (raw === null) return null;
  let result: z.ZodSafeParseResult<T>;
  try {
    result = schema.safeParse(JSON.parse(raw));
  } catch {
    throw new TaskctlAuthError("CLI_AUTH_FILE_INVALID", "CLI 凭据文件无效，请重新登录");
  }
  if (!result.success)
    throw new TaskctlAuthError("CLI_AUTH_FILE_INVALID", "CLI 凭据文件无效，请重新登录");
  const common = result.data as { scope: string; expiresAt: string };
  if (common.scope !== scope)
    throw new TaskctlAuthError(
      "CLI_AUTH_RUNTIME_MISMATCH",
      "CLI 凭据不属于当前 runtime，请重新登录",
    );
  if (Date.parse(common.expiresAt) <= now)
    throw new TaskctlAuthError("CLI_AUTH_EXPIRED", "CLI 凭据已过期，请重新登录");
  return result.data;
}
