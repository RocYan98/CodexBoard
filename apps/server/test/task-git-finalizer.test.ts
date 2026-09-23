import { execFileSync } from "node:child_process";
import {
  existsSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { TaskGitFinalizer } from "../src/modules/taskboard/task-git-finalizer.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "completion-check-")));
  roots.push(root);
  const main = join(root, "main");
  mkdirSync(main);
  git(main, "init", "-b", "main");
  git(main, "config", "user.name", "Test");
  git(main, "config", "user.email", "test@example.test");
  writeFileSync(join(main, "source.txt"), "initial");
  git(main, "add", ".");
  git(main, "commit", "-m", "initial");
  const worktree = join(root, "task");
  const finalizer = new TaskGitFinalizer([root]);
  const check = async (cwd = main, branch: string | null = "main") => {
    const snapshot = await finalizer.inspect(cwd, "task", "operation", main, branch);
    return snapshot && finalizer.verify(snapshot);
  };
  return { root, main, worktree, finalizer, check };
}

it("completes a clean main checkout without commits, archives, or delivery records", async () => {
  const { main, check } = setup();
  const before = git(main, "show-ref");
  expect(await check()).toMatchObject({ mainTask: true, commitSha: null, archiveRef: null });
  expect(git(main, "show-ref")).toBe(before);
  expect(existsSync(main)).toBe(true);
});

it.each(["tracked", "staged", "untracked"])(
  "rejects %s changes and never commits them",
  async (kind) => {
    const { main, check } = setup();
    const head = git(main, "rev-parse", "HEAD");
    writeFileSync(join(main, kind === "untracked" ? "new.txt" : "source.txt"), "changed");
    if (kind === "staged") git(main, "add", ".");
    const before = git(main, "status", "--porcelain");
    await expect(check()).rejects.toThrow("Git 不干净");
    expect(git(main, "status", "--porcelain")).toBe(before);
    expect(git(main, "rev-parse", "HEAD")).toBe(head);
  },
);

it("keeps ignored files on main and checks only Git cleanliness", async () => {
  const { main, check } = setup();
  writeFileSync(join(main, ".gitignore"), "cache/\n");
  git(main, "add", ".");
  git(main, "commit", "-m", "ignore");
  mkdirSync(join(main, "cache"));
  writeFileSync(join(main, "cache", "keep"), "keep");
  await expect(check()).resolves.toMatchObject({ mainTask: true });
  expect(existsSync(join(main, "cache", "keep"))).toBe(true);
});

it("requires both worktree removal and branch removal without performing either", async () => {
  const { main, worktree, check } = setup();
  git(main, "worktree", "add", "-b", "feature/task", worktree);
  await expect(check(worktree, "feature/task")).rejects.toThrow("工作树尚未删除");
  expect(existsSync(worktree)).toBe(true);
  git(main, "worktree", "remove", worktree);
  await expect(check(worktree, "feature/task")).rejects.toThrow("分支尚未删除");
  git(main, "branch", "-d", "feature/task");
  const refs = git(main, "show-ref");
  await expect(check(worktree, "feature/task")).resolves.toMatchObject({
    commitSha: null,
    archiveRef: null,
  });
  expect(git(main, "show-ref")).toBe(refs);
});

it("rejects a stale worktree registration even when its directory is gone", async () => {
  const { main, worktree, check } = setup();
  git(main, "worktree", "add", "-b", "feature/task", worktree);
  rmSync(worktree, { recursive: true });
  await expect(check(worktree, "feature/task")).rejects.toThrow("仍登记在 Git");
  expect(git(main, "worktree", "list", "--porcelain")).toContain(worktree.replaceAll("\\", "/"));
});

it("does not require a merge commit or a delivery receipt after external deletion", async () => {
  const { main, worktree, check } = setup();
  git(main, "worktree", "add", "-b", "feature/task", worktree);
  writeFileSync(join(worktree, "source.txt"), "unmerged");
  git(worktree, "commit", "-am", "change");
  git(main, "worktree", "remove", worktree);
  git(main, "branch", "-D", "feature/task");
  await expect(check(worktree, "feature/task")).resolves.toMatchObject({ mainTask: false });
  writeFileSync(join(main, "late.txt"), "pending");
  await expect(check(worktree, "feature/task")).rejects.toThrow("Git 不干净");
});

