# 管理与消费验证交接

复用已有领域入口，按实际变更选择最小完整范围。每个入口拥有自己的状态和测试，不复制总验证平台。

| 变化 | 所有者 | Broker 交接条件 |
| --- | --- | --- |
| 作者正文、Files/Records、完整导入与当前 operation | CLI `.cursor/skills/verify-notion-management/SKILL.md` | 当前目录或已选内容失效，需要核对消费方刷新 |
| list/read/use、当前快照、本地固定资源、请求预算 | CLI `.cursor/skills/verify-notion-consumption/SKILL.md` | SDK 字段、缓存资格或实际正文发生变化 |
| Source 配置、成员发现与接纳 | CLI `.cursor/skills/verify-notion-source-onboarding/SKILL.md` | 成员曝光、启停、依赖或当前来源绑定变化 |
| 资格、请求顺序、固定选择、provider/turn/投影 | [consumer state](../.agents/skills/verify-notion-consumer-state/SKILL.md) | 对应 observations / consumer-state 模型与真实守卫 |
| 双仓开发隔离、CLI/SDK 配对、当前消费、独立安装包 | [integration](../.agents/skills/verify-notion-skills-integration/SKILL.md) | 隔离环境、跨仓合同或实际安装字节变化 |
| 当前 Pi adapter、目录、注入与资源实现 | [context broker](../.agents/skills/verify-context-broker/SKILL.md) | 仅验证本次选择的宿主和功能 |
| 自然用户旅程、本地/Notion 选路及日常管理 | [agent workflows](../.agents/skills/verify-notion-agent-workflows/SKILL.md) | 真实 worker 的有效 session、实际请求与独立业务读回 |

C01–C11/T01–T24、单一 owner 与实际入口由 CLI `verification/skill-domains.json` 唯一维护，使用同一配对提交的 `docs/verification-contracts.md`。当前主线为 AH-1188，旧 Done 不填作当前通过。CLI feature 归属仍在同一索引中。Broker 四项入口分别是 `.agents/skills/verify-notion-consumer-state/SKILL.md`、`.agents/skills/verify-notion-skills-integration/SKILL.md`、`.agents/skills/verify-context-broker/SKILL.md`、`.agents/skills/verify-notion-agent-workflows/SKILL.md`。

## 并行开发入口

按[隔离开发规范](isolated-development.md)使用 `scripts/paired-environment.mjs`
创建基于 `next` 的两个独立 clone 和任务分支。每次 build 生成新的私有 CLI/Broker
完整包，每次 run 使用明确的 build ID 和独立应用状态。源码可以继续编辑，旧构建
不被下一次 build 覆盖。不得在日用 CLI/Pi 指向的 checkout 重建以验证开发改动。

环境创建、构建与进程隔离由 integration 负责；它不判定自然业务场景或替代其他领域
测试。原有 candidate/daily 的正常环境要求、formal 守卫与专项 next 检查条件保持不变；
日用来源使用[独立 next 安装包](next-worktree-delivery.md)。
独立运行成功只计入实际观测的范围。远端库选择与本地隔离不能充当 API 权限沙箱。
公共入口的 Broker/原生 Pi 声明、direct/private wrapper 一致性和单 run 运行时前后
检查归 integration。Benchmark AH-1220 负责候选实际装载握手、同 episode 编排、
跨 pair/batch 的条件一致性与 invalid 判定；公共 smoke 不算真实模型比较成绩。

## 当前执行边界

当前配对只接受 SDK v3，普通消费恒零语义写入，SDK 不接收 `readOnly`。独立 Broker 包使用同一 CLI 提交构建的 current HTTP fixture，验证完整分页目录、正文与资源、身份和取消；不预植历史快照，不走退役 CLI 正文消费路径。

仅改文档路由，运行 `node --test scripts/verification-skill-routing.test.mjs` 和已有合同检查。改状态守卫，沿 consumer-state 入口核模型对应和真实反例；改消费 transport 或随包运行时，沿 integration 入口检查实际安装。跨域时执行相交的必要检查，不把一次通过扩成整个系统通过。

保留的有限模型由 observations 与 consumer-state 两套 coverage 维护。SDK capability、当前 import 的目录失效、包 pin/build 和真实 HTTP/serializer 是各自的实现检查，不因被写入 source hash 就获得形式证明。

## 结果交接

新 current 消费资格遵循当前 Source 与 Skill 的 Enabled；disabled 的当前来源不能因目录缓存或本地旧 pin 被重新启用。Default Context 随实际选定 View 决定默认候选，不 release 既有选择，也不自动注入全文。已有完整固定任务、缺字节 current acquisition 与授权拒绝分别判定；业务 Enabled 关闭不能静默拆掉原完整任务的 Required。重新启用须可信 fresh use 或新 metadata；缺行不能猜 deny。Source ready、目录完整、本地固定字节、完整正文交付、provider 接受、turn 完成和宿主公开投影必须分开判断。本地旧 pin 不承诺远端历史恢复；明确重新选择后才获取当前内容。

