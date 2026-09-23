import { existsSync } from "node:fs";
import { findWindowsCodexPackage } from "./codex-windows-app.mjs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, win32 } from "node:path";

// Read-only adapter for Desktop's persisted Statsig model-slider configuration.
// Formats: google/leveldb doc/table_format.md and doc/log_format.md;
// google/snappy format_description.txt.
// No database is opened, locked, repaired, or copied; no identity/cache payload
// crosses this module. Unknown formats fail closed instead of inventing presets.
const limit = 32 * 1024 * 1024;
const configKey = "423260384";
function cursor(buffer, offset = 0) {
  return {
    offset,
    number() {
      let value = 0,
        scale = 1;
      for (let i = 0; i < 8; i++) {
        const byte = buffer[this.offset++];
        if (byte === undefined) throw new Error("truncated varint");
        value += (byte & 127) * scale;
        if (byte < 128 && Number.isSafeInteger(value)) return value;
        scale *= 128;
      }
      throw new Error("invalid varint");
    },
    bytes(length) {
      if (length < 0 || this.offset + length > buffer.length) throw new Error("truncated bytes");
      const result = buffer.subarray(this.offset, this.offset + length);
      this.offset += length;
      return result;
    },
  };
}
export function decodeSnappy(buffer) {
  const input = cursor(buffer);
  const size = input.number();
  if (size > limit) throw new Error("oversized block");
  const output = Buffer.alloc(size);
  let pos = 0;
  while (input.offset < buffer.length) {
    const tag = input.bytes(1)[0];
    const kind = tag & 3;
    let length, offset;
    if (kind === 0) {
      length = tag >>> 2;
      if (length >= 60) length = input.bytes(length - 59).readUIntLE(0, length - 59);
      length++;
      if (pos + length > size) throw new Error("invalid literal");
      input.bytes(length).copy(output, pos);
    } else {
      length = kind === 1 ? 4 + ((tag >>> 2) & 7) : 1 + (tag >>> 2);
      offset =
        kind === 1
          ? ((tag & 224) << 3) + input.bytes(1)[0]
          : input.bytes(kind === 2 ? 2 : 4).readUIntLE(0, kind === 2 ? 2 : 4);
      if (offset < 1 || offset > pos || pos + length > size) throw new Error("invalid copy");
      for (let i = 0; i < length; i++) output[pos + i] = output[pos + i - offset];
    }
    pos += length;
  }
  if (pos !== size) throw new Error("truncated block");
  return output;
}
function checksum(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
  }
  crc = ~crc >>> 0;
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}
function block(buffer, handle) {
  const at = cursor(handle),
    offset = at.number(),
    size = at.number();
  if (size > limit || offset + size + 5 > buffer.length) throw new Error("invalid block");
  const raw = buffer.subarray(offset, offset + size);
  const type = buffer[offset + size];
  if (
    checksum(buffer.subarray(offset, offset + size + 1)) !== buffer.readUInt32LE(offset + size + 1)
  )
    throw new Error("block checksum");
  if (type === 0) return raw;
  if (type === 1) return decodeSnappy(raw);
  throw new Error("unsupported compression");
}
function* entries(buffer) {
  const end = buffer.length - 4 - 4 * buffer.readUInt32LE(buffer.length - 4);
  const at = cursor(buffer);
  let key = Buffer.alloc(0);
  while (at.offset < end) {
    const shared = at.number(),
      length = at.number(),
      valueLength = at.number();
    if (shared > key.length) throw new Error("invalid key");
    key = Buffer.concat([key.subarray(0, shared), at.bytes(length)]);
    const value = at.bytes(valueLength);
    if (at.offset > end) throw new Error("invalid entry");
    yield [key, value];
  }
  if (at.offset !== end) throw new Error("invalid restart table");
}
function* tableRecords(buffer) {
  if (buffer.length < 48 || buffer.readBigUInt64LE(buffer.length - 8) !== 0xdb4775248b80fb57n)
    throw new Error("invalid table");
  const footer = cursor(buffer, buffer.length - 48);
  footer.number();
  footer.number();
  for (const [, handle] of entries(block(buffer, buffer.subarray(footer.offset)))) {
    for (const [key, value] of entries(block(buffer, handle))) {
      const tag = key.readBigUInt64LE(key.length - 8);
      yield { key: key.subarray(0, -8), value, sequence: tag >> 8n, deleted: (tag & 255n) === 0n };
    }
  }
}
function* logRecords(buffer) {
  let chunks = [];
  for (let base = 0; base < buffer.length; base += 32768) {
    const end = Math.min(base + 32768, buffer.length);
    for (let offset = base; offset + 7 <= end;) {
      const length = buffer.readUInt16LE(offset + 4),
        type = buffer[offset + 6];
      if (!type && !length) break;
      if (offset + 7 + length > end) break; // Live log may have an unfinished tail.
      const part = buffer.subarray(offset + 7, offset + 7 + length);
      if (checksum(Buffer.concat([Buffer.from([type]), part])) !== buffer.readUInt32LE(offset))
        throw new Error("log checksum");
      offset += 7 + length;
      if (type === 1 || type === 2) chunks = [part];
      else if ((type === 3 || type === 4) && chunks.length) chunks.push(part);
      else throw new Error("invalid log fragment");
      if (type !== 1 && type !== 4) continue;
      const batch = Buffer.concat(chunks);
      chunks = [];
      const start = batch.readBigUInt64LE(0),
        count = batch.readUInt32LE(8),
        at = cursor(batch, 12);
      for (let i = 0; i < count; i++) {
        const type = at.bytes(1)[0];
        if (type !== 0 && type !== 1) throw new Error("invalid write batch");
        const key = at.bytes(at.number());
        const value = type === 1 ? at.bytes(at.number()) : Buffer.alloc(0);
        yield { key, value, deleted: type === 0, sequence: start + BigInt(i) };
      }
    }
  }
}
export function selectDesktopPresets(caches, stableId, models, now = Date.now()) {
  const candidates = caches
    .filter(
      (c) =>
        c.stableID === stableId &&
        Number.isFinite(c.receivedAt) &&
        now - c.receivedAt < 7 * 86400000 &&
        c.receivedAt <= now + 60000,
    )
    .sort((a, b) => b.receivedAt - a.receivedAt);
  // A cache alone cannot disambiguate an account switch. Do not recommend
  // another account's slider when more than one identity is present.
  const identities = new Set(
    candidates.map((c) => {
      const keys = JSON.parse(c.data).evaluated_keys;
      return JSON.stringify([keys?.userID, keys?.customIDs?.account_id]);
    }),
  );
  if (identities.size > 1) return [];
  const current = candidates[0];
  if (!current) return [];
  const data = JSON.parse(current.data);
  if (data.evaluated_keys?.customIDs?.stableID !== stableId) return [];
  const groups = data.dynamic_configs?.[configKey]?.value?.presets;
  if (!Array.isArray(groups)) return [];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    const presets = group.flatMap((p) => {
      const model = models.find((m) => !m.hidden && m.model === p?.model);
      return model?.supportedReasoningEfforts.some((e) => e.reasoningEffort === p.reasoning_effort)
        ? [{ model: p.model, effort: p.reasoning_effort }]
        : [];
    });
    const unique = [...new Map(presets.map((p) => [`${p.model}:${p.effort}`, p])).values()];
    if (unique.length >= 3) return unique;
  }
  return [];
}
export function desktopModelDataPath({
  platform = process.platform,
  env = process.env,
  home = homedir(),
  exists = existsSync,
  findPackage = findWindowsCodexPackage,
} = {}) {
  if (env.CODEX_ELECTRON_USER_DATA_PATH) return env.CODEX_ELECTRON_USER_DATA_PATH;
  if (platform === "darwin") return join(home, "Library/Application Support/Codex");
  if (platform !== "win32") return undefined;
  const standard = win32.join(env.APPDATA || win32.join(home, "AppData", "Roaming"), "Codex");
  if (exists(win32.join(standard, "statsig-state.json"))) return standard;
  const family = findPackage()?.appUserModelId?.split("!")[0];
  if (!family || !/^OpenAI\.Codex_[a-z0-9]+$/.test(family)) return undefined;
  const packaged = win32.join(
    env.LOCALAPPDATA || win32.join(home, "AppData", "Local"),
    "Packages",
    family,
    "LocalCache",
    "Roaming",
    "Codex",
  );
  return exists(win32.join(packaged, "statsig-state.json")) ? packaged : undefined;
}
export async function readDesktopPresets(models, { userDataPath = desktopModelDataPath() } = {}) {
  if (!userDataPath) return [];
  try {
    const stableId = JSON.parse(await readFile(join(userDataPath, "statsig-state.json"), "utf8"))[
      "statsig-stable-id"
    ];
    if (typeof stableId !== "string" || !stableId) return [];
    const directory = join(userDataPath, "Default/Local Storage/leveldb");
    const names = (await readdir(directory)).filter((n) => /^\d+\.(ldb|log)$/.test(n));
    if (names.length > 128) return [];
    const latest = new Map();
    let total = 0;
    for (const name of names) {
      const path = join(directory, name),
        size = (await stat(path)).size;
      total += size;
      if (size > limit || total > limit * 2) return [];
      const buffer = await readFile(path);
      for (const entry of name.endsWith(".ldb") ? tableRecords(buffer) : logRecords(buffer)) {
        if (!entry.key.includes(Buffer.from("statsig.cached."))) continue;
        const key = entry.key.toString("hex"),
          old = latest.get(key);
        if (!old || old.sequence < entry.sequence) latest.set(key, entry);
      }
    }
    const caches = [];
    for (const { value, deleted } of latest.values()) {
      if (deleted || (value[0] !== 0 && value[0] !== 1)) continue;
      try {
        caches.push(JSON.parse(value.subarray(1).toString(value[0] === 0 ? "utf16le" : "utf8")));
      } catch {
        /* Unrelated caches are not model configuration. */
      }
    }
    return selectDesktopPresets(caches, stableId, models);
  } catch {
    return [];
  }
}
