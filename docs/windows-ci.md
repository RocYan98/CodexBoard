# Windows 自动构建与测试

本阶段在 GitHub Actions 的 `windows-2022` x64 环境建立兼容性基线。工作流运行于 `feature/windows-ci` 分支推送、面向 `main` 的 Pull Request，以及手动触发。测试分支不自动合并、不发布 Release，也不替换现有 macOS 应用。

首次运行通过推送测试分支触发。GitHub 的 **Run workflow** 按钮通常要求工作流已在默认分支；保留 `workflow_dispatch` 供后续采用，不为显示按钮而将测试分支提前合并。

## 检查范围

| 作业                                     | 实际检查                                                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Node and web build                       | 使用 Node 22.23.2、`npm ci` 和锁文件，构建 contracts、taskctl、server、web；执行类型检查及 ESLint                                  |
| contracts / taskctl / server / web tests | 各工作区完整 Vitest 测试，不通过排除 Windows 失败用例取得绿灯                                                                      |
| scripts tests                            | `scripts/` 下完整 Node 测试，显式展开文件列表，避免依赖 shell 通配符                                                               |
| desktop-scripts tests                    | 桌面脚本完整 Node 测试，包含 Chromium 和 WebKit 界面检查                                                                           |
| Desktop Rust compilation                 | 使用 Cargo 锁文件检查桌面程序及测试目标                                                                                            |
| Test installer                           | 校验并打包 Windows x64 Node/Caddy/frpc，启动包内后端验证健康接口、首页、登录保护和正常退出，再生成独立测试用 NSIS 安装包及 SHA-256 |

每个测试组独立运行，一个组失败不会取消其他组。失败保留非零退出码，工作流总状态也会失败。不能把“工作流成功启动”或“网页构建通过”解释为 Windows 桌面版已适配。

检出前关闭运行器的 Git 自动换行转换，保留仓库原始字节，避免带固定哈希的上游许可证被转换为 CRLF 后产生无关的校验失败。

Node 脚本测试默认使用 120 秒的文件超时；Windows 桌面脚本因真实 ACL 检查启动多个 PowerShell 进程，使用 300 秒。挂起或遗留句柄按失败记录到 JUnit，不强制将未退出的测试算作通过。Windows server/taskctl 的 Vitest 单项和 hook 使用 30 秒预算、最多两个 worker。外层作业另有时限。

CI 不运行需要真实 Codex 的 `codex:protocol:check`，不启动真实任务、不使用飞书凭据，不运行依赖 Unix 模拟桌面的整体 `test:e2e`。Windows ACL 有真实 DACL 检查；GitHub Windows 运行器以管理员运行，仍不能代替普通 Windows 11 用户的隔离验收。真实桌面集成在独立云桌面验证。

安装包后端冒烟测试使用实际产物中的 Node、服务器代码和生产依赖，Windows 路径包含与 Tauri 一致的命名空间前缀。测试使用独立临时 HOME、数据目录和只接受固定只读方法的本地假 WebSocket 对端，不读取真实 Codex 配置或执行任务。结果中的 `codexMode: isolated-fake-websocket` 明确表示它不验证 embedded 模式的真实 Codex 启动链路；这部分仍需云桌面验收。

## 产物与结果

在仓库 **Actions → Windows build and validation** 查看具体提交的运行记录：

- `windows-x64-node-web-build-<commit>`：四个工作区编译结果及 `build-info.json`。它不包含 Node、生产依赖或桌面启动器，不是可安装或独立运行的 Windows 发行包。
- `windows-x64-tests-<suite>-<commit>`：JUnit 报告、标准输出、标准错误和带平台信息的 `result.json`。
- `windows-x64-desktop-check-<commit>`：Rust 工具链版本、编译日志和退出状态。
- `windows-x64-test-installer-<commit>`：独立测试安装包、SHA-256 与构建信息。构建成功才上传，不发布到 Release。

产物保留 14 天。安装依赖或作业超时可能导致报告不完整，此时以作业日志和失败状态为准。平台专属的旧 macOS 启动器和 shell 包装器测试只在对应平台运行；Windows 包装器与权限使用单独的真实 Windows 用例，通用功能测试保持运行。

## 本地复现

在项目根目录执行：

```sh
npm ci --no-audit --no-fund
npm run build
npm run typecheck
npm run lint
node scripts/run-ci-tests.mjs contracts
node scripts/run-ci-tests.mjs taskctl
node scripts/run-ci-tests.mjs server
node scripts/run-ci-tests.mjs web
node scripts/run-ci-tests.mjs scripts
```

桌面脚本测试还需安装 Playwright Chromium 和 WebKit。设置 `PLAYWRIGHT_BROWSERS_PATH` 为绝对缓存路径，再使用同一环境运行 `npx --no-install playwright install chromium webkit` 和 `node scripts/run-ci-tests.mjs desktop-scripts`。测试执行器隔离用户配置目录，避免读取本机 Codex 配置。

Rust 检查命令：

```sh
cargo check --locked --all-targets --manifest-path apps/desktop/src-tauri/Cargo.toml
```

在 macOS 上运行同一组命令只提供 macOS 证据。Windows 结论必须对应实际 Windows 环境及具体源码版本的运行记录。

## 2026-09-19 实际基线

