import { spawnSync, fork } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dataDirectory = mkdtempSync(join(tmpdir(), "codexboard-e2e-"));
const temporaryProjectRoot = join(dataDirectory, "temporary-project-root");
mkdirSync(temporaryProjectRoot);
const fakeCodexCommand = resolve("scripts/fake-codex-app-server.mjs");
// All naming generations may be configured in a developer's shell. Keep
// deployment endpoints, credentials and directories out of synthetic tests.
const testEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !["CODEXBOARD_", "LARK_CODEX_", "LARK_TASKBOARD_"].some((prefix) => key.startsWith(prefix)),
  ),
);

async function allocateLoopbackPorts(count) {
  const reservations = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const reservation = createServer();
      await new Promise((resolveListen, rejectListen) => {
        reservation.once("error", rejectListen);
        reservation.listen(0, "127.0.0.1", resolveListen);
      });
      reservations.push(reservation);
    }
    return reservations.map((reservation) => {
      const address = reservation.address();
      if (!address || typeof address === "string") {
        throw new Error("无法分配 E2E 回环端口");
      }
      return address.port;
    });
  } finally {
    await Promise.all(
      reservations.map(
        (reservation) =>
          new Promise((resolveClose) => reservation.close(() => resolveClose(undefined))),
      ),
    );
  }
}

const [publicPort, adminPort, webPort] = await allocateLoopbackPorts(3);

const fakeCodexHome = join(dataDirectory, "codex-home");
const desktop = fork(resolve("scripts/fake-codex-desktop.mjs"), [], {
  env: {
    ...testEnvironment,
    FAKE_CODEX_HOME: fakeCodexHome,
    CODEX_ELECTRON_USER_DATA_PATH: join(fakeCodexHome, "desktop-settings"),
    FAKE_CODEX_INTERRUPT_DELAY_MS: "1500",
  },
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});
try {
  await new Promise((resolveReady, rejectReady) => {
    desktop.once("message", resolveReady);
    desktop.once("error", rejectReady);
    desktop.once("exit", () => rejectReady(new Error("Fake Desktop exited before ready")));
  });
  const result = spawnSync(
    process.execPath,
    [resolve("node_modules/@playwright/test/cli.js"), "test", ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: {
        ...testEnvironment,
        FAKE_CODEX_HOME: fakeCodexHome,
        CODEX_ELECTRON_USER_DATA_PATH: join(fakeCodexHome, "desktop-settings"),
        CODEXBOARD_ENV: "test",
        CODEXBOARD_AUTH_MODE: "development",
        CODEXBOARD_HOST: "127.0.0.1",
        CODEXBOARD_ADMIN_HOST: "127.0.0.1",
        CODEXBOARD_CODEX_TRANSPORT: "managed-unix",
        CODEXBOARD_DATA_DIR: dataDirectory,
        CODEXBOARD_TEMPORARY_PROJECT_ROOT: temporaryProjectRoot,
        CODEXBOARD_WORKSPACE_ROOTS: dataDirectory,
        CODEXBOARD_CODEX_COMMAND: fakeCodexCommand,
        CODEXBOARD_PORT: String(publicPort),
        CODEXBOARD_ADMIN_PORT: String(adminPort),
        CODEXBOARD_ALLOWED_HOSTS: `127.0.0.1:${publicPort},localhost:${publicPort}`,
        CODEXBOARD_ORIGIN: `http://127.0.0.1:${webPort}`,
        CODEXBOARD_WEB_PORT: String(webPort),
        CODEXBOARD_WEB_API_TARGET: `http://127.0.0.1:${publicPort}`,
        FAKE_CODEX_INTERRUPT_DELAY_MS: "1500",
      },
    },
  );
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
} finally {
  const exited = new Promise((resolveExit) => desktop.once("exit", resolveExit));
  desktop.kill("SIGTERM");
  if (desktop.exitCode === null) await exited;
  rmSync(dataDirectory, { recursive: true, force: true });
}
