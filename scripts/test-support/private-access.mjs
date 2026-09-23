import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { join } from "node:path";

// Tests deliberately add an actual Everyone read ACE on Windows; chmod(0644)
// does not do that. Never use this helper for real application data.
export function makePublicReadableSync(path) {
  if (process.platform !== "win32") {
    chmodSync(path, 0o644);
    return;
  }
  const result = spawnSync(
    join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"),
    [path, "/grant", "*S-1-1-0:R"],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 },
  );
  if (result.error || result.status !== 0) throw new Error("Unable to create public ACL fixture");
}
