import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const skillName = "manage-codexboard";
const bundledFiles = [
  ["SKILL.md", 0o644],
  ["scripts/taskctl.sh", 0o755],
];

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
    const contents = readFileSync(file);
    if (path === "SKILL.md" && !/^name: manage-codexboard\s*$/m.test(contents.toString()))
      throw new Error("Skill 名称与安装目录不一致");
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
