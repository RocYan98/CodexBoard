import { execFile } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { AppError } from "../../app-error.js";

const execute = promisify(execFile);
export type WorkspaceCommandRunner = (
  cwd: string,
  command: readonly string[],
  writableRoots: readonly string[],
) => Promise<string>;
export class WorkspaceNotGitError extends Error {}

export interface TaskGitSnapshot {
  readonly cwd: string;
  readonly mainCwd: string;
  readonly commonDirectory: string;
  readonly branch: string | null;
  readonly mainTask: boolean;
  readonly commitSha: string | null;
  readonly archiveRef: string | null;
  readonly notes: readonly string[];
}

/** Task finalization only observes Git state. It never commits, removes files, or writes refs. */
export class TaskGitFinalizer {
  readonly #allowedRoots: readonly string[];
  constructor(
    allowedRoots: readonly string[],
    private readonly runner?: WorkspaceCommandRunner,
  ) {
    this.#allowedRoots = allowedRoots.map((root) => realpathSync.native(root));
  }

  async inspect(
    directory: string,
    _taskId: string,
    _operationId?: string,
    projectDirectory?: string | null,
    taskBranch?: string | null,
  ): Promise<TaskGitSnapshot | null> {
    const cwd = this.#allowed(directory);
    const present = existsSync(directory);
    if (!present && !projectDirectory)
      throw new AppError("INVALID_REQUEST", 409, "工作树已不存在，无法定位所属 Git 仓库");
    let anchor = present ? cwd : this.#allowed(projectDirectory!);
    let existingWorktree = present;
    let root: string;
    try {
      root = (await this.#git(anchor, "rev-parse", "--show-toplevel")).trim();
    } catch (error) {
      if (!(error instanceof WorkspaceNotGitError) || !present) throw error;
      if (!projectDirectory || this.#allowed(projectDirectory) === cwd) return null;
      // A removed worktree may leave an ordinary directory containing temporary files.
      // Inspect its owning repository so verification still rejects that residue.
      anchor = this.#allowed(projectDirectory);
      try {
        root = (await this.#git(anchor, "rev-parse", "--show-toplevel")).trim();
      } catch (projectError) {
        if (projectError instanceof WorkspaceNotGitError) return null;
        throw projectError;
      }
      existingWorktree = false;
    }
    if (existingWorktree && realpathSync.native(root) !== cwd)
      throw new AppError("INVALID_REQUEST", 409, "完成检查目录必须是 Git 工作树根目录");
    const fields = (await this.#git(anchor, "worktree", "list", "--porcelain", "-z")).split("\0");
    const mainPath = fields.find((field) => field.startsWith("worktree "))?.slice(9);
    if (!mainPath) throw new AppError("INVALID_REQUEST", 409, "无法确认主工作树");
    const mainCwd = this.#allowed(mainPath);
    const commonDirectory = realpathSync.native(
      resolve(mainCwd, (await this.#git(mainCwd, "rev-parse", "--git-common-dir")).trim()),
    );
    const branch =
      taskBranch ??
      (existingWorktree ? (await this.#git(cwd, "branch", "--show-current")).trim() || null : null);
    const mainTask = cwd === mainCwd && (!branch || ["main", "master", "trunk"].includes(branch));
    return {
      cwd,
      mainCwd,
      commonDirectory,
      branch,
      mainTask,
      commitSha: null,
      archiveRef: null,
      notes: [],
    };
  }

  async verify(snapshot: TaskGitSnapshot, cancellationTaskId?: string): Promise<TaskGitSnapshot> {
    const { cwd, mainCwd, branch, mainTask } = snapshot;
    if (this.#allowed(mainCwd) !== mainCwd || this.#allowed(cwd) !== cwd)
      throw new AppError("VERSION_CONFLICT", 409, "工作树路径已变化");
    const common = realpathSync.native(
      resolve(mainCwd, (await this.#git(mainCwd, "rev-parse", "--git-common-dir")).trim()),
    );
    if (common !== snapshot.commonDirectory)
      throw new AppError("VERSION_CONFLICT", 409, "Git 仓库已变化");
    if (cancellationTaskId) {
      for (const directory of new Set([cwd, mainCwd])) {
        const temporary = resolve(directory, ".tmp", "taskboard", cancellationTaskId);
        if (lstatSync(temporary, { throwIfNoEntry: false }))
          throw new AppError("INVALID_REQUEST", 409, `任务临时目录尚未删除：${temporary}`);
      }
    }
    const status = await this.#git(mainCwd, "status", "--porcelain", "--untracked-files=all");
    if (status.trim())
      throw new AppError(
        "INVALID_REQUEST",
        409,
        `主工作区 Git 不干净，存在未提交或未跟踪文件：${status.trim().split("\n").slice(0, 10).join("；")}`,
      );
    if (!mainTask) {
      const fields = (await this.#git(mainCwd, "worktree", "list", "--porcelain", "-z")).split(
        "\0",
      );
      if (
        cwd !== mainCwd &&
        (existsSync(cwd) ||
          fields.some(
            (field) =>
              field.startsWith("worktree ") && canonicalGitDirectory(field.slice(9)) === cwd,
          ))
      )
        throw new AppError("INVALID_REQUEST", 409, `工作树尚未删除或仍登记在 Git 中：${cwd}`);
      if (!branch)
        throw new AppError("INVALID_REQUEST", 409, "无法确认任务使用的分支，请核对任务开发上下文");
      await this.#git(mainCwd, "check-ref-format", `refs/heads/${branch}`);
      const refs = (
        await this.#git(mainCwd, "for-each-ref", "--format=%(refname)", `refs/heads/${branch}`)
      ).split("\n");
      if (refs.includes(`refs/heads/${branch}`) || fields.includes(`branch refs/heads/${branch}`))
        throw new AppError("INVALID_REQUEST", 409, `任务分支尚未删除：${branch}`);
    }
    return {
      ...snapshot,
      notes: [
        mainTask ? "主工作区 Git 干净，检查通过" : "主工作区 Git 干净，任务分支与工作树均已删除",
      ],
    };
  }

  #allowed(directory: string): string {
    if (!isAbsolute(directory)) throw new AppError("FORBIDDEN", 403, "工作区必须使用绝对路径");
    const canonical = canonicalGitDirectory(directory);
    if (
      !this.#allowedRoots.some((root) => {
        const suffix = relative(root, canonical);
        return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
      })
    )
      throw new AppError("FORBIDDEN", 403, "完成检查目录超出允许的工作区");
    return canonical;
  }

  async #git(cwd: string, ...args: string[]): Promise<string> {
    try {
      // Disable optional index refresh writes, including for git status.
      if (this.runner)
        return await this.runner(cwd, ["git", "--no-optional-locks", "-C", cwd, ...args], []);
      return (
        await execute("git", ["--no-optional-locks", "-C", cwd, ...args], {
          encoding: "utf8",
          env: { ...process.env, LC_ALL: "C" },
          timeout: 60_000,
          maxBuffer: 4 * 1024 * 1024,
        })
      ).stdout;
    } catch (cause) {
      if (
        args[0] === "rev-parse" &&
        cause &&
        typeof cause === "object" &&
        "stderr" in cause &&
        String(cause.stderr).includes("not a git repository")
      )
        throw new WorkspaceNotGitError();
      throw new AppError("UPSTREAM_ERROR", 502, `Git 检查失败：${args[0]}`, { cause });
    }
  }
}

export function canonicalGitDirectory(directory: string): string {
  let parent = resolve(directory);
  while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
  return resolve(realpathSync.native(parent), relative(parent, resolve(directory)));
}
