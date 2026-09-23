import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { copyBundledSkill, windowsSkillDocument } from "./package-skills.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "codexboard-skill-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "skills/manage-codexboard");
  mkdirSync(join(source, "scripts"), { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "---\nname: manage-codexboard\ndescription: test\n---\n");
  writeFileSync(join(source, "scripts/taskctl.sh"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(source, "README.md"), "Repository-only installation guide");
  return { root, source, runtime: join(root, "runtime") };
}

test("bundles only runnable Skill files with deterministic hashes and executable wrapper", (t) => {
  const { root, source, runtime } = fixture(t);
  const manifest = copyBundledSkill(root, runtime, "0.1.1", "darwin");
  assert.equal(manifest.version, "0.1.1");
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    ["SKILL.md", "scripts/taskctl.sh"],
  );
  for (const file of manifest.files) {
    const destination = join(runtime, "skills/manage-codexboard", file.path);
    const bytes = readFileSync(destination);
    assert.deepEqual(bytes, readFileSync(join(source, file.path)));
    assert.equal(file.sha256, createHash("sha256").update(bytes).digest("hex"));
    if (process.platform !== "win32") assert.equal(statSync(destination).mode & 0o777, file.mode);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(runtime, "skills/manifest.json"))), manifest);
  assert.throws(() => statSync(join(runtime, "skills/manage-codexboard/README.md")), {
    code: "ENOENT",
  });
});

test("missing or linked Skill content aborts packaging", (t) => {
  const { root, source, runtime } = fixture(t);
  const script = join(source, "scripts/taskctl.sh");
  rmSync(script);
  assert.throws(() => copyBundledSkill(root, runtime, "0.1.1", "darwin"), { code: "ENOENT" });
  symlinkSync(join(source, "README.md"), script);
  assert.throws(() => copyBundledSkill(root, runtime, "0.1.1", "darwin"), /文件无效/);
});

test(
  "POSIX packaging fixes file permissions even with a restrictive release umask",
  { skip: process.platform === "win32" },
  (t) => {
    const { root, runtime } = fixture(t);
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { copyBundledSkill, windowsSkillDocument } from ${JSON.stringify(new URL("./package-skills.mjs", import.meta.url).href)};
    process.umask(0o077);
    copyBundledSkill(process.argv[1], process.argv[2], "0.1.1", "darwin");
  `,
        root,
        runtime,
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(statSync(join(runtime, "skills/manage-codexboard/SKILL.md")).mode & 0o777, 0o644);
    assert.equal(
      statSync(join(runtime, "skills/manage-codexboard/scripts/taskctl.sh")).mode & 0o777,
      0o755,
    );
  },
);

test("linked Skill source directories cannot bring outside files into the app", (t) => {
  const { root, source, runtime } = fixture(t);
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "taskctl.sh"), "outside content");
  rmSync(join(source, "scripts"), { recursive: true });
  symlinkSync(outside, join(source, "scripts"), "junction");
  assert.throws(() => copyBundledSkill(root, runtime, "0.1.1", "darwin"), /源目录无效/);
});

test("Windows package includes native wrappers with verified hashes and no shell dependency", (t) => {
  const { root, source, runtime } = fixture(t);
  writeFileSync(
    join(source, "SKILL.md"),
    readFileSync(new URL("../../../skills/manage-codexboard/SKILL.md", import.meta.url)),
  );
  writeFileSync(join(source, "scripts/taskctl.ps1"), "Write-Output 'fixture'\n");
  writeFileSync(join(source, "scripts/taskctl.cmd"), "@echo off\r\n");
  const manifest = copyBundledSkill(root, runtime, "0.1.1", "win32");
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    ["SKILL.md", "scripts/taskctl.ps1", "scripts/taskctl.cmd"],
  );
  for (const file of manifest.files) {
    const bytes = readFileSync(join(runtime, "skills/manage-codexboard", file.path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
    assert.deepEqual(
      bytes,
      file.path === "SKILL.md"
        ? windowsSkillDocument(readFileSync(join(source, file.path)))
        : readFileSync(join(source, file.path)),
    );
  }
  const guide = readFileSync(join(runtime, "skills/manage-codexboard/SKILL.md"), "utf8");
  assert.match(guide, /scripts\/taskctl.ps1/);
  assert.doesNotMatch(guide, /taskctl.sh|\/Applications|```sh/);
  assert.throws(() => statSync(join(runtime, "skills/manage-codexboard/scripts/taskctl.sh")), {
    code: "ENOENT",
  });
});
