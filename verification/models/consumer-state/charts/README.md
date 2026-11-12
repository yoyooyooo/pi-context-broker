# 消费者状态生成图

本图册由锁定 statechart/TLC 的实际模型结果生成，以 Pele 1.9.0 渲染。三张正图和三张代表反例共用同一完整 24 配置运行；每份原始 Mermaid、报告、输入及源码 hash 均由 [manifest](manifest.json) 绑定。

| 图 | 类型 | 模型状态 | 展示状态 / 转移 | 原报告 |
| --- | --- | ---: | ---: | --- |
| [资格与原始证据](qualification.svg) · [Mermaid](qualification.mmd) | 正例 | 158 | 10 / 19 | [报告](qualification.report.md) |
| [各成员固定选择](selection.svg) · [Mermaid](selection.mmd) | 正例 | 144 | 8 / 9 | [报告](selection.report.md) |
| [接受、完成与持久化](delivery.svg) · [Mermaid](delivery.mmd) | 正例 | 201 | 20 / 24 | [报告](delivery.report.md) |
| [过期缓存错误发布](expired-cache-counterexample.svg) · [Mermaid](expired-cache-counterexample.mmd) | 受控反例 | 164 | 11 / 19 | [报告](expired-cache-counterexample.report.md) |
| [根 pin 错误覆盖依赖](member-pin-counterexample.svg) · [Mermaid](member-pin-counterexample.mmd) | 受控反例 | 144 | 8 / 9 | [报告](member-pin-counterexample.report.md) |
| [draft 被提前当成持久化](projection-counterexample.svg) · [Mermaid](projection-counterexample.mmd) | 受控反例 | 167 | 15 / 16 | [报告](projection-counterexample.report.md) |

## 本次仅修订图面

SelectionGraph 原正例的模型规则全部成立，但旧 view 把 statechart 的 1-based TLA sequence 当作普通 JavaScript 字符串，错误显示根 pin 覆盖依赖。现在按 selected[1]/selected[2] 读取，并用 [窄显示回归](../SelectionGraph.view.test.mjs) 保护。旧 full-final-01 与冷执行证据保留；本次未修改任何 TLA、cfg、生产源码、Skill 或 control。24 份配置的状态数与失败规则集合和前次完整运行逐项一致。

## 读图边界

资格、固定选择、provider 接受、turn 完成与实际公开投影 ACK 保持不同含义。两次请求内的重试仍使用原固定组合；被舍弃的 draft 不推进 persisted。已经发生的 2xx 接受是历史事实，分支回退后不能把它当作当前有效分支的新证明。

视图合并同语义 scenario、取消/会话换代及失效后的收口路径；所有命名动作仍返回标签，没有主动隐藏箭头。工具不绘制同一展示状态内的步骤，其中包含重复返回、等待、检查和终态保持；每图原报告列出该计数。不同显式违例组合和“已接受后离开分支”的状态保持分开，完整规则结果与最短反例留在原报告和原始 TLC 输出。展示转移数不包含起点箭头，manifest 另列含起点的计数。

这些图是有限状态合同的投影，不证明实际 provider wire、生产 Notion 或任意 LLM 最终回答。完整复跑见 [消费者 Skill](../../../../.agents/skills/verify-notion-consumer-state/SKILL.md)，Pele 复现见 [维护合同](../../../../docs/formal-verification-maintenance.md#图形产物定位与复现)。
