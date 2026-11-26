# SDK3 当前产品闭环：read 描述减重

本目录保留本轮 9 条新增原始观测、对其中 6 条的离线重分析，以及可独立回放的公开证据。最终候选 v2 只删除 read.description 中连续两句重复的 refresh 教程，保留原来的根路径、Requires 和完整批读说明。其确定收益是每个受测请求的工具描述少 219 UTF-8 字节；一次 references 配对没有发现业务输出或关键资源消费回退。

当前状态：**产品候选验证完成，日用集成修复进行中**。普通 Mini profile 的 read 由 compact-ui 包装器注册，完整 Broker schema 与指导可见性另有兼容问题；三机采用需等待该集成修复的实际交付收据。

全部统计仍是 `descriptive / no_acceptance_claim`。最终两例的完整形式化结果均为 unknown，原因是任意 bash 调用仍不能证明不存在未观测消费。业务和关键资源的正面证据、正式未知，以及总体推断能力分别保留。单个配对不支持宣称总体非劣、普遍更快或整任务成本必然下降。

## 结果与独立 epoch

| 证据组 | 原观察编号 | 有效 / 原观察 | 业务合同 | 完整结果 P / F / U | 解释 |
| --- | --- | --- | --- | --- | --- |
| [启动仪器 invalid](packages/apparatus-invalid-221/report.md) | 221 | 0 / 1 | 不作为业务结果 | invalid | 0 次模型请求，0 input/output；47,870.911792 ms 原耗时保留 |
| [v1 原分析](packages/v1-original/report.md) | 222–227 | 6 / 6 | 6 pass；14 个关键合同 pass | 0 / 0 / 6 | 355 B 较宽候选，3 对 development 旅程 |
| [v1 重分析](packages/v1-reanalysis/report.md) | 同 222–227 | 同 6 / 6 | 同一业务和关键合同 | 1 / 0 / 5 | 同原件、同费用；collector 1.3.0 → 1.3.1 |
| [最终 v2](packages/v2-final/report.md) | 228–229 | 2 / 2 | 2 pass；4 个关键合同 pass | 0 / 0 / 2 | 219 B 精确删句候选，另一个 references 配对 |

v1 与 v2 的候选字节不同、注册 epoch 不同，不能合并为 4 个配对或扩大最终 v2 样本量。221 的启动失败也不进入业务成功率。每个包保留自身原协议、固定分母、未知值、统计区间和决策。

### 从 v1 收窄到 v2

v1 同时压缩了 refresh 教程附近的文字，实际减少 355 B。为保留现有根路径、Requires 和批读提示的清晰性，最终 v2 恢复了这些文字，只删除两句重复教程。v1 的三组结果用于保留设计过程与真实测试发现，最终 v2 用新注册的一对 references 复验。

两份决定依据都在模型请求前记录：[v1 采用规则](product-decision-policy.json)、[v2 采用规则](product-decision-policy-v2.json)。它们要求实际载荷差分边界、业务/关键资源合同及实际选择/消费轨迹的核对，允许保留非关键的 absence-proof unknown，禁止把 unknown 改成 pass 或从小样本推导总体效率结论。

[捕获载荷审计](reviews/v2-captured-payload-audit.json)、[零发送与入场证明](reviews/v2-capture-status-proof.json)、[实际首请求差分](reviews/v2-actual-first-request-proof.json)和[完整 references 轨迹复核](reviews/v2-trace-review.json)各自保留原收据 SHA 与公开副本映射，见 lineage。捕获中实际序列化载荷为 15,158 → 14,939 B；read 描述为 1,091 → 872 B。路径归一化后所有其它 schema、参数与消息相同。v1 的轨迹复核保留原 1.3.0 分析语境，后续解释器修正另见下面的重分析。

### 最终 v2 的实际消耗

| 量 | 当前基线 | 最终 v2 |
| --- | ---: | ---: |
| 模型请求 | 6 | 6 |
| 首请求 provider input tokens | 2,889 | 2,850 |
| 累计 input tokens | 27,333 | 27,108 |
| 累计 output tokens | 513 | 480 |
| 实际 episode 耗时 | 188,615.508375 ms | 122,218.170541 ms |
| 业务输出 | pass | pass |
| 完整同 owner 资源路径 | pass | pass |
| 完整形式化结果 | unknown | unknown |

