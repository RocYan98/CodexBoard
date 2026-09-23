import { remoteTurnItems } from "@codexboard/contracts";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";

const MAX_BYTES = 8 * 1024 * 1024;
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function mime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString())) return "image/gif";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP")
    return "image/webp";
  throw new Error("此图片格式暂不支持预览");
}

// A caller supplies an item ID, never an arbitrary host path. Resolve the image
// exclusively from the Desktop snapshot of that same authorized conversation.
export async function readRemoteImage(snapshot, { itemId, imageIndex }) {
  if (
    typeof itemId !== "string" ||
    !itemId ||
    itemId.length > 300 ||
    !Number.isInteger(imageIndex) ||
    imageIndex < 0 ||
    imageIndex > 100
  )
    throw new Error("图片编号无效");
  const state = record(snapshot),
    history = record(state.turnHistory);
  const turns =
    history.kind === "canonical"
      ? Object.values(record(record(history.history).entitiesByKey))
      : state.turns;
  const turnList = Array.isArray(turns) ? turns : [];
  // A thumbnail can request its provisional ID after the canonical item arrives.
  const opening = turnList.find(
    (turn) => typeof turn.turnId === "string" && `remote-input:${turn.turnId}` === itemId,
  );
  const item =
    turnList.flatMap(remoteTurnItems).find((i) => i.id === itemId) ??
    (opening ? { type: "userMessage", content: record(opening.params).input } : undefined);
  const sources =
    item?.type === "imageView"
      ? [item]
      : ["userMessage", "steeringUserMessage"].includes(item?.type)
        ? (item.content ?? item.input ?? []).filter((c) => ["image", "localImage"].includes(c.type))
        : [];
  const source = sources[imageIndex];
  if (!source) throw new Error("图片不在此对话中");
  let bytes;
  if (typeof source.path === "string" && isAbsolute(source.path)) {
    // O_NOFOLLOW is unavailable on Windows. Check the entry and the opened
    // handle before reading, so a symlink or a replaced path cannot be used.
    const entry = await lstat(source.path);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("图片暂不支持预览");
    const file = await open(
      source.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      const checked = await lstat(source.path);
      if (
        !stat.isFile() ||
        stat.size === 0 ||
        stat.size > MAX_BYTES ||
        stat.ino !== entry.ino ||
        stat.dev !== entry.dev ||
        checked.isSymbolicLink() ||
        checked.ino !== stat.ino ||
        checked.dev !== stat.dev
      )
        throw new Error("图片暂不支持预览");
      bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw new Error("图片内容已变化");
        offset += bytesRead;
      }
    } finally {
      await file.close();
    }
  } else if (
    typeof source.url === "string" &&
    source.url.length <= Math.ceil((MAX_BYTES * 4) / 3) + 100
  ) {
    const match = source.url.match(/^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new Error("此图片来源暂不支持预览");
    bytes = Buffer.from(match[1], "base64");
    if (bytes.length > MAX_BYTES) throw new Error("图片过大");
  } else throw new Error("此图片来源暂不支持预览");
  return { mimeType: mime(bytes), base64: bytes.toString("base64") };
}
