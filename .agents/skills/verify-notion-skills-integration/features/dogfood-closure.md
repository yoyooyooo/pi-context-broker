# AH-955 实施与证据合同

目标是同一真实 Skill 从 Notion 管理，经正式 CLI、来源请求与缓存、Pi/Context Broker 到实际模型输入的完整日用路径。父票与 12 个子票以 Linear 当前正文为准。

## 固定起点与写入边界

- CLI 基线 ca8cc946a662c486fee2817007d13763c3a57c0f；Broker 基线 1c11c57849f97d2c13b82eb8a62fe6b6065741c4。
- 每个并行实施者使用自己的 Git worktree、分支和证据子目录；主仓当前暂存文件与旧工作区不改。
- Core/SDK 的效果语义由 AH-953 的 CLI 实施者定义；Broker 投影由主代理消费该类型。先共享具体接口，再接线，避免各自定义近似字段。
- AH-922/AH-740 负责 create/import 的原操作恢复。读取原 operation、已 ACK 页面和原输入，受审阅后沿同一个 operation 继续；不补建同名对象、不重放未知写。
- AH-956 负责独立臂与正常臂的真实基线和既有观察器适配。验证器改动保持原 oracle 与失败材料，不为通过更改输入答案。
- 真实服务使用既有认证和明确自有验证库。原用户会话、生产业务 Skill 与未授权数据不修改。只读计划与实际写入分开留证。
- root 统一更新 Linear 状态与 Notion 长期文档，子代理提交可复查代码、精确命令、原件索引与未决范围。

## 实施顺序

首批 AH-956、AH-953、AH-922、AH-740 可独立推进。AH-511 在两个恢复边界稳定后交付正式作者链；AH-623 在基线后独立完成目录候选对照；AH-631 再测作者阶段请求复用，AH-506 测长期派生增长；AH-639 进行真实自主任务，AH-734 进行真正 Notion UI 操作，AH-638 汇总完整任务结果。AH-925 的冷资源失败有界排查并保留原反例，不阻塞无因果关系的实现，不得被遗漏或虚报已解决。

## 真实 Pi 验收

- 固定 magpie/group/worker 和当前约定的 thinking；保留实际 provider/model 标识及 model_change。
- 独立臂使用 pi -p -ns，正常臂保留原 native Skills、扩展、MCP 和安全规则。-ns 是否真的隔离本地 Skill，由实际请求内容与工具调用证明。
- 保留真实 argv、cwd、HOME、包/源码身份、来源与 credential scope 的非秘密身份、正文/Requires/reference 版本、缓存初态与验证时间。
- 不向 consumer 提供 oracle、预期答案或目标叶子 ref。oracle 在独立审计端使用。
- 逐次审计原生 JSONL、toolCallId/参数/结果/错误/撤回、owner/scope/snapshot/File ID、完整正文 hash 和实际 provider payload。
- 管理写、retention、metadata、正文、缓存命中与其他扩展网络分别计量。unknown 不填 0，不把 exit0、HTTP200、ready 或模型自述单独判为通过。
- 对工具或请求并发用真实起止时间核对；session 插入顺序不作为因果证明。
- 当前消费允许的历史留存与作者修改分开披露；明确零远端写时，在实际写前执行无写边界。

## 形式化与长期文档

先更新既有验证地图和能检测旧行为的反例，再改实现。维护现有 TLA+、正负 cfg、Statechart、coverage 和实际代码重放；未影响模型语义时写明复用理由。模型不证明任意 LLM 选路或任意服务并发。旧失败、原会话和原证据不改判。

每个切片完成时，由 root 同步 Notion Project 下受影响的长期页，记录性质、反例、有限边界、精确源码与复跑命令并全文读回。Git 保存可执行规格与脚本，Linear 保存实际验收结论。

## 验证与交付

### AH-953 消费效果合同

CLI/SDK 的 version-1 `effects` 描述本次消费：`remote_writes` 为 none、retained 或 unknown；作者正文状态、Skill/File/operation 与确认状态单列。Broker 的 `notion_use`、标量 `read` 与 Pi `$`/native 注入必须把这份最小回执交给实际 provider，原正文和来源证明 span 保持完整。旧生产者缺字段归 unknown；多来源部分失败仍包含先前效果。严格 `readOnly` 先核对 SDK 与构建 manifest 能力，再由原请求层在首个语义写前拒绝，不能静默降级。批量固定资源仍使用原 immutable 合同。

