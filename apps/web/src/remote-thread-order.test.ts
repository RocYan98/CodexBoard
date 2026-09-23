import { expect, it } from "vitest";
import type { RemoteThreadSummary } from "@codexboard/contracts";
import { compareRemoteThreads, remoteProjectOwner } from "./remote-thread-order";
const thread = (id: string, updatedAt: number, recencyAt: number): RemoteThreadSummary => ({
  id,
  title: id,
  preview: "",
  cwd: "/old/paper",
  status: "idle",
  updatedAt,
  recencyAt,
});
it("uses Desktop activity time, not the timestamp changed by opening an old task", () => {
  const threads = [thread("opened-old", 999, 1), thread("recent", 10, 10)];
  expect(threads.sort(compareRemoteThreads).map((t) => t.id)).toEqual(["recent", "opened-old"]);
});
it("keeps saved manual order while placing new tasks first", () => {
  const threads = [
    { ...thread("second", 100, 100), desktopOrder: 1 },
    { ...thread("first", 1, 1), desktopOrder: 0 },
    { ...thread("new", 10, 10), desktopOrder: -1 },
  ];
  expect(threads.sort(compareRemoteThreads).map((t) => t.id)).toEqual(["new", "first", "second"]);
});
it("uses authoritative project assignments and only falls back to longest cwd for unknown tasks", () => {
  const projects = [
    { id: "paper", rootPaths: ["/paper"] },
    { id: "nested", rootPaths: ["/paper/sub/"] },
  ];
  const t = { ...thread("task", 1, 1), cwd: "/paper/sub/task" };
  expect(remoteProjectOwner({ ...t, projectId: "paper" }, projects)).toBe("paper");
  expect(remoteProjectOwner({ ...t, projectId: null }, projects)).toBeNull();
  expect(remoteProjectOwner(t, projects)).toBe("nested");
  expect(remoteProjectOwner({ ...t, cwd: "/papers" }, projects)).toBeUndefined();
  expect(remoteProjectOwner({ ...t, cwd: "/old/paper", projectId: "paper" }, projects)).toBe(
    "paper",
  );
});
