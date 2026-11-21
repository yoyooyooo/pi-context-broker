---
name: verify-notion-agent-workflows
description: "用真实 Pi 和 magpie/group/worker 验证自然用户怎样发现、选择、消费和管理 Notion Skills，覆盖日常全局本地共存、-ns 对照、多轮换版与恢复、原生 CRUD 和上游投影恢复。修改 Agent 提示词、builtin 指南、工具选路或这些日常工作流后使用；通过现役候选入口运行自然旅程并分析 session、实际请求和业务读回。"
---

# Verify Notion Agent Workflows

## 选定负责范围

先读[验证交接表](../../../docs/verification-routing.md)。本入口负责 C08 自然工作流和 Agent 行为；沿现役候选入口验证 C01–C07 的实际用户表现。CLI 字段、关系和 writer 由管理领域负责；状态实现归 consumer-state，配对安装归 integration。使用配对 CLI 的 verification/skill-domains.json 和 docs/verification-contracts.md，不建立第二合同索引。

只用当前 next。正式模型固定为真实 magpie/group/worker、thinking high。将普通 Pi 的 daily 作为主环境：保留真实 HOME、全局与项目 Skills、正常扩展和 MCP。no-native-skills 只增加 -ns；它不清除 Broker local 或显式可读文件。不得用 -ne、显式预加载 maintain、工具指定提示或受控 provider 代填自然结果。

## 选择最小充分旅程

场景正本是 scripts/notion-agent-scenarios.json，由 scripts/notion-agent-scenarios.mjs 校验。仅阅读或选择本次相关场景及配方；完整覆盖时选择全部 required 场景及各自适用 profile，再选择对应留出输入。

| 改动 | 至少选择的旅程 |
| --- | --- |
| 目录、描述、同名选路或提示词 | mixed-explicit-global、mixed-explicit-notion；再选对应 URL、歧义、语义匹配、等价、互补或原生 slash 场景 |
| 冷启动、builtin 维护说明 | cold-maintenance-consultation、connected-maintenance-filtered-view；明确离线诉求另跑 explicit-offline-bootstrap |
| 版本、支持文件、会话恢复 | lifecycle-inspect-adopt；再选依赖共享、来源切换、fork/compact/resume 或故障后三轮 |
| 原生管理 | management-native-crud、management-register-existing、management-description-flags-resource |
| 上游投影与完整资源树 | management-upstream-delete-restore、management-source-applying-resume；再跑 holdout-upstream-scripts-restore |
| 全批验收 | selectAgentScenarios(corpus, {selection:'required'}) 的全部适用组合及对应 holdout；未运行项不能汇总通过 |

holdout- 前缀是保留到修复后使用的输入；它们改变业务材料组织、资源路径、内容格式或上游仓库。不要先用留出输入调提示词。离线检查是明确来源诉求的独立分支，不能替代远端可见的本地充分负例，也不证明两机日用安装。

## 冻结真实环境与输入

按[准备与运行](references/running.md)创建自有 fixture、绑定和候选配置。candidate-plan 校验语料、绑定和合同；candidate-run 在启动 Pi 前自动验证所选 CLI/SDK、构建产物和实际加载字节，并记录源码身份。沿这两个现役入口执行，无需自行导入内部预检函数。独立包诊断另由 [integration](../verify-notion-skills-integration/SKILL.md) 负责。保留用户日用配置；新状态与故障只作用于本轮拥有的路径或对象。全局本地场景使用真实全局 Skill 目录，不能拿 --skill 或项目文件冒充。普通同名负例的远端目标必须在模型实际目录可见；原生命令数量大于零不能证明目标已被发现。

保持三个边界：

1. 长期语料只存自然旅程和准备配方；运行时才产生实际名称、路径、Notion 身份、版本和原件哈希。
2. 验证 Agent 可读全部配置与私有判据；被测 Pi 只收到自然 prompt、用户本来会给的材料以及正常产品上下文。不得预加载本验证 Skill、正确工具路线或私有事实。
3. 输出、原始 session、实际 provider 请求与业务读回单独保存。薄回执沿用现有 raw_evidence；不新增证据平台。

正文预冻结只供外层观测，不预植被测 Pi 缓存。未来 B 的真实 snapshot 在发布并读回之后取得，不从预期正文推造。

## 执行现役入口

从 Broker 根目录执行；配置中的绝对路径必须是本轮真实文件：

    node scripts/verify-pi-daily-installation.mjs candidate-plan --config /absolute/owned/workflow-config.json
    node scripts/verify-pi-daily-installation.mjs candidate-run --config /absolute/owned/workflow-config.json --live

配置使用 scope:"notion-agent-workflow"。一次执行一个场景/profile，沿同一公开入口选择完整语料；不建立另一个总 runner。计划只表示输入可准备，不是模型成绩。

让运行器等待每轮模型与工具真正结束，再执行声明的 before 事件并独立读回，之后提交下一条原始自然输入。普通继续不重启 Pi；restart、fork 和 compact 必须各有真实 RPC 与 session 证据。fork.turn 指从那条用户输入**之前**分叉，不能误算成保留该轮之后的状态。

已启动的真实运行交给一次有界等待或宿主等待循环收集终局，避免每次短轮询都再次调用模型。预先留出准备、逐轮 CLI 网络预算、分析和清理时间；中途短等待返回不表示任务完成，不因此杀进程、重复写入或悄悄延长已声明的总预算。

