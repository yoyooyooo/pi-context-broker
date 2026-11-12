# 核心消费流程 Statechart

这是 2026-11-12（Asia/Manila）发布到 [Notion 验证策略](https://app.notion.com/p/4125636c236e819bba12c71af9a0c0f5) 的可复现图件快照。项目第一入口是 [Notion Skills](https://app.notion.com/p/4125636c236e81f28894e4bbb4eab711)，后续维护由 [AH-1006](https://linear.app/yoyooyooo/issue/AH-1006) 跟踪。

## 本次检查

- 产品源码基线：`f2f725703c5d6afe1d89c76148abfc3fbf521085`。
- 使用现有 `verify-consumer-observations.mjs --suite flows`，完整执行 2 个模型、13 个正负配置。
- TLA 和 config 保持原字节。本次仅修订 view：将抽象上下文与真实回答分开描述，将未披露效果与显式 unknown 分开显示。
- 13 个配置全部符合原定预期；5 个正向配置的性质成立，8 个历史/故意破坏配置命中指定性质。
- 没有新执行产品 mutation、真实 Notion、Pi、provider 或性能实验。负例图不构成当前产品仍有该缺陷的断言。
- `manifest.json` 保存每组状态数、性质结果、输入与图件 SHA256。完整原始 TLC 和初次标题呈现记录保留在 Pro 的 `verification-evidence/statecharts-20261112/broker/`。

## 建议阅读

| 图件 | 要回答的问题 | 结果 |
| --- | --- | --- |
| [完整准备与固定版本](ManagementToDelivery-implemented/chart.svg) · [Mermaid](ManagementToDelivery-implemented/chart.mmd) · [报告](ManagementToDelivery-implemented/report.md) | 主文与 Requires 完整后才提交，普通续问保版，明确刷新退役旧参考 | 15 状态，性质成立 |
| [混用旧参考的反例](ManagementToDelivery-mixed-reference-negative/chart.svg) · [报告](ManagementToDelivery-mixed-reference-negative/report.md) | 刷新只更新主文却保留旧参考会怎样 | 命中 ReferenceBelongsToSelection |
| [留存效果披露](RetentionDisclosure-implemented/chart.svg) · [Mermaid](RetentionDisclosure-implemented/chart.mmd) · [报告](RetentionDisclosure-implemented/report.md) | 固定读取与当前留存分别报告什么 | 8 状态，性质成立 |
| [严格只读](RetentionDisclosure-read-only/chart.svg) · [Mermaid](RetentionDisclosure-read-only/chart.mmd) · [报告](RetentionDisclosure-read-only/report.md) | 需要留存时在哪里拒绝远端写入 | 7 状态，性质成立 |
| [ACK 丢失后的未知结果](RetentionDisclosure-unknown/chart.svg) · [Mermaid](RetentionDisclosure-unknown/chart.mmd) · [报告](RetentionDisclosure-unknown/report.md) | 操作失败后为何不能声称零写入 | 8 状态，性质成立 |
| [有回执仍错误报告的反例](RetentionDisclosure-claim-negative/chart.svg) · [报告](RetentionDisclosure-claim-negative/report.md) | 结构化效果存在是否保证任意回答准确 | 命中 NoFalseZeroWriteReport |

其余配置的 SVG、Mermaid 和原报告同目录保留，完整清单见 manifest。图由锁定的 Pstack statechart 生成，再由 `pele@1.9.0` 渲染；Mermaid 原文未手改。Notion 展示时仅把 title frontmatter 移至外部标题，状态、箭头和违规标记保持生成内容。

## 性质与边界

ManagementToDelivery 限定一个根、一条 Requires、一份 reference、两个版本和一次有序编辑循环。PublishVerified 是已完成管理读回的前提；图中的上下文是抽象状态，不表示远端多页事务、真实 payload 或模型最终回答已经完成。逻辑正文取得次数不能推导 HTTP 请求数、延迟或 token 成本。

RetentionDisclosure 限定一次读取和一次抽象留存事件。Report 是模型规定的受控报告规则，不能保证任意 LLM 遵守。多来源部分失败、JavaScript 调度、实际权限与所有长期会话仍按明确实现回归和真实证据验收。

终态自环和同标签内部步骤由生成器按原规则省略；每份 report 记录具体数量。各个坏性质及完整最短轨迹保留在 report 与原始 TLC 中。超出完整图预算的行为沿上游工具规程处理，不把图的可读性等同于证明范围。

## 复现

按 [模型 README](../../verification/models/consumer-observations/README.md) 设置固定 `PSTACK_STATECHART_ROOT` 与 `TLA2TOOLS`，在本提交运行：

```sh
node scripts/verify-consumer-observations.mjs --out /absolute/new/flow-output --suite flows
```

使用全新仓外输出目录。检查 summary.complete、各项 matches、探索未截断及每项性质终态。查看每份 chart.mmd/report.md；SVG 使用 Pele 1.9.0 的 render，参数为 `{ limit: 1000000, outputLimit: 8000000, maxEdges: 10000 }`。

后续改动沿 [模型对应](../../verification/models/consumer-observations/flows/coverage.json) 与既有 integration 维护。生成新图时保留旧精确快照及失败事实，不用新图覆盖历史运行结论。
