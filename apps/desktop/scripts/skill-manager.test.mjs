import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createSkillManager } from "./skill-manager.mjs";
import { assertPrivateFileSync, assertPrivateDirectorySync } from "#private-file-permissions";

const WINDOWS = process.platform === "win32";
const WRAPPER = WINDOWS ? "scripts/taskctl.ps1" : "scripts/taskctl.sh";
function icacls(path, ...args) {
  const result = spawnSync("icacls.exe", [path, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
function weakenPermissions(path, posixMode) {
  if (WINDOWS) icacls(path, "/grant", "*S-1-1-0:(R)");
  else chmodSync(path, posixMode);
}
function assertWindowsPreserved(f, result, body) {
  assert.equal(result.status, "error");
  assert.match(result.message, /Windows.*原子替换/);
  assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), body);
  assert.deepEqual(f.staging(), []);
}

const NAME = "manage-codexboard";
const digest = (value) => createHash("sha256").update(value).digest("hex");
function write(path, value, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
  chmodSync(path, mode);
}

function fixture(t, overrides = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "codexboard-skill-manager-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, "home");
  mkdirSync(home);
  const runtimeRoot = join(directory, "runtime");
  const appData = join(home, "Library/Application Support/CodexBoard");
  const target = join(home, ".agents/skills", NAME);
  const source = join(runtimeRoot, "skills", NAME);
  const stateFile = join(appData, "skill-install-state.json");
  const manifestFile = join(runtimeRoot, "skills/manifest.json");
  let commits = 0;
  function bundled(version = "0.1.1", body = "# Test Skill\n") {
    const files = [
      { path: "SKILL.md", mode: 0o644, body },
      { path: WRAPPER, mode: 0o755, body: "#!/bin/sh\nexit 0\n" },
    ];
    for (const file of files) write(join(source, file.path), file.body, file.mode);
    write(
      manifestFile,
      JSON.stringify({
        schemaVersion: 1,
        name: NAME,
        version,
        files: files.map(({ path, mode, body }) => ({ path, mode, sha256: digest(body) })),
      }),
    );
  }
  bundled();
  const identify = (path) => {
    const value = lstatSync(path, { bigint: true });
    return { dev: String(value.dev), ino: String(value.ino) };
  };
  // The native helper has separate real renameatx_np tests. This adapter models
  // its completed filesystem effect so Node fault tests need no app binary.
  const commitDirectories = ({ stagingName, expectedTarget }) => {
    commits++;
    const stage = join(dirname(target), stagingName);
    if (!expectedTarget) {
      assert.equal(existsSync(target), false);
      renameSync(stage, target);
    } else {
      assert.deepEqual(identify(target), expectedTarget);
      const swap = `${stage}.exchange`;
      renameSync(target, swap);
      renameSync(stage, target);
      renameSync(swap, stage);
    }
  };
  const rollbackNewInstall = ({ stagingName, expectedTarget }) => {
    assert.deepEqual(identify(target), expectedTarget);
    const stage = join(dirname(target), stagingName);
    assert.equal(existsSync(stage), false);
    renameSync(target, stage);
  };
  const options = {
    runtimeRoot,
    appData,
    home,
    commitDirectories,
    rollbackNewInstall,
    ...overrides,
  };
  return {
    directory,
    home,
    runtimeRoot,
    appData,
    target,
    source,
    stateFile,
    manifestFile,
    bundled,
    manager: createSkillManager(options),
    managerWith: (extra) => createSkillManager({ ...options, ...extra }),
    commitDirectories,
    commits: () => commits,
    staging: () =>
      existsSync(dirname(target))
        ? readdirSync(dirname(target)).filter((name) =>
            name.startsWith(".manage-codexboard.install-"),
          )
        : [],
  };
}

test("status is read-only and explicit install writes verified files with required modes", async (t) => {
  const f = fixture(t);
  const initial = f.manager.status();
  assert.equal(initial.status, "notInstalled");
  assert.equal(initial.updateAvailable, false);
  assert.match(initial.bundledRevision, /^[a-f0-9]{64}$/);
  assert.equal(initial.canInstall, true);
  assert.match(initial.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.manager.status(), initial);
  assert.deepEqual(readdirSync(f.home), []);
  const installed = await f.manager.install({ expectedFingerprint: null });
  assert.equal(installed.status, "current");
  assert.equal(installed.installedVersion, "0.1.1");
  assert.equal(installed.canInstall, false);
  assert.equal(installed.updateAvailable, false);
  assert.equal(installed.bundledRevision, initial.bundledRevision);
  assert.match(installed.message, /Codex 技能列表/);
  assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), "# Test Skill\n");
  if (WINDOWS) {
    assertPrivateDirectorySync(f.target);
    for (const path of [join(f.target, WRAPPER), join(f.target, "SKILL.md"), f.stateFile])
      assertPrivateFileSync(path);
  } else {
    assert.equal(lstatSync(join(f.target, WRAPPER)).mode & 0o777, 0o755);
    assert.equal(lstatSync(join(f.target, "SKILL.md")).mode & 0o777, 0o644);
    assert.equal(lstatSync(f.stateFile).mode & 0o777, 0o600);
  }
  assert.deepEqual(f.staging(), []);
});

