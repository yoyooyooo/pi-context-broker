# 消费者状态合同与维护对应

## 阅读顺序

先判断改动的是资格证据、固定选择、完整交付还是宿主投影持久化，再看对应模型和真实回放。资格、选择和交付是正交状态；一个模型通过不能代替另一个状态所有者的证据。

## 当前模型范围

Availability/ReadRace 留在 verification/models/consumer-observations，完整配置及故意保留的缺陷反例不改写。它们约束资格一致性、有效分页 cursor、请求顺序和两代会话；F1–F7 与原两项真实守卫 mutation 继续执行。

verification/models/consumer-state/coverage.json 是当前模型的唯一 cases 清单，绑定真实源码和受控回归。不得在 Skill 或 CI 复制另一份配置列表。这些模型覆盖有限时间、来源、精确身份/失败目标、Library 选择，以及 fixed graph 和 provider/boundary 交接。

## FreshnessPublication

- 原子 Receive 对应同步的 currentEvidence → createConsumerObservations 的准入/更新，以及 host-skills 的精确身份/失败目标门禁。异步 source acquisition 已产生原始证据；模型没有将网络请求当作原子步骤。
- 时间为 2、3 两个位置，原始验证时刻为 1、2、3；缓存有效期为原始时刻加 2，最多返回两次。remote/cache/fixed/unknown 分开；一次缓存返回不会更新 validatedAt。
- expire 性质是“不把过期缓存重新发布为当前证明”。已有资格不会在此模型中随墙钟自动消失；真实 metadata consumer 的 TTL 触发另由 F6 受控时钟检查。max-age 为零的真实 remote 观察仍可成为当前证据。
- 初始状态保留一条已知资格或没有观察，以及一个已开始的请求。等验证时间下仍检查请求 order。取消/会话代次只阻止随后发布；不改写已经发生的历史观察。
- scope 既是 recordIdentity 的一部分，也是完整协议返回的验收条件。不能据此宣称 createConsumerObservations.observe 单独拒绝另一个 scope 的合法记录；不同 scope 各自拥有状态。
- 精确失败归到有证据的 child。没有合法目标、未知 transport 或固定内容不能推断 root 的当前权限。metadata candidate 的默认可见性不等于已经获得新权限证明。

| 原子动作/性质 | 实际入口 | 回放 |
| --- | --- | --- |
| 原始 validatedAt、expiry、fixed/unknown | currentEvidence；createConsumerObservations.observe | consumer-observation.test.ts；consumer-state.test.ts 的 FV04 |
| order、generation、cancel | begin/current/accept/canPublish；graphPreparation 的最后资格检查 | 原 late old failures、F7、older success after newer denial；等时间新回归 |
| scope、目标归因 | recordIdentity；prepare-protocol.preparationFailureDetails；host-skills.observeFailure | 原 scope 与 dependency denial 回归 |
| 真实 metadata 到期 | host-skills metadata consumer | 原 F6，TTL-1/TTL/后续访问和并发读者 |

### 显式刷新发现目录

`notion_list refresh:true` 复用 index 的目录 owner 和同包 SDK，仅推进目录请求与发布；它保持 host 任务 `generation`、selected/active 图、固定引用与交付状态，并取消旧 metadata signal。`metadataGeneration` 新加入分页 cursor，即使目录字节和有效资格没变，旧 cursor 也不能跨一次成功刷新继续。它是具体实现的额外发布守卫；Availability 仅建模单条候选与有效资格，ReadRace 只有请求顺序和两个 session epochs，不能把 metadata epoch 等同于其中的会话 epoch。

`FreshnessPublication.Receive` 仍对应异步获取完成后的同步证据准入；它不建模 SDK 请求、写后失效、View 交接或 Promise 等待。`host-refresh.test.ts` 经 production index/adapter 验证 TTL 内新条目、失败/partial、自动写入在途失效、固定选择及随后普通回合；`host-prepare.test.ts` 验证不配合取消的旧 producer、等待者取消、重叠来源合并和 session fence。`catalog-cache.test.ts` 检查精确来源强刷和 offline 策略，`catalog-menu.test.ts` 检查公开 age 随原始验证时刻前进、缺失观察不变成新验证。native CRUD 回执与 literal argv 由 `cli-write-invalidation.test.ts` 检查。这些是实现义务，不扩张现有有限模型的证明范围；保留全部原规则、负例和真实 guard mutations。

### 内容搜索的整份结果发布

`notion_list search_in:content` 以显式、非空 query 和唯一配置来源启动。metadata 模式、禁用来源和无来源不会进入 MCP；headless/RPC/print/JSON 不提供授权展示回调，所以缺少已有凭据时 SDK 在 OAuth flight 前终结。Broker 只持有展示 URL、该 waiter 的 signal 与 deadline；transport、凭据和授权回调由 core/SDK 持有。

`consumer-observation.accept` 在原有 generation、signal、证据时间及请求顺序守卫通过之后，原子地更新 observation、推进 qualification revision 并通知订阅者。拒绝的旧证据不推进 revision；deny 后又 allow 仍是新代次。原 metadata 资格判定和 cursor 合同不变。

`content-publication.createContentPublication` 从这个 revision 和当前 task、metadata、source 配置、session ID/file、branch ancestry 建立一次发布 ticket。成功、空结果、notice、授权拒绝和其他错误共享此 ticket；它在 SDK 等待、授权展示前后及最终输出处检查。已接受资格变化或取消可终止不合作的 producer 等待；原 branch 追加可继续，回退、换支或重写已捕获前缀会退役。授权完成只恢复原参数，不能改来源、另起 query 或改写 selected/active/Requires/pins。

