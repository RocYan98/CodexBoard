import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { copyCargoLicenses } from "./cargo-licenses.mjs";

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function fixture(t) {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "taskboard-cargo-licenses-")));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const root = join(project, "apps/desktop/src-tauri");
  const rootManifest = `[package]\nname = "fixture-app"\nversion = "1.0.0"\nedition = "2021"\n[dependencies]\nruntime-lib = { path = "deps/runtime" }\nproc-helper = { path = "deps/proc" }\n[build-dependencies]\nbuild-only = { path = "deps/build" }\n[dev-dependencies]\ndev-only = { path = "deps/dev" }\n[target.'cfg(windows)'.dependencies]\nwindows-only = { path = "deps/windows" }\n`;
  write(join(root, "Cargo.toml"), rootManifest);
  write(join(root, "src/lib.rs"), "");
  for (const [directory, name, extra] of [
    ["runtime", "runtime-lib", '[dependencies]\nnested-lib = { path = "../nested" }\n'],
    ["nested", "nested-lib", ""],
    ["proc", "proc-helper", "[lib]\nproc-macro = true\n"],
    ["build", "build-only", ""],
    ["dev", "dev-only", ""],
    ["windows", "windows-only", ""],
  ]) {
    write(
      join(root, "deps", directory, "Cargo.toml"),
      `[package]\nname = "${name}"\nversion = "1.0.0"\nedition = "2021"\nlicense = "MIT"\nrepository = "https://example.invalid/${name}"\n${extra}`,
    );
    write(join(root, "deps", directory, "src/lib.rs"), "");
  }
  write(join(root, "deps/runtime/LICENSE_MIT"), "Runtime fixture license\n");
  write(join(root, "deps/runtime/NOTICE"), "Runtime attribution\n");
  write(join(root, "deps/runtime/src/copying.rs"), "// This is source, not a license.\n");
  write(join(root, "deps/nested/COPYING"), "Nested fixture license\n");
  const lock = () => {
    const result = spawnSync(
      "cargo",
      ["generate-lockfile", "--manifest-path", join(root, "Cargo.toml"), "--offline"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
  };
  lock();
  return { project, root, rootManifest, lock, runtime: join(project, "runtime") };
}

test("Cargo selects only the target runtime graph and preserves license text without local paths", (t) => {
  const { project, root, runtime } = fixture(t);
  write(join(runtime, "licenses/npm/keep.txt"), "Other inventory\n");
  assert.deepEqual(copyCargoLicenses(project, runtime), { packageCount: 2, fileCount: 3 });
  const text = readFileSync(join(runtime, "licenses/cargo/index.json"), "utf8");
  assert.equal(text.includes(project), false);
  const index = JSON.parse(text);
  assert.deepEqual(
    index.packages.map((entry) => entry.name),
    ["nested-lib", "runtime-lib"],
  );
  const files = index.packages.flatMap((entry) => entry.files);
  assert.deepEqual(
    files.map((entry) => entry.path),
    ["nested-lib/1.0.0/COPYING", "runtime-lib/1.0.0/LICENSE_MIT", "runtime-lib/1.0.0/NOTICE"],
  );
  for (const file of files) {
    const contents = readFileSync(join(runtime, "licenses/cargo", file.path));
    assert.equal(createHash("sha256").update(contents).digest("hex"), file.sha256);
  }
  assert.deepEqual(
    readFileSync(join(runtime, "licenses/cargo/runtime-lib/1.0.0/LICENSE_MIT")),
    readFileSync(join(root, "deps/runtime/LICENSE_MIT")),
  );
  assert.equal(readFileSync(join(runtime, "licenses/npm/keep.txt"), "utf8"), "Other inventory\n");
});

test("Cargo fails for NOTICE or similarly named source files without license text", (t) => {
  const { project, root, runtime } = fixture(t);
  rmSync(join(root, "deps/runtime/LICENSE_MIT"));
  write(join(runtime, "licenses/cargo/previous.txt"), "Previous inventory\n");
  assert.throws(
    () => copyCargoLicenses(project, runtime),
    /缺少对应版本的 Cargo 许可正文：runtime-lib@1\.0\.0/,
  );
  assert.equal(
    readFileSync(join(runtime, "licenses/cargo/previous.txt"), "utf8"),
    "Previous inventory\n",
  );
});

test("Cargo supplements require the exact crate version, license, repository and source commit", (t) => {
  const { project, root, rootManifest, lock, runtime } = fixture(t);
  write(
    join(root, "Cargo.toml"),
    rootManifest.replace(
      'runtime-lib = { path = "deps/runtime" }',
      'block2 = { path = "deps/runtime" }',
    ),
  );
  write(
    join(root, "deps/runtime/Cargo.toml"),
    '[package]\nname = "block2"\nversion = "0.6.2"\nedition = "2021"\nlicense = "MIT"\nrepository = "https://github.com/madsmtm/objc2"\n',
  );
  rmSync(join(root, "deps/runtime/LICENSE_MIT"));
  const vcs = join(root, "deps/runtime/.cargo_vcs_info.json");
  write(vcs, JSON.stringify({ git: { sha1: "b4167b582b2f75f9a1be75495c41b765344fd03c" } }));
  lock();
  assert.deepEqual(copyCargoLicenses(project, runtime), { packageCount: 1, fileCount: 3 });
  const index = JSON.parse(readFileSync(join(runtime, "licenses/cargo/index.json"), "utf8"));
  assert.equal(index.packages[0].supplemented, true);
  assert.ok(
    index.packages[0].files.some(
      (file) =>
        file.path.endsWith("STANDARD-MIT.txt") &&
        file.source.includes("spdx/license-list-data/16f3aa6"),
    ),
  );
  write(vcs, JSON.stringify({ git: { sha1: "0".repeat(40) } }));
  assert.throws(
    () => copyCargoLicenses(project, runtime),
    /缺少对应版本的 Cargo 许可正文：block2@0\.6\.2/,
  );
});

test("Cargo fails without silently updating a stale lockfile", (t) => {
  const { project, root, rootManifest, runtime } = fixture(t);
  const previous = readFileSync(join(root, "Cargo.lock"));
  write(join(root, "Cargo.toml"), rootManifest.replace('version = "1.0.0"', 'version = "1.0.1"'));
  assert.throws(() => copyCargoLicenses(project, runtime), /无法读取 Cargo 锁定依赖/);
  assert.deepEqual(readFileSync(join(root, "Cargo.lock")), previous);
  assert.equal(existsSync(join(runtime, "licenses/cargo")), false);
});

test("Windows Cargo runtime includes exact WebView2 license supplements", (t) => {
  const { project, root, runtime, lock } = fixture(t);
  write(
    join(root, "deps/windows/Cargo.toml"),
    '[package]\nname = "webview2-com-sys"\nversion = "0.38.2"\nedition = "2021"\nlicense = "MIT"\nrepository = "https://github.com/wravery/webview2-rs"\n',
  );
  const manifest = join(root, "Cargo.toml");
  write(manifest, readFileSync(manifest, "utf8").replace("windows-only =", "webview2-com-sys ="));
  const vcs = join(root, "deps/windows/.cargo_vcs_info.json");
  write(vcs, JSON.stringify({ git: { sha1: "b74dc5e2b394044bea5191052868ce7a106c202c" } }));
  lock();
  assert.deepEqual(copyCargoLicenses(project, runtime, "x86_64-pc-windows-msvc"), {
    packageCount: 3,
    fileCount: 4,
  });
  const index = JSON.parse(readFileSync(join(runtime, "licenses/cargo/index.json"), "utf8"));
  assert.equal(index.target, "x86_64-pc-windows-msvc");
  const entry = index.packages.find((crate) => crate.name === "webview2-com-sys");
  assert.equal(entry.supplemented, true);
  assert.equal(
    entry.files[0].sha256,
    "0dcf41516e608bbcb6cdc5229feb7b86fe4a643b85e7df251133c93408fdac73",
  );
  write(vcs, JSON.stringify({ git: { sha1: "0".repeat(40) } }));
  assert.throws(
    () => copyCargoLicenses(project, runtime, "x86_64-pc-windows-msvc"),
    /缺少对应版本的 Cargo 许可正文：webview2-com-sys@0\.38\.2/,
  );
});
