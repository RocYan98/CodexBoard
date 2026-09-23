import { ApiError } from "./api";

/** Only controlled UI copy may cross the error-to-message boundary. */
export function userErrorMessage(error: unknown, fallback = "操作失败，请稍后重试。"): string {
  if (
    error instanceof TypeError ||
    (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name))
  )
    return "网络连接中断，请检查网络后重试。";
  if (error instanceof ApiError) {
    if (error.code === "REMOTE_UNAVAILABLE") return "暂时无法连接桌面对话，请检查 Desktop 后重试。";
    if (error.code === "REMOTE_RESULT_UNKNOWN")
      return "上次操作结果尚未确认，请先查看对话或任务列表核实，避免重复发送。";
    switch (error.status) {
      case 401:
        return "登录已失效，请重新登录。";
      case 403:
        return "当前操作未获允许，请刷新页面后重试。";
      case 404:
        return "内容已不存在，请刷新后重试。";
      case 409:
        return "数据已更新，请刷新后重试。";
      case 429:
        return "操作频繁，请稍后重试。";
      case 502:
      case 503:
      case 504:
        return "服务暂时无法连接，请稍后重试。";
    }
  }
  return fallback;
}
