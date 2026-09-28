import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

// Query only this user's registered, healthy package. Do not guess a versioned
// WindowsApps directory or read credentials from the application profile.
export function findWindowsCodexPackage({ execute = execFileSync, exists = existsSync } = {}) {
  try {
    const output = execute(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-AppxPackage -Name OpenAI.Codex | Where-Object { $_.Name -eq 'OpenAI.Codex' -and $_.Status -eq 'Ok' } | Sort-Object Version -Descending | Select-Object -First 1 InstallLocation,PackageFamilyName | ConvertTo-Json -Compress",
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 8192,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const app = JSON.parse(output.trim().replace(/^\uFEFF/, ""));
    if (
      !app ||
      typeof app.InstallLocation !== "string" ||
      !win32.isAbsolute(app.InstallLocation) ||
      !/^OpenAI\.Codex_[a-z0-9]+$/.test(app.PackageFamilyName)
    )
      return undefined;
    const resources = win32.join(app.InstallLocation, "app", "resources");
    const cliPath = [
      win32.join(resources, "codex-cli", "bin", "codex.exe"),
      win32.join(resources, "codex.exe"),
    ].find(exists);
    const appPath = win32.join(app.InstallLocation, "app", "ChatGPT.exe");
    if (!cliPath || !exists(appPath)) return undefined;
    return { cliPath, appPath, appUserModelId: `${app.PackageFamilyName}!App` };
  } catch {
    return undefined;
  }
}

export function canRunWindowsCodexCli(path, execute = execFileSync) {
  try {
    const output = execute(path, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 8192,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return /^codex-cli\s+\S+/m.test(output.trim());
  } catch {
    // Registered MSIX files can exist but fail to execute (including UNKNOWN).
    // Do not change ACLs or reveal raw diagnostics; retain standalone fallback.
    return false;
  }
}

export function findWindowsCodexCli({
  env = process.env,
  localAppData = Object.entries(env).find(([key]) => key.toLowerCase() === "localappdata")?.[1],
  exists = existsSync,
  findWindowsPackage = findWindowsCodexPackage,
  canRun = canRunWindowsCodexCli,
} = {}) {
  // Match Desktop's catalog and capabilities when both installations exist.
  // A separately installed CLI can have an older model catalog.
  const desktop = findWindowsPackage({ exists });
  if (desktop?.cliPath && canRun(desktop.cliPath)) return desktop.cliPath;
  if (typeof localAppData === "string") {
    const base = localAppData.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
    if (
      /^(?:[a-z]:[\\/]|\\\\[^\\/]+\\[^\\/]+(?:\\|$))/i.test(base) &&
      !/[<>:"|?*]/.test(base.replace(/^[a-z]:/i, "")) &&
      ![...base].some((character) => character.charCodeAt(0) < 32) &&
      !/(?:^|[\\/])\.{1,2}(?:[\\/]|$)/.test(base)
    ) {
      // The official standalone installer uses this one fixed per-user location.
      // Use it only when Desktop is unavailable; never scan PATH here.
      const path = win32.join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe");
      if (exists(path)) return path;
    }
  }
  return undefined;
}

export function windowsOpenArguments(target) {
  // Arguments are passed to PowerShell as a constant script, not through cmd.exe.
  // Only known URLs/AUMIDs and validated UUID deep links are used by callers.
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Start-Process -FilePath '${target.replaceAll("'", "''")}' -ErrorAction Stop`,
  ];
}
