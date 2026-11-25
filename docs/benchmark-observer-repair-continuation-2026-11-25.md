# Observer 修复后的续测结果：累计 104 条闭合

本轮在原有 89 条闭合记录之后，新增 Own8 和 CodeMode7，共 **15 条原始观测**，累计 **104/139 条闭合**。新增 15 条均通过准入检查，业务产物均为 pass；完整合同为 **8 pass、7 unknown**。这些是已观测计数，不构成整个实验的质量估计，也不能把 104 条闭合称为 104 条通过。

工程执行器在 CodeMode 首轮完成 7 条后停止：该轮以 `batch_budget_exhausted` 正常关账，随后执行器发现原定 8 条切片实际只有 7 条，报出 `Unexpected started prefix: 7 !== 8`。本轮没有新增 core episode stop，也没有新增未知 token 用量。其余 **35 条授权槽位尚未开始**。

旧结果继续链接到 [PR69 合入提交中的 stopped89 证据](https://github.com/yoyooyooo/pi-context-broker/tree/65121fb82fe9b0ac6a0c7f722fe3b8284f982fab/benchmark/results/2026-11-24-own-provider-stop89)。本次没有重收集、重评分或重放这些旧记录。

## 1. 实际完成范围

| 范围 | 此次可派发槽位 | 此次实际闭合 | 准入 valid | 业务 pass | 完整合同 pass / unknown | 未开始 |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| Own observer repair continuation | 8 | 8 | 8 | 8 | 2 / 6 | 0 |
| CodeMode | 24 | 7 | 7 | 7 | 6 / 1 | 17 |
| 规模扩展五组 | 10 | 0 | 0 | 0 | 尚无新观测 | 10 |
| 存储故障 | 8 | 0 | 0 | 0 | 尚无新观测 | 8 |
| 本轮合计 | 50 | 15 | 15 | 15 | 8 / 7 | 35 |

累计物理账务为旧 89 加新 15，共 104；原批准目标仍为 139，硬上限仍为 144，另外 5 个槽位仍未分配。独立审计确认共有 104 个连续、唯一的物理预留，13 个 scope 注册；没有活动 campaign/scope lease，没有已开始但缺少终态的运行。

本轮模型配置保持 `gpt-6.2-sol`、reasoning effort `medium`、`maxTokens=4096`。没有更改已冻结的模型窗口、样本顺序或预算，也没有使用备用槽位替代已完成记录。

## 2. Own8：按 1＋6＋1 完成

Own8 的实际调用切片为 **1＋6＋1**，不是两次完整的 1＋7。

| 调用 | 请求的新样本上限 | 实际新增 | 调用结束后的累计 | 关账原因 |
| --- | ---: | ---: | ---: | --- |
| 第一轮 | 1 | 1 | 1 | `operator_slice_limit` |
| 第二轮 | 7 | 6 | 7 | `batch_budget_exhausted` |
| 第三轮 | 1 | 1 | 8 | `planned_slots_completed` |

第二轮达到该次调用的墙钟时间预算。第三轮沿同一个计划，只执行原科学顺序中的最后一个未开始槽位；已经闭合的 7 条没有重跑，累计资源账务没有重置。最后一条于 **2026-11-25 02:15:49.046（Asia/Manila；UTC 2026-11-24 18:15:49.046）** 闭合。

| 用例与角色 | 完整合同 | 说明 |
| --- | --- | --- |
| scripts-assets：candidate、reference | unknown、unknown | 业务产物通过；完整资源/选择证据仍有缺口 |
| implicit：reference、candidate | unknown、unknown | 业务产物通过；路由策略读取/选择证据仍有缺口 |
| no-skill：candidate、reference | pass、pass | 完整合同及无辅助成功均得到验证 |
| ambiguity：reference、candidate | unknown、unknown | 业务产物通过；澄清/选择等证据仍有缺口 |

Own 正常分析保留科学分母 **20**，本包包含 valid8。分析中的另外 12 个 `unresolved_slots` 表示本包没有代表的历史科学槽位；它们不是 12 个仍在运行的 episode。Own8 的执行账本没有未闭合运行。

本次描述性 Own20 lineage 只把新 8 条接回对应原始槽位，旧 12 条继续链接原结果。不合并不同 primary 的科学评分、置信区间或产品接受结论。

## 3. CodeMode7：实际结果与停止边界

CodeMode 冻结设计有 24 个槽位，原执行器安排三个 8 条切片。本轮只执行了第一切片的前 7 条，顺序与冻结计划一致。

| 本 owner 的运行尾号 | 条件 | 用例 | 模型请求 | Input tokens | Output tokens | 完整合同 |
| --- | --- | --- | ---: | ---: | ---: | --- |
| 001 | broker-off | scripts-assets | 4 | 16,193 | 275 | pass |
| 002 | native-off | scripts-assets | 4 | 13,842 | 350 | pass |
| 003 | native-off | references | 6 | 22,743 | 787 | pass |
| 004 | broker-off | references | 5 | 20,897 | 403 | pass |
| 005 | broker-off | explicit | 4 | 16,069 | 276 | pass |
| 006 | native-off | explicit | 4 | 14,077 | 363 | pass |
| 007 | native-free | scripts-assets | 4 | 16,401 | 414 | unknown |
| 合计 |  |  | 31 | 120,222 | 2,868 | 6 pass / 1 unknown |

001–006 均验证了业务合同、声明的合法资源读取路径和选择集合。007 的业务合同与资源读取路径通过，`legal-selection` 仍为 unknown，原因是选择证据不完整；其 `verified_success` 和 `unassisted_success` 保持 false。未观察到的条件和样本不能据此推定通过。

正常分析的科学分母为 **24**，实际 valid7，另有 17 个未开始科学槽位。四个条件的整体质量估计仍为 unknown；本报告不把已完成的 6 个完整合同 pass 除以 7，冒充整个 CodeMode 实验的通过率或条件比较结论。

### 为什么运行已结束，执行器仍报 stopped

批处理 CLI 于 **2026-11-25 04:53:01.710（Asia/Manila；UTC 2026-11-24 20:53:01.710）** 写入第 16 条账本事件：`batch_closed`、`batch_budget_exhausted`、`new_episodes=7`，随后以 exit 0 结束。7 个开始事件都有唯一、对应的完成事件，全部 `stop_batch=false`。

一次性工程执行器另有严格的切片完成数检查。它以请求上限 8 更新预期前缀，实际账本只有 7 条，因此停止后续序列并保留执行 claim，回执记录 `retries=0`、`automatic_resume=false`。这个停止没有把已完成结果改成失败，也没有触发补跑或进入后面的规模扩展、存储故障组。

公开结果边界应记录为 `closed_prefix`，同时保留每组真实关账原因。执行器的 `stopped` 状态与 episode 的 core stop 是不同层级，不能混写。

## 4. 实际耗时暴露的执行开销

| 时间范围 | 实测值 | 含义 |
| --- | --- | --- |
| CodeMode 配置命令 | 17 分 12.797 秒 | 实际配置开始到命令退出 |
| CodeMode run 命令开始至 `batch_opened` | 35 分 28.401 秒 | 批处理开始前的命令准备与验证阶段 |
| `batch_opened` 至 `batch_closed` | 91 分 1.711 秒 | 本次批处理的实际墙钟时间 |
| 本次批处理墙钟预算 | 85 分钟 | 新一条执行前使用的墙钟门槛 |
| 7 条 episode runtime 合计 | 2 分 57.349 秒 | 归一化用量中的累计 runtime |

91 分钟的批处理时间明显长于 7 条 episode 的累计 runtime，主要时间发生在 episode runtime 之外。上述差额还包含历史和环境验证、预留、采集及编排，现有记录不能把全部差额定量归因到某一个函数。

冻结实现先检查批处理墙钟门槛，再执行预留和历史校验。这个门槛不是运行中的强制终止计时器，因此最终关账可以晚于 85 分钟。第 7 条完成后，下一轮检查据此关账；请求数、input、output 和累计 episode runtime 的“下一条最大值可否容纳”检查当时均仍有余量。

这里记录的是本轮观测和已核对的控制流程，没有宣称这些开销已经优化。episode runtime 也不是纯模型响应时间，不能作为整轮端到端耗时或通用成功时延。

## 5. 用量与保留的未知值

| 范围 | 模型请求 / HTTP attempts | Input tokens | Output tokens | Total tokens | 工具调用 | 累计 episode runtime |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Own8 | 35 | 157,460 | 2,533 | 159,993 | 37 | 272,271.214418 ms |
| CodeMode7 | 31 | 120,222 | 2,868 | 123,090 | 37 | 177,348.906042 ms |
| 新增 15 条描述性合计 | 66 | 277,682 | 5,401 | 283,083 | 74 | 449,620.120460 ms |

这些是新 15 条原始观测的已知用量合计，不是完整历史成本，也不是跨实验科学评分。货币成本未定价，缓存用量只有实际已记录部分。

CodeMode 的 31 次请求都有 HTTP 200 和有界 SSE DONE 证据；其中 30 次原始 transport 保留 AbortError 取消及 wire failure 字段，1 次记录自然完成。请求、usage 与终态核对完整，没有未对上的请求，也没有新增未知 token 用量。原始 transport 字段保持原样，没有被改写成统一的“网络成功”。Own 的原始 transport 与归一化证据同样保留，并已逐条核验。

历史仍有 **6 条 usage unknown**，原 stopped003 仍保持 invalid 及其已知用量。本次观测装置修复没有追溯改写这条旧结果。全历史完整用量与货币总成本仍不能报告为完整数值。

## 6. 科学与发布边界

本轮使用经过 observer 修复的派生构建；已安装的产品和依赖按原字节复用。相关修复见 [PR66](https://github.com/yoyooyooo/pi-context-broker/pull/66)、[PR67](https://github.com/yoyooyooo/pi-context-broker/pull/67) 和 [PR69](https://github.com/yoyooyooo/pi-context-broker/pull/69)。修复作用于后续新观测，旧 source、capture、计划和结果均继续冻结。

两组正常分析均使用实际原始 episode，由正常 `analyze` 入口生成，清空凭据环境并禁止网络；分析新增模型请求为 0。独立审计核对了计划、账本、原始及归一化结果、请求用量、正常分析和预留对应关系。

### 实际公开导出与独立复算

本次公开包由既有 publisher **1.0.6** 于 **2026-11-25 10:13:05.456（Asia/Manila；UTC 02:13:05.456）** 实际导出。隔离公开副本复算于 **10:14:42.623（UTC 02:14:42.623）** 完成；另一次逐文件、账务、结果身份与隐私独立复核于 **10:22:31.543（UTC 02:22:31.543）** 通过。这些步骤新增模型请求均为 0。

| 实际验证 | 结果 |
| --- | --- |
| prepare 内置完整输入检查 | 通过，命令 exit 0，写入实际 input |
| export 的独立输入复核及投影 | 通过，命令 exit 0；没有另跑 standalone inspect 命令 |
| 完整公开文件清单 | 716 个文件，39,411,020 字节 |
| 两个新增 primary 包 | Own384文件；CodeMode327文件 |
| 导出时隐私扫描与后续独立复扫 | 均通过：715文本、1个既有审准的合成二进制、0字面命中 |
| 独立隔离复算 | 两个公开包均 verified，命令 exit 0 |
| 隔离探针 | 公开文件可读；私有源读取、私有写入、公开包写入和网络均被拒绝；未继承凭据 |
| 复算前后公开文件身份 | 716 文件原始导出与隔离副本均保持一致 |
| 旧 stopped89 公开包 | 248文件、11,421,401字节保持一致；历史只链接，未重放 |

独立复算为每组生成 13 个报告文件。每组有 9 个 analysis、CSV表和 quality.svg 文件字节完全一致；input.svg 和 time.svg 的差异仅为标题展开，已逐字验证并记录。不能将该结果表述为“13个报告文件全部逐字节相同”。

| 文件 | 导出图题 | 复算图题 |
| --- | --- | --- |
| input.svg | Cumulative input | Cumulative input across actual attempts |
| time.svg | Capped time | Capped time across the full fixed denominator |

隐私扫描沿用既有 publisher1.0.6规则、210个已知标识和4个路径前缀。它证明已提供的私有字面量和既定模式检查通过，不保证识别所有未知私有值。未扩大二进制例外，也未为使检查通过而修改公开包。

[公开证据入口](../benchmark/results/2026-11-25-observer-repair-continuation/README.md)包含[累计账务](../benchmark/results/2026-11-25-observer-repair-continuation/checkpoint.json)、[Own20 lineage](../benchmark/results/2026-11-25-observer-repair-continuation/own20-lineage.json)与[release manifest](../benchmark/results/2026-11-25-observer-repair-continuation/release-manifest.json)。逐组结果见[Own报告](../benchmark/results/2026-11-25-observer-repair-continuation/packages/own-product-observer-repair-unstarted-8-3/report.md)和[CodeMode报告](../benchmark/results/2026-11-25-observer-repair-continuation/packages/continuation-codemode-24/report.md)。

公开 checkpoint 沿用既有字段名 valid_business_unknown，但该字段实际计数来自 normalized result.outcome，表示完整合同为 unknown 的有效观测：Own6、CodeMode1。本文“业务 pass15”来自逐项业务合同及 business.status；“完整合同 pass8 / unknown7”来自完整结果。这个说明没有重命名已认证文件的字段或改动评分。

实际导出、独立审查和复算的非敏感回执投影见[验证记录](benchmark-observer-repair-continuation-2026-11-25.validation.json)。本报告和验证记录独立于716文件清单，不原地改写其README、manifest或导出时“需另有复算回执”的声明。最终Git head、远程CI与合入事实由关联PR和闭环回执记录，本报告不预先宣称CI或合入完成。

公开复算只验证脱敏投影的文件身份、定位和归一化观测统计；它不重跑私有grader，不重建私有raw hash chain，也不调用模型供应商。旧89条在新包中仅链接，其既有验证不计作本次重新执行的结果。

## 7. 剩余工作与原窗口

剩余 35 条为 CodeMode17、规模扩展10、存储故障8；五个备用槽位仍未分配。

本次冻结的模型窗口为 **2026-11-24 10:08:50.700 至 2026-11-25 10:08:50.700（Asia/Manila）**，对应 **2026-11-24T02:08:50.700Z 至 2026-11-25T02:08:50.700Z**。窗口现已结束，截止时间没有因停止、分析或发布顺延。**2026-11-25 10:10:22.470820（Asia/Manila）** 的实际窗口结束检查点确认仍为104条闭合、13个注册、35条未开始，没有活动lease或未闭合运行。

本报告没有重启已停止的一次性执行器，没有移除其 claim，没有扩大累计预算，也没有创建新窗口。剩余槽位不能沿这个已经结束的冻结窗口继续派发；任何后续窗口都需要新的事前授权和明确绑定，同时保留本次全部实际历史。
