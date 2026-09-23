import {
  ensurePrivateDirectorySync,
  ensurePrivateFileSync,
} from "../../../../../scripts/private-file-permissions.mjs";
import { existsSync, lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import { CORE_MIGRATIONS } from "./migrations/index.js";
import { runMigrations } from "./migrator.js";

export type SqliteDatabase = Database.Database;

function isMemoryDatabase(filename: string): boolean {
  return filename === ":memory:";
}

export function openDatabase(filename: string): SqliteDatabase {
  const memory = isMemoryDatabase(filename);
  const resolvedFilename = memory ? filename : resolve(filename);

  if (!memory) {
    ensurePrivateDirectorySync(dirname(resolvedFilename));
  }

  const existed = memory || existsSync(resolvedFilename);
  if (!memory && existed) {
    const stat = lstatSync(resolvedFilename);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("SQLite 数据库必须是不含符号链接的普通文件");
    }
  }
  const database = new Database(resolvedFilename);

  try {
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    database.pragma("synchronous = NORMAL");
    database.pragma("temp_store = MEMORY");
    database.pragma("journal_mode = WAL");

    if (!memory && !existed) {
      const stat = lstatSync(resolvedFilename);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error("SQLite 数据库必须是不含符号链接的普通文件");
      }
      ensurePrivateFileSync(resolvedFilename);
    }

    return database;
  } catch (error: unknown) {
    database.close();
    throw error;
  }
}

export function initializeDatabase(filename: string): SqliteDatabase {
  const database = openDatabase(filename);

  try {
    runMigrations(database, CORE_MIGRATIONS);
    return database;
  } catch (error: unknown) {
    database.close();
    throw error;
  }
}

export function withTransaction<Result>(database: SqliteDatabase, operation: () => Result): Result {
  return database.transaction(operation)();
}

export function isDatabaseHealthy(database: SqliteDatabase): boolean {
  try {
    const result = database.prepare("SELECT 1 AS healthy").get() as { healthy: number } | undefined;
    return result?.healthy === 1;
  } catch {
    return false;
  }
}
