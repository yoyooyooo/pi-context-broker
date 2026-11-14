# RetentionDisclosure

TLC reached 8 states and 9 steps. The chart draws 8 states and 7 arrows.
The chart does not draw 2 steps that stay in one chart state.

## ReadOnlyHasNoRemoteWrites breaks
The shortest path has 3 steps:
0. 严格只读；已有固定版本
1. 人修改Notion正文: 严格只读；Notion正文已经修改
2. 明确取得当前版: 严格只读；请求当前完整内容
3. 留存已观察版本: 严格只读；内部留存已发生远端写入；违反只读：已发生远端写入

## Rules that hold
TypeOK, ReadyReportsObservedRetention, NoFalseZeroWriteReport, UnknownOutcomeIsDisclosed, NoDeadlock
