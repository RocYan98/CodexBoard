import { expect, it } from "vitest";
import { defaultRemotePresets, readComposerOptions } from "./remote-composer-model";
it("inherits Desktop defaults for empty or corrupt saved preferences", () => {
  for (const saved of [null, "{}", "broken", "null"])
    expect(readComposerOptions(saved)).toMatchObject({
      selectionMode: "default",
      serviceTier: null,
    });
});
it("keeps explicit selections from the previous preference format", () => {
  expect(
    readComposerOptions(JSON.stringify({ model: "other", effort: "high", approvalMode: "ask" })),
  ).toMatchObject({ model: "other", effort: "high", selectionMode: "model", approvalMode: "ask" });
  expect(
    readComposerOptions(
      JSON.stringify({
        model: "gpt-6-astra",
        effort: "high",
        serviceTier: "priority",
        selectionMode: "model",
      }),
    ),
  ).toMatchObject({ selectionMode: "model", serviceTier: "priority" });
});

it("uses only Desktop recommended presets in their published order", () => {
  const models = ["new-model", "other-model"].map((id) => ({
    id,
    name: id,
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    serviceTiers: [],
  }));
  expect(defaultRemotePresets(models)).toEqual([]);
  expect(
    defaultRemotePresets([
      {
        ...models[0]!,
        defaultPresets: [
          { effort: "high", order: 2 },
          { effort: "unsupported", order: 3 },
        ],
      },
      {
        ...models[1]!,
        defaultPresets: [
          { effort: "low", order: 0 },
          { effort: "medium", order: 1 },
        ],
      },
    ]),
  ).toEqual([
    { model: "other-model", effort: "low" },
    { model: "other-model", effort: "medium" },
    { model: "new-model", effort: "high" },
  ]);
});
