import { NativeMediaError } from "./feishu-images";
import { userErrorMessage } from "./user-error";
import {
  REMOTE_UPLOAD_MAX_BYTES,
  RemoteThreadListSchema,
  RemoteThreadSchema,
  RemoteModelSchema,
  RemoteUsageSchema,
  RemoteReviewSchema,
  RemoteReviewContentSchema,
  RemoteAttachmentSchema,
  type RemoteAction,
  type RemoteReviewScope,
} from "@codexboard/contracts";
import { z } from "zod";
import { ApiError, apiRequest, mutationHeaders } from "./api";
import { createUuid } from "./random-id";

export async function listRemoteThreads(search: string, cursor?: string) {
  const query = new URLSearchParams({ search, ...(cursor ? { cursor } : {}) });
  return (
    await apiRequest(`/api/v1/remote/threads?${query}`, z.object({ data: RemoteThreadListSchema }))
  ).data;
}
export async function readRemoteThread(id: string, signal?: AbortSignal) {
  return (
    await apiRequest(
      `/api/v1/remote/threads/${encodeURIComponent(id)}`,
      z.object({ data: RemoteThreadSchema }),
      { signal: AbortSignal.any([AbortSignal.timeout(125_000), ...(signal ? [signal] : [])]) },
    )
  ).data;
}
export async function listRemoteModels() {
  return (await apiRequest("/api/v1/remote/models", z.object({ data: z.array(RemoteModelSchema) })))
    .data;
}

export async function uploadRemoteFile(
  file: File,
  csrf: string,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
) {
  try {
    return await uploadFile(file, csrf, onProgress, signal);
  } catch (error) {
    signal?.throwIfAborted();
    if (
      error instanceof TypeError ||
      (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name))
    )
      throw new RemoteUploadError("network", { cause: error });
    throw error;
  }
}
async function uploadFile(
  file: File,
  csrf: string,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!file.size || file.size > REMOTE_UPLOAD_MAX_BYTES) throw new RemoteUploadError("size");
  onProgress?.(0);
  const chunkBytes = 192 * 1024;
  if (file.size > chunkBytes) {
    const id = createUuid();
    const count = Math.ceil(file.size / chunkBytes);
    const controller = new AbortController();
    const uploadSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    let next = 0;
    let completed = 0;
    let attachment: z.infer<typeof RemoteAttachmentSchema> | null = null;
    const worker = async () => {
      while (next < count && !uploadSignal.aborted) {
        const index = next++;
        const query = new URLSearchParams({
          name: file.name,
          mimeType: file.type,
          size: String(file.size),
          index: String(index),
        });
        const body = file.slice(index * chunkBytes, (index + 1) * chunkBytes);
        for (let attempt = 0; ; attempt++) {
          try {
            uploadSignal.throwIfAborted();
            const result = await apiRequest(
              `/api/v1/remote/uploads/chunks?${query}`,
              z.object({ data: RemoteAttachmentSchema.nullable() }),
              {
                method: "POST",
                headers: {
                  ...mutationHeaders(csrf, id),
                  "Content-Type": "application/octet-stream",
                },
                body,
                signal: AbortSignal.any([uploadSignal, AbortSignal.timeout(30000)]),
              },
            );
            uploadSignal.throwIfAborted();
            if (result.data) attachment = result.data;
            onProgress?.(Math.round((++completed / count) * 100));
            break;
          } catch (error) {
            const retryable =
              error instanceof TypeError ||
              (error instanceof DOMException && error.name === "TimeoutError") ||
              (error instanceof ApiError && [502, 503, 504].includes(error.status));
            if (!retryable || attempt >= 2 || uploadSignal.aborted) throw error;
            await new Promise<void>((resolve, reject) => {
              const abort = () => {
                clearTimeout(timer);
                reject(uploadSignal.reason);
              };
              const timer = setTimeout(
                () => {
                  uploadSignal.removeEventListener("abort", abort);
                  resolve();
                },
                250 * (attempt + 1),
              );
              uploadSignal.addEventListener("abort", abort, { once: true });
              if (uploadSignal.aborted) abort();
            });
          }
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(4, count) }, worker));
    } catch (error) {
      controller.abort();
      throw error;
    }
    uploadSignal.throwIfAborted();
    if (!attachment) throw new RemoteUploadError("incomplete");
    return attachment;
  }
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => {
      reader.abort();
      reject(signal?.reason);
    };
    reader.onloadend = () => signal?.removeEventListener("abort", abort);
    reader.onload = () => resolve(String(reader.result).split(",")[1]!);
    reader.onerror = () => reject(new RemoteUploadError("read"));
    signal?.addEventListener("abort", abort, { once: true });
    signal?.throwIfAborted();
    reader.readAsDataURL(file);
  });
  signal?.throwIfAborted();
  return (
    await apiRequest("/api/v1/remote/uploads", z.object({ data: RemoteAttachmentSchema }), {
      method: "POST",
      headers: mutationHeaders(csrf, createUuid()),
      body: JSON.stringify({ name: file.name, mimeType: file.type, base64 }),
      signal: signal ?? null,
    })
  ).data;
}
export async function createRemoteThread(projectId: string | null, csrf: string, key: string) {
  return (
    await apiRequest(
      "/api/v1/remote/threads",
      z.object({ data: z.object({ threadId: z.uuid() }) }),
      {
        method: "POST",
        headers: mutationHeaders(csrf, key),
        body: JSON.stringify({ projectId }),
      },
    )
  ).data;
}
export async function remoteAction(
  threadId: string,
  action: RemoteAction,
  csrf: string,
  key: string,
) {
  return apiRequest(
    `/api/v1/remote/threads/${encodeURIComponent(threadId)}/actions`,
    z.object({ data: z.object({}) }),
    {
      method: "POST",
      headers: mutationHeaders(csrf, key),
      body: JSON.stringify(action),
    },
  );
}

