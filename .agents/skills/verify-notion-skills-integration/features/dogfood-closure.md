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

首批 AH-956、AH-953、AH-922、AH-740 可独立推进。AH-511 在两个恢复边界稳定后交付正式作者链；AH-623 在基线后独立完成目录候选对照；AH-631 再测作者阶段请求复用，AH-506 测长期派生增长；AH-639 进行真实自主任务，AH-638 汇总完整任务结果。用户已明确把 AH-734 本轮管理入口改为 Devspace Pro 上正式 ntn CLI，不再要求浏览器登录；历史 UI not_run 不算通过。AH-925 已按有限调查和诊断交付完成，旧本地 host admission 因果仍未知；保留原反例与重开条件，不把等待未来同类失败变成无期限前置。

## 当前全局入口与收口范围

正式Pi remove/install已将第19槽切到`pi-context-broker-d5a49b33/packages/context-broker`，正常新进程唯一加载实际39ad源码；其他19包、非packages设置及69 native Skills的name/source path/order保持。原CLI shim的`NTN_SKILLS_DEV_ROOT`已切到`notion-skills-cli-cfe89f88`，FF到`ee4e712`后fresh Shell实际help仍核到新的原操作恢复参数。根目录和旧目录未清除，无main merge/npm发布。全局切换回执SHA `fa4b840307742c8216ac1d03c12b8c3c125631abb3885142fa7fa6aa26b2965a`，69项独立读回SHA `7594b5b3fb7dd22eae8581e80586e07509eb96e3fe82d21fe46a88cb4bde3ad8`；源码head、独立包、嵌9b03运行时与实际模型输入分开绑定。

正常doctor的Namespace仍failed：精确23个外部本地ENOENT与原受审退役清单相同，公开find pstack实际5/5正确。Agent Kit PR964候选尚未main/live source admission；不要把受审overlay通过写成已部署，也不要与已完成的CLI/Broker激活混同。原自动doctor gate不接受这些local ENOENT，不声称该gate通过；有限范围独审SHA `79ea5fd610115699dbe400e0689c9d0db85c05300fa9ae16b95d044ab482f165`确认无新增Notion主线身份故障，不扩成fleet部署前置。

AH734的正式ntn编辑、取消与原Source恢复保持同一owner/FileID；实际两臂固定新旧版本消费见本skill的`skill-consumption.md`，root完整native/provider/SDK复核SHA `4095dfc891a3f3ac1e16a18d55772366edfa5208f2950ae3f93e6f3fa9d57051`。CLI `ee4e712`修复原计划ID在正文dispatch前的持久回执以及旧processing/null反馈恢复；原source-run暂停和original applied事实独立保留，只有真实原操作reconcile/全文读回才能闭合反馈。六个原生成失败及唯一A cap失败仍缺产物和独立实驱；AH639和依赖的AH638不因此完成，也不把外部模型未完成升格为唯一根因已定位。

实际反馈恢复已通过正常全局CLI完成：先dry-run核原`body-write-follow-a9b3…b8aa`及完整提交/来源/事件事实，再一次reconcile发布`verified_applied / ORIGINAL_VERIFIED`。正式ntn全文读回表明只有Management Receipt/Result改变，原生正文仍为SHA `e52cd60661c304240d1f61dbd1afb6c836da74adf6c4d433a68e9154d11c8fca`；公开request读回一致，再次reconcile为unchanged/remote_writes0。原正文操作未重派发，body_writes0；metadata反馈原操作为`source-op-40e801a058cc5275ba242fcf07161698c993f994879a214512a677323b0b9413`。主审`ah734-cli-replacement/39-management-closure-readback.json`为9,833 B、SHA `9b93c69b310cb4099dd72bc9d5170fbb9650bb5c8a64ede6a5ced33ab6460732`；编号21的原命令暂停结果保留，不改成原run成功。管理CLI完整HTTP细分未独立采集，不以命令数补造请求数。

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

当次23条失效声明的受审overlay、正常doctor和公开find pstack 5/5证据保持；Agent Kit候选仍待独立admission，当前CLI/Broker全局激活已按上方原件另验。最终16冷配置为8个technical passed、6个failed、2个窄侧not_run。已完成介绍中6份准确；setup留出覆盖全部10项但有两处解释偏差，D-named独立臂另把作者flag误推为运行时限制、把坐标偏好写成禁令，正常臂准确通过。A/B/D-natural两臂共6个任务均超时且无完整产物；完整正文和真实项目输入不能替代交付。独立strict batch协议通过，原warm failed不改判，A资源续问因没有合格产物保持not_run。终局原件索引为`final-v3-terminal-index.json`（SHA `928f4b1e738db8f76a9f9ae2ee8b7544f23fb64353f9a5c6ea7e47966769e55e`）；全部真实模型失败usage保持unknown，已完响应只计下界。完整生成产物及helper实驱未满足，AH-639/AH-638继续开放；AH-623按独立发现验收判断，未引入额外发现平台或模型。

### 已保留失败的 v4 空 cwd 接线

原print续问对旧cwd的包映射做deepEqual，换候选包路径会在启动Pi前拒绝；`warm-v4-resume-contract-red.json`保留真实旧入口拒绝，0个Pi/model/source请求。默认续问继续保留该保护。仅显式`isolateResumeCwd`允许已独审、成功单轮的纯介绍换到新的空owned cwd：原任务不得有owned项目、执行或项目枚举，原native精确hash与只读来源工具须通过，原cwd只能有`.pi/settings.json`且包映射绑定原结果。原result/native/settings均不修改，结束后再次核hash；新的cwd与包映射明确记录，原owned Store继续复用，实际自动metadata按账本记录。

