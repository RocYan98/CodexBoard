import { homedir } from "node:os";
import { posix } from "node:path";

export function macCodexAppPaths() {
  return [
    "/Applications/Codex.app",
    "/Applications/ChatGPT.app",
    posix.join(homedir(), "Applications/Codex.app"),
    posix.join(homedir(), "Applications/ChatGPT.app"),
  ];
}

export function macCodexCandidates() {
  return [
    ...macCodexAppPaths().flatMap((path) => [
      posix.join(path, "Contents/Resources/codex-cli/bin/codex"),
      posix.join(path, "Contents/Resources/codex"),
    ]),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ];
}
