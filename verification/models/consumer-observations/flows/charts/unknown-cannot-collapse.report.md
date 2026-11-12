# AcquisitionEffects

TLC reached 85 states and 85 steps. The chart draws 19 states and 22 arrows.
The chart does not draw 10 steps that stay in one chart state.

## UnknownEffectIsSticky breaks
The shortest path has 5 steps:
0. 检查 SDK 能力
1. 开始获取: 来源一待获取
2. 来源一确认无写: 来源一完成
3. 来源二留存写: 来源二已写等待回执
4. 来源二 ACK 未知: 合并来源结果
5. 保留累计事实: 失败或取消不提交新选择；effects=none；未知被降级

## NoFalseZeroWriteReport breaks
The shortest path has 6 steps:
0. 检查 SDK 能力
1. 开始获取: 来源一待获取
2. 来源一确认无写: 来源一完成
3. 来源二留存写: 来源二已写等待回执
4. 来源二 ACK 未知: 合并来源结果
5. 保留累计事实: 失败或取消不提交新选择；effects=none；未知被降级
6. 按受控规则报告: 受控报告完成；effects=none；未知被降级；错误零写声明

## Rules that hold
TypeOK, ConfirmedFactsPreserved, CompleteSelectionOnly, StrictReadOnlyHasNoWrites, CompatibleSdkBeforeDispatch, NoDeadlock
