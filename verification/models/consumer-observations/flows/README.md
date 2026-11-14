# 管理到模型输入的组合审阅

2026-11-12 的 [中文图册](../../../../docs/notion-statecharts-2026-11-12/README.md) 保留当时 2 模型、13 配置的历史输入和结果。其后 ManagementToDelivery 加入管理回执前提，当前套件是 3 模型、24 配置；不要用当前命令声称复现历史图。当前模型入口见本页与 coverage，RetentionDisclosure 的 [局部视图修正](../../../../docs/statecharts/review-corrections/README.md) 单独保留当前生成结果。

这组模型与原 Availability、ReadRace 共用 statechart/TLC 锁定和运行器，覆盖另一层问题：各模块正确时，它们连接起来是否仍兑现用户可观察的承诺。它们不替代资源管理模型、原生宿主测试或真实 Notion。

## 运行

在 Broker 仓库，使用父目录 README 指定的 `PSTACK_STATECHART_ROOT` 和 `TLA2TOOLS`。输出是新建或预先创建的空仓外绝对目录：

```sh
node scripts/verify-consumer-observations.mjs --out /new/absolute/flow-output --suite flows
```

默认不传 `--suite` 时，原六个观察配置保持不变。本批扩展后的流程套件24个配置全部要求探索完成、性质有终态并匹配预期；`RetentionDisclosure.current` 保留历史接口缺口的反例。运行器成功表示所有预期匹配，历史失败不能改判成通过。

## ManagementToDelivery

一个已确认的作者发布、一个根、一个 Requires、一份 reference 和两个固定版本。它检查完整准备后应用、普通续问保版、明确刷新退役旧参考、合格暖续问不重取正文。4个破坏配置分别移除这些条件。

`PublishVerified` 与 `EditInNotion` 只映射到完整读回后的管理回执，不能把 Notion 多页写入当原子事务。模型不计算实际 HTTP，只数逻辑正文取得；目录 TTL 到期时的合法元数据请求不违反正文复用。CLI/SDK/模型时间、授权变化、内容保真和故障恢复需要实际测试。

真实回放绑定同一新建 Skill：公开CLI create成功、冷Pi自主list/use/read、旧版暖续问、同进程公开write主文与参考、保留旧pin、明确refresh取新版、自然续问。原生session及实际发送payload证明必要主文/Requires/reference各一份，旧正文与旧参考同时退役。它是一条实际路径，不是所有模型选择或长期性能的统计保证。

## RetentionDisclosure

消费层允许保存原生编辑后的内容为不可变历史。原真实路径中，作者先在Notion更新两个文件，后续current use发出6次成功POST留存内容。旧工具模型输出只有`ok/status/purpose/roots/records`，最终模型却报告“未写入”。原会话、HTTP与失败结论保持不变。

AH-953 的实施合同在 CLI consume/readSkill/prepareGraph 返回 version-1 `effects`：`remote_writes` 为 none、retained 或 unknown，另列作者正文是否未变及涉及的 Skill/File/operation。Broker 将同次操作回执交付到 `notion_use`、标量原生 read 与 Pi `$`/native 注入；缺失旧生产者回执保留 unknown，不从 HTTP200、文件已存在或固定快照的历史推导零写。失败包含已发生效果和未知结果，正文及完整来源 span 保持原样。

`implemented` 检查正常固定读取和当前留存；`read-only` 检查首个语义写前拒绝；`unknown` 检查丢失 ACK 的失败披露。`ReadOnlyHasNoRemoteWrites` 和 `UnknownOutcomeIsDisclosed` 各有移除对应边界的负配置。SDK 的严格只读还要求代码导出与构建 manifest 都声明 effects version 1，在不兼容时不调用旧操作。

`ReadyReportsObservedRetention` 要求 ready 能识别已观察留存。`NoFalseZeroWriteReport` 只约束模型里的显式报告规则；`current` 展示旧反例，`proposal` 保留原设计，`claim-negative` 继续证明有字段也不能保证任意 LLM 正确报告。真实模型仍须逐份审阅其实际输入与最终回答。

此模型区分必要留存和作者修改，不删除历史来制造零写。严格调用通过 `readOnly: true`（CLI `--read-only`）进入原请求层无写边界：需要留存时在首个语义写前拒绝；固定或已留存内容可正常返回 none。诊断 HTTP 计数独立留在证据中，模型只收到最小语义回执。批量固定资源读取不在本切片新增标量参数的范围。