源代码回归覆盖投影缺字段、严格请求、不兼容生产者零调用、失败后的部分效果、原生正文/资源回执和 `$` 注入的原生历史。形式化复用 `verification/models/consumer-observations/flows` 的13个配置；原六个 availability/race 配置单独复跑。新增只读与未知 ACK 负配置必须分别击中对应性质；旧“零写”反例保留，模型不能证明任意 LLM 报告正确。实际 Pi 必须再验当前留存、稳定固定读取、严格拒绝及最终回答；未执行时不得关闭 AH-953。

独立审阅的两个确定反例并入既有 `host-prepare.test.ts`：`$` 多源预加载中首源已经留存、后源拒绝时，调用级回执必须保留首源 Skill/File/operation，后源缺效果仍为 unknown；native read 在本地准备提交后、实际文件读取前取消，仍须拒绝读取并保留本次留存回执，不能附加晚到的正文证明。取消交错用提交后的 `queueMicrotask`，不靠 sleep 或重复压力。修订沿原 accumulator 与失败出口接线，不增加远端查询、自然语言解析或新的效果协议。固定资源校验失败保持保守 unknown。复跑 `bun test packages/context-broker/scripts/host-prepare.test.ts packages/context-broker/scripts/scalar-resource-read-host.test.ts packages/context-broker/scripts/pi-read-adapter.test.ts` 与 typecheck；红例、绿例和实际源码身份分别保留。

该切片证据位于 `verification-evidence/ah955-20261111/ah953-partial-cancel-fix`：两正式红例先失败，目标集随后 67/67 通过；当前 `build:broker` 内的 typecheck 与既有 `input-guard.test.ts` 通过。新工作区第一次输入守卫因尚无随包 CLI 报 `HOST_CLI_UNAVAILABLE`，保留原日志，显式构建 CLI 输入后复跑通过。原冻结 statechart/TLC 的 flows 13 配置全部匹配预期，其中八个历史/负配置仍命中规定性质；未扩展或重解释其状态空间。这些源码和有限模型结果不替代真实 Pi、自然只读意图与最终披露复验。

2026-11-11 候选真实负例 `ah953-20261111-real-uUH0q5/notion-only-strict-fresh-cKJIB1`：模型没有按自然“不写入”要求传 `readOnly`，实际发生六次 retention 写入。effects 已出现在 provider 输入，最终回答却只说作者内容未修改，未主动披露历史写入。两处原工具说明现明确把用户只读/无写要求映射到 `readOnly:true`，并要求最终说明 retained/unknown；没有新增常驻指南、查询或工具。此改动不改变状态机、严格写边界或原文 span，因此沿用模型正负配置，不能用有限模型代替新的自然任务真实复验。原失败会话和请求保留，显式参数正测与自然语言遵从分别判断。

后续错误封装复核又复现三个直接红例：`notion_use` 与 `$` 接收冻结的 SourceError，native read 接收真实 DOMException AbortError。旧出口修改原错误的只读 message/details 会抛 TypeError 并丢失 effects。三处现在新建错误回执并保留 cause、来源错误类型/code/source/exitCode/details；DOMException 保留名称和数字 code，不修改原错误。权限、写边界、取消、提交和正文交付均未改变。`readonly-error-envelope-{red,green,typecheck}.log` 保留三项原失败、48 项宿主通过及类型检查；模型不枚举 JavaScript 错误属性，因此同步双 coverage 的语义审阅和源码绑定，复用既有未改 TLA/cfg/view 结果，不宣称本次重跑。

复用 .agents/skills/verify-notion-skills-integration、verify-context-broker 和 CLI 的 .cursor/skills/verify-ntn-skills。补丁先有能失败的直接反例，再跑必要回归及真实链路；不重复展开无关完整矩阵。每个交接包含 commit、文件列表、命令、exit/进程终局、原始输出和仍未覆盖的门槛。

### AH-623 当前目录身份与策略

