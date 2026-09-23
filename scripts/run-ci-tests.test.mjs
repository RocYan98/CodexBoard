import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runSuite } from "./run-ci-tests.mjs";

function fixture(t) {
  const rootDirectory = realpathSync(mkdtempSync(join(tmpdir(), "codexboard-ci-runner-test-")));
  t.after(() => rmSync(rootDirectory, { recursive: true, force: true }));
  const outputDirectory = (suite) => join(rootDirectory, "test-results", "windows", suite);
  function write(name, content) {
    const path = join(rootDirectory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return { rootDirectory, outputDirectory, write };
}

test("Vitest suite preserves failures, captures both streams and uses an isolated Codex home", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.rootDirectory, "packages", "contracts"), { recursive: true });
  f.write(
    "node_modules/vitest/vitest.mjs",
    `import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
assert.ok(process.argv.includes("run"));
assert.ok(process.argv.includes("--reporter=default"));
assert.ok(process.argv.includes("--reporter=junit"));
assert.equal(process.cwd(), ${JSON.stringify(join(f.rootDirectory, "packages", "contracts"))});
assert.equal(process.env.CODEX_HOME, join(process.env.HOME, ".codex"));
assert.equal(process.env.CODEXBOARD_DATA_DIR, undefined);
assert.equal(process.env.LARK_CODEX_DATA_DIR, undefined);
assert.equal(process.env.LARK_TASKBOARD_DATA_DIR, undefined);
assert.equal(process.env.FAKE_CODEX_HOME, undefined);
assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, ${JSON.stringify(join(f.rootDirectory, "browser-cache"))});
assert.equal(process.env.CARGO_HOME, ${JSON.stringify(join(f.rootDirectory, "cargo-home"))});
assert.equal(process.env.RUSTUP_HOME, ${JSON.stringify(join(f.rootDirectory, "rustup-home"))});
console.log(JSON.stringify({ home: process.env.HOME, codexHome: process.env.CODEX_HOME }));
console.error("fixture stderr");
const report = process.argv.find((arg) => arg.startsWith("--outputFile.junit="));
writeFileSync(report.slice("--outputFile.junit=".length), '<testsuites tests="1" failures="1"/>');
process.exitCode = 7;
`,
  );
  f.write("scripts/run-ci-tests.mjs", readFileSync(new URL("./run-ci-tests.mjs", import.meta.url)));
  const execution = spawnSync(
    process.execPath,
    [join(f.rootDirectory, "scripts", "run-ci-tests.mjs"), "contracts"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: "must-not-inherit",
        CODEXBOARD_DATA_DIR: "must-not-inherit",
        LARK_CODEX_DATA_DIR: "must-not-inherit",
        LARK_TASKBOARD_DATA_DIR: "must-not-inherit",
        FAKE_CODEX_HOME: "must-not-inherit",
        PLAYWRIGHT_BROWSERS_PATH: join(f.rootDirectory, "browser-cache"),
        CARGO_HOME: join(f.rootDirectory, "cargo-home"),
        RUSTUP_HOME: join(f.rootDirectory, "rustup-home"),
      },
    },
  );
  assert.equal(execution.status, 7, execution.stderr);
  const output = f.outputDirectory("contracts");
  const result = JSON.parse(readFileSync(join(output, "result.json"), "utf8"));
  assert.equal(result.exitCode, 7);
  assert.equal(result.status, "failed");
  const isolated = JSON.parse(readFileSync(join(output, "stdout.log"), "utf8"));
  assert.notEqual(isolated.home, process.env.HOME);
  assert.equal(existsSync(isolated.home), false, "temporary home is removed after the suite");
  assert.equal(readFileSync(join(output, "stderr.log"), "utf8"), "fixture stderr\n");
  assert.deepEqual(JSON.parse(readFileSync(join(output, "result.json"), "utf8")), result);
  assert.equal(result.os, process.platform);
  assert.equal(result.arch, process.arch);
  assert.equal(result.node, process.version);
});

