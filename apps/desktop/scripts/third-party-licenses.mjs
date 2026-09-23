import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep, posix } from "node:path";
import { fileURLToPath } from "node:url";

const supplements = {
  "abstract-logging@2.0.1": {
    license: "MIT",
    file: fileURLToPath(new URL("../licenses/abstract-logging-2.0.1/LICENSE", import.meta.url)),
    source: "https://jsumners.mit-license.org/license.txt",
    reference: "https://github.com/jsumners/abstract-logging/blob/v2.0.1/Readme.md",
    retrieved: "2026-09-14",
  },
};

function productionPackages(project) {
  const root = realpathSync(project);
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  // Include the web workspace: Vite embeds its production dependencies even
  // though their node_modules directories are not shipped in the runtime.
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["ls", "--all", "--omit=dev", "--workspaces", "--include-workspace-root", "--parseable"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      shell: process.platform === "win32",
      windowsHide: true,
    },
  );
  if (result.status !== 0)
    throw new Error("无法读取第三方生产依赖，请先 npm ci 并修复 npm ls 报告的问题", {
      cause: result.error ?? new Error(result.stderr.trim()),
    });

  const packages = [];
  for (const line of new Set(result.stdout.split(/\r?\n/).filter(Boolean))) {
    const path = relative(root, resolve(line)).split(sep).join("/");
    if (path === "") continue;
    const meta = lock.packages[path];
    if (isAbsolute(path) || path === ".." || path.startsWith("../") || !meta)
      throw new Error(`第三方依赖路径不在 lockfile 中：${path}`);
    // npm may report either a workspace link or its project-owned target.
    if (meta.link || !path.split("/").includes("node_modules")) continue;
    if (meta.dev) throw new Error(`许可依赖列表意外包含开发依赖：${path}`);
    const directory = join(root, path);
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    if (manifest.version !== meta.version)
      throw new Error(`第三方依赖版本与 lockfile 不一致：${path}`);
    if (
      !/^(?:@[a-zA-Z0-9_.~-]+\/)?[a-zA-Z0-9_.~-]+$/.test(manifest.name) ||
      [".", ".."].includes(manifest.name)
    )
      throw new Error(`第三方包名称无效：${path}`);
    packages.push({ directory, path, manifest, meta });
  }
  return packages.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

function licenseFiles(directory) {
  const files = [];
  const licenseName = /(?:^|[.-])(?:licen[cs]es?|copying|notice)(?:[.-]|$)/i;
  function visit(current, insideLicenses = false) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (["node_modules", ".git"].includes(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path, insideLicenses || licenseName.test(entry.name));
      else if (insideLicenses || licenseName.test(entry.name)) {
        const resolved = relative(realpathSync(directory), realpathSync(path)).split(sep).join("/");
        if (isAbsolute(resolved) || resolved === ".." || resolved.startsWith("../"))
          throw new Error(`第三方许可文件指向包外：${path}`);
        files.push({
          path: relative(directory, path).split(sep).join("/"),
          contents: readFileSync(path),
        });
      }
    }
  }
  visit(directory);
  return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

function mitReadme(directory, license) {
  if (license !== "MIT") return [];
  for (const entry of readdirSync(directory).filter((name) => /^readme(?:\.|$)/i.test(name))) {
    const contents = readFileSync(join(directory, entry));
    const text = contents.toString("utf8").replace(/\s+/g, " ");
    // Some upstream packages publish the entire license in their README. A
    // heading, SPDX identifier or external link alone does not provide its text.
    if (
      /copyright/i.test(text) &&
      text.includes(
        "Permission is hereby granted, free of charge, to any person obtaining a copy",
      ) &&
      text.includes("The above copyright notice and this permission notice shall be included in") &&
      /THE SOFTWARE IS PROVIDED [“"']AS IS[”"']/.test(text) &&
      text.includes(
        "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE",
      )
    )
      return [{ path: entry, contents }];
  }
  return [];
}

export function copyThirdPartyLicenses(project, runtime) {
  const packages = new Map();
  for (const { directory, path, manifest, meta } of productionPackages(project)) {
    const key = `${manifest.name}@${manifest.version}`;
    if (packages.has(key)) {
      packages.get(key).installedPaths.push(path);
      continue;
    }
    const files = licenseFiles(directory);
    // Attribution-only NOTICE files do not replace the package's license text.
    let hasLicense = files.some(
      (file) =>
        /(?:^|[./-])(?:licen[cs]es?|copying)(?:[./-]|$)/i.test(file.path) &&
        file.contents.length > 0,
    );
    if (!hasLicense) {
      const readme = mitReadme(directory, manifest.license);
      files.push(...readme);
      hasLicense = readme.length > 0;
    }
    let supplement;
    if (!hasLicense && supplements[key]?.license === manifest.license) {
      const { file, ...source } = supplements[key];
      supplement = source;
      files.push({ path: "LICENSE", contents: readFileSync(file) });
      hasLicense = true;
    }
    if (!hasLicense) throw new Error(`缺少第三方许可正文：${key}；请核实上游后补齐`);
    packages.set(key, {
      name: manifest.name,
      version: manifest.version,
      license: manifest.license ?? null,
      source: meta.resolved ?? null,
      repository: manifest.repository?.url ?? manifest.repository ?? null,
      installedPaths: [path],
      supplement,
      files,
    });
  }

  // Validate the complete inventory before replacing this generated directory.
  // Binary license files alongside it (Node, Caddy and frpc) are preserved.
  const destination = join(runtime, "licenses/npm");
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  let fileCount = 0;
  const index = [];
  for (const entry of [...packages.values()].sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, "en"),
  )) {
    const { files, ...metadata } = entry;
    const copied = [];
    for (const file of files) {
      const path = posix.join(entry.name, encodeURIComponent(entry.version), file.path);
      const target = join(destination, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.contents);
      copied.push({ path, sha256: createHash("sha256").update(file.contents).digest("hex") });
      fileCount++;
    }
    index.push({ ...metadata, files: copied });
  }
  writeFileSync(
    join(destination, "index.json"),
    JSON.stringify(
      {
        formatVersion: 1,
        scope:
          "Root and all npm workspace production dependencies, including the bundled web frontend",
        packages: index,
      },
      null,
      2,
    ) + "\n",
  );
  return { packageCount: index.length, fileCount };
}
