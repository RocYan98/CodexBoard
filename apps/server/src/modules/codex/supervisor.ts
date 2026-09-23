import { fileURLToPath } from "node:url";

import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import type { Readable, Writable } from "node:stream";
import { isWindowsPipePath, localEndpoint } from "../../../../../scripts/codex-local-endpoint.mjs";

export interface ManagedCodexProcess {
  readonly pid?: number;
  readonly stderr: Readable;
  readonly stdin?: Writable | null;
  readonly stdout?: Readable | null;
  readonly killed: boolean;
  readonly exitCode: number | null;
  kill(signal: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface CodexSupervisorHealth {
  readonly status: "offline" | "starting" | "ready" | "error";
  readonly pid: number | null;
  readonly error: string | null;
}

interface CodexAppServerSupervisorOptions {
  readonly socketPath: string;
  readonly codexCommand?: string;
  readonly token?: string;
  readonly startupTimeoutMs?: number;
  readonly startupPollMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly spawnProcess?: (
    command: string,
    arguments_: readonly string[],
    options: SpawnOptions,
  ) => ManagedCodexProcess;
  readonly readinessProbe?: () => Promise<boolean>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function redact(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:token|secret|password|api[_-]?key)\s*[=:]\s*)[^\s]+/gi, "$1[REDACTED]")
    .slice(-2_000);
}

export class CodexAppServerSupervisor {
  readonly #socketPath: string;
  readonly #codexCommand: string;
  readonly #token: string | undefined;
  readonly #startupTimeoutMs: number;
  readonly #startupPollMs: number;
  readonly #shutdownTimeoutMs: number;
  readonly #spawnProcess: NonNullable<CodexAppServerSupervisorOptions["spawnProcess"]>;
  readonly #readinessProbe: () => Promise<boolean>;
  #process: ManagedCodexProcess | undefined;
  #status: CodexSupervisorHealth["status"] = "offline";
  #error: string | null = null;
  #stderr = "";
  #unexpectedExitHandler: (() => void) | undefined;
  #pendingUnexpectedExit = false;

  constructor(options: CodexAppServerSupervisorOptions) {
    this.#socketPath = options.socketPath;
    this.#codexCommand = options.codexCommand ?? "codex";
    this.#token = options.token;
    if (isWindowsPipePath(options.socketPath) && !options.token)
      throw new Error("Windows Codex 桥接需要认证令牌");
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
    this.#startupPollMs = options.startupPollMs ?? 50;
    // The bridge may need 5s to reap session workers before it can exit.
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
    this.#spawnProcess =
      options.spawnProcess ??
      ((command, arguments_, spawnOptions) =>
        spawn(command, arguments_, spawnOptions) as ManagedCodexProcess);
    this.#readinessProbe = options.readinessProbe ?? (() => this.#probeSocket());
  }

  onUnexpectedExit(handler: () => void): void {
    this.#unexpectedExitHandler = handler;
    if (this.#pendingUnexpectedExit) {
      this.#pendingUnexpectedExit = false;
      queueMicrotask(handler);
    }
  }

  health(): CodexSupervisorHealth {
    return {
      status: this.#status,
      pid: this.#process?.pid ?? null,
      error: this.#error,
    };
  }

