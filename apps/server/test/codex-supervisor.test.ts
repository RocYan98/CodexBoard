import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { CodexAppServerSupervisor, type ManagedCodexProcess } from "../src/modules/codex/index.js";

class FakeProcess extends EventEmitter implements ManagedCodexProcess {
  readonly pid = 42;
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  readonly signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.killed = true;
    this.signals.push(signal);
    this.exitCode = signal === "SIGTERM" ? 0 : 1;
    queueMicrotask(() => this.emit("exit", this.exitCode, signal));
    return true;
  }
}

describe("Codex App Server supervisor", () => {
  it("uses an authenticated Windows pipe without putting the capability in arguments", async () => {
    const socketPath = "\\\\.\\pipe\\codexboard-supervisor-test";
    expect(() => new CodexAppServerSupervisor({ socketPath })).toThrow(/认证令牌/);
    const child = new FakeProcess();
    child.stdin.once("finish", () => {
      child.exitCode = 0;
      child.emit("exit", 0, null);
    });
    const spawnProcess = vi.fn<(...args: unknown[]) => FakeProcess>(() => {
      queueMicrotask(() => child.stdout.write("CODEXBOARD_BRIDGE_READY\n"));
      return child;
    });
    const supervisor = new CodexAppServerSupervisor({
      socketPath,
      token: "test-capability",
      spawnProcess,
      readinessProbe: async () => true,
      shutdownTimeoutMs: 20,
    });
    await supervisor.start();
    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(["--listen", "npipe://./pipe/codexboard-supervisor-test"]),
      expect.objectContaining({
        env: expect.objectContaining({ CODEXBOARD_BRIDGE_TOKEN: "test-capability" }),
      }),
    );
    expect(JSON.stringify(spawnProcess.mock.calls[0]?.[1])).not.toContain("test-capability");
    await supervisor.stop();
    expect(child.signals).toEqual([]);
  });

  it("does not trust a reachable Windows pipe until the owned child has bound it", async () => {
    const child = new FakeProcess();
    const readinessProbe = vi.fn(async () => true);
    const supervisor = new CodexAppServerSupervisor({
      socketPath: "\\\\.\\pipe\\codexboard-preexisting-test",
      token: "test-capability",
      spawnProcess: () => child,
      readinessProbe,
      startupTimeoutMs: 10,
      startupPollMs: 1,
    });
    await expect(supervisor.start()).rejects.toThrow("Codex App Server 启动失败");
    expect(readinessProbe).not.toHaveBeenCalled();
    expect(supervisor.health().status).not.toBe("ready");
  });

  it("starts one owned process, reports health and stops only that child", async () => {
    const child = new FakeProcess();
    const spawnProcess = vi.fn(() => child);
    const supervisor = new CodexAppServerSupervisor({
      socketPath: "/private/tmp/codexboard-test.sock",
      spawnProcess,
      readinessProbe: async () => true,
      startupTimeoutMs: 200,
      shutdownTimeoutMs: 200,
    });

    await supervisor.start();
    await supervisor.start();
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      [
        expect.stringContaining("scripts/codex-session-bridge.mjs"),
        "--codex",
        "codex",
        "--listen",
        "unix:///private/tmp/codexboard-test.sock",
      ],
      expect.objectContaining({ stdio: ["ignore", "ignore", "pipe"] }),
    );
    expect(supervisor.health()).toEqual({ status: "ready", pid: 42, error: null });

    await supervisor.stop();
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(supervisor.health()).toEqual({ status: "offline", pid: null, error: null });
  });

  it("fails startup without leaking stderr secrets", async () => {
    const child = new FakeProcess();
    const supervisor = new CodexAppServerSupervisor({
      socketPath: "/private/tmp/codexboard-test.sock",
      spawnProcess: () => {
        queueMicrotask(() => {
          child.stderr.write("Authorization: Bearer very-secret-token\n");
          child.exitCode = 1;
          child.emit("exit", 1, null);
        });
        return child;
      },
      readinessProbe: async () => false,
      startupTimeoutMs: 200,
      startupPollMs: 5,
    });

    await expect(supervisor.start()).rejects.toThrow("Codex App Server 启动失败");
    expect(supervisor.health().error).not.toContain("very-secret-token");
    expect(supervisor.health().error).toContain("[REDACTED]");
  });

  it("signals an unexpected child exit so the service manager can restart the parent", async () => {
    const child = new FakeProcess();
    const onUnexpectedExit = vi.fn();
    const supervisor = new CodexAppServerSupervisor({
      socketPath: "/private/tmp/codexboard-test.sock",
      spawnProcess: () => child,
      readinessProbe: async () => true,
    });
    supervisor.onUnexpectedExit(onUnexpectedExit);
    await supervisor.start();

    child.exitCode = 1;
    child.emit("exit", 1, null);

    expect(onUnexpectedExit).toHaveBeenCalledOnce();
    expect(supervisor.health()).toMatchObject({ status: "error", pid: null });
  });

  it("replays a clean unexpected exit that occurs before the restart handler is registered", async () => {
    const child = new FakeProcess();
    const supervisor = new CodexAppServerSupervisor({
      socketPath: "/private/tmp/codexboard-late-handler.sock",
      spawnProcess: () => child,
      readinessProbe: async () => true,
    });
    await supervisor.start();
    child.exitCode = 0;
    child.emit("exit", 0, null);
    const onUnexpectedExit = vi.fn();

    supervisor.onUnexpectedExit(onUnexpectedExit);
    await Promise.resolve();

    expect(onUnexpectedExit).toHaveBeenCalledOnce();
    expect(supervisor.health()).toMatchObject({
      status: "error",
      pid: null,
      error: "Codex App Server 意外退出",
    });
  });

  it("refuses to remove a non-socket file from the configured socket path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexboard-supervisor-"));
    const socketPath = join(directory, "codex.sock");
    writeFileSync(socketPath, "do-not-delete");
    const spawnProcess = vi.fn(() => new FakeProcess());
    const supervisor = new CodexAppServerSupervisor({ socketPath, spawnProcess });
    try {
      await expect(supervisor.start()).rejects.toThrow(/非 Socket 文件/);
      expect(spawnProcess).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("turns an asynchronous spawn error into a stable startup failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexboard-spawn-error-"));
    const missingCommand = join(directory, "missing-codex");
    const child = new FakeProcess();
    const supervisor = new CodexAppServerSupervisor({
      socketPath: join(directory, "codex.sock"),
      codexCommand: missingCommand,
      spawnProcess: () => {
        queueMicrotask(() => child.emit("error", new Error(`spawn ${missingCommand} ENOENT`)));
        return child;
      },
      readinessProbe: async () => false,
      startupTimeoutMs: 200,
      startupPollMs: 5,
    });
    vi.useFakeTimers();
    try {
      const failed = expect(supervisor.start()).rejects.toThrow("Codex App Server 启动失败");
      await vi.runAllTimersAsync();
      await failed;
      expect(supervisor.health().error).toBe("Codex App Server 进程启动失败");
      expect(supervisor.health().error).not.toContain(missingCommand);
      await expect(supervisor.stop()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
