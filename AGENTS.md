# CodexBoard：Agent 安装与使用指南

[面向用户的 README](README.md)

本指南仅在**用户请求安装、配置、排障或使用 CodexBoard** 时适用。读取本文件本身不触发安装、配置修改或任务执行，也不要求处理源码的 Agent 先安装应用；既有上级及宿主规则继续适用。

以下操作针对已发布的 macOS / Windows 应用，无需克隆源码或安装开发环境。命令与界面以实际安装版本为准；命令不匹配时先按第 5 节定位包装器并查看帮助，不要猜测接口。

## 1. 执行边界

- 根据用户当前请求推进安装或操作；可逆准备和只读检查不必重复确认。只有缺少具体决定或授权时才询问。
- 保留现有数据、配置和未完成任务。不要退出 Codex Desktop、接管已有 Codex 会话，或为验证安装而启动真实任务。
- 优先通过 CodexBoard 的「连接配置」「端口设置」「使用引导」操作；当前没有对外承诺的无头配置 CLI。
- App Secret、完整 frpc.toml（可能含隧道 token）、CLI 会话文件、内部令牌和 `runtime.json` 不得输出到对话、日志或 Issue。请用户在应用界面输入凭据；不要索要密码、复制飞书客户端 token 或关闭脱敏。
- 创建任务、评论、执行任务、响应审批、删除数据等写操作必须符合用户请求。CLI 查询与写入均使用真实 Web 或飞书用户配对授权；浏览器已登录不代表 CLI 已获授权，需要用户在配对页确认。安装授权本身不包含业务操作。

## 2. 确认设备、版本和已有安装

1.0.0 提供 **macOS arm64** 与 **Windows x64** 包，不支持 Intel Mac、Windows arm64 或 Linux。macOS 要求 13 或更新版本；Windows 在 Server 2022 验证，Windows 11 实机与真实业务任务尚未验证。先按当前系统选择检查与安装流程。

macOS 读取：

```sh
uname -m
sw_vers -productVersion
```

如果 `uname -m` 返回 `x86_64`，继续用 `sysctl -n hw.optional.arm64` 判断是否为 Rosetta 下的 Apple Silicon；结果为 `1` 才支持当前 arm64 包。确认前不要安装。

检查 `/Applications/CodexBoard.app` 和以下目录是否存在，只读取必要元信息，不展示私密文件内容：

```text
~/Library/Application Support/CodexBoard/
├── data/       数据库、附件、运行时信息
├── secrets/    飞书凭据、frpc 配置、内部令牌
├── deploy/     本机端口配置
└── caddy/      证书与 Caddy 状态
```

存在数据目录就按升级处理；不要清空目录或覆盖成发布者的配置。首次升级启动时，若新目录不存在且旧版已退出，应用会自动迁移旧版数据目录；新旧目录同时存在或目录受其他进程占用时按提示处理，不手工合并或覆盖。正常替换 `.app` 保留这些数据。需要备份时先确认备份位置及访问权限；复制整个数据目录应先正常退出 CodexBoard，避免只复制正在写入的 SQLite 主文件。

应用内置 Node、后端、网页前端、Codex 桥接、SQLite 组件、Caddy 和 frpc 客户端。用户仍需安装并登录 Codex，并准备公网 frp 服务；使用飞书入口或飞书 CLI 配对时，还需飞书客户端和自己的飞书应用。Web 看板和 Web CLI 配对无需飞书登录。**不需要另外安装 Node、Docker、Rust 或 Homebrew。**

## 3. 下载、校验与安装

