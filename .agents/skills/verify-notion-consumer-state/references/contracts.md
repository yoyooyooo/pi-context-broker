# 消费者状态合同与维护对应

## 阅读顺序

先判断改动的是资格证据、固定选择、完整交付还是宿主投影持久化，再看对应模型和真实回放。资格、选择和交付是正交状态；一个模型通过不能代替另一个状态所有者的证据。

## 当前模型范围

Availability/ReadRace 留在 verification/models/consumer-observations，完整配置及故意保留的缺陷反例不改写。它们约束资格一致性、有效分页 cursor、请求顺序和两代会话；F1–F7 与原两项真实守卫 mutation 继续执行。

verification/models/consumer-state/coverage.json 是当前四个模型的唯一 cases 清单，绑定真实源码和受控回归。不得在 Skill 或 CI 复制另一份配置列表。这些模型覆盖有限时间、来源、精确身份/失败目标，以及 fixed graph 和 provider/boundary 交接。

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

## 守卫破坏与诊断

scripts/check-consumer-state-mutations.mjs 为每个实际守卫创建隔离 package 副本，链接既有依赖，只在副本内改一处。每个 case 保存源码/测试 hash、完整 argv、stdout/stderr 与 baseline/mutated/restored 退出状态。入口还运行 check-consumer-observation-mutations.mjs，保留旧 order/cursor 反例。

每个模型业务性质有明确损坏配置；实际守卫 mutation 证明这些回放能发现对应实现退化，并非逐行形式化 refinement。NoRetiredSelection 的实现证据包含原受控取消/会话回放，其模型 lifecycle 负配置不冒称已经移除所有冗余生产守卫。类型、parser、模块加载或依赖问题必须单列，不能算检出行为缺陷。

源码变动时先核函数和原子边界，再核回放及 finite model，最后更新 coverage 文件哈希。保留失败的原目录、初始失败配置和独立修复证据；不重新命名旧失败为成功。

## 工具与发布

模型由稳定 scripts/verify-consumer-observations.mjs 转交 /statechart，并复用原 tool-lock；模型输入、生成 Mermaid、每规则 TLC 输出与 report 都进入新证据目录。只用 Pele 将生成 Mermaid 渲染为 SVG，图册与正文必须标注来源 spec/config/view、状态规模和有限边界。

共享 CI 门禁沿既有 runner/result contract；本 Skill 仅维护消费者状态。当前管理 operation、HTTP RequestEngine、SDK capability、import 失效和实际安装各归其现有测试。新图不证明实际 provider wire 或完整线上链路成功。
