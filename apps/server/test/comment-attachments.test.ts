import { identityKey } from "@codexboard/contracts";
import { credentialPaths, defaultCredentialStore } from "../../../packages/taskctl/src/auth.js";
import { TEST_FEISHU_ACTOR, seedFeishuTestActor } from "./helpers/identity.js";
import { exec } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePrivateDirectorySync } from "../../../scripts/private-file-permissions.mjs";
import {
  CreateCommentCommandSchema,
  CreateTaskCommandSchema,
  type PrincipalView,
  type RuntimeDescriptor,
} from "@codexboard/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { AttachmentService, AttachmentVault } from "../src/modules/attachments/index.js";
import { initializeDatabase } from "../src/modules/database/index.js";
import { ExecutionQueue } from "../src/modules/execution/index.js";
import {
  DevelopmentIdentityAdapter,
  DEVELOPMENT_IDENTITY,
  IdentityService,
} from "../src/modules/identity/index.js";
import { ProjectAdministration } from "../src/modules/project-registry/index.js";
import { Taskboard, TaskWorkspace } from "../src/modules/taskboard/index.js";
import { CliAuthService } from "../src/modules/identity/cli-auth-service.js";

const actor: PrincipalView = TEST_FEISHU_ACTOR;
const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanup.splice(0).forEach((fn) => fn());
});
function setup() {
  const database = initializeDatabase(":memory:");
  seedFeishuTestActor(database);
  const root = mkdtempSync(join(tmpdir(), "comment-attachments-"));
  cleanup.push(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });
  const identityService = new IdentityService({
    database,
    provider: new DevelopmentIdentityAdapter(),
    sessionTtlSeconds: 300,
  });
  identityService.ensureDevelopmentActor(DEVELOPMENT_IDENTITY);
  const project = new ProjectAdministration(database).createProject({
    projectKey: "FILES",
    name: "附件",
    description: "",
  });
  const taskboard = new Taskboard({ database, identityService });
  const workspace = new TaskWorkspace({ database, identityService, taskboard });
  const vault = new AttachmentVault({ rootDirectory: root });
  const service = new AttachmentService({ database, identityService, taskboard, vault });
  const queue = new ExecutionQueue({ database, dataDirectory: root });
  const context = () => ({ actor, idempotencyKey: randomUUID() });
  const newTask = () =>
    taskboard.createTask(
      CreateTaskCommandSchema.parse({ projectId: project.id, title: "附件任务" }),
      context(),
    ).task;
  const task = newTask();
  const upload = (commentId?: string, taskId = task.id) =>
    service.upload(
      taskId,
      {
        filename: "需求 [附件].txt",
        contentType: "text/plain",
        bytes: Buffer.from("attachment content"),
        ...(commentId ? { commentId } : {}),
      },
      context(),
    ).data;
  const comment = (body = "正文") => workspace.createComment(task.id, { body }, context()).data;
  const submit = () =>
    queue.submit(
      {
        taskId: task.id,
        kind: "start",
        maxAttempts: 2,
        executionKey: "/tmp",
        workContext: {
          projectId: project.id,
          cwd: root,
          prompt: "原始描述 https://example.com/spec",
        },
      },
      context(),
    );
  return {
    database,
    identityService,
    root,
    workspace,
    vault,
    service,
    queue,
    task,
    newTask,
    context,
    upload,
    comment,
    submit,
  };
}

it("accepts attachment-only comments, trims body and preserves the 100k limit", () => {
  expect(
    CreateCommentCommandSchema.parse({ body: " \n ", attachmentIds: [randomUUID()] }).body,
  ).toBe("");
  expect(CreateCommentCommandSchema.parse({ body: " body " }).body).toBe("body");
  expect(CreateCommentCommandSchema.safeParse({ body: " ", attachmentIds: [] }).success).toBe(
    false,
  );
  expect(CreateCommentCommandSchema.safeParse({ body: " " }).success).toBe(false);
  expect(CreateCommentCommandSchema.safeParse({ body: "x".repeat(100_000) }).success).toBe(true);
  expect(
    CreateCommentCommandSchema.safeParse({
      body: "x".repeat(100_001),
      attachmentIds: [randomUUID()],
    }).success,
  ).toBe(false);
  expect(
    CreateCommentCommandSchema.safeParse({ body: "", attachmentIds: ["invalid"] }).success,
  ).toBe(false);
});

