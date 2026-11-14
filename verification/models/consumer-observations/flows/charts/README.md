# 组合合同生成图

本批 4 张图均来自锁定 statechart/TLC 的原始 Mermaid，以 Pele 1.9.0 渲染。manifest 绑定实际输入、完整规则、源码及运行身份。两个正图分别是管理回执交接和两来源 effects；两个反例保留前源效果丢失及 unknown 降级。

- [management-receipt](management-receipt.svg) · [Mermaid](management-receipt.mmd) · [原报告](management-receipt.report.md)；15 states，16 条展示边。
- [two-acquisition-effects](two-acquisition-effects.svg) · [Mermaid](two-acquisition-effects.mmd) · [原报告](two-acquisition-effects.report.md)；85 states，21 条展示边。
- [lost-prior-effects](lost-prior-effects.svg) · [Mermaid](lost-prior-effects.mmd) · [原报告](lost-prior-effects.report.md)；85 states，23 条展示边。
- [unknown-cannot-collapse](unknown-cannot-collapse.svg) · [Mermaid](unknown-cannot-collapse.mmd) · [原报告](unknown-cannot-collapse.report.md)；85 states，23 条展示边。

前源 facts 的具体身份保留在原模型和报告，图面在拒绝/报告边界显示 effects；下游接受、完成、持久化均为回执输入端口，保留同一累计回执；本模型没有验证实际 provider 或写入操作。只隐藏终态自环，没有删改最短坏路径。原 RetentionDisclosure 历史图继续在 2026-11-12 原图册保留。

复现路径见 [维护合同](../../../../../docs/formal-verification-maintenance.md#图形产物定位与复现)。图面不构成实际 provider、生产 Notion 或任意 LLM 最终答复的证明。
