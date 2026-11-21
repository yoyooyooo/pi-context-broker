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

沿配对 CLI 合同索引 C10/T21 检查每个入口的 required_inputs；双机交付以 [next 工作树交付](../../../../docs/next-worktree-delivery.md) 的同一流程收口。run 与 aggregate 验普通日用装载和 metadata，仍将正文与模型任务记为 not_run；candidate-run 是项目级候选，不能代替两机普通日用入口。计划和帮助都不算执行成绩。运行前阅读实际输出并消除配置/字节/协议不匹配，不把旧 source.command 或旧 selector 加回产品。

T16/T17 还须冻结 turns[].prompt/bodies/proofs/requireUse 与对应 expectedBodies；自然提示不预给工具或 ref。现有 candidate-run 连续执行 turns，没有轮间暂停、等待远端编辑再恢复的编排。它不能独立证明“原会话采用 A、远端改为 B、同会话查看或采用最新”的完整时序。该部分使用公开 Pi 人工驱动并保留编辑前后原件，未取得则保持 not_run，不能由既有 unit 或候选结果代填。

T22 在普通 Pi 不带 -ns、Notion source 可见且本地充分的条件下执行。必须由独立人工逐条审核完整 tool_call/tool_result/provider trace，失败 notion_use 也计入不必要调用。现有 toolCallCount 计全部工具；requireUse:false 也不构成零误调断言。另保留确需远端的正例，分别判断任务与实际正文。

分别观察：当前 Source可发现；目录完整；实际选择绑定；完整正文/资源进入实际provider/serializer；取消不产生迟到激活；turn完成；后续会话按固定选择恢复。真实模型需要成功响应及实际任务证据，不由 mock、receipt 或模型自述代填。

受控实际 Pi 的 SDK 场景仍在 `scripts/notion-sdk-pi.mjs`，先读 `--help` 并使用匹配的安装/输入。包检查只证明包与HTTP，二者均不能自动证明日用有效配置。

## 界面范围

原生终端候选、Tab、光标、焦点和菜单操作必须实际驱动并观察。本轮原生终端专项未验收；旧 CLI fixture PTY 与旧 OMP/Tern daily UI 驱动已删除。OMP/Tern 产品代码保留但延期，无Tern成绩，不把一个宿主的结果替代另一个。

清理仅限本轮自有进程与绝对scratch路径，经系统Trash。不要复制用户凭据、重置用户会话或以全局重装绕过身份问题。结果分别记录源码、安装、SDK/HTTP、Pi、真实Notion、模型和UI。
