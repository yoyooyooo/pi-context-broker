# 实际 Pi 日用安装与界面边界

AH-1197/AH-637/AH-1198 使用 `scripts/verify-pi-daily-installation.mjs` 的公开动作。`scripts/verify-pi-daily-candidate.mjs` 是导入的实现模块，没有独立 CLI。真实表切换后，先核对有效 Pi 配置实际加载的安装，不能把工作树或独立临时包成功称为日用成功。

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
| plan/run | version:1；同一新 delivery:{id:UUID,startedAt:UTC_ISO}；实际日用包注册、source 配置、配对 roots/archive/hash、embedded CLI/SDK 和 entry hash、自有 evidenceRoot。run 还核正常 PATH、expectedFindRecord 和适用的 namespace review；plan 只输出准备信息。 |
| aggregate | version:1；同一 delivery、worktrees、cliRoot/brokerRoot；receipts.pro/mini 为两份本次日用 result.json 的绝对路径。重验真实 origin/next、当前构建、不同机器与完整 version:2 日用回执；单机、旧回执、候选、source-only 或缺项不通过。 |
| candidate-plan | version:1；scope:project-scoped-candidate-precheck；非空 turns 含唯一 id/自然 prompt；body 断言对应冻结 expectedBodies。输出 prepared_not_executed。 |
| candidate-run --live | 以上候选输入及当前包/归档 hashes、oldBrokerRoot、localSkill、ownershipReceipt、artifactReceipt、自有 evidenceRoot、sourceId/database 和已授权凭据环境。当前实现要求 model:magpie/group/flash、thinkingLevel:high。 |

## 准备普通日用配置

先按 [next 交付合同](../../../../docs/next-worktree-delivery.md) 确定两机的同一目标提交和新 `delivery`。
以下是 `plan/run` 的完整配置形状。把全部 `REPLACE_`、绝对路径和示例数字换为实际输入，
再保存到本轮自有目录。`packageCount:2` 和 `packageIndex:1` 只是类型示例，index 从 0 开始。
不要沿用默认的 21 个包或第二个 slot 来猜当前安装。

```json
{
	"version": 1,
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

上述读取受现有访问权限约束。若执行环境不允许读取日用配置，按交付合同记 `blocked`，不要换路径绕读。
配置本身不含 token。`plan` 展示准备信息，不验证所有原件，也不证明 `run` 已成功。

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

T16/T17 还须冻结 turns[].prompt/bodies/proofs/requireUse 与对应 expectedBodies；自然提示不预给工具或 ref。现有 candidate-run 连续执行 turns，没有轮间暂停、等待远端编辑再恢复的编排。它不能独立证明“原会话采用 A、远端改为 B、同会话查看或采用最新”的完整时序。该部分使用公开 Pi 人工驱动并保留编辑前后原件，未取得则保持 not_run，不能由既有 unit 或候选结果代填。

T22 在普通 Pi 不带 -ns、Notion source 可见且本地充分的条件下执行。必须由独立人工逐条审核完整 tool_call/tool_result/provider trace，失败 notion_use 也计入不必要调用。现有 toolCallCount 计全部工具；requireUse:false 也不构成零误调断言。另保留确需远端的正例，分别判断任务与实际正文。

分别观察：当前 Source可发现；目录完整；实际选择绑定；完整正文/资源进入实际provider/serializer；取消不产生迟到激活；turn完成；后续会话按固定选择恢复。真实模型需要成功响应及实际任务证据，不由 mock、receipt 或模型自述代填。

受控实际 Pi 的 SDK 场景仍在 `scripts/notion-sdk-pi.mjs`，先读 `--help` 并使用匹配的安装/输入。包检查只证明包与HTTP，二者均不能自动证明日用有效配置。

## 界面范围

原生终端候选、Tab、光标、焦点和菜单操作必须实际驱动并观察。本轮原生终端专项未验收；旧 CLI fixture PTY 与旧 OMP/Tern daily UI 驱动已删除。OMP/Tern 产品代码保留但延期，无Tern成绩，不把一个宿主的结果替代另一个。

清理仅限本轮自有进程与绝对scratch路径，经系统Trash。不要复制用户凭据、重置用户会话或以全局重装绕过身份问题。结果分别记录源码、安装、SDK/HTTP、Pi、真实Notion、模型和UI。