初版27项回归通过后，真实C1准入揭示历史参数假设过严：原7个read均未传readOnly，但完整配对结果都有version1/none/unchanged/空retention。初版拒绝保留，不重写原7次调用。准入改为检查实际已闭合效果回执，缺失、unknown、retained、retention矛盾或isError均拒绝；只读目录查询按既有metadata语义单列。新增无flag但none正例和有flag却坏回执反例，`verify-pi-daily-resume.test.mjs`与原candidate测试现共28项通过，真实C1离线准入也通过，原result/native/settings前后hash相等；这些预检没有启动Pi/model/source。

边界同时覆盖原默认拒绝、项目/失败/已续问/执行型父任务、额外文件、错误settings和native前缀漂移。纯介绍语义由既有C1完整独审与本次冻结调用合同确定，不声称helper能自动理解任意任务。该驱动接线不改产品状态机或源码覆盖的有限转移；不新增TLA模型、不把回归通过当成v4真实通过。v4按新driver commit与原39ad包双身份单独冻结一次，沿原成功C1前缀，不带旧failed warm追加；新cwd属于条件变化，不能据此作同条件性能比较或回填v3分母。

唯一v4终局为failed：实际host仍加载af7030f2，payload只有811 B旧guidance。新observer已恢复9份完整收据，不等于39ad产品指导通过；最终例子另有像素/性能排他句的准确性缺口。`final-v4-C-warm-summary.json`（SHA `204b070f55865d6608078d10254bcbff27436e709390e55c28235749b07bd232`）与两份独审完整保留。已安装Pi实际bundle证实`--session`取header.cwd再建project settings，spawn新cwd不能覆盖它；只读因果见`reviews/v4-autoload-causal-review.json`（SHA `2c85be78958ddfe05404cd7491011ca9276721d5ca718305d877b355121a53ae`）。旧`isolateResumeCwd`现于I/O/模型前拒绝，不能继续静默发送错误候选。

### 已审纯介绍的公开 native fork

v5当次显式`forkIntroductionResume`仅供已独审C1纯介绍正常臂，保留原effects准入、无owned项目和固定非slash原题。默认resume继续原settings deepEqual与copy/`--session`。新分支复用Pi公开`--fork`原C1绝对路径，复用原Store，另记新header/cwd/包映射；原C1的150条非header历史453156 B、SHA `c6633549425dfb8d2f4cf8d97291e39c4ce66599d74a910a326ca06e05692299`须逐字同序。原native/result/settings及34份不可变原件不变；新header明确核id/cwd/parentSession，未绑定fork仍拒绝，不能称整个原文件前缀相同。

独立input guard在公开输入边界核单一Broker真实path/hash、实际cwd、worker/high、69 native命令与固定prompt hash；任何身份或文件/ledger异常都显式handled并记录失败，不能依赖宿主会吞掉的throw。guard注册前没有文件I/O，序列化函数无外部模块闭包，重复输入也拒绝；原observer保持被动。已有candidate/resume与新fork有界测试38/38通过，RED/GREEN均留存。直接调用已安装`SessionManager.forkFrom`的纯文件证明`warm-v5-file-fork-proof/result.json`（SHA `330fac63bbbd762c50622fc3ee8c85ca7b3ce1e51bdc7905b41f9c031d4b207d`）核150条原字节、35份原件/设置前后相等，0 Pi/model/HTTP；不冒充真实新包autoload或v5成功。后续唯一v5按新driver与原39ad包独立冻结，保留v3/v4失败与分母。仅此已证实接线，不新增配置平台、产品状态或有限模型证明。

### 唯一 v5 真实终局与最终 CI 身份

`normal-final-v5-C-warm-BeUhOX` 原driver与独立机械审均passed。freeze `823afcefd57ba2554ebeeb374a74f7d8ae63c207617ef567fd0a3a66a9101741`绑定driver `1750de8f1fecf10a444a9c7a78497d9cd1472f82`、39ad产品及ac24归档；实际guard/host/path/hash、worker/high、69 native、897 B guidance（SHA `abfdefd54d32a4bf7c9e4f17d6a14a49e636c46c49a95c42507613de6330bf4b`）与9份正文各1收据全部成立。新header的id/cwd/parentSession明确不同，原150条453156 B非header历史逐字同序；原35份原件/设置、210项非环境输入、92份driver副本、90个archive成员均经独立回读。它验证公开fork条件，不把失败的v4线性resume改为通过，也不作为同条件性能比较。

本轮1个实际provider payload为216635 B，耗时79460.218792 ms，0工具、12 metadata/0 body/0 write，来源解码响应1196395 B，完整reported usage61733。继承历史正文的来源成本不重复计入本轮；分部token与美元费用仍unknown，其他扩展GET/SSE request7未闭合，不声明所有网络完成。最终2702 B回答完成了举例，但把作者`disable-model-invocation`推成当前运行时不会自动启动的保证，属于明确语义缺口；实际guidance已说明作者flag不能覆盖Notion可用性/权限。它不是本轮执行了禁止工作流的证据，也不因该缺口重跑。完整独审为`reviews/e2e-final-v5-C-warm-original-review.json`（SHA `13fbd8fa3320a72b63013b9f9d12a28742eadfe6f9ab82e9ebb56c6b7a0121dd`）和`reviews/e2e-final-v5-C-warm-integrity-semantic-review.json`（SHA `9c212f5c15cd14e61cecb13edf83febb23fc8a9ea33c9639da8e51a08326028b`）。

