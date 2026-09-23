import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { desktopThreadPlacement } from "./codex-desktop-sidebar.mjs";

test("keeps moved project and worktree assignments, explicit projectless and manual order", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "desktop-sidebar-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const threads = [
    { id: "paper", cwd: "/old/paper" },
    { id: "new" },
    { id: "loose", cwd: "/paper" },
  ];
  assert.deepEqual(await desktopThreadPlacement(home, threads), threads);
  await writeFile(
    join(home, ".codex-global-state.json"),
    JSON.stringify({
      "thread-project-assignments": {
        paper: { projectKind: "local", projectId: "p" },
        new: { projectKind: "local", projectId: "p" },
      },
      "projectless-thread-ids": ["loose"],
      "sidebar-project-thread-orders": { p: { threadIds: ["other", "paper"] } },
      "electron-persisted-atom-state": {
        "flat-project-sidebar-preferences-v1": {
          projectSortMode: "manual",
          chatSortMode: "updated_at",
        },
      },
    }),
  );
  assert.deepEqual(await desktopThreadPlacement(home, threads), [
    { ...threads[0], desktopProjectId: "p", desktopOrder: 1 },
    { ...threads[1], desktopProjectId: "p", desktopOrder: -1 },
    { ...threads[2], desktopProjectId: null },
  ]);
  await writeFile(join(home, ".codex-global-state.json"), '{"partial":');
  assert.deepEqual(await desktopThreadPlacement(home, threads), threads);
});
