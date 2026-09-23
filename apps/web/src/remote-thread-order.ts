import type { RemoteThreadSummary } from "@codexboard/contracts";

export function remoteRecency(thread: RemoteThreadSummary) {
  return thread.recencyAt ?? thread.updatedAt;
}

export function compareRemoteThreads(a: RemoteThreadSummary, b: RemoteThreadSummary) {
  return (a.desktopOrder ?? -1) - (b.desktopOrder ?? -1) || remoteRecency(b) - remoteRecency(a);
}

export function remoteProjectOwner(
  thread: RemoteThreadSummary,
  projects: { id: string; rootPaths: string[] }[],
) {
  // Explicit Desktop assignments (including projectless) override path guesses.
  if (thread.projectId !== undefined) return thread.projectId;
  return projects
    .flatMap((project) =>
      project.rootPaths.map((root) => ({ id: project.id, root: root.replace(/\/$/, "") })),
    )
    .filter(({ root }) => thread.cwd === root || thread.cwd.startsWith(`${root}/`))
    .sort((a, b) => b.root.length - a.root.length)[0]?.id;
}
