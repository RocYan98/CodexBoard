import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, relative, resolve } from "node:path";
import { realpathSync, statSync } from "node:fs";

import {
  ExecutionContextSchema,
  LocalDevelopmentContextViewSchema,
  LocalProjectViewSchema,
  WorkspaceRegistrationResultSchema,
  type ExecutionContext,
  type LocalDevelopmentContextView,
  type RegisterWorkspaceCommand,
  type WorkspaceRegistrationResult,
} from "@codexboard/contracts";
import { z } from "zod";

import { AppError } from "../../app-error.js";
import { withTransaction, type SqliteDatabase } from "../database/index.js";

const execFileAsync = promisify(execFile);

const ProjectWorkspaceRowSchema = z.object({
  id: z.uuid(),
  projectKey: z.string().nullable(),
  name: z.string(),
  description: z.string(),
  kind: z.enum(["legacy", "codex", "system"]),
  rootPathsJson: z.string(),
  workspaceRealpath: z.string().nullable(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
});

const ProjectSourceRowSchema = z.object({
  sourceKind: z.enum(["legacy", "codex", "system"]),
  rootPathsJson: z.string(),
  syncDeletedAt: z.string().datetime().nullable(),
});

const ContextRowSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  kind: z.enum(["branch", "worktree"]),
  label: z.string().min(1),
  branch: z.string().nullable(),
  gitRef: z.string().nullable(),
  headSha: z.string().nullable(),
  worktreeRealpath: z.string().nullable(),
  executable: z.number().int(),
  active: z.number().int(),
  scannedAt: z.string().datetime(),
});

interface RepositoryInspection {
  readonly rootRealpath: string;
  readonly commonDirectoryRealpath: string;
  readonly branch: string | null;
  readonly headSha: string | null;
  readonly dirty: boolean;
}

interface DiscoveredContext {
  readonly contextKey: string;
  readonly kind: "branch" | "worktree";
  readonly label: string;
  readonly branch: string | null;
  readonly gitRef: string | null;
  readonly headSha: string | null;
  readonly worktreeRealpath: string | null;
  readonly executable: boolean;
}

interface GitWorktree {
  readonly path: string;
  readonly branch: string | null;
  readonly gitRef: string | null;
  readonly headSha: string | null;
}

interface GitBranch {
  readonly gitRef: string;
  readonly name: string;
  readonly headSha: string;
}

export class ProjectRegistry {
  readonly #database: SqliteDatabase;
  readonly #allowedRoots: readonly string[];
  readonly #now: () => Date;

  constructor(
    database: SqliteDatabase,
    allowedRoots: readonly string[],
    now: () => Date = () => new Date(),
  ) {
    this.#database = database;
    this.#allowedRoots = allowedRoots.map((root) => this.#configuredRoot(root));
    this.#now = now;
  }