1. 从用户提供的 GitHub 仓库或 Release 页面读取版本、资产名和实际下载 URL。仓库未明确时只询问仓库链接；不要猜测 owner/repo 或拼接未经核对的资产地址。
2. 下载同一 Release 的 `macos-arm64.dmg` 及对应 `.sha256` 文件。避免把自动生成的 Source code 压缩包当作安装包；预发布版本需符合用户选择。
3. 将两个文件保存在同一目录，核对 SHA-256。例如，实际文件名与下面完全一致时执行：

   ```sh
   cd "$HOME/Downloads"
   shasum -a 256 -c "CodexBoard-1.0.0-macos-arm64.dmg.sha256"
   ```

   其他版本使用实际文件名。检查校验文件中的文件名与下载的 DMG 一致；必须得到 `OK`。失败就停止安装并重新核对下载来源，不修改校验值来通过检查。校验和用于检查文件完整性，不等于 Apple 公证或发布者身份认证。

4. 升级前通过菜单栏「退出 CodexBoard」或 Command-Q 正常退出旧版，等待它启动的服务停止。关闭窗口只会隐藏应用，不能作为退出判断；不要使用范围过大的 `pkill node` 或结束 Codex。
5. 挂载 DMG，将完整的 `CodexBoard.app` 拖入「Applications」。已有旧版时替换整个应用包，不合并内部文件，也不从挂载卷直接作为长期安装运行。
6. 从 `/Applications/CodexBoard.app` 启动应用，然后推出 DMG。

当前版本使用本地 ad-hoc 签名，尚无 Developer ID 签名及 Apple 公证。若 macOS 拦截，说明当前状态与实际提示，请用户在确认来源后通过系统「隐私与安全性」处理首次打开。此系统安全决定交给用户；不要自动清除 quarantine、关闭 Gatekeeper 或执行绕过系统保护的命令。若系统报告恶意软件或文件损坏，应停止并核对原包，不能把所有拦截都归因于未公证。

### Windows 安装与升级

- 使用 PowerShell `[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture` 确认 x64；从同一 Release 下载 `CodexBoard-1.0.0-windows-x64-setup.exe` 及 `.sha256`，用 `Get-FileHash -Algorithm SHA256` 比较，失败停止。
- 正常退出旧 CodexBoard，保留 `%LOCALAPPDATA%\CodexBoard` 数据目录。运行完整 NSIS 安装器，默认程序目录 `%LOCALAPPDATA%\CodexBoard Desktop` 与数据目录分离。旧 Windows Test 程序需退出，新版沿用原数据；不启动第二套服务，不接管 Codex Desktop。
- WebView2 可由安装器下载。当前没有 Authenticode 签名；系统安全决定由用户处理，不关闭 Defender、SmartScreen 或修改 PowerShell 执行策略。
- Windows 通过下载新版安装器升级，不能使用 macOS `.app.tar.gz` 或 macOS 更新替换流程。
- Agent Skill 的 Windows 入口为同目录 `scripts/taskctl.ps1`（cmd 可用 `taskctl.cmd`），默认探测 `%LOCALAPPDATA%\CodexBoard Desktop`。自定义安装目录使用 `CODEXBOARD_APP_PATH`；数据目录默认 `%LOCALAPPDATA%\CodexBoard\data`。首次只读检查运行 `& $TASKCTL --help`、`& $TASKCTL health`、`& $TASKCTL auth status`；业务操作仍须完成第 6 节用户配对。

### macOS 应用内更新

已有版本可通过「应用设置 → 应用更新」或菜单栏「检查更新…」检查版本，读取更新说明后按用户授权下载。下载过程会验签；只有确认「安装并重启」才会停止本机服务并替换应用。先处理正在执行的任务和未保存配置，不能把“检查更新”的授权当作“现在重启”的授权。

不要自行下载 `.app.tar.gz` 后绕过更新器解压覆盖，也不要修改 `latest.json` 或签名让检查通过。自动安装失败时，根据实际错误改用同版本 DMG，保留数据目录；不要结束 Codex Desktop。

## 4. 用应用界面完成配置

### 公网隧道和端口