测试提交：`641676e746ba16722354749a81a4d00c86d8e6ec`。完整记录见 [Windows Actions 运行 35420294000](https://github.com/RocYan98/CodexBoard/actions/runs/35420294000)。平台元数据确认为 `win32` / `x64` / Node `v22.23.2`，整体结论为 **failure**。

| 检查            | 通过 | 失败 | 跳过 |
| --------------- | ---: | ---: | ---: |
| contracts       |   49 |    0 |    0 |
| web             |  204 |    0 |    0 |
| taskctl         |   97 |    6 |    0 |
| server          |  510 |   98 |    1 |
| scripts         |   33 |   69 |    0 |
| desktop-scripts |  144 |   79 |    0 |

以上按 JUnit 的 testcase 记录统计。Node 脚本的失败包含超时及其连带取消，不代表相同数量的独立缺陷；服务端日志还记录了未处理异步错误，需要结合标准输出和标准错误分析。

四个 Node/Web 工作区构建、类型检查和 ESLint 均通过。Windows 上测试执行器自身 8 项回归全部通过，包括非零退出码、失败报告、挂起测试和遗留句柄。六组测试报告、编译日志及构建产物共 8 个 artifact 已上传。

桌面 Rust 检查返回 101，首个阻断为 `icons/icon.ico` 缺失，停在 `tauri-build`。该结果尚未覆盖项目中 Unix 专用 Rust 源码的后续编译错误。没有生成 Windows 桌面安装包。

首次运行暴露了两项测试设施问题：Windows 检出转换换行导致上游许可证哈希不匹配，以及脚本失败后遗留句柄阻止报告完成。当前提交分别通过保留仓库字节和测试超时解决；复测中许可证校验已通过，脚本组在约 121 秒后以失败状态输出完整报告。没有屏蔽失败测试或放宽产品权限保护。

后续适配优先项：

1. Windows 凭据和数据权限策略：现有 `0600/0700` 与所有者检查需要对应的 Windows 安全实现。
2. Git 路径等价性、盘符路径与 CLI cwd 校验，以及附件命令的执行端路径和 shell 语法。
3. Codex Desktop IPC、Unix socket、进程停止和 POSIX 启动包装器。
4. 将 `/private/tmp`、macOS 临时目录别名和固定正斜杠等测试夹具改为明确的平台语义，保留安全断言。
5. Windows 图标、桌面资源及 Rust 平台模块；之后验证安装更新与真实 Codex 会话。备份入口、浏览器超时等其他失败仍需分别复现定位。

## 2026-09-22 云桌面验证

本轮在云桌面中运行便携 Node `v22.23.2`（`win32` / `x64`）和最小测试包，使用独立临时用户配置与测试目录，未读取既有 Codex 账号或项目配置，未连接真实 Codex 会话。验证范围为测试执行器自身和项目快照脚本。

### 青椒云：修复前基线

环境为 Windows 10 IoT Enterprise LTSC 2021，build `19044`，使用 Administrator 账号执行。源码基线为 `234654491476088b64e32cf806751c912112dff0`（`2346544`）。

- 测试执行器：8 项全部通过。
- 项目快照：4 项中 1 项通过、3 项失败。
- 单独调用 `writeProjectSnapshot` 写入空项目快照，实际返回 `EPERM`，操作为 `fsync`。该直接探测与代码检查定位到原子替换之后的目录同步；Windows 不支持本实现使用的目录 fsync。

### 无影：快照修复后复测

环境实测为 Microsoft Windows Server 2022 Datacenter，版本 `10.0.20348`、build `20348`、64 位。运行时确认为 Node `v22.23.2` / `win32` / `x64`。

复测源码由基线 `2346544` 加当时尚未提交的以下两个文件改动组成：

- `scripts/codex-project-snapshot.mjs`：Windows 跳过目录 fsync，保留文件 fsync、原子 rename 和文件同步失败的错误传播。
- `scripts/codex-project-snapshot.test.mjs`：夹具使用平台原生绝对路径，补充同步顺序和失败保留旧快照测试，保留原有 `0600` 权限断言。

上述改动已通过独立审查；macOS 上该快照测试文件 6 项全部通过，格式与 ESLint 检查通过。云端确认外层验证包、便携 Node 包和修复源码包的 SHA-256 均校验成功。其中修复源码包 `codexboard-windows-snapshot-fix.zip` 的 SHA-256 为：

```text
5d0f15955b3defdb750b7607bdf05c47bca38bdf70abbaf5bade50b0db33b59a
```

无影结果从本轮生成的 `summary.json`、分组结果及日志所呈现的本地 HTML 逐项核验：

| 测试组         | 总数 | 通过 | 失败 | 跳过 | Node 退出码 |
| -------------- | ---: | ---: | ---: | ---: | ----------: |
| 测试执行器自身 |    8 |    8 |    0 |    0 |           0 |
| 项目快照       |    6 |    5 |    1 |    0 |           1 |

快照首次写入与替换前的文件 fsync、文件同步失败时保留旧文件并清理临时文件，以及状态文件原子替换后的监听更新均通过。唯一剩余失败是 `keeps the last good snapshot and reports only a safe error code` 中的权限断言，位置为本次测试包的 `scripts/codex-project-snapshot.test.mjs:192:12`：

```text
ERR_ASSERTION: 438 !== 384
```

十进制 `438` 对应 `0666`，期望的 `384` 对应 `0600`。该失败保持原样，未跳过测试或放宽断言。Windows 下的 mode 值不能替代 ACL 验证；当前尚未实现和验收等效的 Windows 权限保护。

本轮证明最小测试包可在上述两种实际 Windows 环境运行，并验证了 Server 2022 上的快照目录 fsync 修复。它不代表 Windows 11、Windows ACL 或标准用户隔离、桌面安装包与更新、完整应用、真实 Codex 登录及会话集成已通过；Windows 掉电后的目录持久性也未验证。

## 2026-09-22 Actions 提交后复测

快照修复提交 `db016ab539e0d5672a7de19ec719eab451b7188b` 推送后触发 [Windows Actions 运行 35748288642](https://github.com/RocYan98/CodexBoard/actions/runs/35748288642)。本次为 push 事件、首次运行，已于 `2026-09-22T15:38:24Z` 完成，整体结论为 **failure**。测试报告确认平台为 `win32` / `x64` / Node `v22.23.2`。

按六组 JUnit testcase 记录核对，最终结果如下：

| 测试组          | 总数 | 通过 | 失败 | 跳过 | Node 退出码 |
| --------------- | ---: | ---: | ---: | ---: | ----------: |
| contracts       |   49 |   49 |    0 |    0 |           0 |
| web             |  204 |  204 |    0 |    0 |           0 |
| taskctl         |  103 |   97 |    6 |    0 |           1 |
| server          |  609 |  511 |   97 |    1 |           1 |
| scripts         |  104 |   37 |   67 |    0 |           1 |
| desktop-scripts |  223 |  144 |   79 |    0 |           1 |

scripts 的 67 项 JUnit 失败包含 66 项普通失败和 1 项超时取消；整组约 121 秒后输出完整报告。测试执行器自身 8 项回归全部通过。

项目快照在完整 scripts 组内仍为 **6 项中 5 项通过、1 项失败**，与无影云桌面的独立复测一致。唯一失败仍是 `keeps the last good snapshot and reports only a safe error code` 在 `scripts/codex-project-snapshot.test.mjs:192:12` 的 `438 !== 384` 权限断言。文件 fsync 与原子替换顺序、文件同步失败时保留旧快照，以及原子替换后的监听更新均通过。原始证据见 [本次 scripts 测试 artifact](https://github.com/RocYan98/CodexBoard/actions/runs/35748288642/artifacts/10703163260)。

与 2026-09-19 基线逐项对比，scripts 从 33 项通过、69 项失败变为 37 项通过、67 项失败：项目顺序读取和状态替换后的监听两项由失败转为通过，新增的两项文件同步回归均通过。server 从 510 项通过、98 项失败、1 项跳过变为 511 项通过、97 项失败、1 项跳过；变化来自 `test/web-accounts.test.ts` 的 `locks after five guesses across service instances and disables existing sessions`，只记录本次运行差异，不归因于快照修复。其他四组计数与基线相同。

四个 Node/Web 工作区构建、类型检查与 ESLint 均通过，六组报告、构建产物及编译证据共 8 个 artifact 已上传。桌面 Rust 检查仍返回 101，阻断于 `tauri-build` 缺少 `icons/icon.ico`；后续 Rust 平台编译错误尚未覆盖，也未生成 Windows 桌面安装包。

## 官方 Windows Codex 运行环境安装验证

在无影 Windows Server 2022 Datacenter（build `20348`）上，以管理员账号验证了 [OpenAI 官方 Windows MSIX 包](https://persistent.oaistatic.com/codex-app-prod/ChatGPT-x64.msix)。包版本为 `26.915.4065.0`、架构 `x64`、大小 `824570408` 字节，SHA-256 为：

```text
fb4745f5378c8a4122f74643a3c7c1000da5f4b184f0d9dc9faf275c79ac73a4
```

包经 25 个分片上传，逐片及合并后的全包哈希均通过；官方许可证文件哈希通过，MSIX 的 Authenticode 签名状态为 `Valid`。使用 `Add-AppxProvisionedPackage -Online -PackagePath -LicensePath` 完成系统预配，未使用 `SkipLicense` 或 `Regions all`。当前用户已存在同版本包登记，无需再次执行 `Add-AppxPackage`。

当前用户包最初显示 `DeploymentInProgress, Servicing`，随后只读复查确认 `Status: Ok`、`SignatureKind: Store`，登记验证结果为 `verified-without-changes`。包名为 `OpenAI.Codex`，显示名为 `ChatGPT`。

从开始菜单启动后，实际看到白色 OpenAI logo 加载画面；此后浏览器控制连接丢失，尚未确认登录页或主界面。连接中断本身不构成应用崩溃或安装失败的证据。

2026-09-23 通过 Chrome 恢复无影画面后，已实际看到该应用登录后的工作主界面，启动及已登录界面验证通过。此后没有创建项目或任务，也没有验证在线令牌、任务执行或 CodexBoard 集成。

本次验证的是 OpenAI 官方 Codex 运行环境的安装与主界面启动，不是 CodexBoard Windows 安装包。上述结果不证明 Windows 11、IPC、真实任务或完整应用功能已通过。

## 2026-09-23 Windows 桥接实机检查

在 `4a80653` 上只读审查现有桥接入口，并核对已下载官方 MSIX 的 manifest 与文件表。桌面入口为 `app\ChatGPT.exe`，CLI 为 `app\resources\codex.exe`；包内另一个 `app\Codex.exe` 不能据文件名当作 CLI。包内容核对不等于云桌面运行验证。

真实集成验证前仍有以下代码阻断：

| 位置                                                                              | 当前行为                                                                   |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `scripts/codex-desktop-session.mjs`                                               | 默认连接 `codexHome/ipc/ipc.sock`，调用方尚未发现或传入 Windows 管道地址。 |
| `scripts/codex-desktop-loader.mjs`                                                | 连接失败后的自动打开线程仅支持 `darwin`，启动命令使用 `/usr/bin/open`。    |
| `apps/desktop/scripts/setup-controller.mjs`                                       | 程序探测仍使用 macOS/Unix 路径，没有 MSIX 包与 `codex.exe` 的发现流程。    |
| `apps/server/src/modules/codex/supervisor.ts`、`scripts/codex-session-bridge.mjs` | supervisor 固定构造 `unix://`，桥接 CLI 也只接受该协议。                   |
| `scripts/run-codex-app-server.mjs`、`apps/server/src/modules/codex/transports.ts` | 仍依赖 POSIX `0600` 权限检查，Windows ACL 的等效保护未实现。               |

随后在同一无影 Windows Server 2022 云桌面中，通过管理员 PowerShell 直接执行分段输入的只读查询，并在 Windows Chrome 中逐项查看生成的 `report.html`。报告时间为 `2026-09-23T00:29:04.0452817+08:00`；预先准备的 `Inspect-Codex-Runtime.ps1/.cmd` 未上传、未执行。

| 检查              | 实测结果                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| 当前用户包        | `OpenAI.Codex`，版本 `26.915.4065.0`，架构 `X64`，`Status: Ok`，`SignatureKind: Store`                 |
| PackageFamilyName | `OpenAI.Codex_2p2nqsd0c76g0`                                                                           |
| InstallLocation   | `C:\Program Files\WindowsApps\OpenAI.Codex_26.915.4065.0_x64__2p2nqsd0c76g0`                           |
| 包内文件存在性    | `app\ChatGPT.exe`、`app\resources\codex.exe`、`app\resources\app.asar` 均为 `true`                     |
| 开始菜单入口      | `Get-StartApps` 精确匹配到 `Name: ChatGPT`、`AppID: OpenAI.Codex_2p2nqsd0c76g0!App`                    |
| 安装目录内进程    | 观察到 `ChatGPT.exe` 进程；本次筛选结果未出现运行中的 `Codex.exe`                                      |
| 命名管道候选      | 名称筛选得到 6 条：`\\.\pipe\codex-ipc`，另有 1 条 sandbox、3 条 browser-use 和 1 条 computer-use 名称 |

进程查询仅选择 `ProcessId`、`ParentProcessId`、`Name` 和 `ExecutablePath`，先限定名称为 `ChatGPT.exe` 或 `Codex.exe`，再限定可执行文件位于上述包安装目录。管道检查仅枚举 `[IO.Directory]::GetFiles('\\.\pipe\')` 返回的名称，并以 `codex|openai` 筛选。上述进程与管道结果是检查时刻的快照；没有匹配进程不能独立证明应用崩溃，候选管道名也不证明其归属、协议、ACL 或连接可用。

本轮新建报告保存在云桌面的 `C:\Users\admin\Downloads\037d6e48-7008-48cc-9be1-3809b5d37600\`，包含 `result.json`、`report.html` 和初步包信息页 `package.html`。文件未下载到 Mac。查询没有读取认证文件、进程命令行、环境变量列表或现有日志；仅使用 `USERPROFILE` 定位 Downloads 目录。没有连接 IPC、接管会话、启动真实任务或修改安全策略。

本轮确认了已安装包、运行进程及 `codex-ipc` 命名管道候选的存在，下一步仍需实现 Windows IPC 适配并验证实际协议与权限。上述静态桥接阻断、CI 失败、Rust 图标缺失和 `0600` 权限断言失败均未因此解决；不能据此认定 CodexBoard Windows 版可运行。桥接 `/readyz` 在 helper 启动前即可返回 200，也不能作为集成成功的证据。

## 2026-09-23 Windows 适配后的验证

实现提交 `cd1309a087937439ee010d2b76d42a30edca324c` 的 [Actions 运行 35805907531](https://github.com/RocYan98/CodexBoard/actions/runs/35805907531) 已通过 Windows Rust 编译、Node/Web 构建、类型检查、ESLint 及 contracts/taskctl/web 测试。scripts、server、desktop-scripts 仍有失败，保持失败状态继续修复。安装作业已编译出 Windows 原生程序，但被 `webview2-com-sys@0.38.2` 缺少许可证正文阻断，未生成可用安装包。

同日在无影 Server 2022 中，从上述提交下载 `probe-codex-desktop-ipc.mjs` 和 `codex-local-endpoint.mjs`，核对两文件 SHA-256 后，以既有便携 Node 22.23.2 运行。真实 `\\.\pipe\codex-ipc` 初始化返回：

```json
{ "status": "ready", "transport": "named-pipe", "framing": "uint32le-json", "initialized": true }
```

结果保存在既有 Downloads 测试目录的 `ipc-probe.json`。探针只建立临时连接并发送 `initialize`，随后关闭连接；没有读取会话列表、订阅任务、读取历史或启动任务。该结果确认 Windows Desktop IPC 传输与初始化协议，不代替完整应用、用户权限隔离、真实任务执行或 Windows 11 验证。

随后在同一云桌面直接运行 `findWindowsCodexPackage()`，成功返回该已登记包中的 CLI、桌面程序路径及 `OpenAI.Codex_2p2nqsd0c76g0!App`；结果位于 `windows-package.json`。

`492b4dbddc325eba74f7c131294471160004ba92` 的权限实现、测试与 fixture helper 经 SHA-256 核对后，在无影运行 `node --test --test-reporter=spec private-file-permissions.test.mjs`。三项全部通过、零失败、零跳过、退出码 0：原子替换保留权限且拒绝真实 Everyone 读取授权；拒绝非文件和符号链接目录且不修改目标；独立读取 DACL 确认只含当前用户授权并关闭继承。原始输出为 `acl-test.txt`，可读摘要为 `acl-report.html`，均在上述 Downloads 目录。本次使用管理员账号，不能据此宣称普通用户之间的隔离测试已完成。

### 第二轮完整 Windows 测试

[Actions 运行 35806691028](https://github.com/RocYan98/CodexBoard/actions/runs/35806691028) 对应提交 `492b4dbddc325eba74f7c131294471160004ba92`。六组完整测试均以退出码 0 完成，JUnit 统计如下：

| 测试组          | 总数 | 通过 | 失败 | 跳过 |
| --------------- | ---: | ---: | ---: | ---: |
| contracts       |   51 |   51 |    0 |    0 |
| taskctl         |  103 |  103 |    0 |    0 |
| server          |  613 |  611 |    0 |    2 |
| web             |  204 |  204 |    0 |    0 |
| scripts         |  117 |  117 |    0 |    0 |
| desktop-scripts |  233 |  221 |    0 |   12 |
| 合计            | 1321 | 1307 |    0 |   14 |

Node/Web 构建、类型检查、ESLint 和 Rust Windows 全目标编译同时通过。跳过项为平台专属用例及原有条件跳过；Windows Skill 参数传递、真实 ACL、命名管道与桌面 UI 用例保持运行。测试通过不能替代安装包在真实桌面的安装与启动验证。

### Windows 测试安装包

第二轮 Actions 的安装作业与汇总作业均成功，生成 `windows-x64-test-installer-492b4dbddc325eba74f7c131294471160004ba92` artifact。安装程序为 `CodexBoard Windows Test_0.1.10_x64-setup.exe`，大小 `54561103` 字节；`build-info.json` 标记为 `win32` / `x64`、`signed: false`、`release: false`。本轮没有发布正式 Release。

安装程序先在 Mac 下载并通过随包 SHA-256 校验，随后在无影下载同一 artifact 并解压，`Get-FileHash` 返回相同 SHA-256：

```text
37303ee7dd019fec8fb9c355a1a8677a4104f49b6b78d21856b457cb723b3269
```

Mac 文件位于 `~/Downloads/CodexBoard-Windows-Test-492b4db/`；无影文件位于上述 Downloads 测试目录下的 `installer-492b4db/`。

### 首次安装实机检查发现入口判断问题

无影中的 NSIS 向导自动安装 Microsoft WebView2 后完成安装；默认位置为 `C:\Users\admin\AppData\Local\CodexBoard Windows Test\`。已实际打开 CodexBoard 主窗口，但状态显示“服务管理器已退出，请重新打开应用”，应用内暂无运行日志。安装包内的 Node 可以运行 `runtime/packages/taskctl/dist/cli.js --help` 并返回退出码 0。通过托盘“退出 CodexBoard”正常退出后，主程序进程数为 0。

随后只读比较 Windows 路径，确认 Tauri 传入的 `\\?\C:\...\runtime\desktop\runtime.mjs` 与 Node 模块 URL 转回的 `C:\...\runtime\desktop\runtime.mjs` 在原始字符串比较中不相等。现有 `resolve(process.argv[1]) === fileURLToPath(import.meta.url)` 入口判断因此可能跳过主函数；该检查没有导入或运行服务管理器、读取配置或启动业务任务。本安装包的桌面运行验证判定为未通过，继续修复入口判断后复测，不能将本轮 CI 成功等同于实机启动成功。

### 原生 Node 启动边界的进一步复现

提交 `86e1e090dcdf30f4f582e49bb4863d2382894823` 修复入口 URL 比较、保留 POSIX 符号链接行为并加入真实 Windows 命名路径启动回归。[Actions 运行 35809032465](https://github.com/RocYan98/CodexBoard/actions/runs/35809032465) 中，contracts、taskctl、server、web、Node/Web 构建与 Rust 检查通过；scripts 为 126 项中 122 通过、4 失败，desktop-scripts 为 239 项中 223 通过、4 失败、12 跳过。新增的 8 项失败均发生在 Node 22.23.2 自身的入口解析阶段，报 `EISDIR: illegal operation on a directory, lstat 'C:'` 或 `lstat 'D:'`，尚未执行应用 JavaScript。已保存报告后取消仍在执行的旧安装包编译，避免继续产出已知启动链路存在问题的包。

无影也用仅包含 `console.log("ENTRY_OK")` 的临时脚本复现：普通路径成功，添加 `\\?\` 前缀后报相同 `EISDIR`；添加 Node 的 `--preserve-symlinks-main` 参数后成功。此前仅临时替换已校验的 runtime/Skill 脚本不足以修复原生启动；原文件备份位于测试 Downloads 目录的 `entryfix-backup-492b4db/`。

进一步以 `86e1e09` 的真实 runtime 脚本、命名路径形式的资源目录及全新的 `runtime-diag-86e1e09/` 数据目录运行，添加上述 Node 参数并通过 stdin 请求停止。实测返回启动状态、预期的缺少连接配置提示、`id: 42, ok: true` 的停止响应和最终停止状态；进程退出码 0，标准错误长度 0。输出保存在同一测试 Downloads 目录的 `runtime-diagnostic.jsonl` 与 `runtime-diagnostic.err`。诊断未配置公网入口或启动业务任务；还需把该入口参数接入原生启动边界并重新验证完整安装包。

随后仅在一次测试应用进程的环境中传入 `NODE_OPTIONS=--preserve-symlinks-main`，未修改系统环境变量。完整应用实际进入使用引导，服务概览显示预期的未配置提示，原先“服务管理器已退出”的故障不再出现。该次诊断使用临时替换的脚本与进程级参数，不能代替修复后安装包在不带参数覆盖时的验收；Skill 原生入口会清除 `NODE_OPTIONS`，仍需新原生程序验证。

该诊断应用关闭窗口后仍驻留托盘，通过“显示主窗口”恢复成功；随后选择“退出 CodexBoard”，应用主进程和安装目录下的 Node 进程均已退出。现有官方 Codex 会话未受操作。

### 大写入口与 PowerShell 命名路径回归

提交 `a17b7e99ee083a11f65437c9d71442dd75516288` 的 [Actions 运行 35810128167](https://github.com/RocYan98/CodexBoard/actions/runs/35810128167) 已通过 Node/Web 构建、Rust 编译及 contracts、taskctl、server、web 测试。scripts 仍有 2 项失败，desktop-scripts 仍有 3 项失败：4 项为整体大写路径使 `.mjs` 变为 `.MJS`，触发 Node 的 `ERR_UNKNOWN_FILE_EXTENSION`；另一项为 PowerShell 包装器无法处理命名空间安装目录。普通命名空间入口已通过。保存测试报告后取消了仍在执行的安装包构建。

无影以含 `import` 的独立 ESM 临时文件复现相同的大写扩展名失败。先用 `realpathSync.native` 恢复实际文件名大小写，再带上述 Node 参数启动，返回 `ESM_OK`、退出码 0。Rust 原有临时脚本只有 CommonJS 兼容语句，不能暴露此问题；回归现已加入 `type: module`、显式 `import/export`，保留大写命名路径用例。PowerShell 路径拼接和文件检查改用 .NET 文件系统 API；无影也确认反斜杠命名路径的 `File.Exists` 和 `Process.Start` 可成功运行捆绑 Node，退出码 0。

这些定位结果仍需新一轮完整 Windows CI 和新安装包无参数覆盖启动验证。

### 修复后的完整测试结果

提交 `6f256a8221cda7fd869ad86a3d19229bbbc247c2` 的 [Actions 运行 35810830531](https://github.com/RocYan98/CodexBoard/actions/runs/35810830531) 中，六组 `result.json` 均确认 `win32` / `x64` / Node `v22.23.2`、`status: passed`、`exitCode: 0`、`signal: null`。按 JUnit testcase 独立核对如下：

| 测试组          | 总数 | 通过 | 失败 | 跳过 |
| --------------- | ---: | ---: | ---: | ---: |
| contracts       |   51 |   51 |    0 |    0 |
| taskctl         |  103 |  103 |    0 |    0 |
| server          |  613 |  611 |    0 |    2 |
| web             |  204 |  204 |    0 |    0 |
| scripts         |  130 |  130 |    0 |    0 |
| desktop-scripts |  241 |  229 |    0 |   12 |
| 合计            | 1342 | 1328 |    0 |   14 |

14 项跳过均为其他平台专属用例：macOS `.app` launcher 2 项、macOS `taskctl.sh` 8 项、POSIX umask 1 项、POSIX SIGTERM 1 项、macOS `/tmp` 别名 1 项、macOS HOME/Documents 默认路径 1 项。Windows 命名空间、大写别名、真实 ESM 入口、PowerShell 包装器和独立 ACL 用例均实际运行并通过。Node/Web 构建、类型检查、lint、Rust 全目标编译及 Rust 启动真实 ESM 脚本也通过。

无影另行下载同一提交的 `taskctl.ps1`，SHA-256 为 `e85b4aac54d3b9bab2c455fc7d7b71cf842bf8aa505c13e3131306e556af8a01`。在子 PowerShell 中指定大写命名空间形式的既有测试安装目录，执行 `--help` 返回正常帮助及退出码 0；原进程环境随后恢复。输出为同一 Downloads 测试目录的 `wrapper-6f256a8-help.txt`。该检查只运行帮助，不读取用户会话或业务数据。

上述 Actions 最终整体成功，安装作业生成 artifact `10729823381`（`windows-x64-test-installer-6f256a8221cda7fd869ad86a3d19229bbbc247c2`）。`CodexBoard Windows Test_0.1.10_x64-setup.exe` 为 `54568595` 字节，Mac 和无影均通过随包校验，双方 SHA-256 一致：

```text
96ae313a8fe21335ba685a8fd38b4d9eeed25eefb7f6de654d256d3ea2f159a2
```

Mac 安装包位于 `~/Downloads/CodexBoard-Windows-Test-6f256a8/`，无影位于上述 Downloads 测试目录的 `installer-6f256a8/`。构建信息仍为 `win32` / `x64`、版本 `0.1.10`、`signed: false`、`release: false`，未发布正式 Release。

### 新安装包在无影中的正常启动验收

在同一 Windows Server 2022 Datacenter x64、管理员账号下，NSIS 选择“添加/重新安装”，保留 `C:\Users\admin\AppData\Local\CodexBoard Windows Test\` 目录，完成新包覆盖安装。此次使用安装向导的正常启动入口，随后也直接启动 `codexboard-desktop.exe`；没有设置 `NODE_OPTIONS` 或复用此前诊断启动对象。当前 PowerShell 的 `NODE_OPTIONS` 为空。

| 检查           | 实测结果                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 安装资源       | `runtime/desktop/runtime.mjs` 和 `runtime/scripts/node-script-arguments.mjs` 的 SHA-256 均与 `6f256a8` 源码一致，已替换此前临时诊断脚本。  |
| 首次启动       | 正常显示“让 Codex 使用 CodexBoard”提示，选择“稍后”后进入使用引导。                                                                         |
| 服务管理器     | 主程序及安装目录下的 Node 进程保持运行；服务概览显示预期的缺少连接配置提示，不再显示“服务管理器已退出”。                                   |
| Codex 探测     | 应用设置显示已安装 `OpenAI.Codex_26.917.686.0_x64__2p2nqsd0c76g0` 内的 `app\resources\codex.exe`。                                         |
| Skill 原生入口 | 应用设置 → Agent Skill 可读取并重新检查状态，显示“尚未安装”及随包版本 `0.1.10`，没有管理工具不可用错误。未安装 Skill 或进行 CLI 身份授权。 |
| 内置 CLI       | 同版本 PowerShell 包装器自动发现更新后的应用，`--help` 正常输出，退出码 0；输出为 `installed-6f256a8-help.txt`。                           |
| 关闭与恢复     | 关闭窗口后后台仍运行；通过托盘“显示主窗口”恢复成功。                                                                                       |
| 正常退出       | 通过托盘“退出 CodexBoard”后，限定安装目录的应用和 Node 进程计数为 0。                                                                      |
| 再次启动       | 不带参数覆盖重新启动成功，服务概览仍为预期的未配置状态；主窗口保留在无影浏览器面板。                                                       |

本次确认测试安装包的安装、正常启动、原生 Skill 状态查询、CLI 帮助、托盘行为与退出后重启通过。尚未配置或保存公网隧道、飞书凭据、Web 账号，后台业务服务及公网入口未启动；真实 Web/飞书登录、CLI 用户配对和业务任务执行均未验证。既有官方 Codex 会话未退出、未接管、未触发真实任务。Windows 11、标准用户之间的隔离及正式签名/发布升级也未验证，不能据本轮桌面启动验收宣称全部功能已可用。

### 2026-09-23 用户配置后的后台启动修复

用户随后完成连接配置，原 `6f256a8` 安装包启动后台时提示“后端未能就绪，请检查端口占用或运行日志”。启动前检查四个本机端口 `58978`–`58981` 未发现占用；使用随包 Node 打开并关闭 `better-sqlite3` 内存数据库成功，退出码 0。提交 `d1c9b2c` 增加安全启动诊断后，实机记录为 `INTERNAL_ERROR; Error`、后端退出码 1，没有系统错误码或 Node 加载错误码。

通过随包 Node 按 UTF-8 解析本机 Codex 全局状态，确认 JSON 有效，`local-projects` 为有效空对象，且没有 `project-order` 字段；检查只输出字段类型与数量。原项目快照读取器把这一初始空状态当作无效格式，阻断后台初始化。提交 `48c666ae29762f72f0f294ac80eb9cdd78664b82` 仅兼容“有效空项目对象且排序字段未定义”的情况；非空项目缺少排序、无效字段类型与损坏 JSON 仍拒绝，刷新失败仍保留最近有效快照。新增回归覆盖初始空状态、随后添加有序项目，以及上述错误边界。本地项目快照与桥接等定向检查共 26 项全部通过，独立审查通过。

无影在保留用户现有配置的情况下，临时替换并校验了修复后的 `codex-project-snapshot.mjs`，SHA-256 为：

```text
1d3181c32f6427703d9ca6bef4b81fe1771022a1ee3151a64bfa4960eafcf74b
```

重启后日志出现 `Public and local admin listeners are ready`，主界面显示后端已连接、frp 运行中；Caddy 等待证书并记录 ACME challenge 失败。使用从已保存隧道配置推导出的公开 Host `test.rocyan.cn`，对本机进行无认证只读检查：

| 请求                                         | 实测结果                                                          |
| -------------------------------------------- | ----------------------------------------------------------------- |
| `GET http://127.0.0.1:58978/api/health`      | `status: ok`、`service: codexboard-server`、`checks.sqlite: ok`。 |
| `GET http://127.0.0.1:58978/api/v1/projects` | HTTP `401`，未授权访问被拒绝。                                    |

检查没有读取运行令牌、调用业务 CLI 或输出隧道配置及凭据。随后在无影下载并校验同一 `48c666a` 提交的 `server-smoke.mjs`，SHA-256 为：

```text
8f185919ba5a90dd2a06c401259d6409f1ce13420205ab18f7ad2624d9acb72b
```

该脚本对实机已安装的随包后台执行隔离冒烟测试，返回 `status: passed`，后台健康、网页资源、未授权访问拒绝和优雅退出检查均通过。另将程序文件复制到独立 D 盘测试目录，并使用含中文和空格的目录名重复验证，均通过；用户配置未复制。其 `codexMode` 为 `isolated-fake-websocket`，使用隔离的模拟 Codex 对端；结果不证明真实 Codex 登录或任务集成通过。

同一提交的 [Actions 运行 35814478656](https://github.com/RocYan98/CodexBoard/actions/runs/35814478656) 整体仍为 **failure**。contracts、taskctl、server、web、scripts 五组通过；desktop-scripts 为 246 项中 233 通过、1 失败、12 跳过，失败发生在 `server-smoke.test.mjs` 测试进程，原生退出码为 `3221226505`（`0xC0000409`）。安装作业的随包后台冒烟检查另报 `SMOKE_BACKEND_EXITED: CONFIG_INVALID,EXIT_1`，未产出本轮可验收的新安装包。两个 CI 失败均保留，继续修复；无影隔离冒烟通过不替代 CI 失败的解决。

最新 DNS 查询中，`test.rocyan.cn` 的 A 记录为 `101.133.133.237`，HTTPS 仍未就绪。本轮已确认临时修复后的本机后台健康与未授权访问边界；新安装包覆盖安装、无临时替换的启动及配置后复验仍待完成。Codex 在线登录有效性、真实 Web/飞书登录、CLI 用户配对及业务任务执行均未验证，不能据此认定 Windows 适配已全部完成。

### Windows 隔离环境与中文目录复制的进一步诊断

提交 `36aac4c7d15ad5caec501bb33cdaa7db85f5a2c9` 的 [Actions 运行 35816268259](https://github.com/RocYan98/CodexBoard/actions/runs/35816268259) 仍为 **failure**。六组报告合计 1352 项：1337 通过、1 失败、14 跳过。唯一测试失败在 desktop-scripts 的打包冒烟夹具，最后阶段为 `workspace-copy`，尚未开始后台启动；测试进程以 `3221226505`（`0xC0000409`）退出。安装作业则保留了 `CONFIG_INVALID`、`CODEXBOARD_CODEX_TOKEN_FILE`、`ACL_FAILED` 诊断，继续定位隔离子进程中的 ACL 检查。

安装作业在相同隔离目录和文件上进行两因素对照：是否补充固定系统环境字段并设置仅含系统安装目录的 `PSModulePath`，以及是否预建隔离 profile 目录。四种环境中的 PowerShell 基础启动均成功；ACL 读取结果如下：

| 系统环境与系统模块路径 | 预建 profile 目录 | ACL 读取结果                       |
| ---------------------- | ----------------- | ---------------------------------- |
| 未补充                 | 否                | 20029 ms 后超时，`ETIMEDOUT`。     |
| 已补充                 | 否                | 302 ms，标记 `PRIVATE`，退出码 0。 |
| 未补充                 | 是                | 20024 ms 后超时，`ETIMEDOUT`。     |
| 已补充                 | 是                | 275 ms，标记 `PRIVATE`，退出码 0。 |

该对照确认本轮隔离环境中的 ACL 超时可由系统环境与系统模块路径组合修复，单独创建 profile 目录不能解决。系统模块路径没有继承用户自定义 `PSModulePath`；该结果也未放宽当前用户专属 DACL 校验。

另在无影 Node `22.23.2` 上复现：对含中文路径执行不带 `filter` 的递归 `cpSync`，可触发相同原生退出码；为复制增加始终返回 `true` 的 `filter` 后，完整 runtime 复制成功、退出码 0。这个过滤函数保留所有文件，只切换复制遍历路径，未排除文件或跳过冒烟测试。工作树据此修复 Windows 工作区包复制与 PowerShell 子进程环境；全部检查通过及新安装包实机复验仍待后续运行确认。

公网检查随后看到 Caddy 日志 `certificate obtained successfully`。只读核对本机端口为 API `58978`、管理接口 `58979`、bridge `58980`、Caddy `58981` 后，在无影执行：

```powershell
curl.exe --noproxy '*' --resolve test.rocyan.cn:58981:127.0.0.1 https://test.rocyan.cn:58981/api/health
```

请求保留域名与 TLS SNI，只将目标解析到本机 Caddy；没有使用 `-k` 或绕过证书验证。响应为 `status: ok`、`service: codexboard-server`、`checks.http: ok`、`checks.sqlite: ok`，确认本机 Caddy 证书、TLS 和后台转发链路通过。公网 `443` 的同一健康接口仍在 Windows 与 Mac 两端发生 TLS 握手失败，Mac 禁用代理后也相同。当前故障范围已缩小到公网入口或隧道链路，尚未修复，不能将本机 HTTPS 成功记为公网验收通过。

### 隔离启动与复制修复后的安装包

提交 `961dde9` 的 [Actions 运行 35817063740](https://github.com/RocYan98/CodexBoard/actions/runs/35817063740) 中，六组报告合计 1355 项：1340 通过、1 失败、14 跳过。desktop-scripts 为 249 项中 237 通过、12 跳过，先前的中文目录复制与隔离后台启动检查通过。唯一失败在 server 的 `execution-http.test.ts`：双执行 worker 取消测试结束后，清理 `repository-2` 时返回 `EBUSY`，原始失败保留，因此本轮整体仍为 **failure**。

安装作业独立通过随包后台健康、网页资源、未授权访问拒绝和 IPC 优雅退出的冒烟检查，成功产出 [测试安装包 artifact 10731323672](https://github.com/RocYan98/CodexBoard/actions/runs/35817063740/artifacts/10731323672)。Mac 使用 `gh run download` 下载并解压，再以 `shasum -c` 校验安装程序，结果为 `OK`，未单独核对 ZIP 摘要；无影 Windows 同时核对 ZIP 的官方摘要与安装程序摘要，两者均一致。`CodexBoard Windows Test_0.1.10_x64-setup.exe` 的 SHA-256 为：

```text
e3cc9eebf03b0dffb66438df920fcb01866435982448a078958fbb7e30a07479
```

server 清理失败定位为测试夹具未等待假执行器释放后仍在运行的真实 Git 工作区指纹采集。修复提交 `469708e946b77569f7f99a07a7be669c9ea514eb` 等待实际任务终态与指纹落盘，再关闭应用阻止新增采集，最后等待已开始的采集完成后清理目录；没有改产品停止语义、跳过用例、吞掉 `EBUSY` 或改为重试删除。该修复通过独立审查、本地 5 项 HTTP 回归、server 类型检查及格式和静态检查，Windows 测试结果见下节。

无影已完成上述 `961dde9` 安装包的重装：先通过托盘正常退出旧应用并确认应用进程数为 0，再由 NSIS 在原目录 `C:\Users\admin\AppData\Local\CodexBoard Windows Test\` 安装并保留用户配置。点击 Finish 后正常启动，没有设置临时 `NODE_OPTIONS` 或替换随包脚本。主界面显示本机服务运行正常，后台与 Caddy 已连接、frp 运行中。

安装后的三个关键文件与同一提交源码逐一核对，SHA-256 均一致：

| 安装目录内文件                                   | SHA-256                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| `runtime\desktop\runtime.mjs`                    | `9e1df1b32f230d5b5174bc113df2c449d5166c610e10d6b31f6610c533ff5b7c` |
| `runtime\scripts\windows-system-environment.mjs` | `fa8c8c41ece991516ae0e22ceca04b2d08a392be0672fcd6095d255ad4086f93` |
| `runtime\scripts\codex-project-snapshot.mjs`     | `1d3181c32f6427703d9ca6bef4b81fe1771022a1ee3151a64bfa4960eafcf74b` |

重装后再次以 `--resolve test.rocyan.cn:58981:127.0.0.1` 和正常证书验证请求本机 HTTPS 健康接口，返回 `status: ok`、`checks.http: ok`、`checks.sqlite: ok`；项目接口未登录请求返回 `401`。本轮确认 `961dde9` 原始安装包在现有用户配置下可正常启动并提供本机 HTTPS 服务。公网 `443` 最近一次检查仍为 TLS 握手失败；真实登录、CLI 用户配对和业务任务未验证。经 Git 差异核对，`469708e` 相比 `961dde9` 仅有测试夹具变化，产品源码和打包脚本未变，因此复用 `961dde9` 的实机验收，不要求重复云桌面安装；这不代表公网验收通过。

### 清理修复后的 Windows 自动测试

提交 `469708e946b77569f7f99a07a7be669c9ea514eb` 的 [Actions 运行 35818027885](https://github.com/RocYan98/CodexBoard/actions/runs/35818027885) 已完成，整体结论为 **success**，全部 10 个作业成功，包括安装作业和汇总作业。六组测试报告均为 `win32` / `x64` / Node `v22.23.2`、退出码 0。按报告核对如下：

| 测试组          | 总数 | 通过 | 失败 | 跳过 |
| --------------- | ---: | ---: | ---: | ---: |
| contracts       |   51 |   51 |    0 |    0 |
| taskctl         |  103 |  103 |    0 |    0 |
| server          |  613 |  611 |    0 |    2 |
| web             |  204 |  204 |    0 |    0 |
| scripts         |  135 |  135 |    0 |    0 |
| desktop-scripts |  249 |  237 |    0 |   12 |
| 合计            | 1355 | 1341 |    0 |   14 |

14 项均为平台条件跳过，Windows 打包后台冒烟检查实际运行并通过。此前 server 的工作区清理失败已通过；Rust 检查与构建作业也成功。独立核对安装作业原始日志，`2026-09-23T04:24:21Z` 记录随包后台健康、网页资源、未授权访问拒绝和 IPC 优雅退出四项冒烟检查通过，随后 NSIS 完成。

最新构建产物为 [测试安装包 artifact 10732337440](https://github.com/RocYan98/CodexBoard/actions/runs/35818027885/artifacts/10732337440)，artifact ZIP 大小 `54560278` 字节，上传日志记录的官方 ZIP SHA-256 为：

```text
87e35ca1d94bb561fd4f1e2aa8b6881d2cfe477238165e6524fe5d17fd6fcd8e
```

最终证据由 `469708e` 的完整 Windows CI 与 `961dde9` 原始安装包的无影实机验收组成；`469708e` 相比 `961dde9` 仅有测试夹具变化，产品源码和打包脚本未变。无影已验证保留用户配置的重装、正常启动、本机 Caddy TLS、后台健康和未登录访问拒绝。公网 `443` 最近一次检查仍存在 TLS 握手失败，Codex 在线登录有效性、真实 Web/飞书登录、CLI 用户配对和业务任务执行均未验证。此处确认 Windows 自动构建、测试及本机安装运行通过，不代表公网、真实任务、Windows 11、标准用户隔离或正式签名发布已完成验收。
