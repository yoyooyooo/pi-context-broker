---
name: verify-context-broker
description: "验证当前 Context Broker 的 Pi 注入、目录与资源消费、会话生命周期和独立安装包。修改这些行为或验收产物时使用；真实 Pi 日用、模型效果与原生终端分别验收，OMP/Tern 延期。"
---

# Verify Context Broker

## 选择当前入口

从 [功能地图](features/README.md) 选择受影响的范围，复用已有测试和实际宿主助手。当前只有 `next` 协议：公开引用使用 `skill://`，Library 身份是 canonical root page UUID，消费经同包 SDK v3。`source.command`、旧 CLI 正文消费和 export 回退都不属于有效验证输入。

[验证交接表](../../../docs/verification-routing.md) 指定 CLI 管理、消费、Source 接手与 Broker 的职责。本文负责 Broker 实现与集成边界；自然用户旅程与 Agent 认知交给 [工作流验证 Skill](../verify-notion-agent-workflows/SKILL.md)，作者正文和 Notion 多表治理交给 CLI 原有领域 Skill。

| 变化 | 现有入口 | 必须保留的结论边界 |
| --- | --- | --- |
| 当前目录、选择、注入、资源、会话状态 | `bun run check:broker`，按改动先跑对应测试 | 源码回归不证明实际安装或 Pi 会话 |
| 跨仓 SDK、包内运行时、安装后的 HTTP 消费 | [integration Skill](../verify-notion-skills-integration/SKILL.md)；`scripts/verify-artifacts.mjs` | 同一 CLI/SDK 候选，实际独立安装与 current HTTP |
| 资格、固定选择、取消、provider/turn/投影状态 | [consumer-state Skill](../verify-notion-consumer-state/SKILL.md) | 审模型、受保护 guard 与反例；不刷新 hash 放行 |
| 实际 Pi 的 SDK/工具/serializer 行为 | `scripts/notion-sdk-pi.mjs` 现有入口 | 记录所选场景与实际安装；受控 provider 不证明模型理解 |
| 自然用户旅程与 Agent 选路 | [工作流验证 Skill](../verify-notion-agent-workflows/SKILL.md) | 真实 worker、当前请求和独立业务读回；不以结构检查代填 |
| 真实 Notion 与日用 Pi | `scripts/verify-pi-daily-installation.mjs` 的 plan/run/aggregate/candidate-plan/candidate-run | 两机 aggregate 只证明本次普通入口与 metadata；正文、取消与模型结果分别记录 |

OMP/Tern 产品代码保留，当前验收延期。旧双宿主控制器、旧 CLI fixture 总入口和旧原生 UI/PTY 驱动已删除。真实 Pi 助手仍在；原生终端菜单、光标和 UI 操作须有对应实测，不能由源码、RPC 或安装包结果推断。

## 构建和源码检查

所有命令从 Broker 根目录执行。先选定同一提交的完整 CLI/SDK 包，按 integration Skill 设置 `NTN_SKILLS_BUILD_ENTRY` 与真实 decoder 的 `CONTEXT_BROKER_GRAPH_CORE`。不混用发布版和源码候选，不把 `NTN_SKILLS_DEV_ROOT` 带入子进程。

```sh
node scripts/skill-consumption-contract.mjs check-gates
bun run check:broker
```

接线检查只验证实际 check、CI/publish 和安装路径连接正确；第二条才执行 Broker 当前检查。仅修改局部逻辑时先跑地图指定的现有测试；满足所需范围后不重复全套。`build:broker` 只构建当前 Broker，不隐式构建 Tern。

## 实际 Pi 与日用

实际 Pi 场景读取原助手的公开参数：

```sh
node scripts/notion-sdk-pi.mjs --help
node scripts/verify-pi-daily-installation.mjs candidate-plan --config /absolute/current-candidate.json
```

命令中的绝对路径是占位，按合同索引 required_inputs 补齐自有配置。候选配置应指向有效 Pi 配置实际使用的安装、当前 Notion 库和本轮自有输出。计划结果不是执行结果。真实表切换与日用安装就绪后，按 [日用地图](../verify-notion-skills-integration/features/daily-installation-ui.md) 执行公开动作；candidate-run 仅为项目级候选，不替代每机日用 run。候选实现模块没有独立 CLI；不用旧 CLI fixture 填补缺失输入。

缺失引用、取消与会话恢复分别沿 [injection](features/injection.md)、[lifecycle](features/lifecycle.md)；当前请求只保留一份必要正文沿 [context-once](features/context-once.md)。模型效果沿 [model](features/model.md)，只在已有授权覆盖的 provider/model 上运行。

## 结果与清理

分别报告 Source ready、目录完整、固定文件、正文进入实际 provider/serializer、turn 完成和宿主投影。源码测试、受控 HTTP、独立安装、真实 Pi、真实 Notion和模型效果不能相互代填。权限或完整性失败必须保持失败；不因为缓存中有旧文件就恢复当前资格。

保留实际命令、候选身份、退出结果和原助手产生的必要诊断；不新增总 manifest、历史版本或统一证据平台。只用本轮自有绝对目录，不改用户全局配置、凭据或正在使用的会话。清理先确认自有进程已退出，再将对应 scratch 移入系统 Trash；保留失败结果，不执行永久删除、批量 kill 或 git clean/reset。

仅改 Skill/路由时运行已有 `node --test scripts/verification-skill-routing.test.mjs scripts/skill-consumption-contract.test.mjs`。作者的结构检查与独立 agent 冷启动评估分开，后者未做时记录 `instruction_evaluation:not_run`。

## 当前合同和运行回执

按上文的验证交接使用配对 CLI 的合同/场景索引与薄回执。记录 actual command、源码/dirty tree、实际加载路径/bytes、机器/runtime、初态、层级和原件 hash；首次失败与复验关系保留。fixture 或受控 provider 不作为 live/natural；结构检查不代表独立 Agent 使用成功，未做时标 instruction_evaluation:not_run。

自然任务与工具必要性由 [工作流验证 Skill](../verify-notion-agent-workflows/SKILL.md) 单独负责；本入口承接实际 adapter、注入和工具实现修复。复验保留普通 Pi 与适用的 -ns 对照、真实 worker、零不必要 notion_use（含失败）、查看与采用边界及故障后继续，不给被测 Agent 预填工具路线。