test("dismiss persists only the offer preference and never creates the skill", async (t) => {
  const f = fixture(t);
  const result = await f.manager.dismiss();
  assert.equal(result.offerDismissed, true);
  assert.equal(result.status, "notInstalled");
  assert.equal(existsSync(f.target), false);
  assert.equal(existsSync(join(f.home, ".agents")), false);
  assert.equal(f.managerWith({}).status().offerDismissed, true);
});

test("corrupt manifests and modified bundled files never create user skill directories", async (t) => {
  for (const change of [
    (f) => write(f.manifestFile, "bad json"),
    (f) => write(join(f.source, "SKILL.md"), "changed bundle"),
    (f) => {
      const value = JSON.parse(readFileSync(f.manifestFile));
      value.files[0].path = "../outside";
      write(f.manifestFile, JSON.stringify(value));
    },
    (f) => {
      const value = JSON.parse(readFileSync(f.manifestFile));
      value.files.push(value.files[0]);
      write(f.manifestFile, JSON.stringify(value));
    },
    (f) => {
      const value = JSON.parse(readFileSync(f.manifestFile));
      value.files[0].mode = 0o777;
      write(f.manifestFile, JSON.stringify(value));
    },
  ]) {
    const f = fixture(t);
    change(f);
    assert.equal(f.manager.status().status, "unavailable");
    assert.equal((await f.manager.install()).status, "error");
    assert.deepEqual(readdirSync(f.home), []);
  }
});

test("unknown existing directories require explicit replacement and their fresh whole-tree fingerprint", async (t) => {
  const f = fixture(t);
  write(join(f.target, "SKILL.md"), "custom skill");
  write(join(f.target, "notes.txt"), "custom notes");
  const before = f.manager.status();
  assert.equal(before.status, "modified");
  assert.equal(before.canInstall, false);
  assert.equal(before.canReplace, !WINDOWS);
  assert.equal(
    (await f.manager.install({ expectedFingerprint: before.fingerprint })).status,
    "error",
  );
  assert.equal(
    (await f.manager.install({ replaceModified: true, expectedFingerprint: "0".repeat(64) }))
      .status,
    "error",
  );
  assert.equal(readFileSync(join(f.target, "notes.txt"), "utf8"), "custom notes");
  const result = await f.manager.install({
    replaceModified: true,
    expectedFingerprint: before.fingerprint,
  });
  if (WINDOWS) {
    assertWindowsPreserved(f, result, "custom skill");
    assert.equal(readFileSync(join(f.target, "notes.txt"), "utf8"), "custom notes");
    return;
  }
  assert.equal(result.status, "current");
  assert.equal(existsSync(join(f.target, "notes.txt")), false);
  assert.deepEqual(f.staging(), []);
});

