# RetentionDisclosure

TLC reached 8 states and 9 steps. The chart draws 8 states and 7 arrows.
The chart does not draw 2 steps that stay in one chart state.

## ReadyReportsObservedRetention breaks
The shortest path has 4 steps:
0. 已有固定版本
1. 人修改Notion正文: Notion正文已经修改
2. 明确取得当前版: 请求当前完整内容
3. 留存已观察版本: 内部留存已发生远端写入
4. 返回正文及本次效果: 工具返回完整正文；未披露效果：留存副作用未披露

## NoFalseZeroWriteReport breaks
The shortest path has 5 steps:
0. 已有固定版本
1. 人修改Notion正文: Notion正文已经修改
2. 明确取得当前版: 请求当前完整内容
3. 留存已观察版本: 内部留存已发生远端写入
4. 返回正文及本次效果: 工具返回完整正文；未披露效果：留存副作用未披露
5. 按模型规定的报告规则输出: 受控报告规则已输出；未披露效果；报告零写入：留存副作用未披露、错误声称零写入

## Rules that hold
TypeOK, ReadOnlyHasNoRemoteWrites, UnknownOutcomeIsDisclosed, NoDeadlock