  async registerWorkspace(
    projectId: string,
    command: RegisterWorkspaceCommand,
  ): Promise<WorkspaceRegistrationResult> {
    const project = this.#readProject(projectId);
    if (this.#projectSource(projectId).sourceKind !== "legacy") {
      throw new AppError("INVALID_REQUEST", 409, "Codex 同步项目的源目录只能由 Codex Desktop 管理");
    }
    if (project.archivedAt) {
      throw new AppError("INVALID_REQUEST", 409, "不能为已归档项目登记目录");
    }
    if (project.version !== command.expectedVersion) {
      throw new AppError("VERSION_CONFLICT", 409, "项目版本已变化，请重新加载");
    }

    const workspaceRealpath = this.#canonicalAllowedDirectory(command.absolutePath);
    const duplicate = this.#database
      .prepare("SELECT id FROM projects WHERE workspace_realpath = ? AND id <> ?")
      .get(workspaceRealpath, projectId);
    if (duplicate) {
      throw new AppError("DUPLICATE_REQUEST", 409, "该本地目录已绑定到其他项目");
    }

    const repository = await this.#inspectRepository(workspaceRealpath);
    if (repository.rootRealpath !== workspaceRealpath) {
      throw new AppError("INVALID_REQUEST", 400, "必须登记 Git 工作树根目录，不能登记其子目录");
    }
    const contexts = await this.#discoverContexts(repository);
    const timestamp = this.#now().toISOString();

    withTransaction(this.#database, () => {
      const update = this.#database
        .prepare(
          `UPDATE projects SET
            workspace_realpath = ?,
            version = version + 1,
            updated_at = ?
          WHERE id = ? AND version = ? AND archived_at IS NULL`,
        )
        .run(workspaceRealpath, timestamp, projectId, command.expectedVersion);
      if (update.changes !== 1) {
        throw new AppError("VERSION_CONFLICT", 409, "项目版本已变化，请重新加载");
      }
      this.#persistContexts(projectId, contexts, timestamp);
      this.#recordAudit("project.workspace.register", projectId, {
        contextCount: contexts.length,
        dirty: repository.dirty,
      });
    });

    return WorkspaceRegistrationResultSchema.parse({
      project: this.#readProject(projectId),
      repository: {
        branch: repository.branch,
        headSha: repository.headSha,
        dirty: repository.dirty,
      },
      contexts: this.#readContexts(projectId),
    });
  }

  async scanDevelopmentContexts(
    projectId: string,
  ): Promise<readonly LocalDevelopmentContextView[]> {
    const project = this.#readProject(projectId);
    const workspaceRealpath = project.workspaceRealpath;
    if (!workspaceRealpath) {
      throw new AppError("INVALID_REQUEST", 409, "项目尚未登记本地目录");
    }
    if (project.archivedAt) {
      throw new AppError("INVALID_REQUEST", 409, "不能扫描已归档项目");
    }

    const canonicalWorkspace = this.#canonicalAllowedDirectory(workspaceRealpath);
    const repository = await this.#inspectRepository(canonicalWorkspace);
    if (repository.rootRealpath !== canonicalWorkspace) {
      throw new AppError("INVALID_REQUEST", 409, "已登记目录不再是 Git 工作树根目录");
    }
    const contexts = await this.#discoverContexts(repository);
    const timestamp = this.#now().toISOString();

    withTransaction(this.#database, () => {
      this.#persistContexts(projectId, contexts, timestamp);
      this.#recordAudit("project.contexts.scan", projectId, { contextCount: contexts.length });
    });
    return this.#readContexts(projectId);
  }

  readDevelopmentContexts(projectId: string): readonly LocalDevelopmentContextView[] {
    this.#readProject(projectId);
    return this.#readContexts(projectId).filter(
      (context) => context.active && context.executable && context.worktreeRealpath !== null,
    );
  }

  async resolveExecutionContext(
    projectId: string,
    developmentContextId?: string,
  ): Promise<ExecutionContext> {
    const source = this.#projectSource(projectId);
    if (source.sourceKind === "system") {
      throw new AppError("INVALID_REQUEST", 409, "系统项目不能执行任务");
    }
    const project = this.#readProject(projectId);
    if (source.sourceKind === "codex" && source.syncDeletedAt) {
      throw new AppError("INVALID_REQUEST", 409, "已从 Codex Desktop 删除的项目不能启动执行");
    }
    if (source.sourceKind === "codex" && !developmentContextId) {
      const roots = z.array(z.string().min(1)).min(1).parse(JSON.parse(source.rootPathsJson));
      const cwd = this.#canonicalAllowedDirectory(roots[0] as string);
      let repository: RepositoryInspection | null = null;
      try {
        repository = await this.#inspectRepository(cwd);
      } catch {
        // Codex Desktop 项目允许使用非 Git 源文件夹。
      }
      return ExecutionContextSchema.parse({
        projectId,
        developmentContextId: null,
        cwd,
        branch: repository?.branch ?? null,
        headSha: repository?.headSha ?? null,
      });
    }
    const registeredWorkspace = project.workspaceRealpath;
    if (!registeredWorkspace) {
      throw new AppError("INVALID_REQUEST", 409, "项目尚未登记本地目录");
    }
    if (project.archivedAt) {
      throw new AppError("INVALID_REQUEST", 409, "已归档项目不能执行任务");
    }

    const registered = await this.#inspectRepository(
      this.#canonicalAllowedDirectory(registeredWorkspace),
    );
    if (!developmentContextId) {
      return ExecutionContextSchema.parse({
        projectId,
        developmentContextId: null,
        cwd: registered.rootRealpath,
        branch: registered.branch,
        headSha: registered.headSha,
      });
    }

    const rawContext: unknown = this.#database
      .prepare(
        `SELECT
          id,
          project_id AS projectId,
          kind,
          label,
          branch,
          git_ref AS gitRef,
          head_sha AS headSha,
          worktree_realpath AS worktreeRealpath,
          executable,
          active,
          scanned_at AS scannedAt
        FROM project_development_contexts
        WHERE id = ? AND project_id = ?`,
      )
      .get(developmentContextId, projectId);
    const context = ContextRowSchema.safeParse(rawContext);
    if (!context.success || context.data.active !== 1) {
      throw new AppError("NOT_FOUND", 404, "开发上下文不存在或已失效");
    }
    if (context.data.executable !== 1 || !context.data.worktreeRealpath) {
      throw new AppError("INVALID_REQUEST", 409, "该分支没有可执行的工作树");
    }

    const cwd = this.#canonicalAllowedDirectory(context.data.worktreeRealpath);
    const selected = await this.#inspectRepository(cwd);
    if (selected.commonDirectoryRealpath !== registered.commonDirectoryRealpath) {
      throw new AppError("FORBIDDEN", 403, "开发上下文不属于已登记 Git 仓库");
    }
    if (context.data.kind === "branch" && selected.branch !== context.data.branch) {
      throw new AppError("INVALID_REQUEST", 409, "分支上下文已变化，请重新扫描");
    }

    return ExecutionContextSchema.parse({
      projectId,
      developmentContextId,
      cwd: selected.rootRealpath,
      branch: selected.branch,
      headSha: selected.headSha,
    });
  }

  #configuredRoot(root: string): string {
    if (!isAbsolute(root)) {
      throw new AppError("CONFIG_INVALID", 500, "工作区允许根目录必须是绝对路径");
    }
    try {
      const canonical = realpathSync.native(root);
      if (!statSync(canonical).isDirectory()) {
        throw new Error("not a directory");
      }
      return canonical;
    } catch (cause: unknown) {
      throw new AppError("CONFIG_INVALID", 500, "工作区允许根目录不存在或不可读取", { cause });
    }
  }

  #canonicalAllowedDirectory(input: string): string {
    if (!isAbsolute(input)) {
      throw new AppError("INVALID_REQUEST", 400, "项目目录必须使用绝对路径");
    }

    let canonical: string;
    try {
      canonical = realpathSync.native(input);
      if (!statSync(canonical).isDirectory()) {
        throw new Error("not a directory");
      }
    } catch (cause: unknown) {
      throw new AppError("INVALID_REQUEST", 400, "项目目录不存在或不可读取", { cause });
    }
    if (!this.#allowedRoots.some((root) => this.#isInside(root, canonical))) {
      throw new AppError("FORBIDDEN", 403, "项目目录超出允许的工作区根目录");
    }
    return canonical;
  }

  #isInside(root: string, candidate: string): boolean {
    const pathFromRoot = relative(root, candidate);
    return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
  }

  async #inspectRepository(workspace: string): Promise<RepositoryInspection> {
    try {
      const rootOutput = await this.#git(workspace, ["rev-parse", "--show-toplevel"]);
      const rootRealpath = realpathSync.native(rootOutput.trim());
      const commonOutput = await this.#git(workspace, ["rev-parse", "--git-common-dir"]);
      const commonDirectoryRealpath = realpathSync.native(resolve(workspace, commonOutput.trim()));
      const branch = await this.#gitOptional(workspace, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]);
      const headSha = await this.#gitOptional(workspace, ["rev-parse", "--verify", "HEAD"]);
      const status = await this.#git(workspace, [
        "status",
        "--porcelain",
        "--untracked-files=normal",
      ]);

      return {
        rootRealpath,
        commonDirectoryRealpath,
        branch: branch?.trim() || null,
        headSha: headSha?.trim() || null,
        dirty: status.length > 0,
      };
    } catch (cause: unknown) {
      if (cause instanceof AppError) {
        throw cause;
      }
      throw new AppError("INVALID_REQUEST", 400, "项目目录不是有效的 Git 工作树", { cause });
    }
  }

  async #discoverContexts(repository: RepositoryInspection): Promise<readonly DiscoveredContext[]> {
    const [worktrees, branches] = await Promise.all([
      this.#readWorktrees(repository.rootRealpath),
      this.#readBranches(repository.rootRealpath),
    ]);
    const executableBranchPaths = new Map(
      worktrees
        .filter((worktree) => worktree.branch && this.#isAllowedExistingDirectory(worktree.path))
        .map((worktree) => [worktree.branch as string, realpathSync.native(worktree.path)]),
    );

    const branchContexts: DiscoveredContext[] = branches.map((branch) => {
      const worktreeRealpath = executableBranchPaths.get(branch.name) ?? null;
      return {
        contextKey: `branch:${branch.gitRef}`,
        kind: "branch",
        label: branch.name,
        branch: branch.name,
        gitRef: branch.gitRef,
        headSha: branch.headSha,
        worktreeRealpath,
        executable: worktreeRealpath !== null,
      };
    });
    return branchContexts;
  }

  async #readWorktrees(workspace: string): Promise<readonly GitWorktree[]> {
    const output = await this.#git(workspace, ["worktree", "list", "--porcelain", "-z"]);
    return output
      .split("\0\0")
      .map((record) => record.split("\0").filter(Boolean))
      .filter((fields) => fields.some((field) => field.startsWith("worktree ")))
      .map((fields) => {
        const value = (key: string) =>
          fields.find((field) => field.startsWith(`${key} `))?.slice(key.length + 1);
        const gitRef = value("branch") ?? null;
        return {
          path: value("worktree") as string,
          branch: gitRef?.replace(/^refs\/heads\//, "") ?? null,
          gitRef,
          headSha: value("HEAD") ?? null,
        };
      });
  }

  async #readBranches(workspace: string): Promise<readonly GitBranch[]> {
    const output = await this.#git(workspace, [
      "for-each-ref",
      "--format=%(refname)%00%(refname:short)%00%(objectname)",
      "refs/heads",
    ]);
    return output
      .split("\n")
      .filter(Boolean)
      .map((record) => {
        const [gitRef, name, headSha] = record.split("\0");
        if (!gitRef || !name || !headSha) {
          throw new AppError("INVALID_REQUEST", 400, "无法解析 Git 分支信息");
        }
        return { gitRef, name, headSha };
      });
  }

  #isAllowedExistingDirectory(path: string): boolean {
    try {
      const canonical = realpathSync.native(path);
      return (
        statSync(canonical).isDirectory() &&
        this.#allowedRoots.some((root) => this.#isInside(root, canonical))
      );
    } catch {
      return false;
    }
  }

  #persistContexts(
    projectId: string,
    contexts: readonly DiscoveredContext[],
    scannedAt: string,
  ): void {
    this.#database
      .prepare(
        `UPDATE project_development_contexts
        SET active = 0, executable = 0, scanned_at = ?
        WHERE project_id = ?`,
      )
      .run(scannedAt, projectId);
    const upsert = this.#database.prepare(
      `INSERT INTO project_development_contexts (
        id, project_id, context_key, kind, label, branch, git_ref, head_sha,
        worktree_realpath, executable, active, scanned_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT (project_id, context_key) DO UPDATE SET
        kind = excluded.kind,
        label = excluded.label,
        branch = excluded.branch,
        git_ref = excluded.git_ref,
        head_sha = excluded.head_sha,
        worktree_realpath = excluded.worktree_realpath,
        executable = excluded.executable,
        active = 1,
        scanned_at = excluded.scanned_at`,
    );
    for (const context of contexts) {
      upsert.run(
        randomUUID(),
        projectId,
        context.contextKey,
        context.kind,
        context.label,
        context.branch,
        context.gitRef,
        context.headSha,
        context.worktreeRealpath,
        context.executable ? 1 : 0,
        scannedAt,
      );
    }
  }

  #readContexts(projectId: string): readonly LocalDevelopmentContextView[] {
    const rows: unknown[] = this.#database
      .prepare(
        `SELECT
          id,
          project_id AS projectId,
          kind,
          label,
          branch,
          git_ref AS gitRef,
          head_sha AS headSha,
          worktree_realpath AS worktreeRealpath,
          executable,
          active,
          scanned_at AS scannedAt
        FROM project_development_contexts
        WHERE project_id = ?
        ORDER BY active DESC, kind, label COLLATE NOCASE`,
      )
      .all(projectId);
    return rows.map((row) => {
      const parsed = ContextRowSchema.parse(row);
      return LocalDevelopmentContextViewSchema.parse({
        ...parsed,
        executable: parsed.executable === 1,
        active: parsed.active === 1,
      });
    });
  }

  #readProject(projectId: string) {
    const raw: unknown = this.#database
      .prepare(
        `SELECT
          id,
          project_key AS projectKey,
          name,
          description,
          source_kind AS kind,
          root_paths_json AS rootPathsJson,
          workspace_realpath AS workspaceRealpath,
          version,
          created_at AS createdAt,
          updated_at AS updatedAt,
          archived_at AS archivedAt
        FROM projects
        WHERE id = ?`,
      )
      .get(projectId);
    if (!raw) {
      throw new AppError("NOT_FOUND", 404, "项目不存在");
    }
    const project = ProjectWorkspaceRowSchema.parse(raw);
    const rootPaths = z.array(z.string().min(1)).parse(JSON.parse(project.rootPathsJson));
    return LocalProjectViewSchema.parse({ ...project, rootPaths });
  }

  #projectSource(projectId: string) {
    const raw = this.#database
      .prepare(
        `SELECT source_kind AS sourceKind, root_paths_json AS rootPathsJson,
          sync_deleted_at AS syncDeletedAt
        FROM projects WHERE id = ?`,
      )
      .get(projectId);
    const source = ProjectSourceRowSchema.safeParse(raw);
    if (!source.success) throw new AppError("NOT_FOUND", 404, "项目不存在");
    return source.data;
  }

  #recordAudit(action: string, projectId: string, metadata: Record<string, unknown>): void {
    this.#database
      .prepare(
        `INSERT INTO audit_events (
          id, identity_key, action, resource_type, resource_id, outcome, safe_metadata_json
        ) VALUES (?, NULL, ?, 'project', ?, 'allowed', ?)`,
      )
      .run(randomUUID(), action, projectId, JSON.stringify(metadata));
  }

  async #git(workspace: string, arguments_: readonly string[]): Promise<string> {
    const result = await execFileAsync("git", ["-C", workspace, ...arguments_], {
      encoding: "utf8",
      maxBuffer: 2 * 1_024 * 1_024,
    });
    return result.stdout;
  }

  async #gitOptional(workspace: string, arguments_: readonly string[]): Promise<string | null> {
    try {
      return await this.#git(workspace, arguments_);
    } catch {
      return null;
    }
  }
}
