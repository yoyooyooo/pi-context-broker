---
name: verify-notion-consumer-state
description: "维护和验证 Notion 消费者的当前资格、缓存原始验证时间、请求顺序、取消与会话代次，以及固定 root＋Requires 选择、完整正文交付、provider 接受、turn 完成和持久化回执。修改这些状态、源码守卫或其验证资产时使用；不接管操作恢复、HTTP 调度或跨域 effects 组合。"
---

# Verify Notion Consumer State

## 管理与消费的跨仓验证路由

[验证交接表](../../../docs/verification-routing.md) 明确 CLI 的管理、消费、来源接手三入口与本仓原 guardian 的职责。本 Skill 仍负责原宿主/状态/组合范围；不复制 CLI 的作者操作测试，不由 Source ready、目录项或一次read推断完整投递。

在仓库根目录执行。先读 [合同与源码对应](references/contracts.md)，确认本次触及资格、选择或交付中的哪一层。一个 Skill 维护多个小模型；不能把这些状态合成一个成功字段。

## next 本轮边界

消费 transport 收敛先运行 [现有 integration Skill 的有限入口](../verify-notion-skills-integration/SKILL.md#next-单轨有限验收)。本 Skill 仍维护资格、取消、代次和投递状态；只有这些语义或守卫实际变化时才选择相应小模型复验。不得仅为清理旧 CLI fixture 重跑所有模型、自动改源码 hash 或增加一层验证平台。保持当前身份、完整 manifest 和只读约束；OMP/Tern 本轮未运行。

## 状态所有者

| 状态 | 实际所有者 | 本入口 |
| --- | --- | --- |
| 当前资格、原始证据与观察顺序 | consumer-observation；host-skills 的精确失败归因与发布门禁 | 保留 Availability/ReadRace，新增 FreshnessPublication |
| 准备结果与固定版本组合 | prepare-protocol、graphPreparation.commit、session-graph | SelectionGraph |
| 完整正文、provider 接受、turn 完成、公开投影回执 | session-source-snapshot、session-active、host-skills provider/boundary hooks | DeliveryBoundary |

原 Availability/ReadRace 的六份配置、F1–F7、order/cursor/generation 负例保留原位；它们的历史 current 失败不是现实现失败。新增范围和原入口整理分别记账。

## 先检查环境

沿已有锁定安装配置 PSTACK_STATECHART_ROOT 与 TLA2TOOLS，使用仓库已经支持的 Node、Bun、Java。不要为得到通过更新工具锁、下载替代版本或更换模型检查器。

~~~sh
node .agents/skills/verify-notion-consumer-state/scripts/control.mjs doctor
~~~

Doctor 核对原 statechart/TLC 的完整工具哈希，输出实际版本与范围。缺失工具、依赖或来源不一致是 blocked；不表示认证失败，也不创建真实服务请求。

## 完整复跑

~~~sh
CONSUMER_STATE_EVIDENCE="$(mktemp -d /tmp/notion-consumer-state.XXXXXX)"
node .agents/skills/verify-notion-consumer-state/scripts/control.mjs run --out "$CONSUMER_STATE_EVIDENCE"
node .agents/skills/verify-notion-consumer-state/scripts/control.mjs evidence --out "$CONSUMER_STATE_EVIDENCE"
~~~

输出须在仓库外、为新建或预建的空绝对目录。run 串行执行原观察模型、新消费者模型、受控真实函数/宿主 hooks 回归、原两项实际守卫破坏及新增守卫破坏。任何失败停止，保留 manifest、原始 stdout/stderr、模型输入、TLC 输出、报告、生成图、各隔离副本和恢复回执。evidence 只核保存完整性；不能把它代替行为通过。

仅定位一个已知模型问题时复用稳定仓库入口：

~~~sh
node scripts/verify-consumer-observations.mjs --suite consumer-state --model FreshnessPublication --out "$(mktemp -d /tmp/consumer-freshness.XXXXXX)"
node scripts/verify-consumer-observations.mjs --suite consumer-state --model SelectionGraph --out "$(mktemp -d /tmp/consumer-selection.XXXXXX)"
node scripts/verify-consumer-observations.mjs --suite consumer-state --model DeliveryBoundary --out "$(mktemp -d /tmp/consumer-delivery.XXXXXX)"
~~~

TLA+ 模型的检查与图使用 /statechart，通过仓库稳定 runner 取得锁定工具。不要把工具内部脚本或易变参数复制到此 Skill。模型命令产 Mermaid/report/TLC；Pele SVG 的可定位环境、公开渲染步骤和图册绑定见 [图形产物复现](../../../docs/formal-verification-maintenance.md#图形产物定位与复现)。新图必须来自本次 spec/config/view 的实际执行，展示时同时保留原始 Mermaid、Pele SVG 与报告；图本身不证明生产实现正确。

## 判定与修复

- 在 coverage.json 唯一 cases 清单中核对完整 expected_rules，包括 TypeOK 和 NoDeadlock。candidate 的业务规则全部成立，负配置仅失败声明的规则；完整穷尽且未 cut 才成立。解析失败、超时、未知结果、未执行不是反例。
- 将最短反例对应到实际函数回放。模型与实现不一致时先检查模型的原子边界、初始前提与有限规模，不能删性质或放宽断言取得通过。
- 实现被证实有缺陷时保留原反例，修复真实守卫、补受控回归，再更新源码对应哈希。只改 hash 不能完成维护。
- 对真实代码的破坏必须在 runner 的独立副本内完成；要求 baseline 成功、mutated 出现行为断言失败、恢复字节后成功，并核对工作树源码未变。语法错误、缺模块、工具故障不算检出。
- source hash 失配时先读实际 diff，确认状态所有者和原子步骤是否变化，再更新对应模型、负配置、回放与 coverage。共享 runner/CI 的合同属于原正式入口，不在此另建一份检查协议。

提交模型或入口变更前，作者完成完整 run；让一个新 agent 只拿任务、此 Skill 和必要工具配置，独立执行一个受影响的新模型及其实际守卫破坏，读回原始反例和恢复回执。冷检记录所选切片，不把它扩称全批独立复验；冷检未完成时保留 draft 状态，不继承作者自己的运行结果。维护入口是 /maintain-formal-verification-skill。

例如交付投影切片可选上面的 DeliveryBoundary 命令，再执行：

~~~sh
CONSUMER_MUTATION_PARENT="$(mktemp -d /tmp/consumer-guard.XXXXXX)"
node scripts/check-consumer-state-mutations.mjs --out "$CONSUMER_MUTATION_PARENT/mutation" --case public-projection-ack
~~~

mutation 输出目录本身须不存在；保留父目录及原始失败/恢复 transcript，不对真实安装或工作树应用破坏。

## 证明边界

NXT12 工作集变更复用 SelectionGraph/DeliveryBoundary。执行每个受影响模型的完整配置，并跑 `session-active.test.ts` 中完整并集预算、共享 Requires、旧 pin、释放与正在准备的旧 use 回归。`session-active-session.mjs` 验证实际安装 SessionManager 的独立进程 resume/fork/compaction；`scripts/notion-sdk-pi.mjs --scenario working-set --provider-backend http` 另验实际 RPC、公开工具和序列化请求正文。三层各自留证；不要将状态层成功写成真实模型或真实 Notion 成功。主合同位于 CLI 仓库 `.cursor/skills/verify-ntn-skills/features/nxt-delivery.md`。

这些模型是有限设计合同，真实代码回归与守卫破坏是独立的实现证据；源码 hash 只绑定审阅版本。资格可变，固定内容不可变；固定 pin、已选择、已准备均不是当前授权或交付证明。2xx 接受也不是模型完成；boundary draft 不是已持久化回执。

本入口不访问真实 Notion、调用模型或安装宿主，不证明 HTTP 线性一致性、任意权限/墙钟/跨机竞态、任意宿主行为或 LLM 的最终描述。effects 与跨域组合继续用 [verify-notion-skills-integration](../verify-notion-skills-integration/SKILL.md)，完整宿主/UI/安装验证继续用 [verify-context-broker](../verify-context-broker/SKILL.md)。

相关 Notion 文档由项目发布流程按实际执行回执更新；保留原失败与未执行项。历史证据不删除，不操作用户现有会话、全局配置或主仓脏文件。
