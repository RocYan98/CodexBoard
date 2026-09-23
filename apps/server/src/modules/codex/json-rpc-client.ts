import {
  JsonRpcMessageSchema,
  isSupportedServerRequestMethod,
  type CodexNotification,
  type CodexRequestId,
  type CodexServerRequest,
  type CodexTransport,
  type JsonRpcMessage,
} from "./protocol.js";

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface CodexJsonRpcClientOptions {
  readonly transport: CodexTransport;
  readonly requestTimeoutMs?: number;
  readonly clientInfo?: {
    readonly name: string;
    readonly title: string;
    readonly version: string;
  };
}

export class CodexProtocolError extends Error {
  readonly messageValue: unknown;

  constructor(message: string, messageValue?: unknown) {
    super(message);
    this.name = "CodexProtocolError";
    this.messageValue = messageValue;
  }
}

export class CodexRequestError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "CodexRequestError";
    this.code = code;
    this.data = data;
  }
}

export class CodexJsonRpcClient {
  readonly #transport: CodexTransport;
  readonly #requestTimeoutMs: number;
  readonly #clientInfo: CodexJsonRpcClientOptions["clientInfo"];
  readonly #pending = new Map<CodexRequestId, PendingRequest>();
  readonly #notificationListeners = new Set<(notification: CodexNotification) => void>();
  readonly #protocolErrorListeners = new Set<(error: CodexProtocolError) => void>();
  readonly #disconnectListeners = new Set<(error: Error) => void>();
  #serverRequestHandler: ((request: CodexServerRequest) => Promise<void>) | undefined;
  #removeMessageListener: (() => void) | undefined;
  #removeCloseListener: (() => void) | undefined;
  #nextRequestId = 1;
  #state: "idle" | "connecting" | "connected" | "closed" = "idle";
  #connectPromise: Promise<void> | undefined;
  #codexHome: string | undefined;

