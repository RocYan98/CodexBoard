# CodexBoard macOS 应用（HTTP / HTTPS）

当前支持 Apple Silicon、macOS 13 或更新版本。内置 Node 运行时。

应用打开时启动三个服务：CodexBoard 后端（内嵌 Codex 桥接）、Caddy 和 frpc。关闭主窗口时隐藏窗口和 Dock 图标，仅保留菜单栏图标，服务继续运行；通过菜单栏「显示主窗口」恢复窗口和 Dock 图标。选择菜单栏「退出 CodexBoard」、按 Command-Q 或使用系统应用菜单退出时，应用停止自己启动的后台进程。界面的「停止服务」仍可手动停止服务。Codex Desktop 和它已经执行的任务不会被应用关闭。

「打开看板」先检查本机部署配置、后台服务和公网入口，再唤起飞书客户端中配置的应用，不会回退到浏览器。缺少配置、服务未就绪或公网入口不可用时显示「未部署完成」。当前应用没有飞书发布状态查询权限，这些检查不包含开放平台版本发布状态；尚未发布或无可见权限的应用仍由飞书客户端处理。此版本是本机服务管理应用，尚未将完整看板嵌入桌面窗口。

## 本机配置

首次启动自动创建 `~/Library/Application Support/CodexBoard/` 下的数据、证书与配置目录。路径由当前用户目录推导，不读取 desktop.env 或 production.env，不保存自定义目录或 Codex 路径。正式部署沿用现有配置目录及看板数据。

应用自动查找 Codex Desktop / ChatGPT 内置程序及常见 CLI 路径，使用本机登录状态；新安装 Codex 后无需重启管理应用即可重新检测。工作区允许目录在服务启动时读取 Codex Desktop 项目列表。macOS 临时任务根目录由当前用户主目录动态推导为 `~/Documents/Codex`，创建临时任务时自动递归创建目录，不提供路径编辑入口。

「使用引导」可切换查看 Web 或飞书步骤；连接配置不区分互斥模式。飞书应用与 Web 账号可以同时使用：配置飞书凭据启用飞书入口，配置 HTTPS 并在本机「应用设置 → Web 账号」创建账号启用浏览器入口。仅使用 Web 时可同时留空两项飞书凭据。旧 `deploy/access.json` 不再控制运行方式。两项飞书凭据一起保存到 `secrets/feishu-credentials.json`，隧道配置保存到 `secrets/frpc.toml`；文件权限为 `0600`。公网入口从唯一匹配本机 Caddy 端口的隧道读取：HTTP/HTTPS 隧道按 `type` 识别协议，读取 `customDomains`，分别使用公网 80/443；TCP 使用公网 IPv4 `serverAddr` 和 `remotePort`，固定为 HTTP。没有手动域名、端口或证书配置项。HTTP 公网访问不会加密会话与业务数据。内部桥接令牌首次启动自动生成，之后保持不变。

## 使用引导与检查

侧栏「使用引导」固定为配置 frp 客户端、创建飞书应用、确认 Codex 登录三步，可单项检查或一键检查。DNS 解析和公网访问检查合并在第一步内，根据隧道模式显示对应说明。首次启动缺少连接配置时自动显示引导，已有完整配置继续显示运行概览。

1. frp 客户端与公网访问：将完整 frpc.toml 粘贴到「连接配置」，让隧道转发到 `127.0.0.1:<当前 Caddy 端口>`，保留服务商提供的服务器与认证参数。HTTPS/HTTP 域名入口显示 DNS 解析信息，按服务商要求添加 A/CNAME；TCP 公网 IPv4 入口显示无需 DNS，但仍需检查公网访问。隧道检查验证 TOML、本机转发、内置 `frpc verify` 和服务端口连通性，不会启动第二个 frpc 连接；访问检查验证需要时的 DNS、HTTPS 证书及看板健康响应。单纯返回 HTTP 200 不算通过。若本机未运行、配置未保存或待重启，会提示无法确认新配置已生效。账号认证、节点授权和额度仍需在服务商后台确认。
2. 飞书：创建企业自建网页应用，配置桌面与移动主页、同源 H5 可信域名及重定向 URL，申请 `contact:user.employee_id:readonly` 字段权限，发布版本并设置可用范围。引导中的地址来自最近检查的 frpc 表单内容；尚未检查时使用已保存配置。检查会向飞书官方接口验证 App ID 和 App Secret，取得的应用 token 不保存、不显示。
3. Codex：提供官方下载入口及打开本机应用的按钮，用户在 Codex 中完成登录。只读执行 `codex login status`，仅显示登录状态分类，不显示命令原始输出，不读取或保存账号密码、API Key。在线令牌有效性和额度仍需实际请求确认。

