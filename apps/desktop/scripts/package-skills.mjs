import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const skillName = "manage-codexboard";
const bundledFiles = [
  ["SKILL.md", 0o644],
  ["scripts/taskctl.sh", 0o755],
];

export function windowsSkillDocument(contents) {
  const source = contents.toString("utf8");
  const start = source.indexOf("## 运行入口");
  const end = source.indexOf("`--help` 无需后台运行", start);
  if (start < 0 || end < 0) throw new Error("Skill 运行入口结构已变化，请更新 Windows 文档适配");
  const entry =
    "## 运行入口\n\n从本次加载的 SKILL.md 定位同目录下 scripts/taskctl.ps1，使用 PowerShell 调用；保持项目原有工作目录。路径是占位符，替换后执行。\n\n```powershell\n$TASKCTL = 'C:\\实际安装目录\\manage-codexboard\\scripts\\taskctl.ps1'\n& $TASKCTL --help\n& $TASKCTL health\n```\n\n包装器仅调用完整 Windows 安装目录内的 runtime\\bin\\node.exe 与内置 taskctl，无需全局 Node。当前安装器的默认位置是 `%LOCALAPPDATA%\\CodexBoard Desktop`；其次探测 Program Files 下的同名目录。自定义位置通过 `$env:CODEXBOARD_APP_PATH` 指定；显式路径无效则报错，不回退。默认数据目录为 `%LOCALAPPDATA%\\CodexBoard\\data`，`$env:CODEXBOARD_DATA_DIR` 可覆盖；包装器不迁移数据。\n\n```powershell\n$env:CODEXBOARD_APP_PATH = 'D:\\Apps\\CodexBoard Desktop'\n& $TASKCTL --help\n```\n\n也可从 cmd 使用同目录 taskctl.cmd。若系统执行策略阻止 PowerShell 脚本，说明实际提示并交由用户处理，不自动放宽策略或添加 Bypass。Windows 版可首次安装 Skill；已有目录不会被自动替换。\n\n";
  return Buffer.from(
    (source.slice(0, start) + entry + source.slice(end))
      .replaceAll(
        "[scripts/taskctl.sh](scripts/taskctl.sh)",
        "[scripts/taskctl.ps1](scripts/taskctl.ps1)",
      )
      .replaceAll("```sh", "```powershell")
      .replaceAll('"$TASKCTL"', "& $TASKCTL"),
  );
}

export function copyBundledSkill(project, runtime, version, platform = process.platform) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error("Skill 发布版本需要稳定版本号（例如 0.1.1）");
  const source = join(project, "skills", skillName);
  const target = join(runtime, "skills", skillName);
  for (const directory of [join(project, "skills"), source, join(source, "scripts")]) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Skill 源目录无效");
  }
  const manifest = { schemaVersion: 1, name: skillName, version, files: [] };
  const files =
    platform === "win32"
      ? [
          ["SKILL.md", 0o644],
          ["scripts/taskctl.ps1", 0o644],
          ["scripts/taskctl.cmd", 0o644],
        ]
      : bundledFiles;
  for (const [path, mode] of files) {
    const file = join(source, path);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Skill 文件无效：${path}`);
    let contents = readFileSync(file);
    if (path === "SKILL.md" && !/^name: manage-codexboard\s*$/m.test(contents.toString()))
      throw new Error("Skill 名称与安装目录不一致");
    if (platform === "win32" && path === "SKILL.md") contents = windowsSkillDocument(contents);
    const destination = join(target, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents, { mode });
    chmodSync(destination, mode);
    manifest.files.push({
      path,
      sha256: createHash("sha256").update(contents).digest("hex"),
      mode,
    });
  }
  writeFileSync(join(runtime, "skills/manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
