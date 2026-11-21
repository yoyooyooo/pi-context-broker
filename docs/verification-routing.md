# 管理与消费验证交接

复用已有领域入口，按实际变更选择最小完整范围。每个入口拥有自己的状态和测试，不复制总验证平台。

| 变化 | 所有者 | Broker 交接条件 |
| --- | --- | --- |
| 作者正文、Files/Records、完整导入与当前 operation | CLI `.cursor/skills/verify-notion-management/SKILL.md` | 当前目录或已选内容失效，需要核对消费方刷新 |
| list/read/use、当前快照、本地固定资源、请求预算 | CLI `.cursor/skills/verify-notion-consumption/SKILL.md` | SDK 字段、缓存资格或实际正文发生变化 |
| Source 配置、成员发现与接纳 | CLI `.cursor/skills/verify-notion-source-onboarding/SKILL.md` | 成员曝光、启停、依赖或当前来源绑定变化 |
| 资格、请求顺序、固定选择、provider/turn/投影 | [consumer state](../.agents/skills/verify-notion-consumer-state/SKILL.md) | 对应 observations / consumer-state 模型与真实守卫 |
| CLI/SDK 配对、当前消费、独立安装包 | [integration](../.agents/skills/verify-notion-skills-integration/SKILL.md) | 跨仓合同或实际安装字节变化 |
| 当前 Pi adapter、目录、注入与资源实现 | [context broker](../.agents/skills/verify-context-broker/SKILL.md) | 仅验证本次选择的宿主和功能 |
| 自然用户旅程、本地/Notion 选路及日常管理 | [agent workflows](../.agents/skills/verify-notion-agent-workflows/SKILL.md) | 真实 worker 的有效 session、实际请求与独立业务读回 |

C01–C11/T01–T23、单一 owner 与实际入口由 CLI `verification/skill-domains.json` 唯一维护，使用同一配对提交的 `docs/verification-contracts.md`。当前主线为 AH-1188，旧 Done 不填作当前通过。CLI feature 归属仍在同一索引中。Broker 四项入口分别是 `.agents/skills/verify-notion-consumer-state/SKILL.md`、`.agents/skills/verify-notion-skills-integration/SKILL.md`、`.agents/skills/verify-context-broker/SKILL.md`、`.agents/skills/verify-notion-agent-workflows/SKILL.md`。

## 当前执行边界

当前配对只接受 SDK v2，普通消费恒零语义写入，SDK 不接收 `readOnly`。独立 Broker 包使用同一 CLI 提交构建的 current HTTP fixture，验证完整分页目录、正文与资源、身份和取消；不预植历史快照，不走退役 CLI 正文消费路径。

仅改文档路由，运行 `node --test scripts/verification-skill-routing.test.mjs` 和已有合同检查。改状态守卫，沿 consumer-state 入口核模型对应和真实反例；改消费 transport 或随包运行时，沿 integration 入口检查实际安装。跨域时执行相交的必要检查，不把一次通过扩成整个系统通过。

保留的有限模型由 observations 与 consumer-state 两套 coverage 维护。SDK capability、当前 import 的目录失效、包 pin/build 和真实 HTTP/serializer 是各自的实现检查，不因被写入 source hash 就获得形式证明。

## 结果交接

新 current 消费资格遵循当前 Source 与 Skill 的 Enabled；disabled 的当前来源不能因目录缓存或本地旧 pin 被重新启用。Default Context 随实际选定 View 决定默认候选，不 release 既有选择，也不自动注入全文。已有完整固定任务、缺字节 current acquisition 与授权拒绝分别判定；业务 Enabled 关闭不能静默拆掉原完整任务的 Required。重新启用须可信 fresh use 或新 metadata；缺行不能猜 deny。Source ready、目录完整、本地固定字节、完整正文交付、provider 接受、turn 完成和宿主公开投影必须分开判断。本地旧 pin 不承诺远端历史恢复；明确重新选择后才获取当前内容。

