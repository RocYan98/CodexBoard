import { execFileSync } from "node:child_process";
import { identityKey } from "@codexboard/contracts";
import { CliAuthService } from "../src/modules/identity/cli-auth-service.js";
import { IdentityService } from "../src/modules/identity/identity-service.js";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { initializeDatabase, type SqliteDatabase } from "../src/modules/database/index.js";
import type { BackupRunner } from "../src/modules/operations/index.js";
import { ProjectSyncService } from "../src/modules/project-sync/index.js";
import { createLocalAdminApp } from "../src/transports/local-admin-http.js";
import { FakeThreadProvisioner } from "./fake-thread-provisioner.js";

const openApps: FastifyInstance[] = [];
const openDatabases: SqliteDatabase[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
  for (const database of openDatabases.splice(0)) {
    if (database.open) {
      database.close();
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup(
  options: { readonly backupRunner?: BackupRunner; readonly adminPort?: number } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "codexboard-admin-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    CODEXBOARD_ENV: "test",
    CODEXBOARD_WORKSPACE_ROOTS: root,
    CODEXBOARD_DATA_DIR: root,
    ...(options.adminPort === undefined
      ? {}
      : { CODEXBOARD_ADMIN_PORT: String(options.adminPort) }),
  });
  const database = initializeDatabase(":memory:");
  openDatabases.push(database);
  const capabilityToken = "x".repeat(43);
  const projectSync = new ProjectSyncService({ database });
  const provisioner = new FakeThreadProvisioner();
  const cliAuth = new CliAuthService();
  const app = createLocalAdminApp({
    config,
    database,
    capabilityToken,
    cliAuth,
    codexThreadProvisioner: provisioner,
    ...(options.backupRunner ? { backupRunner: options.backupRunner } : {}),
  });
  openApps.push(app);
  async function loginCli() {
    const identity = { kind: "feishu", tenantKey: "test-tenant", userId: "test-user" } as const;
    database
      .prepare(
        `INSERT INTO identities (identity_key, kind, tenant_key, user_id, name, role, active) VALUES (?, 'feishu', ?, ?, 'CLI 用户', 'admin', 1)`,
      )
      .run(identityKey(identity), identity.tenantKey, identity.userId);
    const identities = new IdentityService({
      database,
      sessionTtlSeconds: 3600,
      provider: {
        kind: "feishu",
        exchangeCode: async () => ({ identity, name: "CLI 用户", avatarUrl: null }),
      },
    });
    const grant = await identities.exchangeCode("verified-test-code");
    const request = cliAuth.create("local-admin-test");
    cliAuth.approve(request.requestId, grant.actor.identity as typeof identity);
    const session = cliAuth.complete(request.requestId, request.claimSecret);
    if (!("token" in session)) throw new Error("missing CLI session");
    return { "x-taskctl-session": session.token };
  }
  return {
    app,
    config,
    database,
    capabilityToken,
    root,
    projectSync,
    provisioner,
    loginCli,
    cliAuth,
  };
}

function cookieHeader(response: Awaited<ReturnType<FastifyInstance["inject"]>>): string {
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

describe("local admin HTTP adapter", () => {
  it("rejects every board route without a valid user session despite a valid machine capability", async () => {
    const { app, capabilityToken, database, loginCli, cliAuth } = setup();
    expect(
      database.prepare("SELECT count(*) FROM identities WHERE kind = 'service'").pluck().get(),
    ).toBe(0);
    const id = "11111111-1111-4111-8111-111111111111";
    const localHeaders = {
      host: "127.0.0.1:47824",
      authorization: `Bearer ${capabilityToken}`,
    };
    const session = await loginCli();
    cliAuth.revoke(session["x-taskctl-session"]);
    const routes = [
      ["GET", "/context"],
      ["GET", "/projects"],
      ["GET", `/projects/${id}/dashboard`],
      ["GET", `/projects/${id}/task-creation-options`],
      ["GET", `/projects/${id}/board`],
      ["POST", `/projects/${id}/contexts/scan`],
      ["GET", `/projects/${id}/git`],
      ["POST", `/projects/${id}/git`],
      ["DELETE", `/projects/${id}/git`],
      ["GET", "/members/audit"],
      ["GET", `/events?projectId=${id}&afterRevision=0`],
      ["GET", "/labels"],
      ["POST", "/labels"],
      ["PATCH", `/labels/${id}`],
      ["DELETE", `/labels/${id}`],
      ["PUT", "/labels/order"],
      ["POST", "/tasks"],
      ["PATCH", `/tasks/${id}`],
      ["DELETE", `/tasks/${id}`],
      ["GET", `/tasks/${id}/workspace`],
      ["POST", `/tasks/${id}/archive`],
      ["POST", `/tasks/${id}/restore`],
      ["POST", `/tasks/${id}/read`],
      ["POST", `/tasks/${id}/move`],
      ["POST", `/tasks/${id}/reassign`],
      ["GET", `/tasks/${id}/lifecycle`],
      ["POST", `/tasks/${id}/lifecycle`],
      ["POST", `/tasks/${id}/comments`],
      ["PATCH", `/comments/${id}`],
      ["DELETE", `/comments/${id}`],
      ["POST", `/tasks/${id}/relations`],
      ["DELETE", `/tasks/${id}/relations/${id}`],
      ["POST", `/tasks/${id}/attachments`],
      ["GET", `/attachments/${id}`],
      ["DELETE", `/attachments/${id}`],
      ["GET", `/tasks/${id}/jobs`],
      ["POST", `/tasks/${id}/jobs/start`],
      ["POST", `/tasks/${id}/jobs/continue`],
      ["GET", `/jobs/${id}`],
      ["POST", `/jobs/${id}/cancel`],
      ["GET", `/jobs/${id}/interactions`],
      ["POST", `/interactions/${id}/respond`],
      ["GET", "/auth/session"],
      ["POST", "/auth/logout"],
    ] as const;
    for (const extraHeaders of [{}, { "x-taskctl-session": "invalid" }, session]) {
      for (const [method, path] of routes) {
        const response = await app.inject({
          method,
          url: `/api/v1/local${path}`,
          headers: { ...localHeaders, ...extraHeaders },
        });
        expect(response.statusCode, `${method} ${path}: ${response.body}`).toBe(401);
        expect(response.json().error.code).toBe("UNAUTHENTICATED");
      }
      const head = await app.inject({
        method: "HEAD",
        url: "/api/v1/local/projects",
        headers: { ...localHeaders, ...extraHeaders },
      });
      expect(head.statusCode).toBe(401);
    }
    expect(database.prepare("SELECT count(*) FROM tasks").pluck().get()).toBe(0);
    expect(database.prepare("SELECT count(*) FROM comments").pluck().get()).toBe(0);
  });

  it("manages labels through authenticated local routes with versions and replay", async () => {
    const { app, capabilityToken, loginCli } = setup();
    const headers = {
      host: "127.0.0.1:47824",
      authorization: `Bearer ${capabilityToken}`,
      ...(await loginCli()),
      "idempotency-key": "label-create-1",
    };
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/local/labels", payload: { name: "测试" } }))
        .statusCode,
    ).toBe(403);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/local/labels",
      headers,
      payload: { name: "测试" },
    });
    expect(created.statusCode).toBe(201);
    const label = created.json().data;
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/local/labels",
      headers,
      payload: { name: "测试" },
    });
    expect(replay.json().data.id).toBe(label.id);
    const url = `/api/v1/local/labels/${label.id}`;
    expect(
      (
        await app.inject({
          method: "PATCH",
          url,
          headers: { ...headers, "idempotency-key": "label-update-1" },
          payload: { name: "修改", expectedVersion: label.version },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url,
          headers: { ...headers, "idempotency-key": "label-stale-1" },
          payload: { expectedVersion: label.version },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/local/labels/order",
          headers: { ...headers, "idempotency-key": "label-order-1" },
          payload: { labelIds: [label.id] },
        })
      ).statusCode,
    ).toBe(200);
    const list = await app.inject({ method: "GET", url: "/api/v1/local/labels", headers });
    expect(list.json().data.labels).toHaveLength(1);
    const current = list.json().data.labels[0];
    expect(
      (
        await app.inject({
          method: "DELETE",
          url,
          headers: { ...headers, "idempotency-key": "label-delete-1" },
          payload: { expectedVersion: current.version },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("exposes task archive/restore, read state, options, dashboard, events and job detail", async () => {
    const { app, capabilityToken, projectSync, root, loginCli } = setup();
    const headers = {
      host: "127.0.0.1:47824",
      authorization: `Bearer ${capabilityToken}`,
      ...(await loginCli()),
    };
    projectSync.reconcile({
      schemaVersion: 1,
      generatedAt: "2026-09-01T12:00:00.000Z",
      projects: [
        {
          codexProjectId: "11111111-1111-4111-8111-111111111111",
          name: "测试",
          rootPaths: [realpathSync.native(root)],
          position: 0,
        },
      ],
    });
    const projects = await app.inject({ method: "GET", url: "/api/v1/local/projects", headers });
    const project = projects.json().data.find((entry: { kind: string }) => entry.kind === "codex");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/local/tasks",
      headers: { ...headers, "idempotency-key": "parity-task-create" },
      payload: { projectId: project.id, title: "接口验收" },
    });
    expect(created.statusCode).toBe(201);
    const task = created.json().data;
    const path = `/api/v1/local/tasks/${task.id}`;
    const archived = await app.inject({
      method: "POST",
      url: `${path}/archive`,
      headers: { ...headers, "idempotency-key": "parity-archive" },
      payload: { expectedVersion: task.version },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().data.archivedAt).not.toBeNull();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${path}/restore`,
          headers: { ...headers, "idempotency-key": "parity-restore-stale" },
          payload: { expectedVersion: task.version },
        })
      ).statusCode,
    ).toBe(409);
    const restored = await app.inject({
      method: "POST",
      url: `${path}/restore`,
      headers: { ...headers, "idempotency-key": "parity-restore" },
      payload: { expectedVersion: archived.json().data.version },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().data.archivedAt).toBeNull();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${path}/read`,
          headers: { ...headers, "idempotency-key": "parity-read" },
          payload: {},
        })
      ).statusCode,
    ).toBe(204);
    for (const suffix of ["dashboard", "task-creation-options"]) {
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/v1/local/projects/${project.id}/${suffix}`,
            headers,
          })
        ).statusCode,
      ).toBe(200);
    }
    const events = await app.inject({
      method: "GET",
      url: `/api/v1/local/events?projectId=${project.id}&afterRevision=0&limit=2`,
      headers,
    });
    expect(events.statusCode).toBe(200);
    expect(events.json().data.events).toHaveLength(2);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/local/events?projectId=${project.id}&afterRevision=-1`,
          headers,
        })
      ).statusCode,
    ).toBe(400);
    const job = await app.inject({
      method: "POST",
      url: `${path}/jobs/continue`,
      headers: { ...headers, "idempotency-key": "parity-job" },
      payload: { prompt: "检查" },
    });
    expect(job.statusCode).toBe(202);
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/local/jobs/${job.json().data.id}`,
      headers,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.taskId).toBe(task.id);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/local/projects/00000000-0000-4000-8000-0000000000a2/git`,
          headers,
        })
      ).statusCode,
    ).toBe(409);
  });

  it("requires the exact loopback host and runtime capability without a browser Origin", async () => {
    const { app, capabilityToken, database } = setup();
    const url = "/api/v1/local/health";

    const missingCapability = await app.inject({
      method: "GET",
      url,
      headers: { host: "127.0.0.1:47824" },
    });
    expect(missingCapability.statusCode).toBe(403);
    expect(missingCapability.json().error.code).toBe("FORBIDDEN");

    const browserRequest = await app.inject({
      method: "GET",
      url,
      headers: {
        host: "127.0.0.1:47824",
        authorization: `Bearer ${capabilityToken}`,
        origin: "http://localhost:5173",
      },
    });
    expect(browserRequest.statusCode).toBe(403);

    const wrongHost = await app.inject({
      method: "GET",
      url,
      headers: {
        host: "localhost:47824",
        authorization: `Bearer ${capabilityToken}`,
      },
    });
    expect(wrongHost.statusCode).toBe(403);

    const allowed = await app.inject({
      method: "GET",
      url,
      headers: {
        host: "127.0.0.1:47824",
        authorization: `Bearer ${capabilityToken}`,
      },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().data.listener).toBe("local-admin");
    expect(allowed.json().data.checks).toEqual(
      expect.objectContaining({
        http: { status: "ok" },
        sqlite: { status: "ok" },
        queue: expect.any(Object),
        connector: expect.any(Object),
        appServer: expect.any(Object),
      }),
    );
    expect(
      database
        .prepare("SELECT outcome FROM audit_events WHERE action = 'local_admin.authenticate'")
        .pluck()
        .all(),
    ).toEqual(["denied"]);
  });

  it("accepts canonical HTTP port-80 Host headers over a real loopback connection", async () => {
    const { app, capabilityToken } = setup({ adminPort: 80 });
    // Use an ephemeral listener so the test does not compete with a machine's port 80.
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const url = new URL("/api/v1/local/health", address);
    const requestHealth = (headers: { host: string; authorization?: string; origin?: string }) =>
      new Promise<number | undefined>((resolve, reject) => {
        const request = get(url, { headers, agent: false }, (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode));
        });
        request.once("error", reject);
        request.setTimeout(2000, () => request.destroy(new Error("request timeout")));
      });
    for (const host of ["127.0.0.1", "127.0.0.1:80"]) {
      expect(await requestHealth({ host, authorization: `Bearer ${capabilityToken}` })).toBe(200);
    }
    for (const host of [
      "localhost",
      "localhost:80",
      "127.0.0.1:81",
      "127.0.0.1:47824",
      "0.0.0.0:80",
      "127.0.0.1.evil.test",
    ]) {
      expect(await requestHealth({ host, authorization: `Bearer ${capabilityToken}` })).toBe(403);
    }
    for (const headers of [
      { host: "127.0.0.1" },
      { host: "127.0.0.1", authorization: `Bearer ${capabilityToken}`, origin: "http://localhost" },
    ]) {
      expect(await requestHealth(headers)).toBe(403);
    }
  });

  it("keeps project metadata read-only and rejects arbitrary member creation", async () => {
    const { app, config, capabilityToken, database, projectSync, root, loginCli } = setup();
    const headers = {
      host: "127.0.0.1:47824",
      authorization: `Bearer ${capabilityToken}`,
      ...(await loginCli()),
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/local/projects",
      headers,
      payload: { projectKey: "LOCAL", name: "本机项目", description: "" },
    });
    expect(created.statusCode).toBe(404);
    projectSync.reconcile({
      schemaVersion: 1,
      generatedAt: "2026-09-01T12:00:00.000Z",
      projects: [
        {
          codexProjectId: "11111111-1111-4111-8111-111111111111",
          name: "本机项目",
          rootPaths: [realpathSync.native(root)],
          position: 0,
        },
      ],
    });
    const project = database
      .prepare("SELECT id, version FROM projects WHERE codex_project_id = ?")
      .get("11111111-1111-4111-8111-111111111111") as { id: string; version: number };

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/local/projects/${project.id}`,
      headers,
      payload: { expectedVersion: project.version, name: "更新后的项目" },
    });
    expect(updated.statusCode).toBe(404);

    const archived = await app.inject({
      method: "POST",
      url: `/api/v1/local/projects/${project.id}/archive`,
      headers,
      payload: { expectedVersion: project.version },
    });
    expect(archived.statusCode).toBe(404);

    const registered = await app.inject({
      method: "PUT",
      url: `/api/v1/local/projects/${project.id}/workspace`,
      headers,
      payload: { expectedVersion: project.version, absolutePath: root },
    });
    expect(registered.statusCode).toBe(404);

    const member = await app.inject({
      method: "PUT",
      url: `/api/v1/local/projects/${project.id}/members/bootstrap`,
      headers,
      payload: {
        tenantKey: "tenant",
        userId: "user-id",
        name: "项目成员",
        projectRole: "executor",
      },
    });
    expect(member.statusCode).toBe(404);
    expect(
      database.prepare("SELECT count(*) FROM identities WHERE user_id = ?").pluck().get("user-id"),
    ).toBe(0);

    const publicDatabase = initializeDatabase(":memory:");
    const publicApp = createApp({ config, database: publicDatabase });
    openApps.push(publicApp);
    const publicAttempt = await publicApp.inject({
      method: "POST",
      url: "/api/v1/local/projects",
      headers: { host: "127.0.0.1:47823", origin: "http://localhost:5173" },
      payload: { projectKey: "LEAK", name: "不应创建" },
    });
    expect(publicAttempt.statusCode).toBe(404);
  });

  it("creates a consistent backup only through the protected local adapter", async () => {
    const { app, capabilityToken } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/local/backups",
      headers: {
        host: "127.0.0.1:47824",
        authorization: `Bearer ${capabilityToken}`,
      },
      payload: {},
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({
      backupId: expect.stringMatching(/^backup-/),
      manifest: {
        manifestVersion: 1,
        schemaVersion: 27,
        attachments: [],
      },
    });
  });

  it("keeps health responsive while an online backup runs outside the request event loop", async () => {
    type BackupManifest = Awaited<ReturnType<BackupRunner["create"]>>;
    let finishBackup!: (manifest: BackupManifest) => void;
    const pendingBackup: Promise<BackupManifest> = new Promise((resolve) => {
      finishBackup = resolve;
    });
    const backupRunner: BackupRunner = { create: vi.fn(() => pendingBackup) };
    const { app, capabilityToken } = setup({ backupRunner });
    const headers = {
      host: "127.0.0.1:47824",
      authorization: `Bearer ${capabilityToken}`,
    };

    const backupResponse = app.inject({ method: "POST", url: "/api/v1/local/backups", headers });
    await vi.waitFor(() => expect(backupRunner.create).toHaveBeenCalledOnce());
    const healthResponse = await app.inject({
      method: "GET",
      url: "/api/v1/local/health",
      headers,
    });
    expect(healthResponse.statusCode).toBe(200);
    finishBackup({
      backupId: "backup-test",
      manifest: {
        manifestVersion: 1,
        createdAt: "2026-08-31T00:00:00.000Z",
        schemaVersion: 5,
        database: { path: "taskboard.sqlite", size: 1, sha256: "0".repeat(64) },
        attachments: [],
      },
    });
    const completedBackup = await backupResponse;
    expect(completedBackup.statusCode).toBe(201);
    expect(completedBackup.json().data.backupId).toBe("backup-test");
  });

  it("resolves context from the taskctl caller working directory", async () => {
    const { app, capabilityToken, root, database, projectSync, loginCli } = setup();
    projectSync.reconcile({
      schemaVersion: 1,
      generatedAt: "2026-09-01T12:00:00.000Z",
      projects: [
        {
          codexProjectId: "11111111-1111-4111-8111-111111111111",
          name: "调用方项目",
          rootPaths: [realpathSync.native(root)],
          position: 0,
        },
      ],
    });
    const project = database
      .prepare("SELECT id FROM projects WHERE codex_project_id = ?")
      .get("11111111-1111-4111-8111-111111111111") as { id: string };
    const headers = {
      host: "127.0.0.1:47824",
      authorization: `Bearer ${capabilityToken}`,
      "x-taskctl-cwd": root,
      ...(await loginCli()),
    };
    const context = await app.inject({ method: "GET", url: "/api/v1/local/context", headers });
    expect(context.statusCode).toBe(200);
    expect(context.json().data.cwd).toBe(realpathSync.native(root));
    expect(context.json().data.project.id).toBe(project.id);

    const relativeContext = await app.inject({
      method: "GET",
      url: "/api/v1/local/context",
      headers: { ...headers, "x-taskctl-cwd": "relative/path" },
    });
    expect(relativeContext.statusCode).toBe(400);

    const nested = join(root, "嵌套项目");
    mkdirSync(nested);
    projectSync.reconcile({
      schemaVersion: 1,
      generatedAt: "2026-09-01T12:01:00.000Z",
      projects: [
        {
          codexProjectId: "11111111-1111-4111-8111-111111111111",
          name: "调用方项目",
          rootPaths: [realpathSync.native(root)],
          position: 0,
        },
        {
          codexProjectId: "22222222-2222-4222-8222-222222222222",
          name: "嵌套调用方项目",
          rootPaths: [realpathSync.native(nested)],
          position: 1,
        },
      ],
    });
    const nestedProject = database
      .prepare("SELECT id FROM projects WHERE codex_project_id = ?")
      .get("22222222-2222-4222-8222-222222222222") as { id: string };
    const nestedContext = await app.inject({
      method: "GET",
      url: "/api/v1/local/context",
      headers: { ...headers, "x-taskctl-cwd": encodeURIComponent(nested) },
    });
    expect(nestedContext.statusCode).toBe(200);
    expect(nestedContext.json().data.cwd).toBe(realpathSync.native(nested));
    expect(nestedContext.json().data.project.id).toBe(nestedProject.id);

    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/local/context",
      headers: {
        host: headers.host,
        authorization: headers.authorization,
        "x-taskctl-session": headers["x-taskctl-session"],
      },
    });
    expect(missing.statusCode).toBe(400);
  });

  it("writes user-attributed comments through paired local HTTP and exposes revisions to H5", async () => {
    const { app, config, database, capabilityToken, projectSync, root, loginCli } = setup();
    const publicApp = createApp({ config, database, closeDatabaseOnClose: false });
    openApps.push(publicApp);
    const localHeaders = {
      host: "127.0.0.1:47824",
      authorization: `Bearer ${capabilityToken}`,
      ...(await loginCli()),
    };
    projectSync.reconcile({
      schemaVersion: 1,
      generatedAt: "2026-09-01T12:00:00.000Z",
      projects: [
        {
          codexProjectId: "11111111-1111-4111-8111-111111111111",
          name: "同步项目",
          rootPaths: [realpathSync.native(root)],
          position: 0,
        },
      ],
    });
    const project = database
      .prepare("SELECT id FROM projects WHERE codex_project_id = ?")
      .get("11111111-1111-4111-8111-111111111111") as { id: string };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/local/tasks",
      headers: { ...localHeaders, "idempotency-key": "local-create-task" },
      payload: { projectId: project.id, title: "CLI 创建的任务" },
    });
    expect(created.statusCode).toBe(201);
    const task = created.json().data;
    const comment = await app.inject({
      method: "POST",
      url: `/api/v1/local/tasks/${task.id}/comments`,
      headers: { ...localHeaders, "idempotency-key": "local-create-comment" },
      payload: { body: "来自 taskctl 的进度" },
    });
    expect(comment.statusCode, comment.body).toBe(201);
    expect(comment.json().data.author.identity).toEqual({
      kind: "feishu",
      tenantKey: "test-tenant",
      userId: "test-user",
    });
    const commentId = comment.json().data.id;
    const anonymous = {
      host: localHeaders.host,
      authorization: localHeaders.authorization,
      "idempotency-key": "anonymous-comment",
    };
    for (const [method, url, payload] of [
      ["POST", `/api/v1/local/tasks/${task.id}/comments`, { body: "forbidden" }],
      ["PATCH", `/api/v1/local/comments/${commentId}`, { expectedVersion: 1, body: "forbidden" }],
      ["DELETE", `/api/v1/local/comments/${commentId}`, { expectedVersion: 1 }],
    ] as const) {
      expect((await app.inject({ method, url, headers: anonymous, payload })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method,
            url,
            headers: { ...anonymous, "x-taskctl-session": "invalid" },
            payload,
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method,
            url,
            headers: { ...localHeaders, "idempotency-key": `forged-${method}` },
            payload: {
              ...payload,
              source: "codex",
              author: { kind: "service", serviceId: "codex" },
            },
          })
        ).statusCode,
      ).toBe(400);
    }
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/local/comments/${commentId}`,
      headers: { ...localHeaders, "idempotency-key": "comment-update" },
      payload: { expectedVersion: 1, body: "用户修改" },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().data.author.identity).toEqual(comment.json().data.author.identity);
    expect(updated.json().data.body).toBe("用户修改");
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/local/comments/${commentId}`,
      headers: { ...localHeaders, "idempotency-key": "comment-delete" },
      payload: { expectedVersion: 2 },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(
      database
        .prepare("SELECT author_identity_key, deleted_at FROM comments WHERE id = ?")
        .get(commentId),
    ).toEqual({
      author_identity_key: identityKey({
        kind: "feishu",
        tenantKey: "test-tenant",
        userId: "test-user",
      }),
      deleted_at: expect.any(String),
    });
    const attachmentBytes = Buffer.from("local attachment");
    const attachment = await app.inject({
      method: "POST",
      url: `/api/v1/local/tasks/${task.id}/attachments`,
      headers: {
        ...localHeaders,
        "idempotency-key": "local-create-attachment",
        "content-type": "application/octet-stream",
        "x-content-type": "text/plain",
        "x-filename": "local.txt",
      },
      payload: attachmentBytes,
    });
    expect(attachment.statusCode).toBe(201);
    expect(attachment.json().data.downloadUrl).toBe(
      `/api/v1/local/attachments/${attachment.json().data.id}`,
    );
    const localWorkspace = await app.inject({
      method: "GET",
      url: `/api/v1/local/tasks/${task.id}/workspace`,
      headers: localHeaders,
    });
    expect(localWorkspace.json().data.attachments[0].downloadUrl).toBe(
      `/api/v1/local/attachments/${attachment.json().data.id}`,
    );
    const preview = await app.inject({
      method: "GET",
      url: `/api/v1/local/attachments/${attachment.json().data.id}?preview=1`,
      headers: localHeaders,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.rawPayload).toEqual(attachmentBytes);
    expect(preview.headers["content-disposition"]).toContain("inline;");
    const deletedAttachment = await app.inject({
      method: "DELETE",
      url: `/api/v1/local/attachments/${attachment.json().data.id}`,
      headers: { ...localHeaders, "idempotency-key": "local-delete-attachment" },
    });
    expect(deletedAttachment.statusCode).toBe(200);
    expect(deletedAttachment.json().data.id).toBe(attachment.json().data.id);

    const trusted = { host: "127.0.0.1:47823", origin: "http://localhost:5173" };
    const login = await publicApp.inject({
      method: "POST",
      url: "/api/v1/auth/development",
      headers: trusted,
    });
    const cookie = cookieHeader(login);
    const board = await publicApp.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/board`,
      headers: { host: trusted.host, cookie },
    });
    expect(board.statusCode).toBe(200);
    expect(board.json().data.tasks).toEqual([
      expect.objectContaining({ id: task.id, title: "CLI 创建的任务" }),
    ]);
    const workspace = await publicApp.inject({
      method: "GET",
      url: `/api/v1/tasks/${task.id}/workspace`,
      headers: { host: trusted.host, cookie },
    });
    expect(workspace.json().data.comments).toEqual([]);
    expect(
      database
        .prepare("SELECT count(*) FROM change_events WHERE aggregate_id = ?")
        .pluck()
        .get(task.id),
    ).toBeGreaterThanOrEqual(1);
  });
});

