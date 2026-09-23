import { NativeMediaError } from "./feishu-images";
import { afterEach, expect, it, vi } from "vitest";
import {
  uploadRemoteFile,
  remoteErrorMessage,
  remoteUploadErrorMessage,
  readRemoteThread,
} from "./remote-api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("cancels an abandoned conversation read without leaving its request pending", async () => {
  const controller = new AbortController();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    ),
  );
  const reading = readRemoteThread("old", controller.signal);
  const rejected = expect(reading).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await rejected;
});

it("overlaps four upload segments and retries a dropped segment without losing the file", async () => {
  vi.useFakeTimers();
  let active = 0,
    peak = 0;
  const received = new Set<number>();
  let dropped = false;
  const size = 192 * 1024 * 8;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 200));
      active--;
      const index = Number(new URL(url, "http://localhost").searchParams.get("index"));
      if (index === 1 && !dropped) {
        dropped = true;
        throw new TypeError("Load failed");
      }
      expect((init.body as Blob).size).toBe(192 * 1024);
      received.add(index);
      return new Response(
        JSON.stringify({
          data:
            received.size === 8
              ? {
                  id: "11111111-1111-4111-8111-111111111111",
                  name: "video.mov",
                  mimeType: "video/quicktime",
                  size,
                }
              : null,
        }),
      );
    }),
  );
  const progress: number[] = [];
  const result = uploadRemoteFile(
    new File([new Uint8Array(size)], "video.mov", { type: "video/quicktime" }),
    "csrf",
    (value) => progress.push(value),
  );
  await vi.runAllTimersAsync();
  expect(await result).toMatchObject({ name: "video.mov", size });
  expect(peak).toBe(4);
  expect(received.size).toBe(8);
  expect(progress.at(-1)).toBe(100);
});

it("uses controlled Chinese messages for all remote errors", () => {
  expect(remoteErrorMessage(new TypeError("Load failed"))).toBe("网络连接中断，请检查网络后重试。");
  expect(remoteErrorMessage(new Error("raw server error /private/path"))).toBe(
    "暂时无法完成操作，请刷新后重试。",
  );
});

it("cancels every in-flight segment and does not retry after user cancellation", async () => {
  const controller = new AbortController();
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: RequestInit) => {
      const signal = init.signal!;
      signals.push(signal);
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    }),
  );
  const result = uploadRemoteFile(
    new File([new Uint8Array(192 * 1024 * 8)], "cancel.mov"),
    "csrf",
    undefined,
    controller.signal,
  );
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(signals).toHaveLength(4);
  controller.abort();
  await rejected;
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(4);
});

it("maps upload validation and arbitrary errors without exposing raw messages", async () => {
  const { remoteUploadErrorMessage } = await import("./remote-api");
  const error = await uploadRemoteFile(new File([], "empty.txt"), "csrf").catch((error) => error);
  expect(remoteUploadErrorMessage(error)).toBe("单个文件须为 1 字节至 64 MiB，请重新选择。");
  expect(remoteUploadErrorMessage(new Error("raw secret"))).toBe(
    "上传失败，请重新选择文件；草稿已保留。",
  );
});

it("keeps known review notices and hides arbitrary backend details", async () => {
  const { remoteReviewMessage } = await import("./remote-api");
  expect(remoteReviewMessage("二进制文件，无法显示文本差异")).toBe("二进制文件，无法显示文本差异");
  expect(remoteReviewMessage("fatal: raw private path")).toBe("暂时无法显示内容，请刷新后重试。");
});

it("shows native media failure stages without exposing arbitrary SDK error text", () => {
  expect(
    remoteUploadErrorMessage(new NativeMediaError("无法读取选中的媒体文件，请重新选择")),
  ).toContain("无法读取");
  expect(remoteUploadErrorMessage(new NativeMediaError("单个文件须为 1 字节至 64 MiB"))).toContain(
    "64 MiB",
  );
  expect(remoteUploadErrorMessage(new Error("private native path"))).not.toContain(
    "private native path",
  );
});
