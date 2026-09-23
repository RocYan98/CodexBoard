import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { AppError } from "../../app-error.js";
import type { SqliteDatabase } from "../database/index.js";

export function hasTaskLifecycleIntent(database: SqliteDatabase, taskId: string): boolean {
  return Boolean(
    database
      .prepare(
        "SELECT 1 FROM task_lifecycle_operations WHERE task_id = ? AND status IN ('pending', 'running', 'failed')",
      )
      .get(taskId),
  );
}

export function assertTaskLifecycleAvailable(database: SqliteDatabase, taskId: string): void {
  if (hasTaskLifecycleIntent(database, taskId))
    throw new AppError("VERSION_CONFLICT", 409, "任务正在取消或收尾，请先完成或重试该操作");
}

export function canonicalWorkspace(directory: string): string {
  try {
    return realpathSync.native(directory);
  } catch {
    return resolve(directory);
  }
}

export function assertWorkspaceLifecycleAvailable(
  database: SqliteDatabase,
  directory: string,
): void {
  assertGitManagementAvailable(database, directory);
  for (const key of workspaceResourceKeys(directory)) {
    if (
      database.prepare("SELECT 1 FROM task_lifecycle_resources WHERE resource_key = ?").get(key)
    ) {
      throw new AppError("VERSION_CONFLICT", 409, "该工作区正在执行任务收尾，请稍后重试");
    }
  }
}

export function workspaceResourceKeys(directory: string): readonly string[] {
  const cwd = canonicalWorkspace(directory);
  const keys = [`cwd:${cwd}`];
  try {
    const common = execFileSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    keys.push(`repo:${canonicalWorkspace(resolve(cwd, common))}`);
  } catch {
    /* Non-Git temporary tasks still participate in the directory lock. */
  }
  return keys;
}

// The application owns one database/process; release in finally and restart clears in-flight locks.
const gitManagementLocks = new WeakMap<SqliteDatabase, Set<string>>();
export function assertGitManagementAvailable(database: SqliteDatabase, directory: string): void {
  if (workspaceResourceKeys(directory).some((key) => gitManagementLocks.get(database)?.has(key)))
    throw new AppError("VERSION_CONFLICT", 409, "该仓库正在管理分支或工作树，请稍后重试");
}
export function acquireGitManagementLock(database: SqliteDatabase, directory: string): () => void {
  assertWorkspaceLifecycleAvailable(database, directory);
  const keys = workspaceResourceKeys(directory);
  const held = gitManagementLocks.get(database) ?? new Set<string>();
  gitManagementLocks.set(database, held);
  for (const key of keys) held.add(key);
  return () => {
    for (const key of keys) held.delete(key);
  };
}