it("deletes canceled tasks through the protected service with version checks and replay", async () => {
  const { app, capabilityToken, projectSync, root, database, provisioner, loginCli } = setup();
  const headers = {
    host: "127.0.0.1:47824",
    authorization: `Bearer ${capabilityToken}`,
    ...(await loginCli()),
  };
  projectSync.reconcile({
    schemaVersion: 1,
    generatedAt: "2026-09-01T12:00:00.000Z",
    projects: [
      {
        codexProjectId: "11111111-1111-4111-8111-111111111111",
        name: "删除测试",
        rootPaths: [realpathSync.native(root)],
        position: 0,
      },
    ],
  });
  const project = database
    .prepare("SELECT id FROM projects WHERE codex_project_id = ?")
    .get("11111111-1111-4111-8111-111111111111") as { id: string };
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/local/tasks",
    headers: { ...headers, "idempotency-key": "delete-create" },
    payload: { projectId: project.id, title: "待删除" },
  });
  expect(created.statusCode).toBe(201);
  const task = created.json().data;
  const url = `/api/v1/local/tasks/${task.id}`;
  const denied = await app.inject({
    method: "DELETE",
    url,
    headers: { host: headers.host },
    payload: { expectedVersion: task.version },
  });
  expect(denied.statusCode).toBe(403);
  const active = await app.inject({
    method: "DELETE",
    url,
    headers: { ...headers, "idempotency-key": "delete-active" },
    payload: { expectedVersion: task.version },
  });
  expect(active.statusCode).toBe(409);
  const canceled = await app.inject({
    method: "POST",
    url: `${url}/move`,
    headers: { ...headers, "idempotency-key": "delete-cancel" },
    payload: { expectedVersion: task.version, targetStatus: "canceled" },
  });
  expect(canceled.statusCode).toBe(200);
  const version = canceled.json().data.version;
  const stale = await app.inject({
    method: "DELETE",
    url,
    headers: { ...headers, "idempotency-key": "delete-stale" },
    payload: { expectedVersion: task.version },
  });
  expect(stale.statusCode).toBe(409);
  const request = {
    method: "DELETE" as const,
    url,
    headers: { ...headers, "idempotency-key": "delete-once" },
    payload: { expectedVersion: version },
  };
  const deleted = await app.inject(request);
  expect(deleted.statusCode).toBe(200);
  expect(deleted.json().data.taskId).toBe(task.id);
  const replay = await app.inject(request);
  expect(replay.statusCode).toBe(200);
  expect(replay.json()).toEqual(deleted.json());
  expect(provisioner.archived).toEqual(["thread-draft-1"]);
  expect((await app.inject({ method: "GET", url: `${url}/workspace`, headers })).statusCode).toBe(
    404,
  );
});

