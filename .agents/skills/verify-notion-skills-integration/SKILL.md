---
name: verify-notion-skills-integration
description: "验证双仓开发隔离、配对 CLI/SDK 与 Broker 的消费合同、完整目录、资源和独立安装包。修改隔离入口、Notion source、随包运行时或消费边界时使用；Benchmark 候选回归、模型筛查和证据重分析转专用入口；live Notion、真模型与两机 next 日用沿 AH-1197/AH-637/AH-1198 验收。"
---

# Verify Notion Skills Integration

## 范围和交接

只验证从当前 `next` 演进的单轨。开发使用隔离任务分支；正式日用使用精确 `next` 配对构建的独立安装包，不指向开发 worktree。复用现有检查和安装入口，不新增总验证 runner。
OMP/Tern 延期；不恢复 `source.command`、CLI 正文消费、完整 export 回退或旧 snapshot reader。
[验证交接表](../../../docs/verification-routing.md) 指定 CLI 管理、消费、来源接手与 Broker 的负责人。
本 Skill 检查跨仓消费和安装包，不复制作者操作验收。自然用户旅程、混合来源选路与日常管理闭环交给 [工作流验证 Skill](../verify-notion-agent-workflows/SKILL.md)。当前feature地图直接指向现役SDK、安装与实际Pi入口。

项目级自然旅程沿工作流入口 candidate-plan → candidate-run：plan 校验输入与合同，run 在启动 Pi 前自动核对所选 CLI/SDK 与随包产物身份。无需为这条路径自行导入预检函数或执行正式双机交付；单独诊断包边界时才使用下文的现有检查。

### Benchmark 候选与证据

比较环境版本、筛查配置中的新模型、运行回归或重算旧证据时，先读
[Benchmark 运行入口](../../../docs/benchmark-running.md)。在独立双仓环境选择明确 build，
复用已登记的 setup/plan；沿 `node benchmark/cli.mjs configure` 做零模型装载核对并冻结计划，
再按授权类型选择执行入口。用户已持续授权后续相关批次并取消资源上限时，读
[持续授权入口](../../../docs/benchmark-standing-campaign.md)，用 `setup.standing` 绑定真实授权、
科学工作计划和独立账本，再用 `run-standing` 执行。`--slice` 只控制检查点频率；
不添加累计请求、token、费用、批次或时间上限，也不要求逐批批准。新增科学条件或修复
使用新模板、计划和尝试身份，沿用同一授权。历史有界计划仍用 `run` 保留原合同。
用 `status` 和 `journey` 独立回读结果；`analyze` 重算既有规范化证据，
观察或判定修正用 `reanalysis` 从原件重新适配与评分，两者均不调用模型。
实际参数以同一构建的 `--help` 为准，不手工维护远端表关系或改日用配置。

Benchmark 专用变更合入小写 `benchmark`；共享产品和隔离修复先合入 `next` 再吸收。
保留每次 invalid、预算停止、unknown、失败及成本；中断执行先对账，不覆盖或盲重跑。
同一证据重分析不增加样本；行为变化另起 retest 身份。付费运行使用已冻结的科学计划，
按实际授权执行；工作计划的样本数不构成持续授权的额度。不建定时付费任务。
原生/Broker 的实际装载、私有判定未注入、关键原件和业务回读分别确认；
没有完整证据就保留 unknown，不能用旧功能验收替代模型比较。
本入口负责找到隔离与 Benchmark 流程，日用 `next` 的双机和真实入口检查继续按原合同执行。

## 0. 准备和核对隔离环境

