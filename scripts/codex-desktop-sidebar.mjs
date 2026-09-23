import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Read only the Desktop's project assignments and sidebar preferences. A moved
// project or a worktree does not necessarily share the saved project's cwd.
export async function desktopThreadPlacement(codexHome, threads) {
  let state;
  try {
    state = JSON.parse(await readFile(join(codexHome, ".codex-global-state.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return threads;
    throw error;
  }
  const assignments = state?.["thread-project-assignments"] ?? {};
  const projectless = new Set(
    Array.isArray(state?.["projectless-thread-ids"]) ? state["projectless-thread-ids"] : [],
  );
  const atoms = state?.["electron-persisted-atom-state"] ?? {};
  const preferences = atoms["flat-project-sidebar-preferences-v1"] ?? {};
  return threads.map((thread) => {
    const assignment = assignments[thread.id];
    const projectId = projectless.has(thread.id)
      ? null
      : assignment?.projectKind === "local" && typeof assignment.projectId === "string"
        ? assignment.projectId
        : undefined;
    const mode =
      atoms["codex-sidebar-sort-mode-v1"] ??
      (projectId ? preferences.projectSortMode : preferences.chatSortMode);
    const order = projectId
      ? state?.["sidebar-project-thread-orders"]?.[projectId]?.threadIds
      : atoms["codex-sidebar-chat-order-v1"];
    const index = Array.isArray(order) ? order.indexOf(thread.id) : -1;
    return {
      ...thread,
      ...(projectId !== undefined ? { desktopProjectId: projectId } : {}),
      // Desktop places newly seen tasks before saved manual ordering.
      ...(mode === "manual" ? { desktopOrder: index } : {}),
    };
  });
}