it("atomically binds multiple uploads and replays without rebinding", () => {
  const s = setup();
  const ids = [s.upload().id, s.upload().id];
  const command = { body: "  ", attachmentIds: ids };
  const context = s.context();
  const result = s.workspace.createComment(s.task.id, command, context);
  expect(result.data.body).toBe("");
  expect(s.workspace.createComment(s.task.id, command, context)).toEqual(result);
  expect(
    s.workspace.readTaskWorkspace(s.task.id, actor).attachments.map((a) => a.commentId),
  ).toEqual([result.data.id, result.data.id]);
  expect(() =>
    s.workspace.createComment(s.task.id, { ...command, attachmentIds: [ids[0]!] }, context),
  ).toThrow(/幂等/);
});

it.each(["missing", "duplicate", "other-task", "other-uploader", "bound", "deleted-comment"])(
  "rolls back the full batch for %s attachment",
  (kind) => {
    const s = setup();
    const first = s.upload();
    let bad = s.upload();
    if (kind === "missing") bad = { ...bad, id: randomUUID() };
    if (kind === "duplicate") bad = first;
    if (kind === "other-task") bad = s.upload(undefined, s.newTask().id);
    if (kind === "other-uploader")
      s.database
        .prepare("UPDATE attachments SET uploader_identity_key = NULL WHERE id = ?")
        .run(bad.id);
    if (kind === "bound" || kind === "deleted-comment") {
      const c = s.comment();
      bad = s.upload(c.id);
      if (kind === "deleted-comment")
        s.workspace.deleteComment(c.id, { expectedVersion: c.version + 1 }, s.context());
    }
    const counts = () =>
      ["comments", "activities", "change_events", "request_idempotency"].map((table) =>
        s.database.prepare(`SELECT count(*) FROM ${table}`).pluck().get(),
      );
    const before = counts();
    expect(() =>
      s.workspace.createComment(
        s.task.id,
        { body: "", attachmentIds: [first.id, bad.id] },
        s.context(),
      ),
    ).toThrow(/附件/);
    expect(counts()).toEqual(before);
    expect(
      s.database.prepare("SELECT comment_id FROM attachments WHERE id = ?").pluck().get(first.id),
    ).toBeNull();
  },
);

it("requires comment author even for an admin and rejects missing, cross-task and deleted comments", () => {
  const s = setup();
  const c = s.comment();
  s.database.prepare("UPDATE comments SET author_identity_key = NULL WHERE id = ?").run(c.id);
  expect(() => s.upload(c.id)).toThrow(/自己评论/);
  expect(() => s.upload(randomUUID())).toThrow(/评论不存在/);
  const other = s.workspace.createComment(s.newTask().id, { body: "other" }, s.context()).data;
  expect(() => s.upload(other.id)).toThrow(/当前任务/);
  s.database
    .prepare("UPDATE comments SET author_identity_key = ? WHERE id = ?")
    .run(identityKey(actor.identity), c.id);
  const file = s.upload(c.id);
  s.database.prepare("UPDATE comments SET author_identity_key = NULL WHERE id = ?").run(c.id);
  expect(() => s.service.delete(file.id, s.context())).toThrow(/自己评论/);
  expect(s.service.open(file.id, actor).bytes.toString()).toBe("attachment content");
  s.database
    .prepare("UPDATE comments SET author_identity_key = ? WHERE id = ?")
    .run(identityKey(actor.identity), c.id);
  s.workspace.deleteComment(c.id, { expectedVersion: c.version + 1 }, s.context());
  expect(() => s.upload(c.id)).toThrow(/评论不存在/);
  expect(s.workspace.readTaskWorkspace(s.task.id, actor).attachments).toEqual([]);
  expect(() => s.service.open(file.id, actor)).toThrow(/附件不存在/);
  expect(() => s.service.delete(file.id, s.context())).toThrow(/附件不存在/);
  expect(s.database.prepare("SELECT count(*) FROM attachments").pluck().get()).toBe(1);
});

