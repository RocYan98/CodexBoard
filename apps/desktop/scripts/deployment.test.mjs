import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readDeploymentConfiguration,
  saveDeploymentConfiguration,
  initializeDeployment,
  desktopPaths,
} from "./runtime.mjs";
import { assertPrivateFileSync } from "#private-file-permissions";
const tunnel = (domain) =>
  `[[proxies]]\nname = "board"\ntype = "https"\nlocalIP = "127.0.0.1"\nlocalPort = 8443\ncustomDomains = ["${domain}"]\n`;
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "codexboard-config-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, "deploy");
  initializeDeployment(dir);
  const paths = readDeploymentConfiguration(dir).paths;
  writeFileSync(paths.credentials, JSON.stringify({ appId: "cli_old", appSecret: "old-secret" }), {
    mode: 0o600,
  });
  writeFileSync(paths.frpc, tunnel("old.example.com"));
  return { dir, base, ...paths };
}
test("connection configuration follows the saved Caddy port", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, "ports.json"), JSON.stringify({ caddy: 9443 }));
  const frpc = tunnel("custom.example.com").replace("8443", "9443");
  const saved = await saveDeploymentConfiguration(
    f.dir,
    {
      appId: "cli_custom",
      appSecret: "test-secret",
      frpc,
    },
    async () => {},
  );
  assert.equal(saved.origin, "https://custom.example.com");
  assert.equal(readDeploymentConfiguration(f.dir).originError, "");
  await assert.rejects(
    saveDeploymentConfiguration(
      f.dir,
      {
        appId: "cli_custom",
        appSecret: "test-secret",
        frpc: tunnel("custom.example.com"),
      },
      async () => {},
    ),
    /9443/,
  );
});
test("saves credentials together and derives origin exclusively from frpc", async (t) => {
  const f = fixture(t);
  const result = await saveDeploymentConfiguration(
    f.dir,
    {
      appId: "cli_new",
      appSecret: "new-secret",
      origin: "https://ignored.test",
      frpc: tunnel("new.example.com"),
    },
    async (path) => assert.match(readFileSync(path, "utf8"), /new.example.com/),
  );
  assert.deepEqual(JSON.parse(readFileSync(f.credentials, "utf8")), {
    appId: "cli_new",
    appSecret: "new-secret",
  });
  assert.equal(result.origin, "https://new.example.com");
  assert.equal(result.appSecret, "new-secret");
  if (process.platform === "win32") assert.doesNotThrow(() => assertPrivateFileSync(f.credentials));
  else assert.equal(statSync(f.credentials).mode & 0o777, 0o600);
  if (process.platform === "win32") assert.doesNotThrow(() => assertPrivateFileSync(f.frpc));
  else assert.equal(statSync(f.frpc).mode & 0o777, 0o600);
  assert.equal(existsSync(join(f.dir, "production.env")), false);
  assert.equal(existsSync(join(f.base, "secrets/feishu-app-secret")), false);
});
test("blank values are rejected without changing saved files", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    saveDeploymentConfiguration(
      f.dir,
      { appId: "cli_new", appSecret: "", frpc: "" },
      async () => {},
    ),
    /同时填写/,
  );
  assert.equal(readDeploymentConfiguration(f.dir).appSecret, "old-secret");
});
test("invalid tunnel official verification changes no files or leaks validator details", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    saveDeploymentConfiguration(
      f.dir,
      { appId: "cli_new", appSecret: "new-secret", frpc: tunnel("new.example.com") },
      async () => {
        throw new Error("secret-value");
      },
    ),
    /frpc.toml 配置无效/,
  );
  assert.equal(readDeploymentConfiguration(f.dir).appId, "cli_old");
});
test("ambiguous domain changes no files", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    saveDeploymentConfiguration(
      f.dir,
      {
        appId: "cli_new",
        appSecret: "new-secret",
        frpc: tunnel("new.example.com").replace(
          '["new.example.com"]',
          '["one.example.com", "two.example.com"]',
        ),
      },
      async () => {},
    ),
  );
  assert.equal(readDeploymentConfiguration(f.dir).appId, "cli_old");
});
test("rejects invalid app id and credential symlinks", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    saveDeploymentConfiguration(f.dir, { appId: "bad\nINJECT=1" }, async () => {}),
    /App ID/,
  );
  rmSync(f.credentials);
  symlinkSync(f.frpc, f.credentials);
  await assert.rejects(
    saveDeploymentConfiguration(
      f.dir,
      { appId: "cli_new", appSecret: "changed", frpc: tunnel("new.example.com") },
      async () => {},
    ),
    /普通文件/,
  );
  assert.match(readFileSync(f.frpc, "utf8"), /old.example.com/);
});
test("file reads reflect changed frpc domain while preserving the editable invalid content", (t) => {
  const f = fixture(t);
  writeFileSync(f.frpc, tunnel("changed.example.com"));
  assert.equal(readDeploymentConfiguration(f.dir).origin, "https://changed.example.com");
  writeFileSync(f.frpc, "invalid");
  const result = readDeploymentConfiguration(f.dir);
  assert.equal(result.origin, "");
  assert.ok(result.originError);
  assert.equal(result.frpc, "invalid");
  assert.equal(result.appId, "cli_old");
});
test("first launch creates credentials and token once without env files", (t) => {
  const f = fixture(t);
  const token = desktopPaths(f.dir).CODEXBOARD_CODEX_TOKEN_FILE;
  const before = readFileSync(token, "utf8");
  initializeDeployment(f.dir);
  assert.equal(readFileSync(token, "utf8"), before);
  if (process.platform === "win32") assert.doesNotThrow(() => assertPrivateFileSync(token));
  else assert.equal(statSync(token).mode & 0o777, 0o600);
  assert.equal(readDeploymentConfiguration(f.dir).appId, "cli_old");
  assert.equal(existsSync(join(f.dir, "desktop.env")), false);
  assert.equal(existsSync(join(f.dir, "production.env")), false);
});
test("migrates legacy credentials once before removing old files", (t) => {
  const f = fixture(t);
  rmSync(f.credentials);
  const oldProd = join(f.dir, "production.env"),
    oldSecret = join(f.base, "secrets/feishu-app-secret");
  writeFileSync(
    oldProd,
    'CODEXBOARD_FEISHU_APP_ID="cli_migrated"\nCODEXBOARD_ORIGIN=https://stale.test\n',
  );
  writeFileSync(oldSecret, "migrated-secret\n", { mode: 0o600 });
  initializeDeployment(f.dir);
  const result = readDeploymentConfiguration(f.dir);
  assert.equal(result.appId, "cli_migrated");
  assert.equal(result.appSecret, "migrated-secret");
  assert.equal(result.origin, "https://old.example.com");
  assert.equal(existsSync(oldProd), false);
  assert.equal(existsSync(oldSecret), false);
});
test("conflicting renamed credential keys preserve the complete legacy configuration", (t) => {
  const f = fixture(t);
  const oldProd = join(f.dir, "production.env");
  const body = "CODEXBOARD_FEISHU_APP_ID=cli_new\nLARK_CODEX_FEISHU_APP_ID=cli_old\n";
  writeFileSync(oldProd, body);
  const before = readFileSync(f.credentials);
  assert.throws(() => initializeDeployment(f.dir), /不一致/);
  assert.equal(readFileSync(oldProd, "utf8"), body);
  assert.deepEqual(readFileSync(f.credentials), before);
});

