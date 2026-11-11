# 管理到模型输入的组合审阅

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

## 源码与证据维护

`coverage.json`绑定实际Broker状态、协议与投影文件，并明确CLI管理步骤的抽象边界。源码hash变化先重审对应，不直接替换hash。真实原件、SDK trace、模型session、只读缓存统计和操作receipt按运行保留；数据写入权威仍由原管理operation负责。

本次审阅起点：Broker `d472dbd0cf708890a3a3e58951485ad87f14d28c`；CLI `ca8cc946a662c486fee2817007d13763c3a57c0f`。Pro原件位于`verification-evidence/ah681-20261108/dogfood-flow-audit-5ZQLVa/`。本目录保存可再跑的模型和性质，不打包用户正文、认证、真实session或临时工具二进制。

真实接口缺口回放：`native-review.json`连结原生44行use、48行toolResult、52行最终答复及六个POST请求ID。首先核对工具返回结构和原始HTTP，不能由自然语言模型的自述独立判定写入。其他故意破坏配置仅证明相应性质可失败，不能称为现产品另有四个Bug。