短旅程的 compact 可声明 keepRecentTokens，运行器只在自有项目设置该保留预算，并在计划中记录差异；仍由真实 Pi 和模型完成压缩。一个会话只能声明一种预算。不得添加无关对话凑 token、写入假 compaction 条目或修改日用全局设置。观察器随真实 fork 重绑同一进程，保留连续编号和原始哈希链。

A/B 旅程依次为：采用 A → 外部发布 B 并读回 → 普通继续 A → 只看 B → 再继续 A → 明确采用完整 B。发布是外部事件，不伪装成一轮模型回答。澄清回复必须是语料中预写的业务信息；不得临时补工具名、flag、opaque ref 或修复命令救场。

不支持的事件、错误版本、缺绑定、未触发的时序前提和 transport 观测缺口都必须显露。目录 pending 场景须证明真实首次请求早于目录完成；已经 ready 的运行不填作 pending 成绩。

Store 故障先用同一固定 snapshot 的公开离线读取证明正文可读，再隔离本轮 Store，并证明同一读取出现 STATE_UNAVAILABLE。重启后的实际 SDK 目录也必须以同一错误终结；取消、未开始或其他错误不能代替故障前提。恢复时再用同一读取核验正文与身份。只移走 manifest 仍可能从 SQLite 合法恢复，不能据此宣称不可恢复状态已命中。

## 判定当前实际行为

阅读本次分析结果及其原件，不只看退出码。沿 scripts/notion-agent-analysis.mjs 关联有效 session 分支、工具调用与结果、当前请求、provider 完成和独立业务读回。

- 将存在、原生发现、模型可见、读取、选择、当前实际交付、provider 完成和业务成功分开。历史 active、prepared、短引用登记和模型自述均不能代替当前正文。
- 比较逻辑 owner、scope、snapshot/version 与资源路径；Notion 来源可以合法使用 Git 或缓存中的字节，同 hash 不代表同 owner。Required 闭包须完整，Members 不自动变为必需。
- tool-attempts 统计实际失败和撤回尝试。显式本地且材料充分的负例要求不必要 notion_use 为零；后台目录请求和控制端事件分别记账。
- selection-any 只允许声明的等价身份；显式来源和管理目标不能互换。正文已在当前有效上下文时允许复用，不强迫重复 list/read/use。
- 管理结果需独立读回关系、正文、资源及保护对象。投影恢复比较稳定逻辑语义，允许重建页面 ID 与审计时间变化；人类阅读筛选不得裁剪完整 Git 消费树。
- 启停、权限、Source applying、partial 及恢复故障不能通过旧本地副本、清 pending 或包内 fallback 掩盖。故障后三轮普通交流仍应能到达模型。

分别给出业务完成、硬合同和效率/自行纠错。错误来源、混版、缺 Required、只读写入或外部扫尾都是硬失败，不能被最后一句正确措辞抵消。未知 metric 不填零；未覆盖的 CLI 子进程效果不能称为已完整观测。

## 修复与复验

先保存首败原件，再按失败归属修产品或文档：环境身份、发现/注入、模型选路、CLI、版本/恢复、真实结果。禁止按这批 Skill 名称、当前页面 ID 或标准答案写特判。

同一输入先跑一次基线。修复后用新自有状态复验受影响旅程，设置 retestOf 指向原失败，再跑对应未用过的 holdout。同一无法解释的失败连续出现两次时停止重试，先定位原因；不得不断抽样到一次成功就覆盖首败。仅扩测仍有具体风险的范围，不做维度全排列。

结构/路由检查与独立 Agent 使用评估分开。作者实跑不等于独立冷启动；后者未做时记录 instruction_evaluation:not_run。独立评估者只取得任务、本 Skill 和必要工具配置，通过同一入口完成实际工作，其真实模型、调用链与结果另留原件。AH-1198 汇总最终评价，必选 failed/blocked/not_run 不能完成主线。

## 清理与交付

命令声称完成后若还需控制端补字段、补关系、清 pending 或删残留，该场景失败。既定 fixture teardown 只负责回收测试对象，不修补产品结果。

先依据运行回执确认被测进程退出，再调用 fixture 的公开清理函数；已有 builtin 为外部只读对象，不在清理范围。清理函数回收自有 Notion 对象，将自有全局或项目 Skill 目录移到系统 Trash。本轮输入、oracle、Store、项目配置和临时材料保留在证据根，尤其不能丢掉未知或失败 operation 继续执行所需的输入。运行器将 TMPDIR 绑定到 ownership 声明的 temporary 目录，并通过自有项目的原生 AGENTS.md 说明 shell 显式模板及保留约定。路径、说明哈希和保留策略写入回执；这是记录在案的环境约定，不是文件系统沙箱。按约定产生的材料随证据保留，无需另扫系统临时目录或编写本地扫尾脚本。不得重置用户缓存、会话或并行 writer。

报告实际执行的场景/profile、候选身份、修复和复验关系，以及仍缺的证据。每个自然 case 是它所声明 C/T 的明确切片；同一原始运行可被多张薄回执引用，但不得重复计成本，不能因某个切片通过就宣称整个 T 或整批通过。

新 Skill/路由或语料变动后运行对应 scripts/notion-agent-scenarios.test.mjs、scripts/verification-skill-routing.test.mjs 与既有合同检查；真实 Agent 结论仍由本次实跑产生。
