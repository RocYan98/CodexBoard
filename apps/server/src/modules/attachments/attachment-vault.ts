import {
  ensurePrivateDirectorySync,
  ensurePrivateFileSync,
} from "../../../../../scripts/private-file-permissions.mjs";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

import { AttachmentContentTypeSchema, AttachmentFilenameSchema } from "@codexboard/contracts";

import { AppError } from "../../app-error.js";

const STORAGE_KEY_PATTERN = /^[0-9a-f]{2}\/[0-9a-f-]{36}$/;
const QUARANTINE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FORBIDDEN_CONTENT_TYPES = new Set(["text/html", "application/xhtml+xml", "image/svg+xml"]);

export interface AttachmentUpload {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Buffer;
}

export interface StoredAttachment {
  readonly storageKey: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface QuarantinedAttachments {
  readonly id: string;
  readonly entries: readonly {
    readonly storageKey: string;
    readonly quarantinePath: string;
  }[];
}

interface AttachmentVaultOptions {
  readonly rootDirectory: string;
  readonly maxBytes?: number;
}

export class AttachmentVault {
  readonly #rootDirectory: string;
  readonly #maxBytes: number;

  constructor(options: AttachmentVaultOptions) {
    this.#rootDirectory = resolve(options.rootDirectory);
    this.#maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
    ensurePrivateDirectorySync(this.#rootDirectory);
  }

  store(upload: AttachmentUpload): StoredAttachment {
    const filename = AttachmentFilenameSchema.parse(upload.filename);
    const contentType = AttachmentContentTypeSchema.parse(
      upload.contentType.split(";", 1)[0]?.trim().toLowerCase(),
    );
    if (upload.bytes.length === 0) throw new AppError("INVALID_REQUEST", 400, "附件不能为空");
    if (upload.bytes.length > this.#maxBytes) {
      throw new AppError("INVALID_REQUEST", 413, "附件大小超过限制");
    }
    validateContentType(contentType, upload.bytes);

    const id = randomUUID();
    const storageKey = `${id.slice(0, 2)}/${id}`;
    const finalPath = this.#path(storageKey);
    const directory = dirname(finalPath);
    ensurePrivateDirectorySync(directory);
    const temporaryPath = join(directory, `.${id}.${process.pid}.tmp`);

    try {
      writeFileSync(temporaryPath, upload.bytes, { flag: "wx", mode: 0o600 });
      ensurePrivateFileSync(temporaryPath);
      renameSync(temporaryPath, finalPath);
    } catch (cause: unknown) {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      throw new AppError("INTERNAL_ERROR", 500, "附件保存失败", { cause });
    }

    return {
      storageKey,
      filename,
      contentType,
      sizeBytes: upload.bytes.length,
      sha256: createHash("sha256").update(upload.bytes).digest("hex"),
    };
  }

  open(storageKey: string): Buffer {
    return readFileSync(this.#path(storageKey));
  }

  remove(storageKey: string): void {
    const path = this.#path(storageKey);
    try {
      unlinkSync(path);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  quarantine(
    storageKeys: readonly string[],
    quarantineId: string = randomUUID(),
  ): QuarantinedAttachments {
    if (!QUARANTINE_ID_PATTERN.test(quarantineId)) {
      throw new AppError("INVALID_REQUEST", 400, "附件隔离批次无效");
    }
    const id = quarantineId;
    const quarantineRoot = join(this.#rootDirectory, ".quarantine", id);
    const keys = [...new Set(storageKeys)];
    const entries = keys.map((storageKey) => ({
      storageKey,
      sourcePath: this.#path(storageKey),
      quarantinePath: resolve(quarantineRoot, storageKey),
    }));
    const available: typeof entries = [];
    const moved: typeof entries = [];
    const createdDirectories = new Set<string>();
    try {
      for (const entry of entries) {
        if (existsSync(entry.sourcePath)) {
          const directory = dirname(entry.quarantinePath);
          for (const created of missingDirectories(directory, quarantineRoot)) {
            createdDirectories.add(created);
          }
          ensurePrivateDirectorySync(directory);
          renameSync(entry.sourcePath, entry.quarantinePath);
          moved.push(entry);
          available.push(entry);
        } else if (existsSync(entry.quarantinePath)) {
          available.push(entry);
        }
      }
    } catch (cause: unknown) {
      for (const entry of moved.reverse()) {
        ensurePrivateDirectorySync(dirname(entry.sourcePath));
        renameSync(entry.quarantinePath, entry.sourcePath);
      }
      for (const directory of [...createdDirectories].sort(
        (left, right) => right.length - left.length,
      )) {
        try {
          rmdirSync(directory);
        } catch {
          // Only empty directories created by this call may be removed. A failed
          // rmdir means the directory is non-empty, already gone, or otherwise
          // unsafe to clean, so preserve it with the original failure context.
        }
      }
      throw new AppError("INTERNAL_ERROR", 500, "附件隔离失败", { cause });
    }
    return {
      id,
      entries: available.map(({ storageKey, quarantinePath }) => ({ storageKey, quarantinePath })),
    };
  }

  restore(batch: QuarantinedAttachments): void {
    try {
      for (const entry of batch.entries) {
        const destination = this.#path(entry.storageKey);
        ensurePrivateDirectorySync(dirname(destination));
        if (existsSync(entry.quarantinePath)) renameSync(entry.quarantinePath, destination);
      }
      this.#removeQuarantineDirectory(batch.id);
    } catch (cause: unknown) {
      throw new AppError("INTERNAL_ERROR", 500, "附件隔离恢复失败", { cause });
    }
  }

  discard(batch: QuarantinedAttachments): void {
    this.#removeQuarantineDirectory(batch.id);
  }

  #removeQuarantineDirectory(id: string): void {
    const quarantineBase = resolve(this.#rootDirectory, ".quarantine");
    const path = resolve(quarantineBase, id);
    if (!path.startsWith(`${quarantineBase}${sep}`)) {
      throw new AppError("INVALID_REQUEST", 400, "附件隔离路径无效");
    }
    rmSync(path, { recursive: true, force: true });
  }

  #path(storageKey: string): string {
    if (!STORAGE_KEY_PATTERN.test(storageKey)) {
      throw new AppError("INVALID_REQUEST", 400, "附件存储键无效");
    }
    const path = resolve(this.#rootDirectory, storageKey);
    if (!path.startsWith(`${this.#rootDirectory}${sep}`)) {
      throw new AppError("INVALID_REQUEST", 400, "附件路径无效");
    }
    return path;
  }
}

function missingDirectories(path: string, boundary: string): string[] {
  const missing: string[] = [];
  let current = path;
  while (current === boundary || current.startsWith(`${boundary}${sep}`)) {
    if (existsSync(current)) break;
    missing.push(current);
    if (current === boundary) break;
    current = dirname(current);
  }
  return missing;
}

function validateContentType(contentType: string, bytes: Buffer): void {
  const prefix = bytes.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (
    FORBIDDEN_CONTENT_TYPES.has(contentType) ||
    prefix.startsWith("<svg") ||
    prefix.startsWith("<html") ||
    prefix.startsWith("<!doctype html")
  ) {
    throw new AppError("INVALID_REQUEST", 415, "不允许上传可执行的 HTML 或 SVG 内容");
  }
  if (contentType === "application/octet-stream") return;
  if (contentType === "application/pdf" && bytes.subarray(0, 5).toString("ascii") === "%PDF-")
    return;
  if (contentType === "application/zip" && bytes.subarray(0, 2).toString("hex") === "504b") return;
  if (contentType === "image/png" && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a")
    return;
  if (contentType === "image/jpeg" && bytes.subarray(0, 3).toString("hex") === "ffd8ff") return;
  if (
    contentType === "image/gif" &&
    ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
  )
    return;
  if (
    contentType === "image/webp" &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return;
  if (
    contentType === "text/plain" ||
    contentType === "text/markdown" ||
    contentType === "text/csv"
  ) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return;
    } catch {
      throw new AppError("INVALID_REQUEST", 415, "文本附件不是有效的 UTF-8");
    }
  }
  if (contentType === "application/json") {
    try {
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      return;
    } catch {
      throw new AppError("INVALID_REQUEST", 415, "JSON 附件内容无效");
    }
  }
  throw new AppError("INVALID_REQUEST", 415, "附件内容类型与文件内容不匹配或不受支持");
}
