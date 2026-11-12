# FV06 管理回执与部分失败的效果交接

由本 Skill 继续维护三个小型组合模型，复用原 `scripts/verify-consumer-observations.mjs --suite flows`。完整模型、有限域、源函数、输入端口及历史 E2E 身份见 [flows README](../../../../verification/models/consumer-observations/flows/README.md) 和对应 `coverage.json`。

| 模型 | 主要合同 | 必须保留的边界 |
| --- | --- | --- |
| ManagementToDelivery | 完整管理回执、完整准备、普通续问固定版本、明确刷新处理旧参考 | context 为抽象状态；原 operation 未知不被独立接受改写 |
| RetentionDisclosure | ready 披露留存、严格只读、未知 ACK、受控零写报告 | 原 current/claim/read-only/unknown 反例保留；不证明任意 LLM |
| AcquisitionEffects | 两来源部分失败/取消累计 effects，能力与语义写门槛，完整选择 | 两次有序 acquisition；真实 delivery 证明由 consumer-state 和原生会话证据负责 |

运行前按 [维护合同](../../../../docs/formal-verification-maintenance.md) 核对来源与固定工具。`--suite flows` 跑完整 24 配置；`--model ManagementToDelivery|RetentionDisclosure|AcquisitionEffects` 跑一个完整模型组。默认不带 suite 的原观察 6 配置不变。

```sh
node scripts/verify-consumer-observations.mjs --suite flows --out /absolute/new/flow-results
node scripts/check-effects-composition-mutations.mjs --out /absolute/new/effects-guards
bun test packages/context-broker/scripts/formal-effects-composition.test.ts packages/context-broker/scripts/host-prepare.test.ts packages/context-broker/scripts/notion-sdk.test.ts
```

模型输出使用新建或预先创建的空绝对目录；mutation 输出目录本身必须尚不存在。确认完整规则集合和精确负例集合；保留全部失败、原 TLC、report、Mermaid 与输入 hash。7 个真实 guard 破坏必须由行为断言捕获，恢复后通过；不能把语法/缺模块错误当作正确拒绝。

当前资格和实际交付的改变先走 [verify-notion-consumer-state](../../verify-notion-consumer-state/SKILL.md)；CLI ACK/独立接受的改变走另一仓库 verify-notion-operation-recovery，再核对本组合模型的输入前提。跨领域只复验变化的交接，不以更新 hash 替代实际审阅，不开启全批日用 E2E。