2026-11-11 的同源完整目录为 303 条，Default View 为 74 条。历史 25 个 `notion_page` 引用逐个匹配当前同一物理 page/database/data source 的唯一 enabled `shared_skill` 身份；数量来自本次 SDK 原件，不以名称推断。旧引用的精确当前兼容必须保留配置 namespace、credential scope、完整物理 locator、kind 与 canonical main 检查；同页多身份、来源失败、disabled、不同数据库、旧固定 snapshot 都不可猜。返回目录改用当前 canonical identity/ref，未选正文调用仍为零。`remote-catalog.test.ts` 先保留旧解析失败，再覆盖这些正反例；真实 doctor 与实际 Router 选择另验，不能由单测推定。

现有紧凑完整目录与当前已存在的 root-only View 分开比较；窄 View 是候选管理策略，不是权限收缩。名称/描述发现、View 外精确 ref、分页和目录六态保持既有回归。两条超限本地声明按实际文件另审，不提高全局大小限制或截断作者正文。此项是当前目录身份归一化，未新增消费代际、取消或否决状态；既有 Availability/ReadRace 语义保持，不新建近似状态模型。

本次记录的303条真实元数据在候选解析器逐一重放，25/25对应正确当前身份，额外HTTP与正文读取为零；这份元数据重放不冒充真实doctor。历史两个超限声明指向同一taste-skill路径，该本地SKILL.md今日已不存在；Agent Kit既有handoff将该精确路径映射到Notion页4065636c-236e-81cd-9730-ec4b548e90c4，当前目录中存在唯一enabled共享身份。实际配置是否仍保留旧声明、以及正式配置修正仍须独立复查，不能按历史大小声称今日超限或凭同名迁移。原件为`verification-evidence/ah623-20261111-daily-tnQiE9/catalog-identity-{red.log,green.log,typecheck.log,current-replay.json}`。

不永久删除文件，不用 git reset --hard、git clean 或批量 restore。临时材料通过系统 Trash 回收，原始证据和未知操作保持。日用最终继续现有 CLI shim/NTN_SKILLS_DEV_ROOT 与 Broker 源入口，不新增发行目录或第二套缓存系统。

### AH-623 / AH-639 / AH-638 日用 View 配对实验

本次仅在 `runCandidatePrint` 增加显式 `viewId`，映射原 source 的 `default_view_id`，以及复用原五文件 owned Ticket 项目。不同库不得隐式继承旧 View；同库显式选择现有 View，不修改远端 View 或权限。正常臂保留 HOME、69 native commands、原 packages/MCP/安全设置，23 条已证实失效声明仅使用原已审阅进程 overlay。`-ns` 单独记录为策略差异，不能加算成 View 收益。

首轮前冻结固定 worker/high、同一 CLI/Broker/嵌 SDK/包哈希、任务全文、source scope、缓存空起点、tool exposure、成功门槛、预算与顺序。至少三对同一 C 原句冷运行比较原 Default View 与既有 poteto 单根 View，顺序宽窄、窄宽、宽窄；一个独立留出任务不参与调优。A/B 复用原 `frozenPrompt`，模型读取真实项目并生成完整 Skill 文件；私有 oracle 与审阅材料留在项目外。C、setup-pstack、多 Skill 介绍、D 无 `$` 名称/自然任务/闲聊按意图验收，不强迫执行工作流。

每次运行事后独立核对原生 JSONL、实际模型/thinking、toolCallId、pin/File ID、完整正文和资源 hash、provider payload 与 wire hash。所有失败和未运行留在冻结分母。报告逐轮累计输入/usage、模型与工具轮数、source metadata/body/retention 请求与字节；未观测保持 unknown。明确效果、完整性或只读红线失败时不推荐候选，不能只凭首轮目录字节减少宣称改善。源码候选不证明全局日用激活、Notion UI 或物理 Mini。

生成产物继续走 `retainGeneratedPlan` 和独立 `exerciseReviewedGeneratedHelper`，先审完整 bytes/hash，再复制到独立 owned 项目执行一个真实生成的 Node helper，最后按原 Evidence→系统 Trash→Evidence 合同核对。现有 npm test 不能代替生成 helper 执行。本次驱动参数接线不改变消费 availability/race、效果与 pin 状态语义，沿用现有 TLA+/正负 cfg；source coverage 仅增加实际测试/证据对应，不虚构新的模型证明。

