import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const desktop = join(project, "apps/desktop");
const output = join(desktop, "dist");
const repository = process.env.CODEXBOARD_RELEASE_REPOSITORY ?? "RocYan98/CodexBoard";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: project, stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${command} 未成功完成 (${result.status})`);
  return result;
}

export function assertDistributionClean(app) {
  const home = homedir();
  const localHomes = [
    ...new Set([home, home.replaceAll("\\", "/"), JSON.stringify(home).slice(1, -1)]),
  ].map((value) => Buffer.from(value));
  const outside = (path) => path === ".." || /^\.\.[\\/]/.test(path) || isAbsolute(path);
  const realApp = realpathSync.native(app);
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (
        [
          "updater.key",
          "auth.json",
          "frpc.toml",
          "runtime.json",
          ".env",
          "production.env",
          "feishu-credentials.json",
          "codex-app-server-token",
          "feishu-app-secret",
        ].includes(entry.name) ||
        /\.sqlite(?:-wal|-shm)?$/.test(entry.name)
      )
        throw new Error(`分发包中存在私人配置：${relative(app, path)}`);
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(path);
        const relativeTarget = relative(app, resolve(dirname(path), target));
        if (isAbsolute(target) || outside(relativeTarget))
          throw new Error(`分发包中的链接指向应用外：${relative(app, path)}`);
        let realTarget;
        try {
          // Resolve through every link before handling '..'; lexical resolution
          // alone can hide a target outside the app behind an internal alias.
          realTarget = relative(realApp, realpathSync.native(path));
        } catch {
          throw new Error(`分发包中的链接无法解析：${relative(app, path)}`);
        }
        if (outside(realTarget))
          throw new Error(`分发包中的链接指向应用外：${relative(app, path)}`);
      } else if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const contents = readFileSync(path);
        if (localHomes.some((localHome) => contents.includes(localHome)))
          throw new Error(`分发包中存在私人配置或本机路径：${relative(app, path)}`);
      }
    }
  }
  visit(app);
}

function release() {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("当前发布仅支持 Apple Silicon macOS");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("GitHub 仓库名称无效");
  const config = JSON.parse(readFileSync(join(desktop, "src-tauri/tauri.conf.json"), "utf8"));
  const version = JSON.parse(readFileSync(join(project, "package.json"), "utf8")).version;
  if (!/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?$/.test(version) || config.version !== version)
    throw new Error("根 package.json 和 tauri.conf.json 的版本必须一致且有效");
  const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(
    readFileSync(join(desktop, "src-tauri/Cargo.toml"), "utf8"),
  )?.[1];
  if (cargoVersion !== version) throw new Error("Cargo.toml 的应用版本与发布版本不一致");
  const endpoint = `https://github.com/${repository}/releases/latest/download/latest.json`;
  if (config.plugins?.updater?.endpoints?.[0] !== endpoint)
    throw new Error("应用的更新地址与发布仓库不一致");
  const publicKey = config.plugins?.updater?.pubkey?.trim();
  if (!publicKey) throw new Error("必须配置更新签名公钥");
  const privateKey = realpathSync(
    process.env.TAURI_SIGNING_PRIVATE_KEY_PATH ??
      ["codexboard", "lark-codex"]
        .map((name) => join(homedir(), ".config", name, "release/updater.key"))
        .find((path) => existsSync(path)) ??
      join(homedir(), ".config/codexboard/release/updater.key"),
  );
  const keyRelative = relative(realpathSync(project), privateKey);
  if (!isAbsolute(keyRelative) && keyRelative !== ".." && !keyRelative.startsWith("../"))
    throw new Error("更新私钥必须保存在源码仓库外");
  if (!statSync(privateKey).isFile() || (statSync(privateKey).mode & 0o077) !== 0)
    throw new Error("更新私钥必须是仅当前用户可读写的文件（权限 0600）");
  if (
    !existsSync(`${privateKey}.pub`) ||
    readFileSync(`${privateKey}.pub`, "utf8").trim() !== publicKey
  )
    throw new Error("私钥对应的 .pub 文件与应用公钥不一致");
  if (process.env.RUSTFLAGS && !process.env.CARGO_ENCODED_RUSTFLAGS)
    throw new Error("发布构建请改用 CARGO_ENCODED_RUSTFLAGS 传递自定义 Rust 参数");
  const buildEnv = {
    ...process.env,
    CARGO_ENCODED_RUSTFLAGS: [
      process.env.CARGO_ENCODED_RUSTFLAGS,
      `--remap-path-prefix=${homedir()}=/build`,
    ]
      .filter(Boolean)
      .join("\x1f"),
  };
  run(process.execPath, [join(desktop, "scripts/build-macos.mjs")], { env: buildEnv });
  const app = join(output, "CodexBoard.app");
  const builtVersion = run(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleShortVersionString", join(app, "Contents/Info.plist")],
    { stdio: "pipe", encoding: "utf8" },
  ).stdout.trim();
  if (builtVersion !== version) throw new Error("构建应用的版本与发布版本不一致");
  run("codesign", ["--verify", "--deep", "--strict", app]);
  assertDistributionClean(app);

  const stem = `CodexBoard-${version}-macos-arm64`;
  const archive = join(output, `${stem}.app.tar.gz`);
  run("/usr/bin/tar", ["-czf", archive, "-C", output, "CodexBoard.app"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const signingEnv = {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
  };
  delete signingEnv.TAURI_SIGNING_PRIVATE_KEY;
  // Never expose signer diagnostics: malformed-key errors can include input.
  run(
    process.execPath,
    [join(project, "node_modules/.bin/tauri"), "signer", "sign", "-f", privateKey, archive],
    { env: signingEnv, stdio: "pipe" },
  );
  const signature = readFileSync(`${archive}.sig`, "utf8").trim();
  const staging = mkdtempSync(join(tmpdir(), "codexboard-release-"));
  try {
    const publicKeyFile = join(staging, "updater.pub");
    writeFileSync(publicKeyFile, publicKey);
    run(
      "cargo",
      [
        "run",
        "--quiet",
        "--release",
        "--locked",
        "--manifest-path",
        join(desktop, "src-tauri/Cargo.toml"),
        "--example",
        "verify-update-signature",
        "--",
        publicKeyFile,
        `${archive}.sig`,
        archive,
      ],
      { env: buildEnv },
    );
    run(
      "cargo",
      [
        "test",
        "--release",
        "--locked",
        "--offline",
        "--manifest-path",
        join(desktop, "src-tauri/Cargo.toml"),
        "packaged_update_archive_matches_native_structure_check",
        "--",
        "--ignored",
      ],
      { env: { ...buildEnv, CODEXBOARD_UPDATE_ARCHIVE: archive } },
    );
    rmSync(publicKeyFile);
    cpSync(app, join(staging, "CodexBoard.app"), { recursive: true, verbatimSymlinks: true });
    symlinkSync("/Applications", join(staging, "Applications"));
    writeFileSync(
      join(staging, "安装说明.txt"),
      `CodexBoard ${version}\n\n适用于 Apple Silicon Mac，macOS 13 或更新版本。\n\n1. 更新旧版前，请先处理执行中的任务并正常退出 CodexBoard。\n2. 将 CodexBoard.app 拖入 Applications（应用程序）。\n3. 打开应用，按“使用引导”完成配置，然后推出本安装磁盘。\n\n当前未完成 Apple Developer ID 签名和公证。确认来源可信后，首次打开方法见：\nhttps://support.apple.com/en-mo/102445\n无需关闭系统整体安全检查。\n\n已安装版本可在“应用设置 → 应用更新”中检查、下载并确认安装更新。\n更新包通过独立签名校验；更新不会覆盖应用的数据目录。\n\n安装包包含 Node.js、前后端、Codex 桥接、SQLite、Caddy、frp 客户端。\nCodex、公网 frp 服务端需自行准备；使用飞书入口或飞书 CLI 配对时另需飞书客户端与自建应用。Web 账号登录及 CLI 配对需要 HTTPS。\n\n用户指南：https://github.com/${repository}\nAgent 指南：https://github.com/${repository}/blob/main/AGENTS.md\n`,
    );
    const dmg = join(output, `${stem}.dmg`);
    run("hdiutil", [
      "create",
      "-volname",
      "CodexBoard",
      "-srcfolder",
      staging,
      "-ov",
      "-format",
      "UDZO",
      "-fs",
      "HFS+",
      dmg,
    ]);
    run("hdiutil", ["verify", dmg]);
    writeFileSync(
      `${dmg}.sha256`,
      `${createHash("sha256").update(readFileSync(dmg)).digest("hex")}  ${stem}.dmg\n`,
    );
    const notes = process.env.CODEXBOARD_RELEASE_NOTES_FILE
      ? readFileSync(process.env.CODEXBOARD_RELEASE_NOTES_FILE, "utf8")
      : `CodexBoard ${version} 更新`;
    writeFileSync(
      join(output, "latest.json"),
      JSON.stringify(
        {
          version,
          notes,
          pub_date: new Date().toISOString(),
          platforms: {
            "darwin-aarch64": {
              signature,
              url: `https://github.com/${repository}/releases/download/v${version}/${stem}.app.tar.gz`,
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`发布产物已生成并验证：${output}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) release();