AH-953 的独立源码审阅在 `79ee07fe` 找到两处实现接线缺口：`$` 的多源准备没有传递 operation observer，前源已留存而后源拒绝时可能只剩后源的 none；标量 native read 在准备后、原生执行前的取消检查位于 effects catch 外。既有 `host-prepare.test.ts` 现在分别用已确认 retention 加后源拒绝，以及提交后 `queueMicrotask` 取消复现；失败必须保留原错误身份和已观察的 Skill/File/operation，缺失的后源效果仍为 unknown，取消仍拒绝正文且清除 pending receipt。修复复用原 accumulator/catch，未增加请求、授权或状态维度。`NoFalseZeroWriteReport` 和未知结果披露合同不变；有限模型仍只抽象一次 acquisition/retention，不声称穷举多来源或 JavaScript 调度，这两条实现边界由直接反例证明。Availability/ReadRace 的资格与取消决定不变，双 coverage 同步实际源码和回归绑定。

此修订的同一冻结工具复跑保存在 `verification-evidence/ah955-20261111/ah953-partial-cancel-fix/flows`：13 配置均探索完成、未截断并匹配原预期，历史及故意破坏配置保留原失败性质。命令与进程终局见相邻 `flows.json`，实际两条红例及67项宿主回归见 `red.*` 和 `targeted-final.*`。原六个 Availability/ReadRace 配置本切片未重跑，沿用未改变的资格/取消语义说明，不将 flows 结果宣称为它们的新执行。

## 源码与证据维护

`coverage.json`绑定实际Broker状态、协议与投影文件，并明确CLI管理步骤的抽象边界。源码hash变化先重审对应，不直接替换hash。真实原件、SDK trace、模型session、只读缓存统计和操作receipt按运行保留；数据写入权威仍由原管理operation负责。

AH-925 的 `93ca4a714c87d22ad5124e066ff3b2f5562e2337` 只在原读取拒绝回执附带 stage/code、开始/当前 generation 和 signal 状态；公开消歧候选保留原结构。`ManagementToDelivery` 的完整准备、固定选择、参考归属和交付提交均未改变。`RetentionDisclosure` 的 readOnly 下传、首次写前拒绝、已观察及 unknown effects 也未改变，新增 admission 不参与效果推断或零写报告。此审阅同步本流程目录自己的 host-skills 源码绑定，不能以父目录 coverage 的更新替代；13 配置继续使用原模型与正负预期，原冷资源失败原因仍 unknown。

2026-11-11 的绑定复核用原 statechart `c742dd61706fbacc1b95f1a20b7b988cf096ce6c` 与 TLC 1.7.4 完成全部13配置。`ah925-flows-source-binding/summary.json` 中每项 `matches: true`、探索完整且未截断；8个故意失败/历史反例配置仍命中原定性质，不把它们改称性质成立。原始报告、TLC 和 Mermaid 保留在 `/Users/yoyo/Documents/code/personal/verification-evidence/ah955-20261111/ah925-flows-source-binding`，命令终局在相邻 `ah925-cold-resource/flows-followup.json`。这次复跑不补足原冷资源故障缺失的 admission 原件。

本次审阅起点：Broker `d472dbd0cf708890a3a3e58951485ad87f14d28c`；CLI `ca8cc946a662c486fee2817007d13763c3a57c0f`。Pro原件位于`verification-evidence/ah681-20261108/dogfood-flow-audit-5ZQLVa/`。本目录保存可再跑的模型和性质，不打包用户正文、认证、真实session或临时工具二进制。

真实接口缺口回放：`native-review.json`连结原生44行use、48行toolResult、52行最终答复及六个POST请求ID。首先核对工具返回结构和原始HTTP，不能由自然语言模型的自述独立判定写入。其他故意破坏配置仅证明相应性质可失败，不能称为现产品另有四个Bug。

## AH-1012 新增的组合合同

本批保留原 13 配置及其预期，扩展为 **3 个模型、24 个配置**：ManagementToDelivery 增加完整管理回执前提及不足时的正/负对照；AcquisitionEffects 增加两次 acquisition 的 9 个配置。RetentionDisclosure 的原 current、proposal、claim、read-only 和 unknown 模型输入完全保留。

