---
name: verify-notion-consumer-state
description: "维护和验证 Notion 消费者的当前资格、缓存原始验证时间、请求顺序、取消与会话代次，以及固定 root＋Requires 选择、完整正文交付、provider 接受、turn 完成和公开投影回执。修改这些状态、实际守卫、有限模型或验证入口时使用。"
---

# Verify Notion Consumer State

[验证交接表](../../../docs/verification-routing.md) 指定 CLI 管理、消费、来源接手与 Broker 的负责人。本入口只拥有消费者状态；消费 transport、SDK capability 和独立安装包交给 [integration Skill](../verify-notion-skills-integration/SKILL.md)。不新增总验证器，不恢复旧管理或隐式 retention 模型。

在仓库根目录执行。先读 [合同与源码对应](references/contracts.md)，确定改动触及的状态所有者。

| 状态 | 实际所有者 | 模型 |
| --- | --- | --- |
| 当前资格、原始证据、观察顺序 | consumer-observation；host-skills 的精确失败归因与发布门禁 | Availability、ReadRace、FreshnessPublication |
| 完整准备与固定成员选择 | prepare-protocol、graphPreparation.commit、session-graph | SelectionGraph |
| 完整正文、provider 接受、turn、公开投影回执 | session-source-snapshot、session-active、host-skills hooks | DeliveryBoundary |
| 旧会话固定恢复、缺失闭包隔离、继续提问 | session-recovery、index restoreActive、host-skills 最终交付守卫 | RecoveryClosure |

`coverage.json` 是各套件唯一 cases 与 expected_rules 清单。名为 current 的旧缺陷配置是故意保留的负例，不是当前实现结论。本地固定 pin 不承诺远端历史恢复。

## 检查环境

使用既有锁定安装配置 `PSTACK_STATECHART_ROOT` 和 `TLA2TOOLS`，不要更换工具版本取得通过。

```sh
node .agents/skills/verify-notion-consumer-state/scripts/control.mjs doctor
```

Doctor 核完整工具哈希、受支持 Node/Bun/Java 和已有依赖。缺工具或来源不一致记 blocked；它不访问真实 Notion、不调用模型，也不证明认证。

## 执行既有检查

改变模型、入口或整体源码映射时执行完整 run；仅定位一个受影响状态时执行该模型的全部配置和对应真实守卫。

```sh
CONSUMER_STATE_EVIDENCE="$(mktemp -d /tmp/notion-consumer-state.XXXXXX)"
node .agents/skills/verify-notion-consumer-state/scripts/control.mjs run --out "$CONSUMER_STATE_EVIDENCE"
node .agents/skills/verify-notion-consumer-state/scripts/control.mjs evidence --out "$CONSUMER_STATE_EVIDENCE"
```

输出须为仓库外新建或预建的空绝对目录。run 串行执行 observations、consumer-state、实际函数/宿主 hooks 回归、两组真实守卫破坏。失败即停止，保留本次原始输出供诊断；evidence 只查保存完整性，不代替行为通过。

```sh
node scripts/verify-consumer-observations.mjs --suite consumer-state --model DeliveryBoundary --out "$(mktemp -d /tmp/consumer-delivery.XXXXXX)"
CONSUMER_MUTATION_PARENT="$(mktemp -d /tmp/consumer-guard.XXXXXX)"
node scripts/check-consumer-state-mutations.mjs --out "$CONSUMER_MUTATION_PARENT/mutation" --case public-projection-ack
```

mutation 输出目录本身须不存在。按实际变化选择 `FreshnessPublication`、`SelectionGraph`、`DeliveryBoundary` 或 `RecoveryClosure`，不复制工具内部参数。模型 runner 生成 Mermaid/report/TLC；需要展示图时依照 [图形产物复现](../../../docs/formal-verification-maintenance.md#图形产物定位与复现)，只渲染本次真实生成的图。

## 判断和修复

- 完整核对独立 expected_rules，包括 TypeOK、已声明的时序性质和 NoDeadlock。候选全部成立；负例只失败声明的集合。未穷尽、cut、超时、解析失败、未知结果都不能算通过。
- 将最短反例对应到实际函数。先查模型的原子边界、前提和有限域，不能删性质、放宽断言或改负例期待取得通过。
- source hash 漂移时先读实际 diff，确认状态所有者及实际 guard，再更新映射；不得盲目刷新 hash。包 pin/build/guidance 不是状态证明前提。
- 真守卫破坏只在 runner 的隔离副本内进行：baseline 通过、mutated 出现行为断言失败、恢复原字节后通过，并核工作树未变。语法错误、缺模块或工具故障不算检出。
- 多根完整并集、共享 Requires 冲突/批量刷新、同正文但 Requires 改变和精确 physical owner 由 `session-refresh.test.ts`、`session-active.test.ts` 补充；单根 SelectionGraph 不自动证明这些组合。
- 恢复失败走 `RecoveryClosure` 与 `session-recovery.test.ts`。有限模型检查三次提问和完整闭包；真实回放另核整轮 30 秒恢复预算、失败退避和不合作的迟到 producer。它们不证明 UI 输入或模型任务完成。

入口指令改变后，将作者实跑与冷启动评估分开。独立 agent 只取得任务、本 Skill 和必要工具配置，按所选切片执行；未做时记录 `instruction_evaluation:not_run`，不把作者结果或结构检查当成独立使用成功。

## 结果边界与清理

资格、已选择、已准备、provider 接受、turn 完成和公开投影回执分别判断。HTTP 2xx 不代表模型任务完成，返回 draft 不代表宿主已持久化；本地固定内容也不表示当前授权。

本入口不访问真实 Notion、启动真实 Pi 会话或调用模型。不证明服务线性一致性、跨机权限/墙钟竞态、实际 serializer、任意宿主或模型最终描述。独立安装与安装身份沿 integration，自然版本/恢复旅程沿 [工作流验证 Skill](../verify-notion-agent-workflows/SKILL.md)，宿主实现沿 [verify-context-broker](../verify-context-broker/SKILL.md)；OMP/Tern 延期。

只清理本轮进程和自有绝对路径，经系统 Trash；不动用户现有会话、全局配置、日用安装或未结清 operation Store。运行结果放仓库外，不在源码中累计历史图册或成绩账本。

## 当前合同和运行回执

按上文的验证交接使用配对 CLI 的合同/场景索引与薄回执。记录 actual command、源码/dirty tree、实际加载路径/bytes、机器/runtime、初态、层级和原件 hash；首次失败与复验关系保留。fixture 或受控 provider 不作为 live/natural；结构检查不代表独立 Agent 使用成功，未做时标 instruction_evaluation:not_run。
