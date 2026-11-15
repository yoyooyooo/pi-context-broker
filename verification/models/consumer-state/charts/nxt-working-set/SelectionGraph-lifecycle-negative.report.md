# SelectionGraph

TLC reached 252 states and 539 steps. The chart draws 9 states and 11 arrows.
The chart does not draw 354 steps that stay in one chart state.

## NoRetiredSelection breaks
The shortest path has 5 steps:
0. 当前操作 / 保留旧选择，等待准备
1. 取消或会话换代: 操作失效，等待拒绝提交
2. 收到准备图: 操作失效，等待拒绝提交
3. 检查输出预算: 操作失效，等待拒绝提交
4. 检查 scope、snapshot、hash 与闭包: 操作失效，等待拒绝提交
5. 尝试最终提交: 违例：失效操作提交

## Rules that hold
TypeOK, SelectionRequiresChecks, FailedRefreshPreservesSelection, EachMemberKeepsOwnPin, NoDeadlock
