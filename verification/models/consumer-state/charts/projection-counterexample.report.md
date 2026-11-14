# DeliveryBoundary

TLC reached 167 states and 248 steps. The chart draws 15 states and 16 arrows.
The chart does not draw 123 steps that stay in one chart state.

## PublicProjectionBeforePersistence breaks
The shortest path has 4 steps:
0. 已准备并选择
尚无交付证明
1. 发送选定的 root 与 Requires: 尚无完整图接受事实 / 等待本次 provider 响应
2. 观察响应头与完整图证明: 已有完整图接受事实 / 2xx 已接受完整固定图
3. 观察 turn 结束状态: 已有完整图接受事实 / turn 已完成，尚未持久化
4. 尝试生成边界 draft，或拒绝: 违例：未观察到公开投影

## Rules that hold
TypeOK, CompleteBoundGraphForActive, ProviderAcceptanceBeforeProof, CompletionBeforePersistence, NoRetiredDeliveryProof, CurrentBranchOwnsProof, NoDeadlock