it("distinguishes Terminal and Codex creation on the authenticated CLI route", async () => {
  const { app, capabilityToken, root, database, projectSync, loginCli } = setup();
  const cwd = join(realpathSync.native(root), "repo");
  mkdirSync(cwd);
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.test");
  writeFileSync(join(cwd, "README.md"), "initial");
  git("add", ".");
  git("commit", "-m", "initial");
  projectSync.reconcile({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    projects: [
      {
        codexProjectId: "11111111-1111-4111-8111-111111111111",
        name: "Git",
        rootPaths: [cwd],
        position: 0,
      },
    ],
  });
  const id = database.prepare("SELECT id FROM projects WHERE source_kind = 'codex'").pluck().get();
  const headers = {
    host: "127.0.0.1:47824",
    authorization: `Bearer ${capabilityToken}`,
    ...(await loginCli()),
  };
  const url = `/api/v1/local/projects/${id}/git`;
  const threadId = "22222222-2222-4222-8222-222222222222";
  for (const [branch, extra] of [
    ["feature/terminal", {}],
    ["feature/codex", { codexThreadId: threadId }],
  ] as const) {
    const response = await app.inject({
      method: "POST",
      url,
      headers,
      payload: { kind: "branch", branch, baseBranch: "main", ...extra },
    });
    expect(response.statusCode, response.body).toBe(201);
  }
  const result = await app.inject({ method: "GET", url, headers });
  expect(result.statusCode).toBe(200);
  const entries = result.json().data.entries;
  expect(
    entries.find((e: { branch: string }) => e.branch === "feature/terminal").branchOrigin.kind,
  ).toBe("terminal");
  expect(
    entries.find((e: { branch: string }) => e.branch === "feature/codex").branchOrigin,
  ).toMatchObject({ kind: "codex", threadId });
});