管理结果 partial/unknown 保持原意图和实际状态；当前读取相同不能制造原ACK。消费端失效必须绑定当前 Library root 与 operation，不按同名 Skill 猜测。模型、回执摘要和 HTTP 2xx 都不能代替实际 serializer 中的完整正文。

当前源码直接运行 `bun run check:broker`；安装直接复用 `scripts/verify-artifacts.mjs` 与 `scripts/verify-notion-sdk-installed.mjs`。实际 Pi 沿 `scripts/notion-sdk-pi.mjs` 和 `scripts/verify-pi-daily-installation.mjs` 的公开动作；`scripts/verify-pi-daily-candidate.mjs` 仅是后者导入的实现模块。旧双宿主controller及CLI fixture/UI/PTY入口已退役，没有新的包装runner。原生终端专项本轮未验收。

独立安装检查允许 npm 子进程使用本次运行显式提供的 `npm_config_cache` 公共下载缓存，以及 `HTTPS_PROXY` / `HTTP_PROXY` 中无凭据的 HTTP(S) 代理。缓存只存下载数据，安装仍从归档重新建立依赖。运行时消费检查使用空 HOME，不继承这些安装设置、用户凭据、`NODE_OPTIONS` 或 `NODE_PATH`。安装后的公开 import schema 必须使用根页面 `--library`，不得保留旧 `--entry`。

报告绑定合同/场景/run、实际命令、源码/dirty tree、loaded CLI/SDK/Broker 路径与 hash、机器/runtime、初态及原始日志 hash。复用现有 summary/result；同一原件不因多票引用重复计数。按配对 CLI 的 `verification/run-receipt.mjs` 检查薄回执；receipt-valid 只代表字段正确，不认证底层行为。failed/blocked/not_run 保留，首败和 retest_of 分开。源码测试、受控 HTTP、独立安装、真实 Notion、Pi 会话、provider/model 分别判断。安装入口不启动 Pi；真实日用沿 AH-1197/AH-637/AH-1198 验当前配对，AH-1063 只保留历史范围。OMP/Tern 延期，不作为当前 Pi 主线的默认前置。

Skill 作者执行与独立冷启动评估分开；未完成后者时标明 `instruction_evaluation:not_run`，不把结构测试称为 agent 使用成功。清理只处理本轮进程和自有绝对路径，经系统 Trash；不动用户会话、全局配置或未结清的当前 operation Store。

## 当前层级与自然任务

consumer-state 拥有 C01–C05/C07c 的观察、选择、恢复与实际闭包；integration 拥有 C10 的跨仓公共入口和实际安装；agent-workflows 拥有 C08 的自然任务与工具必要性；context-broker 保留 Pi adapter、注入和工具实现。形式化只验证声明的组合性质，不接管产品状态。

源码/真实 Store、受控 HTTP/host、独立包、live Notion+Pi+provider、natural 各自记账。自然层必须使用自然用户任务和真实模型；工具指定提示、受控 provider、observer fixture 不可填入该栏。T22 必须保留 source 可见的纯本地充分负例及必要远端正例；@local 不代表全局禁用 Notion。

复用现有回执和运行命令，只增加追溯字段。校验一个现有回执使用配对 CLI checkout：

```sh
node /absolute/current/notion-skills-cli/verification/run-receipt.mjs /absolute/owned/run/receipt.json
```

空集合不通过，关键项 failed/blocked/not_run 不可收口。普通续聊、主动最新、查看不采用、compact/manifest 失败后三轮、开关切换、多根共享依赖和两机下一次同步分别有场景 owner；不能由单次安装 smoke 代替。

## next 日用安装与工作树专项

Pro、Mini、imile-win 的日用入口使用从已合入 `next` 的精确 CLI/Broker 配对构建的独立安装包，不能指向开发 worktree。每次安装核对归档、实际入口和新普通 Pi 进程，并验证本次修改的行为，按 [next 日用安装](next-worktree-delivery.md) 执行。临时候选用 `pi -ne -e /absolute/task/extension.ts` 或现有隔离运行入口，不改全局注册。

以下命令只用于声明了工作树输入的专项检查。先在两仓目标 next worktree 分别 build，再将精确 commits 和实际 worktree roots 写入专项 config 的 `worktrees.cli` / `worktrees.broker`。CLI/Broker build 的 `dist/next-build.json` 记录真实 source 与产物身份；Broker 还核 raw CLI/SDK 及 embedded 对应。

```sh
node scripts/verify-next-worktrees.mjs --config /absolute/owned/current-pair.json
```

专项 config 的 cliRoot/brokerRoot 必须是这些 worktree 的实际 packages 路径。检查还核实际机器指纹和有界真实 origin/next；旧本地 tracking ref 不能证明当前远端。源码 dirty、HEAD 不符、旧 build/SDK 或一机落后不能 passed。双机专项仍由原 daily 入口的 `aggregate` 联合检查不同机器、同一新 delivery 的完整 version:2 回执，不能放宽守卫来接受独立安装目录。它不作为每次日用更新的必做流程；工作树检查也不能代替安装包和真实行为验证。