打开「端口设置」或「使用引导」，读取**当前 Caddy 端口**，不要把文档默认端口当作当前值。在「连接配置」粘贴服务商或用户自行准备的完整 frpc.toml，保留其服务器地址、控制端口与认证参数。

使用引导可切换 Web 或飞书流程：配置 frp 客户端、设置 Web 账号或飞书应用、确认 Codex 登录。引导选择仅改变说明与检查内容；连接配置可同时保存飞书和公网配置，无需选择互斥模式。DNS 解析和公网访问检查位于第一步内；HTTPS/HTTP 域名模式显示解析信息，TCP 公网 IPv4 模式显示无需 DNS。TCP 仍需验证公网访问。

公网地址只从 frpc.toml 推导。必须且只能有一个启用的 HTTP、HTTPS 或 TCP 代理匹配 `127.0.0.1`（或 `localhost`）及当前 Caddy 端口；修正匹配关系，不增加手工公网地址文件。

| 隧道类型 | 公网入口规则                 | 配置要点                                                                      |
| -------- | ---------------------------- | ----------------------------------------------------------------------------- |
| `https`  | `https://域名`，公网 443     | `customDomains` 中只有一个完整域名；443 能到达本机 Caddy，由 Caddy 管理证书   |
| `http`   | `http://域名`，公网 80       | 协议取自 `type`，域名本身不能决定 HTTPS                                       |
| `tcp`    | `http://公网IPv4:remotePort` | `serverAddr` 必须是公网 IPv4；不填写 `customDomains` 或 `subdomain`，无需 DNS |

HTTP/TCP 模式明文传输登录会话与业务数据；Web 账号密码登录只允许 HTTPS，HTTP/TCP 不支持该登录方式。飞书入口正式使用时也应优先配置 HTTPS。当前应用按 HTTP/HTTPS 标准公网端口工作，不从 frpc 控制端口推测网页端口。公网 frp 服务端不随应用安装。

域名模式按隧道服务商实际提供的入口设置 A/CNAME；不能仅因 `serverAddr` 是控制服务器就认定它一定是 DNS 目标。代理应直接转发到本机 Caddy，不依赖 `includes`、`store.path`、`subdomain` 或代理插件来推导入口。

修改本机端口用「端口设置」保存：四个本机端口必须互不相同，Caddy 端口变化会同步对应隧道的 `localPort`。不要误改 frpc 的 `serverPort`。

### Web 账号与访问控制

1. 配置 HTTPS 入口，保存后启动服务；实际配置变更需要重启生效。
2. 用户在本机“应用设置 → Web 账号”创建账号，也可从连接配置的“管理 Web 账号”进入。密码长度 8–256 位；没有公开注册接口。不要在对话中索取用户密码，也不要直接写数据库创建账号。
3. 让用户从浏览器实际登录验证。使用引导自动检查服务、运行配置和启用账号数量；它不验证用户密码或真实登录。
4. 仅用 Web 时，飞书 App ID 和 App Secret 均可留空；若填写必须成对配置。有效飞书配置与 Web 账号可以同时使用同一公网入口。

Web 账号是受信任的看板用户，能创建并执行任务、作为本人新建任务的负责人和评论作者；不能伪造或指定其他人的身份。账号共用看板，目前没有按项目隔离的权限。停用账号或重置密码会使已有浏览器登录失效。域名和 HTTPS 不是用户权限机制，未登录访问仍需被拒绝。

Web 账号可用于第 6 节的 CLI 配对。创建账号或浏览器登录并不自动授权 CLI；仍须在授权页核对并确认。

### 飞书应用（可与 Web 同时配置）

