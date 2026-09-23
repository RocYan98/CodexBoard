import { describe, expect, it, vi } from "vitest";
import { readModelCatalog } from "./model-catalog.js";
const model = (id: string) => ({
  model: id,
  displayName: id,
  supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
  defaultReasoningEffort: "medium",
});
describe("live model catalog", () => {
  it("includes models on later pages and deduplicates overlapping pages", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: [model("old")], nextCursor: "next" })
      .mockResolvedValueOnce({ data: [model("old"), model("new")], nextCursor: null });
    expect((await readModelCatalog(request)).data.map((m) => m.model)).toEqual(["old", "new"]);
    expect(request).toHaveBeenLastCalledWith("model/list", { limit: 100, cursor: "next" });
  });
  it("rejects a repeating cursor instead of looping forever", async () => {
    await expect(
      readModelCatalog(vi.fn().mockResolvedValue({ data: [], nextCursor: "same" })),
    ).rejects.toThrow("分页游标重复");
  });
});