test("Node suite discovers every test file without shell glob expansion", async (t) => {
  const f = fixture(t);
  f.write(
    "scripts/first.test.mjs",
    'import test from "node:test"; test("first fixture", () => {});',
  );
  f.write(
    "scripts/second with spaces.test.mjs",
    'import test from "node:test"; test("second fixture", () => { throw Error("intentional failure"); });',
  );
  f.write("scripts/not-a-test.mjs", 'throw Error("must not be executed");');
  const result = await runSuite("scripts", { rootDirectory: f.rootDirectory });
  assert.equal(result.exitCode, 1);
  assert.equal(result.status, "failed");
  const junit = readFileSync(join(f.outputDirectory("scripts"), "junit.xml"), "utf8");
  assert.match(junit, /first fixture/);
  assert.match(junit, /second fixture/);
  assert.doesNotMatch(junit, /must not be executed/);
});

test("desktop Node suite reports success", async (t) => {
  const f = fixture(t);
  f.write(
    "apps/desktop/scripts/success.test.mjs",
    'import test from "node:test"; test("desktop fixture", () => {});',
  );
  const result = await runSuite("desktop-scripts", { rootDirectory: f.rootDirectory });
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, "passed");
});

test("Node timeout reports hanging tests and leaked handles as failures", async (t) => {
  const f = fixture(t);
  f.write(
    "scripts/pending.test.mjs",
    'import test from "node:test"; test("pending fixture", async () => { setInterval(() => {}, 100); await new Promise(() => {}); });',
  );
  f.write(
    "scripts/leaked-handle.test.mjs",
    'import test from "node:test"; test("passing fixture with leaked handle", () => { setInterval(() => {}, 100); });',
  );
  const result = await runSuite("scripts", { rootDirectory: f.rootDirectory, testTimeoutMs: 1000 });
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.status, "failed");
  const output = f.outputDirectory("scripts");
  const junit = readFileSync(join(output, "junit.xml"), "utf8");
  assert.match(junit, /pending\.test\.mjs/);
  assert.match(junit, /leaked-handle\.test\.mjs/);
  assert.equal((junit.match(/<failure type="testTimeoutFailure"/g) ?? []).length, 2);
  assert.ok(result.finishedAt);
  assert.deepEqual(JSON.parse(readFileSync(join(output, "result.json"), "utf8")), result);
});

test("a child that cannot start leaves a failing result and JUnit report", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.rootDirectory, "packages", "contracts"), { recursive: true });
  const result = await runSuite("contracts", {
    rootDirectory: f.rootDirectory,
    nodeExecutable: join(f.rootDirectory, "missing-node-executable"),
  });
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.status, "error");
  assert.match(result.error, /ENOENT/);
  assert.match(
    readFileSync(join(f.outputDirectory("contracts"), "junit.xml"), "utf8"),
    /failures="1"/,
  );
});

test("missing tests and a missing JUnit report cannot silently pass", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.rootDirectory, "scripts"));
  const empty = await runSuite("scripts", { rootDirectory: f.rootDirectory });
  assert.equal(empty.status, "error");
  assert.equal(empty.exitCode, 1);
  mkdirSync(join(f.rootDirectory, "packages", "contracts"), { recursive: true });
  f.write("node_modules/vitest/vitest.mjs", "process.exitCode = 0;");
  const missingReport = await runSuite("contracts", { rootDirectory: f.rootDirectory });
  assert.equal(missingReport.status, "error");
  assert.equal(missingReport.exitCode, 1);
  assert.match(missingReport.error, /without producing its JUnit report/);
});

test("invalid suite names cannot select arbitrary report paths", async (t) => {
  const f = fixture(t);
  await assert.rejects(runSuite("../../outside", { rootDirectory: f.rootDirectory }), /Unknown/);
  assert.equal(existsSync(join(f.rootDirectory, "test-results")), false);
  const execution = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./run-ci-tests.mjs", import.meta.url)), "invalid"],
    { encoding: "utf8" },
  );
  assert.equal(execution.status, 2);
  assert.match(execution.stderr, /Usage:/);
});

test("report directory links cannot redirect output outside the checkout", async (t) => {
  const f = fixture(t);
  const target = join(f.rootDirectory, "untouched");
  mkdirSync(target);
  writeFileSync(join(target, "marker"), "keep");
  symlinkSync(
    target,
    join(f.rootDirectory, "test-results"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    runSuite("contracts", { rootDirectory: f.rootDirectory }),
    /must be a real directory/,
  );
  assert.equal(readFileSync(join(target, "marker"), "utf8"), "keep");
  assert.equal(existsSync(join(target, "windows")), false);
});