it.each(["executed_at", "deleted_at", "author_identity_key"])(
  "checks upload mutation inside transaction after vault store (%s)",
  (field) => {
    const s = setup();
    const c = s.comment();
    const store = s.vault.store.bind(s.vault);
    vi.spyOn(s.vault, "store").mockImplementation((upload) => {
      const stored = store(upload);
      s.database
        .prepare(`UPDATE comments SET ${field} = ? WHERE id = ?`)
        .run(field === "author_identity_key" ? null : new Date().toISOString(), c.id);
      return stored;
    });
    expect(() => s.upload(c.id)).toThrow();
    expect(s.database.prepare("SELECT count(*) FROM attachments").pluck().get()).toBe(0);
    expect(
      readdirSync(s.root, { recursive: true, withFileTypes: true }).filter((entry) =>
        entry.isFile(),
      ),
    ).toHaveLength(0);
  },
);

it("rechecks execution lock inside deletion transaction and restores quarantined bytes", () => {
  const s = setup();
  const c = s.comment();
  const file = s.upload(c.id);
  const quarantine = s.vault.quarantine.bind(s.vault);
  vi.spyOn(s.vault, "quarantine").mockImplementation((keys) => {
    const result = quarantine(keys);
    s.database
      .prepare("UPDATE comments SET executed_at = ? WHERE id = ?")
      .run(new Date().toISOString(), c.id);
    return result;
  });
  expect(() => s.service.delete(file.id, s.context())).toThrow(/已用于执行/);
  expect(s.service.open(file.id, actor).bytes.toString()).toBe("attachment content");
  // The injected lock was inside the same transaction and must roll back too.
  expect(
    s.database.prepare("SELECT executed_at FROM comments WHERE id = ?").pluck().get(c.id),
  ).toBeNull();
});

it("snapshots description and attachment-only comment files with usable download commands, then locks and preserves retry", () => {
  const s = setup();
  const description = s.upload();
  const file = s.upload();
  const c = s.workspace.createComment(
    s.task.id,
    { body: "", attachmentIds: [file.id] },
    s.context(),
  ).data;
  const deleted = s.comment("不应执行");
  const hidden = s.upload(deleted.id);
  s.workspace.deleteComment(deleted.id, { expectedVersion: deleted.version + 1 }, s.context());
  s.submit();
  const job = s.queue.claimNext("worker")!;
  expect(job.workContext.commentSnapshot).toEqual([{ id: c.id, version: 1 }]);
  expect(job.workContext.attachmentSnapshot).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ originalAttachmentId: file.id, commentId: c.id }),
      expect.objectContaining({ originalAttachmentId: description.id, commentId: null }),
    ]),
  );
  const prompt = String(job.workContext.prompt);
  expect(prompt).toContain("原始描述 https://example.com/spec");
  for (const attachment of job.workContext.attachmentSnapshot as {
    id: string;
    filename: string;
    downloadCommand: string;
  }[]) {
    expect(prompt).toContain(attachment.filename);
    expect(prompt).toContain(`/api/v1/local/attachments/${attachment.id}`);
    expect(attachment.downloadCommand.replaceAll("\\", "/")).toContain(
      `/.tmp/taskboard/${s.task.id}/attachment-${attachment.id}`,
    );
    expect(s.service.open(attachment.id, actor).bytes.toString()).toBe("attachment content");
  }
  expect(prompt).not.toContain(hidden.id);
  expect(() => s.upload(c.id)).toThrow("任务执行中");
  expect(
    s.workspace.readTaskWorkspace(s.task.id, actor).comments.find((comment) => comment.id === c.id)
      ?.version,
  ).toBe(1);
  s.queue.releaseForRetry(job.id, "worker", "INTERNAL_ERROR", "retry");
  s.comment("下一轮评论");
  const retried = s.queue.claimNext("worker");
  expect(retried?.workContext).toEqual(job.workContext);
});

it("includes task description attachments when there are no pending comments", () => {
  const s = setup();
  const file = s.upload();
  s.submit();
  expect(s.queue.claimNext("worker")?.workContext.attachmentSnapshot).toEqual([
    expect.objectContaining({ originalAttachmentId: file.id }),
  ]);
});

