import {
  ensurePrivateDirectorySync,
  ensurePrivateFileSync,
} from "../../../../../scripts/private-file-permissions.mjs";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { BackupManifestSchema, type BackupManifest } from "@codexboard/contracts";
import Database from "better-sqlite3";

import {
  CORE_MIGRATIONS,
  pendingMigrationVersions,
  type SqliteDatabase,
} from "../database/index.js";
import { acquireDataDirectoryLock } from "./data-directory-lock.js";
import {
  assertNoInterruptedRestore,
  finalizeRestoreJournal,
  makeRestoreRollbackDurable,
  recoverInterruptedRestore,
  syncDurablePath,
  syncDurableTree,
  type RestoreDurabilityHooks,
  type RestoreJournal,
  writeRestoreJournal,
} from "./restore-journal.js";
import { assertNoSymlinkComponents } from "./safe-path.js";

export interface BackupServiceOptions {
  readonly database: SqliteDatabase;
  readonly dataDirectory: string;
  readonly now?: () => Date;
  readonly durabilityHooks?: RestoreDurabilityHooks;
}

export interface RestoreResult {
  readonly restoredFrom: string;
  readonly safetyBackup: string | null;
  readonly corruptCurrentArtifact: CorruptCurrentArtifact | null;
}

export interface CorruptCurrentArtifact {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

function sha256(path: string): string {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead: number;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function safeRelativePath(root: string, path: string): string {
  const value = relative(root, path);
  if (!value || value === ".." || value.startsWith(`..${sep}`)) {
    throw new Error("备份文件路径越出附件目录");
  }
  return value.split(sep).join("/");
}

function isInsideOrEqual(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`));
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("附件根目录必须是不含符号链接的目录");
  }
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("附件目录包含符号链接，拒绝备份");
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push(path);
      else throw new Error("附件目录包含不支持的文件类型");
    }
  };
  visit(root);
  return files.sort();
}

function copyAttachmentTree(sourceRoot: string, destinationRoot: string): void {
  ensurePrivateDirectorySync(destinationRoot);
  for (const source of listFiles(sourceRoot)) {
    const path = safeRelativePath(sourceRoot, source);
    const destination = join(destinationRoot, ...path.split("/"));
    ensurePrivateDirectorySync(dirname(destination));
    copyFileSync(source, destination);
    ensurePrivateFileSync(destination);
  }
}

function readManifest(directory: string): BackupManifest {
  const directoryStat = lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error("备份根目录必须是不含符号链接的目录");
  }
  const path = join(directory, "manifest.json");
  if (lstatSync(path).isSymbolicLink()) throw new Error("备份清单不能是符号链接");
  return BackupManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

function currentSchemaVersion(database: SqliteDatabase): number {
  return (
    (database.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get() as
      number | null) ?? 0
  );
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function assertOffline(dataDirectory: string): void {
  const descriptorPath = join(dataDirectory, "run", "runtime.json");
  if (!existsSync(descriptorPath)) return;
  let pid: number;
  try {
    const value = JSON.parse(readFileSync(descriptorPath, "utf8")) as { pid?: unknown };
    if (!Number.isInteger(value.pid) || Number(value.pid) < 1) throw new Error();
    pid = Number(value.pid);
  } catch {
    throw new Error("运行时描述无效，拒绝在无法确认离线时恢复");
  }
  if (isProcessRunning(pid)) throw new Error("服务仍在运行，拒绝恢复数据");
}

function removeDatabaseSidecars(databasePath: string): void {
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
}

function errorReason(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "当前数据库无法通过 SQLite 校验";
}

interface SafetyBackupAttempt {
  readonly safetyBackup: string | null;
  readonly corruptionReason: string | null;
}

async function tryCreateSafetyBackup(
  databasePath: string,
  dataDirectory: string,
): Promise<SafetyBackupAttempt> {
  let database: Database.Database | undefined;
  try {
    const header = readFileSync(databasePath).subarray(0, 16).toString("hex");
    if (header !== "53514c69746520666f726d6174203300") {
      throw new Error("当前数据库 SQLite 文件头无效");
    }
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    const integrity = database.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error("当前数据库 SQLite 完整性校验失败");
    const safetyService = new BackupService({ database, dataDirectory });
    const safetyBackup = safetyService.automaticDestination("pre-restore");
    await safetyService.create(safetyBackup);
    return { safetyBackup, corruptionReason: null };
  } catch (error: unknown) {
    if (database?.open) database.close();
    return { safetyBackup: null, corruptionReason: errorReason(error) };
  } finally {
    if (database?.open) database.close();
  }
}

function corruptArtifactDestination(dataDirectory: string, createdAt: string): string {
  const timestamp = createdAt.replaceAll(/[:.]/g, "-");
  return join(
    dataDirectory,
    "backups",
    `pre-restore-corrupt-${timestamp}-${randomUUID().slice(0, 8)}`,
  );
}

function preserveCorruptCurrentArtifact(
  dataDirectory: string,
  sourcePath: string,
  size: number,
  checksum: string,
  reason: string,
  createdAt: string,
  hooks: RestoreDurabilityHooks,
): CorruptCurrentArtifact {
  const backupRoot = assertNoSymlinkComponents(join(dataDirectory, "backups"), "恢复工件目录");
  ensurePrivateDirectorySync(backupRoot);
  assertNoSymlinkComponents(backupRoot, "恢复工件目录");
  const destination = assertNoSymlinkComponents(
    corruptArtifactDestination(dataDirectory, createdAt),
    "恢复工件",
  );
  const staging = `${destination}.partial-${randomUUID()}`;
  ensurePrivateDirectorySync(staging);
  const databaseDestination = join(staging, "taskboard.sqlite");
  const metadataDestination = join(staging, "artifact.json");
  try {
    copyFileSync(sourcePath, databaseDestination);
    ensurePrivateFileSync(databaseDestination);
    if (statSync(databaseDestination).size !== size || sha256(databaseDestination) !== checksum) {
      throw new Error("损坏数据库工件校验失败");
    }
    writeFileSync(
      metadataDestination,
      `${JSON.stringify({
        artifactVersion: 1,
        databasePath: "taskboard.sqlite",
        size,
        sha256: checksum,
        createdAt,
        reason,
      })}\n`,
      { mode: 0o600 },
    );
    ensurePrivateFileSync(metadataDestination);
    const synchronize = hooks.syncPath ?? syncDurablePath;
    syncDurableTree(staging, synchronize);
    (hooks.renamePath ?? renameSync)(staging, destination);
    synchronize(destination);
    synchronize(backupRoot);
    return { path: destination, size, sha256: checksum };
  } catch (error: unknown) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function verifyPayload(directory: string, manifest: BackupManifest): void {
  const databasePath = join(directory, manifest.database.path);
  if (!existsSync(databasePath)) throw new Error("数据库备份不存在");
  const databaseStat = lstatSync(databasePath);
  if (databaseStat.isSymbolicLink() || !databaseStat.isFile()) {
    throw new Error("数据库备份必须是不含符号链接的普通文件");
  }
  if (
    databaseStat.size !== manifest.database.size ||
    sha256(databasePath) !== manifest.database.sha256
  ) {
    throw new Error("数据库备份校验失败");
  }
  const inspectionDirectory = mkdtempSync(join(tmpdir(), "codexboard-verify-"));
  ensurePrivateDirectorySync(inspectionDirectory);
  const inspectionPath = join(inspectionDirectory, "taskboard.sqlite");
  let database: Database.Database | undefined;
  try {
    copyFileSync(databasePath, inspectionPath);
    ensurePrivateFileSync(inspectionPath);
    database = new Database(inspectionPath, { readonly: true, fileMustExist: true });
    const integrity = database.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error("SQLite 完整性校验失败");
    if (currentSchemaVersion(database) !== manifest.schemaVersion) {
      throw new Error("备份清单与数据库 schema version 不一致");
    }
    const pending = pendingMigrationVersions(database, CORE_MIGRATIONS);
    const applied = database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .pluck()
      .all() as number[];
    const expectedApplied = CORE_MIGRATIONS.filter(
      (migration) => migration.version <= manifest.schemaVersion,
    ).map((migration) => migration.version);
    const expectedPending = CORE_MIGRATIONS.filter(
      (migration) => migration.version > manifest.schemaVersion,
    ).map((migration) => migration.version);
    if (
      expectedApplied.at(-1) !== manifest.schemaVersion ||
      JSON.stringify(applied) !== JSON.stringify(expectedApplied) ||
      JSON.stringify(pending) !== JSON.stringify(expectedPending)
    ) {
      throw new Error("备份数据库迁移版本不是当前程序支持的完整前缀");
    }

    const hasSnapshotAttachments = database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'job_attachment_snapshots'",
      )
      .get();
    const databaseAttachments = database
      .prepare(
        `SELECT storage_key AS path, size_bytes AS size, sha256
        FROM attachments ${hasSnapshotAttachments ? "UNION SELECT storage_key AS path, size_bytes AS size, sha256 FROM job_attachment_snapshots" : ""} ORDER BY path`,
      )
      .all() as BackupManifest["attachments"];
    if (JSON.stringify(databaseAttachments) !== JSON.stringify(manifest.attachments)) {
      throw new Error("附件清单与数据库元数据不一致");
    }
  } finally {
    if (database?.open) database.close();
    rmSync(inspectionDirectory, { recursive: true, force: true });
  }
  const attachmentRoot = join(directory, "attachments");
  for (const attachment of manifest.attachments) {
    const path = resolve(attachmentRoot, ...attachment.path.split("/"));
    if (!path.startsWith(`${attachmentRoot}${sep}`)) throw new Error("附件路径无效");
    if (
      !existsSync(path) ||
      lstatSync(path).isSymbolicLink() ||
      statSync(path).size !== attachment.size ||
      sha256(path) !== attachment.sha256
    ) {
      throw new Error(`附件校验失败：${attachment.path}`);
    }
  }
  const actualPaths = listFiles(attachmentRoot).map((path) =>
    safeRelativePath(attachmentRoot, path),
  );
  if (actualPaths.join("\n") !== manifest.attachments.map((item) => item.path).join("\n")) {
    throw new Error("附件清单与备份内容不一致");
  }
}

export class BackupService {
  readonly #database: SqliteDatabase;
  readonly #dataDirectory: string;
  readonly #now: () => Date;
  readonly #durabilityHooks: RestoreDurabilityHooks;

  constructor(options: BackupServiceOptions) {
    this.#database = options.database;
    const dataDirectory = assertNoSymlinkComponents(resolve(options.dataDirectory), "数据根目录");
    ensurePrivateDirectorySync(dataDirectory);
    this.#dataDirectory = assertNoSymlinkComponents(dataDirectory, "数据根目录");
    const dataStat = lstatSync(this.#dataDirectory);
    if (dataStat.isSymbolicLink() || !dataStat.isDirectory()) {
      throw new Error("数据根目录必须是不含符号链接的目录");
    }
    this.#now = options.now ?? (() => new Date());
    this.#durabilityHooks = options.durabilityHooks ?? {};
  }

  automaticDestination(label = "backup"): string {
    const timestamp = this.#now().toISOString().replaceAll(/[:.]/g, "-");
    return join(
      this.#dataDirectory,
      "backups",
      `${label}-${timestamp}-${randomUUID().slice(0, 8)}`,
    );
  }

  async create(destination = this.automaticDestination()): Promise<BackupManifest> {
    assertNoInterruptedRestore(this.#dataDirectory);
    const resolvedDestination = assertNoSymlinkComponents(resolve(destination), "备份目标");
    const destinationParent = dirname(resolvedDestination);
    const sourceAttachments = join(this.#dataDirectory, "attachments");
    if (isInsideOrEqual(sourceAttachments, resolvedDestination)) {
      throw new Error("备份目标不能位于附件目录内");
    }
    if (existsSync(resolvedDestination)) throw new Error("备份目标已存在");
    assertNoSymlinkComponents(destinationParent, "备份目标父目录");
    // The user can choose an existing shared backup parent. Keep its ACL;
    // only the application-owned staging tree below it must be private.
    mkdirSync(destinationParent, { recursive: true, mode: 0o700 });
    assertNoSymlinkComponents(destinationParent, "备份目标父目录");
    const staging = `${resolvedDestination}.partial-${randomUUID()}`;
    ensurePrivateDirectorySync(staging);
    let published = false;
    try {
      const databasePath = join(staging, "taskboard.sqlite");
      await this.#database.backup(databasePath);
      ensurePrivateFileSync(databasePath);
      const backupAttachments = join(staging, "attachments");
      copyAttachmentTree(sourceAttachments, backupAttachments);
      const manifest = BackupManifestSchema.parse({
        manifestVersion: 1,
        createdAt: this.#now().toISOString(),
        schemaVersion: currentSchemaVersion(this.#database),
        database: {
          path: "taskboard.sqlite",
          size: statSync(databasePath).size,
          sha256: sha256(databasePath),
        },
        attachments: listFiles(backupAttachments).map((path) => ({
          path: safeRelativePath(backupAttachments, path),
          size: statSync(path).size,
          sha256: sha256(path),
        })),
      });
      const manifestPath = join(staging, "manifest.json");
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      ensurePrivateFileSync(manifestPath);
      verifyPayload(staging, manifest);
      const synchronize = this.#durabilityHooks.syncPath ?? syncDurablePath;
      syncDurableTree(staging, synchronize);
      (this.#durabilityHooks.renamePath ?? renameSync)(staging, resolvedDestination);
      published = true;
      synchronize(resolvedDestination);
      synchronize(destinationParent);
      return manifest;
    } catch (error: unknown) {
      rmSync(published ? resolvedDestination : staging, { recursive: true, force: true });
      throw error;
    }
  }

  static verify(directory: string): BackupManifest {
    const resolvedDirectory = assertNoSymlinkComponents(resolve(directory), "备份目录");
    const manifest = readManifest(resolvedDirectory);
    verifyPayload(resolvedDirectory, manifest);
    return manifest;
  }

  static async restore(
    sourceDirectory: string,
    dataDirectory: string,
    durabilityHooks: RestoreDurabilityHooks = {},
  ): Promise<RestoreResult> {
    const resolvedDataDirectory = assertNoSymlinkComponents(resolve(dataDirectory), "恢复目标");
    const resolvedSource = assertNoSymlinkComponents(resolve(sourceDirectory), "恢复源");
    const lock = acquireDataDirectoryLock(resolvedDataDirectory, "restore");
    try {
      return await BackupService.#restoreLocked(
        resolvedSource,
        resolvedDataDirectory,
        durabilityHooks,
      );
    } finally {
      lock.release();
    }
  }

  static async #restoreLocked(
    resolvedSource: string,
    resolvedDataDirectory: string,
    durabilityHooks: RestoreDurabilityHooks,
  ): Promise<RestoreResult> {
    recoverInterruptedRestore(resolvedDataDirectory, durabilityHooks);
    const dataStat = lstatSync(resolvedDataDirectory);
    if (dataStat.isSymbolicLink() || !dataStat.isDirectory()) {
      throw new Error("恢复目标必须是不含符号链接的数据目录");
    }
    const manifest = BackupService.verify(resolvedSource);
    assertOffline(resolvedDataDirectory);

    const currentDatabasePath = join(resolvedDataDirectory, "taskboard.sqlite");
    if (!existsSync(currentDatabasePath)) throw new Error("当前数据库不存在，拒绝覆盖恢复");
    const currentDatabaseStat = lstatSync(currentDatabasePath);
    if (currentDatabaseStat.isSymbolicLink() || !currentDatabaseStat.isFile()) {
      throw new Error("当前数据库必须是不含符号链接的普通文件");
    }
    const currentAttachments = join(resolvedDataDirectory, "attachments");
    if (isInsideOrEqual(currentAttachments, resolvedSource)) {
      throw new Error("恢复源不能位于当前附件目录内");
    }
    if (existsSync(currentAttachments)) {
      const attachmentStat = lstatSync(currentAttachments);
      if (attachmentStat.isSymbolicLink() || !attachmentStat.isDirectory()) {
        throw new Error("当前附件根目录必须是不含符号链接的目录");
      }
    }
    const safetyAttempt = await tryCreateSafetyBackup(currentDatabasePath, resolvedDataDirectory);
    const safetyBackup = safetyAttempt.safetyBackup;
    const createdAt = new Date().toISOString();
    const corruptCurrentArtifact =
      safetyAttempt.corruptionReason === null
        ? null
        : preserveCorruptCurrentArtifact(
            resolvedDataDirectory,
            currentDatabasePath,
            currentDatabaseStat.size,
            sha256(currentDatabasePath),
            safetyAttempt.corruptionReason,
            createdAt,
            durabilityHooks,
          );

    const stagingName = `.restore-${randomUUID()}`;
    const rollbackName = `.restore-rollback-${randomUUID()}`;
    const staging = join(resolvedDataDirectory, stagingName);
    const rollback = join(resolvedDataDirectory, rollbackName);
    const restoreJournal: RestoreJournal = {
      version: 1,
      rollbackName,
      stagingName,
      hadAttachments: existsSync(currentAttachments),
      phase: "prepared",
      createdAt,
    };
    writeRestoreJournal(resolvedDataDirectory, restoreJournal);
    try {
      ensurePrivateDirectorySync(staging);
      ensurePrivateDirectorySync(rollback);
      copyFileSync(join(resolvedSource, "taskboard.sqlite"), join(staging, "taskboard.sqlite"));
      ensurePrivateFileSync(join(staging, "taskboard.sqlite"));
      copyAttachmentTree(join(resolvedSource, "attachments"), join(staging, "attachments"));
      const move = durabilityHooks.renamePath ?? renameSync;
      move(currentDatabasePath, join(rollback, "taskboard.sqlite"));
      removeDatabaseSidecars(currentDatabasePath);
      if (existsSync(currentAttachments)) {
        move(currentAttachments, join(rollback, "attachments"));
      }
      makeRestoreRollbackDurable(resolvedDataDirectory, restoreJournal, durabilityHooks);
      move(join(staging, "taskboard.sqlite"), currentDatabasePath);
      move(join(staging, "attachments"), currentAttachments);
      ensurePrivateFileSync(currentDatabasePath);
      ensurePrivateDirectorySync(currentAttachments);
      verifyPayload(resolvedDataDirectory, manifest);
      finalizeRestoreJournal(resolvedDataDirectory, durabilityHooks);
    } catch (error: unknown) {
      recoverInterruptedRestore(resolvedDataDirectory, durabilityHooks);
      throw error;
    }
    return { restoredFrom: resolvedSource, safetyBackup, corruptCurrentArtifact };
  }
}
