import { assertPrivateFileSync } from "../../../scripts/private-file-permissions.mjs";
import { seedProjectMember } from "./helpers/project-member-fixture.js";
import { TEST_FEISHU_ACTOR, seedFeishuTestActor } from "./helpers/identity.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CreateTaskCommandSchema, type PrincipalView } from "@codexboard/contracts";

import { AttachmentService, AttachmentVault } from "../src/modules/attachments/index.js";
import { initializeDatabase, type SqliteDatabase } from "../src/modules/database/index.js";
import {
  DevelopmentIdentityAdapter,
  DEVELOPMENT_IDENTITY,
  IdentityService,
} from "../src/modules/identity/index.js";
import { ProjectAdministration } from "../src/modules/project-registry/index.js";
import { Taskboard } from "../src/modules/taskboard/index.js";

const temporaryDirectories: string[] = [];
const openDatabases: SqliteDatabase[] = [];
const ADMIN_ACTOR: PrincipalView = TEST_FEISHU_ACTOR;

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    if (database.open) database.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup(maxBytes = 1_024) {
  const root = mkdtempSync(join(tmpdir(), "codexboard-vault-"));
  temporaryDirectories.push(root);
  return { root, vault: new AttachmentVault({ rootDirectory: root, maxBytes }) };
}