test("actual content, modes, extra entries and a rewritten receipt each make owned skills modified", async (t) => {
  for (const mutate of [
    (f) => write(join(f.target, "SKILL.md"), "user edit"),
    (f) => weakenPermissions(join(f.target, WRAPPER), 0o644),
    (f) => write(join(f.target, "extra.txt"), "extra"),
    (f) => mkdirSync(join(f.target, "extra-directory")),
    (f) => weakenPermissions(join(f.target, "scripts"), 0o755),
    (f) => write(join(f.target, ".codexboard-skill.json"), "{}"),
    (f) => {
      write(join(f.target, "SKILL.md"), "user edit");
      const path = join(f.target, ".codexboard-skill.json");
      const value = JSON.parse(readFileSync(path));
      value.files.find((file) => file.path === "SKILL.md").sha256 = digest("user edit");
      write(path, JSON.stringify(value));
    },
  ]) {
    const f = fixture(t);
    assert.equal((await f.manager.install()).status, "current");
    mutate(f);
    assert.equal(f.manager.status().status, "modified");
    assert.equal(f.manager.status().canReplace, !WINDOWS);
  }
});

test("new bundled versions are offered without writing and update only after a fresh request", async (t) => {
  const f = fixture(t);
  await f.manager.install();
  f.bundled("0.1.2", "new version\n");
  const status = f.manager.status();
  assert.equal(status.status, "updateAvailable");
  assert.equal(status.installedVersion, "0.1.1");
  assert.equal(status.bundledVersion, "0.1.2");
  assert.equal(status.updateAvailable, true);
  assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), "# Test Skill\n");
  assert.equal((await f.manager.install()).status, "error");
  const result = await f.manager.install({ expectedFingerprint: status.fingerprint });
  if (WINDOWS) {
    assertWindowsPreserved(f, result, "# Test Skill\n");
    assert.equal(f.manager.status().status, "updateAvailable");
    return;
  }
  assert.equal(result.status, "current");
  assert.equal(result.installedVersion, "0.1.2");
  assert.equal(result.updateAvailable, false);
  f.bundled("0.1.1");
  assert.equal(f.manager.status().status, "current");
  assert.equal(f.manager.status().updateAvailable, false);
  assert.equal(f.manager.status().canInstall, false);
  assert.equal((await f.manager.install()).installedVersion, "0.1.2");
  assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), "new version\n");
});

test("same-version bundle changes are updates to untouched installations and require an explicit fresh install", async (t) => {
  const f = fixture(t);
  const installed = await f.manager.install();
  const previousState = readFileSync(f.stateFile);
  f.bundled("0.1.1", "same version with revised instructions\n");
  const status = f.manager.status();
  assert.equal(status.status, "updateAvailable");
  assert.equal(status.updateAvailable, true);
  assert.equal(status.canInstall, !WINDOWS);
  assert.equal(status.canReplace, false);
  assert.equal(status.installedVersion, "0.1.1");
  assert.notEqual(status.bundledRevision, installed.bundledRevision);
  assert.equal(status.fingerprint, installed.fingerprint);
  assert.deepEqual(readFileSync(f.stateFile), previousState);
  assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), "# Test Skill\n");
  assert.equal((await f.manager.install()).status, "error");
  const result = await f.manager.install({ expectedFingerprint: status.fingerprint });
  if (WINDOWS) {
    assertWindowsPreserved(f, result, "# Test Skill\n");
    assert.equal(f.manager.status().status, "updateAvailable");
    return;
  }
  assert.equal(result.status, "current");
  assert.equal(result.updateAvailable, false);
  assert.equal(result.bundledRevision, status.bundledRevision);
  assert.equal(
    readFileSync(join(f.target, "SKILL.md"), "utf8"),
    "same version with revised instructions\n",
  );
});