  constructor(options: CodexJsonRpcClientOptions) {
    this.#transport = options.transport;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#clientInfo = options.clientInfo ?? {
      name: "codexboard",
      title: "CodexBoard",
      version: "0.1.0",
    };
  }

  get connected(): boolean {
    return this.#state === "connected";
  }

  get codexHome(): string | undefined {
    return this.connected ? this.#codexHome : undefined;
  }

  connect(): Promise<void> {
    if (this.#state === "connected") {
      return Promise.resolve();
    }
    if (this.#connectPromise) {
      return this.#connectPromise;
    }
    if (this.#state === "closed") {
      return Promise.reject(new CodexProtocolError("Codex client is closed"));
    }
    this.#state = "connecting";
    this.#removeMessageListener = this.#transport.onMessage((message) => {
      void this.#handleMessage(message);
    });
    this.#removeCloseListener = this.#transport.onClose((error) => {
      this.#handleDisconnect(error);
    });
    this.#connectPromise = (async () => {
      try {
        await this.#transport.connect();
        const initialized = await this.#requestRaw("initialize", {
          clientInfo: this.#clientInfo,
          capabilities: null,
        });
        this.#codexHome =
          initialized !== null &&
          typeof initialized === "object" &&
          "codexHome" in initialized &&
          typeof initialized.codexHome === "string"
            ? initialized.codexHome
            : undefined;
        await this.#transport.send({ method: "initialized", params: {} });
        this.#state = "connected";
      } catch (error: unknown) {
        this.#state = "idle";
        throw error;
      } finally {
        this.#connectPromise = undefined;
      }
    })();
    return this.#connectPromise;
  }

  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.#state !== "connected") {
      return Promise.reject(new CodexProtocolError("Codex client is not connected"));
    }
    return this.#requestRaw(method, params, timeoutMs);
  }

  notify(method: string, params: unknown): Promise<void> {
    if (this.#state !== "connected") {
      return Promise.reject(new CodexProtocolError("Codex client is not connected"));
    }
    return this.#transport.send({ method, params });
  }

  onNotification(listener: (notification: CodexNotification) => void): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  onServerRequest(handler: (request: CodexServerRequest) => Promise<void>): void {
    this.#serverRequestHandler = handler;
  }

  clearServerRequestHandler(): void {
    this.#serverRequestHandler = undefined;
  }

  onProtocolError(listener: (error: CodexProtocolError) => void): () => void {
    this.#protocolErrorListeners.add(listener);
    return () => this.#protocolErrorListeners.delete(listener);
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.#disconnectListeners.add(listener);
    return () => this.#disconnectListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#state === "closed") {
      return;
    }
    this.#state = "closed";
    this.#rejectPending(new CodexProtocolError("Codex client closed"));
    this.#removeMessageListener?.();
    this.#removeCloseListener?.();
    this.#removeMessageListener = undefined;
    this.#removeCloseListener = undefined;
    await this.#transport.close();
  }

  #requestRaw(
    method: string,
    params: unknown,
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<unknown> {
    const id = this.#nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CodexProtocolError(`Codex request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timeout });
      void this.#transport.send({ id, method, params }).catch((error: unknown) => {
        const pending = this.#pending.get(id);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.#pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error("Codex transport send failed"));
      });
    });
  }

  async #handleMessage(rawMessage: unknown): Promise<void> {
    const parsed = JsonRpcMessageSchema.safeParse(rawMessage);
    if (!parsed.success) {
      this.#reportProtocolError(
        new CodexProtocolError("Illegal Codex protocol message", rawMessage),
      );
      return;
    }
    const message = parsed.data as JsonRpcMessage;
    if ("id" in message && !("method" in message)) {
      const pending = this.#pending.get(message.id);
      if (!pending) {
        this.#reportProtocolError(
          new CodexProtocolError(`Response for unknown request id: ${String(message.id)}`, message),
        );
        return;
      }
      clearTimeout(pending.timeout);
      this.#pending.delete(message.id);
      if ("error" in message) {
        pending.reject(
          new CodexRequestError(message.error.code, message.error.message, message.error.data),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if ("id" in message && "method" in message) {
      await this.#handleServerRequest(message.id, message.method, message.params);
      return;
    }
    if ("method" in message) {
      const notification = { method: message.method, params: message.params };
      for (const listener of this.#notificationListeners) {
        listener(notification);
      }
    }
  }

  async #handleServerRequest(id: CodexRequestId, method: string, params: unknown): Promise<void> {
    if (!isSupportedServerRequestMethod(method) || !this.#serverRequestHandler) {
      await this.#transport.send({
        id,
        error: { code: -32601, message: `Unsupported server request: ${method}` },
      });
      return;
    }
    let answered = false;
    const request: CodexServerRequest = {
      id,
      method,
      params,
      respond: async (result) => {
        if (answered) {
          throw new CodexProtocolError(`Server request ${String(id)} was already answered`);
        }
        answered = true;
        await this.#transport.send({ id, result });
      },
      fail: async (code, message, data) => {
        if (answered) {
          throw new CodexProtocolError(`Server request ${String(id)} was already answered`);
        }
        answered = true;
        await this.#transport.send({ id, error: { code, message, data } });
      },
    };
    try {
      await this.#serverRequestHandler(request);
      if (!answered) {
        await request.fail(-32603, "Server request handler did not answer");
      }
    } catch (error: unknown) {
      if (!answered) {
        await request.fail(
          -32603,
          error instanceof Error ? error.message : "Server request handler failed",
        );
      }
    }
  }

  #handleDisconnect(error?: Error): void {
    if (this.#state === "closed") {
      return;
    }
    this.#removeMessageListener?.();
    this.#removeCloseListener?.();
    this.#removeMessageListener = undefined;
    this.#removeCloseListener = undefined;
    this.#state = "idle";
    const disconnectError = error ?? new CodexProtocolError("Codex transport disconnected");
    this.#rejectPending(disconnectError);
    for (const listener of this.#disconnectListeners) {
      listener(disconnectError);
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #reportProtocolError(error: CodexProtocolError): void {
    for (const listener of this.#protocolErrorListeners) {
      listener(error);
    }
  }
}
