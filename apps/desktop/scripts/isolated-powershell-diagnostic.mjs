import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { join, relative, resolve, sep, win32 } from "node:path";

const systemFields = [
  "SystemDrive",
  "ProgramFiles",
  "ProgramW6432",
  "ProgramData",
  "ALLUSERSPROFILE",
];
const profileFields = [
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
];
const knownSpawnErrors = new Set([
  "ETIMEDOUT",
  "ENOENT",
  "EACCES",
  "EPERM",
  "EINVAL",
  "ENOBUFS",
  "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
]);

function environmentValue(environment, name) {
  const key = Object.keys(environment).find((key) => key.toLowerCase() === name.toLowerCase());
  return key ? environment[key] : undefined;
}

function setEnvironmentValue(environment, name, value) {
  for (const key of Object.keys(environment))
    if (key.toLowerCase() === name.toLowerCase()) delete environment[key];
  environment[name] = value;
}

// Copy only fixed OS installation fields, never the host's user profile,
// module path, authentication variables, proxy configuration or NODE_OPTIONS.
export function isolatedPowerShellVariants(environment, systemEnvironment = process.env) {
  const augmented = { ...environment };
  for (const name of systemFields) {
    const value = environmentValue(systemEnvironment, name);
    if (
      typeof value === "string" &&
      !/[\0\r\n]/.test(value) &&
      (name === "SystemDrive" ? /^[A-Za-z]:$/.test(value) : win32.isAbsolute(value))
    )
      setEnvironmentValue(augmented, name, value);
  }
  const systemRoot = environmentValue(environment, "SystemRoot");
  const programFiles =
    environmentValue(augmented, "ProgramW6432") ?? environmentValue(augmented, "ProgramFiles");
  const modules = [];
  if (typeof systemRoot === "string" && win32.isAbsolute(systemRoot))
    modules.push(win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules"));
  if (typeof programFiles === "string" && win32.isAbsolute(programFiles))
    modules.push(win32.join(programFiles, "WindowsPowerShell", "Modules"));
  setEnvironmentValue(augmented, "PSModulePath", modules.join(";"));
  return [
    { name: "baseline", createProfileDirectories: false, env: { ...environment } },
    { name: "system-env", createProfileDirectories: false, env: { ...augmented } },
    { name: "profile-directories", createProfileDirectories: true, env: { ...environment } },
    {
      name: "system-env-and-profile-directories",
      createProfileDirectories: true,
      env: { ...augmented },
    },
  ];
}

export function summarizePowerShellProbe(result, durationMs, expectedMarker) {
  const errorCode = knownSpawnErrors.has(result.error?.code) ? result.error.code : null;
  const marker = ["READY", "PRIVATE", "ACL_FAILED"].includes(result.stdout?.trim())
    ? result.stdout.trim()
    : null;
  return {
    status:
      result.error?.code === "ETIMEDOUT"
        ? "timeout"
        : result.error
          ? "spawn-failed"
          : result.status === 0 && marker === expectedMarker
            ? "ok"
            : "probe-failed",
    exitCode:
      Number.isInteger(result.status) && Math.abs(result.status) <= 0xffffffff
        ? result.status
        : null,
    signal:
      typeof result.signal === "string" && Object.hasOwn(osConstants.signals, result.signal)
        ? result.signal
        : null,
    errorCode,
    marker,
    durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : null,
  };
}

const aclReadScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $path = [string]$request.path
  $item = Get-Item -LiteralPath $path -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'type' }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $actual = [IO.File]::GetAccessControl($path)
  if ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
  if (-not $actual.AreAccessRulesProtected) { throw 'inheritance' }
  $ownerRead = $false
  foreach ($rule in $actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
      if ($rule.IdentityReference.Value -ne $sid.Value) { throw 'other-principal' }
      if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
          ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadData) -ne 0) { $ownerRead = $true }
    }
  }
  if (-not $ownerRead) { throw 'no-owner-access' }
  [Console]::Out.Write('PRIVATE')
} catch { [Console]::Out.Write('ACL_FAILED'); exit 1 }
`;

// Diagnostic only: the caller supplies its existing synthetic fixture. The
// production ACL implementation, file contents and timeouts are never changed.
export function diagnoseIsolatedPowerShell({
  env,
  cwd,
  tokenFile,
  fixtureRoot,
  onResult = () => {},
}) {
  if (process.platform !== "win32") return [];
  const root = win32.toNamespacedPath(realpathSync.native(fixtureRoot));
  function fixturePath(path) {
    if (typeof path !== "string" || !win32.isAbsolute(path) || /[\0\r\n]/.test(path))
      throw new Error("WINDOWS_SHELL_DIAGNOSTIC_UNSAFE_FIXTURE");
    const normalized = win32.toNamespacedPath(resolve(path));
    const suffix = relative(root, normalized);
    if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || win32.isAbsolute(suffix))
      throw new Error("WINDOWS_SHELL_DIAGNOSTIC_UNSAFE_FIXTURE");
    let parent = root;
    for (const segment of suffix.split(sep)) {
      parent = join(parent, segment);
      try {
        if (lstatSync(parent).isSymbolicLink())
          throw new Error("WINDOWS_SHELL_DIAGNOSTIC_UNSAFE_FIXTURE");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return normalized;
  }
  fixturePath(tokenFile);
  for (const name of ["HOME", "USERPROFILE"]) fixturePath(environmentValue(env, name));
  const directories = profileFields.flatMap((name) => {
    const value = environmentValue(env, name);
    return value === undefined ? [] : [[name, fixturePath(value)]];
  });
  const executable = win32.join(
    environmentValue(env, "SystemRoot"),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const results = [];
  for (const variant of isolatedPowerShellVariants(env)) {
    if (variant.createProfileDirectories)
      for (const [, directory] of directories) mkdirSync(directory, { recursive: true });
    for (const [probe, program, expectedMarker] of [
      ["startup", "[Console]::Out.Write('READY')", "READY"],
      ["acl-read", aclReadScript, "PRIVATE"],
    ]) {
      // PowerShell may create a cache directory itself. Report actual existence
      // before each probe so such a side effect cannot masquerade as a clean A/B.
      const profileDirectoriesExist = Object.fromEntries(
        directories.map(([name, path]) => [name, existsSync(path)]),
      );
      const started = performance.now();
      const result = spawnSync(
        executable,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(program, "utf16le").toString("base64"),
        ],
        {
          cwd,
          env: variant.env,
          input: probe === "acl-read" ? JSON.stringify({ path: tokenFile }) : "",
          encoding: "utf8",
          windowsHide: true,
          timeout: 20_000,
          maxBuffer: 16_384,
        },
      );
      const summary = {
        variant: variant.name,
        probe,
        createProfileDirectories: variant.createProfileDirectories,
        profileDirectoriesExist,
        ...summarizePowerShellProbe(result, performance.now() - started, expectedMarker),
      };
      results.push(summary);
      // Observability must not stop the remaining diagnostic probes.
      try {
        onResult(summary);
      } catch {
        /* Keep diagnostics bounded and independent of reporting. */
      }
    }
  }
  return results;
}
