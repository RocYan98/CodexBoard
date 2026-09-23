import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  fchmodSync,
  fsyncSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensurePrivateDirectorySync,
  ensurePrivateFileSync,
  assertPrivateFileSync,
  assertPrivateDirectorySync,
} from "#private-file-permissions";

const NAME = "manage-codexboard";
// Recognize installed pre-rename Skills without moving or replacing user files.
const LEGACY_NAMES = ["manage-lark-codex", "manage-lark-taskboard"];
const RECEIPT = ".codexboard-skill.json";
const OWNER = "cn.rocyan.codexboard.desktop";
const STAGE_PREFIX = `.${NAME}.install-`;
const MAX_TREE_BYTES = 32 * 1024 * 1024;
const messages = {
  managed: "此 Skill 路径含链接、受管标记或特殊文件。请在原管理工具中处理，应用不会覆盖。",
  legacy:
    "Codex 旧技能目录或旧名称位置已有 CodexBoard Skill。请先在原管理工具中处理，避免出现重复技能。",
  bundle: "随包 Skill 缺失或校验失败，请重新安装 CodexBoard 后重试。",
  changed: "Skill 内容已发生变化，请刷新状态并重新确认。未覆盖现有文件。",
  permission: "无法读写 Skill 或安装记录，请检查目录权限后重试。",
  commit: "无法完成 Skill 安装，原有目录未被替换。请刷新状态后重试。",
  modified: "现有 Skill 不属于本次已验证安装，或文件已被修改。使用随包版本会替换整个目录。",
  installed: "Skill 文件已安装。请在 Codex 技能列表确认，必要时强制重新加载技能。",
};

class SkillError extends Error {
  constructor(code, message = messages[code]) {
    super(message);
    this.code = code;
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const encoded = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const identity = (stat) => ({ dev: String(stat.dev), ino: String(stat.ino) });
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;

function statOrNull(path) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Check every existing ancestor without resolving links. A missing path is safe
// to create only after a second check immediately before the explicit install.
function assertPlainPath(path, allowMissing = false) {
  if (!isAbsolute(path) || resolve(path) !== path) throw new SkillError("managed");
  let current = parse(path).root;
  const parts = path.slice(current.length).split(sep).filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    const stat = statOrNull(current);
    if (!stat) {
      if (allowMissing) return;
      throw new SkillError("permission");
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SkillError("managed");
  }
}

function readRegular(path, limit = MAX_TREE_BYTES) {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
    throw new SkillError("managed");
  if (before.size > limit) throw new SkillError("managed");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!sameIdentity(identity(before), identity(opened)) || !opened.isFile())
      throw new SkillError("changed");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (bytes.length > limit || before.size !== after.size || before.mtimeNs !== after.mtimeNs)
      throw new SkillError("changed");
    return { bytes, mode: Number(after.mode) & 0o777, identity: identity(after) };
  } finally {
    closeSync(fd);
  }
}

function scanTree(root) {
  assertPlainPath(dirname(root), true);
  const stat = statOrNull(root);
  if (!stat) return { exists: false, fingerprint: sha256("missing"), files: [], identity: null };
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SkillError("managed");
  const records = [];
  let size = 0;
  function visit(directory) {
    assertPlainPath(directory);
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      const metadata = lstatSync(path, { bigint: true });
      const local = relative(root, path).split(sep).join("/");
      if (entry === ".git" || metadata.isSymbolicLink()) throw new SkillError("managed");
      if (records.length >= 2000) throw new SkillError("managed");
      if (metadata.isDirectory()) {
        records.push({ path: local, type: "directory", mode: Number(metadata.mode) & 0o777 });
        visit(path);
      } else {
        const file = readRegular(path, MAX_TREE_BYTES - size);
        size += file.bytes.length;
        records.push({ path: local, type: "file", mode: file.mode, sha256: sha256(file.bytes) });
      }
    }
  }
  visit(root);
  const id = identity(stat);
  if (!sameIdentity(id, identity(lstatSync(root, { bigint: true }))))
    throw new SkillError("changed");
  return {
    exists: true,
    root,
    identity: id,
    files: records,
    mode: Number(stat.mode) & 0o777,
    fingerprint: sha256(
      encoded({ identity: id, mode: Number(stat.mode) & 0o777, entries: records }),
    ),
  };
}

function validateFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > 256) throw new SkillError("bundle");
  const seen = new Set();
  return files
    .map((file) => {
      if (
        !file ||
        typeof file.path !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/.test(file.path) ||
        file.path.split("/").some((part) => part === "." || part === "..") ||
        seen.has(file.path) ||
        !/^[a-f0-9]{64}$/.test(file.sha256) ||
        ![0o644, 0o755].includes(file.mode)
      )
        throw new SkillError("bundle");
      seen.add(file.path);
      return { path: file.path, sha256: file.sha256, mode: file.mode };
    })
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
}

function versionParts(version) {
  if (
    typeof version !== "string" ||
    version.length > 64 ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
  )
    throw new SkillError("bundle");
  const parts = version.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new SkillError("bundle");
  return parts;
}

function compareVersions(a, b) {
  const aa = versionParts(a);
  const bb = versionParts(b);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
}

function expectedDirectories(files) {
  const directories = new Set();
  for (const { path } of files) {
    let parent = dirname(path);
    while (parent !== ".") {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  return directories;
}

function matchesFiles(tree, files, withReceipt = false) {
  const directories = expectedDirectories(files);
  const actual = tree.files.filter((file) => file.type === "file" && file.path !== RECEIPT);
  if (actual.length !== files.length) return false;
  if (tree.files.some((file) => file.type === "directory" && !directories.has(file.path)))
    return false;
  if (!withReceipt && tree.files.some((file) => file.path === RECEIPT)) return false;
  if (process.platform === "win32" && withReceipt) {
    try {
      assertPrivateDirectorySync(tree.root);
      for (const entry of tree.files) {
        if (entry.type === "directory") assertPrivateDirectorySync(join(tree.root, entry.path));
        else assertPrivateFileSync(join(tree.root, entry.path));
      }
    } catch {
      return false;
    }
  }
  if (
    process.platform !== "win32" &&
    withReceipt &&
    (tree.mode !== 0o700 ||
      tree.files.some((file) => file.type === "directory" && file.mode !== 0o700) ||
      !tree.files.some(
        (file) => file.path === RECEIPT && file.type === "file" && file.mode === 0o644,
      ))
  )
    return false;
  return files.every((file) =>
    actual.some(
      (entry) =>
        entry.path === file.path &&
        entry.sha256 === file.sha256 &&
        (process.platform === "win32" || entry.mode === file.mode),
    ),
  );
}

function safeMessage(error) {
  return error instanceof SkillError ? error.message : messages.permission;
}

export function createSkillManager({
  runtimeRoot,
  appData,
  home,
  codexHome,
  commitDirectories,
  rollbackNewInstall,
  beforeCommit,
  beforeStateCommit,
}) {
  const targetPath = join(home, ".agents/skills", NAME);
  const parent = dirname(targetPath);
  const statePath = join(appData, "skill-install-state.json");
  const source = join(runtimeRoot, "skills", NAME);
  let queue = Promise.resolve();
  const serial = (work) => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };

  function readState() {
    assertPlainPath(appData, true);
    const stat = statOrNull(statePath);
    if (!stat) return { schemaVersion: 1, offerDismissed: false };
    const bytes = readRegular(statePath, 256 * 1024).bytes;
    try {
      const state = JSON.parse(bytes);
      if (state.schemaVersion !== 1 || typeof state.offerDismissed !== "boolean") return null;
      return state;
    } catch {
      return null;
    }
  }

  function bundle() {
    try {
      assertPlainPath(join(runtimeRoot, "skills"));
      const manifest = JSON.parse(
        readRegular(join(runtimeRoot, "skills/manifest.json"), 256 * 1024).bytes,
      );
      if (manifest.schemaVersion !== 1 || manifest.name !== NAME) throw new SkillError("bundle");
      versionParts(manifest.version);
      const files = validateFiles(manifest.files);
      if (!files.some((file) => file.path === "SKILL.md")) throw new SkillError("bundle");
      const tree = scanTree(source);
      if (!tree.exists || !matchesFiles(tree, files)) throw new SkillError("bundle");
      return {
        version: manifest.version,
        files,
        revision: sha256(encoded(files)),
        fingerprint: tree.fingerprint,
      };
    } catch {
      throw new SkillError("bundle");
    }
  }

  function legacyConflict() {
    const roots = new Set([join(home, ".codex")]);
    if (typeof codexHome === "string" && isAbsolute(codexHome)) roots.add(resolve(codexHome));
    return (
      LEGACY_NAMES.some((name) => statOrNull(join(home, ".agents/skills", name)) !== null) ||
      [...roots].some((root) =>
        [NAME, ...LEGACY_NAMES].some((name) => statOrNull(join(root, "skills", name)) !== null),
      )
    );
  }

  function inspect() {
    const result = {
      bundledVersion: null,
      bundledRevision: null,
      updateAvailable: false,
      offerDismissed: false,
      status: "unavailable",
      installedVersion: null,
      targetPath,
      fingerprint: null,
      message: null,
      canInstall: false,
      canReplace: false,
    };
    try {
      const bundled = bundle();
      result.bundledVersion = bundled.version;
      result.bundledRevision = bundled.revision;
      const stored = readState();
      result.offerDismissed = stored?.offerDismissed === true;
      if (legacyConflict()) throw new SkillError("managed", messages.legacy);
      assertPlainPath(home);
      assertPlainPath(parent, true);
      for (const directory of [home, join(home, ".agents"), parent])
        if (statOrNull(join(directory, ".git"))) throw new SkillError("managed");
      const tree = scanTree(targetPath);
      result.fingerprint = tree.fingerprint;
      if (!tree.exists)
        return {
          ...result,
          status: "notInstalled",
          canInstall: true,
          message: "可为 Codex 安装随包 Skill。",
        };
      result.status = "modified";
      result.canReplace = process.platform !== "win32";
      result.message =
        process.platform === "win32"
          ? "Windows 测试版暂不支持原子替换已有 Skill；现有目录已保留，请在原安装工具中处理。"
          : messages.modified;
      try {
        const raw = readRegular(join(targetPath, RECEIPT), 256 * 1024).bytes;
        const receipt = JSON.parse(raw);
        const files = validateFiles(receipt.files);
        versionParts(receipt.version);
        if (
          receipt.schemaVersion !== 1 ||
          receipt.owner !== OWNER ||
          receipt.name !== NAME ||
          stored?.installed?.receiptSha256 !== sha256(raw) ||
          stored.installed.version !== receipt.version ||
          JSON.stringify(stored.installed.files) !== JSON.stringify(files)
        )
          return result;
        result.installedVersion = receipt.version;
        const comparison = compareVersions(bundled.version, receipt.version);
        result.updateAvailable =
          comparison > 0 ||
          (comparison === 0 && JSON.stringify(files) !== JSON.stringify(bundled.files));
        // The receipt establishes the installed release independently of the
        // current files. A new bundle must not erase a user's local edits, and
        // unchanged installed files must not become "modified" merely because
        // the same release number was bundled with revised contents.
        if (!matchesFiles(tree, files, true)) return result;
        return {
          ...result,
          status: result.updateAvailable ? "updateAvailable" : "current",
          canInstall: result.updateAvailable && process.platform !== "win32",
          canReplace: false,
          message: result.updateAvailable
            ? process.platform === "win32"
              ? "随包 Skill 有更新，Windows 测试版暂不支持原子替换；现有目录已保留。"
              : "随包 Skill 有更新；点击更新后才会替换文件。"
            : messages.installed,
        };
      } catch {
        return result;
      }
    } catch (error) {
      return {
        ...result,
        status:
          error.code === "managed" ? "managed" : error.code === "bundle" ? "unavailable" : "error",
        message: safeMessage(error),
      };
    }
  }

  function ensureDirectory(path) {
    assertPlainPath(path, true);
    if (!statOrNull(path)) {
      ensureDirectory(dirname(path));
      mkdirSync(path, { mode: 0o700 });
      if (process.platform === "win32") ensurePrivateDirectorySync(path);
    }
    assertPlainPath(path);
  }

  function writeNewFile(path, bytes, mode) {
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    try {
      if (process.platform === "win32") ensurePrivateFileSync(path);
      writeFileSync(fd, bytes);
      if (process.platform !== "win32") fchmodSync(fd, mode);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  function stageState(state) {
    ensureDirectory(appData);
    if (statOrNull(statePath)) readRegular(statePath, 256 * 1024);
    const temporary = join(appData, `.skill-install-state.${randomUUID()}.tmp`);
    writeNewFile(temporary, encoded(state), 0o600);
    return temporary;
  }

  async function install(options = {}) {
    let stage;
    let stageIdentity;
    let stateTemporary;
    let stateTemporaryIdentity;
    let exchanged = false;
    let commitAttempted = false;
    let previousTree;
    let committedIdentity;
    try {
      const initial = inspect();
      if (["managed", "unavailable", "error"].includes(initial.status))
        throw new SkillError("managed", initial.message);
      if (initial.status === "current") return initial;
      if (process.platform === "win32" && initial.status !== "notInstalled")
        throw new SkillError("commit", initial.message);
      if (initial.status === "modified" && options.replaceModified !== true)
        throw new SkillError("modified");
      const expected = options.expectedFingerprint ?? undefined;
      if (
        (initial.status !== "notInstalled" && expected !== initial.fingerprint) ||
        (expected !== undefined && expected !== initial.fingerprint)
      )
        throw new SkillError("changed");
      if (typeof commitDirectories !== "function") throw new SkillError("commit");
      const bundled = bundle();
      const stored = readState() ?? { schemaVersion: 1, offerDismissed: false };
      previousTree = scanTree(targetPath);
      ensureDirectory(parent);
      stage = join(parent, `${STAGE_PREFIX}${randomUUID()}`);
      mkdirSync(stage, { mode: 0o700 });
      if (process.platform === "win32") ensurePrivateDirectorySync(stage);
      stageIdentity = identity(lstatSync(stage, { bigint: true }));
      for (const file of bundled.files) {
        const destination = join(stage, file.path);
        ensureDirectory(dirname(destination));
        assertPlainPath(dirname(join(source, file.path)));
        const data = readRegular(join(source, file.path));
        if (
          sha256(data.bytes) !== file.sha256 ||
          (process.platform !== "win32" && data.mode !== file.mode)
        )
          throw new SkillError("bundle");
        writeNewFile(destination, data.bytes, file.mode);
      }
      const receipt = {
        schemaVersion: 1,
        owner: OWNER,
        name: NAME,
        version: bundled.version,
        files: bundled.files,
      };
      const receiptBytes = encoded(receipt);
      writeNewFile(join(stage, RECEIPT), receiptBytes, 0o644);
      const stagedTree = scanTree(stage);
      if (!matchesFiles(stagedTree, bundled.files, true)) throw new SkillError("bundle");
      stateTemporary = stageState({
        schemaVersion: 1,
        offerDismissed: stored.offerDismissed === true,
        installed: {
          version: bundled.version,
          files: bundled.files,
          receiptSha256: sha256(receiptBytes),
        },
      });
      stateTemporaryIdentity = identity(lstatSync(stateTemporary, { bigint: true }));
      await beforeCommit?.();
      const current = inspect();
      if (current.fingerprint !== initial.fingerprint || current.status !== initial.status)
        throw new SkillError("changed");
      if (bundle().fingerprint !== bundled.fingerprint) throw new SkillError("bundle");
      if (scanTree(stage).fingerprint !== stagedTree.fingerprint) throw new SkillError("changed");
      assertPlainPath(parent);
      commitAttempted = true;
      await commitDirectories({
        home,
        stagingName: stage.slice(parent.length + 1),
        expectedTarget: previousTree.identity,
      });
      exchanged = true;
      committedIdentity = stageIdentity;
      if (!sameIdentity(identity(lstatSync(targetPath, { bigint: true })), committedIdentity))
        throw new SkillError("changed");
      await beforeStateCommit?.();
      assertPlainPath(appData);
      if (statOrNull(statePath)) readRegular(statePath, 256 * 1024);
      renameSync(stateTemporary, statePath);
      stateTemporary = null;
      exchanged = false;
      if (previousTree.exists) {
        assertPlainPath(parent);
        if (!sameIdentity(identity(lstatSync(stage, { bigint: true })), previousTree.identity))
          throw new SkillError("changed");
        rmSync(stage, { recursive: true });
      }
      stage = null;
      return inspect();
    } catch (error) {
      let failure = error;
      if (commitAttempted && !exchanged) {
        // A lost helper acknowledgement does not prove rename failed. The
        // sibling may now be the user's original directory: never remove it.
        let currentStage;
        try {
          assertPlainPath(parent);
          currentStage = stage && statOrNull(stage);
        } catch {
          // Inaccessible paths also make the commit result uncertain.
        }
        if (!currentStage || !sameIdentity(identity(currentStage), stageIdentity)) {
          failure = new SkillError(
            "commit",
            previousTree.exists
              ? "无法确认安装提交结果，原有目录的暂存内容已保留。请检查 Skill 父目录中的安装暂存目录后再操作。"
              : "无法确认安装提交结果，请刷新状态并检查 Skill 目录后再操作。",
          );
        }
      }
      if (exchanged) {
        try {
          if (previousTree.exists) {
            await commitDirectories({
              home,
              stagingName: stage.slice(parent.length + 1),
              expectedTarget: committedIdentity,
            });
          } else {
            if (typeof rollbackNewInstall !== "function")
              throw new Error("rollback unavailable", { cause: error });
            await rollbackNewInstall({
              home,
              stagingName: stage.slice(parent.length + 1),
              expectedTarget: committedIdentity,
            });
          }
        } catch {
          // Preserve replacement staging if rollback cannot be proven successful.
          stage = null;
          failure = new SkillError(
            "commit",
            "安装记录写入失败，无法确认替换恢复结果。请检查 Skill 目录后再操作。",
          );
        }
      }
      const current = inspect();
      return { ...current, status: "error", message: safeMessage(failure) };
    } finally {
      try {
        if (stage && statOrNull(stage)) {
          assertPlainPath(parent);
          const currentStage = statOrNull(stage);
          if (currentStage && sameIdentity(identity(currentStage), stageIdentity))
            rmSync(stage, { recursive: true, force: true });
        }
        if (stateTemporary && statOrNull(stateTemporary)) {
          assertPlainPath(appData);
          if (
            sameIdentity(
              identity(lstatSync(stateTemporary, { bigint: true })),
              stateTemporaryIdentity,
            )
          )
            rmSync(stateTemporary, { force: true });
        }
      } catch {
        /* Leave only this operation's staging when safe cleanup is unavailable. */
      }
    }
  }

  return {
    status: inspect,
    install: (options) => serial(() => install(options)),
    dismiss: () =>
      serial(() => {
        let temporary;
        try {
          const state = readState() ?? { schemaVersion: 1 };
          temporary = stageState({ ...state, schemaVersion: 1, offerDismissed: true });
          assertPlainPath(appData);
          if (statOrNull(statePath)) readRegular(statePath, 256 * 1024);
          renameSync(temporary, statePath);
          temporary = null;
          return inspect();
        } catch (error) {
          return { ...inspect(), status: "error", message: safeMessage(error) };
        } finally {
          try {
            if (temporary && statOrNull(temporary)) {
              assertPlainPath(appData);
              rmSync(temporary, { force: true });
            }
          } catch {
            /* This operation's small metadata staging can be cleaned up later. */
          }
        }
      }),
  };
}

async function main() {
  const [action, runtimeRoot, appData, home, executable] = process.argv.slice(2);
  if (
    !["status", "install", "dismiss"].includes(action) ||
    ![runtimeRoot, appData, home, executable].every(
      (path) => typeof path === "string" && isAbsolute(path),
    )
  )
    throw new Error("Invalid native invocation");
  const invokeCommit =
    (rollback) =>
    ({ stagingName, expectedTarget }) => {
      const result = spawnSync(
        executable,
        [
          "--codexboard-skill-commit",
          rollback ? "rollback-new" : "install",
          stagingName,
          expectedTarget?.dev ?? "-",
          expectedTarget?.ino ?? "-",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 },
      );
      if (result.status !== 0) throw new SkillError("commit");
    };
  const manager = createSkillManager({
    runtimeRoot,
    appData,
    home,
    codexHome: process.env.CODEX_HOME,
    commitDirectories: invokeCommit(false),
    rollbackNewInstall: invokeCommit(true),
  });
  let result;
  if (action === "install") {
    const request = JSON.parse(readFileSync(0, "utf8"));
    result = await manager.install({
      expectedFingerprint: request.expectedFingerprint,
      replaceModified: request.replaceModified === true,
    });
  } else result = action === "dismiss" ? await manager.dismiss() : manager.status();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write("Skill operation failed\n");
    process.exitCode = 1;
  });
}
