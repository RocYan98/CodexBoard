import { identityKey } from "@codexboard/contracts";
import { seedFeishuTestActor, TEST_FEISHU_ACTOR } from "./helpers/identity.js";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateTaskCommandSchema,
  CreateCommentCommandSchema,
  type PrincipalView,
} from "@codexboard/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { initializeDatabase, type SqliteDatabase } from "../src/modules/database/index.js";
import {
  DevelopmentIdentityAdapter,
  DEVELOPMENT_IDENTITY,
  IdentityService,
} from "../src/modules/identity/index.js";
import { ProjectAdministration } from "../src/modules/project-registry/index.js";
import { ExecutionQueue } from "../src/modules/execution/index.js";
import { Taskboard, TaskWorkspace } from "../src/modules/taskboard/index.js";
import { TaskLifecycleService } from "../src/modules/taskboard/task-lifecycle-service.js";
import { TaskGitFinalizer } from "../src/modules/taskboard/task-git-finalizer.js";
import { canonicalWorkspace } from "../src/modules/taskboard/task-lifecycle-guard.js";

const databases: SqliteDatabase[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const actor: PrincipalView = {
  identity: TEST_FEISHU_ACTOR.identity,
  name: "本机管理员",
  avatarUrl: null,
  role: "admin",
};
function context(key = randomUUID()) {
  return { actor, idempotencyKey: key };
}
function setup() {
  const database = initializeDatabase(":memory:");
  databases.push(database);
  const identityService = new IdentityService({
    database,
    provider: new DevelopmentIdentityAdapter(),
    sessionTtlSeconds: 300,
  });
  identityService.ensureDevelopmentActor(DEVELOPMENT_IDENTITY);
  seedFeishuTestActor(database, actor);
  const project = new ProjectAdministration(database).createProject({
    projectKey: "LIFE",
    name: "生命周期",
    description: "",
  });
  const taskboard = new Taskboard({ database, identityService });
  const workspace = new TaskWorkspace({ database, identityService, taskboard });
  const task = taskboard.createTask(
    CreateTaskCommandSchema.parse({ projectId: project.id, title: "收尾任务" }),
    context(),
  ).task;
  database.prepare("UPDATE tasks SET status = 'in_review' WHERE id = ?").run(task.id);
  const queue = new ExecutionQueue({ database });
  const service = new TaskLifecycleService({
    database,
    taskboard,
    queue,
    gitFinalizer: new TaskGitFinalizer([]),
    scheduleExecution: () => {},
  });
  return {
    database,
    taskboard,
    workspace,
    task: taskboard.readTask(task.id, actor),
    queue,
    service,
  };
}

it("finishes a task without a Git workspace and replays completion without another version change", async () => {
  const { service, task, taskboard } = setup();
  const command = { targetStatus: "done" as const, expectedVersion: task.version };
  const ctx = context();
  const operation = service.request(task.id, command, ctx);
  const result = await service.wait(operation.id);
  expect(result.task.status).toBe("done");
  const replay = service.request(task.id, command, ctx);
  expect(replay.status).toBe("succeeded");
  expect((await service.wait(replay.id)).task.version).toBe(result.task.version);
  expect(taskboard.readTask(task.id, actor).status).toBe("done");
});

it("does not start completion when unexecuted comments exist", () => {
  const { service, workspace, task, database } = setup();
  workspace.createComment(
    task.id,
    CreateCommentCommandSchema.parse({ body: "还需要修改" }),
    context(),
  );
  expect(() =>
    service.request(task.id, { targetStatus: "done", expectedVersion: task.version }, context()),
  ).toThrow();
  expect(database.prepare("SELECT COUNT(*) AS n FROM task_lifecycle_operations").get()).toEqual({
    n: 0,
  });
});

it("cancels queued execution before marking the task canceled and blocks edits while cancellation is pending", async () => {
  const { service, task, taskboard, queue, workspace } = setup();
  const job = queue.submit(
    {
      taskId: task.id,
      kind: "start",
      executionKey: "cwd:/tmp",
      workContext: { cwd: "/tmp", prompt: "task" },
    },
    context(),
  );
  const current = taskboard.readTask(task.id, actor);
  const operation = service.request(
    task.id,
    { targetStatus: "canceled", expectedVersion: current.version },
    context(),
  );
  expect(() =>
    workspace.createComment(task.id, CreateCommentCommandSchema.parse({ body: "race" }), context()),
  ).toThrow("任务正在取消或收尾");
  expect((await service.wait(operation.id)).task.status).toBe("canceled");
  expect(queue.readJob(job.id).status).toBe("canceled");
});

it("retains a failed completion for retry rather than marking the task done", async () => {
  const { database, task, service, taskboard } = setup();
  database
    .prepare("UPDATE projects SET workspace_realpath = '/missing-worktree' WHERE id = ?")
    .run(task.projectId);
  const operation = service.request(
    task.id,
    { targetStatus: "done", expectedVersion: task.version },
    context(),
  );
  await expect(service.wait(operation.id)).rejects.toThrow();
  expect(service.readLatest(task.id, actor)?.status).toBe("failed");
  expect(taskboard.readTask(task.id, actor).status).toBe(task.status);
  // Cancellation abandons failed completion, but cannot bypass the workspace check.
  const canceled = service.request(
    task.id,
    { targetStatus: "canceled", expectedVersion: task.version },
    context(),
  );
  await expect(service.wait(canceled.id)).rejects.toThrow();
  expect(taskboard.readTask(task.id, actor).status).toBe(task.status);
  expect(service.readLatest(task.id, actor)?.errorSummary).toContain("任务未取消");
});

it.each(["backlog", "todo", "in_progress", "in_review", "blocked"] as const)(
  "restores the status before cancellation: %s",
  async (status) => {
    const { database, service, taskboard, task } = setup();
    database
      .prepare("UPDATE tasks SET status = ?, blocked_from_status = ? WHERE id = ?")
      .run(status, status === "blocked" ? "in_review" : null, task.id);
    const operation = service.request(
      task.id,
      { targetStatus: "canceled", expectedVersion: task.version },
      context(),
    );
    const canceled = (await service.wait(operation.id)).task;
    const ctx = context();
    const command = { expectedVersion: canceled.version };
    const restored = taskboard.restoreTask(task.id, command, ctx).task;
    expect(restored).toMatchObject({
      status,
      blockedFromStatus: status === "blocked" ? "in_review" : null,
    });
    expect(taskboard.restoreTask(task.id, command, ctx).task.version).toBe(restored.version);
    const second = service.request(
      task.id,
      { targetStatus: "canceled", expectedVersion: restored.version },
      context(),
    );
    const canceledAgain = (await service.wait(second.id)).task;
    expect(
      taskboard.restoreTask(task.id, { expectedVersion: canceledAgain.version }, context()).task
        .status,
    ).toBe(status);
  },
);

it("requires a clean main checkout even with execution evidence and never commits changes", async () => {
  const { database, taskboard, task, queue } = setup();
  const root = mkdtempSync(join(tmpdir(), "lifecycle-evidence-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.test");
  writeFileSync(join(root, "app.txt"), "initial");
  git("add", ".");
  git("commit", "-m", "initial");
  database
    .prepare("UPDATE projects SET workspace_realpath = ? WHERE id = ?")
    .run(root, task.projectId);
  const job = queue.submit(
    {
      taskId: task.id,
      kind: "start",
      executionKey: root,
      workContext: { cwd: root, prompt: "implement" },
    },
    context(),
  );
  queue.claimNext("worker");
  await queue.captureWorkspaceStart(job.id);
  writeFileSync(join(root, "app.txt"), "implemented");
  await queue.captureWorkspaceStop(job.id);
  queue.succeed(job.id, "worker");
  database.prepare("UPDATE tasks SET status = 'in_review' WHERE id = ?").run(task.id);
  const service = new TaskLifecycleService({
    database,
    taskboard,
    queue,
    gitFinalizer: new TaskGitFinalizer([root]),
    scheduleExecution: () => {},
  });
  const operation = service.request(
    task.id,
    { expectedVersion: taskboard.readTask(task.id, actor).version, targetStatus: "done" },
    context(),
  );
  await expect(service.wait(operation.id)).rejects.toThrow("Git 不干净");
  expect(taskboard.readTask(task.id, actor).status).toBe("in_review");
  expect(git("status", "--porcelain")).not.toBe("");
  expect(git("show", "HEAD:app.txt")).toBe("initial");
  git("commit", "-am", "user commits changes");
  service.request(
    task.id,
    { expectedVersion: taskboard.readTask(task.id, actor).version, targetStatus: "done" },
    context(),
  );
  expect((await service.wait(operation.id)).task.status).toBe("done");
  expect(service.readLatest(task.id, actor)?.commitSha).toBeNull();
});

it("rejects terminal operations on an archived project", () => {
  const { database, task, service } = setup();
  database
    .prepare("UPDATE projects SET archived_at = ? WHERE id = ?")
    .run(new Date().toISOString(), task.projectId);
  expect(() =>
    service.request(task.id, { expectedVersion: task.version, targetStatus: "done" }, context()),
  ).toThrow("已归档项目");
  expect(() =>
    service.request(
      task.id,
      { expectedVersion: task.version, targetStatus: "canceled" },
      context(),
    ),
  ).toThrow("已归档项目");
});

it("blocks restoring another completed task while its workspace is being finalized", () => {
  const { database, task, taskboard } = setup();
  const workspace = canonicalWorkspace(tmpdir());
  database
    .prepare("UPDATE projects SET workspace_realpath = ? WHERE id = ?")
    .run(workspace, task.projectId);
  const completed = taskboard.moveTask(
    task.id,
    { expectedVersion: task.version, targetStatus: "done" },
    context(),
  ).task;
  const opId = randomUUID();
  database
    .prepare(
      "INSERT INTO task_lifecycle_operations (id, task_id, identity_key, idempotency_key, request_hash, target_status, status, phase, expected_version, created_at, updated_at) VALUES (?, ?, ?, 'test', 'test', 'done', 'succeeded', 'completed', 1, ?, ?)",
    )
    .run(
      opId,
      task.id,
      identityKey(actor.identity),
      new Date().toISOString(),
      new Date().toISOString(),
    );
  database
    .prepare("INSERT INTO task_lifecycle_resources (resource_key, operation_id) VALUES (?, ?)")
    .run(`cwd:${workspace}`, opId);
  expect(() =>
    taskboard.moveTask(
      task.id,
      { expectedVersion: completed.version, targetStatus: "todo" },
      context(),
    ),
  ).toThrow("该工作区正在执行任务收尾");
});

it("checks project mutability before replayed Git work", async () => {
  const { database, taskboard, task, queue } = setup();
  database
    .prepare("UPDATE projects SET workspace_realpath = '/tmp' WHERE id = ?")
    .run(task.projectId);
  const inspect = vi.fn().mockRejectedValue(new Error("first attempt fails"));
  const service = new TaskLifecycleService({
    database,
    taskboard,
    queue,
    gitFinalizer: { inspect, verify: vi.fn() },
    scheduleExecution: () => {},
  });
  const ctx = context();
  const command = { expectedVersion: task.version, targetStatus: "done" as const };
  const first = service.request(task.id, command, ctx);
  await expect(service.wait(first.id)).rejects.toThrow();
  database
    .prepare("UPDATE projects SET archived_at = ? WHERE id = ?")
    .run(new Date().toISOString(), task.projectId);
  service.request(task.id, command, ctx);
  await expect(service.wait(first.id)).rejects.toThrow("归档");
  expect(inspect).toHaveBeenCalledTimes(1);
});

it("completes a non-Git task directory and preserves its deliverables", async () => {
  const { database, taskboard, task, queue } = setup();
  const root = mkdtempSync(join(tmpdir(), "plain-lifecycle-"));
  roots.push(root);
  writeFileSync(join(root, "document.txt"), "deliverable");
  database
    .prepare("UPDATE projects SET workspace_realpath = ? WHERE id = ?")
    .run(root, task.projectId);
  const service = new TaskLifecycleService({
    database,
    taskboard,
    queue,
    gitFinalizer: new TaskGitFinalizer([root]),
    scheduleExecution: () => {},
  });
  const operation = service.request(
    task.id,
    { expectedVersion: task.version, targetStatus: "done" },
    context(),
  );
  expect((await service.wait(operation.id)).task.status).toBe("done");
  expect(service.readLatest(task.id, actor)?.commitSha).toBeNull();
});

it.each(["backlog", "todo", "in_progress", "blocked", "done", "canceled"])(
  "rejects completion from %s",
  (status) => {
    const { database, task, service } = setup();
    database
      .prepare("UPDATE tasks SET status = ?, blocked_from_status = ? WHERE id = ?")
      .run(status, status === "blocked" ? "in_progress" : null, task.id);
    expect(() =>
      service.request(task.id, { targetStatus: "done", expectedVersion: task.version }, context()),
    ).toThrow(status === "done" || status === "canceled" ? "只读" : "只有待验收状态的任务才能完成");
  },
);

it.each(["queued", "running", "waiting_approval", "waiting_input", "canceling", "succeeded"])(
  "locks description for %s execution",
  (status) => {
    const { database, task, taskboard, queue } = setup();
    const job = queue.submit(
      {
        taskId: task.id,
        kind: "start",
        executionKey: "cwd:/tmp",
        workContext: { cwd: "/tmp", prompt: "task" },
      },
      context(),
    );
    if (status !== "queued")
      database.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(job.id);
    if (!["queued", "running"].includes(status))
      database.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(status, job.id);
    const current = taskboard.readTask(task.id, actor);
    expect(() =>
      taskboard.updateTask(
        task.id,
        { expectedVersion: current.version, description: "changed" },
        context(),
      ),
    ).toThrow("任务描述已锁定");
  },
);

it("keeps description locked after an earlier success even when the latest run fails", () => {
  const { database, task, taskboard, queue, workspace } = setup();
  const submit = (kind: "start" | "continue") =>
    queue.submit(
      {
        taskId: task.id,
        kind,
        executionKey: "cwd:/tmp",
        workContext: { cwd: "/tmp", prompt: "task" },
      },
      context(),
    );
  const first = submit("start");
  queue.claimNext("worker");
  queue.succeed(first.id, "worker");
  workspace.createComment(
    task.id,
    CreateCommentCommandSchema.parse({ body: "后续修改" }),
    context(),
  );
  const next = submit("continue");
  queue.claimNext("worker");
  database.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(next.id);
  const current = taskboard.readTask(task.id, actor);
  expect(current.descriptionLocked).toBe(true);
  expect(() =>
    taskboard.updateTask(
      task.id,
      { expectedVersion: current.version, description: "changed" },
      context(),
    ),
  ).toThrow("任务描述已锁定");
});

it.each(
  ["legacy", "context"].flatMap((source) =>
    (["done", "canceled"] as const).map((targetStatus) => ({ source, targetStatus })),
  ),
)(
  "checks externally deleted worktrees using $source metadata for $targetStatus without a receipt",
  async ({ source, targetStatus }) => {
    const { database, taskboard, task, queue } = setup();
    const root = mkdtempSync(join(tmpdir(), "lifecycle-check-only-"));
    roots.push(root);
    const main = join(root, "main");
    const worktree = join(root, "task");
    mkdirSync(main);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", main, ...args], { encoding: "utf8" }).trim();
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.test");
    writeFileSync(join(main, "source.txt"), "initial");
    git("add", ".");
    git("commit", "-m", "initial");
    git("worktree", "add", "-b", "feature/task", worktree);
    database
      .prepare("UPDATE projects SET workspace_realpath = ? WHERE id = ?")
      .run(main, task.projectId);
    database
      .prepare("INSERT INTO task_threads (id,task_id,thread_id,cwd,is_primary) VALUES (?,?,?,?,1)")
      .run(randomUUID(), task.id, randomUUID(), worktree);
    const service = new TaskLifecycleService({
      database,
      taskboard,
      queue,
      gitFinalizer: new TaskGitFinalizer([root]),
      scheduleExecution: () => {},
    });
    const operation = service.request(
      task.id,
      { expectedVersion: task.version, targetStatus },
      context(),
    );
    await expect(service.wait(operation.id)).rejects.toThrow("工作树尚未删除");
    expect(existsSync(worktree)).toBe(true);
    expect(taskboard.readTask(task.id, actor).status).toBe(task.status);
    expect(
      database
        .prepare("SELECT COUNT(*) FROM task_lifecycle_resources WHERE operation_id = ?")
        .pluck()
        .get(operation.id),
    ).toBe(0);
    if (source === "context") {
      const contextId = randomUUID();
      database
        .prepare(
          `INSERT INTO project_development_contexts
      (id, project_id, context_key, kind, label, branch, worktree_realpath, active, scanned_at)
      VALUES (?, ?, ?, 'worktree', 'task', 'feature/task', ?, 0, ?)`,
        )
        .run(contextId, task.projectId, contextId, worktree, new Date().toISOString());
      database
        .prepare("UPDATE tasks SET development_context_json = ? WHERE id = ?")
        .run(JSON.stringify({ id: contextId }), task.id);
    }
    // A persisted old checkpoint must not resume commits or depend on an archive/delivery ref.
    database
      .prepare(
        "UPDATE task_lifecycle_operations SET phase = 'cleaning', snapshot_json = ? WHERE id = ?",
      )
      .run(
        JSON.stringify({
          cwd: worktree,
          branch: "feature/task",
          commitSha: "old-sha",
          archiveRef: "refs/old",
        }),
        operation.id,
      );
    git("worktree", "remove", worktree);
    service.request(task.id, { expectedVersion: task.version, targetStatus }, context());
    await expect(service.wait(operation.id)).rejects.toThrow("分支尚未删除");
    git("branch", "-d", "feature/task");
    if (source === "context")
      database
        .prepare("UPDATE task_lifecycle_operations SET snapshot_json = NULL WHERE id = ?")
        .run(operation.id);
    service.request(task.id, { expectedVersion: task.version, targetStatus }, context());
    expect((await service.wait(operation.id)).task.status).toBe(targetStatus);
    expect(service.readLatest(task.id, actor)).toMatchObject({
      status: "succeeded",
      phase: "completed",
      commitSha: null,
      archiveRef: null,
    });
    if (targetStatus === "canceled") {
      const canceled = taskboard.readTask(task.id, actor);
      const restored = taskboard.restoreTask(
        task.id,
        { expectedVersion: canceled.version },
        context(),
      ).task;
      expect(restored.status).toBe(task.status);
      expect(restored.developmentContextId).toBe(canceled.developmentContextId);
      expect(existsSync(worktree)).toBe(false);
    }
    expect(git("for-each-ref", "--format=%(refname)", "refs/taskboard")).toBe("");
  },
);

it.each(["done", "canceled"] as const)(
  "releases failed %s locks on restart so Git cleanup remains available",
  async (targetStatus) => {
    const { database, task, service } = setup();
    database
      .prepare("UPDATE projects SET workspace_realpath = '/missing-worktree' WHERE id = ?")
      .run(task.projectId);
    const operation = service.request(
      task.id,
      { targetStatus, expectedVersion: task.version },
      context(),
    );
    await expect(service.wait(operation.id)).rejects.toThrow();
    database
      .prepare(
        "INSERT INTO task_lifecycle_resources (resource_key, operation_id) VALUES ('repo:/old', ?)",
      )
      .run(operation.id);
    await service.resumePending();
    expect(
      database
        .prepare("SELECT COUNT(*) FROM task_lifecycle_resources WHERE operation_id = ?")
        .pluck()
        .get(operation.id),
    ).toBe(0);
    expect(service.readLatest(task.id, actor)?.status).toBe("failed");
  },
);
