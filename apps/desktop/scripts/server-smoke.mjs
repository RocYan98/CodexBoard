import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join, resolve, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { ensurePrivateDirectorySync, ensurePrivateFileSync } from "#private-file-permissions";
import { nodeScriptArguments } from "#node-script-arguments";
import { windowsSystemEnvironment } from "#windows-system-environment";

const host = "codexboard-smoke.invalid";
const knownErrors = new Set([
  "CONFIG_INVALID",
  "MIGRATION_FAILED",
  "INTERNAL_ERROR",
  "IDENTITY_MIGRATION_PREFLIGHT_FAILED",
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
  "ERR_DLOPEN_FAILED",
  "ERR_UNKNOWN_FILE_EXTENSION",
  "EADDRINUSE",
  "EACCES",
  "EPERM",
  "ENOENT",
  "EISDIR",
  "SQLITE_CANTOPEN",
  "SQLITE_BUSY",
]);
const configFields = [
  "CODEXBOARD_CODEX_TOKEN_FILE",
  "CODEXBOARD_WEB_ROOT",
  "CODEXBOARD_WORKSPACE_ROOTS",
  "CODEXBOARD_CODEX_ENDPOINT",
  "CODEXBOARD_PORT",
  "CODEXBOARD_ADMIN_PORT",
  "CODEXBOARD_DATA_DIR",
  "CODEXBOARD_AUTH_MODE",
  "CODEXBOARD_ORIGIN",
  "CODEXBOARD_CODEX_PROJECT_SNAPSHOT_FILE",
];

// Run only against the same isolated fixture after a failed backend. Config
// validation reads synthetic files; it does not import main or start a bridge.
export function smokeConfigDiagnostics({ runtimeRoot, nodePath, env }) {
  const allowed = new Set([
    "SMOKE_CONFIG_IMPORT_FAILED",
    "SMOKE_CONFIG_RECHECK_PASSED",
    "SMOKE_CONFIG_RECHECK_FAILED",
    "ACL_FAILED",
    "WEB_INDEX_MISSING",
    "TOKEN_EMPTY",
    ...configFields,
  ]);
  const program = `
    const fields = new Set(${JSON.stringify(configFields)});
    let stage = 'import';
    try {
      const { loadConfig } = await import(process.argv[1]);
      stage = 'config';
      loadConfig();
      console.log(JSON.stringify(['SMOKE_CONFIG_RECHECK_PASSED']));
    } catch (error) {
      const issues = Array.isArray(error.issues)
        ? error.issues.filter(issue => typeof issue === 'string') : [];
      const codes = [stage === 'import' ? 'SMOKE_CONFIG_IMPORT_FAILED' : 'SMOKE_CONFIG_RECHECK_FAILED'];
      for (const issue of issues) {
        const field = issue.split(':', 1)[0];
        if (fields.has(field)) codes.push(field);
        if (issue.includes('Windows 私有 ACL 检查失败')) codes.push('ACL_FAILED');
        if (issue.includes('Web 构建目录缺少 index.html')) codes.push('WEB_INDEX_MISSING');
        if (issue.includes('文件内容为空')) codes.push('TOKEN_EMPTY');
      }
      console.log(JSON.stringify([...new Set(codes)]));
      process.exitCode = 1;
    }
  `;
  const result = spawnSync(
    nodePath,
    [
      "--input-type=module",
      "-e",
      program,
      pathToFileURL(join(runtimeRoot, "apps/server/dist/config.js")).href,
    ],
    {
      cwd: runtimeRoot,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 8192,
    },
  );
  // Never relay the child stderr or arbitrary config issue text, even when a
  // dependency prints before the JSON result or the diagnostic itself fails.
  if (!result.error) {
    try {
      const codes = JSON.parse(result.stdout);
      if (Array.isArray(codes) && codes.length && codes.every((code) => allowed.has(code)))
        return [...new Set(codes)];
    } catch {
      /* Return only a fixed diagnostic failure below. */
    }
  }
  return ["SMOKE_CONFIG_DIAGNOSTIC_FAILED"];
}

function smokeError(code, diagnostics = []) {
  const error = new Error(`${code}${diagnostics.length ? `: ${diagnostics.join(",")}` : ""}`);
  error.code = code;
  return error;
}

async function reservePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { port: server.address().port, close: () => new Promise((done) => server.close(done)) };
}

function request(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path, headers: { host }, agent: false },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
          if (body.length > 1024 * 1024) res.destroy(smokeError("SMOKE_RESPONSE_TOO_LARGE"));
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve({ status: res.statusCode, body, type: res.headers["content-type"] }),
        );
      },
    );
    req.setTimeout(1000, () => req.destroy(smokeError("SMOKE_REQUEST_TIMEOUT")));
    req.once("error", reject);
  });
}

