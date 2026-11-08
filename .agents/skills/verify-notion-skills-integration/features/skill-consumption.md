# Skill 消费链：验证地图与证据合同

归属 [AH-617](https://linear.app/yoyooyooo/issue/AH-617)，当前合同 `agent-cli-ref-20261105`。本页维护 SC01–26 的执行导航，机器索引在 [skill-consumption-scenarios.json](../../../../scripts/skill-consumption-scenarios.json)。规程状态与产品结果分开：未执行的路线为 draft，样本为 not_run；不能从本文存在推断产品已通过。历史报告保持原工具名、原始预算与结果，不改写为新合同已通过。

## Sub-features

- SC-VERIFY-01：26 项任务、26 条用户旅程及缓存×会话×入口×intent 的组合索引。
- SC-VERIFY-02：复用原图验收反例，补观察缺失、投影/源混淆、假投递和失败证据丢失反例。
- SC-VERIFY-03：从真实 Pi 入口运行、核对原始记录、清理自有 scratch 后再次验证证据；独立新会话按同一规程重跑。

相关材料：[原图合同](skill-dependency-graph.md)、[请求账本](request-engine.md)、[会话恢复](session-cache-recovery.md)、[正常安装](installed-consumption.md)。CLI 的对应入口为 notion-skills-cli 仓库中的 `.cursor/skills/verify-ntn-skills/features/skill-consumption.md`。

## How to get to it (user POV)

普通消息、`$name@notion`、原生 `/skill:`、`notion_list`、原生 `read` 检查主文/资源、`notion_use` 与直接 CLI 是不同入口。CLI 日常合同为 `list [--query TEXT]`、`read REF`、`use REF`，主引用为单数 `skill://`。use 必须取得根与完整 Requires；Members 保持候选。Pi 的 `notion_use({ref:string|string[],refresh?:boolean})` 只支持已验证的顶层模型工具交付，Code mode 内部成功不能激活；`notion_ctl` 按需发现。OMP 旧工具与历史 receipt 单列，不在 Pi 默认同时注册。

| 任务 | Issue | 用户入口 | 已有驱动及尚需补齐的证明 |
| --- | --- | --- | --- |
| SC01 | AH-618 | 验证规程 | 本页完整流程；反例及清理后证据 |
| SC02 | AH-619 | 全部消费入口 | [只观察的成本规程](skill-consumption-cost.md)；真实模型、source 初态与单资源基线，旧 graph observer 不作为纯观察器 |
| SC03 | AH-620 | CLI、SDK、Pi | CLI core 的 version 1 consume 合同与等价证明已提交；独立 SDK 打包和 Broker 迁移继续归 SC10 |
| SC04 | AH-621 | 短引用、原生 read | [本轮证据](../../../../packages/context-broker/docs/skill-consumption-runtime.md)：C/S/R 分支表、真实 SessionManager 13 项与 5 次独立 resume、实际 Pi search/prepare/read；74 候选批量投影经同目录 13 点真实对照，跨机重新授权和正式模型 Gate 仍分列 |
| SC05 | AH-622 | provider 输入 | [能力化指引](../../../../packages/context-broker/docs/skill-consumption-guidance.md)、[prepare 编译投影](../../../../packages/context-broker/docs/skill-consumption-projection.md)、[搜索/注入/native 呈现](../../../../packages/context-broker/docs/skill-model-surfaces-verification-2026-11-05.md)及[重复确认配对](../../../../packages/context-broker/docs/repeat-read-consumption-verification-2026-11-05.md)：完整作者正文与机器证明分离，实际 span、全部 provider HTTP 与工具往返分别验收；正式模型 Gate 仍分列 |
| SC06 | AH-623 | 目录、search、自然任务 | search 卡片已减少重复 id/scope 并批量登记短引用，完整 UI/机器元数据保留；view-discovery / model 继续验跨入口去重及两种目录的真实选路比较 |
| SC07 | AH-626 | inspect、use、资源 | installed --skill-graph true；固定资源批读使用下方 `resource-batch` 路线及[合同](../../../../packages/context-broker/docs/fixed-resource-batches.md)；单文件直读使用 `resource-scalar` / `resource-scalar-short-refs` 与[配对记录](../../../../packages/context-broker/docs/scalar-resource-consumption-verification-2026-11-05.md)；[批读最终包、真实模型与新会话记录](../../../../packages/context-broker/docs/fixed-resource-batches-verification-2026-11-04.md)。原句介绍/执行与正式模型 Gate 分别验收；[指引历史](../../../../packages/context-broker/docs/skill-consumption-guidance.md)的失败继续保留 |
| SC08 | AH-627 | 重复、resume、压缩 | [默认 SDK 实际会话入口](session-cache-recovery.md#sc08-sc22-pi-默认-sdk-会话恢复)：原 driver 的 session-lifecycle 驱动真实 fork/clone/tree/compact/跨进程 resume/晚到取消，逐 turn 核对完整正文、分支绑定与源终局；[重复读取配对](../../../../packages/context-broker/docs/repeat-read-consumption-verification-2026-11-05.md)保留原始全文；受控摘要与真实模型摘要分别验收 |
| SC09 | AH-624 | 普通消息、显式选择 | [本轮证据](../../../../packages/context-broker/docs/skill-consumption-runtime.md)：context 准备与运行信号，RPC/PTY 10/10、完整启动 31/31；[历史失败](../../../../packages/context-broker/docs/skill-consumption-startup-checkpoint.md)保留 |
| SC10 | AH-625 | SDK、公开 CLI | [本轮证据](../../../../packages/context-broker/docs/skill-consumption-runtime.md)：独立 npm/Node SDK 11/11、Broker 等价 9/9、实际 Pi 默认 SDK 3/3；目录 CLI 和 custom command 明确单列 |
| SC11 | AH-628 | 目录、依赖选择 | CLI 的 scalar inventory SDK/CLI smoke 及[完整目录复用记录](../../../../packages/context-broker/docs/shared-metadata-consumption-verification-2026-11-05.md)；同次 logical selector / native-reference 编译复用六属性观察，真实 source driver 单独计量；需求批次、其他投影与关系范围继续补齐 |
| SC12 | AH-629 | 暖、过期、clear | session-cache-recovery；验 freshness、scope、权限、恢复，不要求额外物理缓存全部落地 |
| SC13 | AH-630 | 主文、单资源、export | CLI 独立 SDK smoke 与下方 `partial-entrypoint`；[固定快照记录](../../../../packages/context-broker/docs/selected-snapshot-consumption-verification-2026-11-05.md)、[来源所有权、最终包与真实来源记录](../../../../packages/context-broker/docs/source-ownership-consumption-verification-2026-11-05.md)、[固定单资源直读](../../../../packages/context-broker/docs/scalar-resource-consumption-verification-2026-11-05.md)及[同次目标 bytes 复用](../../../../packages/context-broker/docs/repeat-read-consumption-verification-2026-11-05.md)；完整目录、先判归属后取字节与 full export 各自验收；首次 current 全树观察、Git 隐私回退与 legacy ZIP 成本仍单列 |
| SC14 | AH-631 | 过期 Records | CLI request_metrics；另补事实计划复用与Payload归因 |
| SC15 | AH-632 | 并发、取消、崩溃 | 现有 request-engine / cache-concurrency 的取消、预算、隔离是硬门槛；新增合并/预取先作成本裁决 |
| SC16 | AH-633 | 历史重算 | 先验现有 replay 与成本；采用 checkpoint 时另验冲突/unknown，不无条件阻塞消费接口 |
| SC17 | AH-634 | 大对象存取 | 以现有真实账本比较承载策略；附件过期/unknown 专项仅适用于已选 backend |
| SC18 | AH-635 | 固定来源、旧pin | 根据已选策略验迁移与回滚；所有已承诺旧 pin 仍要独立恢复 |
| SC19 | AH-636 | poteto任务 | 审阅完整规则；作者优化需实际任务收益与独立内容 hash，不运行时摘要 |
| SC20 | AH-638 | 完整矩阵 | 旧Broker→新候选、Pi原生本地Skill→新候选分开；累计全部provider输入及请求，不相加切片百分比 |
| SC21 | AH-639 | A/B/C/D真实Agent | graph model / integration model；正式 A/B/C/D 另验；额外介绍案例 `7gd44M` 保留 incomplete，`9W6HlD` 为同原句一次 cold/warm 回归，0 工具仍有两处语义缺陷，不替代正式 C |
| SC22 | AH-637 | 独立npm、pro/mini | installed / Pi PTY；双机各自新包证据 |
| SC23 | AH-640 | 所有受影响调用者 | CLI / package / integration；迁移清单与回滚实驱 |
| SC24 | AH-641 | 正常日用Pi | verify-pi-daily-installation 仅核安装身份；另留真实日用新会话、provider、工具调用与任务结果证据 |
| SC25 | AH-675 | CLI list/read/use、默认目录 SDK | 公共单 ref、根/Requires、精确资源、Default View 与稳定机器输出；作者/ctl 按需 |
| SC26 | AH-676 | 常规 check、CI、独立 Pi | 下方门禁接线、语义 oracle、默认 SDK 目录、成本对照 manifest 与独立新会话 |

尚未实施功能的完整规程仍为 draft。SC01 只验证地图、证据反例与下方既有 Pi 路径；上表本轮分层证据只覆盖其实际执行范围，不批量更改 1,120 个矩阵项。不得把矩阵项标 passed 来消除 blocker。

### 必跑用户旅程

| ID | 动作 | 主要断言 |
| --- | --- | --- |
| J01 | 全冷普通消息，目录延迟/失败 | provider先于目录完成；正文读取0 |
| J02 | 暖目录普通消息 | 仅轻量发现；后台成本独立计 |
| J03 | 暖缓存新会话显式激活 | 策略允许时远端0；根/Requires各一份 |
| J04 | 全冷根与共享Requires | 只读所选闭包；Members正文0 |
| J05 | 用户原句介绍目标 | 准确介绍；不执行工作流、不写仓库 |
| J06 | 无美元但明确名字 | 一次检查；歧义返回候选 |
| J07 | 无美元且无叶子名 | 自主选能力并完成任务 |
| J08 | 仅Router根 | 自主选择叶子和必要资源 |
| J09 | 仅poteto根 | Requires准备；Members由模型选择 |
| J10 | 重复美元与随后普通消息 | 版本不变；当前provider正文一份 |
| J11 | 远端A→B与refresh失败/成功 | 失败保留旧绑定；成功不混版本 |
| J12 | resume/fork/rewind/压缩 | 固定引用不漂移；丢失正文后恢复 |
| J13 | 过期未变 | 元数据复验；正文重下0、写回0 |
| J14 | N文件中k变化或仅属性/关系变化 | 只补受影响内容和证明 |
| J15 | 单资源缺失及custom覆盖大来源 | 完整清单下按需字节；export单独完整 |
| J16 | 空pro/mini恢复旧pin | 自身认证；固定文件准确，无当前回退 |
| J17 | 并发、取消、崩溃、clear | 有界只读合并；不串scope、不迟到发布 |
| J18 | 坏hash、错File/scope、权限及分页错 | 显式失败；无partial成功投递 |
| J19 | 附件轮换、过期、断流、unknown | 稳定内容身份；原操作核对 |
| J20 | 旧检查点、同mtime、冲突、未决操作 | 不能遮蔽事实；完整重算计成本 |
| J21 | 正常日用新Pi与资源续读 | 自动加载新包；非目标配置保持 |
| J22 | CLI list→read/use→固定资源 | 单数公共 ref；固定资源不重备主文；files/export/作者/ctl 可达 |
| J23 | 同条件Pi原生本地Skill对照 | 同正文/候选/任务；完整schema/guidance/每轮provider成本与实际native入口 |
| J24 | Code mode off/on及顶层/嵌套 | 内部success、print、摘要或截断不等于delivered/active；不支持的嵌套明确失败 |
| J25 | check/CI、独立Pi、默认SDK Default View | 必要测试实际运行且能失败；source.command absent的成功目录与分页/缺失反例 |
| J26 | 旧命令/配置/会话工具/ref/operation | 明确兼容范围；不回退current、不重放unknown mutation |

J19 的附件专属分支、J20 的 checkpoint 专属分支依候选实际采用能力裁决；未测不得写 N/A。现有读取/历史/权限正确性始终必验。正式收口顺序为 SC23 → SC22 → SC20 → SC21 → SC24。

### 完整组合与合法不适用项

`coverage` 实际输出 5 种缓存 × 7 种会话 × 8 种入口 × 4 种 intent，共 1,120 个元组。缓存为 cold、warm、expired-unchanged、expired-changed、partial；会话为 new、existing、restart、resume、fork、rewind、compacted；入口为 ordinary、dollar、native、list、use、read、cli、sdk；intent 为 none、discover、inspect、use。

每个元组默认 not_run。只允许以下不适用理由：none 没有显式 Skill 入口；list 只发现候选；use 交付 Requires；普通自然任务的 inspect/use 记在后续实际工具入口；显式美元/native 为 use；直接 CLI/SDK 没有 Pi 会话生命周期，绑定由宿主调用路径验证。所有不适用元组均附理由。

激活/刷新/权限/压缩/取消的高风险组合逐项运行，其他组合可在 SC02 开跑前冻结覆盖策略。未执行元组不得被 pairwise 覆盖自动提升为 passed。缓存五层分别记录初态，不能只清 Broker 目录便称全冷；保持真实机器级调度，不能清空用户缓存。

## Driving it with existing harnesses

### Launch

从 Broker checkout 根目录运行。已有依赖与构建可用时不重复安装。只有缺构建时才按主 Skill 的 Pi 单宿主方法，先构建 CLI，再设置 `NTN_SKILLS_BUILD_ENTRY` 运行 `bun run build:broker`。不要使用全目标 build 改写既有 Tern 产物。

先建立工作树保护基线。保留别人已暂存的文件，按明确文件提交本次改动；不 reset、clean 或批量 restore。私有证据放在 checkout 外。

### 精确引用与目录失败

SC04 的 canonical ref 或当前分支短引用不要求 Agent 先调用 list。`notion_use`、单个原生 read 和固定资源批读可以在无关来源目录失败时继续；已选来源的阻断错误仍必须在准备或读取正文前返回。根与 Requires、owner/scope/File/pin 继续由原消费内核核对，不能为此回退 current 或跳过权限。

冷态 View 外 canonical 引用仍可能在内部查询所需元数据，其 HTTP 与字节计入该次账本。“无需 Agent 发现工具往返”不等于“零目录请求”。用原 host harness 运行：

```bash
bun test packages/context-broker/scripts/host-prepare.test.ts packages/context-broker/scripts/native-read-session.test.ts
```

正例同时保持发现入口失败，并证明精确 use 返回根和完整 Requires、未选 Member 未加载；反例分别注入目录和 exact lookup 的选中来源错误，确认正文准备为零。单个 native read 另验证冷态 View 外入口。它们是源码 host 集成证据，实际 Pi 和独立安装候选仍须单列。

没有已知候选且没有独立 lookup 时，目录失败不能改判“引用不存在”。原 `bun packages/context-broker/scripts/input-guard.test.ts` 验证 RATE_LIMITED、NOTION_UNAVAILABLE、ACCESS_DENIED 均保持准确失败且不读正文；这条基础门禁与精确引用正例同时运行。

### Pi 目录名称与可复制的读取入口

Default View 的 Pi Notion 条目展示实际名称、完整描述、来源与精确入口；内部 command token 不代替显示名称，同名不同来源保留各自 ref。本地原生目录、补全 alias 和 OMP 兼容形式另核对，不能为同条件对照改写作者 frontmatter。

读取验收同时检查真实 provider 的 `read.path` 顶层与 scalar 分支 schema：明确接受本地路径和系统已返回的 `skill://` / `sr:` 引用，并要求原样复制。资源目录的 path 是资源名称，不能据此猜测 Pi 安装目录；检查用 read，采用根与 Requires 用 notion_use。定向源码门禁为 `bun test packages/context-broker/scripts/pi-read-adapter.test.ts packages/context-broker/scripts/view-discovery.test.ts`。下一独立候选的原 SDK/Pi driver 须核对实际 schema、名称与资源续读；描述纠正不能代替模型自主选路或任务完成证明。

### Doctor

以下命令全部离线，不创建生产数据、不调用模型：

```bash
node scripts/skill-consumption-contract.mjs --help
node scripts/skill-consumption-contract.mjs check-map
node scripts/skill-consumption-contract.mjs check-gates
node scripts/skill-consumption-contract.mjs self-test
node scripts/verify-notion-integration.mjs --help
node scripts/verify-notion-integration.mjs doctor --mode deterministic --host pi
```

最后一条会保留 owned probe scratch，输出真实 Node/Pi 版本、扩展路径/hash。它不认证、不访问 Notion；status=ready 只证明前置可用。缺前置记 blocked，不能换另一宿主或跳过后写 pass。审阅完该次 Doctor 后只把输出的 probe scratch 移到系统回收站。

### Drive：SC01 的完整既有用户路径

SC26 的常规门禁先跑 `NTN_SKILLS_BUILD_ENTRY=ABSOLUTE_INSTALLED_CLI bun run check:broker`。其实际 package check 必须输出 `test:consumption` 的完整测试结果；`check-gates` 拒绝漏接、旧 Pi pin、缺失安装门禁和没有冻结 SDK 构建输入的 workflow，但不能代替执行日志。CI / publish 从同一精确 CLI commit checkout 后 frozen install/build，再用原 `scripts/sdk-fixture.ts --outdir NEW_ABSOLUTE_DIRECTORY --catalog` 生成 fixture。原 artifact Pi gate 必须显式传入同一路径的 `--fixture` 和 `--require-sdk`，实际运行同 installed 包的默认 SDK all14；缺 fixture、跳过或吞掉失败均拒绝，原件始终上传。验证门禁会传播失败时，在 owned 普通副本中将 Pi use 的 `exposure` 从 `model-only` 改为 `direct`，保留完整 check 的非零退出和命中断言；正常候选须跑同一入口通过。不修改用户工作树制造失败。

独立 Pi 安装沿原 control 入口执行 `node .agents/skills/verify-context-broker/scripts/control.mjs doctor distribution-pi`，再 `run distribution-pi`。该路径只允许精确 Pi 1.4.0／1.5.0，实际版本分别留证；未知版本仍失败。使用 `verify-artifacts.mjs --host pi` 打包 Broker 并在空 consumer 中 npm install，保留 package/CLI/SDK/实际Pi identity、RPC、provider 和进程终局。通用命令不带 fixture 时，manifest 的 `defaultSdk` 必须明确 `not_run`。完整默认 SDK 安装验收直接为原命令增加 `--fixture ABSOLUTE_FIXTURE_JSON --require-sdk`，检查同包 all14 的 plan/result/每景 terminal 和未改动身份；参见[分发门禁](../../verify-context-broker/features/distribution.md)。CI 主 Pi 1.5.0，兼容步骤用 owned Pi 1.4.0 跑原 native print／continue 和同 installed 路径的 all14；发布仍单 job。`CONTEXT_BROKER_CANDIDATE_DIR` 可指向一个已冻结的绝对包目录；未给时打包当前完整源码。它不构建 Tern、不验真实 Notion或模型，OMP 由独立 `--host omp` 结果负责。私有 evidence 保存在输出目录，后续原件hash与回收规则相同。

正常默认目录必须在 source.command absent 下通过 SDK list 获取完整 View 元数据，未选正文读取为零；custom command、CACHE_MISSING、pending 或非零子进程只各自证明对应分支。非阻塞冷启动允许第一任务的 provider 保留 pending，`notion_list` 等待并交付真实目录；下一普通用户 turn 重建 ready 默认目录。每个 turn 单独记录，不把第一轮 pending 当作 Default View 成功。额外 list 允许已授权范围，默认 View 不变成永久搜索边界。live 驱动不主动编辑不等于产品 current read 永不写入；首次 adoption/retention、稳定未变、真实 notion_write 分组记录，unknown 操作不重放。

### Drive：SC25 / SC26 默认 SDK、Code mode 与精确资源

先在 CLI 仓沿已有 `scripts/sdk-fixture.ts --outdir ABS_NEW_FIXTURE --catalog` 创建 owned fixture；它的 `default_view.records` 为 a、b，完整目录另含 c、base 与资源场景。Default View 只写元数据，Requires base 不在默认目录。独立包与 fixture 的绝对路径来自本次输出，`SDK_EVIDENCE` 必须是新目录：

```bash
node scripts/notion-sdk-pi.mjs doctor --package "$SDK_PACKAGE" --fixture "$SDK_FIXTURE" --scenario all
node scripts/notion-sdk-pi.mjs run --package "$SDK_PACKAGE" --fixture "$SDK_FIXTURE" --scenario all --out "$SDK_EVIDENCE"
node scripts/notion-sdk-pi.mjs evidence --evidence "$SDK_EVIDENCE"
node scripts/notion-sdk-pi.mjs cleanup --evidence "$SDK_EVIDENCE"
node scripts/notion-sdk-pi.mjs evidence --evidence "$SDK_EVIDENCE"
```

此既有 driver 的 14 个场景使用实际 Pi 1.4、独立安装 Broker、随包 CLI/SDK、受控 source/provider。`default-view` 留下 pending → list → 普通续接 ready 的三次请求；逐条显示准确 `record.name`、description、独立 source 与短入口，不能以命令 token 冒充显示名；只有一份默认目录，SDK 完整元数据和失败状态独立核对。默认目录与资源场景同时核对实际 provider 的 read.path outer/oneOf scalar schema 都说明 local path、`skill://`、`sr:` 和复制 issued ref。`prepare` 的场景名保留历史入口，但实际调用为 `notion_use({ref:[...]})`，共享 Requires 只交付一次。native、批读、固定 scalar、恢复短引用和 partial-cache 场景继续复用原证据与实际对象读取正控制；`session-lifecycle` 的实际分支/压缩/恢复/取消按[会话地图](session-cache-recovery.md#sc08-sc22-pi-默认-sdk-会话恢复)独立报告。

资源使用的 scalar `read.path` 和 batch `read.paths` 都是当前入口。逐文件的完整 provider span、固定 owner/snapshot/File ID/hash 与外层 toolCallId 独立核对；资源数与外层工具调用数分列，不能把一次 batch 记成多次 Agent 往返。实际图模型 observer 同样检查原始 SDK 结果与完整外层输出，details-only、部分正文、未发现或错 pin 的资源不计完成。

`dollar` 逐字校验完整 root / Requires 正文，同时验证注入 wrapper 的 supporting files：仅展示所选 snapshot 的 path 和准确 `sr:R`，不再把物理 cache 目录当作资源读取入口。无 supporting files 时不生成空资源块；资源路径、handle 类型、重复机器字段与正文摘要均有拒绝例。实际资源续读须复制 wrapper 返回的 ref，通过原 native read 验固定文件与版本；仅 wrapper 字符串正确不算读成功。产品红例保存在 `/tmp/ah622-source-files-before-smw_v3n5`，旧 driver 拒绝新合法 wrapper 的红例在 `/private/tmp/ah676-dollar-oracle-before-i13w67t1`；两类失败分开保留，当前 driver 与产品测试同步维护。

`codemode-hidden` / `codemode-truncated` 显式加载实际 Pi 安装内的 codemode 扩展，因为 `--no-extensions` 不会替 driver 加载它。先证明 nested notion_use 不可调用，再实际 native read 完整正文，分别不转发或只 print 16 字符；provider 此时不能被标完整正文。随后顶层 notion_use 必须交付根与完整 Requires，active custom entry 只能出现在这份结果之后。外层工具轮、内部 read、SDK 操作与 provider schema/正文累计字节分别报告；code 内成功和 print 摘要不折算为完成交付。

Default View 的正反例必须使用不同 owned fixture：在 CLI 原入口额外指定 `--default-view-cache missing` 或 `--default-view-cache incomplete`，随后对该 fixture 运行同一 `--scenario default-view`。预期 runner 非零、report failed；真实 provider 目录分别为 CACHE_MISSING / STATE_CORRUPT，失败 SDK list 的终界和零离线 HTTP仍保留。不能把非零状态、失败目录或旧缓存降级为正例。失败原件也先 evidence → cleanup → evidence；只回收 driver 的 owned scratch，原 fixture 与 retained evidence 不删除。

SDK 组合目录的一个 `list` operation 可包含 full catalog 与 Default View 两个独立成功／失败 outcome。验证读取原 envelope，不把两个 facet 算成两次 SDK 调用，也不把已返回的失败 facet 标为成功目录。实际 HTTP 复用、分页／响应字节、generation 一次性交付、旧 SDK 与 custom command 兼容按[安装态 HTTP 地图](installed-consumption.md#已安装-sdk-的真实-http-消费接线)验证；共享只在 CLI 同一次 operation 内成立。

真实 C/D 的 ready setup、graph model 的名称选择与 SC20 比较沿用 `notion-skill-graph-model-evidence.mjs` 的纯 `catalogFacets`，同时接受历史 flat 回执和组合 envelope。两个投影保留同一原始 request ID；失败 outcome 单独保留，不复制 raw receipt 或 metrics。名称选择及其 authored-time 归属只使用成功完整 catalog，成功 View 不能替代失败、部分或歧义的全库；C/D setup 和全任务源验收仍拒绝任一失败／部分投影。SC20 只从成功 directory 投影确定可见候选，允许无关 full 失败留在原回执中，不能把 full 名单计作 Default View。双成功投影的 scope 或同数据库 shared-library descriptor 不一致均拒绝。

对应原回归入口为 `node --test scripts/notion-skill-graph-model-evidence.test.mjs scripts/notion-skill-graph-model.test.mjs scripts/notion-model-cache.test.mjs scripts/skill-consumption-model-baseline.test.mjs`；`--test-name-pattern 'combined catalog:'` 可复跑本切片。保留旧 flat 正反例、组合一回执的 HTTP/bytes 计数、full 失败而 View 可用、名称歧义、权限 scope／descriptor、部分目录和原公开 Doctor 读取冻结 envelope 的证据。此迁移不改变真实任务、oracle、工具、预算或评分，也不把确定性回归视作真实 C/D／SC20 成功。


真实 C/D 的每轮 final 先从本次 submission 的 observer slice 取得最后一个 `assistant-final`，保留原事件、全文、SHA-256 与 UTF-8 bytes，并在验收前写入 `turn-N.json`。自然任务未实际 use、模型最终失败或 RPC 在输出后失败，都仍保留已发生的 final；当前轮缺少 final 时不借上一轮、早先成功事件或其他 case。保存输出不改变原失败、后续 `not_run`、语义评分、预算或通过条件。RPC 与 final 留证同时出错时保留原 RPC 主错误，另记 `finalEvidenceError`；留证失败本身仍为失败，不掩盖或降级。复用原 `driveIntentStopping` 的确定性入口 `node --test --test-name-pattern 'intent final receipt' scripts/notion-model-cache.test.mjs`，同时验证自然 use 断言仍失败、最后失败 final 不被早先成功替换、RPC 失败留证和恢复轮缺失 final。C10 原 `D-natural-task` 的 `observer.jsonl` sequence 88 已有 41,059 bytes / SHA `b226ad1e1096976ea04a03cde05cc7b4db8477111a92ce74d860618c75102258`，其旧 `turn-0.json` 缺 final 的失败原件保留，不回填或改判。

这些结果证明真实 Pi 和安装边界，真实 Notion、真实模型、双机恢复及日用安装分别验收。SC20 的冻结比较 manifest 必须声明 previous-broker、notion-candidate、pi-native-local 三个角色；本地臂须用同字节/版本的普通全局 Skill，由 Pi 原生发现/read，不加载 Broker。记录相同任务、模型、工具 profile、缓存/会话初态和完整 provider 输入，未跑本地臂不能推算对照收益。

SC23 当前 C3 的管理入口为 `ctl operation list/show/reconcile/resume`，旧顶层 `operation` 继续作为同一 handler 的显式兼容入口；新 `next.argv` 使用 `ctl`，历史 receipt 的原始 bytes/hash 不改写。验收须核对候选自身 schema，维护原 operation ID、unknown 状态与旧调用者的明确兼容范围。此前 C1 不支持 `ctl operation` 的失败原件保留为迁移前证据，不能套用到 C3。旧包回滚仍需从该包支持的 `operation show` 获取下一步，不直接执行新包生成的 ctl argv。

### 2026-11-07：C12 原 C 三轮的技术、成本与语义

使用原 `--intent-case C-introduce`，产品为 `a9ba19e`／C12，模型 harness 为纯 Git `1f991217`；计划、三份提示、私有 oracle、评分及原预算保持。一次 doctor ready 后一次 run，三次提交、0 retry／fallback。初始介绍、同会话复用、明确再读均技术通过；原 manifest 仍为 `review_required`，独立语义整体不通过。前两轮把明确标为 paths-only 的项目文件名单升级成“只有单元测试／缺少 E2E”的肯定结论，没有项目正文读取支持；第三轮核心回答通过，保留局部事实校正。不能将此样本写为正式 SC21 通过。

实际公开动作是初轮 read 目标主文与参考 README，续问零工具，再读轮一次 read。完整 41,537 B 根与 5,938 B Requires 在六份实际输入中各保留一份；目标 6,837 B 在选择后完整交付。明确再读取得新的完整源读取记录，但本次 provider 工具消息是 2,822 B 的 `Already loaded.` 加目录，原完整正文仍在历史中一份；源读取与模型是否重发全文分开计账。53 个未选 Member 正文读取、来源写入及 CLI 子进程均为零。

| 完整实际尝试 | C10 历史（含失败） | C12 本次 |
| --- | ---: | ---: |
| 原提示提交 | 3 | 3 |
| provider 请求／序列化请求体 B | 7／771,632 | 6／575,282 |
| 来源 HTTP attempts／请求体 B | 53／6,121 | 50／5,884 |
| 来源解码响应 B | 5,089,320 | 4,373,438 |
| runner 总时间（n=1） | 73.765 s | 88.420 s |
| 技术／独立语义 | failed／failed | passed／failed |

首个 provider 尚未出现模型工具选择时，请求体 92,546→80,824 B；完整 Default XML 块 30,687→18,965 B，二者均少 11,722 B。74 个 canonical 身份、名称和准确入口不变。每份省去 50 处重复描述：首份为 50 个 native-custom Members 证明，后五份各为 49 个 native-session 加 1 个 complete-generated-directory；不是六份均靠同一种 receipt。六份 Default 累计 113,790 B、guidance 12,288 B、工具定义 18,570 B；这些组件与正文／历史有重叠，不与完整请求体相加。

来源逐 receipt 对账确认少的恰为三页 list 库存：237 请求体 B、715,882 解码响应 B，其余 50 次请求的 operation/kind/target/status/bytes 多重集相同；consume 仍为 11 次正文请求／458,902 B。一次 paired SDK 交付 full298／Default74，请求与字节只记一次。事后私有审计另有 5 次 metadata／32,149 B，不混入 consumer。Pi 规范化 usage 为 input44,750／output3,133／cacheRead118,272／total166,155；原 provider usage body 未留，费用未知，cost0 不代表免费。

选择器仍为 `magpie/group/flash`、thinking high，但实际 responseModel 从 C10 的 `deepseek-ai/DeepSeek-V4.1-Flash-1017` 变为 `deepseek-v4.1-flash`，别名／后端版本等价未知；工具路径、回答、请求数也不同。因此 196,350 B 总差额不是严格同后端全任务净收益，n=1 不支持稳定时延结论，旧静态 80,272 B 假设不计实测。未新跑 D、未补样本、未用成功技术路径覆盖内容失败。

证据根 `/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/c12-c-cost-draft-0yg6dljt`：`run-handoff.json` SHA `b6ab774e94a57e0f5754523a77361a25f0c5c1067fe819d680872448a10bd9b6`；`run-diagnostics/wire-and-cost.json` SHA `e4548c40d7d3361516bade38b62eeea9335784ecffc0c2ca398351f35eb5a532`；独立语义 `semantic-review-records-decode-20261107.json` SHA `46d2fbffa284a0bc131accb29fbd4edd93cc9ea2c1b5d389ff566b3bbb480536`。原 E→系统 Trash→E 全0，50份原件及父manifest保持，owned进程已关闭；产品87／harness258／日用3哨兵及两仓原暂存内容保持。root核18交接引用、来源17原件与6份实际wire。Mini正常执行入口仍UNAVAILABLE；SC22／SC20／SC21／SC24不关闭，日用保持旧安装。

### 2026-11-07：C12 恢复增量与剩余成本归属

当前 C12 同包 [CI 42330430928](https://github.com/yoyooyooo/pi-context-broker/actions/runs/42330430928) 的原报告已覆盖 HTTP cache recovery 的 cold／warm／expired／forced／resumed，以及 rate-limit／disconnect／cancel；Pi 1.5／1.4 的 session-lifecycle 也已通过。各分支实际请求数见[成本地图](skill-consumption-cost.md#c12-当前候选的已运行边界2026-11-07)，不继续笼统列作待跑，也不据此升级全部 1,120 个组合。

独立 `session-compaction` 另以同一 C12 包、原 fixture、冻结 1f harness 和原预算完成一次实际 Pi：kept 不重备正文，summary／forged 各一次 fixed inspect 恢复原四 pin，下一 provider 四正文各一份。19 份安装 serializer 请求共 184,474 B、14 SDK、0 来源 HTTP，原 E→Trash→E 后 106 原件保持；完整证据在[会话恢复地图](session-cache-recovery.md#c12-同包压缩恢复增量2026-11-07)。这不是新模型样本或双机验收。

C12 原 C 的根因复核直接确认：实际 developer 项目块已标 paths-only，完整 poteto 也要求区分事实／推断／猜测；read 工具可读取项目源码。没有发现足以将未经核实的仓库判断归因于正文丢失或产品 guidance 的证据，因此保留原语义失败，不增加针对该回答的提示或重采样。作者正文和 Requires 保持。

旧 ZIP 的残余成本已从同一原 C 的 raw receipt 核到 owner/chunk/request：3 个归档、6 chunks 实际为 3 HTTP／392,539 decoded B，SDK 回执报告 51 路径 all_files_ready。主文和显式资源 read 覆盖 4 路径，其他 47 个同 owner 归档路径与 53 个未选 Skill Member 正文0分开，不声称只有入口被下载或物化。复跑脚本、完整账本与限制见[旧归档成本](skill-consumption-cost.md#c12-旧归档的实际承载成本2026-11-07)。当前格式保留，SC17/18 不据此关闭或加入新 backend；Mini、完整本地对照与真实任务质量仍是各自未结项。

### Drive：既有受控宿主路径

以下路径无需生产 Notion 或真实模型授权。它实际启动 Pi 和 Broker，驱动原生 read、显式选择、资源、失败与持久会话；source 与 provider 明确为受控 fixture。它不证明真实模型能力或新的低延迟目标。

```bash
SC_PARENT="$(mktemp -d /private/tmp/skill-consumption-evidence-XXXXXX)"
node scripts/verify-notion-integration.mjs run --mode deterministic --host pi --evidence-root "$SC_PARENT"
SC_EVIDENCE="$(python3 - "$SC_PARENT" <<'PY'
from pathlib import Path
import sys
runs = list(Path(sys.argv[1]).glob('broker-notion-evidence-*'))
assert len(runs) == 1, 'Use exactly the directory reported by this run'
print(runs[0])
PY
)"
node scripts/verify-notion-integration.mjs evidence --evidence "$SC_EVIDENCE"
```

失败也保留 `SC_PARENT` 与本次输出路径，先检查 manifest 和 stderr；不能重试覆盖旧样本。driver 失败可能早于后续命令，恢复时从本次真实路径开始，不能重造 pass 回执。输出有 functionalStatus、missing 及执行分支；只检查目录存在不够。

### Evidence

审阅 `manifest.json` 中实际 selectedHosts、branches、notRun、scratch、extension、doctor、失败阶段。然后核对本次真实文件清单中的 Pi provider/RPC、source CLI 调用与 owned-processes spawn/close。OMP 未选即 not_run。不要要求未执行宿主产生证据。

先保存所有既有证据文件的 SHA-256 清单，随后 cleanup，再逐文件复查。清单放在 SC_PARENT，避免把它自身纳入：

```bash
python3 - "$SC_EVIDENCE" "$SC_PARENT/retained-before.json" <<'PY'
from pathlib import Path
import hashlib, json, sys
root = Path(sys.argv[1])
rows = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in root.rglob('*') if p.is_file()}
assert rows and 'manifest.json' in rows
Path(sys.argv[2]).write_text(json.dumps(rows, indent=2) + '\n')
PY
```

真实服务、真实模型、PTY、独立安装和双机分别使用原地图入口。不能给 controlled provider 的结果贴 real_model 标签。新版最小投影合同尚未冻结时，原 A/B 完整正文规则保持；`evaluate` 只接受 `source-identity/v1`，不把任意摘要当作合法投影。

### Cleanup

先确认 run 已结束、所有本次宿主都有 close 证据、没有待核对的 unknown mutation。以下 helper 仅回收本次关联 scratch，不删除证据：

```bash
node scripts/verify-notion-integration.mjs cleanup --evidence "$SC_EVIDENCE"
node scripts/verify-notion-integration.mjs evidence --evidence "$SC_EVIDENCE"
python3 - "$SC_EVIDENCE" "$SC_PARENT/retained-before.json" <<'PY'
from pathlib import Path
import hashlib, json, sys
root = Path(sys.argv[1])
for name, expected in json.loads(Path(sys.argv[2]).read_text()).items():
    path = root / name
    assert path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == expected, name
print('All original evidence bytes retained after cleanup.')
PY
```

cleanup 新增自己的回执不影响原文件比对。若原文件改变，保留失败现场并修复规程，不能排除该文件掩盖错误。禁止按进程名称 kill、永久删除或触碰他人会话。真实网络、真实模型是否运行要单列；此次完整路径的两者均为 not_run。

### Drive：SC05/06 搜索、注入与原生读取投影

沿用同一已安装 CLI/SDK、同一 fixture，分别构建并独立安装基线与候选 Broker。复用 `scripts/notion-sdk-pi.mjs`，对每臂分别运行 `--scenario dollar`、`native`、`prepare`；`all` 的当前清单见 `--help`，不等同于本次三路对照。每次使用新的仓外 `--out`。基线传 `--expect-compact-context false`，候选传 true（默认）；false 仅允许观察旧形态，不认证新合同。

```bash
node scripts/notion-sdk-pi.mjs doctor --package "$CONTEXT_PACKAGE" --fixture "$CONTEXT_FIXTURE"
node scripts/notion-sdk-pi.mjs run --package "$CONTEXT_PACKAGE" --fixture "$CONTEXT_FIXTURE" --scenario dollar --expect-compact-context true --out "$CONTEXT_EVIDENCE"
node scripts/notion-sdk-pi.mjs evidence --evidence "$CONTEXT_EVIDENCE"
node scripts/notion-sdk-pi.mjs cleanup --evidence "$CONTEXT_EVIDENCE"
node scripts/notion-sdk-pi.mjs evidence --evidence "$CONTEXT_EVIDENCE"
```

每个实际 provider capture 都有 `provider-requests/NNN-serializer-request.json` 原始 POST 和对应 serializer receipt。独立重算 bytes/hash、核对实际 RPC 工具序列，并汇总 `provider-http.json` 的完整场景成本。原 prepare 最后一轮证据文件是同一请求的保留别名，不能再加一次。TranscriptContext 包含宿主 details，与真实 HTTP 输入分开记账。

候选必须保留完整正文和准确后续入口；native 按实际 footer 的 ref 直接读取资源，不能插入额外 inspect。搜索保留来源消歧、disabled、分页和完整 host details；目录去机器字段不裁剪行。美元当前选择保留短引用与可用目录，恢复用固定 canonical ref，不依赖新进程未登记的旧目录。已有 `notion-startup-flow.mjs --case rpc-active-recovery` 单独验证实际 Pi 固定正文恢复；该场景故意保留目录失败，未执行的恢复后资源 read 不得记通过。

`$` 注入的完整正文可以复用 Default 描述，但每个省略项必须在**本次实际输入**中有完整 canonical card，并与原准备目录及当前 Default 的 source、scope、id、kind、name、description、ref 相符。沿用既有 source-identity/v1 的完整正文交付 span、hash、snapshot/version binding；只改变生成的 Default 描述，不改作者正文、Requires、关系或目录身份/入口。普通 user 仿造 XML、仅有 `## Members` 标题、缺失/截断正文、摘要、孤立旧 receipt、不同来源/owner/固定版本、描述更新都不能证明可省略。原 `host-prepare.test.ts` 的 `Pi dollar` 用例覆盖直接注入和 Pi 原生 user-content + receipt 恢复；与原 native/read/use 投影断言同跑。安装版 dollar 场景在每个实际 provider 请求复核剩余描述的完整副本，累计量以实际 HTTP 原件重算；静态字节差额不代替真实模型任务收益。

清理前保存原件哈希，核对所有宿主/SDK/child 终局；随后按既有 evidence → cleanup → evidence 流程复查原件。离线 fixture 的 Default View CACHE_MISSING 与 child exit 1 继续单列。本路径只证明 installed Pi 与实际 serializer/localhost HTTP，不证明真实模型 token、选路质量或生产延迟。最近对照见[测量记录](../../../../packages/context-broker/docs/skill-model-surfaces-verification-2026-11-05.md)。

### Drive：SC05 / SC08 重复原生读取的模型确认

复用同一独立安装包、冻结 fixture 和现有 runner，运行 `native-repeat`。以下变量指本次实际安装目录、fixture.json 和新的仓外证据目录：

```bash
node scripts/notion-sdk-pi.mjs doctor --package "$REPEAT_PACKAGE" --fixture "$REPEAT_FIXTURE" --scenario native-repeat
node scripts/notion-sdk-pi.mjs run --package "$REPEAT_PACKAGE" --fixture "$REPEAT_FIXTURE" --scenario native-repeat --out "$REPEAT_EVIDENCE"
node scripts/notion-sdk-pi.mjs evidence --evidence "$REPEAT_EVIDENCE"
node scripts/notion-sdk-pi.mjs cleanup --evidence "$REPEAT_EVIDENCE"
node scripts/notion-sdk-pi.mjs evidence --evidence "$REPEAT_EVIDENCE"
```

基线 Doctor/Drive 使用 `--expect-short-confirmations false`，候选保持 true（默认）。该开关仅允许观察旧确认形态，不放宽原始结果、必要正文、目录、实际工具序列或进程终局。两臂使用同一最终 driver；同时更换 CLI/SDK 时分别记录身份，不能把整个差额归给 Broker。

固定五次工具调用为 search → 首次主文 → 首次资源 → 重复主文 → 重复资源。第一次 read 使用搜索实际返回的引用，后续使用首次主文 footer 的真实 `sr:S` / `sr:R`；不插入 inspect 或测试专用读取。六次 provider 请求都经 installed serializer / localhost HTTP 留存。原始两次主文与资源结果保持完整，当前 provider 投影保留首次正文和目录，只将重复正文替换为短确认；主文 footer 的其余内容保持不变。逐请求复算差额并核对工具往返，不能只比较确认字符串长度。

短文案与作者正文相同、raw/XML/JSON、极短与空内容、坏证明、不同 scope/pin、partial、重复投影与压缩后恢复由既有会话定向测试补齐。原始 JSONL、toolCallId、完整 read 结果不得改写。该路径是受控提供方与实际 Pi 的验证，不代替真实模型选路或生产延迟门槛。

最近的三组同条件结果、逐 SDK 区间对象读取与清理后原件复核见[重复读取记录](../../../../packages/context-broker/docs/repeat-read-consumption-verification-2026-11-05.md)。

### Drive：SC07 固定资源批读

复用 `scripts/notion-sdk-pi.mjs`，不新增顶层验证器。先在 CLI 仓按对应消费链地图构建、打包并独立安装 SDK，运行 `sdk-package-smoke.mjs`。Broker 只从该**已安装 CLI package**选择 `NTN_SKILLS_BUILD_ENTRY`，使用 `bun scripts/build-tern.mjs --target broker --package-out ABS_NEW_PACKAGE`，随后在隔离产物目录 `npm pack --ignore-scripts` 并安装到新 consumer。包目录必须包含相邻 SDK/CLI/runtime 清单，`source.command` 缺省；checkout import 或显式 command 不代替默认 bundled SDK。

以下变量均使用本次实际绝对路径：`RESOURCE_PACKAGE` 是独立安装的 Broker 目录，`RESOURCE_FIXTURE` 是 CLI fixture.json，`RESOURCE_EVIDENCE` 是新的仓外证据目录。`sdk-fixture.ts --catalog` 生成的独立 `resources` Skill 包含普通 UTF-8、BOM/CRLF、空文件、binary 和未选资源，旧 `a` 单 binary 场景保留。

```bash
node scripts/notion-sdk-pi.mjs doctor --package "$RESOURCE_PACKAGE" --fixture "$RESOURCE_FIXTURE" --scenario resource-batch
node scripts/notion-sdk-pi.mjs run --package "$RESOURCE_PACKAGE" --fixture "$RESOURCE_FIXTURE" --scenario resource-batch --out "$RESOURCE_EVIDENCE"
node scripts/notion-sdk-pi.mjs evidence --evidence "$RESOURCE_EVIDENCE"
node scripts/notion-sdk-pi.mjs cleanup --evidence "$RESOURCE_EVIDENCE"
node scripts/notion-sdk-pi.mjs evidence --evidence "$RESOURCE_EVIDENCE"
```

Doctor 是只读前置检查，Drive 使用真实 installed Pi 和受控 provider。原始 tool result、provider payload、session、source 观察和二进制文件复制必须在 cleanup 前封存；已有 evidence/cleanup helper 只回收确认归属的 scratch 并保留原件。失败样本另存新目录修复重跑，不能覆盖。缺 SDK 新能力或实际 Pi factory 时标 blocked/failed，不切换另一宿主。

helper 输出中的 `cleanup` 布尔值表示本次命令是否请求清理；再次运行 evidence 时的 `cleanup: false` 不表示清理回退。实际清理状态核对 `cleanup.json` 的 `status: trashed`、owned scratch 已不存在，以及清理前后的原始证据 hash 一致。

独立验收要逐项核对：实际 `read` schema 能表达互斥 `path/paths` 且最多16个文件；每批一次 `read-resources`、无 `consume` 和逐文件 `read`；实际 JSON text 的完整 UTF-8/BOM/CRLF/empty bytes/hash；binary 由实际落盘文件复核且不标完整文本；每个 v2 receipt 的 toolCallId、owner/pin/File、整体 digest 与 JSON span一致；repeat 只在 provider 投影替换非空重复正文，原始会话结果仍完整，empty 保持空字符串，binary 元数据不变；没有主文 active/graph 绑定。

`resource-batch` 故意直接输入canonical固定引用，所以它只证明批读与发现的短引用分别可用。实际 `sr:R[]` 用独立 variant 验证：

```bash
node scripts/notion-sdk-pi.mjs run --package "$RESOURCE_PACKAGE" --fixture "$RESOURCE_FIXTURE" --scenario resource-batch-short-refs --out "$RESOURCE_SHORT_EVIDENCE"
node scripts/notion-sdk-pi.mjs evidence --evidence "$RESOURCE_SHORT_EVIDENCE"
node scripts/notion-sdk-pi.mjs cleanup --evidence "$RESOURCE_SHORT_EVIDENCE"
node scripts/notion-sdk-pi.mjs evidence --evidence "$RESOURCE_SHORT_EVIDENCE"
```

`RESOURCE_SHORT_EVIDENCE` 必须是另一个新目录。该 variant 先 `notion_list`，再原生 `read` 主文取得四个真实资源句柄，随后一次 `read(paths)` 及同会话 repeat；主文只来自前面的显式原生读取，SDK 总账须逐项列出目录、主文与两次 read-resources。核对实际 RPC 参数确实是四个对应路径的 `sr:R`，不能用 canonical 成功推断。两个场景保持独立的成本和主文投递结论。

全 warm fixture 的 0 HTTP 只说明本场景离线消费。Core 受控 retained tests 另用请求 object ID 集合证明冷选中物化、共享 chunk 去重、未选主文/资源零下载。SDK abort/header/body、预算、混 pin/owner、重复 alias、坏 proof 的反例沿现有 SDK smoke 和定向测试。旧 `native`、`prepare` 场景用于实际 Pi scalar 工厂与主文 receipt 回归。真实 Notion、真实模型、pro/mini 和日用安装仍单列；本路径不关闭整个 SC07/SC21。

### Drive：SC07 / SC13 固定单资源直读

沿用同一 runner、fixture 与独立 npm 安装步骤。候选 SDK 需导出 `READ_OUTPUT_PROOF_VERSION = 1`，Broker runtime manifest 需记录 `read_output_proof_version: 1`；`readSkill(..., { output })` 的文件 SHA 和独立主文 commitment 只供机器校验，不进入模型。若比较时同时更换 Broker 与 CLI/SDK，分别保留两者版本和 hashes，不能称为只改变 Broker 的对照。

```bash
node scripts/notion-sdk-pi.mjs doctor --package "$SCALAR_PACKAGE" --fixture "$SCALAR_FIXTURE" --scenario resource-scalar
node scripts/notion-sdk-pi.mjs run --package "$SCALAR_PACKAGE" --fixture "$SCALAR_FIXTURE" --scenario resource-scalar --out "$SCALAR_EVIDENCE"
node scripts/notion-sdk-pi.mjs doctor --package "$SCALAR_PACKAGE" --fixture "$SCALAR_FIXTURE" --scenario resource-scalar-short-refs
node scripts/notion-sdk-pi.mjs run --package "$SCALAR_PACKAGE" --fixture "$SCALAR_FIXTURE" --scenario resource-scalar-short-refs --out "$SCALAR_SHORT_EVIDENCE"
```

每个输出须为新的仓外绝对目录。仅在基线尚未支持固定资源直读时，对该臂 Doctor 和 Drive 加 `--expect-direct-scalar false`；它只允许保留旧主文读取/物化/consume 成本，仍严格检查资源内容、身份、对象读取正控制和完整终局。已支持直读的基线和候选都保持 true，五次 native read 应恰为五次 SDK read、零 consume/read-resources、零主文与未选对象读取、零主文物化/投递/active。

两个场景的第一工具调用直接 read，依次读取 UTF-8 全文、BOM/CRLF 分页、同文件全文、binary、empty。五次工具调用和六轮 provider 请求全部经过真实 installed Pi serializer 与 localhost HTTP 留存。分页与 binary 不得标记为完整 UTF-8；空文件的 native/session 原文仍是空串，Pi 1.4 serializer 的 `(no tool output)` 占位必须按实际 HTTP 字节计数。无真实图片 fixture，不把 binary 当作图像 E2E；图像委托由既有 adapter/host 定向测试验证。

比较固定目标 bytes 在单次调用内复用时，逐个 SDK read 的 start/end 区间核对对象读取路径、bytes/SHA 和确切次数；暖目标候选每次一次，基线的重复读取照实保留。第二次读取同一路径仍须实际读取，不用跨调用缓存消掉正控制。该指标仅覆盖观察到的 Node Store 对象边界，不能替代全部文件系统、hash/CPU、冷恢复或网络成本。空对象也有读取事件，不能只凭累计字节数推断次数。

`resource-scalar-short-refs` 先用真实 installed SessionManager 和 Broker short-ref bridge 构建声明过的 metadata-only seed，再在新 Pi 进程恢复。seed 只有固定 owner/File 元数据与 setup 消息，没有主文、物化、delivery 或 active；`resource-scalar-seed.json` 和原始 JSONL 保留模块 hashes、cwd 与句柄。该路径证明持久化短引用恢复消费，不声称真实 Agent 在未 inspect 时首次生成了句柄。

审阅 `resource-scalar-evidence.json`、`resource-scalar-cache.json`、`resource-scalar-files/`、原始 session、object observer 和全部 serializer 请求。main/hash/未选对象检查应相互独立；source 阶段成功不能代替 native 投递。旧 SDK、custom command、主文路径及稳定 File ID 的主文 hint 继续走既有路线；canonical 主文带 File ID 不应新增一次资源预读。全部进程关闭后按既有 evidence → cleanup → evidence 流程保存原件。该对照是受控 warm 源、新 Pi 进程，不能推断生产 Notion 延迟、真实模型选择或日用安装。

### Drive：SC13 固定主文与有效当前缓存

沿上面的独立 CLI → Broker 构建/安装路径，使用本次 `sdk-fixture.ts --catalog` 产生的 fixture。仍运行同一个 `notion-sdk-pi.mjs`；`ENTRYPOINT_PACKAGE` 指已安装 Broker，`ENTRYPOINT_FIXTURE` 指 fixture.json，`ENTRYPOINT_EVIDENCE` 指新的仓外绝对目录：

```bash
node scripts/notion-sdk-pi.mjs doctor --package "$ENTRYPOINT_PACKAGE" --fixture "$ENTRYPOINT_FIXTURE" --scenario partial-entrypoint
node scripts/notion-sdk-pi.mjs run --package "$ENTRYPOINT_PACKAGE" --fixture "$ENTRYPOINT_FIXTURE" --scenario partial-entrypoint --out "$ENTRYPOINT_EVIDENCE"
node scripts/notion-sdk-pi.mjs evidence --evidence "$ENTRYPOINT_EVIDENCE"
node scripts/notion-sdk-pi.mjs cleanup --evidence "$ENTRYPOINT_EVIDENCE"
node scripts/notion-sdk-pi.mjs evidence --evidence "$ENTRYPOINT_EVIDENCE"
```

该场景使用真实 Pi、默认 bundled SDK 与受控 provider。自有缓存先经本次安装 SDK 的公开 current consume 完成完整验证，随后才移出一个约 2 MiB 的未选对象并损坏另一个；不得手写验证记录。`notion_list` 后固定主文 native read 直接返回完整目录，小资源 native read 复制该目录引用；三次工具调用须保留完整源字节和对应 proof，不再次准备主文。`warm-current-validation.json` 与 `partial-entrypoint-evidence.json` 应明确受控 warm 初态、选择、完整清单和实际对象读取；`observer.jsonl` 的 `object_read` 事件需有真实主文读取的正控制，未选大对象不得读取、修复或下载。

缺失/坏 hash 对象被选中时的明确失败、partial export 拒绝、完整 clone 逐文件 export 在独立 SDK smoke 验证；同 pin retained 缺失主文恢复由 CLI Core 的真实请求集合验证。不要让预算错误替代缺失对象负例，也不要由文件目录或旧验证记录推断所有 bytes 当前完整。current 的 TTL、正文期限、scope、失效和 pending 条件仍独立生效。

按上方相同规则封存真实 session、provider、source/object 账本并核对清理前后原件 hash；仅 `status: trashed`、owned scratch 消失且原证据不变才证明清理完成。新会话验证须从本 Skill 和本地图实际完成同一路径，不能只 review 新增文字。全 warm/partial-cache 的 0 HTTP 不证明真实冷源成本；真实 Notion、实际模型和 current/source 尚未完成的范围单独报告。此条通过不关闭整个 SC13/SC21。

Current 来源所有权的 cold 验证继续走 CLI 既有 SDK smoke，见相邻 CLI 消费链地图的「Current 来源先判归属再取字节」。核对空 Store、已有 custom/tombstone 对应的大来源零获取、必需 source main YAML/有效资源的正控制，以及 installed CLI full export 的逐文件 bytes/hash。该 transport 是受控 Response 与 loopback Notion；本节真实 Pi 的 partial-cache 不能替代它。HTTP/Git local alias 还必须保持实际字节验证后、对象发布前的 durable marker 顺序，后续 provider 失败不能留下漏标的新对象。Legacy ZIP 的 whole-archive 成本和首次 current 完整观察继续独立记账。

### SC13：已有成本按来源与初态分组（2026-11-06）

下表复核既有实际原件，不新增消费者、来源请求或存储机制。CLI 两份 C7 归档 `1e44d7cb…` 与最终 `f854faf5…` 的 CLI `6a82d148…` / SDK `2095a85a…` 字节相同；Pi 生产来源记录明确属于 ce50，不能改称后续 Broker 归档实测。

| 来源与初态 | 已观察的获取与完整性 | 不能推出的结论 |
| --- | --- | --- |
| 真实 Notion、Pro/Mini 各自空客户端根，独立 C7 公共 CLI 六命令 | 每机 38 HTTP：32 metadata、6 body、0 write；Pro decoded response 4,882,566 B，Mini 4,882,554 B。root read-inspect 为 21 HTTP，fixed use 为 12；随后 files/固定资源/offline export 为 0 HTTP。根+Requires 47,475 B、46文件/364,634 B完整export与oracle匹配，54个未选Member正文为零 | 这些是整次操作成本；未独立拆出生产首次原生手改/adoption的CPU、压缩wire或阶段延迟。原一个 unclassified_body trace标签由独立owner sidecar归属，原标签不改 |
| 真实 Pi、ce50/C7、两物理机各自cold roots | 每机4 SDK、0 CLI、37 HTTP、3,473,054 decoded response B；74条默认目录、完整根/Requires与固定资源交付。全部6个body请求经原独立sidecar归属，54个未选Member不读取 | 控制provider并非真实模型；不是未来候选成本，不能与CLI六命令相减称收益 |
| 受控 warm/partial-cache，安装 C7 SDK/CLI | 原公开 current consume先完成四对象验证（6次受观测Store读取），随后才移除/损坏两份2MiB未选对象；fixed/current主文各2次、单主文read与小资源各1次，未选读取零。选择缺失/损坏对象分别SNAPSHOT_MISSING/STATE_CORRUPT；partial export拒绝，完整clone四文件4,194,399 B逐hash一致 | Store观察不覆盖全部filesystem或hash/CPU；warm零HTTP不是cold下载收益 |
| 首次 current完整所有权观察、安装C7空Store/受控Response与loopback Notion | cold取得必要source main YAML与有效小资源：2请求/187 B，11 Notion请求/0write；custom/tombstone替代的两份2MiB来源不取得。仅元数据refresh为0 source请求、10 Notion请求/0write，两相位均29受观测对象读取、完整export等于oracle | 这是受控来源，不是生产native-edit/adoption延迟。完整有效清单/引用校验仍先完成，不能借旧receipt跳过当前事实 |
| legacy retained_bundle ZIP，C7实际CI service fixture缺失所选对象 | 选16 B guide仍取得完整2,097,517 B ZIP、全部65 chunks；1受控retained请求，7,848 request B / 2,939,106 decoded response B。完整archive/member校验后仅写16 B所选对象，未选坏/缺对象保持；第二次只读所选cache对象、零远端请求 | whole_archive_cost=true。只发布所选文件不等于随机下载；生产ZIP流量、频率、压缩wire与CPU仍unknown |
| 历史旧producer的真实双机恢复演练 | 各13 HTTP/89,667 decoded response B恢复4文件711 B，current body/write为零，后续9个fixed命令0 HTTP | 此数据是新建的graph_release + exact_bytes chunks，**不是legacy ZIP**，也不是找到的存量用户旧pin |

复核清单：`/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/sc13-cost-groups-jdz_17h8/classification.json`，SHA256 `9c9f4301186013a518ac33ad22e7fb6629345cdc2a4dd09da9aa61f6c0e230e0`。绑定原 C7 installed22 report `8209b2e3…`、partial `fc9213d4…`、ownership `8babe9be…`、实际 CI log `127603636279.log`、生产双机CLI/ce50及旧producer账本；原retained测试从b75到当前字节相同。所有历史失败、旧报告和C7 CLI的永久删除清理偏差保留，不能改称Trash；本次只有只读复核，没有清理来源或用户缓存。

本候选保留已验证的按需物化、完整current观察和完整export合同。这里完成成本分层，未知继续显式保留；不据此宣称新的存储布局、checkpoint或迁移已实现/无需实现。SC14、SC17、SC18继续按实际瓶颈、预算和已批准批次各自裁决；不把tiny fixture外推生产绝对收益，也不累加历轮百分比。

## Gotchas

宿主目录中的临时 location 只属于当前进程。多次 stop/start 后，资源相对路径必须从当前实际 provider 目录重新取得，不能沿用第一个进程的位置。当前按需消费可以使用 prepare、固定主文 read 和所选资源 read，无需整包 export；验收必须核对实际固定内容与资源回执，不能把发生过 export 当成成功的必要条件。失败分支的 source CLI 账本也必须在 scratch 回收前保留。

### 各种状态需要不同证据

- CatalogEntry/known：观察到候选的身份与目录元数据，不证明正文缓存或使用。
- SelectedBinding：明确 scope、身份和版本；短引用本身不授权。
- cached：验证过的源字节；materialized：实际路径和字节；两者都不证明投递。
- SourceBody：源 bytes/hash。ModelProjection：绑定源 hash、关系摘要、编译器版本及投影 bytes/hash；raw/export 保持源语义。
- delivered：本次实际 provider 输入的完整 span，而非 loaded 日志、hash、摘要或历史回执。当前输入同身份/版本完整正文至多一份。
- active：会话已启用的规则；压缩后正文不在输入中时需从固定版本恢复。inspect 不自动产生 active。

Pi 的短引用与 active 可复跑入口见 [运行时记录](../../../../packages/context-broker/docs/skill-consumption-runtime.md)。`before_provider_request` 仅 pending，未取消的同代 2xx `after_provider_response` 确认已完整投递的 active；该事件只是 headers，不等于 stream 或任务成功。SDK 默认准备直接使用已验证 consume 主文，目录仍有真实 CLI 成本。新旧首请求时间必须与同时发生的所有 list/ctl、HTTP 和进程终局一起报告。

### 证据反例

`self-test` 复用旧 graph 反例并加入截断/丢失 HTTP、漏附件账本、观察器异常、未见进程 close、错 scope/hash、只缓存未投递、只剩摘要、完整正文重复、oracle 预暖、隐藏副本、强制工具参数和失败样本/cleanup 证据丢失。它返回 evidence-contract-valid 或自检 passed，产品通过字段永远是 not-inferred。

该合同验证器只检查规范化观察，不能证明输入是未经伪造的原件。真实结论还需实际 driver、原始 artifacts、哈希及人审。新编译器和 SDK 的生产协议由 SC03 定义，不把此脚本当成运行时接口。

### 成本与证明层

Notion metadata/current-body/retained-body/write、附件与模型 HTTP 分开；attempt、重试、队列、预取、SDK/CLI启动均计入。无观察器、trace 截断、scope 未知不能写0。解码 JSON bytes 不等于压缩后 wire bytes；未知保留 null/unknown。只减少首轮文本但增加工具轮次不能称总成本降低。

原图 observer 会约束工具和任务文件，不能直接冒充 SC02 的纯成本 observer。[成本规程](skill-consumption-cost.md) 使用被动 provider hooks、Undici diagnostics 与 source request_metrics，保持工具和输入不变；失败与未知值不参与有效改善结论。

每次报告 passed、failed、blocked、not_run、not_applicable；后者必须有理由。失败不会因 cleanup 成功变为 passed，历史 Gate 也不能代替新包。规程本身由独立新会话读取后执行同一路径，提交该会话的真实命令与清理后证据，才完成 SC-VERIFY-03。

## 项目范围候选 autoload

AH-714 的增量预验收沿用正常 Pi HOME/agentDir、全部其他 packages、MCP、context、tools 和真实已存在的本地 Skill。只在仓外 owned 验证项目创建 `.pi/settings.json`：同一旧 Broker 的绝对 source 以 `extensions: []` 过滤，另以正常 package 声明加载独立安装候选。目标扩展不经 `-e` 注入；`-e` 只加载被动观察器。沿公开 `CONTEXT_BROKER_CONFIG` 复制已审阅的来源配置，只替换一个 Notion entry 和它的 owned cache；local roots、rules、catalogs 保持，任何相对配置路径、其他启用 Notion source 或显式 source.command 均拒绝，先补范围审阅。

这条路径称为 `project-scoped-candidate-precheck`。它不更改全局 package slot、CLI shim 或认证，不证明全局日用安装已经切换。AH-718 实际库存与最终日用层、物理 Mini、Notion UI 继续单列。真实本地同名条目须先从现存文件及实际 `get_commands` 证明；不能生成一个测试副本再称为“原本已有 @local”。新 owned Notion canary 可以沿公开 admission 使用已有本地 Skill 的同名，但 setup 必须明示，不改原本地文件、不复制其私有正文到 Notion。

### 构建与输入绑定

先取得最终 CLI/SDK 独立安装包及其归档 SHA。正式 builder 从 `NTN_SKILLS_BUILD_ENTRY` 所属 `ntn-skills/package.json` 解析同包 `./sdk`，检查合同与 Effect 依赖，分别 bundle 两者；嵌入 SHA 通常不同于原始 CLI/SDK，不能用直接字节相等替代这条输入链。

```bash
NTN_SKILLS_BUILD_ENTRY=/absolute/final-cli/node_modules/ntn-skills/dist/ntn-skills.js bun scripts/build-tern.mjs --target broker --package-out /absolute/new-broker-package
# 在 new-broker-package 内运行；输出目录由本次 run 独占。
npm pack --ignore-scripts --json --pack-destination /absolute/owned-archives
# 回到 Broker checkout；使用刚生成的归档，不重打包、不改日用 vendor。
NTN_SKILLS_BUILD_ENTRY=/absolute/final-cli/node_modules/ntn-skills/dist/ntn-skills.js CONTEXT_BROKER_CANDIDATE_DIR=/absolute/owned-archives node scripts/verify-artifacts.mjs --host pi
```

保留 builder 原命令/stdout/stderr、输入 package manifest/CLI/SDK hash，以及该次 `verify-artifacts` 的 `manifest.json`。其实际 `package.installed` 是候选根；artifact gate 与 daily helper 都检查 archive→安装成员→嵌入 runtime。不要手改 `dist/ntn-skills*` 或 runtime manifest。`verify-artifacts` 的受控 provider 不等于下面的真实模型验收。

### 冻结配置与运行

```bash
node scripts/verify-pi-daily-installation.mjs candidate-plan --config /absolute/frozen-candidate.json
node scripts/verify-pi-daily-installation.mjs candidate-run --config /absolute/frozen-candidate.json --live
```

`candidate-plan` 不创建会话或访问服务；`candidate-run` 必须显式 `--live`。配置放仓外，`version: 1`、`scope: "project-scoped-candidate-precheck"`，字段如下：

| 字段 | 冻结内容 |
| --- | --- |
| `brokerRoot`、`brokerArchive`、`brokerArchiveSha256` | 本次独立安装 Broker 根、真实归档及 SHA |
| `embeddedCliSha256`、`embeddedSdkSha256` | 安装包内实际文件的 SHA |
| `cliRoot`、`cliArchive`、`cliArchiveSha256`、`cliEntrySha256` | 作为 builder 输入的同一 CLI/SDK 包 |
| `artifactReceipt: {path, sha256}` | 上述实际 artifact gate 的成功 `manifest.json`；必须是 Pi、explicit input、同一 archive 与 runtime |
| `oldBrokerRoot`、`packageIndex` | 当前正常 settings 的目标包，默认 index 1；其余 packages 保持 |
| `sourceId`、`database`、`ownershipReceipt: {path, sha256}` | 既有 source ID、新 owned entry、绑定该 entry 的公开创建回执 |
| `localSkill: {path, sha256, name}` | 真实原有同名 Skill 主文，按 realpath 与实际 native command 交叉核对 |
| `contextFiles` | 可选现存上下文文件绝对路径，只保存身份/hash，不拷正文 |
| `expectedBodies` | `{path, sha256, bytes}` 数组，独立源 oracle 的完整非空 UTF-8 文件；观察器只读比较，不种入 source cache、工具结果或 provider |
| `model`、`thinkingLevel` | `magpie/group/flash`、`high`；须由真实 get_state 与请求证明 |
| `turns` | 预先冻结的 `{id, prompt, bodies, proofs, requireUse, forbiddenObjectSha256s}` 序列；同进程按序提交，任一失败停止，后续保持 not_run |
| `evidenceRoot`、`rpcTimeoutMs` | 仓外证据根、可选 RPC deadline，默认 300000ms |

每个 `bodies` 项为 `{sha256, occurrences}`；必要 root/Requires 与目标资源为 1，未选 Member/另一来源 canary 为 0。必须由 `expectedBodies` 提供独立原始字节。默认另要求当前 receipt 校验的完整正文；只有原生本地控制路径可以明确标 `receiptRequired: false`，其来源仍须由实际 local command/path/read 与独立文件身份人审核对。`proofs` 是实际 Broker receipt 中必须同对象匹配的 owner/snapshot/File ID 等字段子集，不能把不同记录拼成一个通过。

`requireUse: true` 要求模型实际调用 `notion_use`，并有同一 toolCallId 的成功结果与 use receipt；只 read、旧轮回执、工具齐备或模型自述应用都失败。任务问题与预期在首次运行前冻结，失败后不改题、不补一次成功覆盖。本预验收只接受实际 `read/grep/find/ls/notion_list/notion_use` 调用；执行型或其他未审工具保留失败，不能据其声称脚本未执行。观察器不阻断或改写正常工具集，脚本和 binary 不可为验收自动执行。

取消项用 `cancel: {operation: "consume" | "read" | "read-resources", providerRequestsBeforeAbort: 0, timeoutMs: 30000}`，其中 provider 数按实际场景预先冻结。观察到该真实 SDK 操作仍在进行时才发原生 `abort`，要求同一 operation 的 cancelled 完成和 abort 后零新增 provider；未捕捉到在途窗口就是未完成，不注入延迟来冒充真实服务时序。`forbiddenObjectSha256s` 的零读结论须同时有选中对象的实际 callback read 正控制。

后端更新前后续接用 `resumeFrom: {path, sha256}` 指向前次 owned 成功 `result.json`。helper 校验前次 CLI/SDK/entry 和原 session hash，只复制本 helper 自建的 session 到新 owned 文件，保留原件，再调用真实 Pi `--session`；重用前次 owned source cache，明确是 warm resume，不当作空状态恢复。`noNotion: true` 将该唯一 source 标 disabled，仍保留其他配置；要求实际 provider 无 Notion 工具/catalog/guidance、SDK/CLI source 调用为零，本地 Skill 保持可用。

### 证据与裁决

复用 `skill-consumption-cost.mjs`、`skill-consumption-provider.mjs`、`skill-consumption-source-observer.mjs`、`observeGraphSdk` 与 `observeOwnedObjectReads`。观察器返回 undefined，不改 provider payload、工具集、SDK 参数或响应，不用 handler/fake provider。实际 payload 的 SHA/bytes 必须与 Undici 已发送 request body 一致，完整正文 raw/XML/JSON span 去重计数；details、schema、assistant arguments 不算模型正文。完整 SDK 输出、文件 proof、source requests、对象读取、每轮 final 与失败 verdict 分别留存。模型 HTTP entity bytes 不当 TCP/TLS wire bytes，source unknown outcome 不重放。

`passed` 仅表示本轮自动观测断言通过，`semanticReview: required` 始终保留，需另审原任务回答。helper 尚未运行的新候选不继承旧 gate；全局日用、真实库存、Mini 和 UI 不因本分支通过而关闭。复跑验证器本身：`node --test scripts/verify-pi-daily-candidate.test.mjs scripts/verify-pi-daily-installation.test.mjs`，正常 check 同时包含这两组反例。
