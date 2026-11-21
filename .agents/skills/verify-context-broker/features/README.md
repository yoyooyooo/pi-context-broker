# Context Broker 当前验证地图

先读 [Skill](../SKILL.md) 与 [跨仓交接](../../../../docs/verification-routing.md)。按行为选择已有入口，不再经过功能包装控制器。

| 受影响行为 | 当前地图 | 执行边界 |
| --- | --- | --- |
| 普通消息、明确接受引用、注入和缺失引用 | [injection](injection.md) | input-guard、native-read-session、host-prepare；实际 Pi 另行运行 |
| 目录选择、来源消歧、自动补全 | [editor](editor.md) | 当前 completion/naming/accepted-selection 回归；原生终端专项未验收 |
| fork、恢复、压缩、取消和迟到结果 | [lifecycle](lifecycle.md) | 当前 session tests 与 consumer-state；实际 Pi 按现有 SDK 助手 |
| 当前请求中的完整内容与唯一性 | [context-once](context-once.md) | provider 和最终 serializer 证据分开 |
| Source、Views、权限和缓存 | [source](source.md) | 当前 SDK/adapter/View 测试；无 source.command |
| 实际模型对 Skill 的使用 | [model](model.md) | AH-1196/AH-1198 实际 Pi/provider；不能以 mock OK 代替 |
| 独立安装、随包 Skill、CLI/SDK 字节 | [distribution](distribution.md) | `verify-artifacts.mjs` 与安装后 SDK verifier |
| 多 Skill / Requires / Members | [依赖图](../../verify-notion-skills-integration/features/skill-dependency-graph.md) | 当前固定选择与受保护状态模型 |

当前完整代码检查是 `bun run check:broker`。跨仓消费和实际安装读 [integration Skill](../../verify-notion-skills-integration/SKILL.md)；状态模型读 [consumer-state Skill](../../verify-notion-consumer-state/SKILL.md)。只运行与本次变化相交的必要检查，完整 check 由集成者统一执行。

真实日用通过 [已有 Pi 安装/候选助手](../../verify-notion-skills-integration/features/daily-installation-ui.md) 执行。OMP/Tern 延期，旧双宿主和旧 CLI fixture 场景不再是可执行路由。每个报告列出实际执行层级；无 UI 操作或模型响应时，不宣称这些层级通过。
