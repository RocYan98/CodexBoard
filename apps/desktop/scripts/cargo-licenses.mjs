import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep, posix } from "node:path";
import { fileURLToPath } from "node:url";

const supplementRoot = fileURLToPath(new URL("../licenses/cargo/", import.meta.url));

function cargo(project, args) {
  const result = spawnSync(
    "cargo",
    [
      args[0],
      "--manifest-path",
      "apps/desktop/src-tauri/Cargo.toml",
      "--locked",
      "--offline",
      ...args.slice(1),
    ],
    { cwd: project, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  );
  if (result.status !== 0)
    throw new Error("无法读取 Cargo 锁定依赖；请先准备对应目标的本机构建依赖", {
      cause: result.error ?? new Error(result.stderr.trim()),
    });
  return result.stdout;
}

function runtimeCrates(project, target) {
  const metadata = JSON.parse(
    cargo(project, ["metadata", "--format-version", "1", "--filter-platform", target]),
  );
  // Cargo tree distinguishes host/build feature graphs. Reconstructing this
  // selection from metadata's merged package nodes would include build tools.
  const tree = cargo(project, [
    "tree",
    "--target",
    target,
    "--edges",
    "normal,no-proc-macro",
    "--prefix",
    "none",
    "--format",
    "{p}",
  ]);
  const selected = new Set();
  for (const line of tree.split(/\r?\n/).filter(Boolean)) {
    const match = /^([a-zA-Z0-9_-]+) v(\S+)(?:\s|$)/.exec(line);
    if (!match) throw new Error("无法识别 Cargo 依赖列表行");
    selected.add(`${match[1]}@${match[2]}`);
  }
  return [...selected].sort().flatMap((key) => {
    const matches = metadata.packages.filter((entry) => `${entry.name}@${entry.version}` === key);
    if (matches.length !== 1) throw new Error(`无法唯一定位 Cargo 依赖：${key}`);
    return matches[0].id === metadata.resolve.root ? [] : matches;
  });
}

function readWithin(root, path) {
  const resolved = relative(realpathSync(root), realpathSync(join(root, path)))
    .split(sep)
    .join("/");
  if (isAbsolute(resolved) || resolved === ".." || resolved.startsWith("../"))
    throw new Error(`Cargo 许可文件指向包外：${path}`);
  return readFileSync(join(root, path));
}

function crateLicenseFiles(root, licenseFile) {
  const found = new Map();
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if ([".git", "target"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (
        /^(?:licen[cs]e|copying|notice|copyright)(?:[._-]|$)/i.test(entry.name) &&
        !/\.(?:rs|[cm]?js|ts|c|h|cpp|toml|json)$/i.test(entry.name)
      ) {
        const file = relative(root, path).split(sep).join("/");
        found.set(file, { path: file, contents: readWithin(root, file) });
      }
    }
  }
  visit(root);
  if (licenseFile)
    found.set(licenseFile, { path: licenseFile, contents: readWithin(root, licenseFile) });
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
}

export function copyCargoLicenses(project, runtime, target = "aarch64-apple-darwin") {
  const supplements = JSON.parse(
    readFileSync(join(supplementRoot, "supplements.json"), "utf8"),
  ).packages;
  const inventory = runtimeCrates(realpathSync(project), target).map((crate) => {
    const key = `${crate.name}@${crate.version}`;
    const root = dirname(crate.manifest_path);
    const vcs = existsSync(join(root, ".cargo_vcs_info.json"))
      ? JSON.parse(readFileSync(join(root, ".cargo_vcs_info.json"), "utf8"))
      : null;
    const files = crateLicenseFiles(root, crate.license_file);
    const hasLicense = files.some(
      (file) =>
        /(?:^|\/)(?:licen[cs]e|copying)(?:[._-]|$)/i.test(file.path) &&
        !file.path.endsWith(".spdx") &&
        file.contents.length > 0,
    );
    let supplement;
    if (!hasLicense) {
      supplement = supplements[key];
      if (
        !supplement ||
        supplement.license !== crate.license ||
        supplement.repository !== crate.repository?.replace(/\/$/, "") ||
        supplement.commit !== vcs?.git?.sha1
      )
        throw new Error(`缺少对应版本的 Cargo 许可正文：${key}`);
      for (const file of supplement.files) {
        const contents = readWithin(supplementRoot, file.path);
        if (createHash("sha256").update(contents).digest("hex") !== file.sha256)
          throw new Error(`Cargo 许可补件校验失败：${key}/${file.destination}`);
        files.push({ path: file.destination, contents, source: file.source });
      }
    }
    return {
      name: crate.name,
      version: crate.version,
      license: crate.license,
      source: crate.source,
      repository: crate.repository,
      authors: crate.authors,
      sourceCommit: vcs?.git?.sha1 ?? null,
      supplemented: Boolean(supplement),
      files,
    };
  });

  // No local registry/workspace paths enter the distributable index.
  const destination = join(runtime, "licenses/cargo");
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  let fileCount = 0;
  const packages = inventory.map(({ files, ...crate }) => ({
    ...crate,
    files: files.map((file) => {
      const path = posix.join(crate.name, encodeURIComponent(crate.version), file.path);
      mkdirSync(dirname(join(destination, path)), { recursive: true });
      writeFileSync(join(destination, path), file.contents);
      fileCount++;
      return {
        path,
        source: file.source ?? null,
        sha256: createHash("sha256").update(file.contents).digest("hex"),
      };
    }),
  }));
  writeFileSync(
    join(destination, "index.json"),
    JSON.stringify(
      {
        formatVersion: 1,
        target,
        scope: "Cargo normal dependencies excluding build, dev and proc-macro dependencies",
        packages,
      },
      null,
      2,
    ) + "\n",
  );
  return { packageCount: packages.length, fileCount };
}
