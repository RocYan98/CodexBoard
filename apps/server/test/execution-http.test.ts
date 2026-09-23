import { identityKey } from "@codexboard/contracts";
import { seedFeishuTestActor, TEST_FEISHU_IDENTITY } from "./helpers/identity.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appControl, createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { CodexExecutionCallbacks, CodexExecutor } from "../src/modules/execution/index.js";
import { initializeDatabase, type SqliteDatabase } from "../src/modules/database/index.js";
import { ProjectAdministration, ProjectRegistry } from "../src/modules/project-registry/index.js";
import { FakeThreadProvisioner } from "./fake-thread-provisioner.js";

const openApps: FastifyInstance[] = [];
const openDatabases: SqliteDatabase[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  for (const database of openDatabases.splice(0)) {
    if (database.open) database.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class ApprovalExecutor implements CodexExecutor {
  approvals = true;
  readonly continuedThreadIds: string[] = [];
  readonly continuedPrompts: string[] = [];

  async start(
    _input: { readonly cwd: string; readonly prompt: string },
    callbacks: CodexExecutionCallbacks,
  ) {
    return this.#execute(callbacks, "thread-http", `turn-${crypto.randomUUID()}`);
  }

  async continue(
    input: { readonly threadId: string; readonly cwd: string; readonly prompt: string },
    callbacks: CodexExecutionCallbacks,
  ) {
    this.continuedThreadIds.push(input.threadId);
    this.continuedPrompts.push(input.prompt);
    return this.#execute(callbacks, input.threadId, `turn-${crypto.randomUUID()}`);
  }

  async interrupt(): Promise<void> {}

  async #execute(callbacks: CodexExecutionCallbacks, threadId: string, turnId: string) {
    callbacks.onThread(threadId);
    callbacks.onTurn(turnId);
    if (this.approvals) {
      const decision = await callbacks.onInteraction({
        id: "approval-http",
        method: "item/commandExecution/requestApproval",
        params: { threadId, turnId, command: "npm test", reason: "运行项目测试" },
        async respond() {},
        async fail() {},
      });
      if (decision.type !== "accept") throw new Error("审批未允许");
    }
    callbacks.onEvent({
      cursor: `${turnId}:agent-message`,
      kind: "codex.agent_message",
      summary: "HTTP 执行完成",
      safePayload: { phase: "final_answer" },
    });
    return { threadId, turnId, status: "completed" as const };
  }
}

class BlockingExecutor implements CodexExecutor {
  #released = false;
  readonly interruptions: { readonly threadId: string; readonly turnId: string }[] = [];
  readonly #active = new Map<
    string,
    {
      readonly threadId: string;
      readonly resolve: (result: {
        readonly threadId: string;
        readonly turnId: string;
        readonly status: "completed" | "interrupted";
      }) => void;
    }
  >();

  get activeCount(): number {
    return this.#active.size;
  }

  async start(
    _input: { readonly cwd: string; readonly prompt: string },
    callbacks: CodexExecutionCallbacks,
  ) {
    const threadId = `thread-blocking-${crypto.randomUUID()}`;
    return this.#block(callbacks, threadId);
  }

  async continue(
    input: { readonly threadId: string; readonly cwd: string; readonly prompt: string },
    callbacks: CodexExecutionCallbacks,
  ) {
    return this.#block(callbacks, input.threadId);
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    this.interruptions.push({ threadId, turnId });
    const active = this.#active.get(turnId);
    if (!active) return;
    this.#active.delete(turnId);
    active.resolve({ threadId, turnId, status: "interrupted" });
  }

  completeAll(): void {
    this.#released = true;
    for (const [turnId, active] of this.#active) {
      active.resolve({ threadId: active.threadId, turnId, status: "completed" });
    }
    this.#active.clear();
  }

  async #block(callbacks: CodexExecutionCallbacks, threadId: string) {
    const turnId = `turn-blocking-${crypto.randomUUID()}`;
    callbacks.onThread(threadId);
    callbacks.onTurn(turnId);
    if (this.#released) return { threadId, turnId, status: "completed" as const };
    return new Promise<{
      readonly threadId: string;
      readonly turnId: string;
      readonly status: "completed" | "interrupted";
    }>((resolve) => {
      this.#active.set(turnId, { threadId, resolve });
    });
  }
}

function cookieHeader(response: Awaited<ReturnType<FastifyInstance["inject"]>>): string {
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function setup(executor?: CodexExecutor, projectCount = 1) {
  const root = mkdtempSync(join(tmpdir(), "codexboard-execution-http-"));
  temporaryDirectories.push(root);
  const database = initializeDatabase(":memory:");
  openDatabases.push(database);
  const administration = new ProjectAdministration(database);
  const registry = new ProjectRegistry(database, [root]);
  const projects = [];
  for (let index = 0; index < projectCount; index += 1) {
    const repository = join(root, `repository-${index + 1}`);
    mkdirSync(repository);
    execFileSync("git", ["-C", repository, "init", "-b", "main"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Taskboard Test"]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.test"]);
    writeFileSync(join(repository, "README.md"), `# Execution test ${index + 1}\n`, "utf8");
    execFileSync("git", ["-C", repository, "add", "README.md"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);
    const project = administration.createProject({
      projectKey: `CX${String.fromCharCode(65 + index)}`,
      name: `Codex HTTP ${index + 1}`,
      description: "",
    });
    await registry.registerWorkspace(project.id, {
      absolutePath: repository,
      expectedVersion: project.version,
    });
    projects.push(project);
  }
  const config = loadConfig({
    CODEXBOARD_ENV: "test",
    CODEXBOARD_WORKSPACE_ROOTS: root,
  });
  const app = createApp({
    config,
    database,
    projectRegistry: registry,
    codexThreadProvisioner: new FakeThreadProvisioner(),
    ...(executor ? { codexExecutor: executor } : {}),
  });
  openApps.push(app);
  const trusted = { host: "127.0.0.1:47823", origin: "http://localhost:5173" };
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/development",
    headers: trusted,
  });
  seedFeishuTestActor(database);
  database.prepare("UPDATE sessions SET identity_key = ?").run(identityKey(TEST_FEISHU_IDENTITY));
  const cookies = cookieHeader(login);
  const csrfToken = login.json().data.csrfToken as string;
  const tasks = [];
  for (const [index, project] of projects.entries()) {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: {
        ...trusted,
        cookie: cookies,
        "x-csrf-token": csrfToken,
        "idempotency-key": `execution-http-task-${index + 1}`,
      },
      payload: { projectId: project.id, title: `执行 HTTP 纵切 ${index + 1}`, status: "todo" },
    });
    tasks.push(created.json().data as { id: string });
  }
  return {
    app,
    database,
    projects,
    task: tasks[0]!,
    tasks,
    headers: { ...trusted, cookie: cookies, "x-csrf-token": csrfToken },
  };
}