1. 由用户在飞书开放平台创建企业自建网页应用，在「连接配置」输入该应用的 App ID、App Secret。
2. 先检查当前 frpc 表单，让「使用引导」生成该用户自己的地址；不要沿用截图、历史部署记录或发布者的域名。
3. 按引导的复制按钮填写桌面端主页、移动端主页、同源 H5 可信域名和重定向 URL。重定向 URL 保留引导提供的末尾 `/`，不要自行猜测 `/callback` 路径。
4. 申请「获取用户 user ID」权限 `contact:user.employee_id:readonly`，完成开放平台版本发布，并设置需要使用该应用的人员可用范围。
5. 用户在飞书客户端登录；部署就绪后，通过 CodexBoard「使用引导 → 打开飞书验证」进入自己的飞书应用并验证实际登录。

App ID/App Secret 检查仅验证凭据；不能据此判断应用已发布、可用范围正确或用户登录已成功。当前没有应用发布状态查询能力，这些项目需要通过飞书后台和实际登录确认。

### Codex 与保存生效

请用户安装并登录 Codex。CodexBoard 自动检测本机 Codex 程序和登录状态，项目来自 Codex Desktop 项目列表。需要添加项目时在 Codex Desktop 中完成；不要尝试用 taskctl 创建或注册项目。

「使用引导」检查的是当前表单，不自动保存、不自动重启。按结果修正后保存配置，再按用户当前意图选择立即重启或稍后重启；稍后重启时运行服务仍使用旧配置。相同配置无需反复保存和重启。

只有服务启动、当前配置生效后，再做公网访问和真实 Web / 飞书登录验证；同时启用时分别验证。连接配置和端口设置支持窗口自适应，小窗口可滚动到保存按钮。Codex 登录状态检查不证明在线令牌有效、额度充足或真实任务执行成功；没有执行授权时将真实执行标为「未验证」。

## 5. 安装 Skill 并调用内置 taskctl

首次启动且尚未安装配套技能时，「让 Codex 使用 CodexBoard」提示提供「安装到 Codex」和稍后选项；之后可通过「应用设置 → Agent Skill」安装、更新或重新检查。首版仅支持 Codex，默认将 `manage-codexboard` 安装到 `~/.agents/skills/`。

安装只写入技能文件，不包含 CLI 身份授权。已有用户修改时，只有用户明确选择「使用随包版本」才替换；符号链接或受其他工具管理的目录不直接覆盖。若已有旧版名称 `manage-lark-codex` 或 `manage-lark-taskboard` 的技能，或旧 `~/.codex/skills`、`$CODEX_HOME/skills` 中已有同名技能，按提示在原位置或管理器处理，不再复制第二份，也不自动改名。应用升级仅提示技能可更新，不静默覆盖。

成功状态只证明文件已安装。先在 Codex 技能列表确认，未识别时由用户按需强制重新加载技能或重新打开 Codex，再在新任务核验；不要为验证而退出 Codex Desktop、接管已有会话或启动真实业务任务。

CLI 示例使用该技能中的包装器，直接调用完整 `.app` 内的 Node 和 taskctl，不依赖源码目录或全局 Node。默认安装时：

```sh
TASKCTL="$HOME/.agents/skills/manage-codexboard/scripts/taskctl.sh"
"$TASKCTL" --help
"$TASKCTL" health
"$TASKCTL" auth status
# 若未登录，先按第 6 节配对，再查询项目
"$TASKCTL" project list
```

若技能已由其他目录管理，从实际加载的 `SKILL.md` 所在目录定位 `scripts/taskctl.sh` 并调整 `TASKCTL`；缺少包装器时先更新原管理器中的技能。包装器优先探测 `/Applications/CodexBoard.app`，其次是 `~/Applications/CodexBoard.app`。`CODEXBOARD_APP_PATH` 可覆盖应用位置，`CODEXBOARD_DATA_DIR` 可显式覆盖数据目录；默认仍为应用的 AppSupport `data` 目录。包装器保持调用工作目录，便于 `context` 定位项目，不自动启动服务。

CLI 自动从 `data/run/runtime.json` 读取本机管理地址和能力令牌；不要 `cat` 此文件，也不要在命令行拼接令牌。`--help` 不需要后台运行；其他命令依赖当前服务。找不到运行信息时先检查应用状态与数据路径，不启动第二套后端或创建伪造的 runtime 文件。