首请求 input 的差是本次 provider 报告的 39 tokens，不能把 219 字节当作 219 tokens。累计 input、output 和耗时是本次两个真实执行的观测；它们不是稳定提速或账单节省的估计。价格仍未知。原始分析的 capped time 还包含未获完整 verified success 的约定，不能把它与上表的实际耗时混为一个量。

## 仅解释器发生变化的 v1 重分析

[逐例差分](v1-reanalysis-difference.json)保留原 episode SHA、重分析 SHA 和 `reanalysis_of`。原 660 个保留文件与原 ledger 均读回核 hash。模型请求、input/output、观测耗时、业务合同和关键资源合同逐例相同，新增模型请求和观测均为 0。

仅 `sdk3-read-description-6-attempt-4-003` 的 legal-selection 从 unknown 变为 pass：现行 SDK 和两份受审 producer 源码能够证明其 notion_list 是 metadata-only，读取正文的链路不变。任意 shell 仍保持 opaque，因此其余 5 例仍为 unknown。该例已有的完成边界因此可被验证，派生的 time_to_success 从 unknown 变为 150,401.687 ms；实际耗时仍为 150,510.982959 ms。这是对同一记录的解释修正，不是一次产品提速。

## 账目与公开集合

[现场账目读回](physical-accounting.json)记录 229 条原观测和 29 次注册，结束时没有 active campaign lease。历史公开集合有 219 条；本目录新增 221 及 222–229，共 9 条。因此公开独立原观测为 228 条，覆盖集合是 **1–219 与 221–229**。旧 220 Store invalid 继续保留在原现场，没有被本目录导出或重评分。不能称为连续“公开至 229”。

本轮 9 条的记账总和是 51 次模型请求、228,177 input tokens 和 3,609 output tokens。这只是按实际发送汇总的执行账目，不是跨 epoch 的科学效果合并。原/重分析两个视图共享同 6 个执行，不重复计算样本或费用。公开包生成、重分析和回放均为 0 次新增模型请求。

## 无凭据回放

每个包都包含自己的统计源码、脱敏原件、原→公开 SHA 映射和重放入口。支持 JSON import attributes 的 Node 即可运行，不需要安装依赖或配置产品/Notion/模型凭据。

~~~sh
node packages/apparatus-invalid-221/replay.mjs
node packages/v1-original/replay.mjs
node packages/v1-reanalysis/replay.mjs
node packages/v2-final/replay.mjs
~~~

需要新报告时，例如：

~~~sh
node packages/v2-final/replay.mjs --out "$PWD/replayed-v2"
~~~

先按 [lineage.json](lineage.json) 选择所需证据组，无须重跑模型。当前产品的下一项测试可沿用 [运行指南](../../../docs/benchmark-running.md) 中的既有 configure、run、analyze、report-only reanalysis 和公开导出入口；本目录不另造验证 runner。

回放验证公开文件 hash、来源定位、reported-model 与请求路由绑定，并从规范化观测重新聚合统计。它不重新运行私有 grader，也不从脱敏副本重建原始 hash chain。私有原件身份以 manifest 显式映射保留。

## 隐私与可核验边界

公开 URL 经现有 URL-aware 脱敏保留可解析的 origin/path 关系，reported-model 绑定校验没有放宽。精确凭据、完整私有 origin、机器路径与独立终端用户名扫描为 0。每个含 SDK 的包中，两个固定 SHA 的公开 SDK 源码各有 6 个通用 loopback/OAuth 常量；相同的 12 个位置均逐项审阅为公开实现常量，不是实际 endpoint 配置。这一有限边界没有扩展为对 implementation 文件的通用豁免。

失败的第一次脱敏副本保留在私有 control 目录，没有进入本目录。最终索引和验证记录见 [lineage.json](lineage.json) 与 [verification.json](verification.json)。产品合入和三台机器日用采用由对应 PR 与交付收据记录，不从本目录的统计结果推定。