| 交接端口 | 输入前提 | 保证与证据归属 |
| --- | --- | --- |
| operation-recovery → PublishVerified | 原操作已完成验证，或另一个独立接受已具备自己的完整完成事实 | 未知/不符的原操作不被改写。管理回执不足时该抽象交接停在 blocked；这不是新加的全局运行时 gate。 |
| PublishVerified → SelectionGraph | 完整管理读回已作为本条工作流的输入；消费者仍独立核对身份/权限/正文与 Requires | 准备完整且预算通过后才提交固定选择。每个成员保留自己的 pin。 |
| SelectionGraph → DeliveryBoundary | 已提交的完整绑定向量及同次 run/session/user 身份 | provider 接受、回合 completed、实际持久化是分开的证据；抽象 context 不构成 wire 原件。 |
| 两来源 acquisition → effects | 每个生产者同次操作的 none/retained/unknown 回执；缺失回执按 unknown | 前源 retained 不能被后源失败/取消覆盖；unknown 优先，Skill/File/original operation 的已知事实仍保留。 |
| effects → Report | 受控报告规则显式消费累计回执 | 只有确认 none 才可报告零写；该性质不保证任意 LLM 自然语言。 |

`AcquisitionEffects` 分开表示外部语义写与后续 ACK 观察，第二个 ACK 未知时不制造精确成功事实。严格只读先检查 SDK/manifest 能力，在每个首要语义写之前拒绝；旧 SDK 能力不匹配时零 producer 派发。第二个来源失败或取消可以留下第一来源的已知效果，不能提交半套新图。本模型直接检查失败时不提交半套新选择；原选择向量的精确保留由 consumer-state 的 SelectionGraph 和既有 host 回归负责。已经发生的远端效果不会因失败回滚。

有限域为两次有序获取、两个已知 retention 身份、最多两次抽象语义写；第二来源覆盖成功、已知失败、ACK 未知与取消。原生准备完成后的 microtask 取消仍由既有真实 `host-prepare` 回归证明，不把此模型称为所有调度交错或 provider 线上的穷举。

```sh
node scripts/verify-consumer-observations.mjs --suite flows --model AcquisitionEffects --out /absolute/new/acquisition-model
node scripts/check-effects-composition-mutations.mjs --out /absolute/new/effects-guards
bun test packages/context-broker/scripts/formal-effects-composition.test.ts packages/context-broker/scripts/host-prepare.test.ts packages/context-broker/scripts/notion-sdk.test.ts
```

7 个真实代码变异检查包括 prepareMany 丢失前源 effects、unknown 优先级、retention 事实及精确身份、重复回执 unknown 状态、旧 SDK 派发、准备后取消绕过原 effects catch。半套选择的真实 guard 复用 consumer-state 的 commit-before-checks/output-budget 回放；管理完成前提复用 operation-recovery 的独立完成绑定，避免再造跨仓总运行器。严格无写在 CLI `packages/core/src/notion-readonly.ts`、`consumption-effects.ts` 和既有 `notion-readonly`/`resource-read` 回归中核对。

原真实 E2E 仍只引用上文的固定 session、HTTP/request IDs、源码和 evidence 身份。本批没有执行新的生产 Notion 或真实 LLM 回合。详见 [维护合同](../../../../docs/formal-verification-maintenance.md)。

组合图中的 provider 接受、回合完成和持久化都是下游合同提供的回执输入，不是本模型生成或验证的线上原件。DeliveryBoundary 负责这些输入的实现边界；真实会话证据仍须沿原独立入口核对。

## 配置计数与当前责任

`RetentionDisclosure.proposal` 与 `implemented` 的 cfg 内容相同，保留两个历史调用名称，不计作两种独立行为覆盖。运行数描述实际调用，独立输入数另行区分。`current` 是修复前反例；`unknown` 的输出即使与某正例相同，也按自己的 cfg 身份记录。

ManagementToDelivery 描述一条有界组合工作流；管理回执是输入前提，刷新失败/取消的选择保留由 `consumer-state/SelectionGraph` 及真实宿主回归负责。没有新增全局管理 gate，也不要求把所有已有分层模型合并。
