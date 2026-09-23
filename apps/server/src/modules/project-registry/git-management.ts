import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  CreateGitResourceCommandSchema,
  DeleteGitResourceCommandSchema,
  type CreateGitResourceCommand,
  type DeleteGitResourceCommand,
  type GitEntry,
  type GitCreationOrigin,
  type GitManagementView,
} from "@codexboard/contracts";
import { AppError } from "../../app-error.js";
import type { SqliteDatabase } from "../database/index.js";
import type { WorkspaceCommandRunner } from "../taskboard/task-git-finalizer.js";
import {
  acquireGitManagementLock,
  canonicalWorkspace,
  workspaceResourceKeys,
} from "../taskboard/task-lifecycle-guard.js";
import type { ProjectRegistry } from "./project-registry.js";

import { GitOrigins, originResource, type GitOriginReader } from "./git-origin.js";

const execute = promisify(execFile);
const conflict = (message: string) => new AppError("INVALID_REQUEST", 409, message);
function inside(root: string, path: string) {
  const part = relative(root, path);
  return (
    part === "" ||
    (part !== ".." &&
      !part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(part))
  );
}

export class GitManagement {
  readonly #roots: readonly string[];
  readonly #origins: GitOrigins;
  constructor(
    private readonly database: SqliteDatabase,
    private readonly registry: ProjectRegistry,
    roots: readonly string[],
    private readonly runner?: WorkspaceCommandRunner,
    originReader?: GitOriginReader,
  ) {
    this.#roots = roots.map((root) => realpathSync.native(root));
    this.#origins = new GitOrigins(database, originReader);
  }
  async #run(cwd: string, command: readonly string[]) {
    try {
      if (this.runner) return await this.runner(cwd, command, this.#roots);
      return (
        await execute(command[0]!, command.slice(1), {
          encoding: "utf8",
          timeout: 20_000,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
        })
      ).stdout;
    } catch (cause) {
      throw new AppError(
        "INVALID_REQUEST",
        409,
        "Git 操作失败，请刷新后检查分支、目录状态或宿主机权限",
        { cause },
      );
    }
  }
  #git(cwd: string, ...args: string[]) {
    return this.#run(cwd, ["git", "-C", cwd, ...args]);
  }
  #allowed(path: string) {
    const canonical = realpathSync.native(path);
    if (!this.#roots.some((root) => inside(root, canonical)))
      throw new AppError("FORBIDDEN", 403, "目录超出允许的工作区");
    return canonical;
  }
  async #repository(projectId: string) {
    const context = await this.registry.resolveExecutionContext(projectId);
    const cwd = this.#allowed(context.cwd);
    if (realpathSync.native((await this.#git(cwd, "rev-parse", "--show-toplevel")).trim()) !== cwd)
      throw conflict("项目目录必须是 Git 工作树根目录");
    const common = this.#allowed(
      resolve(cwd, (await this.#git(cwd, "rev-parse", "--git-common-dir")).trim()),
    );
    return { cwd, common };
  }
  async read(projectId: string): Promise<GitManagementView> {
    const { cwd } = await this.#repository(projectId);
    return this.#read(cwd, projectId);
  }
  async #read(cwd: string, projectId: string): Promise<GitManagementView> {
    const records = (await this.#git(cwd, "worktree", "list", "--porcelain", "-z"))
      .split("\0\0")
      .filter(Boolean)
      .map((record) => {
        const fields = record.split("\0");
        const value = (key: string) =>
          fields.find((field) => field.startsWith(`${key} `))?.slice(key.length + 1);
        return {
          path: resolve(value("worktree")!),
          branch: value("branch")?.replace(/^refs\/heads\//, "") ?? null,
          headSha: value("HEAD") ?? "",
          locked: fields.some((field) => field === "locked" || field.startsWith("locked ")),
          prunable: fields.some((field) => field === "prunable" || field.startsWith("prunable ")),
        };
      });
    if (!records[0]?.path) throw conflict("无法识别主工作树");
    const mainPath = this.#allowed(records[0].path);
    const branches = (
      await this.#git(
        cwd,
        "for-each-ref",
        "--format=%(refname:strip=2)%00%(objectname)",
        "refs/heads/",
      )
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [branch, headSha] = line.split("\0");
        return { branch: branch!, headSha: headSha! };
      });
    const defaultBranch =
      ["main", "master", "trunk", records[0].branch].find(
        (name) => name && branches.some((b) => b.branch === name),
      ) ?? null;
    const defaultHead = branches.find((branch) => branch.branch === defaultBranch)?.headSha;
    const remoteDefault = (
      await this.#git(cwd, "for-each-ref", "--format=%(symref)", "refs/remotes/origin/HEAD")
    )
      .trim()
      .replace(/^refs\/remotes\/origin\//, "");
    const currentBranch =
      records.find((record) => canonicalWorkspace(record.path) === cwd)?.branch ?? null;
    const resources = [
      ...records,
      ...branches
        .filter((branch) => !records.some((record) => record.branch === branch.branch))
        .map((branch) => ({ ...branch, path: null, locked: false, prunable: false })),
    ];
    const entries: GitEntry[] = [];
    for (const resource of resources) {
      const isMain = resource.path !== null && canonicalWorkspace(resource.path) === mainPath;
      const taskCount = this.#taskCount(projectId, resource.branch, resource.path);
      let dirty: boolean | null = null;
      let reason: string | null = null;
      if (
        isMain ||
        (resource.branch &&
          ["main", "master", "trunk", defaultBranch, records[0].branch, remoteDefault].includes(
            resource.branch,
          ))
      )
        reason = "主工作树或主分支受保护";
      else if (resource.path && canonicalWorkspace(resource.path) === cwd)
        reason = "项目登记目录受保护";
      else if (resource.locked) reason = "工作树已锁定";
      else if (resource.prunable) reason = "工作树目录已失效，请先在 Git 中处理";
      else if (taskCount > 0) reason = `有 ${taskCount} 个任务仍关联此分支或工作树`;
      if (resource.path) {
        try {
          const path = this.#allowed(resource.path);
          if (relative(path, resource.path) !== "") throw conflict("工作树路径包含符号链接");
          dirty = Boolean(
            (await this.#git(path, "status", "--porcelain", "--untracked-files=all")).trim(),
          );
          if (dirty) reason ??= "工作树存在未提交的改动或未跟踪文件";
        } catch {
          reason ??= "工作树目录不可访问或超出允许范围";
        }
      }
      if (!reason) {
        if (
          !defaultHead ||
          !resource.headSha ||
          Number(
            (
              await this.#git(
                cwd,
                "rev-list",
                "--count",
                resource.headSha,
                "--not",
                defaultHead,
                "--",
              )
            ).trim(),
          ) !== 0
        )
          reason = `尚未合并到主分支${defaultBranch ? ` ${defaultBranch}` : ""}`;
      }
      entries.push({
        branch: resource.branch,
        headSha: resource.headSha,
        path: resource.path,
        isMain,
        isCurrent: resource.path !== null && canonicalWorkspace(resource.path) === cwd,
        dirty,
        locked: resource.locked,
        taskCount,
        deleteReason: reason,
      });
    }
    const originResources = await Promise.all(
      entries.map(async (entry) => ({
        branch: entry.branch
          ? await originResource(this.#git.bind(this), mainPath, "branch", entry.branch, null)
          : null,
        worktree:
          entry.path && !entry.isMain && entry.dirty !== null
            ? await originResource(
                this.#git.bind(this),
                mainPath,
                "worktree",
                entry.branch,
                entry.path,
              )
            : null,
      })),
    );
    const origins = await this.#origins.read(
      projectId,
      mainPath,
      originResources.flatMap((r) => [r.branch, r.worktree].filter((value) => value !== null)),
    );
    entries.forEach((entry, i) => {
      const resource = originResources[i]!;
      entry.branchOrigin = (resource.branch && origins[resource.branch.key]) || { kind: "unknown" };
      entry.worktreeOrigin = (resource.worktree && origins[resource.worktree.key]) || {
        kind: "unknown",
      };
    });
    return { mainPath, currentBranch, defaultBranch, entries };
  }
  async create(
    projectId: string,
    input: CreateGitResourceCommand,
    principalKey?: string,
    origin: GitCreationOrigin = { kind: "unknown" },
  ): Promise<void> {
    const command = CreateGitResourceCommandSchema.parse(input);
    const repo = await this.#repository(projectId);
    const release = acquireGitManagementLock(this.database, repo.cwd);
    try {
      const view = await this.#read(repo.cwd, projectId);
      await this.#git(repo.cwd, "check-ref-format", `refs/heads/${command.branch}`);
      const exists = view.entries.some((entry) => entry.branch === command.branch);
      const existingBranch = command.kind === "worktree" && command.existingBranch;
      if (existingBranch ? !exists : exists)
        throw conflict(existingBranch ? "所选分支已不存在，请刷新" : "分支已存在");
      if (
        existingBranch &&
        view.entries.some((entry) => entry.branch === command.branch && entry.path)
      )
        throw conflict("该分支已被其他工作树使用");
      const base = view.entries.find((entry) => entry.branch === command.baseBranch);
      if (!existingBranch && !base) throw conflict("请选择有效的起始分支");
      // Resolve the base to an immutable SHA so ref syntax cannot alter command semantics.
      if (command.kind === "branch")
        await this.#git(repo.cwd, "branch", "--", command.branch, base!.headSha);
      else {
        const parent = join(view.mainPath, ".worktrees");
        let parentExists = false;
        try {
          const stat = lstatSync(parent);
          parentExists = true;
          if (stat.isSymbolicLink() || !stat.isDirectory())
            throw conflict(".worktrees 不能是符号链接或文件");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const path = join(parent, command.directoryName);
        try {
          lstatSync(path);
          throw conflict("目标目录已存在，请使用其他名称");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        try {
          await this.#git(
            view.mainPath,
            "check-ignore",
            "--quiet",
            "--",
            `.worktrees/${command.directoryName}/`,
          );
        } catch {
          throw conflict("请先在仓库 .gitignore 中添加 .worktrees/，再创建工作树");
        }
        if (!parentExists)
          await this.#run(
            view.mainPath,
            process.platform === "win32"
              ? [process.execPath, "-e", "require('node:fs').mkdirSync(process.argv[1])", parent]
              : ["/bin/mkdir", "--", parent],
          );
        if (this.#allowed(parent) !== parent) throw conflict(".worktrees 路径包含符号链接");
        await this.#git(
          view.mainPath,
          "worktree",
          "add",
          ...(existingBranch ? [] : ["-b", command.branch]),
          "--",
          path,
          existingBranch ? command.branch : base!.headSha,
        );
      }
      this.#audit(projectId, principalKey, "git.create", command);
      const created = [
        !existingBranch
          ? await originResource(
              this.#git.bind(this),
              view.mainPath,
              "branch",
              command.branch,
              null,
            )
          : null,
        command.kind === "worktree"
          ? await originResource(
              this.#git.bind(this),
              view.mainPath,
              "worktree",
              command.branch,
              join(view.mainPath, ".worktrees", command.directoryName),
            )
          : null,
      ];
      for (const resource of created)
        if (resource) this.#origins.record(projectId, resource, origin);
      await this.registry.scanDevelopmentContexts(projectId);
    } finally {
      release();
    }
  }
  async remove(
    projectId: string,
    input: DeleteGitResourceCommand,
    principalKey?: string,
  ): Promise<void> {
    const command = DeleteGitResourceCommandSchema.parse(input);
    const repo = await this.#repository(projectId);
    const release = acquireGitManagementLock(this.database, repo.cwd);
    try {
      let view = await this.#read(repo.cwd, projectId);
      const entry = view.entries.find(
        (candidate) => candidate.branch === command.branch && candidate.path === command.path,
      );
      if (!entry || entry.headSha !== command.expectedHead)
        throw conflict("分支或工作树已变化，请刷新后重试");
      if (entry.deleteReason) throw conflict(entry.deleteReason);
      this.#assertIdle(repo.common);
      if (command.path) {
        this.#allowed(command.path);
        // Recheck after asynchronous inspection, before the destructive Git command.
        if (this.#taskCount(projectId, command.branch, command.path))
          throw conflict("仍有任务使用此工作树");
        if ((await this.#git(command.path, "rev-parse", "HEAD")).trim() !== command.expectedHead)
          throw conflict("工作树提交已变化");
        if (
          (await this.#git(command.path, "status", "--porcelain", "--untracked-files=all")).trim()
        )
          throw conflict("工作树存在未提交的改动或未跟踪文件");
        await this.#git(view.mainPath, "worktree", "remove", "--", command.path);
      }
      if (command.branch) {
        view = await this.#read(view.mainPath, projectId);
        const remaining = view.entries.find((candidate) => candidate.branch === command.branch);
        if (
          !remaining ||
          remaining.path ||
          remaining.headSha !== command.expectedHead ||
          remaining.deleteReason
        )
          throw conflict("工作树已移除，但分支状态发生变化，请刷新后检查");
        // -d retains Git's checked-out branch protection; never force-delete a branch.
        await this.#git(view.mainPath, "branch", "-d", "--", command.branch);
      }
      this.#audit(projectId, principalKey, "git.delete", command);
    } finally {
      try {
        await this.registry.scanDevelopmentContexts(projectId);
      } finally {
        release();
      }
    }
  }
  #taskCount(projectId: string, branch: string | null, path: string | null) {
    const rows = this.database
      .prepare(
        `SELECT DISTINCT tasks.id, tasks.project_id AS projectId,
      COALESCE(json_extract(tasks.development_context_json, '$.branch'), contexts.branch) AS branch,
      threads.cwd, contexts.worktree_realpath AS contextPath, projects.workspace_realpath AS projectPath,
      tasks.development_context_json AS developmentContext
      FROM tasks JOIN projects ON projects.id = tasks.project_id
      LEFT JOIN task_threads threads ON threads.task_id = tasks.id
      LEFT JOIN project_development_contexts contexts ON contexts.id = json_extract(tasks.development_context_json, '$.id')
      WHERE tasks.status NOT IN ('done', 'canceled')`,
      )
      .all() as {
      id: string;
      projectId: string;
      branch: string | null;
      cwd: string | null;
      contextPath: string | null;
      projectPath: string | null;
      developmentContext: string | null;
    }[];
    return new Set(
      rows
        .filter(
          (row) =>
            (branch !== null && row.projectId === projectId && row.branch === branch) ||
            (path !== null &&
              [
                row.cwd,
                row.contextPath,
                ...(!row.developmentContext ? [row.projectPath] : []),
              ].some((value) => value && canonicalWorkspace(value) === path)),
        )
        .map((row) => row.id),
    ).size;
  }
  #assertIdle(common: string) {
    const jobs = this.database
      .prepare(
        "SELECT work_context_json AS context FROM jobs WHERE status IN ('queued', 'running', 'waiting_approval', 'waiting_input', 'canceling')",
      )
      .all() as { context: string | null }[];
    for (const job of jobs) {
      const context = job.context ? (JSON.parse(job.context) as { cwd?: string }) : null;
      if (context?.cwd && workspaceResourceKeys(context.cwd).includes(`repo:${common}`))
        throw conflict("该仓库仍有活动执行，请稍后重试");
    }
  }
  #audit(projectId: string, principalKey: string | undefined, action: string, command: object) {
    this.database
      .prepare(
        "INSERT INTO audit_events (id, identity_key, action, resource_type, resource_id, outcome, safe_metadata_json) VALUES (?, ?, ?, 'project', ?, 'allowed', ?)",
      )
      .run(randomUUID(), principalKey ?? null, action, projectId, JSON.stringify(command));
  }
}
