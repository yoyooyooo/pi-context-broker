# 资源读取重分析：恢复可信判断，再选择下一项收益验证

本轮先将 Benchmark 的共享源码同步到已审查的 `next`，再使用原始记录修正资源读取判定。原产品没有重新执行，原业务结果、请求、token 用量和实际耗时都没有改变。已取得的收益是纠正错误判断、复用已有实验，并排除据此增加强制重读或关闭 CodeMode 的错误方向。

完整重评原工程六个 scope 的 34 条观察，业务仍为 34 条通过；完整合同清点从 **21 pass / 2 fail / 11 unknown 变为 29 pass / 0 fail / 5 unknown**。10 条读取取得了严格的来源关联，其中 8 个 episode 恢复为完整通过；另外 2 条虽然资源合同闭合，仍因独立的 legal-selection 缺证保持 unknown。新增真实模型请求、产品执行和科学注册均为 **0**。

## 当前源码与旧实验各自保持身份

共享产品与验证代码吸收 `next` `41cce74bbe360327a7947ccba83f9ea722bf475f`，配对 CLI 为 `6727bea66a3aaea3368a5cc8f84fad83e67d21c1`。集成使用 Benchmark 历史上的新线性提交，保留已发布历史；原 `benchmark/results` 中的 15,429 个文件未改写。原比较的计划、材料、产品构建和 raw 继续沿冻结身份解释，源码同步不代表旧实验迁移到 SDK v3。

采集修复提交为 `7490cbebb6729f466dc6b99eef485e7892b2e7b2`，collector 为 `1.2.2`。历史解释器仅处理保留的 SDK v2 / resource-read v1 / Skill ref v1 / preparation evidence v2，应用前已验证原计划到 build receipt、runtime manifest 与 SDK 字节的关联。它属于 Benchmark 分析，不提供当前生产 SDK 的旧协议回退。

当前 live Benchmark fixture 仍需对所选旅程完成 `--entry` / `--database` 到 `--library` 及其分析合同的适配，使用新冻结构建完成装载检查后才能比较新行为。离线重评和源码同步不替代这一步。实施边界见[运行指南](benchmark-running.md)。

## 为什么旧结果可以修正

最初发现的两个 `grant-chain-read` fail 都有完整的 164-byte `references/eligibility.md` 返回，并由父 CodeMode 调用完整交付。旧 collector 未将相对 `path` 与 `from` 指向的 preparation 关联，随后遗漏 unmatched 记录，却声明读取覆盖 complete。仅凭旧 grade 推断 Agent 漏读不成立。[原报告及定位](benchmark-standing-engineering-2026-11-25.md)

第一次修复 `1.2.1` 恢复路径映射与诚实的覆盖标记，两个 fail 先变为 unknown；原件还存在材料快照与运行快照编号不同的问题，因此没有直接判 pass。这份中间分析完整保留。随后核对冻结 SDK 实际源码，发现它明确支持两种快照算法：相同完整 record、scope 与内容 version 在两种算法下，恰好生成材料和运行记录中的两个编号。

`1.2.2` 只在原精确身份匹配失败时使用这条证明。关联须同时满足已核哈希的材料 receipt 与 raw readback、同一完整 record、scope、version、具体 file binding、完整正文与资源字节，以及冻结源码中的两个精确公式。缺一仍然 unknown，不能只凭正文哈希相同放行。原精确匹配路径不增加新门槛；只有实际采用这条证明的读取才记录 `selection_bridge`。

公式来自冻结 build 内的 `packages/core/src/snapshot-identity.ts`，文件 SHA-256 为 `9f030e890998e503434d1ee07a9e97b7719ba63352e38711dbb0cd53549e8955`。该文件属于当时实际冻结的源码，不能只用其基底 Git commit 代替身份。实现与负例见 [collector](../benchmark/collect.mjs)、[历史解释器](../benchmark/retained-source-views.mjs)和[身份关联回归](../benchmark/retained-source-views.test.mjs)。

## 重评范围与新旧差分

先重评两个失败所在的完整 scope 共 26 条，随后只读核查另外 8 条，确认其中 3 条存在相同的快照绑定缺口。因此补齐另外四个完整配对 scope，而不是只挑可升级的观察。六组仍保留各自的固定分母、配对和统计结论；合计仅用于证据清点，不生成跨组质量率。

