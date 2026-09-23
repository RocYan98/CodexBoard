import { ensurePrivateFileSync } from "../../../scripts/private-file-permissions.mjs";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { initializeDatabase } from "../src/modules/database/index.js";

const apps: ReturnType<typeof createApp>[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("production web hosting", () => {
  it("serves only the root and built assets without masking probes as SPA HTML", async () => {
    const webRoot = mkdtempSync(join(tmpdir(), "codexboard-web-"));
    directories.push(webRoot);
    mkdirSync(join(webRoot, "assets"));
    writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>生产看板</title>");
    writeFileSync(join(webRoot, "assets", "app.js"), "globalThis.__PRODUCTION_WEB__ = true;");
    writeFileSync(join(webRoot, "package.json"), '{"privateMarker":"inside-web-root"}');
    const codexTokenFile = join(webRoot, "codex-ws-token");
    writeFileSync(codexTokenFile, "test-token\n");
    ensurePrivateFileSync(codexTokenFile);
    const config = loadConfig({
      CODEXBOARD_ENV: "production",
      CODEXBOARD_AUTH_MODE: "feishu",
      CODEXBOARD_FEISHU_APP_ID: "cli_test_app",
      CODEXBOARD_FEISHU_APP_SECRET: "test-secret",
      CODEXBOARD_ORIGIN: "https://tasks.example.com",
      CODEXBOARD_ALLOWED_HOSTS: "tasks.example.com",
      CODEXBOARD_WEB_ROOT: webRoot,
      CODEXBOARD_CODEX_TRANSPORT: "websocket",
      CODEXBOARD_CODEX_TOKEN_FILE: codexTokenFile,
    });
    const app = createApp({ config, database: initializeDatabase(":memory:") });
    apps.push(app);
    const headers = { host: "tasks.example.com", origin: "https://tasks.example.com" };

    const root = await app.inject({ method: "GET", url: "/", headers });
    const unknownRoute = await app.inject({ method: "GET", url: "/projects/OPS", headers });
    const asset = await app.inject({ method: "GET", url: "/assets/app.js", headers });
    const missingApi = await app.inject({ method: "GET", url: "/api/v1/missing", headers });
    const environmentProbe = await app.inject({ method: "GET", url: "/.env", headers });
    const gitProbe = await app.inject({ method: "GET", url: "/.git/HEAD", headers });
    const missingAsset = await app.inject({ method: "GET", url: "/assets/missing.js", headers });
    const encodedTraversal = await app.inject({
      method: "GET",
      url: "/assets%2f..%2fpackage.json",
      headers,
    });

    expect(root.statusCode).toBe(200);
    expect(root.body).toContain("生产看板");
    expect(asset.body).toContain("__PRODUCTION_WEB__");
    for (const response of [unknownRoute, missingApi, environmentProbe, gitProbe, missingAsset]) {
      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.body).not.toContain("生产看板");
    }
    expect(encodedTraversal.body).not.toContain("inside-web-root");
  });
});
