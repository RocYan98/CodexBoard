# Windows 自动构建与测试

本阶段在 GitHub Actions 的 `windows-2022` x64 环境建立兼容性基线。工作流运行于 `feature/windows-ci` 分支推送、面向 `main` 的 Pull Request，以及手动触发。测试分支不自动合并、不发布 Release，也不替换现有 macOS 应用。

首次运行通过推送测试分支触发。GitHub 的 **Run workflow** 按钮通常要求工作流已在默认分支；保留 `workflow_dispatch` 供后续采用，不为显示按钮而将测试分支提前合并。

## 检查范围

| 作业                                     | 实际检查                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Node and web build                       | 使用 Node 22.23.2、`npm ci` 和锁文件，构建 contracts、taskctl、server、web；执行类型检查及 ESLint |
| contracts / taskctl / server / web tests | 各工作区完整 Vitest 测试，不通过排除 Windows 失败用例取得绿灯                                     |
| scripts tests                            | `scripts/` 下完整 Node 测试，显式展开文件列表，避免依赖 shell 通配符                              |
| desktop-scripts tests                    | 桌面脚本完整 Node 测试，包含 Chromium 和 WebKit 界面检查                                          |
| Desktop Rust compilation                 | 使用 Cargo 锁文件检查桌面程序及测试目标，记录 Windows 编译阻断                                    |

每个测试组独立运行，一个组失败不会取消其他组。失败保留非零退出码，工作流总状态也会失败。不能把“工作流成功启动”或“网页构建通过”解释为 Windows 桌面版已适配。

检出前关闭运行器的 Git 自动换行转换，保留仓库原始字节，避免带固定哈希的上游许可证被转换为 CRLF 后产生无关的校验失败。

Node 脚本测试使用 120 秒的测试超时；挂起或遗留句柄按失败记录到 JUnit，不强制将未退出的测试算作通过。Vitest 使用各工作区原有超时。外层作业另有时限，防止兼容性问题长期占用运行器。

本阶段不运行需要真实 Codex 的 `codex:protocol:check`，不启动真实任务、不使用飞书凭据，不运行依赖 Unix 模拟桌面的整体 `test:e2e`。Windows 安装包、运行时组件分发、标准用户权限与 ACL、真实 Codex 会话和安装更新验收属于后续阶段。GitHub Windows 运行器以管理员运行，不能代替普通 Windows 11 用户的权限验收。

## 产物与结果

在仓库 **Actions → Windows compatibility baseline** 查看具体提交的运行记录：

- `windows-x64-node-web-build-<commit>`：四个工作区编译结果及 `build-info.json`。它不包含 Node、生产依赖或桌面启动器，不是可安装或独立运行的 Windows 发行包。
- `windows-x64-tests-<suite>-<commit>`：JUnit 报告、标准输出、标准错误和带平台信息的 `result.json`。
- `windows-x64-desktop-check-<commit>`：Rust 工具链版本、编译日志和退出状态。

产物保留 14 天。安装依赖或作业超时可能导致报告不完整，此时以作业日志和失败状态为准。测试结果中的 skip 来自现有测试本身；新工作流没有按平台过滤测试。

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

## 2026-09-23 Windows 桥接检查准备

在 `4a80653` 上只读审查现有桥接入口，并核对已下载官方 MSIX 的 manifest 与文件表。桌面入口为 `app\ChatGPT.exe`，CLI 为 `app\resources\codex.exe`；包内另一个 `app\Codex.exe` 不能据文件名当作 CLI。包内容核对不等于云桌面运行验证。

真实集成验证前仍有以下代码阻断：

| 位置                                                                              | 当前行为                                                                   |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `scripts/codex-desktop-session.mjs`                                               | 默认连接 `codexHome/ipc/ipc.sock`，调用方尚未发现或传入 Windows 管道地址。 |
| `scripts/codex-desktop-loader.mjs`                                                | 连接失败后的自动打开线程仅支持 `darwin`，启动命令使用 `/usr/bin/open`。    |
| `apps/desktop/scripts/setup-controller.mjs`                                       | 程序探测仍使用 macOS/Unix 路径，没有 MSIX 包与 `codex.exe` 的发现流程。    |
| `apps/server/src/modules/codex/supervisor.ts`、`scripts/codex-session-bridge.mjs` | supervisor 固定构造 `unix://`，桥接 CLI 也只接受该协议。                   |
| `scripts/run-codex-app-server.mjs`、`apps/server/src/modules/codex/transports.ts` | 仍依赖 POSIX `0600` 权限检查，Windows ACL 的等效保护未实现。               |

下一步实机检查仅收集当前用户 `OpenAI.Codex` 包元信息、包内入口文件是否存在、匹配的开始菜单入口、安装目录内关联进程的 PID 与可执行文件路径，以及名称包含 Codex/OpenAI 的命名管道候选。不读取认证文件、命令行、环境变量或现有日志，不连接管道或接管会话。没有匹配进程或管道不能独立证明崩溃或没有 IPC；桥接 `/readyz` 在 helper 启动前即可返回 200，也不能作为集成成功的证据。
