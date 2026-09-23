import { makePublicReadableSync } from "../../../scripts/test-support/private-access.mjs";
import { ensurePrivateFileSync } from "../../../scripts/private-file-permissions.mjs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigError, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("accepts legacy settings while new values and explicit emptiness take priority", () => {
    expect(loadConfig({ LARK_CODEX_PORT: "48123" }).CODEXBOARD_PORT).toBe(48123);
    expect(loadConfig({ LARK_CODEX_PORT: "48123", CODEXBOARD_PORT: "48125" }).CODEXBOARD_PORT).toBe(
      48125,
    );
    expect(() => loadConfig({ LARK_CODEX_DATA_DIR: "/old/data", CODEXBOARD_DATA_DIR: "" })).toThrow(
      ConfigError,
    );
  });
  it("uses localhost-safe defaults", () => {
    const config = loadConfig({});

    expect(config).toMatchObject({
      CODEXBOARD_HOST: "127.0.0.1",
      CODEXBOARD_PORT: 47_823,
      CODEXBOARD_ADMIN_HOST: "127.0.0.1",
      CODEXBOARD_ADMIN_PORT: 47_824,
      CODEXBOARD_ORIGIN: "http://localhost:5173",
      CODEXBOARD_EVENT_HISTORY_LIMIT: 10_000,
      CODEXBOARD_SSE_HEARTBEAT_MS: 15_000,
      CODEXBOARD_SSE_RETRY_MS: 3_000,
      CODEXBOARD_SSE_WRITE_TIMEOUT_MS: 10_000,
      CODEXBOARD_PROJECT_SYNC_RECONCILE_MS: 30_000,
    });
    expect(config.CODEXBOARD_DATA_DIR).toBe(
      join(fileURLToPath(new URL("../../../", import.meta.url)), ".data"),
    );
    expect(config.CODEXBOARD_CODEX_PROJECT_SNAPSHOT_FILE).toBe(
      join(config.CODEXBOARD_DATA_DIR, "run/codex-projects.json"),
    );
  });

  it("rejects invalid ports", () => {
    expect(() => loadConfig({ CODEXBOARD_PORT: "70000" })).toThrow(ConfigError);
    expect(() => loadConfig({ CODEXBOARD_ADMIN_PORT: "47823" })).toThrow(ConfigError);
  });

  it("rejects unsafe event feed limits and timing values", () => {
    expect(() => loadConfig({ CODEXBOARD_EVENT_HISTORY_LIMIT: "9" })).toThrow(ConfigError);
    expect(() => loadConfig({ CODEXBOARD_SSE_HEARTBEAT_MS: "999" })).toThrow(ConfigError);
    expect(() => loadConfig({ CODEXBOARD_SSE_WRITE_TIMEOUT_MS: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ CODEXBOARD_PROJECT_SYNC_RECONCILE_MS: "49" })).toThrow(ConfigError);
  });

  it("requires absolute workspace roots", () => {
    expect(() => loadConfig({ CODEXBOARD_WORKSPACE_ROOTS: "relative/path" })).toThrow(ConfigError);
  });

  it("accepts an absolute temporary project display root without using it as a workspace root", () => {
    const displayRoot = join(tmpdir(), "codexboard-temporary-display-root");

    expect(loadConfig({ CODEXBOARD_TEMPORARY_PROJECT_ROOT: displayRoot })).toMatchObject({
      CODEXBOARD_TEMPORARY_PROJECT_ROOT: displayRoot,
    });
    expect(() =>
      loadConfig({ CODEXBOARD_TEMPORARY_PROJECT_ROOT: "relative/temporary-root" }),
    ).toThrow(ConfigError);
  });

  it.skipIf(process.platform !== "darwin")(
    "defaults temporary projects to the current user's Documents folder before it exists",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "codexboard-new-user-home-"));
      try {
        vi.stubEnv("HOME", directory);
        const expected = join(directory, "Documents", "Codex");
        expect(existsSync(expected)).toBe(false);
        expect(loadConfig({}).CODEXBOARD_TEMPORARY_PROJECT_ROOT).toBe(expected);
        expect(existsSync(expected)).toBe(false);
      } finally {
        vi.unstubAllEnvs();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("fails closed for unsafe authentication mode combinations", () => {
    expect(() =>
      loadConfig({
        CODEXBOARD_ENV: "production",
        CODEXBOARD_AUTH_MODE: "development",
      }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        CODEXBOARD_AUTH_MODE: "feishu",
        CODEXBOARD_ORIGIN: "http://localhost:5173",
      }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        CODEXBOARD_ENV: "production",
        CODEXBOARD_AUTH_MODE: "feishu",
        CODEXBOARD_HOST: "0.0.0.0",
        CODEXBOARD_FEISHU_APP_ID: "cli_test_app",
        CODEXBOARD_FEISHU_APP_SECRET: "secret",
        CODEXBOARD_ORIGIN: "https://tasks.example.com",
      }),
    ).toThrow(ConfigError);
  });

  it.each([
    ["http://8.8.8.8:47823", "http://8.8.8.8:47823"],
    ["http://8.8.8.8:80", "http://8.8.8.8"],
    ["http://8.8.8.8", "http://8.8.8.8"],
    ["http://tasks.example.com:8080", "http://tasks.example.com:8080"],
  ])(
    "allows Feishu authentication on a canonical public IPv4 HTTP origin: %s",
    (origin, normalizedOrigin) => {
      expect(
        loadConfig({
          CODEXBOARD_ENV: "test",
          CODEXBOARD_AUTH_MODE: "feishu",
          CODEXBOARD_FEISHU_APP_ID: "cli_test_app",
          CODEXBOARD_FEISHU_APP_SECRET: "secret",
          CODEXBOARD_ORIGIN: origin,
          CODEXBOARD_ALLOWED_HOSTS: new URL(origin).host,
        }),
      ).toMatchObject({
        CODEXBOARD_AUTH_MODE: "feishu",
        CODEXBOARD_ORIGIN: normalizedOrigin,
      });
    },
  );

  it.each([
    "http://0.1.2.3:47823",
    "http://10.0.0.1:47823",
    "http://100.64.0.1:47823",
    "http://127.0.0.1:47823",
    "http://127.0.0.0x1",
    "http://169.254.1.1:47823",
    "http://172.16.0.1:47823",
    "http://192.0.0.1:47823",
    "http://192.0.2.1:47823",
    "http://192.168.1.1:47823",
    "http://198.18.0.1:47823",
    "http://198.51.100.1:47823",
    "http://203.0.113.1:47823",
    "http://224.0.0.1:47823",
    "http://tasks.example.com:47823/path",
    "http://8.8.8.8:47823/path",
    "http://user@8.8.8.8:47823",
  ])("rejects a non-public or non-canonical Feishu HTTP origin: %s", (origin) => {
    expect(() =>
      loadConfig({
        CODEXBOARD_ENV: "test",
        CODEXBOARD_AUTH_MODE: "feishu",
        CODEXBOARD_FEISHU_APP_ID: "cli_test_app",
        CODEXBOARD_FEISHU_APP_SECRET: "secret",
        CODEXBOARD_ORIGIN: origin,
      }),
    ).toThrow(ConfigError);
  });

  it("does not expose development authentication on a public HTTP origin", () => {
    expect(() =>
      loadConfig({
        CODEXBOARD_ENV: "test",
        CODEXBOARD_AUTH_MODE: "development",
        CODEXBOARD_ORIGIN: "http://8.8.8.8:47823",
      }),
    ).toThrow(ConfigError);
  });

  it("accepts only an authenticated local Codex WebSocket endpoint", () => {
    const directory = mkdtempSync(join(tmpdir(), "codexboard-codex-token-"));
    const tokenFile = join(directory, "codex-token");
    try {
      writePrivateFixture(tokenFile, "capability-token\n", { mode: 0o600 });
      expect(
        loadConfig({
          CODEXBOARD_CODEX_TRANSPORT: "websocket",
          CODEXBOARD_CODEX_ENDPOINT: "ws://127.0.0.1:47825",
          CODEXBOARD_CODEX_TOKEN_FILE: tokenFile,
        }),
      ).toMatchObject({
        CODEXBOARD_CODEX_TRANSPORT: "websocket",
        CODEXBOARD_CODEX_ENDPOINT: "ws://127.0.0.1:47825/",
        CODEXBOARD_CODEX_TOKEN_FILE: tokenFile,
      });

      for (const endpoint of [
        "ws://192.168.1.10:47825",
        "ws://0.0.0.0:47825",
        "wss://127.0.0.1:47825",
        "ws://user:secret@127.0.0.1:47825",
        "ws://127.0.0.1:0",
        "ws://127.0.0.1:65536",
        "ws://127.0.0.1:47826/path",
        "ws://127.0.0.1:47826/?token=secret",
        "ws://127.0.0.1:47826/#fragment",
        "ws://127.0.0.1:47826/?",
        "ws://127.0.0.1:47826/#",
        "ws://host.docker.internal:47825",
        "ws://docker.local:47825",
      ]) {
        expect(() =>
          loadConfig({
            CODEXBOARD_CODEX_TRANSPORT: "websocket",
            CODEXBOARD_CODEX_ENDPOINT: endpoint,
            CODEXBOARD_CODEX_TOKEN_FILE: tokenFile,
          }),
        ).toThrow(ConfigError);
      }
      expect(() =>
        loadConfig({
          CODEXBOARD_CODEX_TRANSPORT: "websocket",
          CODEXBOARD_CODEX_ENDPOINT: "ws://127.0.0.1:47825",
        }),
      ).toThrow(ConfigError);

      const symlink = join(directory, "codex-token-link");
      mkdirSync(join(directory, "nested"));
      writePrivateFixture(join(directory, "nested", "wide-token"), "wide", { mode: 0o644 });
      symlinkSync(tokenFile, symlink);
      if (existsSync(symlink)) {
        expect(() =>
          loadConfig({
            CODEXBOARD_CODEX_TRANSPORT: "websocket",
            CODEXBOARD_CODEX_TOKEN_FILE: symlink,
          }),
        ).toThrow(ConfigError);
      }
      expect(() =>
        loadConfig({
          CODEXBOARD_CODEX_TRANSPORT: "websocket",
          CODEXBOARD_CODEX_TOKEN_FILE: join(directory, "nested", "wide-token"),
        }),
      ).toThrow(ConfigError);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires a built web root and a private Feishu secret file in production", () => {
    const directory = mkdtempSync(join(tmpdir(), "codexboard-production-config-"));
    const webRoot = join(directory, "web");
    const secretFile = join(directory, "feishu-secret");
    const codexTokenFile = join(directory, "codex-token");
    try {
      writePrivateFixture(secretFile, "secret-from-file\n", { mode: 0o600 });
      writePrivateFixture(codexTokenFile, "codex-token-from-file\n", { mode: 0o600 });
      let error: unknown;
      try {
        loadConfig({
          CODEXBOARD_ENV: "production",
          CODEXBOARD_AUTH_MODE: "feishu",
          CODEXBOARD_FEISHU_APP_ID: "cli_test_app",
          CODEXBOARD_FEISHU_APP_SECRET_FILE: secretFile,
          CODEXBOARD_CODEX_TRANSPORT: "websocket",
          CODEXBOARD_CODEX_ENDPOINT: "ws://127.0.0.1:47825",
          CODEXBOARD_CODEX_TOKEN_FILE: codexTokenFile,
          CODEXBOARD_ORIGIN: "https://tasks.example.com",
          CODEXBOARD_ALLOWED_HOSTS: "tasks.example.com",
          CODEXBOARD_WEB_ROOT: webRoot,
        });
      } catch (caught: unknown) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues).toContain(
        "CODEXBOARD_WEB_ROOT: Web 构建目录缺少 index.html",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("embedded desktop bridge configuration", () => {
  const directory = mkdtempSync(join(tmpdir(), "embedded-config-"));
  const tokenFile = join(directory, "token");
  writePrivateFixture(tokenFile, "test-token", { mode: 0o600 });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  const embedded = {
    CODEXBOARD_CODEX_TRANSPORT: "embedded",
    CODEXBOARD_CODEX_COMMAND: "/Applications/Codex.app/Contents/Resources/codex",
    CODEXBOARD_CODEX_TOKEN_FILE: tokenFile,
    CODEXBOARD_CODEX_PROJECT_STATE_FILE: "/tmp/codex-projects.json",
  };
  it("accepts embedded mode with production Feishu security settings", () => {
    const webRoot = join(directory, "production-web");
    mkdirSync(webRoot);
    writePrivateFixture(join(webRoot, "index.html"), "<html></html>");
    const secretFile = join(directory, "feishu-secret");
    writePrivateFixture(secretFile, "test-secret", { mode: 0o600 });
    const config = loadConfig({
      ...embedded,
      CODEXBOARD_ENV: "production",
      CODEXBOARD_AUTH_MODE: "feishu",
      CODEXBOARD_FEISHU_APP_ID: "cli_test",
      CODEXBOARD_FEISHU_APP_SECRET_FILE: secretFile,
      CODEXBOARD_ORIGIN: "https://tasks.example.com",
      CODEXBOARD_ALLOWED_HOSTS: "tasks.example.com",
      CODEXBOARD_WEB_ROOT: webRoot,
    });
    expect(config.CODEXBOARD_CODEX_TRANSPORT).toBe("embedded");
  });
  it("accepts a local embedded bridge with explicit native paths", () => {
    expect(loadConfig(embedded).CODEXBOARD_CODEX_TRANSPORT).toBe("embedded");
  });
  it.each(["embedded", "websocket"])(
    "accepts allocated loopback ports for %s bridges",
    (transport) => {
      for (const port of [1, 80, 47826, 65535]) {
        const endpoint = `ws://127.0.0.1:${port}`;
        expect(
          loadConfig({
            ...embedded,
            CODEXBOARD_CODEX_TRANSPORT: transport,
            CODEXBOARD_CODEX_ENDPOINT: endpoint,
          }).CODEXBOARD_CODEX_ENDPOINT,
        ).toBe(new URL(endpoint).toString());
      }
    },
  );
  it("rejects a remote endpoint and missing native paths for embedded mode", () => {
    expect(() =>
      loadConfig({ ...embedded, CODEXBOARD_CODEX_ENDPOINT: "ws://host.docker.internal:47825" }),
    ).toThrow();
    expect(() => loadConfig({ ...embedded, CODEXBOARD_CODEX_COMMAND: "codex" })).toThrow();
    expect(() =>
      loadConfig({ ...embedded, CODEXBOARD_CODEX_PROJECT_STATE_FILE: undefined }),
    ).toThrow();
  });
});

describe("unified Feishu credentials configuration", () => {
  const directory = mkdtempSync(join(tmpdir(), "feishu-credentials-config-"));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  const credentialsFile = join(directory, "feishu.json");
  writePrivateFixture(
    credentialsFile,
    JSON.stringify({ appId: "cli_credentials123", appSecret: "private-test-secret" }),
    { mode: 0o600 },
  );
  const legacySecretFile = join(directory, "legacy-secret");
  writePrivateFixture(legacySecretFile, "other-secret", { mode: 0o600 });

  it("loads both credentials from one private file in production Feishu mode", () => {
    const webRoot = join(directory, "web");
    mkdirSync(webRoot);
    writePrivateFixture(join(webRoot, "index.html"), "<html></html>");
    const tokenFile = join(directory, "token");
    writePrivateFixture(tokenFile, "test-token", { mode: 0o600 });

    const config = loadConfig({
      CODEXBOARD_ENV: "production",
      CODEXBOARD_AUTH_MODE: "feishu",
      CODEXBOARD_FEISHU_CREDENTIALS_FILE: credentialsFile,
      CODEXBOARD_CODEX_TRANSPORT: "websocket",
      CODEXBOARD_CODEX_TOKEN_FILE: tokenFile,
      CODEXBOARD_ORIGIN: "https://tasks.example.com",
      CODEXBOARD_WEB_ROOT: webRoot,
    });

    expect(config.CODEXBOARD_FEISHU_APP_ID).toBe("cli_credentials123");
    expect(config.CODEXBOARD_FEISHU_APP_SECRET).toBe("private-test-secret");
    expect(config.CODEXBOARD_FEISHU_APP_SECRET_FILE).toBeUndefined();
  });

  it.each([
    ["CODEXBOARD_FEISHU_APP_ID", "cli_other"],
    ["CODEXBOARD_FEISHU_APP_SECRET", "other-secret"],
    ["CODEXBOARD_FEISHU_APP_SECRET_FILE", legacySecretFile],
  ])("rejects a credentials file mixed with %s", (key, value) => {
    expect(() =>
      loadConfig({
        CODEXBOARD_FEISHU_CREDENTIALS_FILE: credentialsFile,
        [key]: value,
      }),
    ).toThrow(ConfigError);
  });

  it("rejects relative, missing, symlink and publicly readable credentials files", () => {
    const symlink = join(directory, "credentials-link");
    symlinkSync(credentialsFile, symlink);
    const publicFile = join(directory, "public.json");
    writePrivateFixture(publicFile, '{"appId":"cli_test","appSecret":"secret"}', { mode: 0o644 });

    for (const path of [
      "relative.json",
      join(directory, "missing.json"),
      symlink,
      publicFile,
      directory,
    ]) {
      expect(() => loadConfig({ CODEXBOARD_FEISHU_CREDENTIALS_FILE: path })).toThrow(ConfigError);
    }
  });

  it.each([
    '{"appSecret":"sensitive-parse-test",',
    JSON.stringify({ appId: "cli_test" }),
    JSON.stringify({ appId: "cli_test", appSecret: "" }),
    JSON.stringify({ appId: "cli_test", appSecret: 123 }),
    JSON.stringify({ appId: "invalid", appSecret: "sensitive-parse-test" }),
    JSON.stringify({ appId: "cli_test", appSecret: "secret\nline" }),
    "null",
  ])("rejects invalid credentials without echoing their contents (%#)", (contents) => {
    const path = join(directory, "invalid.json");
    writePrivateFixture(path, contents, { mode: 0o600 });
    let caught: unknown;
    try {
      loadConfig({ CODEXBOARD_FEISHU_CREDENTIALS_FILE: path });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect(JSON.stringify((caught as ConfigError).issues)).not.toContain("sensitive-parse-test");
  });
});

function writePrivateFixture(...args: Parameters<typeof writeFileSync>): void {
  writeFileSync(...args);
  const options = args[2];
  if (options && typeof options === "object") {
    if (options.mode === 0o600 || options.mode === 0o644) ensurePrivateFileSync(String(args[0]));
    if (options.mode === 0o644) makePublicReadableSync(String(args[0]));
  }
}
