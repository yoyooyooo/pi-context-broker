# RetentionDisclosure

TLC reached 8 states and 9 steps. The chart draws 7 states and 7 arrows.
The chart does not draw 2 steps that stay in one chart state.

## UnknownOutcomeIsDisclosed breaks
The shortest path has 4 steps:
0. 已有固定版本
1. 人修改Notion正文: Notion正文已经修改
2. 明确取得当前版: 请求当前完整内容
3. 留存已观察版本: 内部留存已发生远端写入
4. 原写入ACK丢失: 原写入ACK丢失，操作返回失败；未披露效果

## Rules that hold
TypeOK, ReadyReportsObservedRetention, NoFalseZeroWriteReport, ReadOnlyHasNoRemoteWrites, NoDeadlock
