import assert from "node:assert/strict";
import test from "node:test";
import { remoteSnapshot } from "./codex-remote-snapshot.mjs";
import { applyDesktopPatches } from "./codex-desktop-session.mjs";

test("media projection preserves text, user image sources, request tokens and original state", () => {
  const state = {
    requests: [{ id: "approval", params: { command: "echo hello" } }],
    turns: [
      {
        turnId: "old",
        items: [
          { type: "userMessage", content: [{ type: "image", url: "data:image/png;base64,user" }] },
          {
            type: "mcpToolCall",
            result: {
              content: [
                { type: "text", text: "result" },
                { type: "image", data: "large", mimeType: "image/png" },
              ],
              structuredContent: { image_url: "data:image/png;base64,large", other: "keep" },
            },
          },
        ],
      },
    ],
  };
  const before = structuredClone(state);
  const view = remoteSnapshot(state);
  assert.deepEqual(state, before);
  assert.deepEqual(view.requests, state.requests);
  assert.deepEqual(view.turns[0].items[0], state.turns[0].items[0]);
  const result = view.turns[0].items[1].result;
  assert.equal(result.content[0].text, "result");
  assert.equal(result.content[1].data, "");
  assert.equal(result.structuredContent.other, "keep");
  assert.ok(!result.structuredContent.image_url.includes("base64"));
});

test("streaming patches copy changed paths while retaining untouched large history", () => {
  const history = { items: [{ type: "mcpToolCall", data: "old media" }] };
  const state = { history, turns: [{ items: [{ text: "before" }, { text: "remove" }] }] };
  const result = applyDesktopPatches(state, [
    { op: "replace", path: ["turns", 0, "items", 0, "text"], value: "after" },
    { op: "remove", path: ["turns", 0, "items", 1] },
    { op: "add", path: ["turns", 0, "items", 1], value: { text: "added" } },
  ]);
  assert.equal(result.history, history);
  assert.deepEqual(result.turns[0].items, [{ text: "after" }, { text: "added" }]);
  assert.deepEqual(state.turns[0].items, [{ text: "before" }, { text: "remove" }]);
});