| Scope | 条数 | 原 1.2.0 P / F / U | 中间 1.2.1 P / F / U | 最终 1.2.2 P / F / U |
|---|---:|---|---|---|
| [CodeMode 四条件](../benchmark/results/2026-11-26-relative-source-reanalysis/packages/codemode-24/report.md) | 24 | 16 / 1 / 7 | 16 / 0 / 8 | 21 / 0 / 3 |
| [Implicit · 64 候选 · 1 轮](../benchmark/results/2026-11-26-relative-source-reanalysis/packages/scale-implicit-n64-r1/report.md) | 2 | 2 / 0 / 0 | 未运行此中间版 | 2 / 0 / 0 |
| [Implicit · 256 候选 · 1 轮](../benchmark/results/2026-11-26-relative-source-reanalysis/packages/scale-implicit-n256-r1/report.md) | 2 | 1 / 0 / 1 | 未运行此中间版 | 1 / 0 / 1 |
| [References · 16 候选 · 2 轮](../benchmark/results/2026-11-26-relative-source-reanalysis/packages/scale-references-n16-r2/report.md) | 2 | 1 / 0 / 1 | 未运行此中间版 | 2 / 0 / 0 |
| [References · 16 候选 · 4 轮](../benchmark/results/2026-11-26-relative-source-reanalysis/packages/scale-references-n16-r4/report.md) | 2 | 0 / 1 / 1 | 0 / 0 / 2 | 1 / 0 / 1 |
| [Tariff · 16 候选 · 8 轮](../benchmark/results/2026-11-26-relative-source-reanalysis/packages/scale-tariff-n16-r8/report.md) | 2 | 1 / 0 / 1 | 未运行此中间版 | 2 / 0 / 0 |
| 六 scope 证据清点，不池化 | 34 | 21 / 2 / 11 | 仅覆盖首批 26 条 | **29 / 0 / 5** |

三段评分与逐条合同差分见[差分清单](../benchmark/results/2026-11-26-relative-source-reanalysis/comparison.json)。`1.2.1` 只运行了首批 26 条，其余 8 条没有虚构中间评分。所有旧成绩、第一次 unknown 解释和最终证据保持可追溯。原 [engineering34 发布](../benchmark/results/2026-11-25-standing-engineering34/README.md)保持原字节。

最终五条 unknown 均仍缺 `legal-selection` 的完整证明：CodeMode 的 009（Broker-free）、010/015（Native-free），256 候选的 001（Broker-free），四轮 references 的 002（Native-free）。例如 009 中另一条 bash 子调用 `ls -la; ls -la input` 仍被记录为 opaque；修复资源读取不自动替它闭合选择覆盖。本轮没有将这些独立缺口改判通过，也不把它们视作已确认产品失败。

## CodeMode 判断发生了什么变化

| 条件（每组 6 条） | 原 P / F / U | 新 P / F / U | 原始平均 duration | 平均累计 input | 实际模型请求合计 |
|---|---|---|---:|---:|---:|
| Broker-free | 0 / 1 / 5 | 5 / 0 / 1 | 38.257 秒 | 21,613.0 | 28 |
| Native-free | 4 / 0 / 2 | 4 / 0 / 2 | 21.804 秒 | 20,974.7 | 30 |
| Broker-off | 6 / 0 / 0 | 6 / 0 / 0 | 36.982 秒 | 20,074.0 | 29 |
| Native-off | 6 / 0 / 0 | 6 / 0 / 0 | 23.646 秒 | 17,741.7 | 29 |

表中 duration、input 和请求数全部与原运行相同。[原始资源清点](../benchmark/results/2026-11-26-relative-source-reanalysis/observed-resources.json) · [新的条件表](../benchmark/results/2026-11-26-relative-source-reanalysis/packages/codemode-24/conditions.csv)

Broker-free 的 verified quality 从 0/6 恢复为 5/6，原 `critical_contracts` 拒绝改为 `descriptive / no_acceptance_claim`。Broker−native 的 free 质量差点估计为 +16.7 pp，同时区间仍为 [-100, 100] pp；不能据此宣布 Broker 或 CodeMode 普遍胜出。[配对结果](../benchmark/results/2026-11-26-relative-source-reanalysis/packages/codemode-24/comparisons.csv)

相应 capped-time 从 180.000 秒变为 62.161 秒，是取得“可验证成功”的计分发生变化；实际平均 duration 始终为 38.257 秒。不能把这个分数变化写成提速。金额仍 unknown，零价占位不表示免费。

