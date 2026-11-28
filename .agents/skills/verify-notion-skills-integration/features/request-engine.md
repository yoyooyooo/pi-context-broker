# 当前请求与限额验证

请求引擎由CLI/core拥有；Broker通过同包SDK使用它。跨仓输入按 [integration Skill](../SKILL.md) 绑定，状态性质按 [consumer-state Skill](../../verify-notion-consumer-state/SKILL.md) 复验。这里只定义实际请求观察边界。

保留分页、并发、队列、retry/backoff、cancel和预算守卫。Notion查询POST属于metadata，其他语义写入不可被归为读取。目录只投影必要列；未选正文和资源不预取；完整正文不可为减少请求而截断。

现有 `safeRequestMetrics` 与请求ledger只接收有界、安全的实际metrics，不收集credential、headers或任意原始URL。trace缺失、drop或无法归属时记unknown，不填零。请求数量、request/response bytes、正文bytes、队列与retry时间分开；相同snapshot ID不是cache命中的证据。

源码覆盖当前SDK/adapter/cache/host-prepare；真实HTTP由现有installed SDK verifier执行。它检查未声明请求、分页、取消、精确owner/scope、零语义写入与零CLI正文子进程。CLI的真实Node/SQLite与请求调度回归由其既有验证Skill负责，不在Broker复制runner。

真实Notion、实际Pi/provider和模型成本沿 [日用地图](daily-installation-ui.md)。控制HTTP的零外部网络不能冒称真实冷服务成本；模型没有结束时整任务usage保持unknown。OMP/Tern与原生终端本轮不提供成绩。
