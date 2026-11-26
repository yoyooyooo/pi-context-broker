# 实际 Pi 日用安装与界面边界

普通多机更新沿 [next 交付合同](../../../../docs/next-worktree-delivery.md) 使用同一配对归档和各机独立安装，核对普通入口与新 Pi 进程。下文 `plan/run/aggregate` 保留 AH-1197/AH-637/AH-1198 的历史 worktree 专项；它要求真实 next checkout，不应把独立安装目录伪装成 worktree。`scripts/verify-pi-daily-candidate.mjs` 是导入的实现模块，没有独立 CLI。真实表切换后，先核对有效 Pi 配置实际加载的安装，不能把工作树或独立临时包成功称为日用成功。

```sh
node scripts/verify-pi-daily-installation.mjs plan --config /absolute/current-daily.json
node scripts/verify-pi-daily-installation.mjs run --config /absolute/current-daily.json
node scripts/verify-pi-daily-installation.mjs aggregate --config /absolute/current-delivery.json
node scripts/verify-pi-daily-installation.mjs candidate-plan --config /absolute/current-candidate.json
node scripts/verify-pi-daily-installation.mjs candidate-run --config /absolute/current-candidate.json --live
```

这里的绝对路径必须替换为本轮自有配置；缺输入保持 not_run 或具体 blocked，不创建虚假配置来取得退出 0。

| 动作 | required_inputs 与结果边界 |
| --- | --- |
| plan/run | version:1；同一新 delivery:{id:UUID,startedAt:UTC_ISO}、预期 library 根 UUID；实际日用包注册、source 配置、配对 roots/archive/hash、embedded CLI/SDK 和 entry hash、自有 evidenceRoot。run 还核正常 PATH、expectedFindRecord 和适用的 namespace review；plan 只输出准备信息。 |
| aggregate | version:1；同一 delivery、library、worktrees、cliRoot/brokerRoot；receipts.pro/mini 为两份本次日用 result.json 的绝对路径。重验真实 origin/next、当前构建、不同机器与完整 version:2 日用回执；单机、旧回执、候选、source-only 或缺项不通过。 |
| candidate-plan | version:1；自然旅程使用 scope:notion-agent-workflow 及 scenarioFile/scenarioId/profile/bindingsFile；原项目预检 scope 保留其 turns/expectedBodies。输出 prepared_not_executed。 |
| candidate-run --live | 自然旅程按 [工作流 Skill](../../verify-notion-agent-workflows/SKILL.md) 绑定实际 fixture、配对包、source/library、注册位置与 evidenceRoot；原项目预检按其现有包/归档/所有权输入。正式模型为 magpie/group/worker、thinkingLevel:high。 |

## 准备普通日用配置

先按 [next 交付合同](../../../../docs/next-worktree-delivery.md) 确定两机的同一目标提交和新 `delivery`。
以下是 `plan/run` 的完整配置形状。把全部 `REPLACE_`、绝对路径和示例数字换为实际输入，
再保存到本轮自有目录。`packageCount:2` 和 `packageIndex:1` 只是类型示例，index 从 0 开始。
不要沿用默认的 21 个包或第二个 slot 来猜当前安装。

```json
{
	"version": 1,
	"library": "REPLACE_WITH_EXPECTED_LIBRARY_ROOT_UUID",
	"delivery": {
		"id": "REPLACE_WITH_NEW_SHARED_UUID",
		"startedAt": "REPLACE_WITH_CURRENT_CANONICAL_UTC_ISO"
	},
	"worktrees": {
		"cli": { "root": "/absolute/cli-next", "commit": "REPLACE_WITH_40_HEX_CLI_COMMIT" },
		"broker": { "root": "/absolute/broker-next", "commit": "REPLACE_WITH_40_HEX_BROKER_COMMIT" }
	},
	"cliRoot": "/absolute/cli-next/packages/cli",
	"cliArchive": "/absolute/owned/archives/ntn-skills.tgz",
	"cliArchiveSha256": "REPLACE_WITH_64_HEX_CLI_ARCHIVE_SHA256",
	"cliEntrySha256": "REPLACE_WITH_64_HEX_RAW_CLI_SHA256",
	"cliShim": "/absolute/normal-path/ntn-skills",
	"brokerRoot": "/absolute/broker-next/packages/context-broker",
	"brokerArchive": "/absolute/owned/archives/pi-context-broker.tgz",
	"brokerArchiveSha256": "REPLACE_WITH_64_HEX_BROKER_ARCHIVE_SHA256",
	"embeddedCliSha256": "REPLACE_WITH_64_HEX_EMBEDDED_CLI_SHA256",
	"embeddedSdkSha256": "REPLACE_WITH_64_HEX_EMBEDDED_SDK_SHA256",
	"packageCount": 2,
	"packageIndex": 1,
	"findQuery": "REPLACE_WITH_REVIEWED_QUERY",
	"expectedFindRecord": {
		"selection": "REPLACE_WITH_QUALIFIED_SELECTION",
		"kind": "REPLACE_WITH_FIND_KIND",
		"source": "REPLACE_WITH_FIND_SOURCE",
		"page": "REPLACE_WITH_FIND_PAGE"
	},
	"evidenceRoot": "/absolute/owned/current-delivery"
}
```

