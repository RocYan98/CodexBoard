// Node 22's Windows entry-point realpath walk rejects canonical \\?\ paths
// before loading JavaScript. Keep the canonical path and only preserve the main
// module's spelling; dependency resolution retains its default behavior.
export function nodeScriptArguments(script, args = [], platform = process.platform) {
  return [...(platform === "win32" ? ["--preserve-symlinks-main"] : []), script, ...args];
}
