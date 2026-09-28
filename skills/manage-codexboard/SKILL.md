---
name: manage-codexboard
description: 通过已安装的 CodexBoard 应用查询和管理飞书任务看板、任务附件、Codex 执行及任务收尾；当用户要求操作该看板时使用，不用于一般项目开发或普通 Git 操作。
---

# 管理 CodexBoard 任务看板

使用本技能的 [scripts/taskctl.sh](scripts/taskctl.sh) 调用应用内置 CLI。无需源码仓库、全局 Node 或 npm 构建。读取技能不会自动安装应用、授权会话或启动任务。

## 运行入口

先从本次加载的 `SKILL.md` 路径定位同目录下的包装器，将 `TASKCTL` 设为它的实际绝对路径。下面的路径是占位符，替换后再执行；在项目原有工作目录调用，不要为了运行 CLI 切换到技能目录。

```sh
TASKCTL="/实际安装目录/manage-codexboard/scripts/taskctl.sh"
"$TASKCTL" --help
"$TASKCTL" health
```

包装器依次寻找 `/Applications/CodexBoard.app`、`~/Applications/CodexBoard.app`，只调用所选应用内的 Node 和 taskctl。自定义安装位置可通过 `CODEXBOARD_APP_PATH` 指定；显式路径无效就报错，不回退到其他应用。默认数据目录是 `~/Library/Application Support/CodexBoard/data`，显式 `CODEXBOARD_DATA_DIR` 覆盖该目录；仅未设置新变量时兼容旧版数据目录覆盖。覆盖变量不接受空值。旧版数据迁移由应用启动时处理，包装器不移动数据。

```sh
CODEXBOARD_APP_PATH="/实际位置/CodexBoard.app" "$TASKCTL" --help
```

`--help` 无需后台运行，其余命令依赖已启动并配置好的 CodexBoard。缺少应用或运行信息时，请用户从应用界面完成安装、启动或配置；包装器不启动服务，不搜索凭据。配置页面为「连接配置」「端口设置」「使用引导」。本技能可从首次启动提示或「应用设置 → Agent Skill」安装到 Codex。

CLI 自动读取私有运行时描述，不要读取或展示 `runtime.json`、完整 frpc.toml、App Secret、内部令牌或会话文件，也不直接读写 SQLite。`context` 使用调用者的工作目录；空匹配不表示项目不存在，应结合项目列表确认。项目从 Codex Desktop 同步，CLI 不能创建或注册项目。

除帮助文本外，结果为 JSON；退出码 `0` 成功、`1` 服务或运行错误、`2` 用法错误。接口和参数以该安装版本的帮助为准，源码版本与安装版本不一定一致。异步受理不代表操作已完成。

## 身份与操作范围

先按用户请求区分代码开发、查询、任务修改、执行和收尾。仅需在现有对话中开发代码时，不要发起 CLI 配对；已绑定任务的 Desktop 对话和结果由后台事件同步，不依赖 CLI 会话。

需要通过 CLI 查询或操作看板时，先检查真实 Web 或飞书用户会话。看板业务读写均需用户登录，不能以本机服务身份执行；`health`、`backup create`、`attachment download` 和登录引导是明确例外。附件下载仅通过本机 loopback 管理接口和 runtime 能力令牌进行，不需要账号配对。已有有效且身份正确的授权可复用；安装技能、登录浏览器或 Codex 不等于已授权 CLI：

```sh
"$TASKCTL" auth status
```

没有有效会话时发起配对：

```sh
"$TASKCTL" auth login --label "Codex"
```

将返回的 `verificationUrl` 与 `verificationCode` 交给用户。Web 用户在浏览器登录授权页，飞书用户在飞书打开授权页；等待用户核对账号、CLI 名称与验证码并点击确认后，再完成配对。不要要求 Web 用户改用飞书：

```sh
"$TASKCTL" auth complete
"$TASKCTL" auth status
```

`auth complete` 只能在用户真实确认后运行；`CLI_AUTH_PENDING` 表示仍需等待。不能替用户确认、伪造身份或生成 token。服务重启、会话过期或 Web 账号停用/重置密码后需重新配对；未登录不是安装失败。配对只暂停需要 CLI 的业务操作，不阻塞已授权的代码开发。

新任务默认负责人为已授权的 Web 或飞书用户，不指定其他人或清空负责人。用户委托发布的评论署当前真实用户；不能以本机管理身份冒充作者。任务执行结果由系统以 Codex 来源同步。

## 定位与修改任务

完成配对后，可先运行 `"$TASKCTL" context` 与 `"$TASKCTL" project list` 定位项目。使用查询结果中的真实项目 ID、任务 UUID、job ID 和最新版本。`TEMP-004` 等显示编号不是任务 UUID；先在项目列表和任务列表中匹配，再读取详情。以下大写 ID、`N` 均需替换，不能原样执行。

```sh
"$TASKCTL" project options PROJECT_ID
"$TASKCTL" issue list --project PROJECT_ID
"$TASKCTL" issue get TASK_ID
"$TASKCTL" job list --task TASK_ID
```

详情包含评论、附件、关联、活动和执行信息。`issue read` 会修改已读状态，`project scan` 会触发扫描，不作为纯查询执行。

按用户请求创建或更新；带版本的写操作需刚刚读取的版本，写完回读确认。遇到版本冲突，先读取差异再判断，不机械替换版本重试。

