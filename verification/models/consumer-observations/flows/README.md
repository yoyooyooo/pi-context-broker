# 管理到模型输入的组合审阅

2026-11-12 的 [中文生成图、SVG、原报告与输入清单](../../../../docs/notion-statecharts-2026-11-12/README.md)已按同一模型和13组配置复跑。当前可读图册维护在 [Notion 验证策略](https://app.notion.com/p/4125636c236e819bba12c71af9a0c0f5)，后续维护由 [AH-1006](https://linear.app/yoyooyooo/issue/AH-1006)承接。该快照只调整展示词汇，不把抽象上下文、受控报告规则升级为真实模型回答证明。

这组模型与原 Availability、ReadRace 共用 statechart/TLC 锁定和运行器，覆盖另一层问题：各模块正确时，它们连接起来是否仍兑现用户可观察的承诺。它们不替代资源管理模型、原生宿主测试或真实 Notion。

## 运行

在 Broker 仓库，使用父目录 README 指定的 `PSTACK_STATECHART_ROOT` 和 `TLA2TOOLS`。输出是尚不存在的仓外绝对目录：

```sh
node scripts/verify-consumer-observations.mjs --out /new/absolute/flow-output --suite flows
```

默认不传 `--suite` 时，原六个观察配置保持不变。流程套件13个配置全部要求探索完成、性质有终态并匹配预期；`RetentionDisclosure.current` 保留历史接口缺口的反例。运行器成功表示所有预期匹配，历史失败不能改判成通过。

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
