import { assertPrivateFileSync } from "../../../scripts/private-file-permissions.mjs";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  CORE_MIGRATIONS,
  initializeDatabase,
  MigrationError,
  openDatabase,
  runMigrations,
  withTransaction,
} from "../src/modules/database/index.js";
import { BackupService, runMigrationsWithBackup } from "../src/modules/operations/index.js";

const LEGACY_MIGRATIONS = CORE_MIGRATIONS.filter((migration) => migration.version <= 20);

const openDatabases: Database.Database[] = [];
const temporaryDirectories: string[] = [];

function track(database: Database.Database): Database.Database {
  openDatabases.push(database);
  return database;
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    if (database.open) {
      database.close();
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLite foundation", () => {
  it("adds a credential generation to existing Web accounts without altering credentials", () => {
    const database = track(openDatabase(":memory:"));
    runMigrations(
      database,
      CORE_MIGRATIONS.filter((migration) => migration.version <= 26),
    );
    database
      .prepare("INSERT INTO web_accounts(id, username, password_hash) VALUES (?, ?, ?)")
      .run("web-account", "alice", "preserved-password-hash");
    runMigrations(database, CORE_MIGRATIONS);
    expect(database.prepare("SELECT * FROM web_accounts WHERE id = ?").get("web-account")).toEqual({
      id: "web-account",
      username: "alice",
      password_hash: "preserved-password-hash",
      failed_attempts: 0,
      locked_until: 0,
      auth_version: 0,
    });
    expect(() => database.exec("UPDATE web_accounts SET auth_version = -1")).toThrow();
    expect(runMigrations(database, CORE_MIGRATIONS)).toEqual([]);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("recovers canceled task states from pre-migration history and defaults missing history", () => {
    const database = track(openDatabase(":memory:"));
    runMigrations(database, CORE_MIGRATIONS.slice(0, 19));
    database.exec(
      "INSERT INTO projects (id, project_key, name) VALUES ('restore', 'RST', 'Restore')",
    );
    const insertTask = database.prepare(
      "INSERT INTO tasks (id, identifier, project_id, task_number, title, status, sort_order) VALUES (?, ?, 'restore', ?, 'Canceled', 'canceled', 42)",
    );
    for (const [index, id] of ["blocked", "review", "missing"].entries()) {
      insertTask.run(id, `RST-${index + 1}`, index + 1);
    }
    const activity = database.prepare(
      "INSERT INTO activities (id, task_id, kind, changes_json, created_at) VALUES (?, ?, 'task.moved', ?, ?)",
    );
    activity.run(
      "a",
      "blocked",
      JSON.stringify({ status: { from: "in_progress", to: "blocked" } }),
      "2026-09-01T00:00:00Z",
    );
    activity.run(
      "b",
      "blocked",
      JSON.stringify({ status: { from: "blocked", to: "canceled" } }),
      "2026-09-02T00:00:00Z",
    );
    activity.run(
      "c",
      "review",
      JSON.stringify({ status: { from: "todo", to: "canceled" } }),
      "2026-09-01T00:00:00Z",
    );
    activity.run(
      "d",
      "review",
      JSON.stringify({ status: { from: "in_review", to: "canceled" } }),
      "2026-09-02T00:00:00Z",
    );
    expect(runMigrations(database, LEGACY_MIGRATIONS)).toEqual([20]);
    expect(
      database
        .prepare(
          "SELECT task_id, status, blocked_from_status, sort_order FROM task_cancellation_states ORDER BY task_id",
        )
        .all(),
    ).toEqual([
      { task_id: "blocked", status: "blocked", blocked_from_status: "in_progress", sort_order: 42 },
      { task_id: "missing", status: "todo", blocked_from_status: null, sort_order: 42 },
      { task_id: "review", status: "in_review", blocked_from_status: null, sort_order: 42 },
    ]);
  });

  it("refuses to open a database path whose final node is a symbolic link", () => {
    const directory = mkdtempSync(join(tmpdir(), "codexboard-db-symlink-"));
    temporaryDirectories.push(directory);
    const outside = join(directory, "outside.sqlite");
    writeFileSync(outside, "do not open");
    const linked = join(directory, "taskboard.sqlite");
    symlinkSync(outside, linked);

    expect(() => openDatabase(linked)).toThrow(/符号链接/);
    expect(readFileSync(outside, "utf8")).toBe("do not open");
  });

  it("applies the core schema with required pragmas", () => {
    const database = track(initializeDatabase(":memory:"));
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .pluck()
      .all() as string[];

    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.pragma("busy_timeout", { simple: true })).toBe(5_000);
    expect(tables).toEqual(
      expect.arrayContaining([
        "identities",
        "attachments",
        "audit_events",
        "change_events",
        "comments",
        "global_labels",
        "job_events",
        "job_interactions",
        "jobs",
        "project_members",
        "project_development_contexts",
        "request_idempotency",
        "projects",
        "schema_migrations",
        "sessions",
        "task_relations",
        "task_delete_authorizations",
        "task_delete_events",
        "task_delete_leases",
        "task_threads",
        "tasks",
      ]),
    );
    expect(database.prepare("SELECT version FROM schema_migrations").pluck().all()).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
      27,
    ]);
    expect(
      Object.fromEntries(
        database
          .prepare("PRAGMA table_info(task_delete_leases)")
          .all()
          .map((column) => {
            const typed = column as { name: string; notnull: number };
            return [typed.name, typed.notnull];
          }),
      ),
    ).toMatchObject({ operation_id: 1, phase: 1, updated_at: 1 });
    expect(
      database
        .prepare("PRAGMA table_info(tasks)")
        .all()
        .map((column) => (column as { name: string }).name),
    ).toContain("links_json");
    expect(
      database
        .prepare("PRAGMA table_info(jobs)")
        .all()
        .map((column) => (column as { name: string }).name),
    ).toEqual(
      expect.arrayContaining([
        "request_hash",
        "work_context_json",
        "recovery_checkpoint_json",
        "target_job_id",
        "cancel_requested_at",
      ]),
    );
  });

  it("upgrades an interrupted Schema 12 deletion lease into a resumable operation", () => {
    const database = track(openDatabase(":memory:"));
    runMigrations(database, CORE_MIGRATIONS.slice(0, 12));
    database
      .prepare(
        `INSERT INTO actors (id, tenant_key, open_id, name, role)
        VALUES (?, 'tenant', 'actor', '删除发起人', 'admin')`,
      )
      .run("00000000-0000-4000-8000-000000000001");
    database
      .prepare("INSERT INTO projects (id, project_key, name) VALUES (?, 'REC', '恢复测试')")
      .run("10000000-0000-4000-8000-000000000001");
    database
      .prepare(
        `INSERT INTO tasks (id, identifier, project_id, task_number, title, status)
        VALUES (?, 'REC-1', ?, 1, '中断删除', 'canceled')`,
      )
      .run("20000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000001");
    database
      .prepare(
        `INSERT INTO task_delete_leases (
          task_id, lease_token, actor_id, expected_version, snapshot_json, created_at
        ) VALUES (?, ?, ?, 1, ?, '2026-09-04T12:00:00.000Z')`,
      )
      .run(
        "20000000-0000-4000-8000-000000000001",
        "30000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000001",
        JSON.stringify({ attachmentStorageKeys: [], threadIds: [], resourceIds: [] }),
      );

    expect(runMigrations(database, LEGACY_MIGRATIONS)).toEqual([13, 14, 15, 16, 17, 18, 19, 20]);
    expect(
      database
        .prepare(
          `SELECT operation_id AS operationId, phase, updated_at AS updatedAt
          FROM task_delete_leases`,
        )
        .get(),
    ).toEqual({
      operationId: "30000000-0000-4000-8000-000000000001",
      phase: "archiving",
      updatedAt: "2026-09-04T12:00:00.000Z",
    });
    database
      .prepare(
        `INSERT INTO task_delete_events (
          id, operation_id, task_id, actor_id, event_type, created_at
        ) VALUES (?, ?, ?, ?, 'resumed', '2026-09-04T12:01:00.000Z')`,
      )
      .run(
        "40000000-0000-4000-8000-000000000001",
        "30000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000001",
      );
    expect(() =>
      database
        .prepare("UPDATE task_delete_events SET event_type = 'completed' WHERE id = ?")
        .run("40000000-0000-4000-8000-000000000001"),
    ).toThrow(/append-only/);
    expect(() =>
      database
        .prepare("DELETE FROM task_delete_events WHERE id = ?")
        .run("40000000-0000-4000-8000-000000000001"),
    ).toThrow(/append-only/);
  });

  it("backfills blocked task origins and enforces the status invariant in Schema 10", () => {
    const database = track(openDatabase(":memory:"));
    runMigrations(database, CORE_MIGRATIONS.slice(0, 9));
    database
      .prepare("INSERT INTO projects (id, project_key, name) VALUES (?, ?, ?)")
      .run("project-1", "LOCAL", "本地项目");
    const insertTask = database.prepare(
      `INSERT INTO tasks (id, identifier, project_id, task_number, title, status)
      VALUES (?, ?, 'project-1', ?, ?, ?)`,
    );
    insertTask.run("blocked-with-history", "LOCAL-1", 1, "有历史", "blocked");
    insertTask.run("blocked-without-history", "LOCAL-2", 2, "无历史", "blocked");
    insertTask.run("active-task", "LOCAL-3", 3, "活动任务", "todo");
    database
      .prepare(
        `INSERT INTO activities (id, task_id, kind, changes_json, created_at)
        VALUES (?, ?, 'task.moved', ?, ?)`,
      )
      .run(
        "activity-1",
        "blocked-with-history",
        JSON.stringify({ status: { from: "in_review", to: "blocked" } }),
        "2026-09-01T00:00:00.000Z",
      );

    expect(runMigrations(database, LEGACY_MIGRATIONS)).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
    expect(
      database
        .prepare(
          `SELECT id, blocked_from_status AS blockedFromStatus
          FROM tasks ORDER BY task_number`,
        )
        .all(),
    ).toEqual([
      { id: "blocked-with-history", blockedFromStatus: "in_review" },
      { id: "blocked-without-history", blockedFromStatus: "in_progress" },
      { id: "active-task", blockedFromStatus: null },
    ]);
    expect(() =>
      database
        .prepare("UPDATE tasks SET blocked_from_status = NULL WHERE id = ?")
        .run("blocked-with-history"),
    ).toThrow();
    expect(() =>
      database
        .prepare("UPDATE tasks SET blocked_from_status = 'todo' WHERE id = ?")
        .run("active-task"),
    ).toThrow();
  });

  it("uses WAL and private permissions for a file database", () => {
    const directory = mkdtempSync(join(tmpdir(), "codexboard-db-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "taskboard.sqlite");
    const database = track(initializeDatabase(filename));

    expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
    assertPrivateFileSync(filename);
    if (process.platform !== "win32") expect(statSync(filename).mode & 0o777).toBe(0o600);
  });

  it("upgrades existing parent relations to multiple children while retaining one parent per child", () => {
    const database = track(openDatabase(":memory:"));
    runMigrations(
      database,
      CORE_MIGRATIONS.filter((migration) => migration.version <= 21),
    );
    database
      .prepare("INSERT INTO projects (id, project_key, name) VALUES (?, ?, ?)")
      .run("project-1", "LOCAL", "本地项目");
    const insertTask = database.prepare(
      `INSERT INTO tasks (id, identifier, project_id, task_number, title, status)
      VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertTask.run("parent-task", "LOCAL-1", "project-1", 1, "父任务", "todo");
    insertTask.run("first-child", "LOCAL-2", "project-1", 2, "第一个子任务", "todo");
    insertTask.run("second-child", "LOCAL-3", "project-1", 3, "第二个子任务", "todo");
    const insertParentRelation = database.prepare(
      `INSERT INTO task_relations (id, project_id, type, source_task_id, target_task_id)
      VALUES (?, ?, 'parent', ?, ?)`,
    );
    insertParentRelation.run("parent-relation-1", "project-1", "parent-task", "first-child");

    runMigrations(database, CORE_MIGRATIONS);
    insertParentRelation.run("parent-relation-2", "project-1", "parent-task", "second-child");
    expect(
      database
        .prepare("SELECT COUNT(*) FROM task_relations WHERE source_task_id = 'parent-task'")
        .pluck()
        .get(),
    ).toBe(2);
    expect(() =>
      insertParentRelation.run("second-parent", "project-1", "second-child", "first-child"),
    ).toThrow();
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("imports exact existing task labels into the ordered global catalog in Schema 9", () => {
    const database = track(openDatabase(":memory:"));
    runMigrations(database, CORE_MIGRATIONS.slice(0, 8));
    database
      .prepare("INSERT INTO projects (id, project_key, name) VALUES (?, ?, ?)")
      .run("project-1", "LOCAL", "本地项目");
    const insertTask = database.prepare(
      `INSERT INTO tasks (
        id, identifier, project_id, task_number, title, status, labels_json
      ) VALUES (?, ?, ?, ?, ?, 'todo', ?)`,
    );
    insertTask.run(
      "task-1",
      "LOCAL-1",
      "project-1",
      1,
      "任务一",
      JSON.stringify(["后端", "Alpha", "后端"]),
    );
    insertTask.run(
      "task-2",
      "LOCAL-2",
      "project-1",
      2,
      "任务二",
      JSON.stringify(["alpha", "前端", "Alpha"]),
    );

    expect(runMigrations(database, LEGACY_MIGRATIONS)).toEqual([
      9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
    expect(
      database
        .prepare(
          "SELECT name, sort_order AS sortOrder, version FROM global_labels ORDER BY sort_order",
        )
        .all(),
    ).toEqual([
      { name: "Alpha", sortOrder: 0, version: 1 },
      { name: "alpha", sortOrder: 1, version: 1 },
      { name: "前端", sortOrder: 2, version: 1 },
      { name: "后端", sortOrder: 3, version: 1 },
    ]);
    expect(() =>
      database
        .prepare("INSERT INTO global_labels (id, name, sort_order) VALUES (?, ?, ?)")
        .run("label-spaced", " 带空格 ", 4),
    ).toThrow();
    expect(() =>
      database
        .prepare("INSERT INTO global_labels (id, name, sort_order) VALUES (?, ?, ?)")
        .run("label-duplicate", "Alpha", 4),
    ).toThrow();
  });

  it("rolls back Schema 8 when existing parent relations have multiple children", () => {
    const database = track(openDatabase(":memory:"));
    runMigrations(database, CORE_MIGRATIONS.slice(0, 7));
    database
      .prepare("INSERT INTO projects (id, project_key, name) VALUES (?, ?, ?)")
      .run("project-1", "LOCAL", "本地项目");
    const insertTask = database.prepare(
      `INSERT INTO tasks (id, identifier, project_id, task_number, title, status)
      VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertTask.run("parent-task", "LOCAL-1", "project-1", 1, "父任务", "todo");
    insertTask.run("first-child", "LOCAL-2", "project-1", 2, "第一个子任务", "todo");
    insertTask.run("second-child", "LOCAL-3", "project-1", 3, "第二个子任务", "todo");
    const insertParentRelation = database.prepare(
      `INSERT INTO task_relations (id, project_id, type, source_task_id, target_task_id)
      VALUES (?, ?, 'parent', ?, ?)`,
    );
    insertParentRelation.run("parent-relation-1", "project-1", "parent-task", "first-child");
    insertParentRelation.run("parent-relation-2", "project-1", "parent-task", "second-child");

    expect(() => runMigrations(database, LEGACY_MIGRATIONS)).toThrow(MigrationError);
    expect(database.prepare("SELECT version FROM schema_migrations").pluck().all()).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(
      database
        .prepare("PRAGMA table_info(tasks)")
        .all()
        .map((column) => (column as { name: string }).name),
    ).not.toContain("links_json");
    expect(
      database
        .prepare("SELECT COUNT(*) FROM task_relations WHERE source_task_id = ? AND type = 'parent'")
        .pluck()
        .get("parent-task"),
    ).toBe(2);
  });

  it("upgrades an existing v4 database to v20 without losing project, task or job data", () => {
    const database = track(openDatabase(":memory:"));
    runMigrations(database, CORE_MIGRATIONS.slice(0, 4));
    database
      .prepare("INSERT INTO actors (id, tenant_key, open_id, name, role) VALUES (?, ?, ?, ?, ?)")
      .run("upgrade-actor", "tenant", "upgrade-open", "升级用户", "admin");
    database
      .prepare("INSERT INTO projects (id, project_key, name, created_by) VALUES (?, ?, ?, ?)")
      .run("upgrade-project", "UPGRADE", "升级项目", "upgrade-actor");
    database
      .prepare(
        `INSERT INTO tasks (id, identifier, project_id, task_number, title, status, creator_actor_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "upgrade-task",
        "UPGRADE-1",
        "upgrade-project",
        1,
        "保留任务",
        "in_progress",
        "upgrade-actor",
      );
    database
      .prepare(
        `INSERT INTO jobs (
          id, task_id, kind, status, execution_key, idempotency_key, requested_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "upgrade-job",
        "upgrade-task",
        "start",
        "succeeded",
        "/workspace/upgrade",
        "upgrade-job-key",
        "upgrade-actor",
      );

    runMigrations(database, LEGACY_MIGRATIONS);

    expect(database.prepare("SELECT version FROM schema_migrations").pluck().all()).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
    expect(
      database.prepare("SELECT title FROM tasks WHERE id = ?").pluck().get("upgrade-task"),
    ).toBe("保留任务");
    expect(
      database.prepare("SELECT status FROM jobs WHERE id = ?").pluck().get("upgrade-job"),
    ).toBe("succeeded");
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_reads'")
        .pluck()
        .get(),
    ).toBe("task_reads");
  });

  it("upgrades Schema 6 project keys and every existing task identifier atomically", () => {
    const database = track(openDatabase(":memory:"));
    runMigrations(database, CORE_MIGRATIONS.slice(0, 6));
    const allProjectId = "00000000-0000-4000-8000-0000000000a1";
    const temporaryProjectId = "00000000-0000-4000-8000-0000000000a2";
    const boardProjectId = "10000000-0000-4000-8000-000000000001";
    const dockerProjectId = "10000000-0000-4000-8000-000000000002";

    database
      .prepare(
        `INSERT INTO projects (
          id, project_key, name, workspace_realpath, source_kind, codex_project_id,
          root_paths_json, sync_position, created_at
        ) VALUES (?, ?, ?, ?, 'codex', ?, ?, ?, ?)`,
      )
      .run(
        boardProjectId,
        "BOARD",
        "codexboard",
        "/Users/test/Projects/codexboard",
        "47c1610d-f646-47f6-8fe3-28824096c2fe",
        '["/Users/test/Projects/codexboard"]',
        0,
        "2026-09-01T00:00:00.000Z",
      );
    database
      .prepare(
        `INSERT INTO projects (
          id, project_key, name, source_kind, codex_project_id, root_paths_json,
          sync_position, sync_deleted_at, created_at
        ) VALUES (?, ?, ?, 'codex', ?, ?, ?, ?, ?)`,
      )
      .run(
        dockerProjectId,
        "CDX-A95CAA715FD94B2F",
        "Docker",
        "a47fb25e-16d8-4e8d-b6cb-b7760b7e028f",
        '["/Users/test/Docker"]',
        1,
        "2026-09-01T12:00:00.000Z",
        "2026-09-01T00:01:00.000Z",
      );

    const insertTask = database.prepare(
      `INSERT INTO tasks (id, identifier, project_id, task_number, title, status)
      VALUES (?, ?, ?, ?, ?, 'todo')`,
    );
    insertTask.run("task-project-1", "BOARD-1", boardProjectId, 1, "任务一");
    insertTask.run("task-project-12", "BOARD-12", boardProjectId, 12, "任务十二");
    insertTask.run("task-temp-1", "SYS-TEMP-1", temporaryProjectId, 1, "临时任务");
    insertTask.run(
      "task-docker-1000",
      "CDX-A95CAA715FD94B2F-1000",
      temporaryProjectId,
      2,
      "来源项目任务",
    );
    database
      .prepare(
        `INSERT INTO project_orphaned_tasks (
          task_id, source_project_id, source_task_number, orphaned_at
        ) VALUES (?, ?, ?, ?)`,
      )
      .run("task-docker-1000", dockerProjectId, 1000, "2026-09-01T12:00:00.000Z");

    expect(runMigrations(database, LEGACY_MIGRATIONS)).toEqual([
      7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
    expect(
      database.prepare("SELECT id, project_key AS projectKey FROM projects ORDER BY id").all(),
    ).toEqual([
      { id: allProjectId, projectKey: null },
      { id: temporaryProjectId, projectKey: "TEMP" },
      { id: boardProjectId, projectKey: "COPA" },
      { id: dockerProjectId, projectKey: "DOVO" },
    ]);
    expect(database.prepare("SELECT id, identifier FROM tasks ORDER BY id").all()).toEqual([
      { id: "task-docker-1000", identifier: "DOVO-1000" },
      { id: "task-project-1", identifier: "COPA-001" },
      { id: "task-project-12", identifier: "COPA-012" },
      { id: "task-temp-1", identifier: "TEMP-001" },
    ]);
    expect(
      database
        .prepare("PRAGMA table_info(projects)")
        .all()
        .find((column) => (column as { name: string }).name === "project_key"),
    ).toMatchObject({ notnull: 0 });
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("rolls back the real Schema 7 table rebuild when migrated identifiers conflict", () => {
    const database = track(openDatabase(":memory:"));
    runMigrations(database, CORE_MIGRATIONS.slice(0, 6));
    const temporaryProjectId = "00000000-0000-4000-8000-0000000000a2";
    const sourceProjectId = "10000000-0000-4000-8000-000000000001";

    database
      .prepare(
        `INSERT INTO projects (
          id, project_key, name, workspace_realpath, source_kind, codex_project_id,
          root_paths_json, sync_position, sync_deleted_at
        ) VALUES (?, ?, ?, ?, 'codex', ?, ?, 0, ?)`,
      )
      .run(
        sourceProjectId,
        "OLD",
        "冲突来源项目",
        "/Users/test/Projects/source",
        "11111111-1111-4111-8111-111111111111",
        '["/Users/test/Projects/source"]',
        "2026-09-01T12:00:00.000Z",
      );
    const insertTask = database.prepare(
      `INSERT INTO tasks (id, identifier, project_id, task_number, title, status)
      VALUES (?, ?, ?, ?, ?, 'todo')`,
    );
    insertTask.run("active-task", "OLD-1", sourceProjectId, 1, "活动任务");
    insertTask.run("orphan-task", "SYS-TEMP-2", temporaryProjectId, 2, "孤儿任务");
    database
      .prepare(
        `INSERT INTO project_orphaned_tasks (
          task_id, source_project_id, source_task_number, orphaned_at
        ) VALUES (?, ?, ?, ?)`,
      )
      .run("orphan-task", sourceProjectId, 1, "2026-09-01T12:00:00.000Z");

    expect(() => runMigrations(database, LEGACY_MIGRATIONS)).toThrow(MigrationError);
    expect(database.prepare("SELECT version FROM schema_migrations").pluck().all()).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(
      database
        .prepare("SELECT project_key FROM projects WHERE id = ?")
        .pluck()
        .get(sourceProjectId),
    ).toBe("OLD");
    expect(database.prepare("SELECT id, identifier FROM tasks ORDER BY id").all()).toEqual([
      { id: "active-task", identifier: "OLD-1" },
      { id: "orphan-task", identifier: "SYS-TEMP-2" },
    ]);
    expect(
      database
        .prepare("PRAGMA table_info(projects)")
        .all()
        .find((column) => (column as { name: string }).name === "project_key"),
    ).toMatchObject({ notnull: 1 });
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'projects_sync_shape_insert'",
        )
        .pluck()
        .get(),
    ).toBe("projects_sync_shape_insert");
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("rejects an orphan mapping whose task is not in the temporary project", () => {
    const database = track(openDatabase(":memory:"));
    runMigrations(database, CORE_MIGRATIONS.slice(0, 6));
    const sourceProjectId = "10000000-0000-4000-8000-000000000001";
    database
      .prepare(
        `INSERT INTO projects (
          id, project_key, name, workspace_realpath, source_kind, codex_project_id,
          root_paths_json, sync_position
        ) VALUES (?, ?, ?, ?, 'codex', ?, ?, 0)`,
      )
      .run(
        sourceProjectId,
        "OLD",
        "损坏孤儿映射",
        "/Users/test/Projects/source",
        "11111111-1111-4111-8111-111111111111",
        '["/Users/test/Projects/source"]',
      );
    database
      .prepare(
        `INSERT INTO tasks (id, identifier, project_id, task_number, title, status)
        VALUES (?, ?, ?, ?, ?, 'todo')`,
      )
      .run("active-task", "OLD-1", sourceProjectId, 1, "错误映射任务");
    database
      .prepare(
        `INSERT INTO project_orphaned_tasks (
          task_id, source_project_id, source_task_number, orphaned_at
        ) VALUES (?, ?, ?, ?)`,
      )
      .run("active-task", sourceProjectId, 2, "2026-09-01T12:00:00.000Z");

    expect(() => runMigrations(database, LEGACY_MIGRATIONS)).toThrow(MigrationError);
    expect(database.prepare("SELECT version FROM schema_migrations").pluck().all()).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it("rejects an orphan mapping whose Codex source project is still active", () => {
    const database = track(openDatabase(":memory:"));
    runMigrations(database, CORE_MIGRATIONS.slice(0, 6));
    const temporaryProjectId = "00000000-0000-4000-8000-0000000000a2";
    const sourceProjectId = "10000000-0000-4000-8000-000000000001";
    database
      .prepare(
        `INSERT INTO projects (
          id, project_key, name, workspace_realpath, source_kind, codex_project_id,
          root_paths_json, sync_position
        ) VALUES (?, ?, ?, ?, 'codex', ?, ?, 0)`,
      )
      .run(
        sourceProjectId,
        "OLD",
        "仍活动的来源项目",
        "/Users/test/Projects/source",
        "11111111-1111-4111-8111-111111111111",
        '["/Users/test/Projects/source"]',
      );
    database
      .prepare(
        `INSERT INTO tasks (id, identifier, project_id, task_number, title, status)
        VALUES (?, ?, ?, ?, ?, 'todo')`,
      )
      .run("orphan-task", "SYS-TEMP-2", temporaryProjectId, 2, "滞留孤儿任务");
    database
      .prepare(
        `INSERT INTO project_orphaned_tasks (
          task_id, source_project_id, source_task_number, orphaned_at
        ) VALUES (?, ?, ?, ?)`,
      )
      .run("orphan-task", sourceProjectId, 1, "2026-09-01T12:00:00.000Z");

    expect(() => runMigrations(database, LEGACY_MIGRATIONS)).toThrow(MigrationError);
    expect(database.prepare("SELECT version FROM schema_migrations").pluck().all()).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it("creates a consistent pre-migration backup before upgrading an existing database", async () => {
    const directory = realpathSync.native(
      mkdtempSync(
        join(
          process.platform === "darwin" ? "/private/tmp" : tmpdir(),
          "codexboard-migration-backup-",
        ),
      ),
    );
    temporaryDirectories.push(directory);
    const database = track(openDatabase(join(directory, "taskboard.sqlite")));
    runMigrations(database, CORE_MIGRATIONS.slice(0, 4));
    database
      .prepare("INSERT INTO actors (id, tenant_key, open_id, name, role) VALUES (?, ?, ?, ?, ?)")
      .run("backup-actor", "tenant", "backup-open", "迁移备份用户", "admin");

    const result = await runMigrationsWithBackup(
      database,
      LEGACY_MIGRATIONS,
      new BackupService({ database, dataDirectory: directory }),
    );

    expect(result.appliedVersions).toEqual([
      5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
    expect(result.backupPath).toMatch(/pre-migration-v4-to-v20/);
    const manifest = JSON.parse(
      readFileSync(join(result.backupPath as string, "manifest.json"), "utf8"),
    ) as { schemaVersion: number };
    expect(manifest.schemaVersion).toBe(4);
    expect(BackupService.verify(result.backupPath as string).schemaVersion).toBe(4);
    expect(
      database.prepare("SELECT name FROM actors WHERE id = ?").pluck().get("backup-actor"),
    ).toBe("迁移备份用户");
    database.close();

    await BackupService.restore(result.backupPath as string, directory);
    const restored = track(openDatabase(join(directory, "taskboard.sqlite")));
    runMigrations(restored, LEGACY_MIGRATIONS);
    expect(restored.prepare("SELECT version FROM schema_migrations").pluck().all()).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
    expect(
      restored.prepare("SELECT name FROM actors WHERE id = ?").pluck().get("backup-actor"),
    ).toBe("迁移备份用户");
  });

  it("creates protected Codex mirror metadata, system projects and orphan mappings", () => {
    const database = track(initializeDatabase(":memory:"));
    const allProjectId = "00000000-0000-4000-8000-0000000000a1";
    const temporaryProjectId = "00000000-0000-4000-8000-0000000000a2";
    const sourceProjectId = "10000000-0000-4000-8000-000000000001";
    const codexProjectId = "11111111-1111-4111-8111-111111111111";

    expect(
      database
        .prepare(
          `SELECT id, project_key AS projectKey, source_kind AS sourceKind,
            system_kind AS systemKind, root_paths_json AS rootPathsJson
          FROM projects WHERE id IN (?, ?) ORDER BY id`,
        )
        .all(allProjectId, temporaryProjectId),
    ).toEqual([
      {
        id: allProjectId,
        projectKey: null,
        sourceKind: "system",
        systemKind: "all",
        rootPathsJson: "[]",
      },
      {
        id: temporaryProjectId,
        projectKey: "TEMP",
        sourceKind: "system",
        systemKind: "temporary",
        rootPathsJson: "[]",
      },
    ]);
    expect(() =>
      database
        .prepare("UPDATE projects SET project_key = 'temp' WHERE id = ?")
        .run(temporaryProjectId),
    ).toThrow();
    expect(database.prepare("SELECT count(*) FROM project_sync_state").pluck().get()).toBe(1);
    expect(() =>
      database.prepare("INSERT INTO project_sync_state (singleton) VALUES (2)").run(),
    ).toThrow();

    database
      .prepare(
        `INSERT INTO projects (
          id, project_key, name, workspace_realpath, source_kind, codex_project_id,
          root_paths_json, sync_position
        ) VALUES (?, ?, ?, ?, 'codex', ?, ?, 0)`,
      )
      .run(
        sourceProjectId,
        "CDXA",
        "论文",
        "/Users/test/Projects/codex-paper",
        codexProjectId,
        '["/Users/test/Projects/codex-paper"]',
      );
    expect(() =>
      database
        .prepare(
          `INSERT INTO projects (
            id, project_key, name, source_kind, codex_project_id, root_paths_json, sync_position
          ) VALUES (?, ?, ?, 'codex', ?, ?, 1)`,
        )
        .run(
          "10000000-0000-4000-8000-000000000002",
          "CDXB",
          "重复 Codex ID",
          codexProjectId,
          '["/Users/test/Other"]',
        ),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `INSERT INTO projects (
            id, project_key, name, source_kind, codex_project_id, root_paths_json, sync_position
          ) VALUES (?, ?, ?, 'codex', ?, ?, 2)`,
        )
        .run(
          "10000000-0000-4000-8000-000000000003",
          "CDXC",
          "错误根目录",
          "33333333-3333-4333-8333-333333333333",
          '{"not":"an-array"}',
        ),
    ).toThrow();

    database
      .prepare(
        `INSERT INTO tasks (id, identifier, project_id, task_number, title, status)
        VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "20000000-0000-4000-8000-000000000001",
        "CDXA-001",
        temporaryProjectId,
        1,
        "保留历史任务",
        "todo",
      );
    database
      .prepare(
        `INSERT INTO project_orphaned_tasks (
          task_id, source_project_id, source_task_number, orphaned_at
        ) VALUES (?, ?, ?, ?)`,
      )
      .run("20000000-0000-4000-8000-000000000001", sourceProjectId, 1, "2026-09-01T12:00:00.000Z");
    expect(() =>
      database
        .prepare(
          `INSERT INTO project_orphaned_tasks (
            task_id, source_project_id, source_task_number, orphaned_at
          ) VALUES (?, ?, ?, ?)`,
        )
        .run("missing-task", sourceProjectId, 2, "2026-09-01T12:00:00.000Z"),
    ).toThrow();
    expect(() =>
      database.prepare("DELETE FROM projects WHERE id = ?").run(sourceProjectId),
    ).toThrow();

    expect(runMigrations(database, CORE_MIGRATIONS)).toEqual([]);
    expect(
      database.prepare("SELECT count(*) FROM projects WHERE source_kind = 'system'").pluck().get(),
    ).toBe(2);
    expect(database.prepare("SELECT count(*) FROM project_sync_state").pluck().get()).toBe(1);
  });

  it("does not start a migration until its pre-migration backup is durably published", async () => {
    const directory = realpathSync.native(
      mkdtempSync(
        join(
          process.platform === "darwin" ? "/private/tmp" : tmpdir(),
          "codexboard-migration-order-",
        ),
      ),
    );
    temporaryDirectories.push(directory);
    const events: string[] = [];
    const database = track(
      new Database(join(directory, "taskboard.sqlite"), {
        verbose: (sql) => {
          if (String(sql).includes("CREATE TABLE task_reads")) {
            events.push("migration");
          }
        },
      }),
    );
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    runMigrations(database, CORE_MIGRATIONS.slice(0, 4));
    const backups = new BackupService({
      database,
      dataDirectory: directory,
      durabilityHooks: {
        syncPath: (path) =>
          events.push(`sync:${path.slice(directory.length).replaceAll("\\", "/") || "/"}`),
      },
    });

    await runMigrationsWithBackup(database, CORE_MIGRATIONS, backups);

    const durablePublishAt = events.findIndex((event) => event === "sync:/backups");
    const migrationAt = events.indexOf("migration");
    expect(durablePublishAt).toBeGreaterThanOrEqual(0);
    expect(migrationAt).toBeGreaterThan(durablePublishAt);
  });

  it("rolls back an operation transaction atomically", () => {
    const database = track(initializeDatabase(":memory:"));

    expect(() =>
      withTransaction(database, () => {
        database
          .prepare(
            "INSERT INTO identities (identity_key, kind, tenant_key, user_id, name, role) VALUES (?, 'feishu', ?, ?, ?, ?)",
          )
          .run('["feishu","tenant","user-1"]', "tenant", "user-1", "测试用户", "member");
        throw new Error("rollback");
      }),
    ).toThrow("rollback");

    expect(database.prepare("SELECT count(*) FROM identities").pluck().get()).toBe(0);
  });

  it("rolls back a failed migration and detects checksum drift", () => {
    const database = track(openDatabase(":memory:"));

    expect(() =>
      runMigrations(database, [
        {
          version: 1,
          name: "broken",
          sql: "CREATE TABLE rolled_back (id TEXT); INSERT INTO missing_table VALUES (1);",
        },
      ]),
    ).toThrow(MigrationError);
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rolled_back'")
        .get(),
    ).toBeUndefined();

    runMigrations(database, [
      { version: 1, name: "stable", sql: "CREATE TABLE stable (id TEXT) STRICT;" },
    ]);
    expect(() =>
      runMigrations(database, [
        { version: 1, name: "stable", sql: "CREATE TABLE stable (id INTEGER) STRICT;" },
      ]),
    ).toThrow(/内容与当前代码不一致/);
  });

  it("runs a checksummed data transform inside the migration transaction", () => {
    const database = track(openDatabase(":memory:"));
    const migration = {
      version: 1,
      name: "with_transform",
      sql: "CREATE TABLE transformed (id TEXT PRIMARY KEY, value TEXT) STRICT;",
      transformChecksum: "insert-v1",
      transform: (target: Database.Database) => {
        target.prepare("INSERT INTO transformed (id, value) VALUES (?, ?)").run("one", "完成");
      },
      foreignKeysDisabled: true,
    };

    runMigrations(database, [migration]);

    expect(database.prepare("SELECT value FROM transformed WHERE id = ?").pluck().get("one")).toBe(
      "完成",
    );
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(() =>
      runMigrations(database, [{ ...migration, transformChecksum: "insert-v2" }]),
    ).toThrow(/内容与当前代码不一致/);
  });

  it("rolls back SQL and migration metadata when a data transform fails", () => {
    const database = track(openDatabase(":memory:"));
    database.pragma("foreign_keys = ON");

    expect(() =>
      runMigrations(database, [
        {
          version: 1,
          name: "broken_transform",
          sql: "CREATE TABLE transform_rollback (id TEXT PRIMARY KEY) STRICT;",
          transformChecksum: "broken-v1",
          transform: () => {
            throw new Error("transform failed");
          },
          foreignKeysDisabled: true,
        },
      ]),
    ).toThrow(MigrationError);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transform_rollback'",
        )
        .get(),
    ).toBeUndefined();
    expect(database.prepare("SELECT version FROM schema_migrations").pluck().all()).toEqual([]);
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("accepts a descriptive migration rename when its version and SQL are unchanged", () => {
    const database = track(openDatabase(":memory:"));
    const sql = "CREATE TABLE stable_name (id TEXT) STRICT;";

    runMigrations(database, [{ version: 1, name: "historical_name", sql }]);

    expect(() =>
      runMigrations(database, [{ version: 1, name: "descriptive_name", sql }]),
    ).not.toThrow();
  });

  it("enforces foreign keys, versions, numbering and active execution uniqueness", () => {
    const database = track(initializeDatabase(":memory:"));

    database
      .prepare(
        "INSERT INTO identities (identity_key, kind, tenant_key, user_id, name, role) VALUES (?, 'feishu', ?, ?, ?, ?)",
      )
      .run('["feishu","tenant","user-1"]', "tenant", "user-1", "测试用户", "admin");
    database
      .prepare(
        "INSERT INTO projects (id, project_key, name, created_by_identity_key) VALUES (?, ?, ?, ?)",
      )
      .run("project-1", "LOCAL", "本地项目", '["feishu","tenant","user-1"]');
    database
      .prepare(
        `INSERT INTO tasks (
          id, identifier, project_id, task_number, title, status, creator_identity_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "task-1",
        "LOCAL-1",
        "project-1",
        1,
        "建立数据库",
        "todo",
        '["feishu","tenant","user-1"]',
      );

    expect(() =>
      database
        .prepare(
          `INSERT INTO tasks (
            id, identifier, project_id, task_number, title, status, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("task-2", "LOCAL-2", "project-1", 2, "非法版本", "todo", 0),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `INSERT INTO tasks (
            id, identifier, project_id, task_number, title, status
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("task-3", "LOCAL-3", "missing-project", 3, "错误项目", "todo"),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `INSERT INTO tasks (
            id, identifier, project_id, task_number, title, status
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("task-4", "LOCAL-4", "project-1", 1, "重复编号", "todo"),
    ).toThrow();

    const insertJob = database.prepare(
      `INSERT INTO jobs (
        id, task_id, kind, status, execution_key, idempotency_key, requested_by_identity_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insertJob.run(
      "job-1",
      "task-1",
      "start",
      "queued",
      "/workspace/local",
      "request-key-0001",
      '["feishu","tenant","user-1"]',
    );
    expect(() =>
      insertJob.run(
        "job-2",
        "task-1",
        "continue",
        "queued",
        "/workspace/local",
        "request-key-0002",
        '["feishu","tenant","user-1"]',
      ),
    ).toThrow();
  });

  it("prevents updates to append-only event tables", () => {
    const database = track(initializeDatabase(":memory:"));
    database
      .prepare(
        `INSERT INTO change_events (
          aggregate_type, aggregate_id, event_type, safe_payload_json
        ) VALUES (?, ?, ?, ?)`,
      )
      .run("system", null, "system.ready", "{}");

    expect(() =>
      database.prepare("UPDATE change_events SET event_type = ? WHERE revision = 1").run("changed"),
    ).toThrow(/append-only/);
  });
});

it("upgrades v14 comment constraints without losing attachment references or execution locks", () => {
  const database = track(openDatabase(":memory:"));
  runMigrations(
    database,
    CORE_MIGRATIONS.filter((migration) => migration.version <= 14),
  );
  database.exec(`
    INSERT INTO actors (id, tenant_key, open_id, name, role) VALUES ('actor', 'tenant', 'open', 'author', 'admin');
    INSERT INTO projects (id, project_key, name) VALUES ('project', 'MIG', 'migration');
    INSERT INTO tasks (id, identifier, project_id, task_number, title, status) VALUES ('task', 'MIG-1', 'project', 1, 'task', 'todo');
    INSERT INTO comments (id, task_id, author_id, body, version, executed_at) VALUES ('comment', 'task', 'actor', 'preserved body', 3, '2026-09-06T00:00:00.000Z');
    INSERT INTO attachments (id, task_id, comment_id, uploader_id, filename, content_type, size_bytes, sha256, storage_key)
      VALUES ('attachment', 'task', 'comment', 'actor', 'evidence.txt', 'text/plain', 3, '${"a".repeat(64)}', 'ab/file');
  `);
  const before = database.prepare("SELECT * FROM comments").get();
  expect(runMigrations(database, LEGACY_MIGRATIONS)).toEqual([15, 16, 17, 18, 19, 20]);
  expect(database.prepare("SELECT * FROM comments").get()).toEqual(before);
  expect(database.prepare("SELECT comment_id, pending_comment FROM attachments").get()).toEqual({
    comment_id: "comment",
    pending_comment: 0,
  });
  expect(database.pragma("foreign_key_check")).toEqual([]);
  expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
  database.prepare("UPDATE comments SET body = '' WHERE id = 'comment'").run();
  expect(() => database.prepare("UPDATE attachments SET comment_id = 'missing'").run()).toThrow();
  database.prepare("DELETE FROM comments WHERE id = 'comment'").run();
  expect(database.prepare("SELECT count(*) FROM attachments").pluck().get()).toBe(0);
});
