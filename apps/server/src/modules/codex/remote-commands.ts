import { ErrorCodeSchema } from "@codexboard/contracts";
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../app-error.js";
import type { SqliteDatabase } from "../database/index.js";

const Row = z.object({ requestHash: z.string(), responseJson: z.string() });
const Receipt = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }),
  z.object({ state: z.literal("done"), result: z.unknown() }),
  z.object({ state: z.literal("failed"), message: z.string(), code: ErrorCodeSchema.optional() }),
]);

// Persist BEFORE the side effect. An interrupted process leaves a pending
// receipt, which must never cause an automatic redispatch on restart.
export class RemoteCommands {
  readonly #running = new Map<string, Promise<unknown>>();
  constructor(private readonly database: SqliteDatabase) {}

  async run(
    identity: string,
    key: string,
    input: unknown,
    operation: () => Promise<unknown>,
  ): Promise<unknown> {
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const runningKey = `${identity}:${key}`;
    const row = Row.safeParse(
      this.database
        .prepare(
          "SELECT request_hash AS requestHash, response_json AS responseJson FROM request_idempotency WHERE identity_key = ? AND scope = 'codex.remote' AND idempotency_key = ?",
        )
        .get(identity, key),
    );
    if (row.success) {
      if (row.data.requestHash !== hash)
        throw new AppError("DUPLICATE_REQUEST", 409, "操作编号已用于其他请求");
      const receipt = Receipt.parse(JSON.parse(row.data.responseJson));
      if (receipt.state === "done") return receipt.result;
      const running = this.#running.get(runningKey);
      if (running) return running;
      throw new AppError(
        receipt.state === "failed"
          ? (receipt.code ?? "REMOTE_RESULT_UNKNOWN")
          : "REMOTE_RESULT_UNKNOWN",
        409,
        receipt.state === "failed"
          ? receipt.message
          : "上次操作结果尚未确认，请刷新对话核实；不会重复发送",
      );
    }
    this.database
      .prepare(
        "INSERT INTO request_idempotency (identity_key, scope, idempotency_key, request_hash, response_json, created_at) VALUES (?, 'codex.remote', ?, ?, ?, ?)",
      )
      .run(identity, key, hash, JSON.stringify({ state: "pending" }), new Date().toISOString());
    const save = (receipt: z.infer<typeof Receipt>) =>
      this.database
        .prepare(
          "UPDATE request_idempotency SET response_json = ? WHERE identity_key = ? AND scope = 'codex.remote' AND idempotency_key = ?",
        )
        .run(JSON.stringify(receipt), identity, key);
    const pending = Promise.resolve()
      .then(operation)
      .then(
        (result) => {
          save({ state: "done", result });
          return result;
        },
        (error: unknown) => {
          const message =
            error instanceof AppError && error.statusCode < 500
              ? error.message
              : "操作结果尚未确认，请刷新对话核实；不会自动重试";
          const code =
            error instanceof AppError && error.statusCode < 500
              ? error.code
              : "REMOTE_RESULT_UNKNOWN";
          save({ state: "failed", message, code });
          throw new AppError(code, 409, message);
        },
      )
      .finally(() => this.#running.delete(runningKey));
    this.#running.set(runningKey, pending);
    return pending;
  }
}