先读[隔离开发规范](../../../docs/isolated-development.md)，沿
`scripts/paired-environment.mjs create / build / check / run` 的公开入口工作。
create 只建立两个独立 clone 和任务分支，不安装依赖；不要在日用 CLI/Pi 指向的目录
重建，也不要改全局 package 注册、配置或凭据。源码可继续编辑；每次 build 按 Git
文件清单复制 tracked 与 nonignored untracked 源码，在该 generation 的 snapshot
内安装依赖，再生成完整私有配对。并行 build 不共享 source node_modules。
build.json 的 source_tree 封存完整源码与已安装依赖；check 同时核对它和 runtime 包。
run 必须明确选择 build ID，不能靠 `latest` 猜测。默认 command run 先把两个源码
snapshot 与依赖复制到自己的 run/source；`--cwd cli|broker` 及 PAIRED_CLI_SOURCE /
PAIRED_BROKER_SOURCE 指向本 run 副本，默认 workspace 为 run 自有目录。
command 可修改自己的副本，不能改 build 内冻结目录；CLI/Pi 纯运行不复制源码。
只消费冻结运行时的 controller 显式选 `--command-source none`，只允许 workspace cwd，
不得收到 PAIRED_CLI_SOURCE / PAIRED_BROKER_SOURCE 或源码验证绑定，也不产生 run/source。
复核 run.json.command_source、真实 CLI/Pi wrapper、私有状态及 frozen artifacts；源码修改测试
继续用默认 copy，并保留并发修改一份副本不会影响另一份或 build 的负例。
create/build/run 在写入前读取环境及所有祖先的 capacity-policy.json，合并明确指定 policy，取更严格的限制。
按目标卷可用量和实际复制长度核对预算；clone/install 总量未知时保留 unknown，低于主机复核线
须先审查并提供总增量估计。不得下调政策绕过拒绝。保留 capacity.json 与首次失败，
安装及启动前复核不构成并发容量预留，ENOSPC 仍须保留原始错误和已有状态。

首次初始化候选使用 `build --install-mode packed`。该模式沿现有 npm pack / 空 consumer install 合同，复用 daily 的 archive-to-installed 字节核对，并比较打包前源码产物。检查 build.json.candidate 的 package/version、archive、实际 bin/SDK/Broker entry、完整 installed 与 archive inventory。run 的直接入口和私有 wrapper 必须选同一安装候选；冻结后不能改 wrapper、包或依赖来绕过检查。默认 directory build 不变。针对这一选择运行 scripts/paired-environment.test.mjs 的实际归档安装与篡改反例。

修改隔离机制时，实际创建两个环境并检查 Git 元数据与目录互不共享；核对 create
没有安装依赖，各 generation 的源码、依赖、完整产物目录独立，build 记录原仓 HEAD、
snapshot 指纹、完整 source_tree 与 runtime 清单。构建后修改一边源码并生成新 build，
核对旧 build 与另一环境字节不变。同 build 启动两个 command run，修改一份 run
源码或依赖，核对另一 run 与冻结 build 不变。分别运行已选 CLI/Pi 或明确 command，
读回真实入口、退出和自有证据。重复 build/run ID 必须拒绝覆盖.
具体命令和通过范围以规范及当前 `--help` 为准。

隔离机制按规范执行两层检查：`node --test scripts/paired-capacity.test.mjs scripts/paired-environment.test.mjs scripts/paired-runtime-identity.test.mjs`
检查实际子进程、启动声明和运行时反例；`scripts/paired-environment.smoke.mjs` 接收两个独立环境和明确 build ID，
执行两个真实 CLI，以及两环境 × Broker/原生模式 × direct/private wrapper 的八个真实 Pi。
受控 provider 必须收到所选 Skill 完整正文，排除另一环境和未选择的发现 canary；
实际观察 Pi 的 argv/settings、命令、工具及独立状态。原生侧必须没有 Broker 注册，
显式 root 的原生命令与 reader 可用。读取首个环境 proofs/唯一目录中的 smoke.json 及原件；失败保留
failure.json。smoke 不访问 Notion 或真模型，不能记作自然 onboarding 或日用通过。