test("malformed new credential file does not erase legacy data", (t) => {
  const f = fixture(t);
  const oldProd = join(f.dir, "production.env");
  writeFileSync(oldProd, "CODEXBOARD_FEISHU_APP_ID=cli_old\n");
  writeFileSync(f.credentials, "invalid secret-value");
  assert.throws(() => initializeDeployment(f.dir), /凭据/);
  assert.equal(existsSync(oldProd), true);
});
test("broken credentials remain repairable from the configuration editor", async (t) => {
  const f = fixture(t);
  writeFileSync(f.credentials, "broken-secret-json");
  const broken = readDeploymentConfiguration(f.dir);
  assert.equal(broken.appId, "");
  assert.ok(broken.credentialsError);
  assert.equal(broken.frpc, tunnel("old.example.com"));
  await saveDeploymentConfiguration(
    f.dir,
    { appId: "cli_repaired", appSecret: "repaired-secret", frpc: broken.frpc },
    async () => {},
  );
  assert.equal(readDeploymentConfiguration(f.dir).appId, "cli_repaired");
});
test("extra credential JSON fields are reported consistently with the backend", (t) => {
  const f = fixture(t);
  writeFileSync(
    f.credentials,
    JSON.stringify({ appId: "cli_old", appSecret: "old-secret", unexpected: "value" }),
  );
  assert.ok(readDeploymentConfiguration(f.dir).credentialsError);
});
test("an explicit save resolves conflicting legacy credentials without retaining old files", async (t) => {
  const f = fixture(t);
  const legacy = join(f.dir, "production.env");
  writeFileSync(legacy, "CODEXBOARD_FEISHU_APP_ID=cli_conflict\n");
  assert.throws(() => initializeDeployment(f.dir), /不一致/);
  await saveDeploymentConfiguration(
    f.dir,
    { appId: "cli_chosen", appSecret: "chosen-secret", frpc: tunnel("old.example.com") },
    async () => {},
  );
  assert.equal(existsSync(legacy), false);
  initializeDeployment(f.dir);
  assert.equal(readDeploymentConfiguration(f.dir).appId, "cli_chosen");
});

