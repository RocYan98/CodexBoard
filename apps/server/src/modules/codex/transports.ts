import type { Readable, Writable } from "node:stream";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { assertPrivateFileSync } from "../../../../../scripts/private-file-permissions.mjs";
import { isWindowsPipePath } from "../../../../../scripts/codex-local-endpoint.mjs";

import WebSocket, { type RawData } from "ws";

import type { CodexTransport, JsonRpcMessage } from "./protocol.js";

interface JsonlStreamTransportOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly description?: string;
  readonly closeStreams?: boolean;
}

export class JsonlStreamTransport implements CodexTransport {
  readonly description: string;
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #closeStreams: boolean;
  readonly #messageListeners = new Set<(message: unknown) => void>();
  readonly #closeListeners = new Set<(error?: Error) => void>();
  #buffer = "";
  #connected = false;
  #closed = false;

  constructor(options: JsonlStreamTransportOptions) {
    this.#input = options.input;
    this.#output = options.output;
    this.description = options.description ?? "stdio-jsonl";
    this.#closeStreams = options.closeStreams ?? false;
  }

  async connect(): Promise<void> {
    if (this.#closed) {
      throw new Error("JSONL transport is closed");
    }
    if (this.#connected) {
      return;
    }
    this.#connected = true;
    this.#input.setEncoding("utf8");
    this.#input.on("data", this.#onData);
    this.#input.on("end", this.#onEnd);
    this.#input.on("error", this.#onInputError);
    this.#output.on("error", this.#onOutputError);
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.#connected || this.#closed) {
      throw new Error("JSONL transport is not connected");
    }
    const frame = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.#output.write(frame, "utf8", (error) => (error ? reject(error) : resolve()));
    });
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#detach();
    if (this.#closeStreams) {
      this.#input.destroy();
      this.#output.end();
    }
  }

  readonly #onData = (chunk: string | Buffer): void => {
    this.#buffer += chunk.toString();
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      try {
        const message: unknown = JSON.parse(line);
        for (const listener of this.#messageListeners) {
          listener(message);
        }
      } catch (cause: unknown) {
        this.#fail(new Error("Invalid JSONL from Codex app-server", { cause }));
        return;
      }
    }
  };

  readonly #onEnd = (): void => this.#fail();
  readonly #onInputError = (error: Error): void => this.#fail(error);
  readonly #onOutputError = (error: Error): void => this.#fail(error);

  #fail(error?: Error): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#detach();
    for (const listener of this.#closeListeners) {
      listener(error);
    }
  }

  #detach(): void {
    this.#input.off("data", this.#onData);
    this.#input.off("end", this.#onEnd);
    this.#input.off("error", this.#onInputError);
    this.#output.off("error", this.#onOutputError);
  }
}

interface UnixWebSocketTransportOptions {
  readonly socketPath: string;
  readonly token?: string;
  readonly requestPath?: string;
  readonly connectTimeoutMs?: number;
  readonly connectRetryMs?: number;
}

export class UnixWebSocketTransport implements CodexTransport {
  readonly description = "unix-websocket";
  readonly #url: string;
  readonly #pipePath: string | undefined;
  readonly #token: string | undefined;
  readonly #connectTimeoutMs: number;
  readonly #connectRetryMs: number;
  readonly #messageListeners = new Set<(message: unknown) => void>();
  readonly #closeListeners = new Set<(error?: Error) => void>();
  #socket: WebSocket | undefined;
  #closedByClient = false;
  #connecting = false;

  constructor(options: UnixWebSocketTransportOptions) {
    const requestPath = options.requestPath ?? "/";
    this.#pipePath = isWindowsPipePath(options.socketPath) ? options.socketPath : undefined;
    if (this.#pipePath && !options.token) {
      throw new Error("Windows named pipe transport requires a capability token");
    }
    this.#token = options.token;
    this.#url = this.#pipePath
      ? `ws://localhost${requestPath}`
      : `ws+unix://${options.socketPath}:${requestPath}`;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.#connectRetryMs = options.connectRetryMs ?? 50;
  }

