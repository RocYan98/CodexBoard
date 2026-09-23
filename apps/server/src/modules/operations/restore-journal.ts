import {
  ensurePrivateDirectorySync,
  ensurePrivateFileSync,
} from "../../../../../scripts/private-file-permissions.mjs";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { z } from "zod";

const RestoreJournalSchema = z
  .object({
    version: z.literal(1),
    rollbackName: z.string().regex(/^\.restore-rollback-[0-9a-f-]+$/),
    stagingName: z.string().regex(/^\.restore-[0-9a-f-]+$/),
    hadAttachments: z.boolean(),
    phase: z.enum(["prepared", "committed", "rolling_back"]),
    createdAt: z.string().datetime(),
  })
  .strict();

export type RestoreJournal = z.infer<typeof RestoreJournalSchema>;

export function syncDurablePath(path: string): void {
  // Windows cannot open/fsync directories; regular-file flush failures remain fatal.
  if (process.platform === "win32" && lstatSync(path).isDirectory()) return;
  // FlushFileBuffers requires GENERIC_WRITE on Windows. r+ grants it without
  // truncating the existing payload; POSIX can fsync a read-only descriptor.
  const descriptor = openSync(path, process.platform === "win32" ? "r+" : "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function syncDurableTree(path: string, synchronize: (path: string) => void): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error("耐久化文件树不能包含符号链接");
  if (stat.isFile()) {
    synchronize(path);
    return;
  }
  if (!stat.isDirectory()) throw new Error("耐久化文件树只能包含普通文件和目录");
  for (const name of readdirSync(path).sort()) syncDurableTree(join(path, name), synchronize);
  synchronize(path);
}

function assertOrdinaryFile(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label}必须是不含符号链接的普通文件`);
  }
}

function assertDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label}必须是不含符号链接的目录`);
  }
}

function removeTree(path: string, label: string): void {
  if (!existsSync(path)) return;
  assertDirectory(path, label);
  rmSync(path, { recursive: true });
}

function removeDatabaseSidecars(databasePath: string): void {
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
}

function paths(dataDirectory: string) {
  const root = resolve(dataDirectory);
  return { root, runDirectory: join(root, "run"), journalPath: join(root, "run", "restore.json") };
}

function readJournal(dataDirectory: string): RestoreJournal {
  const { journalPath } = paths(dataDirectory);
  assertOrdinaryFile(journalPath, "恢复日志");
  return RestoreJournalSchema.parse(JSON.parse(readFileSync(journalPath, "utf8")) as unknown);
}

export function assertNoInterruptedRestore(dataDirectory: string): void {
  const { root, journalPath } = paths(dataDirectory);
  if (existsSync(journalPath)) {
    throw new Error("检测到未完成的恢复，拒绝读取可能处于切换中的数据");
  }
  if (existsSync(root) && readdirSync(root).some((name) => name.startsWith(".restore-rollback-"))) {
    throw new Error("检测到没有恢复日志的回滚目录，拒绝读取可能处于切换中的数据");
  }
}