export async function readRemoteUsage() {
  return (await apiRequest("/api/v1/remote/usage", z.object({ data: RemoteUsageSchema }))).data;
}

export async function readRemoteReview(
  id: string,
  scope: RemoteReviewScope,
  all: boolean,
  turnId?: string,
) {
  const query = new URLSearchParams({ scope, all: all ? "1" : "0" });
  if (turnId) query.set("turnId", turnId);
  return (
    await apiRequest(
      `/api/v1/remote/threads/${encodeURIComponent(id)}/review?${query}`,
      z.object({ data: RemoteReviewSchema }),
    )
  ).data;
}

export async function readRemoteReviewFile(
  id: string,
  scope: RemoteReviewScope,
  path: string,
  view: "diff" | "file" = "diff",
  turnId?: string,
) {
  const query = new URLSearchParams({ scope, path, view });
  if (turnId) query.set("turnId", turnId);
  return (
    await apiRequest(
      `/api/v1/remote/threads/${encodeURIComponent(id)}/review?${query}`,
      z.object({ data: RemoteReviewContentSchema }),
    )
  ).data;
}

export function remoteErrorMessage(error: unknown): string {
  return userErrorMessage(error, "暂时无法完成操作，请刷新后重试。");
}

class RemoteUploadError extends Error {
  constructor(
    readonly kind: "network" | "size" | "incomplete" | "read",
    options?: ErrorOptions,
  ) {
    super("Remote upload failed", options);
  }
}

export function remoteUploadErrorMessage(error: unknown): string {
  if (error instanceof NativeMediaError) return error.message;
  if (error instanceof RemoteUploadError) {
    const messages = {
      network: "上传网络连接中断，请重新选择文件；草稿已保留。",
      size: "单个文件须为 1 字节至 64 MiB，请重新选择。",
      incomplete: "附件上传未完成，请重新选择文件。",
      read: "无法读取文件，请重新选择。",
    };
    return messages[error.kind];
  }
  return userErrorMessage(error, "上传失败，请重新选择文件；草稿已保留。");
}

// Review metadata is received as text; only known product notices may be displayed.
const reviewNotices = [
  "",
  "文件已删除或不可读取",
  "符号链接目标",
  "此项目不是可预览的普通文件",
  "文件超过 1 MiB，暂不显示完整内容",
  "二进制文件，无法显示文本差异",
  "文件已变化，请返回并刷新审核列表",
  "此文件不在暂存区中",
  "文件差异超过 1 MiB，暂不显示完整内容",
  "此任务目录不支持完整文件预览",
  "任务目录不是 Git 仓库，仅显示本轮记录",
  "此任务目录不是 Git 仓库",
] as const;
export function remoteReviewMessage(message: string): string {
  return reviewNotices.find((copy) => copy === message) ?? "暂时无法显示内容，请刷新后重试。";
}
