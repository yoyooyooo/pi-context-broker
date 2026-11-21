# NXT 工作集生成图

这些图来自本轮 `SelectionGraph` 与 `DeliveryBoundary` 的原始 `chart.mmd`，由固定字节的 Pele 1.9.0 渲染。两个模型各自完整的 7 份配置已检查；本目录保存 4 张代表图，[manifest](manifest.json) 绑定输入、原报告、完整规则结果和外部完整 14 图清单。

| 图 | 核对内容 | 原始报告 |
| --- | --- | --- |
| [固定选择与闭包预算](SelectionGraph-candidate.svg) · [Mermaid](SelectionGraph-candidate.mmd) | 保留与新增的完整成员预算、原 pin、准备中的根释放 | [报告](SelectionGraph-candidate.report.md) |
| [失效后仍提交的反例](SelectionGraph-lifecycle-negative.svg) · [Mermaid](SelectionGraph-lifecycle-negative.mmd) | 缺少代次守卫时，迟到选择破坏 `NoRetiredSelection` | [报告](SelectionGraph-lifecycle-negative.report.md) |
| [释放与历史交付事实](DeliveryBoundary-candidate.svg) · [Mermaid](DeliveryBoundary-candidate.mmd) | 当前有效性与已经接受、完成、公开投影、持久化的历史事实 | [报告](DeliveryBoundary-candidate.report.md) |
| [失效后仍新增交付证明的反例](DeliveryBoundary-lifecycle-negative.svg) · [Mermaid](DeliveryBoundary-lifecycle-negative.mmd) | 缺少生命周期守卫时，迟到结果破坏 `NoRetiredDeliveryProof` | [报告](DeliveryBoundary-lifecycle-negative.report.md) |

现有 view 把显式 `ReleaseActiveRoot` 与到达相同展示状态的取消、换代动作聚合在同一条边上；原生成标签保留这几个动作。没有手画替代图、删掉坏路径或修改最短反例。状态内重复步骤仍按原 statechart 工具的聚合规则计入报告。

这是有限域的状态合同检查。任意规模 Requires 图、实际权限和网络字节、Pi 会话恢复及真实模型任务由独立源码和运行证据验证；图中的接受事实不能替代那些结果。