/** Exercises only an explicitly supplied package with synthetic data and a local fake peer. */
export async function smokePackagedServer({
  runtimeRoot,
  nodePath,
  timeoutMs = 120_000,
  onStage = () => {},
  diagnoseWindowsShell = false,
}) {
  if (!runtimeRoot || !nodePath) throw smokeError("SMOKE_EXPLICIT_PACKAGE_REQUIRED");
  // Match Tauri's canonical Windows resource directory, including the namespace
  // prefix passed through cwd and web assets, rather than testing only argv.
  const root =
    process.platform === "win32"
      ? win32.toNamespacedPath(realpathSync.native(runtimeRoot))
      : resolve(runtimeRoot);
  const script = join(root, "apps/server/dist/main.js");
  if (!existsSync(script) || !existsSync(nodePath)) throw smokeError("SMOKE_PACKAGE_INCOMPLETE");
  const scratch = mkdtempSync(join(realpathSync.native(tmpdir()), "codexboard-server-smoke-"));
  const diagnostics = new Set();
  let child, closed, outcome, peer, api, admin;
  let unexpectedMethod = false;
  try {
    onStage("private-fixture");
    ensurePrivateDirectorySync(scratch);
    const home = join(scratch, "home");
    const data = join(scratch, "data");
    const codexHome = join(home, ".codex");
    const workspace = join(scratch, "workspace");
    const temp = join(scratch, "tmp");
    for (const directory of [home, data, codexHome, workspace, temp]) mkdirSync(directory);
    const tokenFile = join(scratch, "fake-bridge-token");
    const token = randomBytes(32).toString("hex");
    writeFileSync(tokenFile, "", { flag: "wx", mode: 0o600 });
    ensurePrivateFileSync(tokenFile);
    writeFileSync(tokenFile, token);
    const snapshotFile = join(scratch, "fake-projects.json");
    writeFileSync(
      snapshotFile,
      JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), projects: [] }),
    );
    peer = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      verifyClient: ({ req }) => req.headers.authorization === `Bearer ${token}`,
    });
    await new Promise((resolve, reject) => {
      peer.once("listening", resolve);
      peer.once("error", reject);
    });
    const replies = new Map([
      ["initialize", { userAgent: "packaged-server-smoke", codexHome }],
      ["config/read", { config: {} }],
      ["account/read", { account: null, requiresOpenaiAuth: true }],
      ["account/rateLimits/read", { rateLimits: {} }],
      ["model/list", { data: [], nextCursor: null }],
      ["thread/list", { data: [], nextCursor: null }],
    ]);
    peer.on("connection", (socket) =>
      socket.on("message", (bytes) => {
        try {
          const message = JSON.parse(bytes.toString());
          if (message.method === "initialized") return;
          if (!replies.has(message.method)) {
            unexpectedMethod = true;
            if ("id" in message)
              socket.send(
                JSON.stringify({
                  id: message.id,
                  error: { code: -32601, message: "Smoke peer rejects this method" },
                }),
              );
            return;
          }
          socket.send(JSON.stringify({ id: message.id, result: replies.get(message.method) }));
        } catch {
          unexpectedMethod = true;
          socket.close();
        }
      }),
    );
    api = await reservePort();
    admin = await reservePort();
    const env = process.platform === "win32" ? windowsSystemEnvironment() : {};
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData/Roaming"),
      LOCALAPPDATA: join(home, "AppData/Local"),
      CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      TMP: temp,
      TEMP: temp,
      TMPDIR: temp,
      PATH: [
        join(root, "bin"),
        ...(process.platform === "win32"
          ? [join(env.SystemRoot || "C:\\Windows", "System32")]
          : ["/usr/bin", "/bin"]),
      ].join(delimiter),
      CODEXBOARD_ENV: "production",
      CODEXBOARD_AUTH_MODE: "web",
      CODEXBOARD_ORIGIN: `https://${host}`,
      CODEXBOARD_ALLOWED_HOSTS: host,
      CODEXBOARD_HOST: "127.0.0.1",
      CODEXBOARD_ADMIN_HOST: "127.0.0.1",
      CODEXBOARD_PORT: String(api.port),
      CODEXBOARD_ADMIN_PORT: String(admin.port),
      CODEXBOARD_DATA_DIR: data,
      CODEXBOARD_WORKSPACE_ROOTS: workspace,
      CODEXBOARD_WEB_ROOT: join(root, "apps/web/dist"),
      CODEXBOARD_CODEX_TRANSPORT: "websocket",
      CODEXBOARD_CODEX_ENDPOINT: `ws://127.0.0.1:${peer.address().port}`,
      CODEXBOARD_CODEX_TOKEN_FILE: tokenFile,
      CODEXBOARD_CODEX_PROJECT_SNAPSHOT_FILE: snapshotFile,
      // A regression that attempts a managed/embedded worker cannot find a real executable.
      CODEXBOARD_CODEX_COMMAND: join(scratch, "nonexistent-codex"),
    });
    await api.close();
    await admin.close();
    onStage("backend-spawn");
    child = spawn(nodePath, nodeScriptArguments(script), {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    closed = new Promise((resolve) =>
      child.once("close", (code, signal) => {
        outcome = { code, signal };
        resolve(outcome);
      }),
    );
    child.once("error", (error) => {
      if (knownErrors.has(error.code)) diagnostics.add(error.code);
    });
    // Retain only allowlisted codes. Never print native output, paths, config or tokens.
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (bytes) => {
        for (const match of bytes.toString().matchAll(/\b[A-Z][A-Z_]{2,63}\b/g))
          if (knownErrors.has(match[0])) diagnostics.add(match[0]);
      });
    const deadline = Date.now() + timeoutMs;
    let ready = false;
    while (Date.now() < deadline && !outcome) {
      try {
        const health = await request(api.port, "/api/health");
        const payload = JSON.parse(health.body);
        if (
          health.status === 200 &&
          payload.service === "codexboard-server" &&
          payload.checks?.sqlite === "ok"
        ) {
          ready = true;
          break;
        }
      } catch {
        /* Wait only for this isolated child to listen. */
      }
      await delay(100);
    }
    if (!ready) {
      if (diagnostics.has("CONFIG_INVALID")) {
        onStage("config-diagnostic");
        for (const code of smokeConfigDiagnostics({ runtimeRoot: root, nodePath, env }))
          diagnostics.add(code);
      }
      if (diagnoseWindowsShell && process.platform === "win32" && diagnostics.has("ACL_FAILED")) {
        try {
          const { diagnoseIsolatedPowerShell } =
            await import("./isolated-powershell-diagnostic.mjs");
          await diagnoseIsolatedPowerShell({
            env,
            cwd: root,
            tokenFile,
            fixtureRoot: scratch,
            onResult: (result) =>
              process.stdout.write(`SMOKE_WINDOWS_POWERSHELL ${JSON.stringify(result)}\n`),
          });
        } catch {
          diagnostics.add("SMOKE_WINDOWS_DIAGNOSTIC_FAILED");
        }
      }
      throw smokeError(outcome ? "SMOKE_BACKEND_EXITED" : "SMOKE_BACKEND_TIMEOUT", [
        ...diagnostics,
        ...(Number.isInteger(outcome?.code) ? [`EXIT_${outcome.code}`] : []),
        ...(["SIGABRT", "SIGKILL", "SIGTERM", "SIGSEGV", "SIGILL"].includes(outcome?.signal)
          ? [outcome.signal]
          : []),
      ]);
    }
    onStage("backend-ready");
    const page = await request(api.port, "/");
    if (
      page.status !== 200 ||
      !page.type?.includes("text/html") ||
      !/<!doctype html/i.test(page.body)
    )
      throw smokeError("SMOKE_WEB_ASSETS_FAILED");
    const protectedRoute = await request(api.port, "/api/v1/projects");
    if (protectedRoute.status !== 401) throw smokeError("SMOKE_AUTH_BOUNDARY_FAILED");
    if (unexpectedMethod) throw smokeError("SMOKE_FAKE_PEER_REJECTED_METHOD");
    onStage("backend-shutdown");
    child.send({ type: "codexboard.shutdown" });
    const stopped = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 15_000);
      void closed.then((result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
    if (stopped === null) throw smokeError("SMOKE_SHUTDOWN_TIMEOUT");
    if (outcome.code !== 0 || outcome.signal)
      throw smokeError("SMOKE_SHUTDOWN_FAILED", [...diagnostics]);
    if (unexpectedMethod) throw smokeError("SMOKE_FAKE_PEER_REJECTED_METHOD");
    return {
      status: "passed",
      backendHealth: true,
      webAssets: true,
      authenticationRequired: true,
      gracefulShutdown: true,
      codexMode: "isolated-fake-websocket",
    };
  } finally {
    onStage("fixture-cleanup");
    if (child && !outcome) {
      child.kill("SIGKILL");
      await closed;
    }
    for (const client of peer?.clients ?? []) client.terminate();
    if (peer) await new Promise((done) => peer.close(done));
    await api?.close();
    await admin?.close();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