首版没有 content 缓存或远程分页，所有 content cursor 都在 dispatch 前拒绝；返回 `next_cursor:null`、`pagination:not_supported`、`coverage:remote_non_exhaustive` 和 `exhaustive:false`。metadata refresh 仍只刷新目录。SDK 负责显式 entry 的 fresh REST 预检、授权后复核、MCP 同一 physical 来源绑定及 Skill/File owner、Enabled、稳定 ID 的最终准入；这些网络义务不由消费者模型证明。

`host-content-search.test.ts` 经真实 host 工具入口回放整份结果 fence、空结果、远程错误、资格变化、配置变化、deadline、单 waiter 取消、模式和 cursor 拒绝、无 pin/active 写入。`consumer-observation.test.ts` 核资格 revision 的唯一接受点与 ABA；`content-search.test.ts` 核动态 SDK 返回的有界闭合结构与错误白名单；`pi-authorization.test.ts` 核展示/关闭/取消和无交互能力零浏览器副作用。现有 mutation runner 另在隔离副本破坏资格推进、source/session/branch/deadline/cancellation 和错误发布守卫，要求 baseline、行为反例、原字节恢复三个阶段。

这些是 `FreshnessPublication`、`ReadRace` 的具体实现扩展义务。现有有限模型没有 OAuth、空远程列表、metadata epoch、配置指纹或 branch ancestry 变量；不得从旧模型通过推导这些新行为已穷尽验证。保留模型、有限域、完整 cases/expected_rules 和旧负例；源码 hash 只绑定已审查的 owner 字节。真实 Notion/OAuth、安装身份和自然 Pi 任务继续由 integration、agent-workflows 负责。

### Source 管理事实与消费者收尾

管理 transport、SQLite 目录 schema 和 scope/load/invalidate 不在现有有限模型的变量或原子动作中。Source 写完成后本地目录失效失败，是具体实现义务；不得将 Availability、FreshnessPublication 或 DeliveryBoundary 的通过声称为 schema 升级或完整管理协议的形式证明。

CLI 先验证固定 transport binding 与完整 manager receipt，然后才运行消费者收尾。其 consumer_finalization 失败可保留 verified_management；Broker 用 source-materialization-contract 再绑定原 request、Library、target、authorization_root 与严格 receipt，并保持 manager scope。正常成功时 manager 与 consumer scope 可以相同或不同，仍须分别通过各自鉴权与当前消费者 scope 验收。source-materialization 只记录管理事实和实际 effects，拒绝 onReceipt、ready、catalog 与正文发布。实际 SourcePreparationScope.checkpoint 可以到期并 abort，但不改变已验证的管理事实；预算不重新计满。验证前失败不带 verified_management。已知未派发的 SourceManagementUnavailable 保持 remote_writes:none；没有可信回执或结果不确定的 transport 保持 unknown。

下图是实现合同示意，不是 TLC 生成的穷尽图：

~~~mermaid
stateDiagram-v2
    [*] --> MemberCandidate
    MemberCandidate --> NotDispatched: blocked or unknown readiness
    MemberCandidate --> AwaitManager: eligible missing current member
    AwaitManager --> NotDispatched: known unavailable before dispatch
    AwaitManager --> Unknown: outcome not verified
    AwaitManager --> Verified: exact bound receipt
    Verified --> FinalizationFailed: consumer error or cancellation
    Verified --> Catalog: consumer finalization succeeds
    Catalog --> Consume: complete current catalog
    FinalizationFailed --> [*]: retain manager fact; no publication
    NotDispatched --> [*]: no dispatch; writes none
    Unknown --> [*]: no verified fact
~~~

实际守卫由 source-materialization.test.ts 的旧实现红、新实现绿、伪造 request/library/target/authroot/phase/code、receipt 后取消和真实 budget checkpoint 到期回放检查。source-materialize-cache-upgrade 另用安装包、实际 Pi、真实 SQLite 及受控 Notion/Git，核两条 v1 与一条 v2 混合目录退休、跨 scope/无关目录保留、完整目录重建和全正文；独立 evidence 必须同时核原 manager stdout/stderr/实际 close 和后续 0 HTTP 暖读。它们是 concrete obligations，保留现有全部模型、cases、expected_rules 与 guard mutations。

source-materialize-blocked-member 单独验证上述 MemberCandidate → NotDispatched 边：真实 Source 注册和 member_patch 通过固定 Git metadata 发现，完整 SDK 返回明确 blocked；有效 manager binding 保持可用，实际 manager spawn、consume 与语义写为0，provider 无原文或派生全文，原 Pi/SDK 完整结清。该回放在 HTTP fixture 完成初始化、任何客户端启动前保留完整 before 及原字节/单调时钟绑定；仅缺失 blocks 的已声明空初始化可以解释输入到 before 的差异，after 继续全值比较，并拒绝缺失、伪造或过晚的 before。成员表示能力归配对 CLI，SourceMemberSelection 仅证明来源、目录覆盖和基数准入，不把本例升级为其形式证明。

## SelectionGraph

一个 root 和一个 Requires，各有两个本地已验证选择的序号；不承诺远端历史恢复。旧向量为 root v1/Requires v2，新向量为 root v2/Requires v1；序号不表示两个身份共享 snapshot/hash。负配置复制 root pin 到 child，会破坏 EachMemberKeepsOwnPin。

Prepare、InspectIdentity、InspectBudget、Commit 分开，不能将异步准备和最终发布画成一个原子写。模型覆盖 scope/snapshot/hash 不匹配、缺依赖、预算超限、取消/代次切换及未先检查的 commit。失败替换保留旧向量。

源码对应 graphPreparation 的延迟 commit、prepare-protocol 完整 graph decoder、session-graph 的 validate-before-append 和逐成员 binding。当前 selected/pending/active 共用 applySelectionGraphs：仅替换指定 roots、投影保留根完整闭包，并校验共享 binding 和 outgoing Requires；这些多根组合由 session-refresh.test.ts 回放，不扩大单根模型的证明范围。Pi 的 commit 可能只暂存 pending graphs，直到 provider 2xx 才写 selected entry；此模型的 selected 表示获准的固定组合，不表示 active 或 persisted。

