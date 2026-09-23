import {
  ensurePrivateDirectorySync,
  ensurePrivateFileSync,
} from "../../../../../scripts/private-file-permissions.mjs";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";

import { assertNoSymlinkComponents } from "./safe-path.js";

export interface DataDirectoryLock {
  readonly path: string;
  release(): void;
}

function ensurePrivateDirectory(path: string, label: string): void {
  ensurePrivateDirectorySync(path);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label}必须是不含符号链接的目录`);
  }
}

function assertSafeLockDatabase(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("数据目录锁必须是不含符号链接的普通文件");
  }
}

function isBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

/**
 * The lock is an exclusive SQLite transaction in a database that is separate
 * from the taskboard payload. SQLite delegates ownership to the kernel, so a
 * process crash releases the lock without any stale-file unlink race.
 */
export function acquireDataDirectoryLock(
  dataDirectory: string,
  purpose: string,
): DataDirectoryLock {
  let root = assertNoSymlinkComponents(resolve(dataDirectory), "数据根目录");
  ensurePrivateDirectory(root, "数据根目录");
  root = assertNoSymlinkComponents(root, "数据根目录");
  const runDirectory = join(root, "run");
  ensurePrivateDirectory(runDirectory, "运行时目录");
  assertNoSymlinkComponents(runDirectory, "运行时目录");

  // The earlier candidate-file implementation used this path. Refuse an
  // ambiguous upgrade instead of guessing whether another version owns it.
  const legacyLockPath = join(runDirectory, "data.lock");
  if (existsSync(legacyLockPath)) {
    throw new Error("检测到旧版数据目录锁；请先确认旧版服务已停止并移除该锁");
  }

  const lockPath = join(runDirectory, "data-lock.sqlite");
  assertSafeLockDatabase(lockPath);
  let database: Database.Database | undefined;
  const token = randomUUID();
  try {
    database = new Database(lockPath);
    ensurePrivateFileSync(lockPath);
    database.pragma("busy_timeout = 0");
    database.pragma("journal_mode = DELETE");
    database.exec(`CREATE TABLE IF NOT EXISTS lock_owner (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      pid INTEGER NOT NULL,
      token TEXT NOT NULL,
      purpose TEXT NOT NULL,
      acquired_at TEXT NOT NULL
    )`);
    database.exec("BEGIN EXCLUSIVE");
    database
      .prepare(
        `INSERT INTO lock_owner (singleton, pid, token, purpose, acquired_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           pid = excluded.pid,
           token = excluded.token,
           purpose = excluded.purpose,
           acquired_at = excluded.acquired_at`,
      )
      .run(process.pid, token, purpose, new Date().toISOString());
  } catch (error: unknown) {
    if (database?.open) database.close();
    if (isBusyError(error)) {
      throw new Error("数据目录正在使用", { cause: error });
    }
    throw error;
  }

  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      const owner = database
        ?.prepare("SELECT pid, token FROM lock_owner WHERE singleton = 1")
        .get() as { pid: number; token: string } | undefined;
      if (owner?.pid !== process.pid || owner.token !== token) {
        throw new Error("数据目录锁所有权已变化，拒绝释放");
      }
      database?.exec("ROLLBACK");
      database?.close();
      released = true;
    },
  };
}