A v2 的另一个独立产品反例是 `read({ paths: [三个已签发 sr:R], readOnly: true })` 被 adapter 拒绝，而公开 schema 同时声明两字段。修复先维护 SC07 地图与精确红例，贯通 adapter、host、source 与已有 SDK 能力守卫。严格只读参数不得丢弃，非法类型和不兼容 SDK 必须在 I/O 前拒绝，既有资源身份与整段正文回执仍验证。旧 SDK 批读没有效果字段时保守 unknown，不由固定引用或作者内容未变推出零写。原 A 会话、timeout 和未生成产物继续保留，本次代码回归不改判它；固定资源 immutable 合同、模型状态与冻结真实包均保持。

首个 A 独立臂真实调用 `ls -la && pwd && find . -maxdepth 3 -type d -o -type f | head -200`，只枚举 owned 项目。正常 Pi 指引要求用 bash 做文件枚举，而旧 print guard 把任何 bash 都算脚本执行。原任务禁止运行项目，并未禁止了解其文件；原样本仍保留旧 harness 的失败，不重标为通过。独立驱动修订仅对 `project: owned-ticket-service` 承认固定 cwd 中有限的 `pwd`、`ls`、有深度/输出上限的 `find` 组合；不解释通用 shell，不准内容搜索、外部路径、替换/重定向、项目或 CLI 执行。原 graph guard 没有可复用的 shell 白名单，因此沿用同一 Pi `tool_call` 阻断边界和五文件项目，不复制旧 graph runner。被动原件仍记 `executionTool: true`，另记 hash 绑定的目录检查，报告脚本执行与目录检查两个数量。此修订在新工作区冻结，只重验项目路线；C 的 View 对照继续原冻结驱动。任意其他 bash 在执行前拒绝，normal HOME/工具 schema 不改。正反例覆盖 changed cwd、外部 Skill 路径、substitution、redirection、第四个命令、超限 find/head 与 npm/node/CLI。

### 已留存的失败、独立校准与 how-only 试点

证据根为 `/Users/yoyo/Documents/code/personal/verification-evidence/ah623-639-638-20261111-daily`。所有已结束样本独立读取 native JSONL、完整工具参数/结果、来源 SDK trace 和实际 provider payload/wire，保留 `independent-observation-audit.json` 与 `timing-and-phase-accounting.json`。未完成响应的整任务 usage 为 unknown；已结束响应只能合计为下界。

| 样本 | 实际终局 | 范围与保留原因 |
| --- | --- | --- |
| 原 A，`notion-only-A-notion-only-P8hFML` | failed，602.069秒 | 11工具、3请求、342059 B；正确自主选叶与完整读取不等于完成产物。旧 verifier 另把目录枚举计作禁止的执行；600秒内也没有完整 final，不能只归因为 harness。 |
| A inventory 修订，`notion-only-A-notion-only-project-v2-o6OHOD` | failed，601.401秒 | 15工具、7请求、1053437 B；原枚举已有精确 owned-cwd/hash 回执。`read({paths:[3个sr:R],readOnly:true})` 被宿主参数判定拒绝；后续三个 scalar read 不能把整任务改为通过。另一条 `python3 -c` 仅计算80/81字符长度，被 guard 在执行前阻断，不误称业务执行。无完整产物，暂停第三次 A。 |
| 原 C，`normal-pair1-C-baseline-opQInj` | failed，602.084秒 | 介绍任务读取 how 后扫描 agent 安装、委派并超时；child 已完成且独立保留原件/成本。原6个C的分母为1 failed、5 not_run，两个 heldout 也未运行。 |
| 原 D-chat，`notion-only-D-chat-notion-only-ulzkDV` | failed，controller stop，340.595秒 | 原句含“今天一起把手头的工作做完”，具有续接意图；0工具门槛不适合作为纯闲聊判断。首请求无三个记忆 Skill 正文，模型依据既有目录/standing guidance 自主 use；不修改全局记忆规则。原 normal 对照保持 not_run。 |
| 新独立问候校准“你好。”两臂 | passed | `-ns` 与 normal69 都是1请求、0工具、0 Skill正文。分别89323/124536 B、30.305/39.003秒；不是原D失败的替代，也不是纯Broker净开销对照。 |
| how-only C，`normal-how-v2-pair1-C-baseline-VXMXOR` | passed，独立试点，128.570秒 | 3请求、2 scalar read、526684 B；poteto、unslop、create 与 README 完整，3550 B final 只介绍，无脚本或委派。两版 how 正文在全部 payload 都是0，因此不能把通过因果归于 how 改文。 |