实际回放复用 host-prepare 的 failed exact-file validation and output budget、session-active 的 pending refresh 和完整闭包、skill-context-session 的错误 hash/mapping/部分输出；新增 consumer-state 回放两个不同成员 pin 及有效 branch 的回退。提前调用 commit 与移除 budget guard 的 mutation 必须失败，而不只是 coverage hash 失配。

### 刷新时保持任务根角色

`host-skills.assertRefreshRootRoles` 在 use 的刷新准入边界检查当前 selected 加本轮 pending use 图。已验证的 Requires-only 节点不能经 refresh 升为独立根；返回可恢复的 `ROOT_ROLE_CONFLICT`，保留原 selection、active 和继续提问能力。失败不说明该节点 disabled，也不授予可用性。普通 use 可以按独立任务选中该节点，已有 root+Requires 双角色随后可刷新；首次选择、新的无关根、已释放图和 inspection-only 状态仍走原路径。

角色必须由精确 scope/owner/locator 和对应 fixed binding 确认。裸引用仅在唯一启用来源及唯一已确认 current scope 下提前判断；多来源先完成原身份解析和歧义处理，不能从一个已选图推断来源唯一。`host-refresh.test.ts` 和 `host-prepare.test.ts` 覆盖这些准入、原任务保留与正常路径；这是宿主回归证据，不扩张 SelectionGraph 的有限状态范围，也不证明自然语言意图。

## DeliveryBoundary

SelectionGraph 包含 retained + new closure 的有限字节预算前提及 `ReleaseActiveRoot` 代次动作；DeliveryBoundary 同样建模显式释放，使有效 root 投影变为 0，但保留历史 active 接受事实。完整共享 Requires 可达性、精确 UTF-8 并集和旧 fixed ref 拒绝由 `session-active.test.ts` 与实际 Pi 回放负责，不能从这个单根有限模型推导。两模型仍使用原完整正反配置清单，源对应见 coverage 的 `nxt12_review`。

初始前提是前一模型已经选定 root v2/Requires v1，且有旧确认向量可保留。active 表示本次完整图曾被 provider 接受这个历史事实；有效 branch 的派生版本另算。rewind 恢复旧有效向量，不能借用离开当前 branch 的确认。

| 状态/动作 | 实际边界 | 不能推断 |
| --- | --- | --- |
| prepared/selected | graph preparation / session selection | provider 已收到内容 |
| ReceiveHeaders | after_provider_response 的 2xx 检查及 confirmActiveSources | stream 或模型任务完成 |
| complete graph proof | sourceBodyLoaded；全 graph binding 的 scope/snapshot/hash | 单个 root 或部分正文足够 |
| FinishTurn | turn_end outcome=completed | 宿主一定接受扩展返回的 drafts |
| OfferDraft | deferredSourceEntries | persisted 已推进 |
| Apply/Discard | 宿主决定公开投影中的实际 entries | 仅返回 draft 就持久成功 |
| ObserveProjection | acknowledgeProjection 逐一核对当前 user 内容 hash 和实际 machine receipt | 任意历史 marker 都可当证明 |

模型最多两个请求，第二个只用于宿主丢弃第一次 drafts 后的重试；最多一个生命周期事件（cancel/switch/rewind）。取消或切换可以发生在 headers、turn、draft、ACK 之间。一次 2xx 后发生 stream/turn 失败，不抹去先前的真实接受事实，但不得产生完成或 projection persisted 的新证明。

真实回放使用 session-active.test.ts 的 selected/partial、discarded drafts、failed/aborted/late/rewound 场景；新回归补不同 session identity 的迟到 headers 和原 user 已离开 branch、另一个 user 仍存在的情况。后者避免“找到了任意 user”冒充原请求身份。native-read-session 和 skill-context-session 保留全正文、精确 snapshot/scope/hash、独立 pins、原生历史不被修改的检查。

### Pi 的失败退化与交付证明

Broker 准备、授权、完整闭包或最终投影检查失败时，原用户请求继续；失败的 Skill 指令不能因此获得交付、激活或持久化证明。`host-skills.warnAndRetire` 撤下本次未确认的 entry、pending graphs、candidate、投影和待确认 drafts，释放自己的准备状态，并给出一次 warning。原有 source/scope、观察顺序、session/generation、取消、完整正文及 provider/turn/projection 守卫仍决定能否发布。用户 Stop 和会话替换由宿主拥有，旧异步结果不能触碰新会话或重新发布正文。

`nonblocking-context.withoutBrokerInstructions` 先保留并校验 receipt，再剥离其证明的正文片段；普通用户引文和图片不凭相似文本删除。最终 provider hook 的安全替换按原逻辑消息、工具调用 ID、原生文本和图片绑定识别已知消息槽，保留普通工具调用及输出、图片和 provider 字段。OpenAI completions、Responses、Anthropic、Google、Bedrock 与 Pi message 形态由具体回归检查；这不是通用 serializer，也不证明未知 provider 形态已被修复。未知形态只依赖序列化前的安全逻辑上下文，不获得额外 wire 确认。实际请求字节的完整 ledger 证明仍限于现有 OpenAI completions 和 Undici 路径。

直接返回给 Pi 的逻辑上下文仍须保留原生消息形状：撤下 source tool result 时，原来是数组的 `content` 继续是 text block 数组，普通图文和调用配对保持原样。后置 payload repair 不能证明此前的 native serializer 边界安全。`nonblocking-context.test.ts` 检查该边界；AH-1327 的实际 Pi 1.6 离线回放还经过 session projection、context clone、`convertToLlm` 和 Responses converter，保留旧 TypeError 与修复后的原件。这不是新的 HTTP 发送或自然模型消费证明。

