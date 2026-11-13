# 读取副作用：局部图面修正

RV2 使用既有 `RetentionDisclosure` 的 8 个配置，全部完整执行并匹配原正负预期。只改展示 view，以及原运行器传递同一 cfg 常量的展示适配；TLA、cfg、性质和产品行为均未变化。输入、结果与图件摘要见 [manifest](manifest.json)。

[严格只读违规](RetentionDisclosure-read-only-negative.svg) · [Mermaid](RetentionDisclosure-read-only-negative.mmd) · [报告](RetentionDisclosure-read-only-negative.report.md)

每个状态明确标为严格只读请求；写入后的状态注明“违反只读：已发生远端写入”，仍只违反 `ReadOnlyHasNoRemoteWrites`。请求模式来自这次实际检查的 `StrictReadOnly` cfg 常量；不从写入结果猜测权限。

[未知结果未披露](RetentionDisclosure-unknown-negative.svg) · [Mermaid](RetentionDisclosure-unknown-negative.mmd) · [报告](RetentionDisclosure-unknown-negative.report.md)

失败且发生抽象写入、但未披露 unknown 的终态独立显示“未知结果未披露”，不会与合法零写终态合并；仍只违反 `UnknownOutcomeIsDisclosed`。原有留存未披露和错误零写声明标签保持。

图由原 statechart 生成器和 Pele 1.9.0 产生。报告保留最短反例，自环及同标签内部步骤按原工具规则省略；不把受控报告规则升级为任意模型回答保证。`proposal` 与 `implemented` 两个历史名称的 cfg 相同，8 次执行不表示 8 种独立输入。

按 [工具配置](../../../verification/models/consumer-observations/README.md) 和 [维护合同](../../formal-verification-maintenance.md)从仓库根复现：

```sh
node scripts/verify-consumer-observations.mjs --suite flows --model RetentionDisclosure --out /absolute/new/retention-results
node --test scripts/formal-view.test.mjs scripts/formal-result-contract.test.mjs
```

[2026-11-12 图册](../../notion-statecharts-2026-11-12/README.md)保留当时输入，不覆盖其原 manifest；[当前组合模型](../../../verification/models/consumer-observations/flows/README.md)继续使用既有分层责任。此次没有新模型、真实 Notion 写入或模型调用。
