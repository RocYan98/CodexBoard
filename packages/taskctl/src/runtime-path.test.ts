import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runtimeDataDirectory } from "./runtime-path.js";

it("uses cwd/.data for source commands and preserves explicit empty new settings", () => {
  expect(runtimeDataDirectory({}, "/fake/home", "/fake/project")).toBe(
    join("/fake/project", ".data"),
  );
  expect(() =>
    runtimeDataDirectory({ CODEXBOARD_DATA_DIR: "", LARK_TASKBOARD_DATA_DIR: "/old" }),
  ).toThrow("CODEXBOARD_DATA_DIR 不能为空");
});

it("maps only the moved legacy default when its old directory is absent and new runtime exists", () => {
  const home = mkdtempSync(join(tmpdir(), "codexboard-runtime-path-"));
  const old = join(home, "Library/Application Support/Lark Codex Taskboard/data");
  const current = join(home, "Library/Application Support/CodexBoard/data");
  const environment = { LARK_TASKBOARD_DATA_DIR: old };
  try {
    expect(runtimeDataDirectory(environment, home)).toBe(old);
    mkdirSync(join(current, "run"), { recursive: true });
    writeFileSync(join(current, "run/runtime.json"), "{}");
    expect(runtimeDataDirectory(environment, home)).toBe(current);
    expect(runtimeDataDirectory({ ...environment, CODEXBOARD_DATA_DIR: old }, home)).toBe(old);
    expect(runtimeDataDirectory({ LARK_TASKBOARD_DATA_DIR: join(home, "custom") }, home)).toBe(
      join(home, "custom"),
    );
    mkdirSync(old, { recursive: true });
    expect(runtimeDataDirectory(environment, home)).toBe(old);
    rmSync(old, { recursive: true });
    symlinkSync(join(home, "missing"), old);
    expect(runtimeDataDirectory(environment, home)).toBe(old);
    rmSync(old);
    rmSync(join(current, "run/runtime.json"));
    symlinkSync(join(home, "missing"), join(current, "run/runtime.json"));
    expect(runtimeDataDirectory(environment, home)).toBe(old);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("follows the last published default path only after migration has completed", () => {
  const home = mkdtempSync(join(tmpdir(), "codexboard-latest-migration-"));
  const old = join(home, "Library/Application Support/Lark-Codex/data");
  const current = join(home, "Library/Application Support/CodexBoard/data");
  try {
    mkdirSync(join(current, "run"), { recursive: true });
    writeFileSync(join(current, "run/runtime.json"), "{}");
    expect(runtimeDataDirectory({ LARK_CODEX_DATA_DIR: old }, home)).toBe(current);
    expect(runtimeDataDirectory({ CODEXBOARD_DATA_DIR: old }, home)).toBe(old);
    mkdirSync(old, { recursive: true });
    expect(runtimeDataDirectory({ LARK_CODEX_DATA_DIR: old }, home)).toBe(old);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