how 作者原件经公开 read/dry-run 审阅后由 root 一次公开 write 并原生完整读回，只有新增意图入口；native3290 B SHA `d225b0f007dd4d0c09f80e2e74bb2182bcd95a22bfe05a38b05bcf9ba4c74b6c`，consumer3622 B SHA `584998e556c1e44c5b747c80d7359de1b7283d547f6780d6f1fb1663315c897a`，pin `s_ce34a81d7f078bb80c7c1f389e47ed27d260f0c7c21a923b3bfae43267c8bb6b`。所有原规则、native链接、元数据、Members/Requires和参考字节均保留。poteto候选因公开 write plan 的64KiB限制未应用，原拒绝保留。

`how-v2-formal-series-paused.json`（SHA `c1932bcb29906a6594fff46d82064e38a986a85dd2f5cf20be310be43cdb326b`）把已启动的1个通过样本单列试点，其余5个C与2个heldout不启动。该旧检查点的正式三对及留出样本等待同一个 batch只读修复版重新冻结；不把新旧runtime跨版本相减，不把较少首轮目录当作完整任务收益。当时没有完成的可比View对，也没有生成helper实驱成功，窄View尚无采用证据。源码和有限模型不能替代这些门槛。

### 最终 v3 的 View 裁决与 AH-623 发现验收

共同 freeze `653f19f2be8bda096f9f58e041bfebaa6af34e6a9f606e0510980bbf68eac249` 的两个 C 对子均完成介绍任务。宽/窄两侧完整授权目录304条深比较相同，默认曝光74/1；宽侧50条描述省略均对应同次实际 provider 中完整同身份卡，正常69个native Skills保留。第一对输入749959/674889 B、耗时219392.32475/267739.550791 ms；第二对346247/857903 B、160695.65/282578.64225 ms。仅两对就使三次中位数的最小回退达22.036881%，超过原20%门槛，无论第三次取值都无法采用窄View。保留宽baseline，C3 narrow与heldout narrow保持not_run及原16冷配置分母；完成的C3 baseline不补成第三个对子。独立证明 `reviews/e2e-final-v3-two-pair-rejection-bound.json` SHA256 `fe781bde70927d5f4a878be55247439a1058f3fe8d0eef40f415b14e23f6fda3`。

原D-natural独立臂的用户句子完全没有Skill名称/handle；首请求仅默认目录，模型复制唯一create-verification-skill候选ref并以readOnly:true use。第二请求完整6,837 B主文，第三请求完整2,761/3,374/4,023 B参考，同owner/scope/pin/version/File ID与实际wire一致；阶段内5个已闭合SDK为25metadata/5body/0write。独立阶段报告 `reviews/e2e-final-v3-D-natural-discovery-phase-review.json` SHA256 `5ff27d9dd72b6cfa15a6e1b39315454066201c319e0cd4b76c82c5c28deb1164`；root再核6个日志前缀、3个实际payload/wire及完整正文，`root-D-natural-discovery-readback.json` SHA256 `8f8364acf8d95a64efaa23ebba182b2ae54ec36d3f20d732e122df8873b0883e`。这闭合AH-623无名称发现项，不把阶段通过改成AH-639整任务通过。

23条失效声明的受审候选、正常doctor和公开find pstack 5/5保持；全局入口激活仍归AH-638。setup留出技术/10项覆盖通过但有两处解释偏差；A两臂、B两臂及D-natural独立臂的超时/无产物失败原样保留。warm观察器与模型对自动metadata的推断边界见成本地图，原warm failed不改判。完整生成产物及helper实驱未满足，AH-639/AH-638继续开放；AH-623可按六条既有验收关闭，未引入额外发现平台或模型。