原16冷配置仍为8 technical passed/6 failed/2 not_run，6个执行任务没有完整产物；旧warm与v4失败各自保留。`final-v3-daily-summary.json`（SHA `d69bf5972dc93b1f9b371f2fac5dbe8e611114fd1c067d2c3194cb791e10bf4a`）与独立成本审`reviews/independent-final-v3-cost-audit.json`（SHA `9e6e2477060a6ecf0ccf060733d60cfc0ebb75e99e51aa6e6215dcd80ecf85c8`）固定冷系列49 payload/7773058 B、960 HTTP/111375735 decoded B；失败整任务usage未知，不用已完成响应下界计算完整费用或总墙钟。

CLI最终验证脚本/测试/地图head为`0cf7002ac02e6d7df37f621f53a151255de81aaf`，[CI117](https://github.com/yoyooyooo/notion-skills-cli/actions/runs/43026467694)四组Mac15/Ubuntu × Node22.22.3/24.20.0的check、fresh consumer及upload均success。回执`ah955-20261111/cli-ci-node22-20261111/records-counter-repair/root-ci117-final.json` SHA `fa306b76c0b5829c7f808855e1cb53b44f9b3e95fa6dad607c20b213c3f174ac`。v3/v4/v5实际冻结的CLI仍为9b03嵌入runtime（CLI48da02ec、SDK40bb943d），不把后续CI身份混作真实模型输入。

### 单次生成预算候选（已完成唯一一次验证）

六个原生成失败的最后请求已收到HTTP200；除A3时序异常外，其余五个在598–600秒附近仍有thinking_delta，无最终文本或完整usage。来源操作已在70.8–151.8秒闭合，四个样本没有guard拒绝；因此不把补目录grammar、批读或warm证明当作生成产物的前置。实际最后请求的max_completion_tokens为431972–456572，worker/high与外层600秒并存。原文、失败、分母与unknown不变；大上限是待判别的预算解释，不先宣称因果已证明。

该`maxCompletionTokens: 32768`候选默认关闭。它使用公开before_provider_request、独立策略扩展且先于被动cost/task观察器；只修改completion上限，保留更小的已有上限，不改变prompt、模型、thinking、工具、项目或全局配置。实际每个payload仍须worker/high、恰32768、无竞争max_tokens字段，并与真实wire的完整hash/bytes一致。原生final必须stop，且本候选拒绝历史中任何length，包括撤回后恢复为stop；安装版Pi原有自动压缩恢复行为和compaction设置保持不变，若发生仍留原事件并判失败，不能称零恢复。控制器只启动一次、零重试，超时/不完整文件继续失败。

候选只允许一次原A/-ns生成任务：同五文件项目SHA、原题、worker/high、600秒/16请求/40工具/4MB。使用当前已验39ad产品及嵌9b03运行时；相对旧A的guidance已由811变为897字节，这不是纯cap因果或同条件性能对照。完整文件出现后才按原独立审阅与真实helper实驱门槛验收。五项新增预算用例先因缺少实现而RED（不是旧模型超时的重现），随后与默认/续问/fork回归合计43/43 GREEN；覆盖默认关闭、错误cap、观察器顺序错误、后续改写和早先length拒绝。该次在独审、root许可和全局注册稳定后才冻结并启动；未重开16配置，未改作者或当次project guard。该预算策略属于模型驱动层，不改变任何产品有限状态转移，不新增TLA模型。

正式公开Pi注册已将同一39ad产品保存为相对user agentDir的local路径，且位于第19槽。旧驱动要求不同的绝对路径，因而在派发前拒绝。限定适配遵循公开baseDir语义；唯一注册与冻结入口realpath/bytes/hash完全一致、无package过滤时直接复用，项目settings不再重复注册。旧不同路径的隔离设置与默认resume深比较保留。三项注册用例先RED再GREEN，含原回归合计46/46；真实settings只读准入核对前后字节相等、0 Pi/model/HTTP。新计划明确已激活候选的global baseline，不把该变化隐藏在纯预算对照中。

唯一真实运行`final-v6-A-budget32768-notion-only-j4qMof`使用driver `60ad5983`，在原600秒超时后以143退出，实际闭合耗时601567.348167ms，保留failed。六份实际payload/wire均为worker/high、32768，累计743816B；14个native调用/结果完整配对，其中3条普通目录枚举被旧guard提前拒绝而未执行。完整六段来源正文（含三个参考）和五个项目文件均送达。来源账本为49 metadata/10 body/0 write，共59 HTTP、7208051 decoded bytes；没有final、stdout或生成文件，helper为not_run，未用原项目测试替代。

最后request79在进程约150.869秒开始，至transport observer结束的未闭合窗口为449135.727583ms；HTTP200之后无request_end、assistant completion或reported usage。观察到2014个thinking事件，含2013个thinking_delta；被动observer对非text_delta摘要空字符串，所以其delta.bytes=0不表示没有思考内容，思考文本字节和token均unknown。该轮实际可见text_delta为0事件/0B；前五轮已报告177506 totalTokens，仅是已结束响应的下界，不能当全程usage或费用。53项冻结输入前后相同，449份原件已索引；完整报告`final-v6-A-budget32768-terminal-review-v2.json` SHA256 `04ab288703d39601516dcbd3dd49e2a7e3f0fbe3a556861f23eebc9a50788918`，root原件独审`reviews/root-final-v6-A-budget32768-raw-audit.json` SHA256 `4abfddd63aea10398dec69945197342f572a0a04365775f7496efd74debae457`。这些事实不证明服务端是否执行了cap，也不支持把生成未完成归因于来源缺失。

后续仅修复三条已证实的库存读取误拒绝：固定owned cwd内，仍限512字/60秒、最多三个pwd/ls/find库存命令；额外至多一个40字的纯ASCII单引号字面量echo标记，总段数不超过四。ls只允许已知的`.`、`src`、`test`、`.pi`目录；find仍以`.`为根、深度1–4，只列文件/目录，最多两个固定node_modules/.git排除，head至多300行。外路径、-L、内容搜索、-exec/-delete、重定向、替换和脚本执行继续拒绝，实际调用及inputSHA仍保留。三条原native反例在旧guard下全部RED，修复后连同existingStore/预算/默认/续问回归51/51 GREEN；没有新Pi/model/HTTP。这一机械修复尚未证明能解决生成超时，所有原failed及分母保持，不自动启动新A/B/D或连续调整cap。

### 文件交付候选冻结时的驱动合同

`verify-pi-daily-candidate.mjs` 增加默认关闭的 `artifactOutput:true`，仅用于新的五文件 `owned-ticket-service` 消费任务，不能组合 resume、作者 CLI、existing-state 或 fork。runner 另建 `/private/tmp/notion-candidate-artifacts-*`，保存精确 ownership/dev/ino；动态路径与 UTF-8/LF 交付约束明示附加到原题，`result.actualPrompt` 保存实际文本、bytes/hash 和原 `config.prompt` hash。提示不提供目标叶子、ref 或业务答案。

前置守卫只允许原生 `write/edit` 向该目录的安全项目相对路径写完整文件；源项目、证据、Store、外路径、父目录逃逸、symlink/hard-link、运行时配置及其他写/执行工具均拒绝。Notion `read/notion_use` 必须 `readOnly:true`；原有限库存命令不扩展。实际 native call/input hash、逐次落盘 bytes/hash 与最终文件逐一核对。失败与超时也保留完整 `owned-artifact-files/`、`owned-artifacts.json` 和原输出目录，不由 partial 升级结果。

成功 native final 另存 `native-artifact-final.md`；只有其成功且文件齐全，才把实际文件封装为明确标记的 `generated-acceptance-plan.md` 并复用原 collector 与 `exercise --review`。容器含完整 final 的 JSON 与每个精确文件，`generatedPlan.delivery` 明确两类原件与 hash；独立 review 绑定 result/container/全文件后仍须读取原 final、审查并真实执行 Node helper。完整规程、参考、正文投递、原生 session/provider 和实际功能要求保持；文件存在不算完成。详细字段见[原产物执行合同](../../../../scripts/notion-skill-graph-acceptance.md#generated-artifacts-and-execution)。

Pro/macOS 手动定向入口：`node --test scripts/verify-pi-daily-artifacts.test.mjs scripts/verify-pi-daily-candidate.test.mjs scripts/verify-pi-daily-budget.test.mjs scripts/verify-pi-daily-resume.test.mjs scripts/verify-pi-daily-fork.test.mjs`，本次 Node 24.20.0 下 60/60 通过。新增九例覆盖缺省/作用域、真实文件 write/edit、越界与链接反例、严格只读、ledger 故障、partial/无 final/缺资源拒绝、批准 ID 隔离，以及原 exercise 中受控 helper 的真实 loopback POST→GET→400。当前 `test:verification` 为显式清单，未加入新文件；不声称新增九例已在 Linux CI 执行。它们证明驱动边界，不证明真实模型能交付。该变化不改产品有限状态转移或产品源码，复用原 TLA/coverage，不新增形式化模型。

后续由 root 先冻结一个 A/-ns 新构造；worker/high、五源文件、完整来源正文、自主选路和 600 秒终止保持。16 次 provider、40 次工具、累计 4,000,000 payload bytes 继续作为原终局质量门槛，不伪称 pre-send 限制；不叠加 v6 cap 干预。这个构造尚非已证明的 timeout 修复，原六失败及 v6 失败不改判。输出目录只在进程终局和证据审阅后按精确 ownership 做 Evidence→系统 Trash→Evidence；不删除证据、不扩全矩阵。

### v7 文件交付终局：未形成产物，候选不纳入日用主线

上节是启动前冻结的合同。唯一 `notion-only-final-v7-A-files-notion-only-hbY2m8` 已在 driver `0f6a9cde36b1692e1ba8f92bbbd43128d24ed1cb`、正常 HOME、worker/high 下真实结束：进程实际闭合 `601446.713208 ms`、exit143/timeout；5 份真实 payload 共 `599465 B`，12 个 native tool calls/配对结果、3 个被拒绝的 Bash。无成功 final、无 write/edit 调用、独立产物目录为空，helper 实驱未运行。原 600 秒、16 payload、40 calls、4,000,000 B 门槛保持；实际超时不能截成 600 秒或改判通过。

实际请求完整包含 Router、所选叶子及三份参考，五个项目文件也全部送达；`write/edit` 从首个 provider schema 就可见。三个拒绝是缺少已审深度的 find 组合、绝对路径 ls 与单独 echo，均未执行；后续已取得所有项目内容，现有证据不支持把这些拒绝单独定为生成超时原因。必要材料和工具可见不证明模型已经完成文件交付，也不证明所有运行时写入路径实际执行过。完整 usage/费用因最后请求未完整结束而保持 unknown，不能把已结束请求的用量当总量。

完整来源账本为 37 metadata / 8 body / 0 write，共 45 HTTP、4725 request bytes、5225532 decoded response bytes。源项目、正常配置与日用产品文件的前后 hash 保持。冻结为 `final-v7-A-files-freeze.json`，15736 B，SHA256 `03287fdf411ed9f903e160eda21687ec06dd11b34f08d73dedebd42fc2ba3c87`；原件根在 `verification-evidence/ah623-639-638-20261111-daily/`。完整独立观察审查位于该 run 的 `independent-observation-audit-v7-files.json`，165794 B，SHA256 `8c0b44510200c2ce44c3fbad6b9edff99fb672359688c1178f3334e29b57dcc2`，保持 failed。

独立成本补核绑定21份原件：前4次完成响应 reported totalTokens 为140594，只是下界。最后 wire64 收到 HTTP200/SSE，从 request_start 至 transport_end 的484287.024291 ms观察窗口内保留1次thinking_start和2896次thinking_delta，末条距观察器结束24.232208 ms；无 request_end、完成响应或usage。它证明SDK流仍活动，不证明具体思考文本、token量或内部根因。报告 `reviews/independent-v7-cost-terminal.json` 为34656 B，SHA256 `bfdd28522d4288da24c9096a9c76b6f4a4b7aa5d971558a557c50e4e8b9b8eb9`。

完整独审还记录了候选的静态兼容缺口：五份真实payload中的Pi `edit` schema为 `{path, edits:[{oldText,newText}]}`，而0f6冻结guard只接受旧的 `{path,oldText,newText}`；`write`形状相符。受控edit正例使用旧模拟形状，不能证明当前native edit通过。实际零write/edit，不能把这个未触发缺口解释成无首写超时的原因；候选不作为已验证日用功能采用，也不以此自动启动重跑。逐条native/payload/source与完整项目/产物快照独审为 `reviews/independent-v7-terminal-mainline-review.json`，93190 B，SHA256 `47957be915360a4cc1e036fe3ace4038d157ffb80089d719c6bedc2b2b43ae7e`。

同轮沿 v5 的继承历史补核了 C1 原 final entry `86e580ce`：它已含作者 editor flag 推导运行时保证、偏好稳定句柄推导禁用坐标的两句。原 C1 passed 审阅原件不改写；“六份介绍无准确性缺口”只代表旧审阅，不能继续作无条件当前结论。新增审阅 `reviews/root-v7-C1-inherited-accuracy-addendum.json`，3408 B，SHA256 `f70add6fafac95d966237025bbbcb7e024f0d9803cdae3eb97614f8e7c8099a0`；原16技术分母仍为8 passed/6 failed/2 not_run。

### v8 原生 edit 接口修正与候选终局

独立 v8 候选将 artifact guard 的 edit 输入对齐真实 Pi 声明的 `{path, edits:[{oldText,newText}]}`：数组必须非空，每项只含两个字符串；旧标量形状、坏元素与额外字段在执行前拒绝。既有 owned 路径、链接、源文件只读边界、Bash 语法和拒绝即失败门槛均保持。先以真实数组形状取得三项 RED，再运行上节五个定向测试文件得到 62/62；Pro 的原始 stdout/stderr 位于 `verification-evidence/ah639-20261112-native-artifact-schema/`，`green.stdout.log` SHA256 `a6ecabc2f8f28d7183c2977823a19cbfc7aa8dd920bf6497b4116a49f8fae71f`。

同一测试入口通过显式 `PI_ARTIFACT_NATIVE_TOOLS_DIR` 指向已安装 Pi 的 `dist/core/tools`，实际调用其默认 write/edit 实现，核对新建文件与两项替换后的完整字节，并证明外路径请求在候选守卫处拒绝、源文件不变。未设置该变量时该项明确 skipped；该证据证明已安装 native 工具实现与守卫兼容，未运行完整 Pi/provider 调度、真实模型或 Notion。v7 零 write/edit 的失败原件与未知超时原因保持，接口修正不证明生成任务已完成；真实模型实跑按下面的冻结记录单独评价。

v8 唯一 A/-ns 实跑 `notion-only-final-v8-A-sequential-files-notion-only-dIj5eO` 已终局 failed。运行时仍绑定冻结提交 `cf1cc69d59803a1851cada3785549c65e1bfb337`，本次地图终局提交不改变该绑定或任何冻结 driver、配置与原件。原 600000 ms 预算下，进程单调时钟实测 `601823.709959 ms`，`timedOut:true`、退出码 `143`；3 份实际 provider payload 共 `346386 B`。完整 native 共 104 行，11 次工具调用全部成功返回，0 工具错误、0 write、0 edit、0 final、0 产物文件。没有可审阅、可实驱的规程与 helper，既有 helper exercise 和 full-task acceptance 均不准入；定向工具测试通过不改判本次实跑。

输入与来源证据完整保存并逐字核对：3 份 payload 都保留完整实际任务和 Pstack router 各一次，末份的全部 11 个 tool result 与 native 一致；create-verification-skill 正文和 3 份引用与保存的 SDK 正文一致，引用保持同一 owner/snapshot；项目 5 份文件的冻结 manifest、实际字节和 native 返回一致。引用是生成器提供的 Notes 示例，目标是 Ticket service；没有生成内容，不能认定已完成来源适配或项目验收。独审回执在 `verification-evidence/ah623-639-638-20261111-daily/reviews/root-v8-A-independent/native-payload-artifact-review.json`，36602 B，SHA256 `6915db59a3b002dc6dd50757b7d62a584c383c1f6b55a0848d710e591fd704d7`。零 write/edit 不构成内部超时原因的证明。

本轮两处 exact owned 临时根已完成 Evidence→系统 Trash→Evidence：项目根 `/private/tmp/notion-candidate-print-fPh4ch` 的 6 文件/4438 B、3 子目录和空产物根 `/private/tmp/notion-candidate-artifacts-vj4sc8` 均先归档核对，再以 `/usr/bin/trash` 移动，两个退出码均为 0，原路径均已不存在。原始 session、observation、配置、结果、所有权清单及已审报告 35 文件/4178071 B 哈希保持；owned-state/Store 仅确认原路径保留，不递归、不读取、不复制内容。清理回执在上述独审目录的 `cleanup-owned-roots-20261112/after.json`，19712 B，SHA256 `8e5c16d1486ce829973bdb8b475b04f58e548519747b1708aa6329bdaf94512b`。

v7、v8 均按原停止规则结束，停止此 v8 构造，不扩展 B/D 或 normal，不推断文件交付普遍无效或唯一内部根因。实现、定向测试和终局地图保留在独立候选分支；主线 PR9/f2f7257 不变，不重复上述构造或重开已完成 CI。AH-639、AH-638 继续开放，原目标、失败、unknown 与 not_run 保留；不把管理、投递或受控 helper 的通过代作任务质量通过。
### 已读来源的多轮介绍复核（冻结时合同）

公开fork现可续接已独审的多轮纯介绍，保留normal或`-ns`原臂与原Store引用。准入按原result绑定的session hash、实际正整数用户轮数、完整非header字节及已闭合工具效果核验；先前已fork的session必须通过其原`launch.introductionFork.binding`核header与历史前缀，未绑定parent仍拒绝。原cwd仅是归档身份，已清理目录或当前包注册变化不阻止新owned cwd的公开fork；不重建旧目录、不复制Store、不删改旧回答。项目、脚本和业务写任务仍不在该入口范围内，默认线性resume的settings保护不变。当前输入前核单一真实Broker path/hash、cwd、worker/high、固定prompt及normal69/`-ns`0命令；结束后再次核原result/session和来源历史。

旧cwd清理、已fork两轮和`-ns`限制先有定向RED；修正后candidate/budget/fork/resume共55/55 GREEN。四个真实父结果C1、D-named、setup各1轮，v5为2轮，全部离线准入通过且原config/result/native字节不变；回执`reviews/close2-20261112-semantic-plan/fork-real-parents-admission.json` SHA `a646803692f90a884d66f424742be8fa08035783ac59ac93a91187cc55b388d4`。该预检未启动Pi/model/来源请求、未读Store；它不证明真实纠错交付。四份草案统一只要求对照已读完整来源复核，不提供正确答案或逐题提示，各一次、零重试、顺序运行，仍待root冻结真实当前host。复核即使通过，也只证明会话最终交付，原冷首答、失败、分母及生成/helper门槛保持。本次只改已有driver接线，不改产品状态转移或增加有限模型。
上述段落保留复核启动前状态。四次实际终局已在来源复核分支 `41101972da5fe6faa1bdce3d7e7bd601c36ee955` 及原件 `reviews/close2-v8-semantics/` 记录：技术核验4/4通过，内容判定C1/v5 failed、D-named passed、setup passed-with-notes；setup初评与补充复核均保留。它们不改原冷首答或生成任务判定。

### v9 两阶段完整生成续接候选（启动前合同，原文保留）

新增默认关闭的 `artifactRecovery` 只接受一个 SHA 绑定的原 failed/timeout 生成结果与固定 `procedure`、`complete` 两阶段。准入独立核验真实终局、原 native 完整调用/结果配对、五文件项目 manifest、来源只读效果、原臂和产品文件；不要求旧 native 有 final，也不合成 final。原 B/D 历史中被原项目守卫明确在执行前拒绝的 Bash 调用可原样保留，其他未闭合或越界历史不准入。v8 A 的完整 104 行历史可通过公开 fork 继承；超时请求未持久化的思考正文无法恢复，不能把空摘要或事件数量解释成具体进展。

第一阶段以公开 `--fork` 进入新的同五文件 owned 项目和独立产物根，仅交付规程主文件；记录 `stage-completed` 和 `fullTaskAccepted:false`。第二阶段通过公开 `--session` 沿用第一阶段的项目、文件及完整 native，同时继续绑定最初 fork header 与原始历史，补齐引用、Node helper 和完整 final。两阶段提示保留原任务及来源，不提供叶子 ref 或业务答案；生成阶段仍不得执行项目或 helper。两份原生 session、provider、成本、文件快照和 ledger 均保留；第二阶段合并两份 ledger 验证最终全文件，只有完整原生 final 与既有 collector 均通过才生成可独立审阅的 plan。

新两阶段总时间固定 `600000 ms`，在第一次 spawn 前启动单调时钟；第二阶段仅取得同一 deadline 的剩余量，中间耗时不重置。总门槛为 8 份 provider payload、40 次 native calls、4,000,000 payload bytes，旧历史不重复计入新成本。阶段边界若已耗尽数量或时间预算，第二阶段记 `not_run`；数量仍是事后验收上限，不声称每次派发前的硬 cap。新调用单独按本阶段 task observer IDs 核验，历史被拒绝命令不会伪装成本轮错误；本轮错误仍失败。完整来源是否真正进入每阶段实际 payload，必须在真实运行后回读原件核验，不能由父 session 曾读过推定。

验证在 Node 24.20.0 下采用命令级 YAML 2.9.0 依赖绑定；最初两次模块加载失败单列，不作为功能 RED。7 项缺实现 RED 之后补齐定向边界，最终 recovery/artifacts/candidate/budget/resume/fork 六文件共 76/76 GREEN、0 skipped，含已安装 Pi 的真实 native write/edit 和原 helper loopback 用例。覆盖共享 deadline、阶段一耗尽预算阻止第二次派发、阶段一不能整票通过、继承错误与新调用分账、完整 fork 前缀及跨阶段 artifact ledger。原始 stdout 为 `verification-evidence/ah639-20261112-staged-artifact-recovery/green.stdout.log`，SHA256 `0f91a3834e7fcd1dea0e853b19a9c35e71f756dc07714d541da8983cb7f6b0d8`；这不是一次真实模型生成通过。

只读准入已直接验证真实 v8 A，以及原 v3 A/B/D-natural 的六个 failed 父结果，保留所有原失败和拒绝事件；v8 实际 `notion_use` 的嵌套 preparation effects 形状先暴露准入错误，修正后回读通过。证据分别为同目录 `real-parent-admission-green.json`（SHA256 `bd3764b12df3b0665f018d5d8f47606162693cc1682c156b1d4ece8acacd4f35`）及 `original-parents-admission.json`（SHA256 `5692973d3124ffeb9ebb8b90deb52d35b1f8debdac13011f34fa58f9a22e77b1`）。本轮没有启动 Pi/model、Notion 请求或读取 Store。独立代码复核覆盖父准入、共享预算、阶段判定、成本分账与旧入口；产品五文件、默认 fresh/介绍入口和外写限制保持。

该构造改变任务分段并使用已读历史，是新的完整生成续接候选；不称原冷任务 600 秒通过，不证明此前超时根因，也不叠加 completion cap 或展开新矩阵。完整产物出现后，仍须独立原文审阅、原受控 helper 实驱和整体 chain `passed` 才可收口。AH-639、AH-638 与全部原 failed、unknown、not_run 继续按实际证据保留。本次只改变已有验证 driver 编排，不改变产品有限状态转移，不新增验证平台或形式模型。

本轮测试诊断明确列出的 45 个 owned 临时根已完成 Evidence→系统 Trash→Evidence：157 份常规文件/200451 B、74 子目录及 2 份 symlink 目标元数据先保留，链接从未跟随；45 次 `/usr/bin/trash` 全部退出 0，原路径全部不存在，原始测试与准入证据的 hash 均保持。只处理本轮确证 fixture，不递归原模型状态、Store/auth 或用户项目。清理回执为同目录 `cleanup-exact-test-roots/after.json`，11506 B，SHA256 `05a8cf5a41ce665f62e698442237f195f87060f37d85aab360cdfc23ac1909c4`。

### v9 真实终局与两份定位暖纠错

上述 v9 段落为启动前冻结合同，运行时绑定提交 `9c87ad659824b6baf19d10a3f83eb893a767ccc7`。唯一 A/-ns 链 `notion-only-close3-v9-A-staged-recovery-notion-only-chain-BLYnlx` 已失败：procedure 进程 `601772.78325 ms / timeout143`，6 payload / 1299378 B，5 次新 native（write 1、Bash 2、read 2）。两个 Bash 文件自检在执行前被拒绝，随后两个 native read 成功；0 final，complete not_run。实际保存 26314 B 的 `.cursor/skills/verify-ticket-service/SKILL.md`，SHA `f3ec7ecf5a116e67e7ef6ce46b97d61af71f250ff91bbf020348885051f96c49`。六个引用/helper 文件缺失，helper not_run；这是一个来源准确的草稿，不是完整任务通过。生命周期与清理设计关注点保留为待实现审阅事项，不虚构 helper 实际失败。

独审逐字核对父非 header 全文327824 B/103条、新 native、实际6份 payload→wire、五文件项目与50项冻结输入；继承11个调用不算本轮新调用。前五个完整响应367926 reported tokens是下界，第六个未完成，完整usage及金额 unknown。来源只有12次metadata且0 mutation；list没有显式effects字段，不虚构新的effects:none。其他网络与后代请求的未知范围保留，不与SDK请求相加，也不把两次拒绝推定为唯一超时原因。终局审计 `reviews/close3-v9-A-terminal-independent/terminal-audit.json` SHA `d92bb5b757b2079d6f9e32ceda2e45dc840f2dab37a7f77260c6d0e3058e254f`，部分文件语义审阅SHA `c08782f59face16ffc32673063e94b9cedb13d85358b18bc4055150b04d0adbd`。本构造已停止，没有扩展其他五臂或提高原预算。

C1/v5另立 `close3-v9-targeted-correction-freeze.json`（SHA `38b467c76fd89a01bd0d15c9dd4d921874680a6332bc91d9c7a9bbbe4a9cd2f5`），只引用各自上一答的问题句，不提供正确答案或后台计数；两例各一次、零重试、串行，沿既有介绍fork驱动41101972，不改产品或作者正文。完整历史与9份正文保持，正常69 Skills/worker-high成立。C1完整语义passed，准确区分显式调用、历史effects和无法证明的自动请求；v5 passed-with-notes，明确撤回Doctor等于用户路径证明，两处措辞歧义作为notes保留。两份原final字节及语义报告在 `reviews/close3-v9-targeted-semantics/`；C1报告SHA `140e4864e181fbf81754927cdb710cec7317dd5be363fdb01e84234514152843`，v5报告SHA `0a0c084eee01613853b08dbe59a49ce891fb3bd0219f9f37f2490bb647a6595a`。这些是明确定位干预后的当前交付恢复，不改原冷/暖/v8失败，不证明自主首答或同条件性能改善。

两新暖运行合计287044.502709 ms、2 payload/501648 B、140637 tokens；C1实际12metadata，v5完整SDK trace为0来源HTTP，均0新工具/0正文重读/0来源mutation。与原8个介绍系列唯一路径合并后为10 run、17 payload/3262677 B、375来源HTTP、966972 tokens，C1祖先只计一次。三份本轮新增运行合计888817.285959 ms、8 payload/1801026 B、24来源HTTP，508563 tokens仍只是下界。独立汇总为 `reviews/root-close3-cost-summary.json`，耗时是运行耗时之和，其他网络与金额unknown，不比较p95或归因性能收益。

A两个根与两暖cwd均完成Evidence→系统Trash→Evidence；83份原件未变，Store/auth未读、未复制、未清理。回执SHA分别为 `24e84bad9e7988d50d3f3c251497fef067d0a5dfc1cd6796ba6a5649be56ec41` 和 `5ae97d7fc0dddee7e321aabb707ab461063bd89f0ab16bbbb4b90a866a9f4bd6`。代码及地图只在独立候选分支同步；日用Broker f2f7257、CLI ee4e712和原精确CI169/CI118保持。当前12子票仍10 Done、AH639/AH638 In Progress；完整生成、固定资源续读及helper实驱没有被介绍纠错替代。原16分母保持8 technical passed/6 failed/2 not_run。本次终局地图不改变有限模型状态语义，既有TLA/cfg/view结果复用，不宣称重新证明。

### 完整失败运行 final 的独立产物实驱

v12 A 原结果 `notion-only-close4-v12-A-ref-and-correction-ibx2dL/result.json` 保持 failed，SHA `a8996e4c1ab529ac77fac193db1be371f1fae76ad5cd0528a1de9cd3e464bea5`；进程在 682162.191084 ms 后以 SIGTERM 闭合，原 600000 ms 预算没有通过。原 native 最后一条 `832f74b7` 是完整 stop final，32907 B、SHA `2dbf297cfe0e0a3b60c4fe8d7ceae155594cf096150b8a8cb0151ec36041bf03`。既有 collector 已在独立 `reviews/close4-v12-A-final-retention/` 逐字保全全文及六份文件；该目录没有伪造的 model result。来源 journal 缺 end，整体来源覆盖仍 unknown，不能由 final、保全或后续实驱补成原运行通过。

默认 `exerciseReviewedGeneratedHelper` 仍只接原 passed 结果。另设默认关闭的 review `artifactAdmission`，仅允许对已终局且正 PID 已不存在的 failed/timeout/SIGTERM 运行做 artifact-only 实驱。review 必须绑定原 failed result、原完整 session、最后当前用户输入之后的完整 stop final，以及独立 retention receipt；从 session 重算 final 正文字节，与保全文和既有扫描器提取的全部文件及 sourceSpan 一致。没有真实 final、选择旧祖先 final、改动文件或伪造任何绑定都在分配执行目录和 spawn 前拒绝；原结果、预算与所有失败事实不改写。

显式分支只改变产物来源准入：继续原独立完整代码审阅、五文件项目副本、单 Node 入口、最多 20000 ms 与最多 2000 ms kill grace、隔离环境、全过程归档和 Evidence→系统 Trash→Evidence。执行结果明确原模型 failed 与独立 artifact-only 范围；不能靠 exit0 或 summary 自述关闭功能门槛，仍须审查完整文件、stdout、实际功能证据、summary 和遗漏。若 summary 写入失败但退出为零，按真实证据不足处理，不由进程退出码制造通过。

定向反例覆盖默认 failed 拒绝、真实最后 final 的保全准入、错误 native/final/manifest 绑定、非 stop 或早期 final、仍存活的原 PID，以及执行/归档/清理后原 result 不变。该切片复用既有 helper executor 与 collector，不追加模型生成、runner、验证平台或新的产品状态模型；消费/来源 pin 状态没有变化，沿用原 TLA/cfg/view 结论并保留其有限边界。

三个新增功能反例先 RED，随后新三项与旧 loopback/默认 failed 拒绝两项合计 5/5 GREEN、0 skipped，原始 stdout 为 `verification-evidence/ah639-20261112-failed-final-artifact-exercise/green-attempt-1.stdout.log`，SHA `da93865d599101e1a61d7c83d43bfd71f96931e587518f7cd76060452f00faf1`。两份受控 helper fixture 真实执行并完成系统 Trash ECE；实际 v12 只调用只读准入，六文件和最后 final 字节相符，未执行真实 helper。正式生成物仍须 root 独立审阅、冻结实驱和按完整文件/stdout/summary/HTTP证据裁决。