  async connect(): Promise<void> {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      return;
    }
    this.#closedByClient = false;
    this.#connecting = true;
    const deadline = Date.now() + this.#connectTimeoutMs;
    try {
      for (;;) {
        const socket = new WebSocket(this.#url, {
          perMessageDeflate: false,
          ...(this.#token ? { headers: { authorization: `Bearer ${this.#token}` } } : {}),
          ...(this.#pipePath ? { createConnection: () => createConnection(this.#pipePath!) } : {}),
        });
        this.#socket = socket;
        socket.on("message", this.#onMessage);
        socket.on("close", this.#onClose);
        socket.on("error", this.#onRuntimeError);
        try {
          await new Promise<void>((resolve, reject) => {
            const onOpen = () => {
              socket.off("error", onConnectError);
              resolve();
            };
            const onConnectError = (error: Error) => {
              socket.off("open", onOpen);
              reject(error);
            };
            socket.once("open", onOpen);
            socket.once("error", onConnectError);
          });
          return;
        } catch (error: unknown) {
          socket.off("message", this.#onMessage);
          socket.off("close", this.#onClose);
          socket.off("error", this.#onRuntimeError);
          socket.terminate();
          if (this.#socket === socket) this.#socket = undefined;
          if (Date.now() >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, this.#connectRetryMs));
        }
      }
    } finally {
      this.#connecting = false;
    }
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Unix WebSocket transport is not connected");
    }
    await new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify(message), (error) => (error ? reject(error) : resolve()));
    });
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    if (!socket) {
      return;
    }
    this.#closedByClient = true;
    this.#socket = undefined;
    if (socket.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close(1000, "client closing");
    });
  }

  readonly #onMessage = (data: RawData, isBinary: boolean): void => {
    if (isBinary) {
      this.#emitClose(new Error("Codex app-server sent an unexpected binary WebSocket frame"));
      this.#socket?.close(1003, "text frames required");
      return;
    }
    try {
      const message: unknown = JSON.parse(data.toString("utf8"));
      for (const listener of this.#messageListeners) {
        listener(message);
      }
    } catch (cause: unknown) {
      this.#emitClose(new Error("Invalid JSON WebSocket frame from Codex app-server", { cause }));
      this.#socket?.close(1007, "invalid JSON");
    }
  };

  readonly #onClose = (): void => {
    if (!this.#closedByClient && !this.#connecting) {
      this.#emitClose(new Error("Codex Unix WebSocket connection closed"));
    }
  };

  readonly #onRuntimeError = (error: Error): void => {
    if (!this.#closedByClient && !this.#connecting) {
      this.#emitClose(error);
    }
  };

  #emitClose(error?: Error): void {
    for (const listener of this.#closeListeners) {
      listener(error);
    }
  }
}

interface TcpWebSocketTransportOptions {
  readonly endpoint: string;
  readonly tokenFile: string;
  readonly connectTimeoutMs?: number;
}

function readCapabilityToken(path: string): string {
  assertPrivateFileSync(path);
  const token = readFileSync(path, "utf8").trim();
  if (!token) throw new Error("Codex capability token 文件为空");
  return token;
}

export class TcpWebSocketTransport implements CodexTransport {
  readonly description = "loopback-websocket";
  readonly #endpoint: string;
  readonly #tokenFile: string;
  readonly #connectTimeoutMs: number;
  readonly #messageListeners = new Set<(message: unknown) => void>();
  readonly #closeListeners = new Set<(error?: Error) => void>();
  #socket: WebSocket | undefined;
  #closedByClient = false;
  #connecting = false;

  constructor(options: TcpWebSocketTransportOptions) {
    const endpoint = new URL(options.endpoint);
    if (
      endpoint.protocol !== "ws:" ||
      endpoint.hostname !== "127.0.0.1" ||
      endpoint.username ||
      endpoint.password
    ) {
      throw new Error("Codex WebSocket 只能连接本机地址");
    }
    this.#endpoint = endpoint.toString();
    this.#tokenFile = options.tokenFile;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
  }

  async connect(): Promise<void> {
    if (this.#socket?.readyState === WebSocket.OPEN) return;
    const token = readCapabilityToken(this.#tokenFile);
    this.#closedByClient = false;
    this.#connecting = true;
    const socket = new WebSocket(this.#endpoint, {
      headers: { authorization: `Bearer ${token}` },
      handshakeTimeout: this.#connectTimeoutMs,
      perMessageDeflate: false,
    });
    this.#socket = socket;
    socket.on("message", this.#onMessage);
    socket.on("close", this.#onClose);
    socket.on("error", this.#onRuntimeError);
    try {
      await new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          socket.off("error", onConnectError);
          resolve();
        };
        const onConnectError = () => {
          socket.off("open", onOpen);
          reject(new Error("Codex WebSocket 连接失败"));
        };
        socket.once("open", onOpen);
        socket.once("error", onConnectError);
      });
    } catch (error: unknown) {
      socket.off("message", this.#onMessage);
      socket.off("close", this.#onClose);
      socket.off("error", this.#onRuntimeError);
      socket.terminate();
      if (this.#socket === socket) this.#socket = undefined;
      throw error;
    } finally {
      this.#connecting = false;
    }
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex WebSocket transport is not connected");
    }
    await new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify(message), (error) => (error ? reject(error) : resolve()));
    });
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    if (!socket) return;
    this.#closedByClient = true;
    this.#socket = undefined;
    if (socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close(1000, "client closing");
    });
  }

  readonly #onMessage = (data: RawData, isBinary: boolean): void => {
    if (isBinary) {
      this.#emitClose(new Error("Codex app-server sent an unexpected binary WebSocket frame"));
      this.#socket?.close(1003, "text frames required");
      return;
    }
    try {
      const message: unknown = JSON.parse(data.toString("utf8"));
      for (const listener of this.#messageListeners) listener(message);
    } catch (cause: unknown) {
      this.#emitClose(new Error("Invalid JSON WebSocket frame from Codex app-server", { cause }));
      this.#socket?.close(1007, "invalid JSON");
    }
  };

  readonly #onClose = (): void => {
    if (!this.#closedByClient && !this.#connecting) {
      this.#emitClose(new Error("Codex loopback WebSocket connection closed"));
    }
  };

  readonly #onRuntimeError = (): void => {
    if (!this.#closedByClient && !this.#connecting) {
      this.#emitClose(new Error("Codex loopback WebSocket connection failed"));
    }
  };

  #emitClose(error?: Error): void {
    for (const listener of this.#closeListeners) listener(error);
  }
}
