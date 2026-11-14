# AcquisitionEffects

TLC reached 85 states and 85 steps. The chart draws 20 states and 22 arrows.
The chart does not draw 10 steps that stay in one chart state.

## ConfirmedFactsPreserved breaks
The shortest path has 5 steps:
0. 检查 SDK 能力
1. 开始获取: 来源一待获取
2. 来源一留存写: 来源一已写等待回执
3. 观察来源一回执: 来源一完成
4. 来源二无写完成或失败取消: 合并来源结果
5. 保留累计事实: 失败或取消不提交新选择；effects=none；已知留存事实丢失

## NoFalseZeroWriteReport breaks
The shortest path has 6 steps:
0. 检查 SDK 能力
1. 开始获取: 来源一待获取
2. 来源一留存写: 来源一已写等待回执
3. 观察来源一回执: 来源一完成
4. 来源二无写完成或失败取消: 合并来源结果
5. 保留累计事实: 失败或取消不提交新选择；effects=none；已知留存事实丢失
6. 按受控规则报告: 受控报告完成；effects=none；已知留存事实丢失；错误零写声明

## Rules that hold
TypeOK, UnknownEffectIsSticky, CompleteSelectionOnly, StrictReadOnlyHasNoWrites, CompatibleSdkBeforeDispatch, NoDeadlock