function replaceJournal(dataDirectory: string, journal: RestoreJournal): void {
  const value = RestoreJournalSchema.parse(journal);
  const { runDirectory, journalPath } = paths(dataDirectory);
  const temporary = `${journalPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    ensurePrivateFileSync(temporary);
    syncDurablePath(temporary);
    renameSync(temporary, journalPath);
    syncDurablePath(runDirectory);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function writeRestoreJournal(dataDirectory: string, journal: RestoreJournal): void {
  const value = RestoreJournalSchema.parse(journal);
  const { runDirectory, journalPath } = paths(dataDirectory);
  ensurePrivateDirectorySync(runDirectory);
  assertDirectory(runDirectory, "运行时目录");
  if (existsSync(journalPath)) throw new Error("检测到未完成的历史恢复，拒绝开始新的恢复");
  replaceJournal(dataDirectory, value);
}

export interface RestoreDurabilityHooks {
  readonly syncPath?: (path: string) => void;
  readonly renamePath?: (source: string, destination: string) => void;
  readonly markCommitted?: (dataDirectory: string, journal: RestoreJournal) => void;
  readonly beforeCleanup?: () => void;
}

function syncLivePayload(root: string, synchronize: (path: string) => void): void {
  const liveDatabase = join(root, "taskboard.sqlite");
  const liveAttachments = join(root, "attachments");
  assertOrdinaryFile(liveDatabase, "恢复后的数据库");
  synchronize(liveDatabase);
  if (existsSync(liveAttachments)) {
    assertDirectory(liveAttachments, "恢复后的附件目录");
    syncDurableTree(liveAttachments, synchronize);
  }
  synchronize(root);
}

export function makeRestoreRollbackDurable(
  dataDirectory: string,
  journal: RestoreJournal,
  hooks: RestoreDurabilityHooks = {},
): void {
  const root = resolve(dataDirectory);
  const rollback = join(root, journal.rollbackName);
  const rollbackDatabase = join(rollback, "taskboard.sqlite");
  assertOrdinaryFile(rollbackDatabase, "回滚数据库");
  if (journal.hadAttachments) {
    assertDirectory(join(rollback, "attachments"), "回滚附件目录");
  }
  syncDurableTree(rollback, hooks.syncPath ?? syncDurablePath);
  (hooks.syncPath ?? syncDurablePath)(root);
}

export function recoverInterruptedRestore(
  dataDirectory: string,
  hooks: RestoreDurabilityHooks = {},
): boolean {
  const { root, runDirectory, journalPath } = paths(dataDirectory);
  if (!existsSync(journalPath)) {
    assertNoInterruptedRestore(root);
    return false;
  }
  const journal = readJournal(root);
  const rollback = join(root, journal.rollbackName);
  const staging = join(root, journal.stagingName);
  const liveDatabase = join(root, "taskboard.sqlite");
  const rollbackDatabase = join(rollback, "taskboard.sqlite");
  const liveAttachments = join(root, "attachments");
  const rollbackAttachments = join(rollback, "attachments");
  const synchronize = hooks.syncPath ?? syncDurablePath;
  const move = hooks.renamePath ?? renameSync;

  if (journal.phase === "committed") {
    removeTree(staging, "恢复暂存目录");
    removeTree(rollback, "恢复回滚目录");
    unlinkSync(journalPath);
    synchronize(runDirectory);
    synchronize(root);
    return true;
  }

  if (journal.phase === "prepared") {
    replaceJournal(root, { ...journal, phase: "rolling_back" });
  }

  if (existsSync(rollbackDatabase)) {
    assertOrdinaryFile(rollbackDatabase, "回滚数据库");
    if (journal.hadAttachments && existsSync(rollbackAttachments)) {
      assertDirectory(rollbackAttachments, "回滚附件目录");
      removeTree(liveAttachments, "当前附件目录");
      move(rollbackAttachments, liveAttachments);
      ensurePrivateDirectorySync(liveAttachments);
    } else if (!journal.hadAttachments) {
      removeTree(liveAttachments, "当前附件目录");
    }
    if (existsSync(liveDatabase)) {
      assertOrdinaryFile(liveDatabase, "当前数据库");
      rmSync(liveDatabase);
    }
    removeDatabaseSidecars(liveDatabase);
    move(rollbackDatabase, liveDatabase);
    ensurePrivateFileSync(liveDatabase);
  } else if (!existsSync(liveDatabase)) {
    throw new Error("恢复中断且当前数据库缺失，拒绝创建空数据库");
  } else {
    assertOrdinaryFile(liveDatabase, "当前数据库");
  }

  syncLivePayload(root, synchronize);
  hooks.beforeCleanup?.();
  removeTree(staging, "恢复暂存目录");
  removeTree(rollback, "恢复回滚目录");
  unlinkSync(journalPath);
  synchronize(runDirectory);
  synchronize(root);
  return true;
}

export function finalizeRestoreJournal(
  dataDirectory: string,
  hooks: RestoreDurabilityHooks = {},
): void {
  const { root, runDirectory, journalPath } = paths(dataDirectory);
  const journal = readJournal(root);
  const synchronize = hooks.syncPath ?? syncDurablePath;
  const liveDatabase = join(root, "taskboard.sqlite");
  const liveAttachments = join(root, "attachments");
  assertOrdinaryFile(liveDatabase, "恢复后的数据库");
  assertDirectory(liveAttachments, "恢复后的附件目录");
  synchronize(liveDatabase);
  syncDurableTree(liveAttachments, synchronize);
  synchronize(root);
  const committed = { ...journal, phase: "committed" as const };
  if (hooks.markCommitted) hooks.markCommitted(root, committed);
  else replaceJournal(root, committed);
  removeTree(join(root, journal.rollbackName), "恢复回滚目录");
  removeTree(join(root, journal.stagingName), "恢复暂存目录");
  unlinkSync(journalPath);
  synchronize(runDirectory);
  synchronize(root);
}