## 已作出的产品取舍与下一项收益验证

1. **保留已有的 source-relative read。** 不再因为这两个旧 fail 增加强制重读、额外提示或重复工具步骤；本轮没有改变产品消费策略。
2. **保留 free 政策的研究价值。** 旧 0/6 不能支持关闭 CodeMode。下一项新的局部 Own 比较可将两边固定为 off 来控制变量，free 结果继续保留；这不改用户默认设置、不改原冻结计划，也不主张 off 普遍更好。
3. **选择一个有依据的成本问题。** 六对 off 观察两侧完整通过，Broker 平均实际等待高约 56.4%、累计 input 高约 13.1%，两侧请求合计均为 29。这个局部差异值得定位，但不是 SDK v3 的性能结论。

对这 6 对旧 trace 的互斥墙钟分区发现，Broker 相对 native 累计多出的 80.015 秒中，首次 HTTP 前初始化多 40.140 秒，工具区间并集多 70.030 秒，provider HTTP→usage 区间并集反而少 30.250 秒，其余差 0.095 秒。子 SDK 请求是这些阶段内部的定位信息，不能重复加到墙钟。旧固定资源读取每次 5 个 metadata 加 1 个 body 请求；当前 next 已改成本地字节优先、缺字节再核验当前来源，因此不把这条旧等待链当作 SDK v3 的现存缺陷，也不删除其身份检查。

输入线索更适合下一项窄验证：旧 6 对首次请求已稳定多 419～425 input tokens，常驻 tools 定义多 5,610 bytes，当前源码仍在 read、notion_list 与宿主指导中重复覆盖部分语义。**下一步先离线观察当前 SDK v3 实际请求载荷；若确认有明显冗余，再选一处工具说明与指导去重。** 没有可删重复就停止；有候选再进行固定 off 条件的小配对，保持工具、参数、发现、权限、来源、版本及澄清语义。字节差不直接换算 token 或账单，当前尚未实施压缩或证明新产品收益。[成本诊断与公开定位](../benchmark/results/2026-11-26-relative-source-reanalysis/cost-diagnosis.md) · [结构化证据](../benchmark/results/2026-11-26-relative-source-reanalysis/cost-diagnosis.json)

后续按一个具体候选相对已接受环境推进，先保持正确交付、必要资源合同与零外部救场，再看累计输入、等待和恢复成本。获得足以保留、采用或否决的证据就结束该比较。Own20 的原正式结论仍为 inconclusive；Native160 继续暂缓，先明确采用问题和可达精度，不因材料已准备而自动发出。

## 验证与公开复算

定向回归 67/67 通过；完整 Benchmark 49 个测试文件共 746 项，743 pass、0 fail、3 skip。三个 skip 是需显式独立配对环境的实际 Pi 集成项，本轮没有把它们记作通过。next 同步时修正了两处旧测试 fixture 对当前身份检查的预期；未放宽产品或 formal gate。最终 PR 的 Node 24.22.3 / 26.13.1 CI 与 Formal 检查以 [PR #91](https://github.com/yoyooyooo/pi-context-broker/pull/91) 当前 head 为准。

34 条私有重分析、逐条差分和既有离线回放均通过。两轮共核对去重后的 8,523 个保护文件（426,670,697 bytes），原哈希、字节数与时间戳保持不变。前一分析版本也保留。10 条实际身份关联均从原件独立核对完整 record、file binding、内容 version、两种快照公式与所交付字节。

原 34 条共 **226 次模型请求、1,275,266 input tokens、20,583 output tokens**，均与原件一致，每条实际 duration 不变。业务、admission 和原产品身份未改变。公开复核与本地验证摘要见[验证回执](../benchmark/results/2026-11-26-relative-source-reanalysis/verification.json)；采集纠错不改变历史消耗或此前未知金额。

六个公开包复用未改动的 publisher `1.0.6` 和已审查的脱敏配置。每包包含 normalized observations、原件的公开副本及映射、分析、CSV、SVG 和独立 replay。公开复算核验脱敏文件、定位器并重算统计；不会运行私有 grader、还原私有 raw 哈希链、请求模型或增加观察。[公开包与复算入口](../benchmark/results/2026-11-26-relative-source-reanalysis/README.md)

本轮追加分析不增加原科学 ledger 的观察或注册。公开原观察边界仍为 219 / 25，Mini 实际边界仍为 220 / 26；单独保留的 Store invalid 没有因此变为已公开或通过。
