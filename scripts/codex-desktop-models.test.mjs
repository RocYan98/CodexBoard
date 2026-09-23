import { desktopModelDataPath } from "./codex-desktop-models.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeSnappy, readDesktopPresets, selectDesktopPresets } from "./codex-desktop-models.mjs";
const models = [
  {
    model: "future-model",
    supportedReasoningEfforts: ["low", "medium", "high", "ultra"].map((reasoningEffort) => ({
      reasoningEffort,
    })),
  },
];
const presets = ["low", "medium", "high"].map((reasoning_effort) => ({
  model: "future-model",
  reasoning_effort,
}));
const now = Date.now();
function cache(groups = [presets], receivedAt = now) {
  return {
    stableID: "desktop",
    receivedAt,
    data: JSON.stringify({
      evaluated_keys: { customIDs: { stableID: "desktop" } },
      dynamic_configs: { 423260384: { value: { presets: groups } } },
    }),
  };
}
test("curated presets follow Desktop order and never expand all supported efforts", () => {
  assert.deepEqual(
    selectDesktopPresets([cache()], "desktop", models, now),
    presets.map((p) => ({ model: p.model, effort: p.reasoning_effort })),
  );
  assert.deepEqual(
    selectDesktopPresets(
      [cache([[{ model: "missing", reasoning_effort: "low" }], presets])],
      "desktop",
      models,
      now,
    ).map((p) => p.effort),
    ["low", "medium", "high"],
  );
});
test("newest cache, unknown configuration, stale cache and wrong installation fail closed", () => {
  for (const caches of [
    [],
    [cache([], now)],
    [cache([presets], now - 8 * 86400000)],
    [cache(), cache([], now + 1)],
  ])
    assert.deepEqual(selectDesktopPresets(caches, "desktop", models, now), []);
  assert.deepEqual(selectDesktopPresets([cache()], "other-installation", models, now), []);
});
test("Snappy supports overlapping copies and rejects oversized or broken blocks", () => {
  assert.equal(decodeSnappy(Buffer.from([8, 4, 97, 98, 22, 2, 0])).toString(), "abababab");
  for (const bytes of [
    [4, 12, 97],
    [8, 22, 2, 0],
    [255, 255, 255, 255, 15],
  ])
    assert.throws(() => decodeSnappy(Buffer.from(bytes)));
});
function varint(value) {
  const bytes = [];
  do {
    bytes.push((value & 127) | (value > 127 ? 128 : 0));
    value = Math.floor(value / 128);
  } while (value);
  return Buffer.from(bytes);
}
function crc(bytes) {
  let n = 0xffffffff;
  for (const b of bytes) {
    n ^= b;
    for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0x82f63b78 : 0);
  }
  n = ~n >>> 0;
  return (((n >>> 15) | (n << 17)) + 0xa282ead8) >>> 0;
}
function record(sequence, value) {
  const key = Buffer.from("_codex://app\0\x01statsig.cached.test");
  const head = Buffer.alloc(12);
  head.writeBigUInt64LE(BigInt(sequence));
  head.writeUInt32LE(1, 8);
  const val = Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(value))]);
  const batch = Buffer.concat([
    head,
    Buffer.from([value === null ? 0 : 1]),
    varint(key.length),
    key,
    ...(value === null ? [] : [varint(val.length), val]),
  ]);
  const header = Buffer.alloc(7);
  header.writeUInt32LE(crc(Buffer.concat([Buffer.from([1]), batch])));
  header.writeUInt16LE(batch.length, 4);
  header[6] = 1;
  return Buffer.concat([header, batch]);
}
test("reads live log records without opening a database; tombstones and corruption disable presets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "desktop-models-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "Default/Local Storage/leveldb");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(root, "statsig-state.json"),
    JSON.stringify({ "statsig-stable-id": "desktop" }),
  );
  const path = join(dir, "000001.log");
  await writeFile(path, record(1, cache()));
  assert.equal((await readDesktopPresets(models, { userDataPath: root })).length, 3);
  await writeFile(path, Buffer.concat([record(1, cache()), record(2, null)]));
  assert.deepEqual(await readDesktopPresets(models, { userDataPath: root }), []);
  const corrupt = record(3, cache());
  corrupt[0] ^= 1;
  await writeFile(path, corrupt);
  assert.deepEqual(await readDesktopPresets(models, { userDataPath: root }), []);
});

function table(sequence, value) {
  const tag = Buffer.alloc(8);
  tag.writeBigUInt64LE((BigInt(sequence) << 8n) | 1n);
  const key = Buffer.concat([Buffer.from("_codex://app\0\x01statsig.cached.test"), tag]);
  const val = Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(value))]);
  const entry = (key, value) =>
    Buffer.concat([
      Buffer.from([0]),
      varint(key.length),
      varint(value.length),
      key,
      value,
      Buffer.from([0, 0, 0, 0, 1, 0, 0, 0]),
    ]);
  const encoded = (raw) => {
    const trailer = Buffer.alloc(5);
    trailer.writeUInt32LE(crc(Buffer.concat([raw, Buffer.from([0])])), 1);
    return Buffer.concat([raw, trailer]);
  };
  const rawData = entry(key, val),
    data = encoded(rawData);
  const rawIndex = entry(key, Buffer.concat([varint(0), varint(rawData.length)])),
    index = encoded(rawIndex);
  const footer = Buffer.alloc(48);
  Buffer.concat([varint(0), varint(0), varint(data.length), varint(rawIndex.length)]).copy(footer);
  footer.writeBigUInt64LE(0xdb4775248b80fb57n, 40);
  return Buffer.concat([data, index, footer]);
}
test("reads SSTable configuration and lets newer log deletions win", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "desktop-model-table-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "Default/Local Storage/leveldb");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(root, "statsig-state.json"),
    JSON.stringify({ "statsig-stable-id": "desktop" }),
  );
  await writeFile(join(dir, "000001.ldb"), table(1, cache()));
  assert.equal((await readDesktopPresets(models, { userDataPath: root })).length, 3);
  await writeFile(join(dir, "000002.log"), record(2, null));
  assert.deepEqual(await readDesktopPresets(models, { userDataPath: root }), []);
});

test("ambiguous account caches never reuse another account's recommendations", () => {
  const one = cache(),
    two = cache([presets], now - 1000);
  const first = JSON.parse(one.data),
    second = JSON.parse(two.data);
  first.evaluated_keys.userID = "one";
  second.evaluated_keys.userID = "two";
  one.data = JSON.stringify(first);
  two.data = JSON.stringify(second);
  assert.deepEqual(selectDesktopPresets([one, two], "desktop", models, now), []);
});

test("Windows model cache follows the registered Desktop profile without scanning other accounts", () => {
  const env = {
    APPDATA: "C:\\Users\\test\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
  };
  const standard = env.APPDATA + "\\Codex";
  assert.equal(
    desktopModelDataPath({
      platform: "win32",
      env,
      exists: () => true,
      findPackage: () => assert.fail(),
    }),
    standard,
  );
  const packaged = env.LOCALAPPDATA + "\\Packages\\OpenAI.Codex_abc123\\LocalCache\\Roaming\\Codex";
  assert.equal(
    desktopModelDataPath({
      platform: "win32",
      env,
      exists: (p) => p === packaged + "\\statsig-state.json",
      findPackage: () => ({ appUserModelId: "OpenAI.Codex_abc123!App" }),
    }),
    packaged,
  );
  assert.equal(
    desktopModelDataPath({
      platform: "win32",
      env,
      exists: () => false,
      findPackage: () => undefined,
    }),
    undefined,
  );
});
