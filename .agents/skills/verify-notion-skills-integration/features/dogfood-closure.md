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

复用 .agents/skills/verify-notion-skills-integration、verify-context-broker 和 CLI 的 .cursor/skills/verify-ntn-skills。补丁先有能失败的直接反例，再跑必要回归及真实链路；不重复展开无关完整矩阵。每个交接包含 commit、文件列表、命令、exit/进程终局、原始输出和仍未覆盖的门槛。

不永久删除文件，不用 git reset --hard、git clean 或批量 restore。临时材料通过系统 Trash 回收，原始证据和未知操作保持。日用最终继续现有 CLI shim/NTN_SKILLS_DEV_ROOT 与 Broker 源入口，不新增发行目录或第二套缓存系统。

