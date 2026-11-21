# DeliveryBoundary

TLC reached 279 states and 422 steps. The chart draws 21 states and 26 arrows.
The chart does not draw 200 steps that stay in one chart state.

## NoRetiredDeliveryProof breaks
The shortest path has 2 steps:
0. 已准备并选择
尚无交付证明
1. 发送选定的 root 与 Requires: 尚无完整图接受事实 / 等待本次 provider 响应
2. ReleaseActiveRoot: 操作失效，等待拒绝新证明

## Rules that hold
TypeOK, CompleteBoundGraphForActive, ProviderAcceptanceBeforeProof, CompletionBeforePersistence, PublicProjectionBeforePersistence, CurrentBranchOwnsProof, NoDeadlock
