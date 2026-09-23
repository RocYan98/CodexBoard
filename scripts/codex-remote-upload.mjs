import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  assertPrivateFileSync,
  ensurePrivateDirectorySync,
  ensurePrivateFileSync,
} from "./private-file-permissions.mjs";

import { REMOTE_UPLOAD_MAX_BYTES } from "@codexboard/contracts";
const maxBytes = REMOTE_UPLOAD_MAX_BYTES;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const validName = (name) =>
  typeof name === "string" &&
  name.length > 0 &&
  name.length <= 220 &&
  ![...name].some(
    (char) =>
      char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === "/" || char === "\\",
  ) &&
  name !== "." &&
  name !== "..";
const hash = (data) => createHash("sha256").update(data).digest("hex");
function directory(home, ownerKey, id) {
  if (!/^[a-f0-9]{64}$/.test(ownerKey ?? "") || !uuid.test(id ?? ""))
    throw new Error("附件编号无效");
  return join(home, "taskboard", "remote-uploads", ownerKey, id);
}
async function regular(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error("附件不可用");
  assertPrivateFileSync(path);
  return readFile(path);
}
function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString())) return "image/gif";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP")
    return "image/webp";
  return null;
}

// This is plain file staging. It never opens a thread or invokes an App Server.
export async function storeRemoteUpload(home, { ownerKey, id, name, mimeType, base64 }) {
  const dir = directory(home, ownerKey, id);
  if (
    !validName(name) ||
    typeof base64 !== "string" ||
    base64.length > Math.ceil(maxBytes / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
  )
    throw new Error("附件名称或内容无效");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64) throw new Error("附件内容无效");
  if (!bytes.length || bytes.length > maxBytes) throw new Error("单个附件须为 1 字节至 64 MiB");
  const detected = imageMime(bytes);
  const metadata = {
    id,
    name,
    mimeType:
      detected ??
      (typeof mimeType === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(mimeType)
        ? mimeType
        : "application/octet-stream"),
    size: bytes.length,
    sha256: hash(bytes),
    image: !!detected,
  };
  ensurePrivateDirectorySync(join(home, "taskboard", "remote-uploads", ownerKey));
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const [existing] = await resolveRemoteUploads(home, { ownerKey, attachments: [id] });
    if (existing.sha256 !== metadata.sha256 || existing.name !== name)
      throw new Error("附件编号已使用，请重新选择文件", { cause: error });
    return { id, name, mimeType: existing.mimeType, size: existing.size };
  }
  ensurePrivateDirectorySync(dir);
  const storageName = "attachment";
  await writeFile(join(dir, storageName), bytes, { flag: "wx", mode: 0o600 });
  ensurePrivateFileSync(join(dir, storageName));
  await writeFile(join(dir, "metadata.json"), JSON.stringify({ ...metadata, storageName }), {
    flag: "wx",
    mode: 0o600,
  });
  ensurePrivateFileSync(join(dir, "metadata.json"));
  return { id, name, mimeType: metadata.mimeType, size: metadata.size };
}

export async function resolveRemoteUploads(home, { ownerKey, attachments = [] }) {
  if (
    !Array.isArray(attachments) ||
    attachments.length > 8 ||
    new Set(attachments).size !== attachments.length
  )
    throw new Error("附件数量无效");
  const files = [];
  for (const id of attachments) {
    const dir = directory(home, ownerKey, id);
    if (!(await lstat(dir)).isDirectory()) throw new Error("附件不可用");
    const meta = JSON.parse((await regular(join(dir, "metadata.json"))).toString());
    if (!validName(meta.storageName) || !validName(meta.name)) throw new Error("附件不可用");
    const path = join(dir, meta.storageName);
    const bytes = await regular(path);
    if (hash(bytes) !== meta.sha256 || bytes.length !== meta.size)
      throw new Error("附件已改变，请重新上传");
    files.push({ ...meta, path, image: !!imageMime(bytes) });
  }
  return files;
}

export async function readRemoteUploadImage(home, { ownerKey, id }) {
  const [file] = await resolveRemoteUploads(home, { ownerKey, attachments: [id] });
  const bytes = await regular(file.path);
  const mimeType = imageMime(bytes);
  if (!mimeType || hash(bytes) !== file.sha256) throw new Error("图片附件不可用");
  return { mimeType, base64: bytes.toString("base64") };
}