test("trusted receipts announce updated bundles while protecting locally modified files until replacement is confirmed", async (t) => {
  for (const version of ["0.1.1", "0.1.2"]) {
    const f = fixture(t);
    await f.manager.install();
    write(join(f.target, "SKILL.md"), "personal instructions\n");
    f.bundled(version, "new bundled instructions\n");
    const status = f.manager.status();
    assert.equal(status.status, "modified");
    assert.equal(status.installedVersion, "0.1.1");
    assert.equal(status.updateAvailable, true);
    assert.equal(status.canInstall, false);
    assert.equal(status.canReplace, !WINDOWS);
    assert.equal(
      (await f.manager.install({ expectedFingerprint: status.fingerprint })).status,
      "error",
    );
    assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), "personal instructions\n");
    const result = await f.manager.install({
      expectedFingerprint: status.fingerprint,
      replaceModified: true,
    });
    if (WINDOWS) {
      assertWindowsPreserved(f, result, "personal instructions\n");
      continue;
    }
    assert.equal(result.status, "current");
    assert.equal(result.updateAvailable, false);
    assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), "new bundled instructions\n");
  }
});

test("untrusted installation metadata never announces an update even when the bundled version is higher", async (t) => {
  for (const mutate of [
    (f) => {
      const path = join(f.target, ".codexboard-skill.json");
      const receipt = JSON.parse(readFileSync(path));
      receipt.version = "0.0.1";
      write(path, JSON.stringify(receipt));
    },
    (f) => {
      const state = JSON.parse(readFileSync(f.stateFile));
      state.installed.files[0].sha256 = "0".repeat(64);
      write(f.stateFile, JSON.stringify(state), 0o600);
    },
    (f) => rmSync(f.stateFile),
  ]) {
    const f = fixture(t);
    await f.manager.install();
    mutate(f);
    f.bundled("0.1.2", "new bundle\n");
    const status = f.manager.status();
    assert.equal(status.status, "modified");
    assert.equal(status.installedVersion, null);
    assert.equal(status.updateAvailable, false);
    assert.equal(status.canInstall, false);
    assert.equal(
      (await f.manager.install({ expectedFingerprint: status.fingerprint })).status,
      "error",
    );
    assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), "# Test Skill\n");
  }
});

test("bundle revisions depend on normalized file content and modes, not filesystem identity, manifest order or version", async (t) => {
  const first = fixture(t);
  const second = fixture(t);
  assert.notEqual(lstatSync(first.source).ino, lstatSync(second.source).ino);
  const original = first.manager.status().bundledRevision;
  assert.equal(second.manager.status().bundledRevision, original);
  const manifest = JSON.parse(readFileSync(second.manifestFile));
  manifest.version = "0.1.2";
  manifest.files.reverse();
  write(second.manifestFile, JSON.stringify(manifest, null, 2));
  assert.equal(second.manager.status().bundledRevision, original);
  chmodSync(join(second.source, WRAPPER), 0o644);
  manifest.files.find((file) => file.path === WRAPPER).mode = 0o644;
  write(second.manifestFile, JSON.stringify(manifest));
  assert.notEqual(second.manager.status().bundledRevision, original);
  second.bundled("0.1.1", "changed content\n");
  assert.notEqual(second.manager.status().bundledRevision, original);
});

test("a managed installed tree cannot claim an available update or be followed after a bundle change", async (t) => {
  const f = fixture(t);
  await f.manager.install();
  const outside = join(f.directory, "outside-skill.md");
  write(outside, "managed personal contents\n");
  rmSync(join(f.target, "SKILL.md"));
  symlinkSync(outside, join(f.target, "SKILL.md"));
  f.bundled("0.1.2", "new bundle\n");
  const status = f.manager.status();
  assert.equal(status.status, "managed");
  assert.equal(status.updateAvailable, false);
  assert.equal(status.canInstall, false);
  assert.equal(status.canReplace, false);
  assert.equal(
    (await f.manager.install({ replaceModified: true, expectedFingerprint: status.fingerprint }))
      .status,
    "error",
  );
  assert.equal(readFileSync(outside, "utf8"), "managed personal contents\n");
});

