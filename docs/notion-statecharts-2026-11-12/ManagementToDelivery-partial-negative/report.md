# ManagementToDelivery

TLC reached 23 states and 25 steps. The chart draws 20 states and 21 arrows.
The chart does not draw 2 steps that stay in one chart state.

## CompleteBeforeApplication breaks
The shortest path has 5 steps:
0. 作者输入尚未确认
1. 取得完整管理读回证据: 已有完整管理回执
2. 启动并发现目录: 目录候选，尚无正文
3. 明确使用该技能: 准备主文与必需依赖（根未取，必需未取）
4. 取得主文: 准备主文与必需依赖（根已取，必需未取）
5. 提交固定选择: 固定选择已提交：缺少必需规则

## Rules that hold
TypeOK, OrdinarySelectionStable, ReferenceBelongsToSelection, FreshFollowupReusesBody, NoDeadlock