失败后同一 turn 内的新成功获取可以重新尝试原上下文链。`toolResultRecovery` 在获取前捕获 run 和失败 episode 的 Map，只在当前 session/generation/signal、同一 Map 且完整获取成功时登记 call ID 与结果 digest。digest 包含正文、来源 receipt 和规范化 `isError`；undefined/false 等价，true 或正文/receipt 变化均不能放行。新的失败替换 Map，旧 episode 的迟到结果不能恢复它；partial scalar、截断 batch 和授权失败不登记。旧结果和旧指令片段继续退休，新结果仍经过当前权限、完整 Requires、最终投影及 provider/turn/projection 守卫。`host-prepare.test.ts`、`resource-read-host.test.ts` 和 `nonblocking-context.test.ts` 回放这些正反例。RecoveryClosure 的三个 prompt 与 DeliveryBoundary 的有限变量不包含同 turn 的 episode、原生数组或 digest；它们的原规则不变，不能据此宣称这些新实现边界已穷尽证明。

`skill-preparation.withContextPreparationDeadline` 为每次模型请求前的 context 保留四个累计额度：普通读取 60 秒、Source 定向发现 180 秒、消费收尾 180 秒、管理等待 600 秒；绝对墙钟上限固定为 840 秒，独立于四项额度之和。Library 身份、首次目录与普通图读取使用读取额度。核实当前字面 `$`、已选 Source 和既有候选或精确 root 条件后，`begin` 进入消费收尾；只有三个既有定向 metadata 发现调用的 `withDiscovery` 词法区间扣发现余额。管理返回后的完整目录和正常 consume 使用消费收尾余额。只有 `source-materialization.materializeExplicitCandidate` 中实际 `manage()` Promise 进入管理等待额度。多个 root、Requires 和同一 context 的 queued inputs 共享四份余额及同一绝对时限；任何阶段、输入或 root 都不能重新计满。

600 秒是前台累计管理等待策略，不是 fixed manager 的后端执行期限，也不读取部署配置来扩大前台额度。管理器可能使用更长的既有运行预算；前台逾期或用户取消只结束等待，不停止已接纳的 writer，也不创建替代请求。未进入 Source 准备时保留原来的单一 60000ms timer；公开工具仍用原 `withPreparationDeadline`。这是每次 context 的额度，包含多次模型和工具往返的整段 agent turn 不共用它。

`preflightPrompt` 是 `withSourcePreparation` scope 的唯一词法所有者。scope 经 `submissionRecords`、`discoverInputMembers` 和既有 PreparationAuthority grant 显式传递；它只有计费职责，不从 signal、模型工具或缓存记录推导写权限。三个开始入口继续检查真实 literal、当前 receipt、已启用在线 Source，以及候选或精确 root 的既有条件；management dispatch 保留完整 Source/scope/readiness/Requires 守卫。`begin` 对本 scope 幂等且不续期。`withDiscovery` 与 `withManagement` 只在该 scope 仍持有当前消费收尾阶段时进入；嵌套或重叠调用不能借用另一次 phase 或额度。scope 结束后不能重新开始，迟到 `checkpoint` 也不能影响下一输入。

以下状态转换表描述实现的 phase 与 scope 所有权，不是新增有限模型或定量墙钟证明：

| 当前状态 | 事件与守卫 | 下一状态及计费 |
| --- | --- | --- |
| 普通读取，无 scope | 进入本输入 preflight | 普通读取，本输入持有 scope；读取余额不重置 |
| 普通读取，本输入持有 scope | 合法定向准备调用 begin；读取尚未过期 | 消费收尾，扣累计收尾余额 |
| 消费收尾 | 同 scope 再次 begin 或异步边界 checkpoint | 状态不变；累计扣账，不授予新额度 |
| 消费收尾 | 当前 scope 的既有定向 metadata 调用进入唯一 withDiscovery；先检查旧阶段余额 | 定向发现，只扣累计发现余额 |
| 定向发现 | 原发现 Promise 结束；scope 仍为当前且 context 未关闭或取消 | 返回消费收尾，保留全部余额和绝对时限 |
| 消费收尾 | 当前 scope 进入唯一 withManagement；先检查旧阶段余额 | 管理等待，只扣累计管理余额 |
| 管理等待 | 原管理 Promise 结束；scope 仍为当前且 context 未关闭或取消 | 返回消费收尾，保留全部余额和绝对时限 |
| 发现或管理已结束、scope 已退役或 context 已取消 | 迟到 finally 或 checkpoint | 不重新开放 scope；不得吞掉原管理回执 |
| 任一活动 scope | 准备成功、没有候选、blocked 或抛错后的 finally | 关闭该 scope；返回剩余普通读取额度 |
| 任一活动状态 | 某桶耗尽、840 秒绝对时限、父取消或 context 结束 | 关闭 context；旧 scope 不得重新计时或派发 |
| 已关闭 context | 已接受 manager 的迟到回执 | 保留经原合同验证的管理事实和失效；signal/receipt 守卫拒绝 session、图和正文发布 |

单调时钟在 scope、阶段切换、异步操作完成和 context 完成时扣账，即使到期 timer 尚未调度也先触发 timeout/abort。管理 finally 只结算原额度，并在仍持有当前 scope 时恢复消费收尾；它不能抛出新的额度错误替换已到的持久化回执。正常已验证回执继续先经过原 `onReceipt` 失效，再由 signal/current 守卫拒绝过期的消费结果；`consumer_finalization` 失败仍遵守上文独立分支，不制造消费 scope。外层 Promise race 先保留 SOURCE_PREPARATION_TIMEOUT 再取消子 signal。正常 context 完成只关闭预算能力，保留后续交付边界需要的成功 signal。后续 taskPrompt、buildPreparedPrompt 和 active restoration 使用剩余普通读取额度。

