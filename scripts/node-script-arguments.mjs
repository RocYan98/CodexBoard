import { realpathSync } from "node:fs";
import { win32 } from "node:path";

// Node 22's Windows entry-point realpath walk rejects canonical \\?\ paths
// before loading JavaScript. Its ESM loader also classifies .MJS differently
// from .mjs. Resolve existing local files to their on-disk spelling first, then
// preserve only the main module path; dependency resolution remains unchanged.
export function nodeScriptArguments(script, args = [], platform = process.platform) {
  if (platform === "win32" && process.platform === "win32") {
    try {
      script = win32.toNamespacedPath(realpathSync.native(script));
    } catch {
      // Executor-visible or missing paths may not exist on this host. Preserve
      // them so their destination Node process retains its normal diagnostics.
    }
  }
  return [...(platform === "win32" ? ["--preserve-symlinks-main"] : []), script, ...args];
}
