import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function listRuntimeDependencyPaths(
  project,
  target = { platform: process.platform, arch: process.arch },
) {
  // npm resolves hoisting, workspace links and transitive/optional dependencies.
  // The frontend is already bundled by Vite and does not need its npm tree here.
  const root = realpathSync(project);
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "ls",
      "--all",
      "--omit=dev",
      "--workspace=@codexboard/server",
      "--workspace=@codexboard/contracts",
      "--workspace=@codexboard/taskctl",
      "--include-workspace-root",
      "--parseable",
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      shell: process.platform === "win32",
      windowsHide: true,
    },
  );
  if (result.status !== 0)
    throw new Error("无法读取生产依赖，请先 npm ci 并修复 npm ls 报告的问题", {
      cause: result.error ?? new Error(result.stderr.trim()),
    });
  const lock = JSON.parse(readFileSync(join(project, "package-lock.json"), "utf8"));
  const paths = new Set();
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const path = relative(root, resolve(line)).split(sep).join("/");
    if (path === "" || ["apps/server", "packages/contracts", "packages/taskctl"].includes(path))
      continue;
    const meta = lock.packages[path];
    if (
      isAbsolute(path) ||
      path.startsWith("../") ||
      !path.split("/").includes("node_modules") ||
      !meta
    )
      throw new Error(`生产依赖路径不在 lockfile 中：${path}`);
    if (meta.link) continue;
    if (meta.dev) throw new Error(`生产依赖列表意外包含开发依赖：${path}`);
    if (!supportsPlatform(meta.os, target.platform) || !supportsPlatform(meta.cpu, target.arch))
      continue;
    if (!existsSync(join(project, path))) {
      if (meta.optional) continue;
      throw new Error(`缺少生产依赖 ${path}，请先 npm ci`);
    }
    paths.add(path);
  }
  return [...paths].sort();
}

export function copyRuntimeDependencies(
  project,
  runtime,
  paths = listRuntimeDependencyPaths(project),
  target = { platform: process.platform, arch: process.arch },
) {
  for (const path of paths) {
    const source = join(project, path);
    const destination = join(runtime, path);
    const packageName = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).name;
    // better-sqlite3 prefers this shipped native binary. npm may still leave
    // node-gyp metadata containing local paths; none of that build tree is used.
    const omitSqliteBuild =
      packageName === "better-sqlite3" &&
      existsSync(join(source, `prebuilds/${target.platform}-${target.arch}.node`));
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, {
      recursive: true,
      dereference: true,
      // Selected nested packages are copied separately, at their original paths.
      filter: (entry) =>
        entry !== join(source, "node_modules") &&
        !(omitSqliteBuild && entry === join(source, "build")),
    });
  }
}

function supportsPlatform(values, target) {
  if (!values) return true;
  if (values.includes(`!${target}`)) return false;
  return !values.some((value) => !value.startsWith("!")) || values.includes(target);
}

// The backend loads run-codex-app-server.mjs and codex-session-bridge.mjs.
// Keep their complete local import closure; development tools are deliberately opt-in.
export const RUNTIME_SCRIPT_FILES = Object.freeze([
  "codex-desktop-loader.mjs",
  "codex-desktop-session.mjs",
  "codex-local-endpoint.mjs",
  "codex-project-snapshot.mjs",
  "codex-remote-image.mjs",
  "codex-remote-queue.mjs",
  "codex-remote-review.mjs",
  "codex-remote-upload.mjs",
  "codex-session-bridge.mjs",
  "codex-task-progress.mjs",
  "codex-thread-title.mjs",
  "codex-windows-app.mjs",
  "git-origin-reader.mjs",
  "node-script-arguments.mjs",
  "private-file-permissions.mjs",
  "run-codex-app-server.mjs",
]);

// The native app starts runtime.mjs, which imports the remaining setup modules.
export const DESKTOP_RUNTIME_SCRIPT_FILES = Object.freeze([
  "runtime.mjs",
  "frpc-config.mjs",
  "ports.mjs",
  "setup-controller.mjs",
  "web-accounts.mjs",
  "setup-checks.mjs",
  "skill-manager.mjs",
]);

export function copyRuntimeScripts(project, runtime) {
  for (const [source, destination, files] of [
    ["scripts", "scripts", RUNTIME_SCRIPT_FILES],
    ["apps/desktop/scripts", "desktop", DESKTOP_RUNTIME_SCRIPT_FILES],
  ]) {
    mkdirSync(join(runtime, destination), { recursive: true });
    for (const file of files) cpSync(join(project, source, file), join(runtime, destination, file));
  }
}

function stripSourceMapReference(source) {
  // TypeScript/Vite append mapping directives at EOF. Restrict removal to that
  // position so a string/template containing similar text remains unchanged.
  return source.replace(
    /(?:^|\r?\n)[\t ]*\/\/[#@][\t ]*sourceMappingURL=[^\r\n]*(?:\r?\n)?$|\/\*[#@][\t ]*sourceMappingURL=[^*]*\*\/[\t \r\n]*$/g,
    "\n",
  );
}

// Use only for project-owned build output, never for third-party dependencies.
// Build output stays intact for workspace consumers that need its declarations.
export function copyRuntimeDist(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (
      /\.(?:map|tsbuildinfo)$|\.d\.[cm]?ts$|\.(?:test|spec)\.[cm]?js$/.test(entry.name) ||
      (entry.isDirectory() && entry.name === "__tests__")
    )
      continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) copyRuntimeDist(from, to);
    else {
      cpSync(from, to);
      if (/\.(?:[cm]?js|css)$/.test(entry.name)) {
        const contents = readFileSync(to, "utf8");
        const cleaned = stripSourceMapReference(contents);
        if (cleaned !== contents) writeFileSync(to, cleaned);
      }
    }
  }
}