管理结果 partial/unknown 保持原意图和实际状态；当前读取相同不能制造原ACK。消费端失效必须绑定当前 library/entry 与 operation，不按同名 Skill 猜测。模型、回执摘要和 HTTP 2xx 都不能代替实际 serializer 中的完整正文。

当前源码直接运行 `bun run check:broker`；安装直接复用 `scripts/verify-artifacts.mjs` 与 `scripts/verify-notion-sdk-installed.mjs`。实际 Pi 沿 `scripts/notion-sdk-pi.mjs` 和 `scripts/verify-pi-daily-installation.mjs` 的公开动作；`scripts/verify-pi-daily-candidate.mjs` 仅是后者导入的实现模块。旧双宿主controller及CLI fixture/UI/PTY入口已退役，没有新的包装runner。原生终端专项本轮未验收。

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

## next worktree 日用链

先在两仓目标 next worktree 分别 build，再将精确 commits 和实际 worktree roots 写入本轮日用 config 的 `worktrees.cli` / `worktrees.broker`。CLI/Broker build 的 `dist/next-build.json` 记录真实 source 与产物身份；Broker 还核 raw CLI/SDK 及 embedded 对应。

```sh
node scripts/verify-next-worktrees.mjs --config /absolute/owned/current-pair.json
```

config 的 cliRoot/brokerRoot 必须是这些 worktree 的实际 packages 路径。检查还核实际机器指纹和有界真实 origin/next；旧本地 tracking ref 不能证明当前远端。检查通过后使用原有 daily installation/candidate 入口，运行前后都核对同一配对。源码 dirty、HEAD 不符、旧 build/SDK 或一机落后不能 passed。这里不执行常驻自更新，也不保留旧包兼容模式。独立 package 安装继续单独验，不因 worktree smoke 通过而省略；两机日用完成必须由原 daily 入口的 `aggregate` 联合检查不同机器、同一新 delivery 的完整 version:2 日用回执，按 [next 工作树交付](next-worktree-delivery.md) 执行。

C10/T21 的 entrypoints.required_inputs 列出各动作必需配置。`/absolute/owned/` 是占位路径，不能直接当成已运行命令。daily-installation 的 plan/candidate-plan 只生成准备信息；run 检查当前日用装载，aggregate 只收口两机装载与 metadata，candidate-run --live 是项目级候选运行。各自范围见 [日用地图](../.agents/skills/verify-notion-skills-integration/features/daily-installation-ui.md)。帮助输出和 import 模块退出 0 都不能记为场景通过。

## 自然用户旅程

[工作流验证 Skill](../.agents/skills/verify-notion-agent-workflows/SKILL.md) 是自然输入、真实 Agent 选路和管理闭环的唯一入口，数据正本为 `scripts/notion-agent-scenarios.json`。它沿同一 candidate-plan / candidate-run --live，使用 `scope:notion-agent-workflow`；不新增宿主驱动或证据平台。`scripts/notion-agent-scenarios.mjs` 校验长期语料与私有绑定，fixtures 准备真实对象，analysis 关联 session、实际请求和独立读回。CLI 写入与内部多表关系仍由原管理入口实现。

普通 daily 保留全局本地与 Notion 的日常混合环境；no-native-skills 只添加 -ns，不表示 Broker local 或显式路径消失。两种正式环境都固定真实 magpie/group/worker。按场景前提选择适用 profile，不能将原生命令计数当成目标可见性，也不能靠关闭 Notion source 获得零误用。

普通续聊保持原进程；发布新版、restart/resume、fork、compact 和故障各有有限事件与真实完成屏障。公开用户文本不携带私有 oracle、工具名或修复路线。只读查看与采用分别断言；失败的 notion_use 也计入实际尝试，已有完整正文允许复用。输出正确不抵消错误来源、混版、缺依赖、管理残留或外部扫尾。

每个自然 case 是所声明 C/T 的明确切片。checkAgentContractCoverage 从配对 CLI 单一索引检查映射；一个真实运行可被多个 T 薄回执引用，详细 scope 放原始证据，不能重复计成本或将局部通过扩成整个 T。必选组合、留出输入、首败、复验与独立 Skill 使用评价分别保留。