it("rejects deleting the final attachment of an empty comment but permits deleting the comment", () => {
  const s = setup();
  const first = s.upload();
  const second = s.upload();
  const c = s.workspace.createComment(
    s.task.id,
    { body: "", attachmentIds: [first.id, second.id] },
    s.context(),
  ).data;
  s.service.delete(first.id, s.context());
  expect(() => s.service.delete(second.id, s.context())).toThrow(/请直接删除评论/);
  expect(s.service.open(second.id, actor).bytes.toString()).toBe("attachment content");
  s.workspace.deleteComment(c.id, { expectedVersion: c.version + 1 }, s.context());
  expect(() => s.service.open(second.id, actor)).toThrow(/附件不存在/);
});

it("hides pending drafts from workspace and execution, protects ownership and clears marker on association", () => {
  const s = setup();
  const context = s.context();
  const upload = {
    filename: "draft.txt",
    contentType: "text/plain",
    bytes: Buffer.from("draft"),
    pendingComment: true,
  };
  const file = s.service.upload(s.task.id, upload, context);
  expect(s.service.upload(s.task.id, upload, context)).toEqual(file);
  expect(() => s.service.upload(s.task.id, { ...upload, pendingComment: false }, context)).toThrow(
    /幂等/,
  );
  expect(() =>
    s.service.upload(s.task.id, { ...upload, commentId: s.comment().id }, s.context()),
  ).toThrow(/草稿/);
  expect(s.workspace.readTaskWorkspace(s.task.id, actor).attachments).toEqual([]);
  expect(s.service.open(file.data.id, actor).bytes.toString()).toBe("draft");
  const otherActor = {
    ...actor,
    identity: { kind: "feishu" as const, tenantKey: "other", userId: "other" },
  };
  expect(() => s.service.open(file.data.id, otherActor)).toThrow();
  expect(() => s.service.delete(file.data.id, { ...context, actor: otherActor })).toThrow();
  s.submit();
  const job = s.queue.claimNext("worker")!;
  expect(String(job.workContext.prompt)).not.toContain(file.data.id);
  expect(
    s.database
      .prepare("SELECT pending_comment FROM attachments WHERE id = ?")
      .pluck()
      .get(file.data.id),
  ).toBe(1);
  const c = s.workspace.createComment(
    s.task.id,
    { body: "", attachmentIds: [file.data.id] },
    s.context(),
  ).data;
  expect(s.workspace.readTaskWorkspace(s.task.id, actor).attachments).toEqual([
    expect.objectContaining({ id: file.data.id, commentId: c.id }),
  ]);
  expect(
    s.database
      .prepare("SELECT pending_comment FROM attachments WHERE id = ?")
      .pluck()
      .get(file.data.id),
  ).toBe(0);
});

