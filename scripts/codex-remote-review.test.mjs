import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { readRemoteReview } from "./codex-remote-review.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
async function repository(t, commit = true) {
  const root = await mkdtemp(join(tmpdir(), "remote-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Review test");
  if (commit) {
    for (const [name, text] of Object.entries({
      "base.txt": "one\n",
      "gone.txt": "gone\n",
      "old name.txt": "same\n",
      "steady.txt": "steady\n",
    }))
      await writeFile(join(root, name), text);
    git(root, "add", ".");
    git(root, "commit", "-m", "initial");
  }
  return root;
}

test("separates unstaged, staged and branch changes and reads the correct version", async (t) => {
  const cwd = await repository(t);
  await writeFile(join(cwd, "base.txt"), "one\ntwo\n");
  git(cwd, "add", "base.txt");
  await writeFile(join(cwd, "base.txt"), "one\ntwo\nthree\n");
  await rm(join(cwd, "gone.txt"));
  git(cwd, "mv", "old name.txt", "重命名 文件.txt");
  await writeFile(join(cwd, "new.txt"), "new\nfile\n");
  const snapshot = { cwd, turns: [] };
  const unstaged = await readRemoteReview(snapshot, { scope: "unstaged" });
  assert.equal(unstaged.files.find((f) => f.path === "base.txt").added, 1);
  assert.equal(unstaged.files.find((f) => f.path === "new.txt").added, 2);
  assert.equal(unstaged.files.find((f) => f.path === "gone.txt").status, "deleted");
  const staged = await readRemoteReview(snapshot, { scope: "staged" });
  assert.equal(staged.files.find((f) => f.path === "base.txt").added, 1);
  assert.equal(staged.files.find((f) => f.path === "重命名 文件.txt").previousPath, "old name.txt");
  assert.ok(!staged.files.some((f) => f.path === "new.txt"));
  const branch = await readRemoteReview(snapshot, { scope: "branch", all: true });
  assert.equal(branch.baseRef, "HEAD");
  assert.equal(branch.files.find((f) => f.path === "base.txt").added, 2);
  assert.equal(branch.files.find((f) => f.path === "steady.txt").status, "unchanged");
  const stagedFile = await readRemoteReview(snapshot, { scope: "staged", path: "base.txt" });
  assert.match(stagedFile.patch, /\+two/);
  assert.doesNotMatch(stagedFile.patch, /\+three/);
  const stagedContent = await readRemoteReview(snapshot, {
    scope: "staged",
    path: "base.txt",
    view: "file",
  });
  assert.equal(stagedContent.content, "one\ntwo\n");
  assert.equal(stagedContent.patch, "");
  const currentContent = await readRemoteReview(snapshot, {
    scope: "branch",
    path: "base.txt",
    view: "file",
  });
  assert.equal(currentContent.content, "one\ntwo\nthree\n");
  const workingFile = await readRemoteReview(snapshot, { scope: "unstaged", path: "base.txt" });
  assert.match(workingFile.patch, /\+three/);
  assert.equal(
    (await readRemoteReview(snapshot, { scope: "branch", path: "steady.txt" })).content,
    "steady\n",
  );
});

test("compares a local feature branch with main without requiring a remote", async (t) => {
  const cwd = await repository(t);
  git(cwd, "switch", "-c", "feature/review");
  await writeFile(join(cwd, "feature.txt"), "feature\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "feature");
  const result = await readRemoteReview({ cwd }, { scope: "branch" });
  assert.equal(result.branch, "feature/review");
  assert.equal(result.baseRef, "main");
  assert.equal(result.files.find((f) => f.path === "feature.txt").added, 1);
  assert.deepEqual((await readRemoteReview({ cwd }, { scope: "unstaged" })).files, []);
});

test("handles an initial branch and a directory without Git", async (t) => {
  const cwd = await repository(t, false);
  await writeFile(join(cwd, "first.txt"), "first\n");
  git(cwd, "add", "first.txt");
  await writeFile(join(cwd, "second.txt"), "second\n");
  const result = await readRemoteReview({ cwd }, { scope: "branch" });
  assert.equal(result.baseRef, null);
  assert.deepEqual(
    result.files.map((f) => f.path),
    ["first.txt", "second.txt"],
  );
  assert.match(
    (await readRemoteReview({ cwd }, { scope: "branch", path: "first.txt" })).patch,
    /\+first/,
  );
  const plain = await mkdtemp(join(tmpdir(), "remote-review-plain-"));
  t.after(() => rm(plain, { recursive: true, force: true }));
  assert.equal((await readRemoteReview({ cwd: plain }, { scope: "branch" })).repository, false);
});

test("uses only the latest turn's recorded patch for turn review", async (t) => {
  const cwd = await repository(t);
  const patch =
    "diff --git a/base.txt b/base.txt\n--- a/base.txt\n+++ b/base.txt\n@@ -1 +1 @@\n-one\n+saved turn\n";
  const snapshot = {
    cwd,
    turnHistory: {
      kind: "canonical",
      history: {
        entitiesByKey: {
          older: { turnStartedAtMs: 1, diff: "old" },
          latest: { turnStartedAtMs: 2, diff: patch },
        },
      },
    },
  };
  const result = await readRemoteReview(snapshot, { scope: "turn" });
  assert.equal(result.files[0].path, "base.txt");
  assert.equal(result.files[0].added, 1);
  assert.equal(
    (await readRemoteReview(snapshot, { scope: "turn", path: "base.txt" })).patch,
    patch,
  );
  snapshot.turnHistory.history.entitiesByKey.latest.diff = "";
  assert.deepEqual((await readRemoteReview(snapshot, { scope: "turn" })).files, []);
});

test("rejects paths outside the indexed review set and previews symlinks without following them", async (t) => {
  const cwd = await repository(t);
  const target = `${cwd}-private-target`;
  await writeFile(target, "private-outside-content");
  t.after(() => rm(target, { force: true }));
  await symlink(target, join(cwd, "link.txt"));
  await writeFile(join(cwd, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  const snapshot = { cwd };
  for (const path of ["../outside", "/etc/passwd", ".git/config", ":(glob)*", "missing.txt"])
    await assert.rejects(readRemoteReview(snapshot, { scope: "branch", path }));
  const result = await readRemoteReview(snapshot, { scope: "branch" });
  assert.equal(result.files.find((f) => f.path === "binary.bin").binary, true);
  const link = await readRemoteReview(snapshot, { scope: "branch", path: "link.txt" });
  assert.ok(link.patch.includes(`+${target}\n`));
  assert.doesNotMatch(link.patch, /private-outside-content/);
  assert.equal(
    (await readRemoteReview(snapshot, { scope: "branch", path: "link.txt", view: "file" })).content,
    target,
  );
  await mkdir(join(cwd, "nested"));
  assert.equal(
    (await readRemoteReview({ cwd: join(cwd, "nested") }, { scope: "branch" })).repository,
    true,
  );
});

test("does not run external diff helpers or modify the index", async (t) => {
  const cwd = await repository(t);
  await writeFile(join(cwd, "base.txt"), "changed\n");
  const marker = join(cwd, "external-ran");
  git(cwd, "config", "diff.external", `touch '${marker}'`);
  git(cwd, "config", "core.fsmonitor", `touch '${marker}'`);
  const before = await readFile(join(cwd, ".git/index"));
  await readRemoteReview({ cwd }, { scope: "branch" });
  await readRemoteReview({ cwd }, { scope: "branch", path: "base.txt" });
  await readRemoteReview({ cwd }, { scope: "branch", path: "base.txt", view: "file" });
  assert.deepEqual(await readFile(join(cwd, ".git/index")), before);
  await assert.rejects(access(marker));
});

test("retains turn filenames when added code resembles Git headers", async (t) => {
  const cwd = await repository(t);
  const patch =
    "diff --git a/base.txt b/base.txt\n--- a/base.txt\n+++ b/base.txt\n@@ -1 +1,2 @@\n-one\n+++ b/not-a-path.txt\n+new file mode 100755\n";
  const result = await readRemoteReview({ cwd, turns: [{ diff: patch }] }, { scope: "turn" });
  assert.equal(result.files[0].path, "base.txt");
  assert.equal(result.files[0].added, 2);
  assert.equal(result.files[0].status, "modified");
});

test("bounds large previews and reads linked worktrees and literal special filenames", async (t) => {
  const cwd = await repository(t);
  await writeFile(join(cwd, "large.txt"), "x".repeat(1024 * 1024 + 1));
  const list = await readRemoteReview({ cwd }, { scope: "branch" });
  assert.equal(list.countsComplete, false);
  assert.equal(list.files[0].added, null);
  const large = await readRemoteReview({ cwd }, { scope: "branch", path: "large.txt" });
  assert.equal(large.tooLarge, true);
  assert.equal(large.patch, "");
  const worktree = join(cwd, "linked");
  git(cwd, "worktree", "add", "-b", "feature/linked", worktree);
  const path = process.platform === "win32" ? "literal [a].txt" : "literal [a]*.txt";
  await writeFile(join(worktree, path), "literal\n");
  const file = await readRemoteReview({ cwd: worktree }, { scope: "branch", path });
  assert.match(file.patch, /\+literal/);
  assert.equal(file.file.path, path);
});

test("selects the requested historical turn without substituting the latest or working tree", async (t) => {
  const cwd = await repository(t);
  const patch = (name) =>
    `diff --git a/${name} b/${name}\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1 @@\n+historical\n`;
  const snapshot = {
    cwd,
    turns: [
      { turnId: "old", turnStartedAtMs: 1, diff: patch("old.txt") },
      { turnId: "latest", turnStartedAtMs: 2, diff: patch("new.txt") },
    ],
  };
  const result = await readRemoteReview(snapshot, { scope: "turn", turnId: "old" });
  assert.deepEqual(
    result.files.map((f) => f.path),
    ["old.txt"],
  );
  const file = await readRemoteReview(snapshot, { scope: "turn", turnId: "old", path: "old.txt" });
  assert.equal(file.patch, patch("old.txt"));
  await assert.rejects(readRemoteReview(snapshot, { scope: "turn", turnId: "missing" }), /该回合/);
  await assert.rejects(readRemoteReview(snapshot, { scope: "branch", turnId: "old" }), /回合编号/);
});

test("reads Desktop fileChange records when the historical turn has no diff", async (t) => {
  const cwd = await repository(t);
  const snapshot = {
    cwd,
    turns: [
      {
        turnId: "recorded",
        diff: null,
        items: [
          {
            type: "fileChange",
            status: "completed",
            changes: [
              {
                path: join(cwd, "base.txt"),
                kind: { type: "update", move_path: null },
                diff: "@@ -1 +1 @@\n-recorded before\n+recorded after\n",
              },
            ],
          },
        ],
      },
    ],
  };
  const review = await readRemoteReview(snapshot, { scope: "turn", turnId: "recorded" });
  assert.equal(review.files[0].path, "base.txt");
  assert.equal(review.files[0].added, 1);
  assert.equal(review.files[0].removed, 1);
  const content = await readRemoteReview(snapshot, {
    scope: "turn",
    turnId: "recorded",
    path: "base.txt",
  });
  assert.match(content.patch, /\+recorded after/);
});
