import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  copyRuntimeDependencies,
  copyRuntimeDist,
  copyRuntimeScripts,
} from "./package-runtime.mjs";
import { copyThirdPartyLicenses } from "./third-party-licenses.mjs";
import { copyCargoLicenses } from "./cargo-licenses.mjs";
import { copyBundledSkill } from "./package-skills.mjs";

export const WINDOWS_RUNTIME_ASSETS = Object.freeze([
  {
    name: "node",
    url: "https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-x64.zip",
    sha256: "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97",
    binary: "node-v22.23.2-win-x64/node.exe",
    license: "node-v22.23.2-win-x64/LICENSE",
  },
  {
    name: "caddy",
    url: "https://github.com/caddyserver/caddy/releases/download/v2.11.4/caddy_2.11.4_windows_amd64.zip",
    sha256: "1708333f79e274c7697285afe6d592ab39314e0b131e9ec6bea08ad27df62ebf",
    binary: "caddy.exe",
    license: "LICENSE",
  },
  {
    name: "frpc",
    url: "https://github.com/fatedier/frp/releases/download/v0.70.0/frp_0.70.0_windows_amd64.zip",
    sha256: "8407f83429643aa3fa9590d0c87a46b1ac14660efb96e46c955a4c2802f744b0",
    binary: "frp_0.70.0_windows_amd64/frpc.exe",
    license: "frp_0.70.0_windows_amd64/LICENSE",
  },
]);
export const WINDOWS_BUNDLE_CONFIG = {
  bundle: { resources: { "../dist/windows-runtime/": "runtime/" } },
};
export function verifyRuntimeArchive(bytes, expected) {
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error("运行时 SHA-256 校验失败；未解压该文件");
}
export async function buildWindows() {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("Windows 测试安装包必须在 Windows x64 构建");
  const project = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const desktop = join(project, "apps/desktop");
  const version = JSON.parse(readFileSync(join(project, "package.json"), "utf8")).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("应用版本格式无效");
  const run = (program, args, options = {}) => {
    const result = spawnSync(program, args, {
      cwd: project,
      stdio: "inherit",
      windowsHide: true,
      ...options,
    });
    if (result.status !== 0)
      throw new Error(`${program} 失败 (${result.status})`, { cause: result.error });
  };
  const cache = join(desktop, ".cache/windows-x64");
  const runtime = join(desktop, "dist/windows-runtime");
  mkdirSync(cache, { recursive: true });
  for (const asset of WINDOWS_RUNTIME_ASSETS) {
    const archive = join(cache, `${asset.name}.zip`);
    if (!existsSync(archive))
      run("curl.exe", [
        "--fail",
        "--location",
        "--retry",
        "3",
        "--connect-timeout",
        "20",
        "--output",
        archive,
        asset.url,
      ]);
    verifyRuntimeArchive(readFileSync(archive), asset.sha256);
    const extracted = join(cache, asset.name);
    mkdirSync(extracted, { recursive: true });
    // Windows ships bsdtar, which handles ZIP without PowerShell path quoting.
    run("tar.exe", ["-xf", archive, "-C", extracted]);
  }
  for (const directory of ["apps/server", "apps/web", "packages/contracts", "packages/taskctl"])
    rmSync(join(project, directory, "dist"), { recursive: true, force: true });
  run("npm.cmd", ["run", "build"], { shell: true });
  rmSync(runtime, { recursive: true, force: true });
  mkdirSync(join(runtime, "bin"), { recursive: true });
  mkdirSync(join(runtime, "licenses"), { recursive: true });
  for (const asset of WINDOWS_RUNTIME_ASSETS) {
    cpSync(join(cache, asset.name, asset.binary), join(runtime, "bin", `${asset.name}.exe`));
    cpSync(
      join(cache, asset.name, asset.license),
      join(runtime, "licenses", `${asset.name}-LICENSE`),
    );
  }
  for (const directory of ["apps/server", "packages/contracts", "packages/taskctl"]) {
    copyRuntimeDist(join(project, directory, "dist"), join(runtime, directory, "dist"));
    cpSync(join(project, directory, "package.json"), join(runtime, directory, "package.json"));
  }
  copyRuntimeDist(join(project, "apps/web/dist"), join(runtime, "apps/web/dist"));
  copyRuntimeScripts(project, runtime);
  copyBundledSkill(project, runtime, version);
  writeFileSync(
    join(runtime, "package.json"),
    JSON.stringify({
      name: "codexboard-desktop-runtime",
      version,
      type: "module",
      imports: {
        "#private-file-permissions": "./scripts/private-file-permissions.mjs",
        "#codex-windows-app": "./scripts/codex-windows-app.mjs",
      },
    }),
  );
  copyRuntimeDependencies(project, runtime);
  // Installer resources cannot preserve npm workspace junctions. Copy the two
  // small compiled workspace packages instead of shipping build-machine links.
  for (const name of ["contracts", "taskctl"])
    cpSync(join(runtime, "packages", name), join(runtime, "node_modules/@codexboard", name), {
      recursive: true,
    });
  await copyThirdPartyLicenses(project, runtime);
  run(
    join(runtime, "bin/node.exe"),
    [
      "--input-type=module",
      "-e",
      "import Database from 'better-sqlite3';const db=new Database(':memory:');if(db.prepare('select 1 as ok').get().ok!==1)process.exit(1);db.close()",
    ],
    { cwd: runtime },
  );
  const cli = join(project, "node_modules/@tauri-apps/cli/tauri.js");
  const bundleConfig = JSON.stringify(WINDOWS_BUNDLE_CONFIG);
  // First compile so Cargo downloads all locked target dependencies for the
  // offline license inventory; then bundle with that inventory included.
  run(
    process.execPath,
    [
      cli,
      "build",
      "--no-bundle",
      "--target",
      "x86_64-pc-windows-msvc",
      "--config",
      bundleConfig,
      "--ci",
      "--",
      "--locked",
    ],
    {
      cwd: desktop,
    },
  );
  copyCargoLicenses(project, runtime, "x86_64-pc-windows-msvc");
  run(
    process.execPath,
    [
      cli,
      "bundle",
      "--bundles",
      "nsis",
      "--target",
      "x86_64-pc-windows-msvc",
      "--config",
      bundleConfig,
      "--ci",
    ],
    { cwd: desktop },
  );
  const artifacts = join(desktop, "dist/windows-x64");
  mkdirSync(artifacts, { recursive: true });
  const bundle = join(desktop, "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis");
  for (const name of readdirSync(bundle).filter((name) => name.endsWith(".exe"))) {
    const source = join(bundle, name);
    cpSync(source, join(artifacts, name));
    writeFileSync(
      join(artifacts, `${name}.sha256`),
      `${createHash("sha256").update(readFileSync(source)).digest("hex")}  ${name}\n`,
    );
  }
  writeFileSync(
    join(artifacts, "build-info.json"),
    JSON.stringify(
      {
        version,
        platform: process.platform,
        architecture: process.arch,
        runtimeAssets: WINDOWS_RUNTIME_ASSETS,
        signed: false,
        release: false,
      },
      null,
      2,
    ),
  );
  console.log(`Windows 测试安装包：${artifacts}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildWindows();