C10/T21 的 entrypoints.required_inputs 列出各动作必需配置。`/absolute/owned/` 是占位路径，不能直接当成已运行命令。daily-installation 的 plan/candidate-plan 只生成准备信息；run 检查当前日用装载，aggregate 只收口两机装载与 metadata，candidate-run --live 是项目级候选运行。各自范围见 [日用地图](../.agents/skills/verify-notion-skills-integration/features/daily-installation-ui.md)。帮助输出和 import 模块退出 0 都不能记为场景通过。

## 自然用户旅程

[工作流验证 Skill](../.agents/skills/verify-notion-agent-workflows/SKILL.md) 是自然输入、真实 Agent 选路和管理闭环的唯一入口，数据正本为 `scripts/notion-agent-scenarios.json`。它沿同一 candidate-plan / candidate-run --live，使用 `scope:notion-agent-workflow`；不新增宿主驱动或证据平台。`scripts/notion-agent-scenarios.mjs` 校验长期语料与私有绑定，fixtures 准备真实对象，analysis 关联 session、实际请求和独立读回。CLI 写入与内部多表关系仍由原管理入口实现。

普通 daily 保留全局本地与 Notion 的日常混合环境；no-native-skills 只添加 -ns，不表示 Broker local 或显式路径消失。两种正式环境都固定真实 magpie/group/worker。按场景前提选择适用 profile，不能将原生命令计数当成目标可见性，也不能靠关闭 Notion source 获得零误用。

默认产品维护和 Source 同步分别用 `cold-maintenance-consultation`、`cold-source-sync-consultation` 核对实际配对 Builtin；fixture 不放官方 Notion 副本，包内正文不预加载。`connected-maintenance-filtered-view` 与 `cold-maintenance-unauthorized` 则明确选择 Notion 团队流程，核对精确来源、inspect/use 及失败不切换。指导来源不决定写入 source/ENTRY，普通业务发现、Pi 中零已启用 Notion source 的本地会话和既有选择保持原合同。

`native-onboarding` 是同一 candidate-plan / candidate-run 路由的空父页适配。它要求 `pairedEnvironment` 的 packed build、授权 `parent`、显式模型配置和环境变量名；不接受已有 `database`、日用 package 注册或预制 fixture。主体只收到公开 README/help/bootstrap、业务任务和空父页，一个 run 内连续完成。integration 负责冻结的 archive/installed 入口、`--pi-mode native` 与空 `--native-skills` 的共同声明；agent-workflows 负责真实请求/session/CLI 关联和另一个 fresh run 中显式 entry 的主文及所有支持文件读回。正文和文件判据保存于 controller-only oracle。进程成功、运行有效性和业务成功分别报告，漂移或未知状态不得通过。没有唯一 entry、超时或不明写入先对账，不能据此声称远端没有副作用。该 profile 不改变 daily/no-native-skills 或严格 next gate。

普通续聊保持原进程；发布新版、restart/resume、fork、compact 和故障各有有限事件与真实完成屏障。公开用户文本不携带私有 oracle、工具名或修复路线。只读查看与采用分别断言；失败的 notion_use 也计入实际尝试，已有完整正文允许复用。输出正确不抵消错误来源、混版、缺依赖、管理残留或外部扫尾。

自然验收的 provider 证明按实际 API 区分请求和终态，工具参数转换按实际宿主与 schema 区分原始值和执行值。Responses、嵌套 codemode 和有限目录枚举的证据边界见[当前模型与工具证据](../.agents/skills/verify-notion-agent-workflows/references/running.md#当前模型与工具证据)。这些观察器补充不改变正常模型、工具配置或 Source operation；缺失原件的旧回执继续保留原状态。

每个自然 case 是所声明 C/T 的明确切片。checkAgentContractCoverage 从配对 CLI 单一索引检查映射；一个真实运行可被多个 T 薄回执引用，详细 scope 放原始证据，不能重复计成本或将局部通过扩成整个 T。必选组合、留出输入、首败、复验与独立 Skill 使用评价分别保留。

每次逐场景结果保留在对应 Issue/PR 的运行证据中，绑定实际候选并保留首失败与修订解释。多机日用安装按 [安装合同](next-worktree-delivery.md) 核对；声明双机工作树专项时单独保留其原始结果。

## Benchmark 分支的当前源码与历史证据

当前共享产品与验证代码已同步到 next 的 SDK v3 / Library root 合同。Benchmark 的候选装载、episode 编排和证据重分析由 [Benchmark 运行入口](benchmark-running.md) 负责。旧实验的 SDK v2 产品、材料、构建和运行记录继续按其冻结身份解释，不因共享源码同步而迁移。

`reanalysis` 使用新的分析实现读取旧原件，不重新执行产品或准备远端 fixture。首次使用新配对进行 live 比较前，必须按所选旅程完成 `--entry` / `--database` 到 `--library` 的 fixture 适配和实际装载验证；当前同步与离线评分修复不证明这项 live 接入已通过。