it("checks the exact task branch, including branch-only contexts on the main checkout", async () => {
  const { main, check } = setup();
  git(main, "branch", "feature/task");
  await expect(check(main, "feature/task")).rejects.toThrow("分支尚未删除");
  git(main, "branch", "-d", "feature/task");
  git(main, "branch", "feature/task-other");
  await expect(check(main, "feature/task")).resolves.toMatchObject({ mainTask: false });
});

it("fails explicitly if the removed checkout has no recorded branch identity", async () => {
  const { worktree, check } = setup();
  await expect(check(worktree, null)).rejects.toThrow("无法确认任务使用的分支");
});

it("preserves non-Git deliverables and enforces allowed paths before running Git", async () => {
  const { root, main, finalizer } = setup();
  const plain = join(root, "plain");
  mkdirSync(plain);
  writeFileSync(join(plain, "file"), "keep");
  expect(await finalizer.inspect(plain, "plain")).toBeNull();
  expect(existsSync(join(plain, "file"))).toBe(true);
  await expect(new TaskGitFinalizer([main]).inspect(plain, "outside")).rejects.toThrow("超出允许");
  symlinkSync(tmpdir(), join(main, "outside"));
  await expect(
    new TaskGitFinalizer([main]).inspect(
      join(main, "outside", "missing"),
      "outside",
      undefined,
      main,
      "feature/task",
    ),
  ).rejects.toThrow("超出允许");
});

it("uses only read-only Git commands with optional writes disabled", async () => {
  const { root, main } = setup();
  const commands: readonly string[][] = [];
  const checker = new TaskGitFinalizer([root], async (_cwd, command, writes) => {
    expect(writes).toEqual([]);
    expect(command.slice(0, 2)).toEqual(["git", "--no-optional-locks"]);
    (commands as string[][]).push([...command]);
    return execFileSync(command[0]!, command.slice(1), { encoding: "utf8" });
  });
  const snapshot = (await checker.inspect(main, "task", undefined, main, "main"))!;
  await checker.verify(snapshot);
  expect(commands.every((c) => ["rev-parse", "status", "worktree"].includes(c[4]!))).toBe(true);
});

it("blocks cancellation on task-scoped ignored temporary files without touching unrelated caches", async () => {
  const { main, finalizer } = setup();
  writeFileSync(join(main, ".gitignore"), ".tmp/\n");
  git(main, "add", ".");
  git(main, "commit", "-m", "ignore temporary files");
  const temporary = join(main, ".tmp", "taskboard", "task");
  const unrelated = join(main, ".tmp", "taskboard", "other-task");
  mkdirSync(temporary, { recursive: true });
  mkdirSync(unrelated);
  writeFileSync(join(temporary, "evidence.txt"), "keep until user cleanup");
  const snapshot = (await finalizer.inspect(main, "task", "operation", main, "main"))!;
  await expect(finalizer.verify(snapshot, "task")).rejects.toThrow("任务临时目录尚未删除");
  expect(existsSync(join(temporary, "evidence.txt"))).toBe(true);
  rmSync(temporary, { recursive: true });
  await expect(finalizer.verify(snapshot, "task")).resolves.toMatchObject({ mainTask: true });
  expect(existsSync(unrelated)).toBe(true);
});

it("rejects a leftover plain directory after Git worktree removal", async () => {
  const { main, worktree, check } = setup();
  git(main, "worktree", "add", "-b", "feature/task", worktree);
  git(main, "worktree", "remove", worktree);
  git(main, "branch", "-d", "feature/task");
  mkdirSync(worktree);
  writeFileSync(join(worktree, "temporary.log"), "keep");
  await expect(check(worktree, "feature/task")).rejects.toThrow("工作树尚未删除");
  expect(existsSync(join(worktree, "temporary.log"))).toBe(true);
});