  async start(): Promise<void> {
    if (this.#status === "ready" && this.#process && this.#process.exitCode === null) {
      return;
    }
    this.#status = "starting";
    this.#pendingUnexpectedExit = false;
    this.#error = null;
    this.#stderr = "";
    this.#removeStaleSocket();
    const windowsPipe = isWindowsPipePath(this.#socketPath);
    let ownedListenerReady = !windowsPipe;
    const child = this.#spawnProcess(
      process.execPath,
      [
        fileURLToPath(new URL("../../../../../scripts/codex-session-bridge.mjs", import.meta.url)),
        "--codex",
        this.#codexCommand,
        "--listen",
        localEndpoint(this.#socketPath),
      ],
      {
        stdio: [windowsPipe ? "pipe" : "ignore", windowsPipe ? "pipe" : "ignore", "pipe"],
        ...(this.#token ? { env: { ...process.env, CODEXBOARD_BRIDGE_TOKEN: this.#token } } : {}),
      },
    );
    this.#process = child;
    if (windowsPipe) {
      let readinessOutput = "";
      child.stdout?.on("data", (chunk: string | Buffer) => {
        readinessOutput = `${readinessOutput}${chunk.toString()}`.slice(-128);
        if (readinessOutput.includes("CODEXBOARD_BRIDGE_READY\n")) ownedListenerReady = true;
      });
    }
    child.stderr.on("data", (chunk: string | Buffer) => {
      this.#stderr = `${this.#stderr}${chunk.toString()}`.slice(-8_000);
    });
    child.on("error", () => {
      if (this.#process !== child) return;
      this.#process = undefined;
      this.#status = "error";
      this.#error = "Codex App Server 进程启动失败";
      this.#removeOwnedSocket();
      this.#notifyUnexpectedExit();
    });
    child.on("exit", (code) => {
      if (this.#process !== child) {
        return;
      }
      this.#process = undefined;
      if (this.#status !== "offline") {
        this.#status = "error";
        this.#error =
          code === 0
            ? "Codex App Server 意外退出"
            : redact(this.#stderr || `process exited with code ${code}`);
        this.#removeOwnedSocket();
        this.#notifyUnexpectedExit();
      }
    });

    const deadline = Date.now() + this.#startupTimeoutMs;
    while (Date.now() <= deadline) {
      if (child.exitCode !== null || this.#process !== child) {
        this.#status = "error";
        this.#error ??= redact(this.#stderr || "Codex App Server 进程提前退出");
        throw new Error("Codex App Server 启动失败");
      }
      // A connect alone could reach a pipe pre-created by another process. The
      // private child stdout confirms that our own bridge successfully bound.
      if (ownedListenerReady && (await this.#readinessProbe())) {
        this.#status = "ready";
        this.#error = null;
        return;
      }
      await delay(this.#startupPollMs);
    }

    this.#status = "error";
    this.#error = redact(this.#stderr || "Codex App Server 启动超时");
    child.kill("SIGTERM");
    throw new Error("Codex App Server 启动失败");
  }

  async stop(): Promise<void> {
    const child = this.#process;
    this.#status = "offline";
    if (!child) {
      this.#error = null;
      this.#removeOwnedSocket();
      return;
    }
    const exited = new Promise<void>((resolve) => {
      const onExit = () => {
        child.off("exit", onExit);
        resolve();
      };
      child.once("exit", onExit);
    });
    if (isWindowsPipePath(this.#socketPath) && child.stdin) child.stdin.end();
    else child.kill("SIGTERM");
    const graceful = await Promise.race([
      exited.then(() => true),
      delay(this.#shutdownTimeoutMs).then(() => false),
    ]);
    if (!graceful && child.exitCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    if (this.#process === child) {
      this.#process = undefined;
    }
    this.#error = null;
    this.#removeOwnedSocket();
  }

  #removeStaleSocket(): void {
    if (isWindowsPipePath(this.#socketPath)) return;
    if (!existsSync(this.#socketPath)) return;
    const stat = lstatSync(this.#socketPath);
    if (stat.isSymbolicLink() || !stat.isSocket()) {
      throw new Error("Codex App Server Socket 路径已被非 Socket 文件占用");
    }
    unlinkSync(this.#socketPath);
  }

  #removeOwnedSocket(): void {
    if (isWindowsPipePath(this.#socketPath)) return;
    if (!existsSync(this.#socketPath)) return;
    const stat = lstatSync(this.#socketPath);
    if (!stat.isSymbolicLink() && stat.isSocket()) unlinkSync(this.#socketPath);
  }

  #notifyUnexpectedExit(): void {
    if (this.#unexpectedExitHandler) {
      this.#pendingUnexpectedExit = false;
      this.#unexpectedExitHandler();
    } else {
      this.#pendingUnexpectedExit = true;
    }
  }

  #probeSocket(): Promise<boolean> {
    return new Promise((resolveProbe) => {
      const socket = createConnection({ path: this.#socketPath });
      const finish = (ready: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolveProbe(ready);
      };
      socket.setTimeout(Math.min(this.#startupPollMs, 250), () => finish(false));
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
  }
}
