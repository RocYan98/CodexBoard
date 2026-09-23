import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopFrameReader, MAX_DESKTOP_FRAME_BYTES } from "./codex-ipc-frames.mjs";

function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

test("decodes fragmented headers, multibyte text and coalesced IPC messages", () => {
  const messages = [];
  const read = createDesktopFrameReader((message) => messages.push(message));
  const input = Buffer.concat([frame({ text: "旧对话🙂" }), frame({ revision: 2 })]);
  for (const byte of input) read(Buffer.from([byte]));
  read(Buffer.concat([frame({ revision: 3 }), frame({ revision: 4 })]));
  assert.deepEqual(messages, [
    { text: "旧对话🙂" },
    { revision: 2 },
    { revision: 3 },
    { revision: 4 },
  ]);
});

test("accepts a fragmented snapshot larger than the old 32 MiB limit", () => {
  const value = "x".repeat(33 * 1024 * 1024);
  let received;
  const read = createDesktopFrameReader((message) => {
    received = message;
  });
  const input = frame({ data: value });
  for (let offset = 0; offset < input.length; offset += 65536)
    read(input.subarray(offset, offset + 65536));
  assert.equal(received.data, value);
});

test("rejects invalid lengths before allocating a body and rejects invalid JSON", () => {
  for (const length of [0, MAX_DESKTOP_FRAME_BYTES + 1, 0xffffffff]) {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(length);
    assert.throws(() => createDesktopFrameReader(() => assert.fail())(header), /frame size/);
  }
  assert.throws(() => createDesktopFrameReader(() => assert.fail())(Buffer.from([1, 0, 0, 0, 0])));
});