检查使用连接表单当前填写内容，不自动保存或重启。实际修改输入或本地配置后，已有结果会标为过期，需要重新检查；启动时加载已保存配置不算修改。保存有变化的配置后仍由用户选择立即重启或稍后手动重启。应用发布、使用范围、安全设置与飞书端实际登录不会仅凭凭据验证被标为完成；引导将这些项目显示为「需确认」。检查结果仅保存在本次进程内存中。

## 自动识别公网连接

`frpc.toml` 是公网配置的唯一来源，应用自动配置 Caddy、后端 Origin、登录 Cookie 和引导检查。`customDomains` 只表示域名，HTTP/HTTPS 协议由 `type` 决定；TCP 固定 HTTP。

HTTPS 由 Caddy 自动签发和续期证书，需要域名解析正确且公网 443 能到达本机 Caddy。标准 frpc 配置不包含服务端的 HTTP/HTTPS 监听端口，因此使用 80/443，不推测非标准端口；此类入口需先在隧道服务端按标准端口配置。不能自动确定唯一入口时提示配置错误，不要求填写额外公网字段。

旧版的 `public-access.json` 和手动导入的证书、私钥不再读取或影响启动；已有文件保留，应用不再写入这些文件。保存后仍由用户选择立即重启或稍后重启，不迁移或接管 Codex 会话。

## 端口设置

「连接配置 → 端口设置」折叠区域管理以下端口；本机监听仍限制在 `127.0.0.1`。

| 项目         | 默认值或来源 | 保存位置                                                     |
| ------------ | ------------ | ------------------------------------------------------------ |
| 后端 API     | `58978`      | `deploy/ports.json` 的 `api`                                 |
| 本机管理 API | `58979`      | `deploy/ports.json` 的 `admin`                               |
| Codex 桥接   | `58980`      | `deploy/ports.json` 的 `bridge`                              |
| Caddy        | `58981`      | `deploy/ports.json` 的 `caddy`，并同步对应隧道的 `localPort` |

`deploy/ports.json` 位于应用自动生成的配置目录，只保存四个本机端口，frpc 服务端口不在此页面显示或修改。端口必须是 `1` 到 `65535` 的整数，四个本机端口不能重复。保存本机端口保留 `frpc.toml` 中原有的 `serverPort`，仅同步对应隧道的 `localPort`。

## 飞书身份

任何通过飞书登录验证的账号都可以直接操作同一看板，无需管理员初始化、成员登记或项目授权。飞书身份、姓名和头像从成功登录的飞书账号读取；独立 Web 账号由本机应用管理。CLI 不提供创建用户的入口。

新任务负责人固定为当前登录用户，详情静态显示任务实际负责人；不能指定其他人或清空。评论区显示真实 Web / 飞书用户、Desktop 用户或 Codex：用户请求 Codex 通过已授权的 CLI 会话代写时署用户，Codex 执行事件同步的结果署 Codex。CLI 配对同时支持 Web 与飞书用户，所有业务查询和写入均需有效用户会话；Desktop 输入及 Codex 结果由绑定会话的执行事件独立同步，不要求 CLI 持续登录。CLI 登录与评论命令通过 `taskctl --help` 查看。

## 构建

安装 Node 22、Rust stable 和 Xcode Command Line Tools，然后在仓库根目录执行：

```sh
npm ci
npm run build:desktop
```

产物：`apps/desktop/dist/CodexBoard.app`。