stdin 默认 ignore；RPC 或显式管道输入必须传 `--stdin inherit`，交互结束时关闭输入。
Node/Pi/Bun/Git 使用统一维护的机器基础环境，不为任务另装旧版；每个 run 在实际子进程环境
中前后观察版本、选定入口和声明范围的文件身份，实际 Node 使用本次启动脚本的 `process.execPath`。升级共享基础环境不要求
重建任务 clone，也不引入任务专用版本管理；按本次实际 runtime 解释验证结果。
每个 run 核对 config/state/cache/data、`NTN_SKILLS_SCHEDULER_ROOT`、Pi agent
目录、session、显式复制的 Skills 和 TMPDIR。默认 `--pi-mode broker` 的 `--skills`
只供 Broker discovery。`--pi-mode native --native-skills ABS_DIR` 复制所选 root，
经 Pi 原生 `--skill` 加载并启用 Skill 命令，实际不加载 Broker。两模式保留 `-ns`，
不改本地原件；共同观察器用可重复的 `--pi-extension ABS_ENTRY` 显式声明。
direct 与 private wrapper 复用 `pi-launch.json` 的同一固定 argv/settings，后置资源和会话覆盖拒绝。
HOME 保持不变；CLI wrapper 仅影响子进程树。
回读 run.runtime 与 result.runtime_check 的 before/after/changes/unknown；unchanged、drifted、
unknown 分开。运行时不完整或漂移时整体失败，command_status/exit_code/timed_out 和 stdout/stderr
仍保留原值。选定 Node/Bun/Git 文件、Pi entry/manifest/可选 runtime module 和私有 wrappers 的
端点检查不等于完整安装冻结，不证明任意 command 的子进程身份。跨 pair/batch 判断、实际
资源装载握手和任务请求前阻断归 Benchmark AH-1220；公共 run 不代判业务成功。
凭据变量只通过显式 `--pass-env NAME` 传入，models 的 apiKey 只能引用环境变量名。
build 如需既有网络代理，同样显式按名称传入；代理的既有 CA 文件可通过
`--pass-env NODE_EXTRA_CA_CERTS` 传入绝对路径，不能传 NODE_OPTIONS 或关闭 TLS 校验。
不默认继承，回执仅记录变量名。
无远端选择时核对 Notion token 不继承且 sources 为空，不能只看目录名推断隔离。
launcher 的 `--library ROOT` 记录 root scope、设置 `PAIRED_NOTION_LIBRARY`，
配置 Broker `source.library`，并在本 run 私有 CLI config 写 `{default_library: ROOT}`。
`--parent OUTER_PAGE` 只记录授权外层容器并设置 `PAIRED_NOTION_PARENT`，不自动建库；
无 Library 选择时私有 CLI config 是 `{}`，不能把唯一 Source 当作默认库。
CLI target 和私有 wrapper 原样传递参数。消费和管理使用 `--library ROOT`，
例如 `ctl library init --library ROOT` 只读 attach，`ctl library inspect --library ROOT`
只读核验；`ctl library init --parent OUTER_PAGE` 才创建专属 root 及其直属四表。
裸 `list` 读取该 run 的 `default_library`；显式 `--library` 覆盖本次选择。
只有明确 `list --all` 才跨库发现，且不能据此声称 workspace-exhaustive。
用 NTN_SKILLS_BUILD_ENTRY 指定真实配套 CLI 运行环境测试，核对 direct/wrapper 的消费
与管理参数；缺少该输入时 real CLI 子测试 skipped，不能把 fixture argv 检查当成通过。
明确 Library root/parent 不缩小 API 权限；同 token 仍受共享远端限流.
只记录凭据是否存在，不输出内容。结束后复核未改变日用来源与全局配置。

隔离 smoke 不等于自然旅程或正常日用验收。不要为让任务分支通过而放宽
`verify-next-worktrees.mjs` 的 branch、clean、真实远端和构建检查，也不要绕过
candidate/daily 对正常 HOME、agentDir 与配置的要求。现有 candidate 入口的明确 native-onboarding profile 单独使用隔离初态，交给工作流 Skill 判自然业务结果；它不满足 daily 的正常环境要求。

## 1. 绑定同一份 CLI/SDK

