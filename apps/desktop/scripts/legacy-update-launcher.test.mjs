import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeLegacyUpdateLauncher } from "./legacy-update-launcher.mjs";

for (const name of ["taskboard-desktop", "lark-codex-desktop"])
  test(
    `macOS ${name} forwards every argument to the renamed app`,
    { skip: process.platform !== "darwin" ? "Legacy .app launcher is macOS-only" : false },
    (t) => {
      const root = mkdtempSync(join(tmpdir(), "codexboard-launcher-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const contents = join(root, "path with spaces.app/Contents");
      mkdirSync(join(contents, "MacOS"), { recursive: true });
      const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
      writeFileSync(
        join(contents, "MacOS/codexboard-desktop"),
        `#!/bin/sh\nexec ${quote(process.execPath)} -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@"\n`,
        { mode: 0o755 },
      );
      const launcher = writeLegacyUpdateLauncher(contents, name);
      const stat = lstatSync(launcher);
      assert.equal(stat.isFile(), true);
      assert.equal(stat.mode & 0o777, 0o755);
      const args = ["--lark-codex-updated", "space value", "", "$(not-a-command)"];
      const result = spawnSync(launcher, args, { encoding: "utf8", env: { PATH: "" } });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), args);
    },
  );