构建脚本下载并校验固定 SHA256 的 Node 22.23.2、Caddy 2.11.4 和 frp 0.70.0 macOS arm64 包，编译前后端及 Tauri，复制锁定的生产依赖，并完成 ad-hoc 签名及 SQLite 冒烟测试。运行时没有 Homebrew Node 动态库依赖。

发布构建可归一化 Rust 编译路径，避免原生二进制中的错误位置包含本机用户目录：

```bash
CARGO_ENCODED_RUSTFLAGS="--remap-path-prefix=$HOME=/build" npm run build:desktop
```

应用只复制运行所需的桥接脚本，以及后端、前端、共享协议和 taskctl 的编译产物。项目自身的 source map、类型声明、测试和开发辅助脚本不进入分发包；开发目录的构建产物仍可保留类型信息。第三方依赖的运行文件和许可声明保留。精简分发内容不等于源码加密：包中的 JavaScript 仍可读取。

本地预览版尚未使用 Apple Developer ID 签名和公证，下载后的首次运行可能被 macOS 拦截。当前脚本只生成 `.app`，不自动生成 DMG。若另行制作 DMG，应从本次通过验证的 `.app` 制作，不把仓库、下载缓存、旧版应用或配置数据一起放入。

## 分发与安装

接收方需要 Apple Silicon Mac、macOS 13 或更新版本，并安装和登录 Codex、飞书客户端。应用已包含 Node、后端、内嵌桥接、SQLite 组件、Caddy 与 frpc，无需另外安装 Node、Docker 或开发工具；公网 frp 服务端不在安装包中。

1. 将 `CodexBoard.app` 复制到「应用程序」目录；升级前先正常退出已有的 CodexBoard。
2. 打开应用，按照「使用引导」配置自己的飞书应用与完整 frpc.toml；使用域名时完成对应 DNS 配置。
3. 检查连接和服务状态，在飞书中打开看板并验证登录。

应用更新通过替换整个 `.app` 完成。用户数据和配置位于 `~/Library/Application Support/CodexBoard/`，不会因正常替换应用而被覆盖。分发时只发送应用产物，保留自己电脑上的该目录；不要把其中的 `secrets/`、数据库、附件、日志或运行时描述复制给接收方。

旧版使用 `~/Library/Application Support/Lark-Codex/` 或更早的 `~/Library/Application Support/Lark Codex Taskboard/`。升级首次启动会等待旧应用释放实例锁，并在新目录不存在时原子移动完整旧目录，保留数据库、附件、配置及权限。两个目录同时存在、路径含链接或旧实例仍占用时会显示错误并保留内容，不合并、不覆盖、不自动备份。

主程序和 bundle identifier 已统一为 `codexboard-desktop`、`cn.rocyan.codexboard.desktop`。更新包保留旧名 `Contents/MacOS/lark-codex-desktop` 和 `Contents/MacOS/taskboard-desktop` 的小型转发启动器，仅用于兼容已发布版本的结构校验与更新后重启；更新公钥保持不变。

随包 Skill 使用 `manage-codexboard`。检测到旧 `manage-lark-codex` 或 `manage-lark-taskboard` 目录时会提示交由原管理工具处理，不自动改名或覆盖；新目录内的旧安装凭据也需要按已修改内容重新确认。

应用启动后及运行期间每 15 秒检查随包 Skill 与可信安装记录，版本增加或同版本内容变化都会显示顶部更新提示。关闭提示仅针对当前版本与内容；另一份更新仍会提醒。已修改的 Skill 保留替换确认，受管目录不跟随链接或直接覆盖。检查只比较本机随包内容，不查询第三方技能管理器的远端版本。

桌面 `.cache/`、`staging/`、`src-tauri/target/` 和过时的 `dist/` 是可重建产物，不属于运行数据。删除这些目录会使下次构建重新下载或编译；应先保留计划分发的已验证应用。

## 验证

```sh
node --test apps/desktop/scripts/*.test.mjs
npx eslint apps/desktop/scripts/*.mjs apps/desktop/ui/app.js --max-warnings=0
codesign --verify --deep --strict "apps/desktop/dist/CodexBoard.app"
```