除帮助外，命令结果为 JSON。退出码 `0` 表示成功、`1` 表示服务/运行错误、`2` 表示用法错误。未登录时 `auth status` 可能报 `CLI_AUTH_NO_SESSION`，这不等于应用安装失败。

完成第 6 节用户配对后，使用只读查询定位用户说的项目和任务。下面的大写 ID 必须替换为上一步响应中的真实值，不能直接执行占位符：

```sh
"$TASKCTL" project dashboard PROJECT_ID
"$TASKCTL" project options PROJECT_ID
"$TASKCTL" issue list --project PROJECT_ID
"$TASKCTL" issue get TASK_ID
"$TASKCTL" job list --task TASK_ID
"$TASKCTL" job get JOB_ID
"$TASKCTL" lifecycle get TASK_ID
```

`issue get` 返回任务详情及评论、附件、关联、活动、执行信息。`issue read` 会更改已读状态，`project scan` 会触发扫描，二者不属于只读查询。

## 6. 查询或写入看板前完成用户配对

本机能力令牌不代表用户身份。安装应用、在飞书打开看板、用 Web 账号登录、登录 Codex，都不等于已授权 CLI。用户请求 Agent 代操作时，先检查 `auth status`；已有有效且身份正确的会话可复用，否则：

```sh
"$TASKCTL" auth login --label "我的 Agent"
```

把返回的 `verificationUrl` 和 `verificationCode` 交给用户；Web 用户在浏览器授权页登录，飞书用户在飞书中打开授权页，核对验证码、CLI 名称与当前身份并确认。此时等待真实确认，不替用户批准、不读取或手工生成会话 token。确认后再执行：

```sh
"$TASKCTL" auth complete
"$TASKCTL" auth status
```

只有 `health`、`backup create` 等明确本机运维和登录引导不需要用户会话；项目、任务、评论、附件、Git、事件、执行与审批等查询和写入均需有效用户会话。没有会话时不得改用本机管理身份。已绑定任务的代码开发和 Desktop 事件同步无需等待 CLI 配对；不需要调用 CLI 时，不应仅因读取本技能就发起配对。

若返回 `CLI_AUTH_PENDING`，配对尚未确认。登录请求约 10 分钟过期，会话约 8 小时过期，服务重启后需重新登录。Web 账号停用或重置密码也会撤销旧 CLI 授权和已确认待领取的配对。CLI 会话保存在当前用户私有配置目录，不需要读取其内容；失效时通过正常配对恢复，不能降级成管理身份。用户要求退出 CLI 授权时执行 `"$TASKCTL" auth logout`。

## 7. 按用户意图操作任务

先读取项目、任务和当前版本，再执行获授权的命令。执行前检查任务的 `codexThreadState` 和已有 jobs：`draft`、`started` 使用 `job continue`，仅 `none` 且没有主会话时使用 `job start`。新任务通常已绑定草稿会话；存在活跃执行时先处理它，不重复提交。以下是语法模板，不是安装验收脚本：

```sh
"$TASKCTL" issue create --project PROJECT_ID --title "用户确认的任务标题"
"$TASKCTL" issue update TASK_ID --version N --description "用户要求的描述"
"$TASKCTL" comment add --task TASK_ID --body "用户要求发布的评论"
"$TASKCTL" job continue --task TASK_ID --prompt "用户要求执行的内容"
```

新任务负责人固定为当前已授权的 Web 或飞书用户，通常省略负责人参数。不能伪造用户、指定其他人或清空负责人。用户代理评论署真实用户，Codex 执行结果由系统同步署 Codex；同步延迟时检查 job，不手工伪造结果评论。