先确认两个仓库的实际提交及未提交改动。选择最终 CLI 提交构建出的完整 CLI/SDK 包，
可以使用 `package:check` 已独立安装的包，或依赖齐全的 checkout 中 `bun run build` 产物。
打包目录本身未安装依赖时，不能直接作为 Broker 的构建入口；先核对已安装包与归档的字节一致。
CI 和 publish 的 CLI pin 必须指向同一完整 commit；不要用发布版或另一工作树代替候选。
Pro/Mini/imile-win 的日用更新按 [next 安装合同](../../../docs/next-worktree-delivery.md) 核所选提交、归档、独立安装字节、普通入口及新 Pi 进程，并验证本次修改的用户行为。临时验证用 `-ne -e` 或现有隔离 run，不改日用注册。只有明确执行历史工作树专项时，才使用原 `aggregate` 联合核验不同机器、同一新 delivery 的两份 version:2 回执；该检查的守卫不放宽，也不要求每次日用更新都跑它。固定路径、旧回执或 source/build-only 均不能证明当前实际装载。
以下命令从 Broker 根目录执行。CLI 路径属于选定的完整包，decoder 源码属于同一提交：

```sh
export NTN_SKILLS_BUILD_ENTRY=/absolute/current/notion-skills-cli/packages/cli/dist/ntn-skills.js
export CONTEXT_BROKER_GRAPH_CORE=/absolute/current/notion-skills-cli/packages/core/src
node scripts/skill-consumption-contract.mjs check-gates
```

`CONTEXT_BROKER_GRAPH_CORE` 让完整 manifest 负例经过真实 SDK decoder；未设时会 skip，不能算通过。
只接受 SDK v3、SKILL_REF_VERSION=2 和完整必需 capability。构建检查 runtime manifest 与实际 CLI/SDK bundle hash。
子进程删除 `NTN_SKILLS_DEV_ROOT`，不能赋空值；不得继承开发 shim 绕过所选包。

## 2. 按变化做当前消费检查

本轮配对使用这四个现有文件和类型检查：

```sh
bun run typecheck
bun test packages/context-broker/scripts/notion-source-sdk.test.ts packages/context-broker/scripts/shared-notion-adapter.test.ts packages/context-broker/scripts/catalog-cache.test.ts packages/context-broker/scripts/notion-entry.test.ts
```

