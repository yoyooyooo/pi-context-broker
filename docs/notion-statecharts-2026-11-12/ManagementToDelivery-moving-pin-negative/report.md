# ManagementToDelivery

TLC reached 15 states and 16 steps. The chart draws 15 states and 15 arrows.
The chart does not draw 1 steps that stay in one chart state.

## OrdinarySelectionStable breaks
The shortest path has 9 steps:
0. 作者输入尚未确认
1. 取得完整管理读回证据: 已有完整管理回执
2. 启动并发现目录: 目录候选，尚无正文
3. 明确使用该技能: 准备主文与必需依赖（根未取，必需未取）
4. 取得必需依赖: 准备主文与必需依赖（根未取，必需已取）
5. 取得主文: 准备主文与必需依赖（根已取，必需已取）
6. 提交固定选择: 固定选择已提交
7. 读取该选择的固定参考: 固定参考已进入抽象上下文
8. 完成Notion内容修改: Notion已更新，原选择保留
9. 普通续问: 普通续问完成，检查固定版本：普通续问换版

## Rules that hold
TypeOK, CompleteBeforeApplication, ReferenceBelongsToSelection, FreshFollowupReusesBody, NoDeadlock