- `--version N` 必须来自最近一次真实读取；写完重新读取验证。遇到 409 先重新读取并重新判断，不机械替换版本号重试。
- 请求超时或连接中断后，先读取任务、job 或生命周期状态确认是否已生效，不能立即重放创建、评论、执行、Git 等写命令。CLI 不承诺重复提交幂等。
- 启动和继续 job 会运行 Codex 并可能修改项目；只能用于用户实际授权的任务。收到审批或补充输入请求时呈现给用户，不自行批准。
- 不直接写 SQLite、不修改用户身份或运行时令牌，不绕过服务端业务限制。Git、附件、评论、标签等其他参数先查 `"$TASKCTL" --help`。

区分以下操作，不把“结束一下”自动解释为删除：

完成任务只做检查，不自动提交、不删除文件、分支或工作树，也不要求交付记录或合并提交证明。原本在 main 主工作树开发的任务，只检查 Git 是否干净；使用独立工作树或分支的任务，还检查任务工作树目录和 Git 登记已删除、任务分支已删除。调用前需已有用户验收，再确认任务处于 `in_review`、没有活跃执行或未执行评论，并读取最新版本。检查失败时保留任务状态，先处理提示中的具体问题再重试。

| 用户意图       | 操作与验证                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| 完成任务       | 已验收且获授权收尾后，`lifecycle request TASK_ID --version N --status done`；再用 `lifecycle get` 查询最终状态 |
| 取消任务       | `lifecycle request TASK_ID --version N --status canceled`；再查询最终状态                                      |
| 只停止当前执行 | `job cancel JOB_ID`；检查该 job，不把取消执行直接报告为任务已取消                                              |
| 隐藏任务       | `issue archive TASK_ID --version N`；`issue restore` 可恢复归档，也支持恢复已取消任务                          |
| 删除任务       | `issue delete TASK_ID --version N`；必须有明确删除意图，不能通过 `restore` 撤销                                |

生命周期请求返回不等于已经完成；检查阶段、错误与任务最终状态再报告。

## 8. 排障与交付报告

| 现象                                      | 优先检查                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| 关闭窗口后服务仍运行                      | 这是正常行为；用菜单栏恢复窗口，完全退出使用「退出 CodexBoard」                        |
| 提示配置需检查或待重启                    | 核对表单是否实际修改、结果是否过期、配置是否保存以及是否已重启；不清空现有配置         |
| 找不到 taskctl 运行信息                   | 核对 `.app` 真实位置、数据路径和桌面服务状态                                           |
| 本机正常，公网不可用                      | 查看唯一匹配的 frpc 代理、服务商认证/额度、DNS、标准公网端口、HTTPS 证书及看板健康响应 |
| 「使用引导 → 打开飞书验证」提示未部署完成 | 核对本机服务和公网入口；它会打开飞书客户端，不提供浏览器回退                           |
| 飞书凭据通过但无法登录                    | 核对主页、可信域名、重定向 URL、user ID 权限、版本发布与人员可用范围                   |
| CLI 查询或写入返回 401                    | 检查 CLI 用户会话；服务重启、会话过期或账号授权撤销后重新配对                          |
| Codex 项目缺失或执行失败                  | 检查 Codex Desktop 项目列表与登录状态；不要退出或接管用户已有会话                      |

诊断只收集必要错误码和脱敏状态，不索取整份配置目录。公网页面返回 HTTP 200 不足以证明它是有效看板，也不能替代真实飞书登录。

报告实际版本、安装位置、校验结果、配置是否保存生效、后台与公网检查结果、Web / 飞书真实登录和 CLI 配对是否完成。业务操作列出实际任务 ID、执行结果和回读证据；未验证的项目明确写「未验证」，不要把“检查通过”写成“全部功能可用”。

需要更详细的源码实现资料时，可查阅 [桌面应用说明](apps/desktop/README.md)。命令用法使用安装包内的 `"$TASKCTL" --help` 查看，配置流程见应用「使用引导」。