按这些来源逐项填值：

- `library` 是本次预期消费的根 UUID。它不配置或覆盖产品默认库；实际普通 SDK 的
  `library-selection` 必须零 HTTP，`library` 和 `list` 必须归属于该根。
  source 名称或 Skill 名称相同不能代替 Library 身份。Source 省略 `library` 时，
  普通 CLI 全局配置仍须有正确的 `default_library`。
- 从真实 package 注册读回包总数和目标 slot。`configurationSnapshot` 读取正常
  `~/.pi/agent/settings.json` 及正常 Broker source 配置，校验 slot 指向 `brokerRoot`。
  它不接受 source override；本次 metadata 检查要求启用的 Notion source 不配置 `command`，且 prefetch 关闭。
- `cliRoot` 和 `brokerRoot` 必须是对应 next checkout 的 packages 路径。
  归档来自本轮配对的实际打包或安装检查。`packageClosure` 逐项比较归档成员和这些目录中的字节，
  同版本字符串不能代替。分别计算归档、`cliRoot/dist/ntn-skills.js`、
  `brokerRoot/dist/ntn-skills.mjs` 和 `brokerRoot/dist/ntn-skills-sdk.mjs` 的 SHA-256。
  [文件身份命令](../../../../docs/current-context-candidate.md#freeze-file-identities) 也可输出 bytes。
- 在正常 PATH 上用 `command -v ntn-skills` 得到 `cliShim`。直接入口或 symlink 必须落到
  该 `cliRoot/dist/ntn-skills.js`。若使用 Volta，还须在同一配置增加
  `voltaIdentity:{"executable_sha256":"实际 volta SHA","dispatcher_sha256":"实际 volta-shim SHA"}`。
  取正常 PATH 的 `volta` 及其真实目录中的 `volta-shim` 原件计算，不猜 wrapper。
  `verifyDailyCliShim` 会调用该 Volta 的 `which ntn-skills` 并核实际 entry。
- 用实际公开 `/context-broker find 查询词` 的 metadata 结果冻结 `expectedFindRecord`。
  `selection` 是 `$` 行去掉首字符 `$` 后的完整值；`kind`、`source`、`page` 原样取同一记录的字段。
  不从名称拼 namespace，也不从旧会话猜 page。`validateDailyFind` 要求该 selection 恰好出现一次，
  且整个四字段对象精确相等。当前目标查不到时报告阻断。
- 保留普通 Pi 原生入口或现役 exec shim。回执分别记录 launcher 路径/hash 与被动观测的
  `host_process`：同一 owned PID 的实际 Pi package/bin/entry、Node executable/version、RPC 参数及退出。
  SDK observer 必须归属同一进程；launcher、Node、entry、package manifest 前后字节不变。
  wrapper 文本中的路径、runner 自身 Node 版本或缺少实际进程的回执不能通过 aggregate。

上述读取受现有访问权限约束。若执行环境不允许读取日用配置，按交付合同记 `blocked`，不要换路径绕读。
配置本身不含 token。`plan` 展示准备信息，不验证所有原件，也不证明 `run` 已成功。

SDK 3 验证根结构会读取该根的直属 children。HTTP observer 仅保全 ID、parent 和分页
状态，独立建立 root→直属 Database→Data Source 的绑定，不保存正文或字段内容。
`library` 操作只可读取认证、该根和这些结构描述；未完成分页、外根 child、孤立
Data Source、任意 Skill/File blocks 或 markdown 都会失败。`list` 的数据源查询也须
位于已验证的根内；View 列表须指定该根内的 Database，View 自身的独立响应还须证明
其 Database 和 Data Source 归属，再允许该 View 的查询。其他页面、properties、外库
View 和全局搜索不符合此日用检查。回执分别记录 `notion_body_requests` 中真实的根结构请求、
`metadata_http_requests` 与 `skill_body_reads:0`，不把根请求改报成 metadata 或隐藏计数。

### 只为已审阅的外部目录诊断提供例外

Doctor 无 namespace 失败时，省略 `namespaceDiagnosticsReview`。只有已确认不属于本次交付库的
外部目录失败，才在配置加入实际审阅文件的引用：

```json
{
	"namespaceDiagnosticsReview": {
		"path": "/absolute/owned/external-namespace-review.json",
		"sha256": "REPLACE_WITH_64_HEX_REVIEW_FILE_SHA256"
	}
}
```

该文件的完整形状如下。它记录实际审阅事实，不是生成成功的命令模板。
保留真实 Doctor 的完整失败行，包括前导空格；不能填示例值来消除失败。

```json
{
	"kind": "reviewed-external-catalog-diagnostics",
	"status": "outside-delivery-scope",
	"sourceDatabaseId": "REPLACE_WITH_CURRENT_ENABLED_SOURCE_DATABASE_ID",
	"declaredDatabaseIds": ["REPLACE_WITH_REVIEWED_EXTERNAL_DATABASE_ID"],
	"routerNames": ["REPLACE_WITH_ACTUAL_EXTERNAL_ROUTER_NAME"],
	"namespaceDiagnostics": ["REPLACE_WITH_COMPLETE_ACTUAL_FAIL_LINE"],
	"catalog": {
		"path": "/absolute/reviewed/catalog.yaml",
		"bytes": 1234,
		"sha256": "REPLACE_WITH_64_HEX_ACTUAL_CATALOG_SHA256"
	},
	"reason": "REPLACE_WITH_REVIEWED_SCOPE_AND_AUTHORIZATION_REFERENCE"
}
```

`run` 核 review 文件 hash，再核 catalog 原件的 hash 和 bytes。`validateDailyDoctor` 只接受
已列出的外部 `CATALOG_MEMBER_UNAVAILABLE` 行；当前 source 的库、必需 selection 所在 router、
新失败或变化后的行仍失败。没有已完成的范围审阅就保留失败，不能为了通过新写例外。

## 项目级候选与自然任务

候选配置的完整 JSON、`ownershipReceipt` 和当前 v2 `artifactReceipt` 来源见
[项目级候选准备](../../../../docs/current-context-candidate.md#configure-the-project-candidate)。
它们不是上面普通日用配置的附加 flags。两机 `aggregate` 配置仍沿
[next 交付合同](../../../../docs/next-worktree-delivery.md#每次更新的完成条件) 使用两份本次原始日用回执。

沿配对 CLI 合同索引 C10/T21 检查每个入口的 required_inputs；双机交付以 [next 工作树交付](../../../../docs/next-worktree-delivery.md) 的同一流程收口。run 与 aggregate 验普通日用装载和 metadata，仍将正文与模型任务记为 not_run；candidate-run 是项目级候选，不能代替两机普通日用入口。计划和帮助都不算执行成绩。运行前阅读实际输出并消除配置/字节/协议不匹配，不把旧 source.command 或旧 selector 加回产品。

T16/T17 沿 [工作流 Skill](../../verify-notion-agent-workflows/SKILL.md) 的自然 scope 使用同进程有限事件：采用 A、真实发布 B 并独立读回、继续 A、只看 B、继续 A、明确采用 B。普通继续保持原进程；restart/fork/compact 各有真实入口和分支证据。源码或受控结果不代填，未执行项仍为 not_run。

T22 的本地充分负例在 daily 普通 Pi 中证明目标由原生全局发现加载、远端目标在实际模型目录可见，再用 tool-attempts 断言 notion_use 尝试为零（含失败与撤回）。全工具 toolCallCount 不能替代专门计数。适用远端任务增加 no-native-skills 对照；-ns 不清除 Broker local。保留必要远端、真正歧义、等价与互补等独立判据。

分别观察：当前 Source可发现；目录完整；实际选择绑定；完整正文/资源进入实际provider/serializer；取消不产生迟到激活；turn完成；后续会话按固定选择恢复。真实模型需要成功响应及实际任务证据，不由 mock、receipt 或模型自述代填。

受控实际 Pi 的 SDK 场景仍在 `scripts/notion-sdk-pi.mjs`，先读 `--help` 并使用匹配的安装/输入。包检查只证明包与HTTP，二者均不能自动证明日用有效配置。

## 界面范围

原生终端候选、Tab、光标、焦点和菜单操作必须实际驱动并观察。Pi 的 `$` 专项沿 [候选地图](dollar-completion-selection.md) 运行实 Editor 回放与当前 `scripts/pi-dollar-pty.mjs`，分别记录首次菜单、后台同屏更新、Esc、高亮身份、排队输入、网络故障及实际正文交付。受控 PTY 与每机普通安装读回各自留证，不能互相代替。旧 CLI fixture PTY 与旧 OMP/Tern daily UI 驱动已删除；OMP/Tern 产品代码保留但延期，不把一个宿主的结果替代另一个。

清理仅限本轮自有进程与绝对scratch路径，经系统Trash。不要复制用户凭据、重置用户会话或以全局重装绕过身份问题。结果分别记录源码、安装、SDK/HTTP、Pi、真实Notion、模型和UI。