```sh
"$TASKCTL" issue create --project PROJECT_ID --title "用户要求的标题"
"$TASKCTL" issue update TASK_ID --version N --description "用户要求的描述"
"$TASKCTL" issue move TASK_ID --version N --status in_review
"$TASKCTL" issue get TASK_ID
```

未传字段保持不变。`--start`、`--due`、`--context` 使用字面值 `null` 清空，`--labels`、`--description` 使用空字符串清空。负责人不能清空或改派其他人。

超时或断线后，先查询任务、执行或生命周期状态，确认请求是否已生效。同一命令再次执行不保证幂等，尤其不能盲目重复创建、评论、启动执行、Git 或备份操作。

## Codex 执行与交互

执行会运行 Codex 并可能修改项目，按用户授权范围启动或继续。读取任务的 `codexThreadState` 和已有 jobs：

- `draft` 或 `started` 表示已有主会话，用继续执行；执行列表为空不等于没有主会话，新任务通常已经绑定草稿会话。
- 只有明确为 `none` 且没有主会话时才启动新会话。
- 存在 `queued`、`running`、`waiting_approval`、`waiting_input` 或 `canceling` 执行时，先处理它，不重复提交。
- 当前 Agent 正在处理同一任务时，不再通过 CLI 启动另一轮相同工作。不要退出 Codex Desktop 或接管其已有会话。

```sh
"$TASKCTL" job continue --task TASK_ID --prompt "用户要求继续处理的内容"
"$TASKCTL" job start --task TASK_ID --prompt "用户要求执行的内容"
"$TASKCTL" job get JOB_ID
"$TASKCTL" interaction list --job JOB_ID
```

审批与补充输入以实际请求为准，向用户呈现待处理内容；只有已获相应决定后才响应，不自行批准。帮助中可查询 `interaction respond` 的 `accept`、`decline`、`cancel`、`input` 参数，输入使用实际问题 ID。

## 评论与附件

与任务绑定的 Codex 主会话最终回复会由原执行事件显示为 Codex 评论；中途 commentary 不同步为评论。只报告实际结果与证据。没有绑定主会话时，不声称当前回复会自动同步。同步延迟先检查原 job 和连接，不用手工评论伪造 Codex 结果，也不重复启动任务。

用户要求代发评论或保存文件到任务时，可使用已授权的 Web 或飞书用户会话执行：

```sh
"$TASKCTL" comment add --task TASK_ID --body "用户要求发布的评论"
"$TASKCTL" attachment upload --task TASK_ID --file "/实际文件路径/evidence.txt"
```

附件下载不需要用户账号配对；使用本机 runtime 能力令牌，直接运行：

```sh
"$TASKCTL" attachment download ATTACHMENT_ID --output "/用户指定目录/evidence.txt"
```

修改和删除仅限当前用户自己的评论。上传、下载路径按用户意图与目标项目规则确定，不把交付文件存入会被生命周期清理的临时目录。需要临时目录时，可使用实际任务工作区内的 `.tmp/taskboard/<任务UUID>/`；目录归属不明就先确认。

## 验证与任务收尾

对所做工作执行与该项目、改动和用户要求相适应的验证；本技能不指定其他项目必须使用的测试或 Git 工作流。报告实际检查结果和未验证项，不把测试通过说成用户已经验收。

用户只要求实现或等待审查时，可在适当验证后移到 `in_review`。用户验收后可请求完成任务：此操作只检查 Git 干净状态；独立工作树任务还检查工作树目录、Git 登记及任务分支均已删除，main 主工作树任务只检查 Git。不自动提交、清理或写入归档引用，不要求交付记录或合并证明。Git 提交与清理由项目规则和用户授权另行处理，不把单个任务授权扩展到其他改动。

完成前重读任务和 jobs；服务要求任务处于 `in_review`、无活跃执行及待执行评论。不要先手工删除生命周期需要检查的目录。

```sh
"$TASKCTL" issue get TASK_ID
"$TASKCTL" lifecycle request TASK_ID --version N --status done
"$TASKCTL" lifecycle get TASK_ID
```

请求受理后继续查询最终状态；只有 `succeeded` 才表示收尾成功。报告返回的阶段、错误和检查结果；只有任务状态确实更新为已完成才报告成功。失败时按具体原因处理并重试。

以下操作含义不同，依用户意图选择并回读验证：

```sh
"$TASKCTL" job cancel JOB_ID
"$TASKCTL" lifecycle request TASK_ID --version N --status canceled
"$TASKCTL" issue archive TASK_ID --version N
"$TASKCTL" issue restore TASK_ID --version N
"$TASKCTL" issue delete TASK_ID --version N
```

- 取消 job 只停止一次执行；取消任务使用生命周期并查询结束状态。取消任务会先停止执行，再只读检查主工作区 Git、任务分支与工作树以及任务专属临时目录；残留未清理时保持任务状态并提示，不自动删除，按用户授权处理后重试。
- 归档隐藏记录；恢复可用于归档或已取消的任务。
- 永久删除需明确删除意图，不能通过恢复撤销。服务要求任务已完成或已取消、未归档、无活跃执行，删除时会归档关联会话。不要为了删除而虚称任务已验收；在授权范围内采用取消流程，再读取最新版本删除。

目标、身份或操作结果不明确时暂停相关写入，继续能够确认范围的查询；不要通过数据库、伪造令牌或重复请求绕过问题。
