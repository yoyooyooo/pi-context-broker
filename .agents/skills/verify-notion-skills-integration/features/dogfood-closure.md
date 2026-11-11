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