it("runs the snapshotted CLI from another cwd only with paired user auth and no global taskctl", async () => {
  const s = setup();
  const file = s.upload();
  s.submit();
  const job = s.queue.claimNext("worker")!;
  const snapshot = job.workContext.attachmentSnapshot as {
    id: string;
    downloadCommand: string;
    downloadPath: string;
  }[];
  const command = snapshot[0]!.downloadCommand;
  expect(command.replaceAll("\\", "/")).toContain("/packages/taskctl/dist/cli.js'");
  expect(command).toContain(`CODEXBOARD_DATA_DIR='${s.root}'`);
  const capabilityToken = "a".repeat(64);
  const cliAuth = new CliAuthService({
    identityVersion: (identity) => s.identityService.cliIdentityVersion(identity),
  });
  let authorized = false;
  const server = createServer((request, response) => {
    let userAuthorized = false;
    try {
      const token = request.headers["x-taskctl-session"];
      userAuthorized =
        typeof token === "string" &&
        identityKey(cliAuth.authenticate(token)) === identityKey(actor.identity);
    } catch {
      // The synthetic endpoint enforces the same independent user session boundary.
    }
    authorized =
      userAuthorized &&
      request.headers.authorization === `Bearer ${capabilityToken}` &&
      request.url === `/api/v1/local/attachments/${snapshot[0]!.id}`;
    response.statusCode = authorized ? 200 : 403;
    response.end(authorized ? s.service.open(snapshot[0]!.id, actor).bytes : "forbidden");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  mkdirSync(join(s.root, "run"));
  ensurePrivateDirectorySync(join(s.root, "run"));
  const runtime: RuntimeDescriptor = {
    descriptorVersion: 1,
    pid: process.pid,
    generatedAt: new Date().toISOString(),
    publicBaseUrl: "http://localhost",
    localAdminBaseUrl: `http://127.0.0.1:${address.port}`,
    capabilityToken,
  };
  writeFileSync(join(s.root, "run", "runtime.json"), JSON.stringify(runtime));
  const authFile = join(s.root, "run", "synthetic-taskctl-auth");
  const paths = credentialPaths(runtime, authFile);
  s.database
    .prepare("UPDATE jobs SET status = 'failed' WHERE task_id = ? AND status = 'running'")
    .run(s.task.id);
  s.service.delete(file.id, s.context());
  const outputPath = snapshot[0]!.downloadPath;
  try {
    const execute = () =>
      promisify(exec)(command, {
        cwd: tmpdir(),
        ...(process.platform === "win32"
          ? {
              shell: join(
                process.env.SystemRoot ?? "C:\\Windows",
                "System32",
                "WindowsPowerShell",
                "v1.0",
                "powershell.exe",
              ),
            }
          : {}),
        env: { ...process.env, PATH: "/nonexistent", CODEXBOARD_AUTH_FILE: authFile },
      });
    await expect(execute()).rejects.toMatchObject({ code: 1 });
    expect(authorized).toBe(false);
    const request = cliAuth.create("attachment-cli-test");
    cliAuth.approve(
      request.requestId,
      s.identityService.authenticatedUserPrincipal(actor.identity).identity,
    );
    const session = cliAuth.complete(request.requestId, request.claimSecret);
    if (!("token" in session)) throw new Error("missing CLI session");
    await defaultCredentialStore.write(
      paths.session,
      JSON.stringify({
        scope: paths.scope,
        token: session.token,
        identity: session.identity,
        expiresAt: session.expiresAt,
      }),
    );
    await execute();
    expect(authorized).toBe(true);
    expect(readFileSync(outputPath, "utf8")).toBe("attachment content");
  } finally {
    rmSync(outputPath, { force: true });
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("uses executor-visible paths for attachments when the server runs in Docker", () => {
  const s = setup();
  const attachment = s.upload();
  const queue = new ExecutionQueue({
    database: s.database,
    dataDirectory: "/var/lib/codexboard",
    executorNodePath: "/opt/homebrew/bin/node",
    executorTaskctlPath: "/Users/example/Task Board/packages/taskctl/dist/cli.js",
    executorDataDirectory: "/Users/example/Library/Application Support/Taskboard/data",
  });
  queue.submit(
    {
      taskId: s.task.id,
      kind: "start",
      executionKey: "/tmp",
      workContext: { projectId: s.task.projectId, cwd: "/tmp", prompt: "执行附件" },
    },
    s.context(),
  );
  const prompt = String(queue.claimNext("worker")!.workContext.prompt);
  expect(prompt).toContain(
    "'/opt/homebrew/bin/node' '/Users/example/Task Board/packages/taskctl/dist/cli.js'",
  );
  expect(prompt).toContain(
    "CODEXBOARD_DATA_DIR='/Users/example/Library/Application Support/Taskboard/data'",
  );
  expect(queue.listTaskJobs(s.task.id)[0]!.workContext.attachmentSnapshot).toEqual([
    expect.objectContaining({ originalAttachmentId: attachment.id }),
  ]);
  expect(prompt).not.toContain("/var/lib/codexboard");
});

it("locks comment attachments during execution and keeps executed comments immutable after success", () => {
  const s = setup();
  const c = s.comment();
  const file = s.upload(c.id);
  s.submit();
  const job = s.queue.claimNext("worker")!;
  expect(() => s.upload(c.id)).toThrow("任务执行中");
  expect(() => s.service.delete(file.id, s.context())).toThrow("任务执行中");
  s.queue.succeedAndRequestReview(job.id, "worker");
  expect(() => s.upload(c.id)).toThrow(/已用于执行/);
  expect(() => s.service.delete(file.id, s.context())).toThrow(/已用于执行/);
});

it("keeps authorized immutable attachment downloads after deleting originals and comments", () => {
  const s = setup();
  const c = s.comment();
  const original = s.upload(c.id);
  const submitted = s.submit();
  const snapshot = (
    submitted.workContext.attachmentSnapshot as { id: string; originalAttachmentId: string }[]
  )[0]!;
  expect(snapshot.id).not.toBe(original.id);
  expect(() => s.service.delete(original.id, s.context())).toThrow("任务执行中");
  s.queue.claimNext("worker");
  s.queue.releaseForRetry(submitted.id, "worker", "NOT_SENT", "retry");
  expect(s.queue.claimNext("worker")!.workContext).toEqual(submitted.workContext);
  s.queue.fail(submitted.id, "worker", "NOT_SENT", "failed before execution");
  s.service.delete(original.id, s.context());
  s.workspace.deleteComment(c.id, { expectedVersion: 3 }, s.context());
  expect(() => s.service.open(original.id, actor)).toThrow(/不存在/);
  expect(s.service.open(snapshot.id, actor).bytes.toString()).toBe("attachment content");
  expect(() => s.service.delete(snapshot.id, s.context())).toThrow(/快照/);
  expect(() =>
    s.service.open(snapshot.id, {
      ...actor,
      identity: { kind: "feishu", tenantKey: "other", userId: "other" },
      role: "member",
    }),
  ).toThrow();
});

it.each(["queued", "running", "succeeded"])(
  "locks description attachment upload and removal for %s but allows comment drafts",
  (status) => {
    const s = setup();
    const file = s.upload();
    const job = s.submit();
    if (status !== "queued") s.queue.claimNext("worker");
    if (status === "succeeded") s.queue.succeed(job.id, "worker");
    expect(() => s.upload()).toThrow("任务描述已锁定");
    expect(() => s.service.delete(file.id, s.context())).toThrow("任务描述已锁定");
    expect(() =>
      s.service.upload(
        s.task.id,
        {
          filename: "后续评论.txt",
          contentType: "text/plain",
          bytes: Buffer.from("补充"),
          pendingComment: true,
        },
        s.context(),
      ),
    ).not.toThrow();
    expect(s.service.open(file.id, actor)).toBeDefined();
  },
);

it.each(["queued", "running", "waiting_approval", "waiting_input", "canceling"])(
  "blocks changes to unexecuted comments and their attachments while %s, then unlocks them",
  (status) => {
    const s = setup();
    const c = s.comment("后续补充");
    const file = s.upload(c.id);
    const job = s.submit();
    if (status !== "queued") s.queue.claimNext("worker");
    s.database.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(status, job.id);
    expect(s.comment("执行中的新补充").executedAt).toBeNull();
    expect(c.executedAt).toBeNull();
    expect(() =>
      s.workspace.updateComment(c.id, { expectedVersion: c.version, body: "修改" }, s.context()),
    ).toThrow("任务执行中");
    expect(() =>
      s.workspace.deleteComment(c.id, { expectedVersion: c.version }, s.context()),
    ).toThrow("任务执行中");
    expect(() => s.upload(c.id)).toThrow("任务执行中");
    expect(() => s.service.delete(file.id, s.context())).toThrow("任务执行中");
    expect(
      s.workspace.readTaskWorkspace(s.task.id, actor).comments.find((value) => value.id === c.id)
        ?.body,
    ).toBe("后续补充");
    s.database.prepare("UPDATE jobs SET status = 'canceled' WHERE id = ?").run(job.id);
    s.service.delete(file.id, s.context());
    const current = s.workspace
      .readTaskWorkspace(s.task.id, actor)
      .comments.find((value) => value.id === c.id)!;
    const updated = s.workspace.updateComment(
      c.id,
      { expectedVersion: current.version, body: "修改" },
      s.context(),
    ).data;
    expect(
      s.workspace.deleteComment(c.id, { expectedVersion: updated.version }, s.context()).data
        .deletedAt,
    ).not.toBeNull();
  },
);