test("links, special paths and manager markers cannot be replaced even with confirmation", async (t) => {
  for (const setup of [
    (f, outside) => symlinkSync(outside, join(f.home, ".agents"), "junction"),
    (f, outside) => {
      mkdirSync(dirname(f.target), { recursive: true });
      symlinkSync(outside, f.target, "junction");
    },
    (f, outside) => {
      mkdirSync(f.target, { recursive: true });
      symlinkSync(join(outside, "keep.txt"), join(f.target, "SKILL.md"));
    },
    (f) => write(join(f.target, ".git"), "gitdir: elsewhere"),
  ]) {
    const f = fixture(t);
    const outside = join(f.directory, "outside");
    write(join(outside, "keep.txt"), "keep");
    setup(f, outside);
    const status = f.manager.status();
    assert.equal(status.status, "managed");
    assert.equal(status.canReplace, false);
    assert.equal(
      (await f.manager.install({ replaceModified: true, expectedFingerprint: status.fingerprint }))
        .status,
      "error",
    );
    assert.deepEqual(readdirSync(outside), ["keep.txt"]);
    assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep");
  }
});

test("either default or configured legacy Codex skill location prevents duplicate installation", async (t) => {
  for (const custom of [false, true]) {
    const f = fixture(t);
    const root = custom ? join(f.directory, "custom-codex") : join(f.home, ".codex");
    const legacy = join(root, "skills", NAME);
    mkdirSync(dirname(legacy), { recursive: true });
    symlinkSync(join(f.directory, "missing-managed-skill"), legacy, "junction");
    const manager = f.managerWith({ codexHome: custom ? root : "relative-ignored" });
    assert.equal(manager.status().status, "managed");
    assert.match(manager.status().message, /旧技能目录/);
    assert.equal((await manager.install()).status, "error");
    assert.equal(existsSync(f.target), false);
  }
});

test("target changes immediately before commit reject the stale confirmation", async (t) => {
  const f = fixture(t);
  if (!WINDOWS) write(join(f.target, "SKILL.md"), "first edit");
  const before = f.manager.status();
  const manager = f.managerWith({
    beforeCommit: () => write(join(f.target, "SKILL.md"), "concurrent edit"),
  });
  const result = await manager.install({
    replaceModified: true,
    expectedFingerprint: before.fingerprint,
  });
  assert.equal(result.status, "error");
  assert.match(result.message, /已发生变化/);
  assert.equal(f.commits(), 0);
  assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), "concurrent edit");
  assert.deepEqual(f.staging(), []);
});

test("pre-rename Skill directories remain untouched and block duplicate installation", async (t) => {
  for (const location of ["agents", "codex", "custom"]) {
    const f = fixture(t);
    const root =
      location === "agents"
        ? join(f.home, ".agents")
        : location === "codex"
          ? join(f.home, ".codex")
          : join(f.directory, "custom-codex");
    const old = join(root, "skills/manage-lark-taskboard");
    write(join(old, "SKILL.md"), "personal pre-rename skill");
    const manager = f.managerWith({ codexHome: location === "custom" ? root : undefined });
    assert.equal(manager.status().status, "managed");
    assert.equal((await manager.install({ replaceModified: true })).status, "error");
    assert.equal(readFileSync(join(old, "SKILL.md"), "utf8"), "personal pre-rename skill");
    assert.equal(existsSync(f.target), false);
  }
});

test("a legacy receipt owner at the renamed target remains protected as modified", async (t) => {
  const f = fixture(t);
  await f.manager.install();
  const receiptFile = join(f.target, ".codexboard-skill.json");
  const receipt = JSON.parse(readFileSync(receiptFile));
  receipt.owner = "cn.rocyan.taskboard.desktop";
  const bytes = JSON.stringify(receipt) + "\n";
  write(receiptFile, bytes);
  const state = JSON.parse(readFileSync(f.stateFile));
  state.installed.receiptSha256 = digest(bytes);
  write(f.stateFile, JSON.stringify(state), 0o600);
  const before = f.manager.status();
  assert.equal(before.status, "modified");
  assert.equal(
    (await f.manager.install({ expectedFingerprint: before.fingerprint })).status,
    "error",
  );
  assert.equal(readFileSync(receiptFile, "utf8"), bytes);
});

