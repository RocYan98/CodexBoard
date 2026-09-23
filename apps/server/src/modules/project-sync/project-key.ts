import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

const LETTER_COUNT = 26n;
const CHECKSUM_SPACE = LETTER_COUNT ** 5n;
const COLLISION_SPACE = 26 ** 3;
const PROJECT_KEY_PATTERN = /^[A-Z]{1,5}$/;
const RESERVED_PROJECT_KEYS = new Set(["TEMP"]);

function pathSyntax(root: string) {
  return /^[A-Za-z]:[\\/]|^\\\\/.test(root) ? win32 : posix;
}

function normalizedRoot(primaryRoot: string): string {
  const syntax = pathSyntax(primaryRoot);
  if (!primaryRoot || !syntax.isAbsolute(primaryRoot)) {
    throw new Error("项目根目录必须是绝对路径");
  }
  const native = syntax.normalize(primaryRoot.normalize("NFC"));
  const normalized = syntax === win32 ? native.toLowerCase() : native;
  const filesystemRoot = syntax.parse(normalized).root;
  return normalized.length > filesystemRoot.length
    ? normalized.replace(/[\\/]+$/u, "")
    : normalized;
}

function checksumLetters(input: string): string {
  let value = createHash("sha256").update(input).digest().readBigUInt64BE(0) % CHECKSUM_SPACE;
  const letters = Array.from({ length: 5 }, () => "A");
  for (let index = letters.length - 1; index >= 0; index -= 1) {
    letters[index] = String.fromCharCode(65 + Number(value % LETTER_COUNT));
    value /= LETTER_COUNT;
  }
  return letters.join("");
}

function readablePrefix(root: string, checksum: string): string {
  const basenameLetters = pathSyntax(root)
    .basename(root)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^A-Za-z]/gu, "")
    .toUpperCase();
  return `${basenameLetters}${checksum}`.slice(0, 2);
}

function available(candidate: string, occupied: ReadonlySet<string>): boolean {
  return !RESERVED_PROJECT_KEYS.has(candidate) && !occupied.has(candidate);
}

function collisionSuffix(value: number): string {
  let remaining = value;
  const letters = Array.from({ length: 3 }, () => "A");
  for (let index = letters.length - 1; index >= 0; index -= 1) {
    letters[index] = String.fromCharCode(65 + (remaining % 26));
    remaining = Math.floor(remaining / 26);
  }
  return letters.join("");
}

function collisionValue(suffix: string): number {
  return [...suffix].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 65, 0);
}

export function allocateProjectKey(primaryRoot: string, occupiedKeys: ReadonlySet<string>): string {
  const root = normalizedRoot(primaryRoot);
  const checksum = checksumLetters(root);
  const prefix = readablePrefix(root, checksum);
  const occupied = new Set([...occupiedKeys].map((key) => key.toUpperCase()));
  const shortCandidate = `${prefix}${checksum.slice(-2)}`;
  if (available(shortCandidate, occupied)) return shortCandidate;

  const start = collisionValue(checksum.slice(-3));
  for (let offset = 0; offset < COLLISION_SPACE; offset += 1) {
    const candidate = `${prefix}${collisionSuffix((start + offset) % COLLISION_SPACE)}`;
    if (available(candidate, occupied)) return candidate;
  }
  throw new Error("项目 Key 可用空间已耗尽");
}

export function formatTaskIdentifier(projectKey: string, taskNumber: number): string {
  if (!PROJECT_KEY_PATTERN.test(projectKey)) {
    throw new Error("项目 Key 格式无效");
  }
  if (!Number.isInteger(taskNumber) || taskNumber <= 0) {
    throw new Error("任务编号必须是正整数");
  }
  return `${projectKey}-${String(taskNumber).padStart(3, "0")}`;
}
