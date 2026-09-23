import { remoteTurnDiff } from "@codexboard/contracts";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const MAX_CONTENT = 1024 * 1024;
const MAX_FILES = 10_000;
const scopes = new Set(["unstaged", "staged", "branch", "turn"]);
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const string = (value) => (typeof value === "string" ? value : "");

async function git(cwd, args, optional = false) {
  try {
    const { stdout } = await execute(
      "git",
      [
        "--no-pager",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.quotePath=false",
        "-C",
        cwd,
        ...args,
      ],
      {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      },
    );
    return stdout;
  } catch (error) {
    if (optional && typeof error.code === "number" && !error.killed) return null;
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
      throw new Error("改动内容过大，请缩小审核范围", { cause: error });
    if (error.killed) throw new Error("读取代码改动超时，请重试", { cause: error });
    throw new Error("读取代码改动失败，请刷新后重试", { cause: error });
  }
}
function validPath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length < 4096 &&
    !isAbsolute(path) &&
    !(process.platform === "win32" && path.includes("\\")) &&
    !path.includes("\0") &&
    !path.split("/").some((part) => part === ".." || part === "." || part === ".git")
  );
}
function lineCount(text) {
  return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
}
async function currentContent(root, path) {
  const absolute = join(root, path);
  let info;
  try {
    info = await lstat(absolute);
  } catch {
    return { content: "", binary: false, tooLarge: false, message: "文件已删除或不可读取" };
  }
  const parent = await realpath(dirname(absolute));
  const parentPath = relative(root, parent);
  if (parentPath === ".." || parentPath.startsWith(`..${sep}`) || isAbsolute(parentPath))
    throw new Error("文件不在任务仓库中");
  if (info.isSymbolicLink())
    return {
      content: await readlink(absolute),
      binary: false,
      tooLarge: false,
      message: "符号链接目标",
      mode: "120000",
    };
  if (!info.isFile())
    return { content: "", binary: false, tooLarge: false, message: "此项目不是可预览的普通文件" };
  if (info.size > MAX_CONTENT)
    return {
      content: "",
      binary: false,
      tooLarge: true,
      message: "文件超过 1 MiB，暂不显示完整内容",
    };
  const file = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const actual = await file.stat();
    const checked = await lstat(absolute);
    if (
      !actual.isFile() ||
      actual.size > MAX_CONTENT ||
      actual.ino !== info.ino ||
      actual.dev !== info.dev ||
      checked.isSymbolicLink() ||
      checked.ino !== actual.ino ||
      checked.dev !== actual.dev
    )
      throw new Error("文件已变化，请刷新重试");
    const bytes = Buffer.alloc(actual.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const data = bytes.subarray(0, offset);
    const binary = data.includes(0);
    return {
      content: binary ? "" : data.toString("utf8"),
      binary,
      tooLarge: false,
      message: binary ? "二进制文件，无法显示文本差异" : "",
      mode: actual.mode & 0o111 ? "100755" : "100644",
    };
  } finally {
    await file.close();
  }
}
function newFilePatch(path, value) {
  if (value.tooLarge) return "";
  const a = JSON.stringify(`a/${path}`),
    b = JSON.stringify(`b/${path}`);
  let patch = `diff --git ${a} ${b}\nnew file mode ${value.mode ?? "100644"}\n`;
  if (value.binary) return `${patch}Binary files /dev/null and ${b} differ\n`;
  if (!value.content) return patch;
  const lines = value.content.split("\n");
  if (value.content.endsWith("\n")) lines.pop();
  patch += `--- /dev/null\n+++ ${b}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}\n`).join("")}`;
  if (!value.content.endsWith("\n")) patch += "\\ No newline at end of file\n";
  return patch;
}
function names(output) {
  const tokens = output.split("\0"),
    result = new Map();
  const statuses = {
    A: "added",
    D: "deleted",
    M: "modified",
    T: "modified",
    U: "conflicted",
    R: "renamed",
    C: "copied",
  };
  for (let i = 0; i < tokens.length - 1;) {
    const code = tokens[i++],
      first = tokens[i++];
    const rename = code.startsWith("R") || code.startsWith("C");
    const path = rename ? tokens[i++] : first;
    if (!validPath(path)) continue;
    const previous = result.get(path);
    result.set(path, {
      path,
      previousPath: rename ? first : null,
      status: previous?.status === "conflicted" ? "conflicted" : (statuses[code[0]] ?? "modified"),
      added: 0,
      removed: 0,
      binary: false,
    });
  }
  return result;
}
function counts(output, files) {
  const tokens = output.split("\0");
  for (let i = 0; i < tokens.length - 1;) {
    const entry = tokens[i++],
      a = entry.indexOf("\t"),
      b = entry.indexOf("\t", a + 1);
    if (a < 0 || b < 0) continue;
    let path = entry.slice(b + 1);
    if (!path) {
      i++;
      path = tokens[i++];
    }
    const file = files.get(path);
    if (!file) continue;
    file.binary = entry.slice(0, a) === "-" || entry.slice(a + 1, b) === "-";
    file.added = file.binary ? null : Number(entry.slice(0, a));
    file.removed = file.binary ? null : Number(entry.slice(a + 1, b));
  }
}
function fileMetadata({ path, previousPath, status, added, removed, binary }) {
  return { path, previousPath, status, added, removed, binary };
}
function gitPath(value) {
  const trimmed = value.split("\t")[0];
  if (!trimmed.startsWith('"')) return trimmed;
  try {
    return JSON.parse(trimmed);
  } catch {
    const inner = trimmed.slice(1, -1),
      bytes = [];
    for (let i = 0; i < inner.length;) {
      const octal = /^\\([0-7]{1,3})/.exec(inner.slice(i));
      if (octal) {
        bytes.push(Buffer.from([parseInt(octal[1], 8)]));
        i += octal[0].length;
      } else if (inner[i] === "\\" && i + 1 < inner.length) {
        const next = inner[++i];
        bytes.push(Buffer.from({ n: "\n", r: "\r", t: "\t" }[next] ?? next));
        i++;
      } else {
        const point = String.fromCodePoint(inner.codePointAt(i));
        bytes.push(Buffer.from(point));
        i += point.length;
      }
    }
    return Buffer.concat(bytes).toString("utf8");
  }
}
function turnFiles(snapshot, turnId) {
  const history = object(snapshot.turnHistory);
  const turns =
    history.kind === "canonical"
      ? Object.values(object(object(history.history).entitiesByKey))
      : (snapshot.turns ?? []);
  const latest = turnId
    ? turns.find((turn) => turn.turnId === turnId || turn.id === turnId)
    : [...turns]
        .sort((a, b) => Number(a.turnStartedAtMs ?? 0) - Number(b.turnStartedAtMs ?? 0))
        .at(-1);
  if (turnId && !latest) throw new Error("该回合的改动暂不可用，请刷新对话后重试");
  const files = new Map();
  for (const patch of remoteTurnDiff(latest, string(snapshot.cwd))
    .split(/(?=^diff --git )/m)
    .filter((chunk) => chunk.startsWith("diff --git "))) {
    let path = "",
      previousPath = null,
      status = "modified",
      added = 0,
      removed = 0,
      inHunk = false;
    const binary = /^Binary files |^GIT binary patch/m.test(patch);
    for (const line of patch.split("\n")) {
      if (!inHunk) {
        if (line.startsWith("diff --git ")) {
          const header = /^diff --git ("(?:[^"\\]|\\.)*"|.+) ("(?:[^"\\]|\\.)*"|b\/.+)$/.exec(line);
          if (header) path = gitPath(header[2]).replace(/^b\//, "");
        }
        if (line.startsWith("--- ") && line !== "--- /dev/null" && !path)
          path = gitPath(line.slice(4)).replace(/^a\//, "");
        if (line.startsWith("+++ ") && line !== "+++ /dev/null")
          path = gitPath(line.slice(4)).replace(/^b\//, "");
        if (line.startsWith("new file mode ")) status = "added";
        if (line.startsWith("deleted file mode ") || line === "+++ /dev/null") status = "deleted";
        if (line.startsWith("rename from ")) {
          previousPath = gitPath(line.slice(12));
          status = "renamed";
        }
        if (line.startsWith("rename to ")) path = gitPath(line.slice(10));
      }
      if (line.startsWith("@@ ")) inHunk = true;
      else if (inHunk && line.startsWith("+")) added++;
      else if (inHunk && line.startsWith("-")) removed++;
    }
    if (validPath(path))
      files.set(path, {
        path,
        previousPath,
        status,
        added: binary ? null : added,
        removed: binary ? null : removed,
        binary,
        patch,
      });
  }
  return files;
}
async function branchBase(root, branch, hasHead) {
  if (!hasHead) return { baseRef: null, revision: null };
  const remoteHead = (
    await git(root, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], true)
  )?.trim();
  let baseRef = remoteHead?.replace(/^refs\/remotes\//, "");
  if (!baseRef)
    for (const candidate of ["main", "master"]) {
      if (
        branch !== candidate &&
        (await git(root, ["show-ref", "--verify", `refs/heads/${candidate}`], true)) !== null
      ) {
        baseRef = candidate;
        break;
      }
    }
  baseRef ??= "HEAD";
  const revision = (await git(root, ["merge-base", "HEAD", baseRef], true))?.trim();
  return revision ? { baseRef, revision } : { baseRef: "HEAD", revision: "HEAD" };
}

// The directory comes exclusively from the authorized Desktop thread snapshot.
// Callers may select a scope and a member file, never an arbitrary host directory.
export async function readRemoteReview(
  snapshot,
  { scope = "branch", all = false, path, view = "diff", turnId } = {},
) {
  if (!scopes.has(scope) || !["diff", "file"].includes(view) || (path != null && !validPath(path)))
    throw new Error("审核范围或文件路径无效");
  if (
    turnId != null &&
    (scope !== "turn" || typeof turnId !== "string" || !turnId || turnId.length > 200)
  )
    throw new Error("回合编号无效");
  const cwd = string(snapshot.cwd);
  if (!isAbsolute(cwd)) throw new Error("任务目录不可用");
  const repositoryPath = (await git(cwd, ["rev-parse", "--show-toplevel"], true))?.trim();
  const repository = Boolean(repositoryPath);
  const root = repository ? await realpath(repositoryPath) : cwd;
  const branch = repository
    ? (await git(root, ["symbolic-ref", "--short", "-q", "HEAD"], true))?.trim() || null
    : null;
  const hasHead = repository && (await git(root, ["rev-parse", "--verify", "HEAD"], true)) !== null;
  const base =
    scope === "branch" && repository
      ? await branchBase(root, branch, hasHead)
      : { baseRef: scope === "staged" ? "HEAD" : null, revision: null };
  const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--find-renames"];
  if (scope === "staged") diffArgs.push("--cached");
  if (scope === "branch" && base.revision) diffArgs.push(base.revision);
  let files = scope === "turn" ? turnFiles(snapshot, turnId) : new Map();
  const allPaths = repository
    ? [
        ...new Set(
          (await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]))
            .split("\0")
            .filter(validPath),
        ),
      ]
    : [];
  if (allPaths.length > MAX_FILES) throw new Error("仓库文件超过 10000 个，暂不支持完整移动审核");
  const initialBranch = repository && scope === "branch" && !hasHead;
  if (repository && scope !== "turn" && !initialBranch) {
    const [status, stats] = await Promise.all([
      git(root, [...diffArgs, "--name-status", "-z"]),
      git(root, [...diffArgs, "--numstat", "-z"]),
    ]);
    files = names(status);
    counts(stats, files);
  }
  if (repository && (scope === "unstaged" || scope === "branch")) {
    const additions = initialBranch
      ? allPaths
      : (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]))
          .split("\0")
          .filter(validPath);
    for (const entry of additions) {
      if (files.has(entry)) continue;
      const value = await currentContent(root, entry);
      if (initialBranch && value.message === "文件已删除或不可读取") continue;
      files.set(entry, {
        path: entry,
        previousPath: null,
        status: initialBranch ? "added" : "untracked",
        added: value.binary || value.tooLarge ? null : lineCount(value.content),
        removed: value.binary ? null : 0,
        binary: value.binary,
        newFile: true,
      });
    }
  }
  const changedCount = files.size;
  if (path != null) {
    const item = files.get(path);
    if (!item && !allPaths.includes(path)) throw new Error("文件不在当前审核范围中");
    const file = item ?? {
      path,
      previousPath: null,
      status: "unchanged",
      added: 0,
      removed: 0,
      binary: false,
    };
    const response = {
      file: fileMetadata(file),
      patch: "",
      content: "",
      binary: file.binary,
      tooLarge: false,
      message: "",
      contentLabel: scope === "staged" ? "暂存内容" : "当前内容",
    };
    if (view === "diff" && scope === "turn" && item) response.patch = item.patch;
    else if (view === "diff" && item?.newFile) {
      const value = await currentContent(root, path);
      Object.assign(response, {
        binary: value.binary,
        tooLarge: value.tooLarge,
        message: value.message,
        patch: newFilePatch(path, value),
      });
    } else if (view === "diff" && item && repository) {
      response.patch = await git(root, [
        ...diffArgs,
        "--unified=3",
        "--",
        ...[item.previousPath, path].filter(Boolean),
      ]);
      if (!response.patch) response.message = "文件已变化，请返回并刷新审核列表";
    } else if (repository) {
      if (scope === "staged") {
        const content = await git(root, ["show", `:${path}`], true);
        if (content == null) response.message = "此文件不在暂存区中";
        else {
          response.binary = content.includes("\0");
          response.content = response.binary ? "" : content;
        }
      } else Object.assign(response, await currentContent(root, path));
    }
    if (
      Buffer.byteLength(response.patch) > MAX_CONTENT ||
      Buffer.byteLength(response.content) > MAX_CONTENT
    ) {
      response.patch = "";
      response.content = "";
      response.tooLarge = true;
      response.message = "文件差异超过 1 MiB，暂不显示完整内容";
    }
    if (response.binary && !response.message) response.message = "二进制文件，无法显示文本差异";
    if (view === "file" && !repository) response.message = "此任务目录不支持完整文件预览";
    return response;
  }
  if (all)
    for (const entry of allPaths)
      if (!files.has(entry))
        files.set(entry, {
          path: entry,
          previousPath: null,
          status: "unchanged",
          added: 0,
          removed: 0,
          binary: false,
        });
  return {
    repository,
    branch,
    baseRef: base.baseRef,
    scope,
    changedCount,
    countsComplete: [...files.values()].every((file) => file.added != null && file.removed != null),
    added: [...files.values()].reduce((sum, file) => sum + (file.added ?? 0), 0),
    removed: [...files.values()].reduce((sum, file) => sum + (file.removed ?? 0), 0),
    message: repository
      ? ""
      : scope === "turn"
        ? "任务目录不是 Git 仓库，仅显示本轮记录"
        : "此任务目录不是 Git 仓库",
    files: [...files.values()]
      .sort((a, b) => (scope === "turn" && !all ? 0 : a.path.localeCompare(b.path, "zh-CN")))
      .map(fileMetadata),
  };
}
