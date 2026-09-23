import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { arch, constants, homedir, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const suites = {
  contracts: "packages/contracts",
  taskctl: "packages/taskctl",
  server: "apps/server",
  web: "apps/web",
  scripts: "scripts",
  "desktop-scripts": "apps/desktop/scripts",
};
const reportFiles = ["junit.xml", "stdout.log", "stderr.log", "result.json"];

function prepareReports(rootDirectory, suite) {
  let directory = rootDirectory;
  for (const segment of ["test-results", "windows", suite]) {
    directory = join(directory, segment);
    try {
      mkdirSync(directory);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const entry = lstatSync(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Report directory must be a real directory: ${directory}`);
    }
  }
  for (const name of reportFiles) {
    const path = join(directory, name);
    try {
      const entry = lstatSync(path);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`Report output must be a regular file: ${path}`);
      }
      rmSync(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return directory;
}

function isolatedEnvironment(home) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(CODEX_|CODEXBOARD_|LARK_CODEX_|LARK_TASKBOARD_|FAKE_CODEX_|HOME$|USERPROFILE$|APPDATA$|LOCALAPPDATA$|XDG_|NODE_TEST_CONTEXT$)/i.test(
          key,
        ),
    ),
  );
  const directories = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    CODEX_HOME: join(home, ".codex"),
  };
  for (const directory of Object.values(directories)) mkdirSync(directory, { recursive: true });
  return {
    ...environment,
    ...directories,
    // Git expands Windows 8.3 temp aliases. Give fixtures the same native path.
    ...(process.platform === "win32"
      ? { TEMP: realpathSync.native(tmpdir()), TMP: realpathSync.native(tmpdir()) }
      : {}),
    // rustup needs the installed toolchain even though test configuration is isolated.
    CARGO_HOME: environment.CARGO_HOME ?? join(homedir(), ".cargo"),
    RUSTUP_HOME: environment.RUSTUP_HOME ?? join(homedir(), ".rustup"),
    CI: "true",
  };
}

function suiteCommand(rootDirectory, suite, outputDirectory, testTimeoutMs) {
  const cwd = join(rootDirectory, suites[suite]);
  const junit = join(outputDirectory, "junit.xml");
  if (suite === "scripts" || suite === "desktop-scripts") {
    const tests = readdirSync(cwd, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
      .map((entry) => join(cwd, entry.name))
      .sort();
    if (tests.length === 0) throw new Error(`No test files found for suite ${suite}`);
    return {
      cwd: rootDirectory,
      args: [
        "--test",
        ...(process.platform === "win32" ? ["--test-concurrency=4"] : []),
        `--test-timeout=${testTimeoutMs}`,
        "--test-reporter=spec",
        "--test-reporter-destination=stdout",
        "--test-reporter=junit",
        `--test-reporter-destination=${junit}`,
        ...tests,
      ],
    };
  }
  return {
    cwd,
    args: [
      join(rootDirectory, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "--reporter=default",
      "--reporter=junit",
      `--outputFile.junit=${junit}`,
    ],
  };
}

function xmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[character];
  });
}

// Options are only for isolated runner tests; the CLI always uses this checkout and Node.
export async function runSuite(
  suite,
  {
    rootDirectory = projectRoot,
    nodeExecutable = process.execPath,
    // Desktop Skill cases perform real Windows ACL checks in isolated PowerShell
    // processes. Keep a bounded file budget without disabling those checks.
    testTimeoutMs = process.platform === "win32" && suite === "desktop-scripts" ? 300_000 : 120_000,
  } = {},
) {
  if (!Object.hasOwn(suites, suite)) throw new Error(`Unknown test suite: ${suite}`);
  rootDirectory = resolve(rootDirectory);
  const outputDirectory = prepareReports(rootDirectory, suite);
  const stdout = openSync(join(outputDirectory, "stdout.log"), "w");
  const stderr = openSync(join(outputDirectory, "stderr.log"), "w");
  const startedAt = new Date();
  const result = {
    os: platform(),
    arch: arch(),
    node: process.version,
    suite,
    testTimeoutMs: suite === "scripts" || suite === "desktop-scripts" ? testTimeoutMs : null,
    status: "running",
    startedAt: startedAt.toISOString(),
    exitCode: null,
    signal: null,
  };
  let home;
  try {
    writeFileSync(join(outputDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    home = mkdtempSync(join(realpathSync.native(tmpdir()), `codexboard-ci-${suite}-`));
    const environment = isolatedEnvironment(home);
    const { cwd, args } = suiteCommand(rootDirectory, suite, outputDirectory, testTimeoutMs);
    const execution = await new Promise((complete) => {
      let spawnError;
      const child = spawn(nodeExecutable, args, {
        cwd,
        env: environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk) => {
        writeSync(stdout, chunk);
        process.stdout.write(chunk);
      });
      child.stderr.on("data", (chunk) => {
        writeSync(stderr, chunk);
        process.stderr.write(chunk);
      });
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("close", (code, signal) => complete({ code, signal, error: spawnError }));
    });
    result.signal = execution.signal;
    if (execution.error) throw execution.error;
    result.exitCode =
      execution.code ??
      (execution.signal && constants.signals[execution.signal]
        ? 128 + constants.signals[execution.signal]
        : 1);
    result.status = result.exitCode === 0 ? "passed" : "failed";
    if (!existsSync(join(outputDirectory, "junit.xml"))) {
      throw new Error(`Suite ${suite} exited without producing its JUnit report`);
    }
  } catch (error) {
    result.status = "error";
    result.exitCode = result.exitCode || 1;
    result.error = error.message;
    const message = `CI test runner: ${error.message}\n`;
    writeSync(stderr, message);
    process.stderr.write(message);
    if (!existsSync(join(outputDirectory, "junit.xml"))) {
      writeFileSync(
        join(outputDirectory, "junit.xml"),
        `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="1" failures="1"><testsuite name="${xmlEscape(suite)}" tests="1" failures="1"><testcase name="CI test runner"><failure message="${xmlEscape(error.message)}"/></testcase></testsuite></testsuites>\n`,
      );
    }
  } finally {
    try {
      if (home) rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
      result.status = "error";
      result.exitCode = result.exitCode || 1;
      const message = `Unable to remove isolated test home: ${error.message}`;
      result.error = [result.error, message].filter(Boolean).join("; ");
      writeSync(stderr, `CI test runner: ${message}\n`);
      process.stderr.write(`CI test runner: ${message}\n`);
    }
    closeSync(stdout);
    closeSync(stderr);
    result.finishedAt = new Date().toISOString();
    result.durationMs = Date.now() - startedAt.getTime();
    writeFileSync(join(outputDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3 || !Object.hasOwn(suites, process.argv[2])) {
    console.error(`Usage: node scripts/run-ci-tests.mjs <${Object.keys(suites).join("|")}>`);
    process.exitCode = 2;
  } else {
    try {
      const result = await runSuite(process.argv[2]);
      process.exitCode = result.exitCode;
    } catch (error) {
      console.error(`CI test runner: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
