import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// Windows chmod changes the read-only attribute, not the DACL. Use the system
// PowerShell/.NET ACL API, with paths supplied as data on stdin and no file data
// or credentials in the command line. Never fall back to chmod on ACL failure.
const windowsAclScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $path = [string]$request.path
  $item = Get-Item -LiteralPath $path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
  if ($item.PSIsContainer -ne [bool]$request.directory) { throw 'type' }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($request.write) {
    if ($request.directory) {
      $acl = New-Object System.Security.AccessControl.DirectorySecurity
      $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    } else {
      $acl = New-Object System.Security.AccessControl.FileSecurity
      $inheritance = [Security.AccessControl.InheritanceFlags]::None
    }
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inheritance, 'None', 'Allow')
    $acl.AddAccessRule($rule)
    if ($request.directory) { [IO.Directory]::SetAccessControl($path, $acl) }
    else { [IO.File]::SetAccessControl($path, $acl) }
  }
  if ($request.directory) { $actual = [IO.Directory]::GetAccessControl($path) }
  else { $actual = [IO.File]::GetAccessControl($path) }
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
  [Console]::Out.Write('private')
} catch { [Console]::Error.Write('PRIVATE_ACCESS_FAILED'); exit 1 }
`;

function validatePath(path) {
  if (typeof path !== "string" || !isAbsolute(path) || /[\0\r\n]/.test(path)) {
    throw new Error("私有文件必须使用有效的绝对路径");
  }
}

function privateAccess(path, directory, write) {
  validatePath(path);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error("私有路径必须是普通文件或目录，不能是符号链接");
  }
  if (process.platform === "win32") {
    const result = spawnSync(
      join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(windowsAclScript, "utf16le").toString("base64"),
      ],
      {
        input: JSON.stringify({ path, directory, write }),
        encoding: "utf8",
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 16_384,
      },
    );
    if (result.error || result.status !== 0 || result.stdout.trim() !== "private") {
      throw new Error("Windows 私有 ACL 检查失败：仅允许当前用户访问，且必须禁用继承");
    }
  } else {
    if (write) chmodSync(path, directory ? 0o700 : 0o600);
    if ((lstatSync(path).mode & 0o077) !== 0) {
      throw new Error(
        `私有${directory ? "目录" : "文件"}权限不能宽于 ${directory ? "0700" : "0600"}`,
      );
    }
  }
}

export function ensurePrivateDirectorySync(path) {
  validatePath(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  privateAccess(path, true, true);
}

// Call before writing sensitive content, or beneath an already-private parent.
export function ensurePrivateFileSync(path) {
  privateAccess(path, false, true);
}

export function assertPrivateFileSync(path) {
  privateAccess(path, false, false);
}

export function assertPrivateDirectorySync(path) {
  privateAccess(path, true, false);
}