Pi preparation gate 不禁用编辑器；一次 input 接纳的排队文本和图片由原生队列送到后续 context 后再准备。`source-materialization-catalog.test.ts` 经生产 index/host 回放无前置 notion_list 的冷目录、首次消费失败、定向发现、manager、完整目录和最终 root/Requires 全文，保留发现 121 秒与管理 163 秒串联回归，并检查发现 125 秒、管理 163 秒、完整目录 36 秒和 consume 30 秒串联时完整正文仍进入 provider。后一个反例区分发现和收尾额度；guard mutation 把发现扣回收尾，必须出现 SOURCE_PREPARATION_TIMEOUT、缺失 root/Requires 正文和行为断言失败，恢复后重新通过，不能用缺方法或 TypeError 算命中。它还检查多 root 和 queued scope 的累计余额、旧/关闭/嵌套/重叠 scope、四桶耗尽、独立 840 秒上限、Stop/session switch、迟到回执与 overdue timer。`pi-queued-input.test.ts` 用安装 Pi 的 dispatcher/SessionManager 检查两份 queued receipt 共用一个 context 预算。普通 60 秒、工具预算和原权限、partial、foreign-scope 负例继续执行。

有限模型没有这些累计时钟、Promise 退出、队列或原生内容变量；ReadRace、FreshnessPublication 与 DeliveryBoundary 继续验证各自的取消、所有权和发布抽象。四项额度、绝对时限、词法计费和上述定量反例是 concrete obligations，不能声称为 TLC 时间证明。实际 Pi 另验 `source-materialize-cold-budget`：空客户端首次直接 literal `$`，无 notion_list/consume 预热，以真实逐请求延迟区分发现、管理和管理后的目录/consume，并保留跨过旧 180 秒共享额度和 240 秒总时限的证据。核对独立的发现 SDK 与管理 request/PID、管理原退出及 ready、最终 ordinary consume/provider 全文，以及下一 PID 的五分钟复用账本。配置的延迟总和不能替代实际时间线，观察区间不冒充内部扣账 tick；其他物化场景的先行目录调用不能替代冷输入条件。

`index` 的 shutdown 先推进目录代次、取消 catalog owner 并清空目录引用，不再等待所有目录 producer 退出。`ownCatalog` 保留获取前后的 signal 检查及拒绝观察；`publishCatalog` 仍检查 owner 和原 cache entry。`host-refresh.test.ts` 通过真实 index 入口暂停一个忽略取消的 SDK catalog，验证 shutdown 在 producer 返回前完成、迟到结果不能作为工具结果发布，也不新增 branch entry 或通知。此 Promise 退出义务不属于 ReadRace 的有限网络调度证明。

`host-skills` 的公开 metadata list、use、`notion_ctl cli_source` 验证和 Broker 自有单项 read 复用 `withPreparationDeadline`，每次操作默认 60 秒。内容搜索保持 360 秒和 `CONTENT_SEARCH_TIMEOUT`，并将最初的 Library 解析纳入总预算；batch 按原 `timeBudgetMs` 做实际 Promise race，保持 `RESOURCE_TIME_BUDGET`。原生 read 接管失败时，tool_call hook 的来源获取同样有界。普通 native read 在识别后原参数直通，其执行不纳入 Broker 的期限。Stop 也通过 race 结束等待，不依赖 producer 自行响应 signal。

外层取消会清理该 toolCall 的 pending read receipts；原 graph commit、qualification、scope、generation、完整文件和公开 ref 守卫继续接收子 signal。超时后的迟到结果不能 commit 或返回正文；已经在原生读取前合法完成的 fixed inspection selection 是先前事实，不回写成从未发生，也不据此伪造成功 read receipt 或 active。`host-prepare.test.ts` 与 `resource-read-host.test.ts` 分别暂停 metadata、Library、graph、原生来源读取和 batch producer，要求未释放 producer 前 timeout/Stop 已返回，再检查迟到回执、状态、下一次工具操作及普通 read 直通。Pi 1.6 的实际 tool runner 直接 await execute，且 Stop 等待 idle；因此只传 AbortSignal 不足以保证退出。以上 Promise 和宿主行为属于具体实现义务，有限模型不宣称证明这些运行时等待。

收到 2xx 后才发生的 session 写入失败不能撤回已送达正文，也不能冒称正文从未加载。此时警告说明持久化未完成，响应继续，失败路径不制造新的确认或 boundary drafts。`activation-feedback` 的 `ready` 只表示准备完成，`loaded` 由 provider 接受路径确认；显示消息始终是 `content: []`，不会成为模型指令或另一套 selected/active 状态。

`nonblocking-context.test.ts`、`host-prepare.test.ts`、`input-guard.test.ts`、`session-recovery.test.ts`、`final-request.test.ts` 和 `activation-feedback.test.ts` 分别检查这些具体边界。FV05 的不同 session 迟到 headers 回归还继续执行 `turn_end`，要求不返回旧来源 drafts；`provider-session-identity` mutation 仍须破坏真实守卫并触发行为断言失败。保留所有原有限域、cases、独立 expected_rules、负配置和 mutation；新增 owner/hash 只是经源码审查的对应，不扩张形式化证明范围。

## RecoveryClosure

该切片覆盖三个连续 prompt，A、C 共用必须依赖 B，并保留独立根 D。原始字节完整或 B 缺失、远端 current 版本 1/2、业务 Enabled 关闭、一次明确权限拒绝和一次恢复 ticket 失效分别建模。恢复开始、外部返回、完整闭包/权限投影和继续提问是不同动作；不把异步读与最终发布当成原子事务。