test("failed native commit preserves old content and removes only this operation staging", async (t) => {
  const f = fixture(t);
  if (!WINDOWS) write(join(f.target, "SKILL.md"), "original");
  const manager = f.managerWith({
    commitDirectories: () => {
      throw new Error("synthetic failure with private data");
    },
  });
  const result = await manager.install({
    replaceModified: true,
    expectedFingerprint: manager.status().fingerprint,
  });
  assert.equal(result.status, "error");
  assert.doesNotMatch(result.message, /private data/);
  if (WINDOWS) assert.equal(existsSync(f.target), false);
  else assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), "original");
  assert.equal(existsSync(f.stateFile), false);
  assert.deepEqual(f.staging(), []);
});

test("metadata commit failure reverses both initial install and directory replacement", async (t) => {
  for (const existing of WINDOWS ? [false] : [false, true]) {
    const f = fixture(t);
    if (existing) await f.manager.install();
    const previousState = existing ? readFileSync(f.stateFile) : null;
    const previousTree = existing ? f.manager.status().fingerprint : null;
    f.bundled("0.1.2", "next version");
    const manager = f.managerWith({
      beforeStateCommit: () => {
        throw new Error("injected metadata failure");
      },
    });
    const result = await manager.install({ expectedFingerprint: manager.status().fingerprint });
    assert.equal(result.status, "error");
    if (existing) {
      assert.deepEqual(readFileSync(f.stateFile), previousState);
      assert.equal(f.manager.status().fingerprint, previousTree);
      assert.equal(f.manager.status().status, "updateAvailable");
    } else {
      assert.equal(existsSync(f.target), false);
      assert.equal(existsSync(f.stateFile), false);
    }
    assert.deepEqual(f.staging(), []);
  }
});

test("a lost acknowledgement after directory commit preserves original staging and reports uncertainty", async (t) => {
  for (const existing of WINDOWS ? [false] : [false, true]) {
    const f = fixture(t);
    if (existing) write(join(f.target, "personal.txt"), "synthetic original contents");
    const manager = f.managerWith({
      commitDirectories: (request) => {
        f.commitDirectories(request);
        throw new Error("synthetic lost success acknowledgement");
      },
    });
    const result = await manager.install({
      replaceModified: true,
      expectedFingerprint: manager.status().fingerprint,
    });
    assert.equal(result.status, "error");
    assert.match(result.message, /无法确认安装提交结果/);
    assert.doesNotMatch(result.message, /原有目录未被替换/);
    assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), "# Test Skill\n");
    assert.equal(existsSync(f.stateFile), false);
    if (existing) {
      assert.equal(f.staging().length, 1);
      assert.equal(
        readFileSync(join(dirname(f.target), f.staging()[0], "personal.txt"), "utf8"),
        "synthetic original contents",
      );
    } else assert.deepEqual(f.staging(), []);
  }
});

test("rollback never treats a concurrently substituted target as the newly installed directory", async (t) => {
  const f = fixture(t);
  if (!WINDOWS) write(join(f.target, "personal.txt"), "synthetic original contents");
  const installed = join(f.directory, "concurrently-moved-install");
  const manager = f.managerWith({
    commitDirectories: (request) => {
      f.commitDirectories(request);
      renameSync(f.target, installed);
      write(join(f.target, "external.txt"), "keep concurrent synthetic contents");
    },
  });
  const result = await manager.install({
    replaceModified: true,
    expectedFingerprint: manager.status().fingerprint,
  });
  assert.equal(result.status, "error");
  assert.match(result.message, /无法确认替换恢复结果/);
  assert.equal(
    readFileSync(join(f.target, "external.txt"), "utf8"),
    "keep concurrent synthetic contents",
  );
  if (WINDOWS) assert.deepEqual(f.staging(), []);
  else {
    assert.equal(f.staging().length, 1);
    assert.equal(
      readFileSync(join(dirname(f.target), f.staging()[0], "personal.txt"), "utf8"),
      "synthetic original contents",
    );
  }
  assert.equal(readFileSync(join(installed, "SKILL.md"), "utf8"), "# Test Skill\n");
});