it("requires a user session for task writes and preserves the authenticated relation author", async () => {
  const { app, capabilityToken, loginCli, database } = setup();
  const localHeaders = { host: "127.0.0.1:47824", authorization: `Bearer ${capabilityToken}` };
  const userHeaders = { ...localHeaders, ...(await loginCli()) };
  const taskIds: string[] = [];
  for (const title of ["前置任务", "后续任务"]) {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/local/tasks",
      headers: { ...userHeaders, "idempotency-key": `create-${taskIds.length}` },
      payload: { title, projectId: "00000000-0000-4000-8000-0000000000a2" },
    });
    expect(created.statusCode, created.body).toBe(201);
    taskIds.push(created.json().data.id);
  }
  const url = `/api/v1/local/tasks/${taskIds[0]}/relations`;
  const payload = { targetTaskId: taskIds[1], relationType: "blocks" };
  const denied = await app.inject({
    method: "POST",
    url,
    headers: { ...localHeaders, "idempotency-key": "missing-user" },
    payload,
  });
  expect(denied.statusCode).toBe(401);
  expect(database.prepare("SELECT COUNT(*) FROM task_relations").pluck().get()).toBe(0);
  const created = await app.inject({
    method: "POST",
    url,
    headers: { ...userHeaders, "idempotency-key": "verified-user" },
    payload,
  });
  expect(created.statusCode).toBe(201);
  expect(created.json().data.createdBy.identity).toEqual({
    kind: "feishu",
    tenantKey: "test-tenant",
    userId: "test-user",
  });
  expect(
    database
      .prepare("SELECT identity_key FROM activities WHERE kind = 'relation.created'")
      .pluck()
      .all(),
  ).toEqual([identityKey({ kind: "feishu", tenantKey: "test-tenant", userId: "test-user" })]);
  for (const [method, path] of [
    ["POST", "/labels"],
    ["PATCH", `/labels/${taskIds[0]}`],
    ["DELETE", `/labels/${taskIds[0]}`],
    ["PATCH", `/tasks/${taskIds[0]}`],
    ["DELETE", `/tasks/${taskIds[0]}`],
    ["POST", `/tasks/${taskIds[0]}/move`],
    ["POST", `/tasks/${taskIds[0]}/lifecycle`],
    ["POST", `/tasks/${taskIds[0]}/reassign`],
    ["DELETE", `/tasks/${taskIds[0]}/relations/${created.json().data.id}`],
    ["POST", `/tasks/${taskIds[0]}/jobs/start`],
    ["POST", `/jobs/${taskIds[0]}/cancel`],
    ["POST", `/interactions/${taskIds[0]}/respond`],
    ["DELETE", `/attachments/${taskIds[0]}`],
  ] as const) {
    const response = await app.inject({
      method,
      url: `/api/v1/local${path}`,
      headers: localHeaders,
      payload: {},
    });
    expect(response.statusCode, `${method} ${path}`).toBe(401);
  }
  expect(
    (await app.inject({ method: "GET", url: "/api/v1/local/health", headers: localHeaders }))
      .statusCode,
  ).toBe(200);
});