| 性质 | 实现边界与回放 |
| --- | --- |
| 固定原版本不偷偷变更 | index restoreActive、assertRestoredSource；新版本字节不能冒充丢失旧快照 |
| Requires 完整才交付 | session-recovery 的闭包隔离、host 最终 assertActiveContextDelivery；缺 B 时 A/C 均不半交付，D 保留 |
| 业务 Disabled 与访问拒绝分开 | 原固定字节可用时继续恢复；真实授权/访问拒绝仍阻止正文投影 |
| 失效 ticket 不发布 | session epoch、取消与 release 后的 check；迟到结果不得进入当前请求 |
| 失败后可以继续提问 | 恢复失败返回有限 warning，不抛成每轮的永久前置失败；三次连续请求回放 |

ConversationCanContinue 使用局部动作的弱公平，并假定用户继续提交下一条、每次外部读取最终返回内容/失败/超时/取消。它检查有限三条 prompt 能达到 provider 请求或显式取消，不能推导无限服务可用性、provider 完成、模型质量或真实终端输入成功。

实际恢复复用现有 `DEFAULT_RESOURCE_READ_BUDGET.timeBudgetMs`，一轮 context 总预算为 30 秒；不是每个根各等待 30 秒。source `requestTimeoutMs` 仍是每个网络 attempt 的预算。`session-recovery.test.ts` 另用确定性暂停验证总预算、有限退避、未完成的 producer、独立本地根与历史 pin 保留；模型不抽象任意网络调度或墙钟。

源码对应 `session-recovery.ts`、`index.ts`、`host-skills.ts` 及完整闭包和 fixed-read proof。`check-consumer-state-mutations.mjs` 在隔离副本移除对应隔离、闭包、业务开关、权限和取消守卫，必须得到行为断言失败；模型通过与真实守卫检出分别报告。

恢复正文的 root/Requires 角色从同一次 `activeSelection(ctx, pending)` 推导，
完整 binding 核对后才展示；尚未投递的新 selected 图不覆盖原 active 角色。
`selectedTaskRole` 同时服务恢复和 read 状态投影，不维护第二份 selection。
`session-recovery.test.ts` 与 `read-intent-status.test.ts` 检查这些实际文本边界；
有限模型不证明 Agent 能理解角色，也不证明自然任务选路成功。

`host-refresh.test.ts` 另核公开 use/read 的精确关系诊断：SDK 明确观察到
Requires disabled 才显示 Enabled=false；缺失、不可访问或库外仍保持未知，
不得转成授权拒绝。公开诊断不携带原始响应或凭据，也不改变原固定任务。

## LibrarySession

Library 身份抽象 canonical root UUID。branch 的默认选择、已接纳 turn 的 Library、
完整 ref 的调用目标、目录 producer 的 ticket、固定 pin 的原 owner 是不同状态。
设置 B 先验证成功，再保存到当前 branch；当前 A turn 仍取 A，后续 turn 才捕获 B。
失败切换保留原选择，但请求 B 的后续流程必须 blocked，不能拿 A 继续完成。

完整 B ref 可以从 A turn 发出，不修改默认选择；只有独立显式 call scope 与它冲突时拒绝。
模型不将 ambient default 当作显式约束。相同 Skill ID/路径的具体对象与字节由实际
SDK/CLI 回归核对，不能只观察名称或工具成功退出。

| 独立事实 | 要检查的退化 |
| --- | --- |
| turn 接纳时 Library A | 切 B 后旧 turn 或短引用改发 B |
| A 目录 payload 与原 selection/epoch ticket | A 迟到结果当 B 发布，或取消后旧结果仍发布 |
| parent branch 已存 A | fork/rewind/resume 借用后来 child 的 B |
| A 的固定 pin owner | 切库重绑 pin 或把旧 A Source 视为 disabled |
| 新 turn 接纳时当前选择 | 明明已切 B，后续 turn 仍使用旧 A |

切库只改变 selection ticket；lifecycle epoch 仍用于独立取消/会话失效。
已有合法发布记录的是其原发布时刻，后来的切换不倒算历史错误。
一个不再适用的目录结果可以被丢弃，而原 A turn 的固定目标仍有效。

有限域包括两个 Library、两个 branch、两轮、一个目录 producer、一次切换和一次取消。
`SessionFlowEventuallyExplained` 依赖局部动作弱公平与外部观察最终返回，终点包括显式
拒绝/blocked；它不证明 API 可用、provider 完成或模型任务质量。
源码对应 `library-selection.ts` 的 `sessionLibrary`、`accept/capture`、`select`、
`isCurrent` 和 command `current()`，以及 `host-skills.ts` 的 `turnContext`。
六项 `library-*` mutation 分别破坏每次 input 取默认、blocked、目录 ticket、command
session、最新 active-branch entry 和 running turn 优先级。失败 B 后的 oracle 会先
恢复远端，再新接纳一次 input；仍须 blocked 且不得发新 resolver 请求，避免旧的
rejected Promise 掩盖删守卫缺陷。普通 A turn 与排队 B 分别保留独立上下文；普通
输入的 preparation gate 在 `agent_start` 释放。Pi 不用此 gate 锁定原生队列，排队
input 保留接纳时的 Library、session 和 generation，在其实际消息进入 context 后
再采用；队列交接不改变既有 graph 提交协议，其顺序与图片保留由具体宿主回归验证。

有限模型只建模默认主 Library 和一个显式跨库调用，不穷尽同轮多 Source 的语法。
`$name@source` 仍是明确 Source 覆盖，按配置绑定实际 root/full ref；无 `@source`
名称只在当前默认库解析。多库同名、混合 Prompt/Skill、显式多 Source 与 CLI 写后
失效归具体宿主回归，不能从这个模型通过推出。
根创建、descriptor v2、实际 DB/DS parent、同 root 换表与原 pending key 属于 CLI 的 LibraryLifecycle。

### 普通与排队输入的接纳回执

`skill-preparation.createInputReceipt` 在 input 接纳的同步部分复制原文本和图片，
保存独立 invocation ID、原 session/branch 以及已经接纳的 Library context。
`accepted-selections.capture` 同时消费这条输入的草稿选择；之后 preflight、
task prompt 和正文构造按同一个 receipt 读取。组合、替换或取消 AbortSignal
不改变身份；下一草稿、同 token 新候选或后台目录不得修改旧 receipt。