test("legacy manual access and certificate files cannot override frpc or block startup configuration", async (t) => {
  const f = fixture(t);
  const { dirname } = await import("node:path");
  const secrets = dirname(f.frpc);
  const legacy = ["public-access.json", "public-certificate.pem", "public-private-key.pem"];
  for (const file of legacy)
    writeFileSync(join(secrets, file), "obsolete-invalid-content", { mode: 0o600 });
  assert.equal(readDeploymentConfiguration(f.dir).origin, "https://old.example.com");
  assert.equal(readDeploymentConfiguration(f.dir).originError, "");
  const frpc = tunnel("http.example.com").replace('type = "https"', 'type = "http"');
  const saved = await saveDeploymentConfiguration(
    f.dir,
    {
      appId: "cli_test",
      appSecret: "secret",
      frpc,
      publicDomain: "ignored.example.com",
      publicPort: "8888",
      certificatePem: "invalid",
      privateKeyPem: "invalid",
    },
    async () => {},
  );
  assert.equal(saved.origin, "http://http.example.com");
  for (const file of legacy)
    assert.equal(readFileSync(join(secrets, file), "utf8"), "obsolete-invalid-content");
  assert.deepEqual(Object.keys(saved.paths).sort(), ["credentials", "frpc"]);
});

test("saving unchanged connections preserves files and skips verification", async (t) => {
  const f = fixture(t);
  const before = [f.credentials, f.frpc].map((path) => ({
    content: readFileSync(path),
    mtime: statSync(path).mtimeMs,
  }));
  let verified = 0;
  const result = await saveDeploymentConfiguration(
    f.dir,
    {
      appId: " cli_old ",
      appSecret: "old-secret",
      frpc: tunnel("old.example.com").trim(),
    },
    async () => {
      verified++;
    },
  );
  assert.equal(result.changed, false);
  assert.equal(verified, 0);
  for (const [i, path] of [f.credentials, f.frpc].entries()) {
    assert.deepEqual(readFileSync(path), before[i].content);
    assert.equal(statSync(path).mtimeMs, before[i].mtime);
  }
});

test("changed connections request restart only on their first save", async (t) => {
  const f = fixture(t);
  const values = { appId: "cli_old", appSecret: "new-secret", frpc: tunnel("old.example.com") };
  assert.equal((await saveDeploymentConfiguration(f.dir, values, async () => {})).changed, true);
  assert.equal((await saveDeploymentConfiguration(f.dir, values, async () => {})).changed, false);
});

test("unchanged explicit saves still clear conflicting legacy credentials", async (t) => {
  const f = fixture(t);
  const legacy = join(f.dir, "production.env");
  writeFileSync(legacy, "LARK_APP_ID=cli_legacy\nLARK_APP_SECRET=legacy-secret\n");
  const result = await saveDeploymentConfiguration(
    f.dir,
    { appId: "cli_old", appSecret: "old-secret", frpc: tunnel("old.example.com") },
    async () => {},
  );
  assert.equal(result.changed, false);
  assert.equal(existsSync(legacy), false);
});

test("Web-only configuration needs no Feishu credentials and rejects plaintext access", async (t) => {
  const f = fixture(t);
  const values = { appId: "", appSecret: "", frpc: tunnel("web.example.com") };
  const saved = await saveDeploymentConfiguration(f.dir, values, async () => {});
  assert.equal(saved.accessMode, "web");
  assert.equal(readDeploymentConfiguration(f.dir).accessMode, "web");
  await assert.rejects(
    saveDeploymentConfiguration(
      f.dir,
      { ...values, frpc: values.frpc.replace('type = "https"', 'type = "http"') },
      async () => {},
    ),
    /HTTPS/,
  );
  assert.equal(readDeploymentConfiguration(f.dir).accessMode, "web");
  await assert.rejects(
    saveDeploymentConfiguration(f.dir, { ...values, appId: "cli_partial" }, async () => {}),
    /同时填写/,
  );
});

test("Feishu and Web coexist even with an old Web-only selection file", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, "access.json"), JSON.stringify({ accessMode: "web" }));
  assert.equal(readDeploymentConfiguration(f.dir).accessMode, "feishu");
  const saved = await saveDeploymentConfiguration(
    f.dir,
    { appId: "cli_both", appSecret: "both-secret", frpc: tunnel("both.example.com") },
    async () => {},
  );
  assert.equal(saved.accessMode, "feishu");
  assert.equal(saved.appId, "cli_both");
});
