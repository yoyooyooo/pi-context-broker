# 自有产品续跑停止报告：89 次物理预约

证据边界：2026-11-24 19:15:40.416436（Asia/Manila；UTC 11:15:40.416436）的停止后快照。原始执行与正常 primary 已闭合；新增公开包已实际导出并通过独立公共副本重放，248 文件的已知标识复扫通过。报告与验证投影位于 docs，独立于该公共包的固定清单。
## 当前停止位置

本轮在此前已公开的 86 条历史记录之后，新增 3 条闭合观测，停在 **89 次物理预约、89 条闭合记录**。新增 001、002 的 admission 为 valid，业务产物通过，完整合同结果仍为 unknown；新增 003 的业务产物也通过，但原始证据准入为 invalid，触发停止规则。本轮新增 verified success 为 **0**。

本次新增记录属于 `benchmark-own-product-provider-stop-unstarted-11-1`，下文的 001–003 均指该 owner，不与此前 owner 的同名尾号混用。旧 86 条继续引用 [PR62](https://github.com/yoyooyooo/pi-context-broker/pull/62) 固定合入提交中的[停止报告](https://github.com/yoyooyooo/pi-context-broker/blob/699e1b4c4fe8f560cd41f6126fb1a51ad07dc185/docs/benchmark-own-continuation-stop-2026-11-24.md)和[公开结果目录](https://github.com/yoyooyooo/pi-context-broker/tree/699e1b4c4fe8f560cd41f6126fb1a51ad07dc185/benchmark/results/2026-11-24-own-continuation-stop)。本次没有重收集、重评分或重放旧 86 条。

按物理记录相加，当前为 **78 valid、11 invalid**，没有未闭合预约。不同实验继续保留各自的科学分母；物理清点不形成全局质量通过率。全部付费 dispatch 已停止，后续分析、代码修复与发布准备都沿用这一停止边界。

| 已接受的剩余分配 | 本轮执行 | 仍未开始 |
| --- | ---: | ---: |
| 原 Own20 中此前从未启动的 11 格 | 3 | 8 |
| Code Mode | 0 | 24 |
| 五组规模与多轮切片 | 0 | 10 |
| 受控故障 | 0 | 8 |
| 合计 | 3 | 50 |

剩余 **50 = Own8 + Engineering42**。已接受总量上限为 139，原硬上限为 144，5 次未分配余量保持未分配；89 + 50 = 139。剩余容量没有转用于重试、替换、探针或探索。

原获准共享模型窗口保持 Asia/Manila **2026-11-24 10:08:50.700 至 2026-11-25 10:08:50.700**（对应 UTC 2026-11-24 02:08:50.700 至 2026-11-25 02:08:50.700）。全部剩余 scope 共用这个窗口，没有另开或续期。预算与时间余额不解除已经触发的停止规则。

## 新三条的实际结果与用量

本轮保留冻结的 collector **1.1.0**、原 runtime/source observer 和原始 normalized records。公开源码版本或后续 observer 修复没有用于重写这些记录。

| 物理序号 | 新记录 | Admission | 原始 business | 原完整合同 outcome | 模型接口请求 | 输入 token | 输出 token |
| --- | --- | --- | --- | --- | ---: | ---: | ---: |
| 87 | 001 | valid | pass | unknown | 4 | 18,093 | 317 |
| 88 | 002 | valid | pass | unknown | 5 | 22,342 | 393 |
| 89 | 003 | invalid | pass | not_applicable；不纳入有效结果比较 | 5 | 23,142 | 376 |
| 本轮合计 | 3 条 | 2 valid、1 invalid | 3 个产物 pass | valid 中 2 unknown | 14 | 63,577 | 1,086 |

两条 valid 的完整合同为 **0 pass、0 fail、2 unknown**。三条业务产物通过与完整合同尚未得到证明可以同时成立。003 的 business pass 保留为原始事实，不能越过其 invalid admission，计成有效完整合同成功。

001 的资源路径和选择证据仍不完整；002 的 `grant-chain-read` 与 `legal-selection` 仍为 unknown。003 也没有建立完整资源路径与选择合同。unknown 表示现有规范证据不足以完成该项判断；它不能被改写成 pass，也不单独证明模型没有读取相关内容。

本轮 **14 次模型接口发送、63,577 input、1,086 output** 的计量完整，包含 invalid003。invalid 用量已经计入所属 primary ledger，不能再把 invalid 明细重复加一次。全部下游 transport HTTP 尝试没有被独立穷尽计数，因此 14 次模型发送不等于所有网关或 Provider 内部 HTTP 尝试的总数。

货币费用继续为 unknown。配置中的零价格不能证明经济费用为零。旧 86 条仍包含用量未知记录，完整 89 条的 token 与货币总额仍不能给出；新三条计量完整不会补齐旧历史的缺失值。辅助操作员的用量和货币成本也没有在本报告中被估算。

## 当前 primary 与 Own20 描述性 lineage

实际正常 primary 仅输入本轮三条原 normalized observations。它保留原 **20 格科学设计**，得到 **2 valid、18 unresolved scientific slots**。此前两个 owner 的九条记录没有被拼接进该 primary。

另一个描述性视图按原槽位串联三个 owner，得到 **12 次物理执行、9 valid、3 invalid、8 unstarted**：

| Owner | 原 Own20 槽位 | 已闭合 | valid | invalid | 本轮处理 |
| --- | --- | ---: | ---: | ---: | --- |
| `benchmark-own-product-confirmation-2` | 1–3 | 3 | 2 | 1 | 链接旧公开记录 |
| `benchmark-own-product-confirmation-unstarted-17-1` | 4–9 | 6 | 5 | 1 | 链接旧公开记录 |
| `benchmark-own-product-provider-stop-unstarted-11-1` | 10–12 | 3 | 2 | 1 | 本次新增公开包 |
| 原槽位 13–20 | 13–20 | 0 | — | — | 8 格从未启动 |

当前 primary 的 18 个 unresolved 包含此前 owner 的九条未并入输入记录、本轮一条 invalid，以及八格尚未启动。它不是“还有 18 格从未启动”。描述性 Own20 视图则有 3 个 invalid-only unresolved 与 8 个 unstarted，合计 11 格尚无有效准入记录。

[描述性 Own20 lineage](../benchmark/results/2026-11-24-own-provider-stop89/own20-lineage.json)保留逐槽 owner、原始身份与公开定位。新三条的公开事实来自实际脱敏后的 episode，旧九条指向固定历史公开文件。三个 primary 的 20 格分母不相加，也不重算联合质量、置信区间、产品接受结论或独立 cold-start 数量。

本轮操作窗口按原记录保留：

| 操作窗口 | limit | 实际新增 | 物理边界 | 原闭合原因 |
| --- | ---: | --- | --- | --- |
| 1 | 1 | 001 | 86 → 87 | `operator_slice_limit` |
| 2 | 2 | 002–003 | 87 → 89 | `subject_requested_stop` |

第二个窗口出现 stop 后，没有放行第三个窗口。这里的操作窗口与共享的 24 小时模型授权窗口是两个不同层次。

## 新 003 的停止原因：observer 漏接合法 resolve

对原始 SDK、source、runtime 与 normalized 证据的只读审查支持一条局部因果链：SDK 合法完成了 `resolve`，而两个陈旧的 observer 操作白名单没有包含它，导致完整观察证据无法成立。

| 原始观测层 | 已观察事实 |
| --- | --- |
| SDK | `list → consume → resolve → read → read-resources` 共 5 个操作；5 个 start、5 个 completed end，结果已观察，最终 pending 为 0 |
| 本次 `resolve` | 配对和度量完整；该操作自身的 HTTP 尝试数为 0 |
| Source observer | 只接受 4 个操作；`resolve` 的两条度量事件被拒绝，errors 为 2，terminal complete 为 false |
| Runtime observer | 拒绝 `resolve` start/end，并因未接受 start 而拒绝其 result；合计 3 个 observer 错误 |
| 原最终记录 | Notion 证据覆盖不完整；normalized admission 为 invalid、outcome 为 not_applicable，stop 保留 |

冻结 runtime 的 [operation whitelist](https://github.com/yoyooyooo/pi-context-broker/blob/1d5b866023214070cfa1b3620bca1dfb86db5ba5/benchmark/runtime/episode-notion.mjs#L14) 与 [source observer whitelist](https://github.com/yoyooyooo/pi-context-broker/blob/1d5b866023214070cfa1b3620bca1dfb86db5ba5/scripts/skill-consumption-source-observer.mjs#L55)均遗漏 `resolve`。这两份公开源码的 SHA-256 与实际冻结文件一致，分别为 `0071f086fcb6a22428e40799f9b8aaa85a431229e4484c5d73188f8a33484ca0`、`f0117434bcd6461f1cdda5d526b9f0623ceae0ac4eaf1c644f187a47553d6f5a`。

[`graphSourceAccounting`](https://github.com/yoyooyooo/pi-context-broker/blob/1d5b866023214070cfa1b3620bca1dfb86db5ba5/scripts/notion-skill-graph-model-evidence.mjs#L242)也有同类遗漏，属于关联离线路径的合同缺口。实际 episode runtime 使用的是 graph observer；这里不能把关联 accounting 函数说成本次 invalid 的直接触发入口。

原 normalized reasons 保留 `core_notion_evidence_incomplete` 与 `runtime_not_a_business_episode:invalid`。批次记录的 `subject_requested_stop` 表示执行体触发了停止规则。诊断不重新归一化、不调用新 collector 或 grader，也不改变原 admission、outcome、stop 或缺失字段。

003 的五次模型响应均有完整已报告用量，reported model 状态与请求路由标签匹配。这支持该次停止的 observer 解释。路由标签匹配仅描述 Provider 返回的标签，不能证明底层模型身份或长期稳定性；本报告不据此将全部 Magpie Provider 判定为已通过稳定性验收。

[公开停止诊断](../benchmark/results/2026-11-24-own-provider-stop89/stop-diagnosis.json)仅投影操作名称、计数、源码哈希和上述边界，不公开原始私有标识、凭据或控制目录。

## 本批源码交付与主线同步

[PR65：Avoid duplicate active campaign amendment verification](https://github.com/yoyooyooo/pi-context-broker/pull/65) 已于 **2026-11-24 19:01:11（Asia/Manila；UTC 11:01:11）** 合入 `benchmark`，实际合入提交为 [`1d5b866023214070cfa1b3620bca1dfb86db5ba5`](https://github.com/yoyooyooo/pi-context-broker/commit/1d5b866023214070cfa1b3620bca1dfb86db5ba5)。该变更减少 active campaign amendment 的重复验证。[CI run 45376167841](https://github.com/yoyooyooo/pi-context-broker/actions/runs/45376167841) 对 PR head `286ed7cc43adf5727098e8d053fbdb856884a58f` 实际成功；这里不将该结果标成合入提交另跑的 CI。

主线在 [b2c441b](https://github.com/yoyooyooo/pi-context-broker/commit/b2c441ba8fe8ed695ff2cf6e6a6579b3895cf31a) 已引入共享观察入口的 `resolve` 支持，[`next@e2d667f`](https://github.com/yoyooyooo/pi-context-broker/tree/e2d667fc600099bd85f9fa5e72e64dad41a54467) 保留这项语义并采用更广的 SDKv3/library 合同。本批交付把既有 `resolve` 语义窄回补到冻结 SDKv2 的 Benchmark，没有另建重复的主线修复，也不把 SDKv3/library/content-search 条件带入该冻结合同。

回补在四个现有有限操作集合中加入 `resolve`：[runtime observer](../benchmark/runtime/episode-notion.mjs)、[source observer](../scripts/skill-consumption-source-observer.mjs)、[graph accounting](../scripts/notion-skill-graph-model-evidence.mjs) 和 [daily HTTP classifier](../scripts/verify-pi-daily-installation.mjs)。未知操作拒绝、ID/版本/时钟与进程归属检查、唯一 start/result/end 配对、完整度量和准确 HTTP 尝试计数均保持。`resolve` 收据可被正确观察，但不会因此被计作向模型交付 Skill 正文或资源，也不自动建立业务或完整合同成功。

原候选的 **71 项聚焦验证**实际通过并经独立源码审查。最终回补候选的八个生产/测试文件与该已审候选逐字相同；新增差异限于两份主线同步与验证路由文档。文档检查最初为 8 pass、1 skip，随后 root 用固定自有 CLI 源运行原先跳过的唯一用例，得到 1 pass、0 fail、0 skip，文档范围合计 **9 项实际通过**。两份检查保留各自原回执；这些计数没有合成一次新测试运行。最终回补与主线路由也通过独立审查。

额外尝试的两个主线 graph 检查在 SDK 观察前因未选择 SDKv3 fixture 而失败，原失败记录保留；它们不被描述为通过，也不替代 Benchmark SDKv2 范围的验证。

| 本批修复的固定源码身份 | 值 |
| --- | --- |
| 回补基点 | `1d5b866023214070cfa1b3620bca1dfb86db5ba5` |
| 纯源码候选 tree，不含本报告与结果包 | `2ac3f6e97ab40880c3dcc8cd0dff10ba73ca20d9` |
| 十文件源码 patch SHA-256 | `b18dfa5b03777c645dc3ff5afc68ec61a3853a63ad23123d64c484c825267dbd` |
| patch 字节数 | 24,482 |

修复、报告与证据包在本批源码交付中配套提供；[公开验证记录](benchmark-own-provider-stop89-2026-11-24.validation.json)固定各源码文件的实际字节哈希。包含文档和结果包后的最终 Git head、远程 CI 与合入事实由关联 PR 检查和闭环回执记录。本报告不嵌入其自身最终提交身份。

本次修复改变 runtime observer 与 collector 静态源码闭包的身份。以后运行必须重新绑定实际源码；旧 controller 的身份核验不能作为新修复的执行证明。

这些源码和受控验证没有用于重写新三条或旧 86 条，也没有切换原冻结执行源。没有新增付费请求、重试、重采集、重归一化或重新评分；stopped89 的停止边界保持。

## 公开包、隔离重放与发布前复扫

新增公开包由既有 publisher **1.0.6** 于 **2026-11-24 19:22:58.362（Asia/Manila；UTC 11:22:58.362）** 实际导出，固定记录器 exit 0。独立公共副本重放于 **19:23:25.627（Asia/Manila；UTC 11:23:25.627）** 完成，记录器 exit 0。两项均产生 **0 次 subject model requests**。

[公开证据入口](../benchmark/results/2026-11-24-own-provider-stop89/README.md)包含 **248 个文件、11,421,401 字节**，其中唯一新增 primary 包为 **243 个文件、11,328,130 字节**。原 collector1.1.0 的三条记录按原结果投影；旧 86 只链接，不复制或重放。公开控制信息见[物理账务](../benchmark/results/2026-11-24-own-provider-stop89/checkpoint.json)、[release manifest](../benchmark/results/2026-11-24-own-provider-stop89/release-manifest.json)与[新增 primary 分析](../benchmark/results/2026-11-24-own-provider-stop89/packages/own-product-provider-stop-unstarted-11-1/analysis.json)。

独立 driver 只复制该实际 public 子树。真实隔离 canary 确认：公共文件可读，指定私有源内容不可读，私有写入和公共副本写入被拒绝，网络被拒绝，子进程没有继承凭据环境变量。仅调用一个新增包内的 portable replay，原 export 与隔离公共副本的完整清单均保持不变。

重放实际生成 13 个报告文件。`analysis.json`、七个 CSV 与 `quality.svg` 共 **9 个文件逐字相同**；两个图表只出现以下标题差异：

| 文件 | 导出标题 | 重放标题 |
| --- | --- | --- |
| input.svg | Cumulative input | Cumulative input across actual attempts |
| time.svg | Capped time | Capped time across the full fixed denominator |

该结论只覆盖已核对的分析、表格和图表身份，不扩大成全部报告文件逐字相同。Portable replay 从公开 normalized observations 重算统计并核验公开文件及 source locators；它不重建私有 raw 哈希链、不重跑私有 graders、不观察 live quiet，也不验证 Provider 上游账户或模型长期稳定性。

随后对实际 248 个公共文件执行有界复扫。检查沿用既有显式标识、路径与 publisher1.0.6 规则，没有增加标识列表、扩大二进制例外或修改 export：

| 复扫范围 | 实际结果 |
| --- | --- |
| 210 个既有显式 identifier，含 URI 编码与 JSON 转义形式 | 0 命中 |
| 4 个既有私有路径前缀，含相同编码形式 | 0 命中 |
| 既有 publisher 检查，包括 52 个 identifier words、1 个 terminal username、凭据模式、原始 UUID 和机器路径规则 | 0 个失败文件 |
| UTF-8 文本文件 | 247 个完成上述检查 |
| 非 UTF-8 文件 | 1 个 6 字节合成 fixture，准确匹配原二进制 allowlist |
| 整个公共子树 | 248 文件，扫描前后 inventory 完全相同 |

既有显式 secret 列表为空，因此这里只声明既有凭据模式检查，不声称匹配了未掌握的真实凭据。原二进制政策包含两个已审批哈希，本次清单仅遇到其中一个；没有新增例外。本次复扫只针对固定已知输入和现有规则，不扩大为对未知 Provider 标识、hosts 或全部可能私密字符串的穷尽证明。扫描没有输出敏感值，也没有改写任何导出字节。

2026-11-24 19:30:20.068（Asia/Manila；UTC 11:30:20.068），实际公共子树已按原样复制到本次源码候选的结果目录。复制后仍为 248 文件、11,421,401 字节，完整 inventory 与获准 export 一致；原 export 和十个修复源码文件均保持不变。此复制事实与最终 Git 合入是分别记录的操作。

| 固定身份 | SHA-256 |
| --- | --- |
| release-manifest.json 文件 | `030763d78896f08694115b9495b1041c8c7b1b5d4283392b5bf1775bf42a71ec` |
| 含 release manifest 的完整公共 inventory | `ebfd93e87b44dce989f09c72493d3259fb1d811e14a5d58ef87af54ed4b01640` |
| 新包 public-manifest.json 文件 | `be3cc249c8900569be24a1df386fad385811d59a71723c75485add61259100f4` |
| 原 primary analysis 语义身份 | `97e92c97ce47be0ddf13055a98b2294a50a2a370b9f53f7fc9f15ada31e30140` |
| 公开 analysis 语义身份 | `6b7baa298bc9c1d6843bac97400a97ed04fd4c36ed32c88facb4da735514ce41` |
| 重生成 report-manifest.json 文件 | `bf69f868e54abcf5c9741bd83968282106a870f73b2906ff7920002bb76c7821` |

原始文件字节哈希、原语义身份、公开文件字节哈希和公开语义身份分别标识。实际导出、重放与复扫的非敏感字段见 [公开验证记录](benchmark-own-provider-stop89-2026-11-24.validation.json)。该记录与本报告独立于 248 文件清单，不改写其内既有 README、manifest 或“需另有重放回执”的导出时声明；独立重放完成的事实由此处实际回执投影证明。

原私有输入、source mapping、隐私映射、控制目录和完整私有 receipt 不进入公开目录。发布证据、源码修复和重放通过均不授予产品接受结论或下一次付费执行权限。
