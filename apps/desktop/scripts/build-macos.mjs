import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  rmSync,
  chmodSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyRuntimeDependencies,
  copyRuntimeDist,
  copyRuntimeScripts,
} from "./package-runtime.mjs";
import { copyThirdPartyLicenses } from "./third-party-licenses.mjs";
import { copyCargoLicenses } from "./cargo-licenses.mjs";
import { copyBundledSkill } from "./package-skills.mjs";
import { writeLegacyUpdateLauncher } from "./legacy-update-launcher.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const desktop = join(project, "apps/desktop");
const version = JSON.parse(readFileSync(join(project, "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?$/.test(version)) throw new Error("应用版本格式无效");
const cache = join(desktop, ".cache");
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("当前构建仅支持 Apple Silicon macOS");
const run = (cmd, args, options = {}) => {
  const r = spawnSync(cmd, args, { cwd: project, stdio: "inherit", ...options });
  if (r.status !== 0) throw new Error(`${cmd} 失败 (${r.status})`);
  return r;
};
mkdirSync(cache, { recursive: true });
const assets = [
  [
    "node",
    "https://nodejs.org/dist/v22.23.2/node-v22.23.2-darwin-arm64.tar.gz",
    "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
    "node-v22.23.2-darwin-arm64/bin/node",
  ],
  [
    "caddy",
    "https://github.com/caddyserver/caddy/releases/download/v2.11.4/caddy_2.11.4_mac_arm64.tar.gz",
    "9efb0af2d6cf09cfb5053c0e51721b9b3d4956d346234f39368d943d25a3c9a7",
    "caddy",
  ],
  [
    "frpc",
    "https://github.com/fatedier/frp/releases/download/v0.70.0/frp_0.70.0_darwin_arm64.tar.gz",
    "bb9cc92548cf7f304722beb244dc8a9b1fd3139e508309c8de6b780e2a166eba",
    "frp_0.70.0_darwin_arm64/frpc",
  ],
];
for (const [name, url, sha] of assets) {
  const archive = join(cache, `${name}.tar.gz`);
  if (!existsSync(archive))
    run("curl", ["-fL", "--retry", "3", "--connect-timeout", "20", "-o", archive, url]);
  if (createHash("sha256").update(readFileSync(archive)).digest("hex") !== sha)
    throw new Error(`${name} SHA256 校验失败，请删除缓存后重试`);
  mkdirSync(join(cache, name), { recursive: true });
  run("tar", ["-xzf", archive, "-C", join(cache, name)]);
}
for (const path of [
  "apps/server/dist",
  "apps/web/dist",
  "packages/contracts/dist",
  "packages/taskctl/dist",
])
  rmSync(join(project, path), { recursive: true, force: true });
run("npm", ["run", "build"]);
run("cargo", [
  "build",
  "--release",
  "--locked",
  "--manifest-path",
  join(desktop, "src-tauri/Cargo.toml"),
]);
const app = join(desktop, "dist/CodexBoard.app");
rmSync(app, { recursive: true, force: true });
const contents = join(app, "Contents");
const runtime = join(contents, "Resources/runtime");
mkdirSync(join(contents, "MacOS"), { recursive: true });
mkdirSync(join(runtime, "bin"), { recursive: true });
for (const [name, , , path] of assets) {
  cpSync(join(cache, name, path), join(runtime, "bin", name));
  chmodSync(join(runtime, "bin", name), 0o755);
}
for (const directory of ["apps/server", "packages/contracts", "packages/taskctl"]) {
  mkdirSync(join(runtime, directory), { recursive: true });
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
mkdirSync(join(runtime, "node_modules/@codexboard"), { recursive: true });
for (const name of ["contracts", "taskctl"])
  symlinkSync(`../../packages/${name}`, join(runtime, "node_modules/@codexboard", name));
const licenses = join(runtime, "licenses");
mkdirSync(licenses);
for (const [name, path] of [
  ["node", "node-v22.23.2-darwin-arm64/LICENSE"],
  ["caddy", "LICENSE"],
  ["frpc", "frp_0.70.0_darwin_arm64/LICENSE"],
]) {
  if (existsSync(join(cache, name, path)))
    cpSync(join(cache, name, path), join(licenses, `${name}-LICENSE`));
}
const thirdPartyLicenses = await copyThirdPartyLicenses(project, runtime);
console.log(`第三方许可：${thirdPartyLicenses.packageCount} 个 npm 包`);
const cargoLicenses = copyCargoLicenses(project, runtime);
console.log(`第三方许可：${cargoLicenses.packageCount} 个 Rust crate`);
cpSync(
  join(desktop, "src-tauri/target/release/codexboard-desktop"),
  join(contents, "MacOS/codexboard-desktop"),
);
const legacyUpdateLaunchers = ["taskboard-desktop", "lark-codex-desktop"].map((name) =>
  writeLegacyUpdateLauncher(contents, name),
);
writeFileSync(
  join(contents, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>codexboard-desktop</string><key>CFBundleIdentifier</key><string>cn.rocyan.codexboard.desktop</string><key>CFBundleName</key><string>CodexBoard</string><key>CFBundleDisplayName</key><string>CodexBoard</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version.split("-")[0]}</string><key>LSMinimumSystemVersion</key><string>13.0</string><key>NSHighResolutionCapable</key><true/></dict></plist>`,
);
const roundedIcon = join(cache, "CodexBoard-rounded.png");
const iconRenderer = join(cache, "icon-mask");
run("swiftc", [
  "-framework",
  "AppKit",
  "-framework",
  "QuartzCore",
  join(desktop, "scripts/icon-mask.swift"),
  "-o",
  iconRenderer,
]);
run(iconRenderer, [roundedIcon, join(desktop, "src-tauri/icons/icon.png")]);
const iconset = join(cache, "CodexBoard.iconset");
mkdirSync(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512])
  for (const scale of [1, 2])
    run(
      "sips",
      [
        "-z",
        String(size * scale),
        String(size * scale),
        roundedIcon,
        "--out",
        join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`),
      ],
      { stdio: "ignore" },
    );
run("iconutil", ["-c", "icns", iconset, "-o", join(contents, "Resources/CodexBoard.icns")]);
const plist = join(contents, "Info.plist");
writeFileSync(
  plist,
  readFileSync(plist, "utf8").replace(
    "</dict>",
    "<key>CFBundleIconFile</key><string>CodexBoard.icns</string></dict>",
  ),
);
// Sign every embedded native module before sealing the containing app.
function signModules(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if ([".bin", "node_gyp_bins"].includes(e.name)) {
      rmSync(p, { recursive: true, force: true });
      continue;
    }
    if (e.isDirectory()) signModules(p);
    else if (e.name.endsWith(".node")) run("codesign", ["--force", "--sign", "-", p]);
  }
}
signModules(join(runtime, "node_modules"));
for (const [name] of assets)
  run("codesign", ["--force", "--sign", "-", join(runtime, "bin", name)]);
for (const launcher of legacyUpdateLaunchers) run("codesign", ["--force", "--sign", "-", launcher]);
run("codesign", ["--force", "--sign", "-", app]);
run("codesign", ["--verify", "--deep", "--strict", app]);
run(
  join(runtime, "bin/node"),
  [
    "--input-type=module",
    "-e",
    "import Database from 'better-sqlite3';const db=new Database(':memory:');console.log('内置 SQLite:',db.prepare('select 1 as ok').get().ok);db.close()",
  ],
  { cwd: runtime },
);
console.log(`应用已生成：${app}`);
