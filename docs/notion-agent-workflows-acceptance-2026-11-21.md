# Notion Skills 自然 Agent 工作流实施与验收

本记录对应 [AH-1207–AH-1214](https://linear.app/yoyooyooo/issue/AH-1207)，归入 [AH-1196](https://linear.app/yoyooyooo/issue/AH-1196)。正式结果由真实 Pi、`magpie/group/worker`、`thinking=high` 产生。外层验证 Agent 与被测日常 Agent 分开取证。

**本批八项实施与自然工作流验收已完成，45 个适用组合全部有通过依据。最后的 PDF `-ns` 与 daily 原生 CRUD 回归及自有对象退场均已完成。独立 Skill 评价保留其限定结论；Pro/Mini 安装与完整 C/T 总验收仍按原负责域继续。**

## 实施内容

| Issue | 交付 | 当前入口 |
| --- | --- | --- |
| AH-1207 | 自然旅程、真实对象绑定、有限事件、私有判定和留出输入 | `scripts/notion-agent-scenarios.json`、`scripts/notion-agent-scenarios.mjs` |
| AH-1208 | 普通 Pi 与 `-ns` 对照；实际模型、包、CLI 子进程和请求身份 | `scripts/verify-pi-daily-installation.mjs candidate-plan/candidate-run` |
| AH-1209 | 同进程多轮、真实发布屏障、预写澄清、fork/compact/resume | `scripts/notion-agent-workflow-runtime.mjs`、现有 RPC harness |
| AH-1210 | session 有效分支、真实请求、工具尝试、精确交付和业务读回分析 | `scripts/notion-agent-analysis.mjs`、tool lineage 与 CLI process observer |
| AH-1211 | 专门的仓库验证 Skill 与负责域交接 | [verify-notion-agent-workflows](../.agents/skills/verify-notion-agent-workflows/SKILL.md) |
| AH-1212 | 显式来源、URL、语义匹配、歧义、等价、互补、冷首轮、过滤视图和故障 | 同一自然语料的 `mixed-*`、维护咨询和离线场景 |
| AH-1213 | 查看与采用新版、共享 Requires、启停、来源切换、恢复与 Source applying | 同一自然语料的 `lifecycle-*` 及 Source 中断/恢复场景 |
| AH-1214 | 原生 CRUD、已有页登记、局部更新、重复删除、批次外投影恢复 | 同一自然语料的 `management-*` 与资源形态留出场景 |

语料包含 32 个场景，其中 28 个必选场景、4 个留出场景。按各自适用环境展开为 45 个组合、98 条自然用户输入；未展开的基础旅程共有 71 条输入。普通 Pi 是日常主环境；`-ns` 仅改变默认原生 Skill 发现，仍保留正常扩展及显式可读资源。

长期语料、运行时绑定、原始结果分别保存。用户输入只展开名称、URL、路径和业务材料。owner、snapshot、正确金额、工具次数和读回要求只供外层判定。场景选择沿配对 CLI 的 C/T 合同索引，不另建合同源或总运行器。

## 实际修复

### 日常来源与管理入口

Broker 接受用户提供的 Notion Skill 页面 URL，并先把物理页面解析为当前库中的精确逻辑 owner。页面 URL 的 View 查询参数不会改变所选 Skill。来源不存在、不可访问、身份冲突或只匹配同名对象时保留失败；当前读取和实际采用仍是两个操作。

日常提示明确遵守用户指定来源及已有选择。真正同等适用而有分歧的候选需要澄清，语义匹配明确或内容可互换时可直接推进。已连接 Notion 的维护说明通过正常目录和精确 read 发现；用户明确要求离线、bootstrap 或安装包说明时，才使用实际配对包的入口。

脚本型留出样本暴露了“要求使用 Skill，但任务只读”的歧义。Agent 读取了正确主文和脚本、回答正确，却只留下 inspection。说明现明确：用户要求使用或按 Skill 规则处理问题时，需要选择任务根和完整 Requires；“不执行脚本”“不修改页面”限制业务副作用，不取消选择。单纯查看、介绍或“只看看最新，不采用”仍是 inspection。选择本身不授予执行、写入或委派权限。

管理命令通过 `notion_ctl cli_source` 取得实际配对 CLI 和当前 source 范围。该响应按需解释默认 600 秒 CLI 网络预算、毫秒单位以及宿主等待余量。短轮询结束不能被误认为写入完成；持续后台执行须等待同一个进程的终局。三表字段和关系继续由 CLI 管理，日常 Agent 不需要构造内部关系。

### 完成结果与只读回查

严格的单次恢复判据又发现了一条真实日常指南缺陷。第 20 批 PDF `-ns` 运行 `aa1aa826-d42b-4406-be6b-dd7cb2d9ef0e` 第一次恢复已经退出 0，完整业务结果为 `complete / applied / restored`，模型也已经读到这个结果。它随后执行了第二次相同恢复。第二次虽返回 `unchanged`、Notion 写入为 0，实际恢复调用仍是两次，因此原运行保留失败。

真实 Notion 资源与已发送的模型请求都包含旧维护指南的指令：`Repeat on the live complete page to establish zero semantic writes.` 公开助手消息将第二次调用描述为复查，证据支持日常指南鼓励成功后的幂等重放。调查只使用公开工具结果、进程、请求与助手消息，没有读取隐藏 thinking。

CLI 提交 `9300b93` 和 `724f9db` 修正了维护与同步的四份指南：终态成功后按需要使用只读 `read`、`files` 或 `export` 回查；不要为了证明完成再执行一次写命令。用户明确要求再次操作或专门验证幂等性时可以重复。原操作中断、结果未知时仍按其原有同意图恢复合同处理。此次改动不改变写入、重试或未知结果的产品代码；新 SDK 构建与 `cce376e` 逐字节一致。

### 日常指南实际发布

修正已经通过现役 `ctl library source apply` 发布到日常 builtin Source。完整声明保留 `manual` 策略、`Ref=next`、三个既有成员与八个文件，设置 `accepted_ref=724f9dbddbbd9ce7128ad4c9a483110b33174122`。一次 apply 正常退出，Source 返回 `ready / applied`，解析提交与固定值相同。它更新了 Source 和成员的必要元数据，不能把未改正文的第三个成员描述为所有属性零写入。

`accepted_ref` 是持久 Source 声明。后续手动 refresh 仍会使用这个提交，直至通过公开管理流程更新或移除固定值；当前配置不自动跟随 `next` 的最新提交。这次候选说明发布不等于主分支合并、包发行或 Pro/Mini 日用安装更新。

Source apply 更新权威文件与目录，阅读页面另外通过 maintain、sync 各一次普通 `projection` 更新。两个命令使用显式的当前默认过滤规则，均返回 `scope:skill / status:complete`；它们属于指南发布，不计作被测 PDF 的恢复调用。原来完成的自定义过滤表达式未持久保存，本次没有声称恢复了未知的历史自定义策略。

独立只读检查同时验证两层：三成员的八个消费文件按路径、字节、哈希和 Git mode 匹配目标提交；八个人类阅读页面均存在，旧重复执行句子全部消失，四份修改后的指南显示新规则；另外四份未改文档保留原内容、链接含义哈希与页面身份。三成员均 ready、操作和投影标记为空，Source 在读回前后保持同一已完成版本。私有回执 `verification-0Vjz2v/result.json` 的 SHA-256 为 `7156273295e28873cc9e860733622a4dd3565634ad144626185b66de50bc477f`，root 另复核其 38 份引用原件，全部匹配。

### Source 生命周期

CLI 先枚举完整的关系信息，再对目标 Source 的贡献、Origin 和内容引用所确定的范围执行完整验证。无关的旧未登记页面不会阻断该 Source 的正常操作；指向目标 Source 的矛盾身份、非法引用和孤儿 File 仍会阻断操作。

Skills 和 Files 的两次查询不是共同快照。若有效 Skill 在前一张表扫描后创建，后续 File 可能引用初次 Map 中没有的 owner。CLI 对这个精确关系补一次读取，验证页面身份、所属 Skills 数据源与非归档状态；不会按名称寻找替代 owner，也不会丢弃该 File 来制造成功。

当前目录验证失败会保留预期与实际身份、字段摘要、文件路径及哈希差异。诊断保留矛盾事实，不修改作者内容来消除差异。

脚本型留出对象的首次真实恢复还暴露了成功写入后的确认失败：一个公开恢复进程返回 `WRITE_OUTCOME_UNKNOWN / CURRENT_PROJECTION_RESTORE_CONFLICT`，Agent 按返回的同意图指令启动第二个恢复进程才完成。第一次实际 PATCH 返回 HTTP 200，但原观察器没有采集后续响应正文，因此不能把某个具体字段状态当成已直接观察的事实。

受控 HTTP 重现证明：成功解除回收站状态后，精确页面读取已生效、完整稳定 ID 查询尚未出现该页面时，旧确认逻辑会产生同类失败。CLI 现仅在成功 untrash ACK 后，对这一窄状态进行最多五次只读确认，四次等待为 1、2、4、8 秒，全部共用原请求与时间预算。每轮仍检查精确 owner、完整唯一身份查询、Source 可用性和冻结指纹；内容变化、身份冲突、Source applying、查询不完整、取消或预算耗尽均不会被重试掩盖，也不会再次 PATCH。初态、写前守卫、未知 ACK 恢复与最终验证保持严格检查。

### 真实终局与故障观测

RPC harness 等待 Pi 的 `agent_settled`，并核实 streaming、compacting 和待处理消息都已结束。自动后台完成消息触发的新一轮仍受同一个原始总预算约束。每个用户回合保留原始终局帧；`agent_end` 或一次工具等待返回不能单独证明整个回合完成。

Store 故障先用同一固定版本的公共读取证明正文可读，再隔离自有 Store，并用同一个读取证明 `STATE_UNAVAILABLE`。重启后的真实 SDK 也须返回对应错误。只移走 manifest 仍可从 SQLite 恢复，不能冒充不可恢复故障。Broker 保留这个公开错误码，后续继续、刷新和普通提问分别验收。

### 验证入口与临时材料

独立验证 Agent 实际使用新 Skill 后，暴露出两处使用成本。`candidate-plan` 只校验配置、绑定与合同；完整构建和 CLI/SDK 配对检查由 `candidate-run` 在启动 Pi 前执行。说明现已明确这个分工，并链接现有 integration 负责域。没有新增 preflight API，也没有让 Agent 猜内部导出函数。

新 fixture 为临时工作文件分配自有目录；`candidate-run` 在启动 Pi 前，在全新自有项目写入三行通用环境说明：临时文件使用提供的 `TMPDIR`、shell 使用显式路径模板、任务结束后保留后续读取或续行所需的精确输入。运行入口拒绝覆盖已有项目指令或经过符号链接写入；结果记录实际项目说明的身份与哈希。真实 macOS 实测发现裸 `mktemp -d` 可能忽略 `TMPDIR`，因此仅传递环境变量不够。

这是公开且留有记录的项目环境约定，不是文件系统沙箱，也不包含 Notion 工具、业务答案或判定路线。CLI 进程观察器仍是被动观测。原始自然业务输入保持不变；旧运行不会被补写成曾收到新项目说明。退场保留工作副本、准确输入、绑定和 Store 证据，避免验证结束后丢失可继续操作的材料。

### 测试准备中的网络失败

一次真实删除事件收到 Notion 明确的 `429 rate_limited`，原场景在发送恢复请求前停止，首次失败保留。fixture 网络边界现对明确被拒绝的写请求执行有限重试，遵守 `Retry-After`，并共享一个 180 秒总预算。每次再次发出请求前重新检查剩余预算。写入的网络中断、响应解析失败和 5xx 不会被当作已知未执行而自动重放；不确定结果仍需保留。这项改动属于测试对象准备，不改变产品写入的成功判据。

另一次脚本型复验在控制端删除第 83 个生成块时遇到 `UND_ERR_SOCKET`：前 82 个 PATCH 已返回 200，该请求没有确定回执，页面删除尚未发生。首轮“使用 Skill、只读查看脚本”的 12 条断言通过，但恢复用户输入没有提交，所以整次运行 `3b454612-c939-4fb3-8fac-7ac2441b2ca7` 保留为失败。后续独立精确 GET 看到该块和页面都仍未进 Trash；这不能回写为原请求成功。旧对象按公开 Source 管理命令退场，后续复验使用新实例。

测试删除事件现先校验精确自有页面与全部顶层块，遇到同一目标的未知 transport 回执后，只执行一次有界逻辑 GET。必须同时确认 ID、对象种类、已知父页面或稳定 Skill ID，以及实际 Trash 状态，才能继续建立测试前提。记录保留 `acknowledgement:unknown` 和独立 `observed-state`，不会重发 PATCH。读回仍存活、身份不符、内容不完整或 GET 失败时仍抛原写错误，并保存确认失败与此前已完成的对象。通用网络函数和其他写入策略未改；旧第 18 批恰好符合“仍存活”的负例，不因这个设施修复变成通过。

## 验收规则

一次通过须同时有真实来源可见性、实际模型请求与完成响应、所需正文和资源的精确身份，以及对应业务结果。历史选中记录、同名内容、prepared、命令退出码和模型自述都不能单独代替这些证据。

正文判据关联 owner、scope、snapshot/version 和文件路径。Notion 逻辑来源可以使用其合法 Git 或缓存字节；创建输入中出现过同样的正文，不等于该 Skill 已被读取和用于任务。零次调用判据统计失败、被拒绝和撤回的实际尝试。未知指标保持未知。

原始失败不改写。验证器误判可用封存的同一次执行重新分析，修订解释追加引用原件，保持原 run ID、时间、环境、产物和成本；这不会增加一次模型执行。产品缺口或缺失真实完成证据须修复后新开实例，并保留 `retest_of`。

四个留出场景最初按自然表达、业务材料组织或上游资源形态独立保留。脚本型留出样本发现只读使用意图缺口后，其后续运行归入该首败的回归，不能继续称为最终提示下从未见过的盲测。其他自然变体及来源选择、查看/采用的相邻回归分别保留实际候选与执行身份；样本通过不构成对所有模型输出的普遍保证。

管理命令完成后，独立读回只能检查，不能补字段、补关系、清 pending 或重新投影。正常 fixture 退场在场景结束和进程退出后执行，独立报告。投影比较稳定逻辑身份、可读内容、目录和必要关系，允许按合同变化的页面 ID 与审计时间；Git 消费树另核完整文件、字节、路径和 Git mode／执行位。

“单次恢复”单独审计实际 CLI 进程与 argv。帮助、失败的只读预览、恢复完成后的读取不计作恢复写调用；同一个 CLI 内部的 restoration 与 projection operation ID 也不拆成两次命令。反过来，重复启动恢复命令、外层修正对象或清理 pending 都不能被正确最终页面抵消。

新 `single-projection-restore` 断言将这条要求纳入机械验收：真实 Node 进程记录参数逐项哈希，按现役公开命令的有限 flags 与位置参数分类；一次恢复须自然退出 0。两次恢复（含首次失败）、额外 projection 写入均失败；缺少参数原件或未知命令形态保持 blocked。它证明已观测的配对 CLI 调用，不声称覆盖任意 shell 或全部网络效果；独立业务读回仍不可省略。

## 验收矩阵

最终覆盖为 **45／45 个适用组合**，共 32 个场景、45 次选定的实际旅程和 98 条自然输入。普通 Pi 32 个组合，`-ns` 13 个组合。38 个采用原始通过结果，7 个采用同次封存执行的独立重析，关联 8 份修订合同回执；原失败、blocked 与旧回执仍保留，不增加模型执行。71 份选定合同回执通过现役校验。

下表显示实际 run ID 前 12 位及各自候选提交。完整运行身份、结果哈希、原失败和复验关系见[可公开覆盖清单](notion-agent-workflows-coverage-2026-11-21.json)。不同版本的结果没有被重标成最后一个提交；旧只读记录保留其当时的完成证据边界，没有补造后来才加入的 RPC 终局原件。

| 场景 | 环境 | 判定依据 | run ID 前 12 位 | Broker／CLI |
| --- | --- | --- | --- | --- |
| mixed-explicit-global | daily | 原结果 | `24692095-df7` | `7264bd42`／`cce376ed` |
| mixed-explicit-notion | daily | 原结果 | `2f8a4303-79c` | `db104fb8`／`c9035146` |
| mixed-explicit-notion | `-ns` | 原结果 | `f6825e5c-52b` | `db104fb8`／`c9035146` |
| mixed-notion-url | daily | 原结果 | `ba9188bb-79e` | `db104fb8`／`c9035146` |
| mixed-notion-url | `-ns` | 原结果 | `fb950618-5a2` | `db104fb8`／`c9035146` |
| mixed-ambiguous-source | daily | 原结果 | `786040f4-9f3` | `db104fb8`／`c9035146` |
| mixed-resource-owner | daily | 原结果 | `5728cfea-bd2` | `db104fb8`／`c9035146` |
| mixed-resource-owner | `-ns` | 原结果 | `29c84f4f-e93` | `db104fb8`／`c9035146` |
| mixed-native-slash | daily | 原结果 | `05c8c5ce-087` | `db104fb8`／`c9035146` |
| mixed-broker-explicit | daily | 封存重析 | `58ae3d1b-eaa` | `db104fb8`／`c9035146` |
| mixed-broker-explicit | `-ns` | 封存重析 | `b86ec8ee-1b0` | `db104fb8`／`c9035146` |
| mixed-pending-local | daily | 原结果 | `a1454863-903` | `db104fb8`／`c9035146` |
| mixed-unavailable-local | daily | 原结果 | `4a3e7bb4-f86` | `db104fb8`／`c9035146` |
| mixed-unavailable-required-remote | daily | 原结果 | `c885d52f-6d2` | `db104fb8`／`c9035146` |
| mixed-unavailable-required-remote | `-ns` | 原结果 | `60b54e4f-5a4` | `db104fb8`／`c9035146` |
| mixed-semantic-fit | daily | 原结果 | `29d3cccc-434` | `ff4f97a4`／`e95f8131` |
| mixed-equivalent-copies | daily | 原结果 | `71380cf1-2ce` | `db104fb8`／`c9035146` |
| mixed-complementary | daily | 原结果 | `9123309c-ab8` | `db104fb8`／`c9035146` |
| cold-maintenance-consultation | daily | 封存重析 | `74a87fdf-312` | `4db44ad6`／`c9035146` |
| cold-maintenance-consultation | `-ns` | 封存重析 | `d2ab7936-719` | `4db44ad6`／`c9035146` |
| connected-maintenance-filtered-view | daily | 原结果 | `63262cfd-111` | `303d3e2a`／`e95f8131` |
| connected-maintenance-filtered-view | `-ns` | 封存重析 | `85a65ef2-387` | `303d3e2a`／`e95f8131` |
| explicit-offline-bootstrap | daily | 原结果 | `8f151961-135` | `4db44ad6`／`c9035146` |
| lifecycle-inspect-adopt | daily | 原结果 | `f7225998-504` | `7264bd42`／`cce376ed` |
| lifecycle-inspect-adopt | `-ns` | 原结果 | `e2b3b215-131` | `db104fb8`／`c9035146` |
| lifecycle-source-switch | daily | 封存重析 | `e6c5a171-1a2` | `db104fb8`／`c9035146` |
| lifecycle-resume-fork-compact | daily | 封存重析 | `f3f4d2e5-fd4` | `0e13f85a`／`c9035146` |
| lifecycle-recovery-failure | daily | 原结果 | `cafdd825-93c` | `303d3e2a`／`e95f8131` |
| lifecycle-shared-requires | daily | 原结果 | `87130baa-76b` | `0e13f85a`／`c9035146` |
| lifecycle-enabled-default-context | daily | 原结果 | `01e048b7-f44` | `303d3e2a`／`e95f8131` |
| management-native-crud | daily | 原结果 | `c7e365c0-564` | `677404ef`／`724f9dbd` |
| management-native-crud | `-ns` | 原结果 | `2f4c8af6-a14` | `303d3e2a`／`e95f8131` |
| management-register-existing | daily | 原结果 | `0567d47a-d38` | `db104fb8`／`c9035146` |
| holdout-notion-business-layout | daily | 原结果 | `14783f24-0ec` | `db104fb8`／`c9035146` |
| holdout-notion-business-layout | `-ns` | 原结果 | `e6c0076d-df1` | `db104fb8`／`c9035146` |
| holdout-global-rephrasing | daily | 原结果 | `f3a8f68f-bfa` | `ff4f97a4`／`e95f8131` |
| holdout-native-handover | daily | 原结果 | `ee2e939e-1de` | `303d3e2a`／`e95f8131` |
| management-upstream-delete-restore | daily | 原结果 | `a00216ba-8f4` | `eea7d983`／`cce376ed` |
| management-upstream-delete-restore | `-ns` | 原结果 | `c80db9b7-048` | `677404ef`／`724f9dbd` |
| holdout-upstream-scripts-restore | daily | 原结果 | `7bf23fe7-f66` | `eea7d983`／`cce376ed` |
| management-description-flags-resource | daily | 原结果 | `84f642e4-5dc` | `303d3e2a`／`e95f8131` |
| cold-maintenance-unauthorized | daily | 原结果 | `bcb8561b-ef3` | `4db44ad6`／`c9035146` |
| cold-maintenance-unauthorized | `-ns` | 原结果 | `1c51c86f-ae8` | `4db44ad6`／`c9035146` |
| management-source-applying-resume | daily | 原结果 | `5208510f-610` | `db104fb8`／`c9035146` |
| management-source-applying-resume | `-ns` | 原结果 | `e8cadfa9-a49` | `303d3e2a`／`e95f8131` |

### 实际删除与单次恢复

| 样本与环境 | 实际 run ID | 恢复 CLI 次数与耗时 | 完整消费文件／阅读页 | 独立结果 |
| --- | --- | --- | --- | --- |
| 脚本型上游，daily | `7bf23fe7-f66c-4fa4-9f55-bab625889010` | 1 次，41.439 秒 | 18／5 | baseline 一致，无外部产品修补 |
| PDF 上游，daily | `a00216ba-8f41-4353-9964-21f7c6baeaec` | 1 次，38.899 秒 | 4／1 | baseline 一致，无外部产品修补 |
| PDF 上游，`-ns` | `c80db9b7-048e-4644-ad62-bc4e36b685b4` | 1 次，38.553 秒 | 4／1 | baseline 一致，无外部产品修补 |

耗时仅指实际恢复 CLI 进程，不包括模型发现、帮助查询、准备、独立读回或测试退场。前两行使用 Broker `eea7d98` / CLI `cce376e`；最后一行使用 `677404e` / `724f9db`，在新指南实际发布后执行。各次均先真实删除自有 Notion 阅读投影，再由一次公开恢复调用完成，随后重新消费。旧失败与新回归保持独立。

两个上游分别为 [Anthropic skill-creator](https://github.com/anthropics/skills/tree/e4bb5d960d87126ff3b3a8af1a104b7db67560ba/skills/skill-creator) 和 [OpenAI PDF](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/pdf)。PDF 的两行是同一资源形态的两个环境，不算两个不同上游。阅读筛选没有裁剪完整 Git 消费树；脚本、非 Markdown 文件及 Git 执行位另有完整读回。

### 原生 Skill 完整日常回归

发布新指南后的 daily 运行 `c7e365c0-5641-4643-b5f0-ec2f6bfb30f2` 完成八轮、75 条断言，全部通过。它依次创建原生 Skill、采用 A、局部更新为 B、只查看 B、继续使用 A、明确采用 B、删除、再按新用户指令实际删除一次。人工说明、附件和受保护对象分别读回核对；外层没有补字段、关系或清理 pending 来促成业务通过。

第一次删除包含一次 preview 和一次实际 apply，实际删除进程耗时 35.983 秒。新用户回合明确要求重复后，相同 apply 命令又实际运行一次，4.754 秒退出 0。两次目标、entry 和实际 CLI 字节一致，每轮均独立确认目标缺席、受保护对象仍在。它验证新指南允许明确的新操作请求，而不是一律禁止重复。

真实投递还区分了子工具返回与模型所见。PDF `-ns` 会话收到完整的新维护主文及操作参考；CRUD 会话收到完整的 5,300 字节维护主文，但 Code mode 只把长操作参考的前 9,000 字符送入模型。主文中的完成回执与明确新请求规则已实际送达，对应行为也通过验收；没有把子 read 拿到的完整文件冒充整份参考已经进入模型请求。

三条单次恢复合并审计的 SHA-256 为 `e879154658e21c8af28ec9a983b17320fdb9139ff4fa14640c93f2e34b62acc7`；两例指南投递审计为 `98e89f3d3d4da66c86f6076268fefbfb4efecf546e3f7f27ed0b4ac546825702`；明确重复删除审计为 `2cb29635f7a3d16b360273c53368f11d6e4fde99c043e89a11660387c850e7ad`。root 复核三份审计引用的 169 个不同原件，全部匹配。

## 失败、纠正与效率

验收分别判断业务结果、关键合同和效率。原始 session 中实际发生过失败的工具调用、无必要的只读预览和等待，不能因为随后成功而删除。第 16 批的两个先前 PDF 样本（`7f27ffab…`、`e3ba8dcc…`）在恢复前尝试过普通 `projection --dry-run`；页面已在 Trash，这些调用返回 `INVALID_SHARED_SKILL`，语义写入为零。它们没有使用 `--restore --dry-run`，不能归因为一个受支持组合失效。最终复验按各自原件另记，不沿用先前样本的调用次数或纠错路径。

单次恢复不等于一次工具调用，也不等于模型零失误。第 20 批脚本样本的恢复这一轮有 30 次实际工具派发、3 次工具错误：一次 Code mode 语法错误、一次把宿主完整 POSIX 权限与 Git mode 逐位等同比较、一次错误假设目录行都带有 sha256。随后修改的是本地比较逻辑，使用导出的 hash/role 与 Git 执行位；实际命令没有 chmod、导出内容重写或额外 Notion 产品写入。该轮 9 个 CLI 进程均正常退出，其中 1 个恢复、4 个帮助、4 个只读命令。

第 20 批 PDF daily 的恢复这一轮有 29 次实际工具派发、4 次工具错误。其中两次是已删索引上的 files 查询与未带 restore 的普通 dry-run；另两次是把 cli_source 或 working_set 与 refs 组合，被参数校验拒绝后自行拆开。该轮 11 个 CLI 进程中，1 个恢复、2 个帮助、8 个只读命令。两个样本的恢复写入均由一次公开 CLI 调用完成，独立读回确认完整 baseline 一致、externalRepair 为 false；探索和自行纠错仍有冗余，没有被报告为最短路线。

第 21 批 PDF `-ns` 的恢复这一轮有 20 次实际工具派发、15 次模型请求和 1 次工具错误。错误是 Code mode 生成了含 NUL 的 shell 参数，宿主拒绝该调用，未启动该 shell。另有一次对已删除页面的只读 files 预查返回非零；实际九个 CLI 进程为 1 个恢复、3 个帮助、5 个只读命令。随后仅执行一次恢复，未通过重复写入或外层修补完成任务。两种错误计数保留各自口径，不能把“一个工具错误”理解为所有 CLI 都退出 0。

独立验证中的日常原生 CRUD 旅程有一次 Code mode 调用错误：Agent 尝试通过并不存在的 `tools.notion_use` 成员调用工具，真实 `notion_use` 并未发出。随后改为公开工具调用并完成消费。这是实际失败尝试和自行纠错，不记成一次成功的 `notion_use`，也不改写为全程最短路线。

RPC 首个 `agent_end` 不能证明异步工具完成通知引发的后续工作已结束；相关失败催生了实际 `agent_settled` 与空闲队列屏障。一次 CI 测试自身对并发忙状态的同步也不充分，现以实际 `get_state` 忙响应为释放条件，移除了测试里的竞争窗口。产品行为与测试同步问题分别保留归因。

语义判定修订只适用于已有原件足以支持相同业务要求的情况。例如“先告诉我这个 Skill 解决什么问题、交付什么结果”是必要业务澄清。修订后的判定检查时间修饰语与同句业务主题，仍拒绝 CLI 输出目录、否定提问和无关问题。原运行、时间、配置、成本和失败结果不变，修订分析另存；它不会制造一条新的模型样本。

## 独立验证 Skill 使用评价

首次独立评估 `outer-skill-eval-01` 达到预定 45 分钟上限；内层虽已有业务输出，仍缺少所需 CLI 终局证据。该失败及实际成本完整保留，后续使用新候选、新运行复验。

独立外层 Agent `outer-skill-eval-02` 使用冻结 Broker `303d3e2`、CLI `e95f813`，在正常 HOME 和扩展下运行真实 worker/high；外层带 `-ns`，内层为不带 `-ns` 的 daily。它自行完成准备、运行、读回和自有对象退场，内层日常原生 CRUD 的八轮、75 条断言通过。外层有 61 次实际模型请求；按顶层 native 工具计 58 次，连同已观测 nested 调用计 77 次。两次入口/本地进程检查的自行纠错保留，原评价为 `passed_with_documentation_and_scratch_gaps`，没有改写为无瑕疵通过。

修正文档及临时材料机制后，`outer-skill-followup-03` 用冻结 Broker `6bdef8a`、同一 CLI 完成一次约七分钟的独立短跟进，两层均带 `-ns`。外层沿现役 `candidate-plan → candidate-run --live` 自行运行，没有猜内部预检 API；内层三次真实模型请求均包含封存的项目说明，并自行在自有临时根创建和回读 230 字节工作副本。退场后准确输入和副本仍逐字节一致、可读；该短跟进不需要额外外部 scratch 清理。891 个冻结文件与日用 settings 不变。

该短跟进的入口、项目说明和临时材料保留切片通过；其完整内层候选仍为 `blocked`。原因是外层额外选择了 `no-semantic-writes`，实际 Bash 调用的全部网络效果不在观察器证明范围内，分析器正确保留 `TOOL_EFFECTS_UNKNOWN`。没有放宽这个判据或重跑换分，也不把该切片加入 45 个组合或完整 T 验收。完整原生管理成绩由前述八轮真实旅程提供。外层与内层成本各自去重记账。

## 成本与证据保留

成本按实际模型请求和观察时钟去重，原始失败、修复后复验、独立外层与内层分别记账。重析封存会话没有新增模型执行。缺少完成响应或可用 usage 的请求保持未知，不补零、不估美元。

本次 Pi 1.6.0 的 `openai-completions` adapter 将输入、输出、缓存读取、缓存写入归一化为四项，报告总量为四项之和；reasoning 是输出的子集，不再重复相加。这个总量包含不同请求重复读取的上下文和缓存，不能当作新生成 token 量或费用。adapter 会把上游未提供的 cache 字段缺省为 0；现存账本不能再区分“上游明确为零”和“缺省为零”，因此只称 Pi 归一化计数。

### 实际 Pi 请求与工具统计

[可公开成本清单](notion-agent-workflows-cost-2026-11-21.json) 按互斥范围汇总，包含失败和复验。105 条登记记录中，103 条有实际模型请求；另两条没有启动观察器，未计成已执行模型。下表的已知 token 小计包含重复输入与缓存读取，不是新生成 token 数或费用。

| 互斥范围 | 登记记录 | 逻辑请求 | 模型 HTTP 尝试 | 实际工具派发／错误 | 已知 token 小计 |
| --- | --- | --- | --- | --- | --- |
| 自然旅程，含历史尝试 | 100 | 1,049 | 1,054 | 1,000／41 | 37,099,963 |
| 外层 Skill 独立评价 01／02 | 2 | 175 | 175 | 205／3 | 13,977,639 |
| 短跟进 03，外层与内层 | 2 | 38 | 38 | 54／0 | 1,974,132 |
| 初始集成 smoke | 1 | 6 | 6 | 4／0 | 132,516 |
| 合计 | 105 | 1,268 | 1,273 | 1,263／44 | 53,184,250 |

合计按 Pi 归一化字段分为 input 17,656,438、output 153,860、cacheRead 35,373,952、cacheWrite 0。五个逻辑请求的 usage 未知，六次模型 HTTP 尝试未能逐请求绑定，因此完整总量仍为 `null`。三个 compact 操作另报告 5,939 tokens；其 usage 是操作级信息，不能分配成每个内部 HTTP 的独立账单，未加入主请求小计。没有补零或换算美元。

自然旅程的最终选定集为 45 条、407 个逻辑请求、376 次工具派发，其中 14 次工具错误，已知小计 13,515,000 tokens。另 55 条历史尝试的已知小计为 23,584,963，二者互斥相加等于自然旅程总计。选定集仍有三次模型 HTTP 尝试未逐请求绑定，完整总量同样保持未知；该表不把通过写成零工具错误或最短路径。

私有完整成本回执 SHA-256 为 `5486ac8e7195103c7caa25165acef93c96e8209bf46ba873052b736829f4e26c`；公开白名单摘要为 `808d9f88781a835174fc87cd21b8ebed1d9d3fc0f5ddf89df02c8d579893951a`。原始 provider、native 和 thinking 正文没有进入仓库。

### 自有测试对象退场

最终清单收录 137 个登记 fixture roots，按精确 ID 或路径去重，311 个自有对象均有退场依据，其中 242 个为 Notion 测试对象、69 个为本地目录或项目临时对象。13 个外部对象单列保留，不计入删除数。登记范围没有未闭合目录、计划槽或证据缺口；原始失败、13 个同 operation 公共续行、4 个故障恢复 fixture、3 条清理首败和 16 条旧公共命令失败仍在历史中。

清单通过 22 项结构复核。root 另对 6,058 份引用原件逐项重算哈希并检查 69 个精确本地路径，均与退场依据一致。私有 `inventory.json` 的 SHA-256 为 `9e137850dddfe74618f015b1fd2115c2c5f3655d53f5303da00df85725f35884`；独立复核回执为 `2c30ced9e2f36424f0124ffadd4ee0d16cc8df4b3ff7d8a8d8ebb8d3637ae3cb`。现役 builtin 发布单独记账，不算测试对象退场。

输入、Store、oracle、原始会话和需继续使用的导出文件按计划保留。此清单不是全机临时目录扫描，也不声称用户的整个 Notion 库为空。另有三个已知设施目标的保全与 Trash 记录单列。一个早期设施红测创建了空目录，但在记录路径前失败；该目录未写入业务材料，精确路径未知，未声称已回收，也未计入成功数量。该限制的说明是后补审计，不能冒充缺失的原始日志。

## 代码与形式检查

| 层 | 已取得结果 | 精确范围 |
| --- | --- | --- |
| Broker 当前验证框架 | 403 项通过，0 skip | `677404e`，[当前 CI](https://github.com/yoyooyooo/pi-context-broker/actions/runs/44940431387)；场景、事件、分析、实际工具与进程归属、RPC 完成和现役入口 |
| Broker 当前包 | SDK 76 项、消费 407 项、Node 请求 2 项通过；typecheck/build/completion 通过 | `677404e`，同一当前 CI；发布策略另有 7 项通过 |
| CLI 当前完整检查 | 四组 Bun 均 1806 项通过；Vitest、Node 按平台与版本分别列于下表；typecheck/format/build 通过 | `724f9db`，[四组 OS/Node CI](https://github.com/yoyooyooo/notion-skills-cli/actions/runs/44940357306) |
| CLI 恢复确认回归 | 30 项通过，包含 10 个新增正反例 | 成功 untrash ACK 后的有限确认；永久缺行、冲突、不完整查询、取消和预算失败仍拒绝 |
| CLI 生命周期及请求模型 | current-lifecycle、request-engine 均通过；生命周期 7 组配置、4 组 guard mutation | `724f9db`，[形式检查](https://github.com/yoyooyooo/notion-skills-cli/actions/runs/44940357291)；页面和索引分开可见的时序由实现回归覆盖，不扩大模型证明范围 |
| CLI 日常指南 | 首次修正与当前投影共 18 项通过；限定语修正后 builtin 7 项、643 个断言通过 | `9300b93`、`724f9db`；四份构建内指南与源码字节一致，维护主文保持 5,300 字节预算 |
| Broker 显式只读使用提示 | 47 项、784 断言通过，0 skip | 只改两处提示生成函数，保留原提示长度预算；查看与采用、来源指定和权限语义分别检查 |
| Broker 单次恢复观测及判定 | 190 项通过，0 skip | 真实 Node/observer、参数哈希、命令有限分类、分析与语料 schema；两次恢复和未知参数形态不能误通过 |
| Broker 临时材料与项目上下文 | 68 项通过，0 skip | 自有目录、拒绝已有上下文/符号链接、实际注入位置和材料保留 |
| Broker 测试删除状态确认 | fixture 66 项、schema 8 项、runtime 18 项通过，共 92 项、0 skip | `eea7d98`；含 22 个新增边界检查。首次 runtime 缺少依赖的加载失败保留，冻结安装依赖后仅补跑该组 |
| Broker 有限模型 | consumer-state、observations 均通过 | `677404e`，[形式检查](https://github.com/yoyooyooo/pi-context-broker/actions/runs/44940431377)；源码摘要检查本身不扩大形式证明范围 |

| CLI 平台与 Node | Vitest | Node 独立采集测试 |
| --- | --- | --- |
| macOS 15，22.22.3 | 106 通过，0 skip | 2 通过，6 skip |
| macOS 15，24.20.0 | 106 通过，0 skip | 7 通过，1 skip |
| Ubuntu，22.22.3 | 102 通过，4 skip | 2 通过，6 skip |
| Ubuntu，24.20.0 | 102 通过，4 skip | 7 通过，1 skip |

Ubuntu 的四项 skip 是 macOS 专用的系统 Trash 与精确 compare-and-delete 测试。Node 22 跳过六项仅支持 Node 24 的旧备份只读采集场景，但实际执行版本拒绝与参数检查；Node 24 只跳过“非 24 应拒绝”的反向用例。这不是普通 CLI 不支持 Node 22。各组均为零失败，这些 skip 不计作通过。

最终报告按相关产品代码与检查范围关联每一次实际候选。不同提交上已经取得的样本保留原始 pin；不能宣称全部样本在最终 SHA 重新执行。

## 交付范围

投影恢复的验收对象是：已有受管页面被实际移入 Notion 回收站，仍有同一可消费 Source/固定版本，并以同一有效阅读策略重建。永久缺失的页面或不可恢复的作者内容、权限不足、身份冲突、未完成的其他内容操作，仍按现役合同返回明确阻断，不属于可无条件恢复的输入。

`projection --include/--exclude` 是每次调用的参数，操作完成后不会永久保存为 Skill 配置。恢复此前自定义阅读布局时须在同一恢复命令里提供相同 filters。普通未完成投影可用原 `--operation … --resume` 沿用冻结策略；`--restore` 不接受这些标志，按错误返回的原恢复命令及过滤参数继续。这与 Source 成员选择的持久声明不同。默认策略的恢复不要求用户重建三表字段、关系或逐页修补排版；人类阅读投影与完整 Git 消费树分别校验。

两仓以 `next` 为基线交付配对分支，CLI pin 为 `724f9dbddbbd9ce7128ad4c9a483110b33174122`。本次自然验收在 Pro 的真实日常环境中使用隔离候选和自有状态，保留日用配置。它不替代 [AH-1197](https://linear.app/yoyooyooo/issue/AH-1197) 的 Pro/Mini 日用安装同步与后续更新演练，也不替代 OMP、Tern 或原生 TUI 专项成绩。

原始 session、provider 请求、实际业务读回和私有配置保留在已授权的本机证据目录，不将这些私有正文上传仓库。本记录只交付实现说明、范围、运行身份和可核验的证据摘要。