核对完整分页目录、稳定 File 绑定与精确 owner/scope；目录完整不等于正文已下载或已投递。
发现阶段只取目录，按实际选择获取完整正文/资源；不截断正文或省略文件来减少请求。
普通消费恒为零语义写入。旧 `readOnly` 参数应在 I/O 前拒绝，不能恢复隐藏写入分支。
保留缓存年龄、凭据/Store 隔离、取消和迟到结果的 guard；失败不能延长 TTL 或发布不完整目录。
缓存、TTL、库选择、启动/SDK 调用次序或会话复用变化，必须按 [缓存地图](features/session-cache-recovery.md#新进程复用)
执行 `http-warm-restart` 和 `http-warm-directory-expired`。前者核整个暖阶段零 HTTP，后者允许到期目录刷新但正文 consume 零 HTTP；两者都核新 PID/session、原 snapshot/校验时间和实际 provider 全文。SDK、安装包或助手单测通过不能代填这些实际 Pi 结果。
`selectLibrary` 只读取本地配置，须在零 Notion I/O 下捕获本轮 root；`resolveLibrary`
另行检查真实 root、完整 children、四 DB/DS 的 parent/schema/relations。fixture 必须
独立声明这些物理事实，不能用待测 descriptor 反推。root children 读取仍计实际 body
请求；不能将它改标 metadata 掩盖请求，也不能因此放开 Skill/File 正文读取。
Broker 每次 input 重读本地默认，已接纳 turn、固定 ref 和 CLI 写后回执保留原绑定。
显式 `$name@source` 可选择其他已配置 Source；无 `@source` 名称只查当前默认库。
只有相关语义改变才扩到现有对应测试；完整 CI 使用 `bun run check:broker`，不要重复跑相同范围。

## 3. 验证实际安装包

用同一提交的 CLI 源码生成新的 current HTTP fixture，输出目录必须属于本轮且未被旧结果占用：

```sh
node /absolute/current/notion-skills-cli/scripts/sdk-fixture.ts --outdir /absolute/new/current-fixture --catalog
node scripts/verify-artifacts.mjs --fixture /absolute/new/current-fixture/fixture.json --source-http-helper /absolute/current/notion-skills-cli/scripts/sdk-source-fixture.mjs
```

保留第 1 步的环境。入口自行执行 broker-only build/pack 和独立临时安装，无须另跑 pack。
它复用 `scripts/verify-notion-sdk-installed.mjs`，不预植 snapshot/cache，不运行旧多根 fixture。
核对分页目录、完整 Files、主文、warm cache、use、标量/批量资源、错误 owner/scope 与两处取消。
安装包同时检查 runtime 版本/hash、随包资源、消费 schema 和 `ctl library import` 必需参数。
内嵌 CLI 的 `skills list/get/path` 必须从安装包离线提供目录、原始 Markdown、JSON、完整支持文件和匹配字节的实际路径；`skills` 默认列目录，包读取不得创建独立安装状态。退役命令的 schema 必须失败，不能保留独立安装生命周期。
所选 CLI 的完整 THIRD_PARTY_NOTICES.md 必须按原始字节包含在 Broker dist/NOTICES.txt 中；检查冻结原件 hash、安装包中的完整内容及产物 inventory，不能只匹配依赖名称或版权关键词。
读取本次 `manifest.json`、`commands.json`、`current-sdk/result.json` 与 HTTP 账本；不能只看退出码。
确认普通消费语义写入为零、CLI 正文读取子进程为零，且实际加载的是所选包的 CLI/SDK 字节。
该入口只在自有临时目录安装 loader 依赖，不启动真实 Pi 会话，也不更改现有日用安装。

## 4. 区分通过范围

源码检查通过，只证明所执行的当前消费回归；安装包通过，只证明独立包与受控 HTTP 服务的交互。
Source ready、目录完整、本地有文件、正文已交付、当前 turn 成功必须分别判断。
隔离 smoke 只记录本次实际 Pi 进程与受控 provider 交互；真实 Notion、真模型和日用安装保留 `not_run`，直到本次 AH-1197/AH-637/AH-1198 对当前配对实际执行。
AH-1197 核两机实际 next 与持续同步，AH-637 独立验证 Mini，AH-1198 核当前真实时间线的配置、provider/serializer 正文、资源读取、恢复与取消。AH-1063 只保留历史范围。
不能用旧安装、旧回执、模拟 HTTP 或一次 read 代替真实日用成功；OMP/Tern 仍记为延期。

## 5. Formal 和文档改动

沿用[形式化维护合同](../../../docs/formal-verification-maintenance.md)，先审阅当前实现、模型和受保护 guard 的对应关系。
旧 SHA gate 未通过时如实记录阻断；不得自动刷新 hash 放行，也不由旧图或旧结果宣称当前性质已验证。
当前保留 observations 与 consumer-state，两套由 [consumer-state Skill](../verify-notion-consumer-state/SKILL.md) 维护。只复验受影响且已建立当前映射的模型；SDK capability、import 失效和实际包仍由实现检查负责。不要恢复旧 flows 或运行 legacy feature 全图。
仅修改本入口或验证路由，运行现有检查：

```sh
node --test scripts/verification-skill-routing.test.mjs scripts/skill-consumption-contract.test.mjs
```

## 6. 输入和清理边界

只用明确拥有的绝对输入/输出路径；保留原输入、失败结果和未结清的当前 operation Store。
验证不能改全局配置、用户凭据或日用安装，也不能上传未选择的本地 Skill 内容。
不要重置用户缓存来制造冷读成功；需要空客户端时使用独立临时根，并记录实际缓存状态。
清理只处理本轮进程和自有 scratch，经系统 Trash 使用绝对路径；不永久删除、不批量杀用户进程。
缺少所需输入、能力或安全清理方式时报告具体阻断，不静默缩小覆盖，不伪造成功。

## 当前合同和运行回执

按上文的验证交接使用配对 CLI 的合同/场景索引与薄回执。记录 actual command、源码/dirty tree、实际加载路径/bytes、机器/runtime、初态、层级和原件 hash；首次失败与复验关系保留。fixture 或受控 provider 不作为 live/natural；结构检查不代表独立 Agent 使用成功，未做时标 instruction_evaluation:not_run。
