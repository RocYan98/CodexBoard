import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join, resolve, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { ensurePrivateDirectorySync, ensurePrivateFileSync } from "#private-file-permissions";
import { nodeScriptArguments } from "#node-script-arguments";

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
export async function smokePackagedServer({ runtimeRoot, nodePath, timeoutMs = 120_000 }) {
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
    const env = {};
    for (const name of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
      const key = Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase());
      if (key) env[name] = process.env[key];
    }
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
    if (!ready)
      throw smokeError(outcome ? "SMOKE_BACKEND_EXITED" : "SMOKE_BACKEND_TIMEOUT", [
        ...diagnostics,
        ...(Number.isInteger(outcome?.code) ? [`EXIT_${outcome.code}`] : []),
        ...(["SIGABRT", "SIGKILL", "SIGTERM", "SIGSEGV", "SIGILL"].includes(outcome?.signal)
          ? [outcome.signal]
          : []),
      ]);
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