实际验收应覆盖端口冲突、修改 Caddy 端口后隧道同步、配置保存后选择立即重启或稍后、三个服务启动、公网健康检查、Codex 鉴权初始化、停止/重启、关闭窗口后继续运行、菜单栏恢复窗口及彻底退出后的进程释放。不要在运行数据库的同时启动第二套服务。

## 内嵌 Codex 桥接

桌面版使用 `CODEXBOARD_CODEX_TRANSPORT=embedded`，直接在后端进程中加载桥接模块与项目快照监听。业务 API、本机管理 API 和受 token 保护的桥接接口由同一进程按已配置端口提供；保留本机 WebSocket 接口兼容现有调用，不再运行独立的桥接 Node 服务。退出或启动失败时，后端统一释放监听器。

## 连接配置页面

页面直接加载本地文件内容，App Secret 默认遮蔽，可切换显示。飞书凭据和 frpc 空值会提示补全。公网信息和证书不需要单独填写或导入。保存前校验凭据、隧道域名及 frpc 官方验证结果；通过后只写回文件。

连接配置与端口设置保存成功且内容实际变化后，应用弹出重启提示，可选择「立即重启」或「稍后手动重启」。内容未变时显示「配置未更改」，不新增重启提醒。选择稍后时，页面显示「配置待重启生效」，运行中的服务继续使用原配置；可通过「重启服务」应用新配置。保存动作本身不会重启服务。

应用定期读取文件，更新未编辑的字段；正在编辑的字段保留输入，保存成功后显示落盘内容。连接内容仅通过本机应用通信提供给界面，不记录到运行日志。

旧版升级会将 production.env 中的 App ID 与 feishu-app-secret 合并，核对成功后删除两个旧文件。新安装不会创建这两个文件。存在多个匹配隧道或域名、没有匹配本机端口的 HTTP/HTTPS/TCP 隧道等情况会提示修正 frpc.toml，应用不会猜测公网地址。

公开发布内容不包含个人部署记录。新安装按本说明和自己的配置执行。

## 独立 Web 账号

在「应用设置」展开「Web 账号」后创建、停用账号或重置密码，点击「用浏览器打开看板」使用默认浏览器登录。要求 HTTPS，不提供公开注册。Web 账号无需飞书登录；配置步骤见 [用户指南](../../README.md)。

所有可折叠区域初始默认收起，包括使用引导各步骤、连接配置页中的「飞书应用与公网隧道」与端口设置，以及应用设置页中的 Web 账号、Agent Skill 和应用更新；点击标题可展开或收起。填写配置、管理账号、Skill 通知和更新通知等定向入口会展开对应区域，方便直接操作；普通页面切换保留当前展开状态。

应用设置的「应用更新」提供「前往 Release 手动下载」链接，用默认浏览器打开最新发布页；自动检查或下载失败时仍可使用。

应用更新支持系统代理及环境代理；可在「更新下载代理」临时填写 HTTP、HTTPS、SOCKS5 或 SOCKS5h 地址（例如 `http://127.0.0.1:7890`），留空恢复自动选择。该字段仅本次应用窗口会话有效，不落盘，不支持含账号密码的地址；检查更新和下载均在发起时使用当前输入。菜单栏检查更新使用自动代理。系统代理自动读取不代表支持浏览器扩展或 PAC 脚本，遇到此类配置可填写实际代理监听地址。下载继续由官方更新插件验签。

## 1.0.0 Windows x64 发布

通过 `npm run build:desktop:windows` 在 Windows x64 构建 NSIS 安装器。两端打包同一套 Web、服务器、桥接与技能代码。Windows CI 执行六套测试、Rust 编译、内置后端冒烟以及完整安装包构建。默认安装目录 `%LOCALAPPDATA%\CodexBoard Desktop`，数据目录 `%LOCALAPPDATA%\CodexBoard`。Windows 当前仅支持下载安装器升级，未启用 macOS tar 更新协议，也没有 Authenticode 签名。

正式包 `CodexBoard-1.0.0-windows-x64-setup.exe` 及 SHA-256 与 macOS DMG、签名更新包一同发布。构建和安装曾在 Server 2022 验证；Windows 11 与真实任务执行需单独验收。