Pi 只在消息真正到达 context 后准备排队输入。`host-skills` 在原生
`message_start` 按 steer 优先于 followUp、同队列 FIFO 关联接纳回执，排除该轮
初始 prompt；有图片的消息可已经被宿主改写图片并追加文本提示。关联只做一次，
随后以 `SessionEntry.message` 保留的原消息实例认领。Pi 的 `emitContext` 会复制
消息，不能拿 context 中的引用、原图片字节或下一草稿重建身份，也没有 fixture
专用的值匹配回退。每条输入使用原 receipt 和 Library，不能先拼接再按最后一条
Library 重新解析。
准备图仍通过原 identity/budget/Requires/qualification 守卫，整个 model request
仍共用既有有界 preparation deadline。多条 pending 图共同参与闭包与冲突检查，
2xx 后才分别按原输入作用域持久化；原 user/image 消息保留。

`accepted-selections.test.ts` 使用真实 host hooks 重放原组合 signal 和排队换绑
反例，并覆盖多条同文本不同 Library/images、steering 优先序、归一化和生命周期退休。
`pi-queued-input.test.ts` 直接使用选定 Pi 的 AgentSession 图片缩放、ExtensionRunner
事件和 SessionManager：真实图片字节与文本变化后，原回执仍绑定 A；原生归一化
消息经过真实 context clone 后完整交付，重复投影不重复认领。它是受控宿主边界
回放，不是远端授权、实际模型消费或 TUI 体验的证明。
LibrarySession 没有 arbitrary queue、图片或 Signal 对象变量，SelectionGraph
也没有多输入图数组；这些是实际调用边界义务，不扩大有限模型的声明。
DeliveryBoundary 的 provider、turn、branch、完整正文和公开 ACK 条件不变。

## MenuPublication

本轮切片保留四条既定性质及四个各破坏一个守卫的配置，使用现有 consumer-state
runner 和独立 expected_rules。它是此次可复现源码，不能冒称为历史 18 states
设计模型或以旧状态数代替当前运行结果。

有限域是一份固定作用域、已打开并高亮 B 的下拉，候选 A/B，一次缓存返回、一次
刷新及一次 Esc/接受。known-denial 场景以 A 的拒绝晚于缓存为前提；reorder 场景
没有拒绝。缓存与刷新先进入内存快照，屏幕更新是另一动作，用户可以在两者之间
接受仍显示的原候选。完成态允许 stutter；没有公平性、网络最终成功或时延性质。

| 性质/动作 | 具体所有者与守卫 | 证明边界 |
| --- | --- | --- |
| NoDeniedResurrection / ReturnCache | SDK readCandidateSnapshot 筛除最新 scope/record 拒绝；Broker 只接纳 SDK 返回的候选 | 拒绝是本模型输入前提；SQLite 原子性和认证归 SDK 回归 |
| FreshOutranksLateCache / ReturnFresh | completion-candidates.createCompletionSnapshot.accept 的 owner/order/refreshed 门禁；index 的 menu generation 与 catalog owner | 只枚举一次 cache/fresh，不覆盖跨库网络调度 |
| NoDismissedReopen / Escape、UpdateMenu | pi-dollar-editor 的 intent、valid、sequence、dismiss；Esc 在 waiting/open 都撤销 intent | 真实 Pi debounce、输入键和 Promise 退出由 Editor/TUI 回放 |
| ChoiceIdentityPreserved / UpdateMenu、Accept | editor 按 item.identity 保持高亮，移除时无选择；dollar.applyCompletion 使用原 item.candidate | 同名、重排、改名、撤下和接受竞态由实际 Editor 测试补齐 |

实际 Pi 在 extension 的 `session_start` 完成前已接收输入，随后还会重绑原生 provider。启动观察在 extension factory 成功完成配置、工具和命令注册之后、TUI 开始输入之前安装；前序初始化失败不会创建一个在 loader 丢弃 cleanup handlers 后仍遗留的 observer。初装前的短暂观察只记录 focused native Editor 实际处理的输入，按实例保存；handoff 必须仍是同一 TUI/焦点、同一输入方法和精确 draft/cursor，已知 scope 也不能变化。未知历史 `$` 草稿不自动认领；早期 Esc、提交、输入/焦点变化或方法被其他扩展替换都不能被复活。原 native 调用只委托一次，返回值和异常原样保留，观察错误不阻塞输入；接管、no-UI 和 shutdown 都停用观察，只有完整 method descriptor 仍归自己时才恢复，不覆盖其他扩展改动。

已有同 scope/draft 的有效意图在 provider 重绑时保留高亮身份并重新订阅、请求；迟到结果不变成隐式 Tab 接受。它在意图抽象中对应 stutter 后的现有 UpdateMenu，具体列表重建和等待状态另由真实 Editor 回放。初装 handoff 在本模型 Init 之前；模型没有 native focus、waiting 或安装事件，安全性质通过也不能证明该交接或等待保活。实际 Editor 的初装/重绑正反例、全插件首 `$` 与早 Esc 终端原件由 AH-1327 记录，时延按各自初态报告。

`index.activateMenu` 先把已有 bundled 本地候选发布到同一 snapshot，再让异步本地扫描与同一 bundled 数组合并去重；无需等待扫描完成才显示这些现成条目。该同步发布仍不提供消费资格、正文或 loaded 证明。

`completion-candidates` 的新元信息候选没有伪造文件路径，`dollar` 每次只筛选当前
内存快照。被选身份在 input 接纳时进入独立 receipt；真正消费才物化，并继续
执行当前资格、精确来源、完整主文/Requires、固定 pin 和实际交付验证。
候选可见不能推进 ready/loaded，关闭菜单也不能撤回历史 provider 接受事实。