describe("Codex execution HTTP routes", () => {
  it("returns comment execution metadata and rejects edits and deletes after continuing", async () => {
    const executor = new ApprovalExecutor();
    executor.approvals = false;
    const { app, task, headers } = await setup(executor);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/comments`,
      headers: { ...headers, "idempotency-key": "http-comment-pending" },
      payload: { body: "HTTP 评论需求" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data).toMatchObject({ executedAt: null, codexThreadId: null });
    const comment = created.json().data;
    const continued = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/jobs/continue`,
      headers: { ...headers, "idempotency-key": "http-comment-continue" },
      payload: {},
    });
    expect(continued.statusCode).toBe(202);
    await vi.waitFor(async () => {
      const result = await app.inject({
        method: "GET",
        url: `/api/v1/jobs/${continued.json().data.id}`,
        headers,
      });
      expect(result.json().data.status).toBe("succeeded");
    });
    expect(executor.continuedPrompts[0]).toContain("HTTP 评论需求");
    for (const method of ["PATCH", "DELETE"] as const) {
      const result = await app.inject({
        method,
        url: `/api/v1/comments/${comment.id}`,
        headers: { ...headers, "idempotency-key": `locked-comment-${method}` },
        payload: {
          expectedVersion: comment.version,
          ...(method === "PATCH" ? { body: "修改锁定内容" } : {}),
        },
      });
      expect(result.statusCode).toBe(409);
      expect(result.json().error.message).toContain("执行");
    }
    const view = await app.inject({
      method: "GET",
      url: `/api/v1/tasks/${task.id}/workspace`,
      headers,
    });
    expect(view.statusCode).toBe(200);
    expect(view.json().data.comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: comment.id, executedAt: expect.any(String) }),
        expect.objectContaining({ source: "codex", codexThreadId: executor.continuedThreadIds[0] }),
      ]),
    );
  });

  it("rejects starting temporary history but continues an existing Thread from its cwd", async () => {
    const executor = new ApprovalExecutor();
    executor.approvals = false;
    const { app, database, projects, task, headers } = await setup(executor);
    const sourceProjectId = projects[0]!.id;
    const sourceTaskNumber = database
      .prepare("SELECT task_number FROM tasks WHERE id = ?")
      .pluck()
      .get(task.id) as number;
    const sourceCwd = database
      .prepare("SELECT workspace_realpath FROM projects WHERE id = ?")
      .pluck()
      .get(sourceProjectId) as string;
    database.pragma("defer_foreign_keys = ON");
    database.prepare("DELETE FROM task_threads WHERE task_id = ?").run(task.id);
    database
      .prepare(
        `INSERT INTO project_orphaned_tasks (
          task_id, source_project_id, source_task_number, orphaned_at
        ) VALUES (?, ?, ?, ?)`,
      )
      .run(task.id, sourceProjectId, sourceTaskNumber, "2026-09-01T12:00:00.000Z");
    database
      .prepare(
        `UPDATE tasks SET project_id = ?, task_number = 1, version = version + 1 WHERE id = ?`,
      )
      .run("00000000-0000-4000-8000-0000000000a2", task.id);

    const start = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/jobs/start`,
      headers: { ...headers, "idempotency-key": "temporary-start-rejected" },
      payload: {},
    });
    expect(start.statusCode).toBe(409);
    expect(start.json().error.message).toMatch(/先分配到 Codex 项目/);

    database
      .prepare(
        `INSERT INTO task_threads (id, task_id, thread_id, cwd, is_primary)
        VALUES (?, ?, ?, ?, 1)`,
      )
      .run(crypto.randomUUID(), task.id, "thread-temporary-history", sourceCwd);
    const continued = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/jobs/continue`,
      headers: { ...headers, "idempotency-key": "temporary-continue-existing" },
      payload: {},
    });
    expect(continued.statusCode).toBe(202);
    await vi.waitFor(async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/jobs/${continued.json().data.id}`,
        headers,
      });
      expect(response.json().data.status).toBe("succeeded");
    });
    expect(executor.continuedThreadIds).toContain("thread-temporary-history");
  });

  it("starts the first Turn on a draft Thread, then continues it through durable APIs", async () => {
    const executor = new ApprovalExecutor();
    const { app, task, headers } = await setup(executor);
    const started = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/jobs/continue`,
      headers: { ...headers, "idempotency-key": "execution-http-start" },
      payload: {},
    });
    expect(started.statusCode).toBe(202);
    const jobId = started.json().data.id as string;

    let interactionId = "";
    await vi.waitFor(async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/jobs/${jobId}/interactions`,
        headers,
      });
      const interaction = response.json().data[0];
      expect(interaction).toMatchObject({ status: "pending", kind: "command_approval" });
      interactionId = interaction.id;
    });
    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/interactions/${interactionId}/respond`,
      headers: { ...headers, "idempotency-key": "execution-http-approve" },
      payload: { type: "accept" },
    });
    expect(approved.statusCode).toBe(200);
    await vi.waitFor(async () => {
      const response = await app.inject({ method: "GET", url: `/api/v1/jobs/${jobId}`, headers });
      expect(response.json().data.status).toBe("succeeded");
    });

    executor.approvals = false;
    const empty = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/jobs/continue`,
      headers: { ...headers, "idempotency-key": "execution-http-empty-continue" },
      payload: {},
    });
    expect(empty.statusCode).toBe(409);
    const continued = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/jobs/continue`,
      headers: { ...headers, "idempotency-key": "execution-http-continue" },
      payload: { prompt: "补充验证" },
    });
    expect(continued.statusCode).toBe(202);
    await vi.waitFor(async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/jobs/${continued.json().data.id}`,
        headers,
      });
      expect(response.json().data.status).toBe("succeeded");
    });
    expect(executor.continuedThreadIds).toEqual(["thread-draft-1", "thread-draft-1"]);
    expect(executor.continuedPrompts[0]).toContain("请完成任务 CXA-001：执行 HTTP 纵切 1");
  });

  it("cancels a queued start idempotently without invoking an executor", async () => {
    const { app, task, headers } = await setup();
    const started = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/jobs/continue`,
      headers: { ...headers, "idempotency-key": "execution-http-queued-start" },
      payload: {},
    });
    const canceled = await app.inject({
      method: "POST",
      url: `/api/v1/jobs/${started.json().data.id}/cancel`,
      headers: { ...headers, "idempotency-key": "execution-http-cancel" },
      payload: {},
    });
    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/jobs/${started.json().data.id}/cancel`,
      headers: { ...headers, "idempotency-key": "execution-http-cancel" },
      payload: {},
    });
    expect(canceled.statusCode).toBe(202);
    expect(replay.json()).toEqual(canceled.json());
    expect(canceled.json().data).toMatchObject({
      target: { status: "canceled" },
      cancel: { status: "succeeded" },
    });
  });

  it("processes cancellation even when both execution workers are occupied", async () => {
    const executor = new BlockingExecutor();
    const { app, database, tasks, headers } = await setup(executor, 2);
    const workspaceStops = vi.spyOn(appControl(app).services.queue, "captureWorkspaceStop");
    const starts = [];
    const failures: unknown[] = [];

    try {
      for (const [index, task] of tasks.entries()) {
        starts.push(
          await app.inject({
            method: "POST",
            url: `/api/v1/tasks/${task.id}/jobs/continue`,
            headers: { ...headers, "idempotency-key": `execution-http-blocking-${index + 1}` },
            payload: {},
          }),
        );
        await vi.waitFor(() => expect(executor.activeCount).toBe(index + 1));
      }

      const targetJobId = starts[0]!.json().data.id as string;
      const cancellation = await app.inject({
        method: "POST",
        url: `/api/v1/jobs/${targetJobId}/cancel`,
        headers: { ...headers, "idempotency-key": "execution-http-saturated-cancel" },
        payload: {},
      });
      expect(cancellation.statusCode).toBe(202);
      expect(cancellation.json().data.target.status).toBe("canceling");

      await vi.waitFor(async () => {
        const target = await app.inject({
          method: "GET",
          url: `/api/v1/jobs/${targetJobId}`,
          headers,
        });
        expect(target.json().data.status).toBe("canceled");
        expect(executor.interruptions).toHaveLength(1);
      });
    } catch (error) {
      failures.push(error);
    }
    executor.completeAll();
    try {
      const jobIds = starts.flatMap((response) => {
        const id = response.json().data?.id as unknown;
        return response.statusCode === 202 && typeof id === "string" ? [id] : [];
      });
      try {
        // Releasing the fake executor starts real asynchronous Git fingerprinting.
        // Let jobs persist their stop evidence before shutting down the database.
        await vi.waitFor(
          async () => {
            for (const id of jobIds) {
              const response = await app.inject({
                method: "GET",
                url: `/api/v1/jobs/${id}`,
                headers,
              });
              expect(response.statusCode).toBe(200);
              expect(["succeeded", "canceled"]).toContain(response.json().data.status);
            }
          },
          { timeout: 10_000 },
        );
        for (const id of jobIds) {
          expect(
            database
              .prepare("SELECT after_fingerprint FROM job_workspace_evidence WHERE job_id = ?")
              .get(id),
          ).toEqual({ after_fingerprint: expect.any(String) });
        }
      } finally {
        try {
          // Stop prevents any new captures. Both workers can capture the canceled
          // job, so await every real call before afterEach removes their Git cwd.
          await app.close();
          await Promise.all(
            workspaceStops.mock.results
              .filter((result) => result.type === "return")
              .map((result) => result.value),
          );
        } finally {
          workspaceStops.mockRestore();
        }
      }
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Execution assertion and fixture shutdown both failed");
  });
});