describe("AttachmentVault", () => {
  it("stores validated bytes atomically under an opaque key", () => {
    const { root, vault } = setup();
    const bytes = Buffer.from("%PDF-1.7\nvalidated");
    const stored = vault.store({
      filename: "验收记录.pdf",
      contentType: "application/pdf",
      bytes,
    });

    expect(stored).toMatchObject({
      filename: "验收记录.pdf",
      contentType: "application/pdf",
      sizeBytes: bytes.length,
    });
    expect(stored.storageKey).toMatch(/^[0-9a-f]{2}\/[0-9a-f-]{36}$/);
    expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(vault.open(stored.storageKey)).toEqual(bytes);
    expect(readFileSync(join(root, stored.storageKey))).toEqual(bytes);
    assertPrivateFileSync(join(root, stored.storageKey));
    if (process.platform !== "win32")
      expect(statSync(join(root, stored.storageKey)).mode & 0o777).toBe(0o600);

    vault.remove(stored.storageKey);
    expect(existsSync(join(root, stored.storageKey))).toBe(false);
  });

  it("rejects traversal, unsafe active content, type mismatch and oversized input", () => {
    const { vault } = setup(64);
    expect(() =>
      vault.store({
        filename: "../secret.txt",
        contentType: "text/plain",
        bytes: Buffer.from("secret"),
      }),
    ).toThrow(/路径/);
    expect(() =>
      vault.store({
        filename: "attack.svg",
        contentType: "image/svg+xml",
        bytes: Buffer.from("<svg onload=alert(1)></svg>"),
      }),
    ).toThrow(/不允许/);
    expect(() =>
      vault.store({
        filename: "disguised.bin",
        contentType: "application/octet-stream",
        bytes: Buffer.from("  <svg onload=alert(1)></svg>"),
      }),
    ).toThrow(/不允许/);
    expect(() =>
      vault.store({
        filename: "fake.png",
        contentType: "image/png",
        bytes: Buffer.from("not a png"),
      }),
    ).toThrow(/内容类型/);
    expect(() =>
      vault.store({
        filename: "large.txt",
        contentType: "text/plain",
        bytes: Buffer.from("x".repeat(65)),
      }),
    ).toThrow(/大小/);
  });

  it("accepts valid JSON with an explicit media type", () => {
    const { vault } = setup();
    const stored = vault.store({
      filename: "evidence.json",
      contentType: "application/json",
      bytes: Buffer.from('{"result":"passed"}'),
    });
    expect(stored.contentType).toBe("application/json");
  });

  it("quarantines stored bytes before deletion and can restore or discard them", () => {
    const { root, vault } = setup();
    const first = vault.store({
      filename: "first.txt",
      contentType: "text/plain",
      bytes: Buffer.from("first"),
    });
    const second = vault.store({
      filename: "second.txt",
      contentType: "text/plain",
      bytes: Buffer.from("second"),
    });

    const restored = vault.quarantine([first.storageKey, second.storageKey]);
    expect(existsSync(join(root, first.storageKey))).toBe(false);
    expect(existsSync(join(root, second.storageKey))).toBe(false);
    vault.restore(restored);
    expect(vault.open(first.storageKey).toString("utf8")).toBe("first");
    expect(vault.open(second.storageKey).toString("utf8")).toBe("second");

    const discarded = vault.quarantine([first.storageKey, second.storageKey]);
    vault.discard(discarded);
    expect(existsSync(join(root, first.storageKey))).toBe(false);
    expect(existsSync(join(root, second.storageKey))).toBe(false);
    expect(
      readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()),
    ).toHaveLength(0);
  });

  it("preserves a pre-existing quarantine batch when a resumed move fails", () => {
    const { root, vault } = setup();
    const batchId = "10000000-0000-4000-8000-000000000001";
    const existing = vault.store({
      filename: "existing.txt",
      contentType: "text/plain",
      bytes: Buffer.from("existing quarantine"),
    });
    const movedThisTime = vault.store({
      filename: "moved-this-time.txt",
      contentType: "text/plain",
      bytes: Buffer.from("move then roll back"),
    });
    const failing = vault.store({
      filename: "failing.txt",
      contentType: "text/plain",
      bytes: Buffer.from("must stay in place"),
    });
    vault.quarantine([existing.storageKey], batchId);

    const quarantineRoot = join(root, ".quarantine", batchId);
    const existingQuarantinePath = join(quarantineRoot, existing.storageKey);
    const movedQuarantinePath = join(quarantineRoot, movedThisTime.storageKey);
    const failingQuarantinePath = join(quarantineRoot, failing.storageKey);
    mkdirSync(failingQuarantinePath, { recursive: true });
    const sentinelPath = join(failingQuarantinePath, "sentinel");
    writeFileSync(sentinelPath, "force rename failure");

    expect(() =>
      vault.quarantine(
        [existing.storageKey, movedThisTime.storageKey, failing.storageKey],
        batchId,
      ),
    ).toThrow(/附件隔离失败/);

    expect(readFileSync(existingQuarantinePath, "utf8")).toBe("existing quarantine");
    expect(existsSync(join(root, existing.storageKey))).toBe(false);
    expect(vault.open(movedThisTime.storageKey).toString("utf8")).toBe("move then roll back");
    expect(existsSync(movedQuarantinePath)).toBe(false);
    expect(vault.open(failing.storageKey).toString("utf8")).toBe("must stay in place");
    expect(existsSync(quarantineRoot)).toBe(true);
    expect(readFileSync(sentinelPath, "utf8")).toBe("force rename failure");
  });

  it("requires verified Feishu identity for cross-project attachments and rolls back failed file mutations", () => {
    const { root, vault } = setup();
    const database = initializeDatabase(":memory:");
    seedFeishuTestActor(database);
    openDatabases.push(database);
    const identityService = new IdentityService({
      database,
      provider: new DevelopmentIdentityAdapter(),
      sessionTtlSeconds: 300,
    });
    identityService.ensureDevelopmentActor(DEVELOPMENT_IDENTITY);
    const administration = new ProjectAdministration(database);
    const project = administration.createProject({
      projectKey: "FILES",
      name: "附件项目",
      description: "",
    });
    const otherProject = administration.createProject({
      projectKey: "OTHERFILES",
      name: "其他附件项目",
      description: "",
    });
    const outsider = seedProjectMember(database, otherProject.id, {
      tenantKey: "other-tenant",
      userId: "other-member",
      name: "无权限成员",
      avatarUrl: null,
      actorRole: "member",
      projectRole: "viewer",
    });
    const taskboard = new Taskboard({ database, identityService });
    const task = taskboard.createTask(
      CreateTaskCommandSchema.parse({ projectId: project.id, title: "附件事务任务" }),
      { actor: ADMIN_ACTOR, idempotencyKey: "attachment-task-transaction" },
    ).task;
    const service = new AttachmentService({ database, identityService, taskboard, vault });
    const uploaded = service.upload(
      task.id,
      { filename: "allowed.txt", contentType: "text/plain", bytes: Buffer.from("allowed") },
      { actor: ADMIN_ACTOR, idempotencyKey: "attachment-allowed" },
    );
    expect(() =>
      service.open(uploaded.data.id, {
        identity: outsider.identity,
        name: "无权限成员",
        avatarUrl: null,
        role: "member",
      }),
    ).toThrow(/权限/);
    expect(() =>
      service.delete(uploaded.data.id, {
        actor: {
          identity: outsider.identity,
          name: "无权限成员",
          avatarUrl: null,
          role: "member",
        },
        idempotencyKey: "attachment-forbidden-delete",
      }),
    ).toThrow(/权限/);

    const verifiedUser: PrincipalView = {
      identity: outsider.identity,
      name: "飞书用户",
      avatarUrl: null,
      role: "member",
    };
    seedFeishuTestActor(database, verifiedUser);
    expect(service.open(uploaded.data.id, verifiedUser).bytes.toString("utf8")).toBe("allowed");
    const crossProjectUpload = service.upload(
      task.id,
      {
        filename: "member.txt",
        contentType: "text/plain",
        bytes: Buffer.from("member upload"),
      },
      { actor: verifiedUser, idempotencyKey: "verified-cross-project-upload" },
    );
    expect(service.open(crossProjectUpload.data.id, verifiedUser).bytes.toString("utf8")).toBe(
      "member upload",
    );
    service.delete(crossProjectUpload.data.id, {
      actor: verifiedUser,
      idempotencyKey: "verified-cross-project-delete",
    });
    expect(() => service.open(crossProjectUpload.data.id, verifiedUser)).toThrow();

    database.exec(`CREATE TRIGGER reject_attachment_delete_activity
      BEFORE INSERT ON activities WHEN NEW.kind = 'attachment.deleted'
      BEGIN SELECT RAISE(ABORT, 'forced attachment delete failure'); END`);
    expect(() =>
      service.delete(uploaded.data.id, {
        actor: ADMIN_ACTOR,
        idempotencyKey: "attachment-delete-rollback",
      }),
    ).toThrow(/forced attachment delete failure/);
    expect(service.open(uploaded.data.id, ADMIN_ACTOR).bytes.toString("utf8")).toBe("allowed");
    expect(
      database
        .prepare("SELECT count(*) FROM attachments WHERE id = ?")
        .pluck()
        .get(uploaded.data.id),
    ).toBe(1);
    database.exec("DROP TRIGGER reject_attachment_delete_activity");

    const filesBeforeFailure = readdirSync(root, { recursive: true, withFileTypes: true }).filter(
      (entry) => entry.isFile(),
    ).length;
    database.exec(`CREATE TRIGGER reject_attachment_insert
      BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT, 'forced attachment failure'); END`);
    expect(() =>
      service.upload(
        task.id,
        { filename: "orphan.txt", contentType: "text/plain", bytes: Buffer.from("orphan") },
        { actor: ADMIN_ACTOR, idempotencyKey: "attachment-orphan" },
      ),
    ).toThrow(/forced attachment failure/);
    expect(
      readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
        .length,
    ).toBe(filesBeforeFailure);
  });
});
