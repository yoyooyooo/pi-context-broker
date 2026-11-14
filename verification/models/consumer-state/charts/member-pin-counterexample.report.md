# SelectionGraph

TLC reached 144 states and 288 steps. The chart draws 8 states and 9 arrows.
The chart does not draw 174 steps that stay in one chart state.

## EachMemberKeepsOwnPin breaks
The shortest path has 4 steps:
0. 当前操作 / 保留旧选择，等待准备
1. 收到准备图: 当前操作 / 图已准备，检查尚未完成
2. 检查输出预算: 当前操作 / 预算已检查，身份待检查
3. 检查 scope、snapshot、hash 与闭包: 当前操作 / 身份与预算均已检查
4. 尝试最终提交: 违例：根 pin 覆盖了依赖 pin

## Rules that hold
TypeOK, SelectionRequiresChecks, FailedRefreshPreservesSelection, NoRetiredSelection, NoDeadlock