test("a substituted staging directory is never installed or removed", async (t) => {
  const f = fixture(t);
  const held = join(f.directory, "held-original-stage");
  const manager = f.managerWith({
    beforeCommit: () => {
      const path = join(dirname(f.target), f.staging()[0]);
      renameSync(path, held);
      write(join(path, "personal.txt"), "unrelated synthetic directory");
    },
  });
  const result = await manager.install();
  assert.equal(result.status, "error");
  assert.equal(existsSync(f.target), false);
  assert.equal(f.commits(), 0);
  assert.equal(f.staging().length, 1);
  assert.equal(
    readFileSync(join(dirname(f.target), f.staging()[0], "personal.txt"), "utf8"),
    "unrelated synthetic directory",
  );
});

test("concurrent install requests are serialized and do not replace a completed current version", async (t) => {
  const f = fixture(t);
  const fingerprint = f.manager.status().fingerprint;
  const results = await Promise.all([
    f.manager.install({ expectedFingerprint: fingerprint }),
    f.manager.install({ expectedFingerprint: fingerprint }),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["current", "current"],
  );
  assert.equal(f.commits(), 1);
  assert.deepEqual(f.staging(), []);
});

test("missing or corrupt independent installation records cannot authorize automatic replacement", async (t) => {
  const f = fixture(t);
  await f.manager.install();
  write(f.stateFile, "not-json", 0o600);
  assert.equal(f.manager.status().status, "modified");
  const result = await f.manager.install({
    replaceModified: true,
    expectedFingerprint: f.manager.status().fingerprint,
  });
  if (WINDOWS) {
    assertWindowsPreserved(f, result, "# Test Skill\n");
    assert.equal(readFileSync(f.stateFile, "utf8"), "not-json");
  } else assert.equal(result.status, "current");
  rmSync(f.stateFile);
  assert.equal(f.manager.status().status, "modified");
});

test("an installation-state symlink is never followed or overwritten", async (t) => {
  const f = fixture(t);
  const outside = join(f.directory, "outside.json");
  write(outside, "keep this file");
  mkdirSync(f.appData, { recursive: true });
  symlinkSync(outside, f.stateFile);
  assert.equal(f.manager.status().status, "managed");
  assert.equal((await f.manager.dismiss()).status, "error");
  assert.equal(readFileSync(outside, "utf8"), "keep this file");
  assert.equal(lstatSync(f.stateFile).isSymbolicLink(), true);
});

test(
  "unreadable target files return an actionable error without writing",
  { skip: process.getuid?.() === 0 },
  async (t) => {
    const f = fixture(t);
    const path = join(f.target, "SKILL.md");
    write(path, "private synthetic text", WINDOWS ? 0o644 : 0o000);
    if (WINDOWS) icacls(path, "/deny", "*S-1-1-0:(R)");
    t.after(() => {
      if (WINDOWS && existsSync(path)) icacls(path, "/remove:d", "*S-1-1-0");
    });
    const result = f.manager.status();
    assert.equal(result.status, "error");
    assert.match(result.message, /权限/);
    assert.equal((await f.manager.install()).status, "error");
    if (WINDOWS) icacls(path, "/remove:d", "*S-1-1-0");
    else chmodSync(path, 0o644);
    assert.equal(readFileSync(join(f.target, "SKILL.md"), "utf8"), "private synthetic text");
  },
);
