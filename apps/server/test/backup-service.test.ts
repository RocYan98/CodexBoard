import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CORE_MIGRATIONS,
  initializeDatabase,
  type SqliteDatabase,
} from "../src/modules/database/index.js";
import {
  acquireDataDirectoryLock,
  BackupService,
  finalizeRestoreJournal,
  recoverInterruptedRestore,
  writeRestoreJournal,
} from "../src/modules/operations/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = realpathSync.native(
    mkdtempSync(
      join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "codexboard-backup-"),
    ),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function seedAttachment(database: SqliteDatabase, storageKey: string, content: string): void {
  database
    .prepare(
      "INSERT OR IGNORE INTO identities (identity_key, kind, tenant_key, user_id, name, role) VALUES (?, 'feishu', ?, ?, ?, ?)",
    )
    .run(JSON.stringify(["feishu", "tenant", "open-1"]), "tenant", "open-1", "备份用户", "admin");
  database
    .prepare(
      "INSERT OR IGNORE INTO projects (id, project_key, name, created_by_identity_key) VALUES (?, ?, ?, ?)",
    )
    .run("project-1", "BACKUP", "备份项目", JSON.stringify(["feishu", "tenant", "open-1"]));
  database
    .prepare(
      `INSERT OR IGNORE INTO tasks (
        id, identifier, project_id, task_number, title, status, creator_identity_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "task-1",
      "BACKUP-1",
      "project-1",
      1,
      "备份任务",
      "todo",
      JSON.stringify(["feishu", "tenant", "open-1"]),
    );
  database
    .prepare(
      `INSERT INTO attachments (
        id, task_id, uploader_identity_key, filename, content_type, size_bytes, sha256, storage_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `attachment-${storageKey}`,
      "task-1",
      JSON.stringify(["feishu", "tenant", "open-1"]),
      storageKey.split("/").at(-1),
      "application/octet-stream",
      Buffer.byteLength(content),
      createHash("sha256").update(content).digest("hex"),
      storageKey,
    );
}

describe("BackupService", () => {
  it("creates and verifies a consistent SQLite snapshot with an attachment manifest", async () => {
    const dataDirectory = temporaryDirectory();
    const databasePath = join(dataDirectory, "taskboard.sqlite");
    const attachmentDirectory = join(dataDirectory, "attachments", "aa");
    mkdirSync(attachmentDirectory, { recursive: true });
    writeFileSync(join(attachmentDirectory, "file.bin"), "original attachment");
    const database = initializeDatabase(databasePath);
    seedAttachment(database, "aa/file.bin", "original attachment");
    const service = new BackupService({
      database,
      dataDirectory,
      now: () => new Date("2026-08-31T09:00:00.000Z"),
    });
    const destination = join(dataDirectory, "backups", "manual-20260831");

    const manifest = await service.create(destination);
    const verified = BackupService.verify(destination);

    expect(verified).toEqual(manifest);
    expect(manifest.schemaVersion).toBe(CORE_MIGRATIONS.at(-1)!.version);
    expect(manifest.attachments).toEqual([
      expect.objectContaining({ path: "aa/file.bin", size: 19 }),
    ]);
    expect(() => readFileSync(join(destination, "taskboard.sqlite-wal"))).toThrow();
    expect(() => readFileSync(join(destination, "taskboard.sqlite-shm"))).toThrow();

    writeFileSync(join(destination, "attachments", "aa", "file.bin"), "tampered");
    expect(() => BackupService.verify(destination)).toThrow(/附件校验失败/);
    database.close();
  });

  it("restores only while offline and preserves a pre-restore safety backup", async () => {
    const dataDirectory = temporaryDirectory();
    const databasePath = join(dataDirectory, "taskboard.sqlite");
    mkdirSync(join(dataDirectory, "attachments"), { recursive: true });
    writeFileSync(join(dataDirectory, "attachments", "original.txt"), "original");
    let database = initializeDatabase(databasePath);
    seedAttachment(database, "original.txt", "original");
    database
      .prepare("UPDATE identities SET name = ? WHERE identity_key = ?")
      .run("原始用户", JSON.stringify(["feishu", "tenant", "open-1"]));
    const backupDirectory = join(dataDirectory, "backups", "restore-source");
    await new BackupService({ database, dataDirectory }).create(backupDirectory);
    database
      .prepare("UPDATE identities SET name = ? WHERE identity_key = ?")
      .run("被修改用户", JSON.stringify(["feishu", "tenant", "open-1"]));
    writeFileSync(join(dataDirectory, "attachments", "original.txt"), "changed");
    database
      .prepare("UPDATE attachments SET size_bytes = ?, sha256 = ? WHERE storage_key = ?")
      .run(
        Buffer.byteLength("changed"),
        createHash("sha256").update("changed").digest("hex"),
        "original.txt",
      );
    database.close();

    mkdirSync(join(dataDirectory, "run"), { recursive: true });
    writeFileSync(join(dataDirectory, "run", "runtime.json"), JSON.stringify({ pid: process.pid }));
    await expect(BackupService.restore(backupDirectory, dataDirectory)).rejects.toThrow(
      /服务仍在运行/,
    );
    rmSync(join(dataDirectory, "run", "runtime.json"));

    const result = await BackupService.restore(backupDirectory, dataDirectory);
    database = initializeDatabase(databasePath);
    expect(
      database
        .prepare("SELECT name FROM identities WHERE identity_key = ?")
        .pluck()
        .get(JSON.stringify(["feishu", "tenant", "open-1"])),
    ).toBe("原始用户");
    expect(readFileSync(join(dataDirectory, "attachments", "original.txt"), "utf8")).toBe(
      "original",
    );
    expect(result.safetyBackup).toBeTypeOf("string");
    if (!result.safetyBackup) throw new Error("缺少恢复前安全备份");
    expect(BackupService.verify(result.safetyBackup).attachments).toEqual([
      expect.objectContaining({ path: "original.txt" }),
    ]);
    database.close();
  });

  it("restores from a verified backup when the current database is zero-byte and quarantines it", async () => {
    const dataDirectory = temporaryDirectory();
    const databasePath = join(dataDirectory, "taskboard.sqlite");
    const database = initializeDatabase(databasePath);
    database
      .prepare(
        "INSERT INTO identities (identity_key, kind, tenant_key, user_id, name, role) VALUES (?, 'feishu', ?, ?, ?, ?)",
      )
      .run(
        JSON.stringify(["feishu", "tenant", "restore-corrupt-open"]),
        "tenant",
        "restore-corrupt-open",
        "源数据库",
        "admin",
      );
    const source = join(dataDirectory, "backups", "verified-source");
    await new BackupService({ database, dataDirectory }).create(source);
    database.close();

    const corruptBytes = Buffer.alloc(0);
    writeFileSync(databasePath, corruptBytes);
    const corruptSha256 = createHash("sha256").update(corruptBytes).digest("hex");

    const result = await BackupService.restore(source, dataDirectory);

    expect(result.safetyBackup).toBeNull();
    expect(result.corruptCurrentArtifact).toEqual({
      path: expect.any(String),
      size: 0,
      sha256: corruptSha256,
    });
    const artifactPath = result.corruptCurrentArtifact?.path;
    expect(artifactPath).toBeDefined();
    expect(readFileSync(join(artifactPath as string, "taskboard.sqlite"))).toEqual(corruptBytes);
    expect(JSON.parse(readFileSync(join(artifactPath as string, "artifact.json"), "utf8"))).toEqual(
      expect.objectContaining({
        size: 0,
        sha256: corruptSha256,
        createdAt: expect.any(String),
        reason: expect.any(String),
      }),
    );

    const restored = initializeDatabase(databasePath);
    expect(
      restored
        .prepare("SELECT name FROM identities WHERE identity_key = ?")
        .pluck()
        .get(JSON.stringify(["feishu", "tenant", "restore-corrupt-open"])),
    ).toBe("源数据库");
    restored.close();
  });

  it("rejects a manifest that redirects the database file outside the backup", async () => {
    const dataDirectory = temporaryDirectory();
    const database = initializeDatabase(join(dataDirectory, "taskboard.sqlite"));
    const backupDirectory = join(dataDirectory, "backups", "redirect-source");
    await new BackupService({ database, dataDirectory }).create(backupDirectory);
    database.close();
    const manifestPath = join(backupDirectory, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      database: { path: string };
    };
    copyFileSync(
      join(backupDirectory, "taskboard.sqlite"),
      join(dataDirectory, "backups", "outside.sqlite"),
    );
    manifest.database.path = "../outside.sqlite";
    writeFileSync(manifestPath, JSON.stringify(manifest));

    expect(() => BackupService.verify(backupDirectory)).toThrow();
  });

  it("rejects restore while the data directory lock is held even without a runtime descriptor", async () => {
    const dataDirectory = temporaryDirectory();
    const database = initializeDatabase(join(dataDirectory, "taskboard.sqlite"));
    const backupDirectory = join(dataDirectory, "backups", "locked-source");
    await new BackupService({ database, dataDirectory }).create(backupDirectory);
    database.close();
    const lock = acquireDataDirectoryLock(dataDirectory, "test-server");
    try {
      await expect(BackupService.restore(backupDirectory, dataDirectory)).rejects.toThrow(
        /数据目录正在使用/,
      );
    } finally {
      lock.release();
    }
  });

  it("creates the missing data root safely and rejects backup destinations under attachments", async () => {
    const root = temporaryDirectory();
    const dataDirectory = join(root, "missing-data");
    const database = initializeDatabase(":memory:");
    const service = new BackupService({ database, dataDirectory });

    await expect(
      service.create(join(dataDirectory, "attachments", "nested-backup")),
    ).rejects.toThrow(/附件目录/);
    database.close();
  });

  it("does not publish a backup when attachment files and database metadata disagree", async () => {
    const dataDirectory = temporaryDirectory();
    const attachmentDirectory = join(dataDirectory, "attachments");
    mkdirSync(attachmentDirectory, { recursive: true });
    writeFileSync(join(attachmentDirectory, "orphan.bin"), "orphan");
    const database = initializeDatabase(join(dataDirectory, "taskboard.sqlite"));
    const destination = join(dataDirectory, "backups", "inconsistent");

    await expect(
      new BackupService({ database, dataDirectory }).create(destination),
    ).rejects.toThrow(/附件清单/);
    expect(() => readFileSync(join(destination, "manifest.json"))).toThrow();
    database.close();
  });

  it("rolls an interrupted destructive restore back before the database can be reopened", () => {
    const dataDirectory = temporaryDirectory();
    const databasePath = join(dataDirectory, "taskboard.sqlite");
    let database = initializeDatabase(databasePath);
    database
      .prepare(
        "INSERT INTO identities (identity_key, kind, tenant_key, user_id, name, role) VALUES (?, 'feishu', ?, ?, ?, ?)",
      )
      .run(
        JSON.stringify(["feishu", "tenant", "restore-open"]),
        "tenant",
        "restore-open",
        "崩溃前数据",
        "admin",
      );
    database.close();
    const rollbackName = ".restore-rollback-00000000-0000-4000-8000-000000000001";
    const stagingName = ".restore-00000000-0000-4000-8000-000000000002";
    mkdirSync(join(dataDirectory, rollbackName));
    mkdirSync(join(dataDirectory, stagingName));
    writeRestoreJournal(dataDirectory, {
      version: 1,
      rollbackName,
      stagingName,
      hadAttachments: false,
      phase: "prepared",
      createdAt: "2026-08-31T10:00:00.000Z",
    });
    renameSync(databasePath, join(dataDirectory, rollbackName, "taskboard.sqlite"));
    database = initializeDatabase(databasePath);
    database.close();

    expect(recoverInterruptedRestore(dataDirectory)).toBe(true);
    database = initializeDatabase(databasePath);
    expect(
      database
        .prepare("SELECT name FROM identities WHERE identity_key = ?")
        .pluck()
        .get(JSON.stringify(["feishu", "tenant", "restore-open"])),
    ).toBe("崩溃前数据");
    database.close();
    expect(existsSync(join(dataDirectory, "run", "restore.json"))).toBe(false);
    expect(existsSync(join(dataDirectory, rollbackName))).toBe(false);
  });

  it("ignores an unpublished lock candidate left by a crash", () => {
    const dataDirectory = temporaryDirectory();
    mkdirSync(join(dataDirectory, "run"), { recursive: true });
    writeFileSync(join(dataDirectory, "run", ".data-lock-orphan.tmp"), "partial");

    const lock = acquireDataDirectoryLock(dataDirectory, "test-after-crash");
    lock.release();
  });

  it("serializes every owner with a kernel-released SQLite transaction lock", () => {
    const dataDirectory = temporaryDirectory();
    const first = acquireDataDirectoryLock(dataDirectory, "first-owner");
    expect(first.path).toBe(join(dataDirectory, "run", "data-lock.sqlite"));
    expect(() => acquireDataDirectoryLock(dataDirectory, "second-owner")).toThrow(
      /数据目录正在使用/,
    );

    first.release();
    const second = acquireDataDirectoryLock(dataDirectory, "second-owner");
    second.release();
  });

  it("refuses an ambiguous legacy lock instead of racing to unlink it", () => {
    const dataDirectory = temporaryDirectory();
    mkdirSync(join(dataDirectory, "run"), { recursive: true });
    writeFileSync(
      join(dataDirectory, "run", "data.lock"),
      `${JSON.stringify({
        pid: 2_147_483_647,
        token: "00000000-0000-4000-8000-000000000099",
        purpose: "stale-owner",
        acquiredAt: "2026-08-31T00:00:00.000Z",
      })}\n`,
    );

    expect(() => acquireDataDirectoryLock(dataDirectory, "new-owner")).toThrow(/旧版数据目录锁/);
  });

  it("finishes an idempotent second rollback after attachments were already restored", () => {
    const dataDirectory = temporaryDirectory();
    const databasePath = join(dataDirectory, "taskboard.sqlite");
    let database = initializeDatabase(databasePath);
    database
      .prepare(
        "INSERT INTO identities (identity_key, kind, tenant_key, user_id, name, role) VALUES (?, 'feishu', ?, ?, ?, ?)",
      )
      .run(
        JSON.stringify(["feishu", "tenant", "old-open"]),
        "tenant",
        "old-open",
        "旧数据库",
        "admin",
      );
    database.close();
    const rollbackName = ".restore-rollback-00000000-0000-4000-8000-000000000003";
    const stagingName = ".restore-00000000-0000-4000-8000-000000000004";
    mkdirSync(join(dataDirectory, rollbackName));
    mkdirSync(join(dataDirectory, stagingName));
    renameSync(databasePath, join(dataDirectory, rollbackName, "taskboard.sqlite"));
    database = initializeDatabase(databasePath);
    database.close();
    mkdirSync(join(dataDirectory, "attachments"));
    writeFileSync(join(dataDirectory, "attachments", "old.txt"), "old attachment");
    writeRestoreJournal(dataDirectory, {
      version: 1,
      rollbackName,
      stagingName,
      hadAttachments: true,
      phase: "rolling_back",
      createdAt: "2026-08-31T10:00:00.000Z",
    });

    expect(recoverInterruptedRestore(dataDirectory)).toBe(true);
    database = initializeDatabase(databasePath);
    expect(
      database
        .prepare("SELECT name FROM identities WHERE identity_key = ?")
        .pluck()
        .get(JSON.stringify(["feishu", "tenant", "old-open"])),
    ).toBe("旧数据库");
    database.close();
    expect(readFileSync(join(dataDirectory, "attachments", "old.txt"), "utf8")).toBe(
      "old attachment",
    );
    expect(recoverInterruptedRestore(dataDirectory)).toBe(false);
  });

  it("fsyncs the restored live payload and root before marking the restore committed", () => {
    const dataDirectory = temporaryDirectory();
    const rollbackName = ".restore-rollback-00000000-0000-4000-8000-000000000005";
    const stagingName = ".restore-00000000-0000-4000-8000-000000000006";
    mkdirSync(join(dataDirectory, "attachments", "nested"), { recursive: true });
    mkdirSync(join(dataDirectory, rollbackName));
    mkdirSync(join(dataDirectory, stagingName));
    writeFileSync(join(dataDirectory, "taskboard.sqlite"), "restored database");
    writeFileSync(join(dataDirectory, "attachments", "nested", "file.bin"), "restored attachment");
    writeRestoreJournal(dataDirectory, {
      version: 1,
      rollbackName,
      stagingName,
      hadAttachments: false,
      phase: "prepared",
      createdAt: "2026-08-31T10:00:00.000Z",
    });
    const events: string[] = [];

    finalizeRestoreJournal(dataDirectory, {
      syncPath: (path) =>
        events.push(`sync:${path.slice(dataDirectory.length).replaceAll("\\", "/") || "/"}`),
      markCommitted: () => events.push("committed"),
    });

    const committedAt = events.indexOf("committed");
    expect(committedAt).toBeGreaterThan(0);
    for (const required of [
      "sync:/taskboard.sqlite",
      "sync:/attachments/nested/file.bin",
      "sync:/attachments/nested",
      "sync:/attachments",
      "sync:/",
    ]) {
      expect(events.indexOf(required)).toBeGreaterThanOrEqual(0);
      expect(events.indexOf(required)).toBeLessThan(committedAt);
    }
  });

  it("makes the old rollback payload durable before installing the staged live payload", async () => {
    const dataDirectory = temporaryDirectory();
    const databasePath = join(dataDirectory, "taskboard.sqlite");
    mkdirSync(join(dataDirectory, "attachments"));
    writeFileSync(join(dataDirectory, "attachments", "old.txt"), "old");
    const database = initializeDatabase(databasePath);
    seedAttachment(database, "old.txt", "old");
    const source = join(dataDirectory, "backups", "source");
    await new BackupService({ database, dataDirectory }).create(source);
    database.close();
    const events: string[] = [];

    await BackupService.restore(source, dataDirectory, {
      renamePath: (from, to) => {
        events.push(
          `rename:${from.slice(dataDirectory.length).replaceAll("\\", "/")}->${to.slice(dataDirectory.length).replaceAll("\\", "/")}`,
        );
        renameSync(from, to);
      },
      syncPath: (path) =>
        events.push(`sync:${path.slice(dataDirectory.length).replaceAll("\\", "/") || "/"}`),
    });

    const rollbackDatabaseRename = events.findIndex(
      (event) =>
        event.startsWith("rename:/taskboard.sqlite->/.restore-rollback-") &&
        event.endsWith("/taskboard.sqlite"),
    );
    const rollbackRootSync = events.findIndex(
      (event, index) => index > rollbackDatabaseRename && event === "sync:/",
    );
    const installDatabaseRename = events.findIndex(
      (event) => event.startsWith("rename:/.restore-") && event.endsWith("->/taskboard.sqlite"),
    );
    expect(rollbackDatabaseRename).toBeGreaterThanOrEqual(0);
    expect(
      events.some((event) => /^sync:\/.restore-rollback-.*\/taskboard\.sqlite$/.test(event)),
    ).toBe(true);
    expect(rollbackRootSync).toBeGreaterThan(rollbackDatabaseRename);
    expect(installDatabaseRename).toBeGreaterThan(rollbackRootSync);
  });

  it("fsyncs a recovered live payload before deleting rollback evidence", () => {
    const dataDirectory = temporaryDirectory();
    const rollbackName = ".restore-rollback-00000000-0000-4000-8000-000000000007";
    const stagingName = ".restore-00000000-0000-4000-8000-000000000008";
    mkdirSync(join(dataDirectory, rollbackName, "attachments"), { recursive: true });
    mkdirSync(join(dataDirectory, stagingName));
    writeFileSync(join(dataDirectory, rollbackName, "taskboard.sqlite"), "old database");
    writeFileSync(join(dataDirectory, rollbackName, "attachments", "old.txt"), "old attachment");
    writeFileSync(join(dataDirectory, "taskboard.sqlite"), "new database");
    mkdirSync(join(dataDirectory, "attachments"));
    writeFileSync(join(dataDirectory, "attachments", "new.txt"), "new attachment");
    writeRestoreJournal(dataDirectory, {
      version: 1,
      rollbackName,
      stagingName,
      hadAttachments: true,
      phase: "rolling_back",
      createdAt: "2026-08-31T10:00:00.000Z",
    });
    const events: string[] = [];

    recoverInterruptedRestore(dataDirectory, {
      syncPath: (path) =>
        events.push(`sync:${path.slice(dataDirectory.length).replaceAll("\\", "/") || "/"}`),
      beforeCleanup: () => events.push("cleanup"),
    });

    const cleanupAt = events.indexOf("cleanup");
    expect(cleanupAt).toBeGreaterThan(0);
    for (const required of [
      "sync:/taskboard.sqlite",
      "sync:/attachments/old.txt",
      "sync:/attachments",
      "sync:/",
    ]) {
      expect(events.indexOf(required)).toBeGreaterThanOrEqual(0);
      expect(events.indexOf(required)).toBeLessThan(cleanupAt);
    }
  });

  it("rejects a data directory whose ancestor is a symbolic link", () => {
    const root = temporaryDirectory();
    const target = join(root, "target");
    mkdirSync(target);
    symlinkSync(target, join(root, "linked-parent"));
    const database = initializeDatabase(":memory:");
    try {
      expect(
        () =>
          new BackupService({
            database,
            dataDirectory: join(root, "linked-parent", "data"),
          }),
      ).toThrow(/符号链接/);
    } finally {
      database.close();
    }
  });

  it.runIf(process.platform === "darwin")(
    "canonicalizes the macOS tmp alias before enforcing attachment containment",
    async () => {
      const dataDirectory = temporaryDirectory();
      const database = initializeDatabase(join(dataDirectory, "taskboard.sqlite"));
      const service = new BackupService({ database, dataDirectory });
      const aliasDestination = join(
        "/tmp",
        dataDirectory.slice("/private/tmp/".length),
        "attachments",
        "alias-backup",
      );
      try {
        await expect(service.create(aliasDestination)).rejects.toThrow(/附件目录/);
      } finally {
        database.close();
      }
    },
  );

  it("always removes the private inspection copy when SQLite validation fails", async () => {
    const dataDirectory = temporaryDirectory();
    const database = initializeDatabase(join(dataDirectory, "taskboard.sqlite"));
    const backupDirectory = join(dataDirectory, "backups", "corrupt");
    await new BackupService({ database, dataDirectory }).create(backupDirectory);
    database.close();
    const inspectionRoot = join(dataDirectory, "inspection");
    mkdirSync(inspectionRoot);
    const backupDatabase = join(backupDirectory, "taskboard.sqlite");
    writeFileSync(backupDatabase, "not a sqlite database");
    const manifestPath = join(backupDirectory, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.database.size = Buffer.byteLength("not a sqlite database");
    manifest.database.sha256 = createHash("sha256").update("not a sqlite database").digest("hex");
    writeFileSync(manifestPath, JSON.stringify(manifest));

    // Other test workers also validate backups. Isolate this synchronous call
    // instead of comparing a shared tmp directory that those workers may clean.
    vi.stubEnv(process.platform === "win32" ? "TEMP" : "TMPDIR", inspectionRoot);
    try {
      expect(() => BackupService.verify(backupDirectory)).toThrow(/file is not a database/);
      expect(readdirSync(inspectionRoot)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