`host-skills.prepareMany/activate` 对已经携带精确 source、scope、稳定 ID/ref 和
shared_skill locator 的 Notion 候选直接调用原 graph/load 消费边界，不等待无关
Catalog/Default View。普通名字、原生 `/skill:` 解析和其他来源保持目录路径。
`preflight` 的 `$` 解析交给 receipt-aware callback，仍由实际 SDK 取得当前资格
和完整正文；已有本 source 的拒绝、较新拒绝与迟到成功、固定 pin 和最终 commit
守卫保留。已捕获的 physical locator 不由后到目录中同 logical identity 的条目
替换。`host-prepare.test.ts` 在目录 producer 未释放时重放完整 root/Requires、
Prompt 获取、physical binding 和本 source 拒绝；这不证明实际网络可用或消费授权。

实际回放另覆盖 cold/stale/partial/完整空结果、缓存损坏、已知拒绝、producer
忽略 abort、provider reject 后下一请求、scope/cursor/session 退休和图片保持。
按键至真实可见下拉、后台返回至屏幕更新及筛选 p50/p95 由真实 Editor/TUI 另测，
包括 Pi 的自然 debounce；任何模型状态数或零 HTTP 断言都不是毫秒证据。

## SourceMemberSelection

该有限切片以一次已接纳的 literal 输入、普通 registry 已有本地选择与否、所选 namespace、解码后的 complete/partial 和 0/1/多个候选为输入。共二十四种初态，多个用 2 表示；不把字符串解析、目录构造、文件扫描、Git 或网络观察伪装成模型已验证的输入。

| 动作/独立性质 | 具体实现与回放 | 边界 |
| --- | --- | --- |
| Route / LocalSelectionOwnsRoute | index.discoverInputMembers 只对 ordinary registry 的 not-found 继续 Source 发现；mixed-source host 裸名只交付本地正文，source-members 与 management 为 0 | 不证明任意本地文件或 fuzzy alias 的完整 registry 构造 |
| Route / UnmatchedNamespaceIsIgnored | sourceMemberQuery 返回未选中后立即忽略；错误 namespace 不回退同名本地对象 | namespace 来自实际配置，不是注册 Source ID；解析原件由具体回归核验 |
| Classify / PartialDirectoryNeverClassified、PartialNoManagement | matchSourceMemberCandidate 在匹配数量判断前拒绝 partial；零匹配与有匹配 host 均可见 CATALOG_INCOMPLETE，0 management、无替代 Skill 正文 | 普通用户任务可继续；warning 不证明 provider 获得 Skill |
| Classify / CompleteClassificationIsExact | complete 目录按 0/1/多个返回缺失、唯一、歧义 | 真实候选身份、字符串匹配与错误码由 source-member-candidates.test.ts 检查 |
| AdmitManagement / ManagementNeedsUniqueSelectedSource | 唯一候选才进入 index.materializeInputMember 的既有边界 | 只建模准入，不表示派发、manager 成功或正文交付；当前 receipt、权限、取消与预算仍是独立守卫 |

Route、Observe、Classify、AdmitManagement 分开，完成态允许 stutter；不声明公平性、网络最终完成或时延。managementAdmitted 只表示进入既有准备边界，readiness、PreparationAuthority grant、真实 dispatch 和完成仍由各自实现回归或已有模型另证；固定输入不覆盖运行中 namespace 或 receipt 改变。candidate 保留全部守卫，三个 negative 分别删除 local、namespace、coverage 守卫。独立 expected_rules 固定所有七条性质和 NoDeadlock；负例必须穷尽并只破坏其声明集合。实际生成 statechart/TLC 原件由现役 runner 保存；实现分支示意见 consumer-state README。

`source-materialization-catalog.test.ts` 通过 production index/host 验证同名混合源、qualified 引用、未知 namespace 及 partial 0/1。`source-materialize-first` 的实际 Pi 则保留无 autoload 标记的同名本地 canary、完整 Git 正文、真实 `$name@namespace`、新 PID 暖读和独立客户端。普通启动 shell/PATH 与 actual Git 身份、manager 原协议和 provider 完整字节继续由 integration 检查；本模型不能代替这些证据，也不扩张 Availability/ReadRace 的变量或历史结论。

## 守卫破坏与诊断

scripts/check-consumer-state-mutations.mjs 为每个实际守卫创建隔离 package 副本，链接既有依赖，只在副本内改一处。每个 case 保存源码/测试 hash、完整 argv、stdout/stderr 与 baseline/mutated/restored 退出状态。入口还运行 check-consumer-observation-mutations.mjs，保留旧 order/cursor 反例。

每个模型业务性质有明确损坏配置；实际守卫 mutation 证明这些回放能发现对应实现退化，并非逐行形式化 refinement。NoRetiredSelection 的实现证据包含原受控取消/会话回放，其模型 lifecycle 负配置不冒称已经移除所有冗余生产守卫。类型、parser、模块加载或依赖问题必须单列，不能算检出行为缺陷。

源码变动时先核函数和原子边界，再核回放及 finite model，最后更新 coverage 文件哈希。保留失败的原目录、初始失败配置和独立修复证据；不重新命名旧失败为成功。

## 工具与发布

模型由稳定 scripts/verify-consumer-observations.mjs 转交 /statechart，并复用原 tool-lock；模型输入、生成 Mermaid、每规则 TLC 输出与 report 都进入新证据目录。只用 Pele 将生成 Mermaid 渲染为 SVG，图册与正文必须标注来源 spec/config/view、状态规模和有限边界。

共享 CI 门禁沿既有 runner/result contract；本 Skill 仅维护消费者状态。当前管理 operation、HTTP RequestEngine、SDK capability、import 失效和实际安装各归其现有测试。新图不证明实际 provider wire 或完整线上链路成功。
