# 自有产品续跑停止报告：86 次物理预约

证据边界：2026-11-24 04:35:32 UTC 的停止后 quiet 快照。实际执行与主分析已经闭合；修订证据包通过导出、独立公共副本重放和定点脱敏复核，并按审查通过的字节清单复制到本报告引用的结果目录。发布和只读诊断不授予后续付费执行权限。

## 当前停止位置

接受原 80 条历史后的续跑新增了 6 条闭合记录。新 006 的一次模型接口发送收到 HTTP 401，输入、输出 token 用量未知，触发原有停止规则。付费 dispatch 已停止，没有重发这条记录，也没有启动下一个槽位。

当前为 86 次物理预约、86 条闭合记录、0 条未闭合预约，其中 76 valid、10 invalid。不同实验继续保留各自的科学分母；这里的物理清点不形成一个全局质量通过率。原 80 条只引用 [PR60](https://github.com/yoyooyooo/pi-context-broker/pull/60) 的固定合入提交 [b76b4f6](https://github.com/yoyooyooo/pi-context-broker/tree/b76b4f61802a359751b417ee09a30842e93abf48/benchmark/results/2026-11-23-accepted-continuation-stop)，本次没有重新收集、评分或重放这 80 条。

| 已接受的后续分配 | 本次执行 | 仍未开始 | 当前解释 |
| --- | ---: | ---: | --- |
| 原 Own20 中从未启动的 17 格 | 6 | 11 | 原 20 格设计保留，已有旧 3 条不复制成新样本 |
| Code Mode | 0 | 24 | 分配意图，未执行 |
| 五组规模与多轮切片 | 0 | 10 | 分配意图，未执行 |
| 受控故障 | 0 | 8 | 分配意图，未执行 |
| 合计 | 6 | 53 | 没有将剩余容量用于重试或探索 |

已接受总量上限仍为 139，原硬上限为 144，5 次未分配余量没有使用。86 + 53 = 139。此前接受的一个新 24 小时窗口已经创建并使用，实际为 UTC 2026-11-24 02:08:50.700 至 2026-11-25 02:08:50.700，即 Asia/Manila 的 2026-11-24 10:08:50.700 至 2026-11-25 10:08:50.700。它由全部剩余 scope 共用，不是每个 run 或 batch 各开一个窗口。当前授权不允许再创建第二个新窗口，也没有自动续期。时间或预算尚有余额，不能越过新增 stop / usage unknown 的停止边界。

[PR61](https://github.com/yoyooyooo/pi-context-broker/pull/61) 提供了显式 v4 部分确认集续跑合同，其固定公开合入提交为 `58c9eb98a059621b69ded273d1bf57774b6c3ee4`。本轮实际执行保留冻结的 private collector 1.1.0；公开源码中的 collector 1.2.0 没有用于重收集或改写这些记录。原 Own003 和新 006 都保持 invalid，未被替换。

## 新六条的实际结果与用量

| 新记录 | Admission | 原始 business | valid 完整合同结果 | 模型接口请求 | 输入 token | 输出 token |
| --- | --- | --- | --- | ---: | ---: | ---: |
| 001 | valid | pass | unknown | 4 | 17,976 | 274 |
| 002 | valid | pass | unknown | 4 | 17,835 | 303 |
| 003 | valid | pass | unknown | 4 | 17,133 | 309 |
| 004 | valid | pass | fail | 8 | 37,276 | 458 |
| 005 | valid | pass | fail | 8 | 38,572 | 464 |
| 006 | invalid | fail（原件保留） | 不纳入有效结果 | 1 | unknown | unknown |

五条 valid 的业务结果全部通过，完整合同结果为 0 pass、2 fail、3 unknown。第六条的原始 business fail 继续保留在证据中，但不能把无效观测计成有效的产品业务失败。所有原有 outcome、admission、stop 和未知字段均保持不变。

本次六条共有 **29 次模型接口发送**。128,792 input / 1,808 output 是五条具有完整 token 计量记录的小计；第六条 token 未知，因此六条的完整 token 总量为 null。请求计数六条均完整，不代表 token 计量也完整。货币费用和辅助操作员 token / 货币成本继续为 unknown。

合并物理账务后，86 条中有 85 条具备完整请求计数、80 条具备完整 token 计数。有效历史视图的用量未知由 5 增至 6，原始完成视图由 6 增至 7。全组请求和 token 完整总量仍为 null。已观测下界与仅完整记录的小计分别保留，均不能替代完整总额。invalid 成本已经计入所属 primary ledger，不能再将 invalid 明细相加一次。

## Own20 的跨 owner 描述与操作窗口

同一个 20 格科学设计现在有 9 次物理执行：旧 owner 的 3 条仍在 PR60，新 owner 执行了原 order 3–8 的 6 条。[描述性 lineage](../benchmark/results/2026-11-24-own-continuation-stop/own20-lineage.json) 保留 7 valid、2 invalid-only unresolved、11 unstarted；因此 13 格尚无有效结果。两份 primary 各自保留的 20 格分母不能相加成 40，也没有重算联合质量、置信区间或产品接受结论。

7 条 valid 的原始完整合同结果为 0 pass、2 fail、5 unknown，business 为 7 pass。这些数字描述已有记录，不构成完整 Own20 验收或新的盲验。

| 本次操作窗口 | 实际操作员上下文 | 实际新记录 | 执行数 | 边界 |
| --- | --- | --- | ---: | --- |
| 1 | 原 cold 操作员的同一持续上下文 | 001 | 1 | 001 为 business pass、完整合同 unknown |
| 2 | root | 002–003 | 2 | 原记录均保留 |
| 3 | 原 cold 操作员的同一持续上下文 | 004–005 | 2 | 两条业务通过，完整合同 fail |
| 4 | root | 006 | 1 | limit 为 2，第一条 stop 后未发送第二条 |

窗口 5–8 没有放行。原 cold 操作员在这次续跑中共执行 3 条，窗口 1 与窗口 3 沿用同一上下文，没有再计一次独立 cold start。原 cold start 中发生的 Own003 准入拒绝仍属于旧历史。预先承诺的 cold Skill 切片仍是 Own20 的子集，不增加预约预算；本报告不把上下文延续描述为新的独立冷启动评测。

窗口 1 早期操作报告曾把完整合同 unknown 错标为 business unknown；root 的明确澄清保持原件并确认 business pass / full-contract unknown。文档按实际 primary 区分两层，不改写原报告或评分。操作报告与澄清的必要摘要哈希保留在验证投影中，私有报告不原样公开。

## 001–005 的合同结果如何解释

001 的 `refund-policy-read`、002/003 的 `tax-source-read` 和三条 `legal-selection` 仍为 unknown。已有证据中，业务输出通过与资源/选择证据覆盖不完整可以同时成立，业务通过不能替代完整合同通过。

004/005 的第二回合任务明确要求只查阅发布检查表并写出政策阈值，不据此决定版本是否可发布，也不采用该工作流程。实际第二回合均为主文档 read、检查表 read、摘要 write，没有第二次 `notion_use`。原 readback 将 `source-1` 主文档读取计入 selections；`legal-selection` 以它作为合法候选集合之外的反例。与此同时，同一 `source-1 + source-2` 的 `inspection-only-policy-read` 和摘要业务合同通过。

冻结 collector 1.1.0 的 [observeSource 分类语句](https://github.com/yoyooyooo/pi-context-broker/blob/892c0f4d7a9fbe3e3c4ee7bec12c0908e181a59b/benchmark/collect.mjs#L490) 在成功映射完整 `SKILL.md` 后将其加入 selections，并记录 turn_id，没有区分文档查阅和工作流采用。该公开文件的 SHA-256 与本轮冻结文件一致：`3e55859024ccfb009853b18f412f515ee712dbc19ea5a5925110c99d58681d15`。[gradeSelection](https://github.com/yoyooyooo/pi-context-broker/blob/58c9eb98a059621b69ded273d1bf57774b6c3ee4/benchmark/corpus/grader.mjs#L114) 汇总整条 episode 的 selections，再按 allowed_sets 检查；该路径没有按 turn_id 或 inspection-only 语义过滤。本轮 task-switch oracle 只允许原库存补货 Skill，因此上述只查阅主文档会进入候选外判定。

这条源码路径解释了两个既有合同结论如何同时出现，不能把它写成“模型采用了错误工作流程”。公开 collector 1.2.0 [仍保留相同的分类语句](https://github.com/yoyooyooo/pi-context-broker/blob/58c9eb98a059621b69ded273d1bf57774b6c3ee4/benchmark/collect.mjs#L632)，所以不能承诺仅切换到 1.2.0 就能修复这一语义问题。本次没有实施或验证修复，没有重新执行 collector、grader 或 scorer。

004/005 的嵌套 `stock.json` read 实际成功，返回了包含 `reorder_below` 和 `target_stock` 的政策 JSON。既有 readback 没有对应的 resource_reads，并将相关调用列为 opaque、覆盖列为 partial；`inventory-policy-read` 因此继续 unknown。这不能解释成模型没有读政策，也不能仅凭返回内容和成功状态就补齐原规范内容映射与 SDK 因果证据。原 2 fail / 3 unknown 全部保留。

逐条 normalized 指针、合同 ID 与决定性 artifact 定位见 [公开证据定位](benchmark-own-continuation-stop-2026-11-24.locators.json)。六条记录均已绑定获准包的实际公开哈希；149 个 raw 定位逐项核对文件字节及 JSON Pointer 或 JSONL 行号。该索引只保留事实和定位，不复制私有 observations、源证据清单或原文正文。

## 新 006 的 Provider 错误与停止原因

Benchmark 侧记录一次模型接口发送、HTTP 401，transport reconciliation 完整且采集错误计数为 0。输入、输出 token 仍未知；Provider 错误之后记录 `reported_model_missing`，冻结守卫报错 `BENCHMARK_REPORTED_MODEL_UNAVAILABLE_AFTER_PROVIDER_ERROR`，继而设置 run 的 stop_batch，批次原因记录为 `subject_requested_stop`。这个原因字段不表示用户发出了停止命令，也不把 HTTP 401 当成有效的业务质量失败。缺失 reported model 不能解释成已经证实的模型切换。

经审查的 gateway 记录在相邻时间出现两个内部候选尝试：候选 A 返回 502，耗时 253 ms；候选 B 返回 401，耗时 2,560 ms，错误正文报告 API key expired。时间、状态及相同错误文本形成强关联，但没有共享的端到端 request ID，也没有独立核验的 model alias 映射，不能声称已证明一条同 ID 的完整链路。候选 A 的更深原因未知；没有查询上游账户的权威 key 状态。

Gateway 内部的两次候选尝试与 benchmark 的一次发送属于不同计数层，不追加成两次 benchmark 预约或三次模型请求。错误记录中的 usage 0 不能证明零费用，也没有证据表明完整 usage 曾产生后又丢失。诊断没有进行探针、重试、凭据/配置修改或服务重启。

这条新增 invalid 与 usage unknown 触发既有停止规则。原 53 个未启动分配保持未开始；错误诊断、环境修复或发布证据本身都不授予继续付费执行权限。

## 公开包、隔离重放与发布前脱敏

获准的修订包由既有 publisher 1.0.6 于 2026-11-24 04:57:11 UTC 完成导出，固定记录器实际 exit 0；随后独立公共副本重放亦实际 exit 0。只运行一个新增 primary 包的 portable replay，旧 80 只链接，不运行旧包 replay。实际隔离 canary 确认公共文件可读、指定私有源内容不可读、私有写入及公共副本写入被拒绝、网络被拒绝，子进程没有继承凭据环境变量。

修订包的重放生成 13 个报告文件，其中 analysis.json、CSV 与 quality.svg 共 9 个文件逐字相同。两个图表只存在既有标题差异：

| 文件 | 导出标题 | 重放标题 |
| --- | --- | --- |
| input.svg | Cumulative input | Cumulative input across actual attempts |
| time.svg | Capped time | Capped time across the full fixed denominator |

这不构成“所有报告文件完全相同”的声明。Portable replay 核验公共文件哈希、source locators 并从 normalized observations 重算统计；它不重建私有 raw 哈希链、不重跑私有评分，也不验证 Provider 上游账户状态或未公开运行环境。

首次候选虽通过既有 publisher 校验与 isolated replay，发布前的定点检查仍发现两个已观察的内部 Provider 标识，共涉及 10 个文件、44 次命中。候选在公开之前被拦截，保持原样，没有复制到本结果目录。修订仅向既有 redactions.identifiers 补充这两个精确标识；不改 Publisher 代码或政策，不改变模型记录、primary 或科学结果。对修订候选复扫同组两个 Provider 标识及一个内部 gateway request ID，实际零命中；扫描的全部 350 个文件与发布清单逐项匹配。这项定点检查不包含未掌握的 Provider hosts，也不被扩大为对一切可能私密字符串的穷尽证明。

[公开证据入口](../benchmark/results/2026-11-24-own-continuation-stop/README.md)包含 350 个文件、18,096,168 字节；其中新增 primary 包为 346 个文件、17,880,428 字节。复制后的结果根恰好等于获准候选清单，没有附加文件，也没有修改候选的 README、raw、normalized input 或报告。三份说明与验证文档留在 docs 中，独立于该 350 文件清单。

| 固定身份 | SHA-256 |
| --- | --- |
| release-manifest.json 文件 | `8789b9bb3f946eb96eadb308352db984f9ed3d0d71fe0c1b1664ef82a2c37295` |
| 含清单的公共 inventory | `fa6f27c80278462598ef3c278b985ab6b991ec9fbe90a6b9dc26b21736430baf` |
| 新包 public-manifest.json 文件 | `46cebffa21e9111d1fcc264f9134ab99f43ba58d68dd4986441db888fcd1b93a` |
| 原 primary analysis 语义身份 | `515b0f9598120c0e8c38a1a3d525760e79d45be9d9069c4f7ec11252939ffada` |
| 公开 analysis 语义身份 | `960719b8b66967f3be51ca68e21bee1a9eab09c71da7461c0a25201c5f953c8c` |

实际回执的非敏感投影见 [公开验证记录](benchmark-own-continuation-stop-2026-11-24.validation.json)，原始与公开哈希分别标识，不把脱敏后的文件冒称原始私有文件。导出、元数据 lineage 和公开重放产生 0 次 subject model requests；辅助代理用量仍为 unknown。

## 关联工作项

以下为本次只读核到的实际工作项；它们在读取时均为 In Progress。报告发布不将这些工作项的其余验收条件自动标成完成。

| 工作项 | 范围 |
| --- | --- |
| [AH-1217](https://linear.app/yoyooyooo/issue/AH-1217/benchmark-建立消费环境版本比较原生校准与持续证据体系) | 总体比较、原生校准与持续证据体系 |
| [AH-1225](https://linear.app/yoyooyooo/issue/AH-1225/benchmark-08-执行-phase-0-与有界三模型先导实验) | Phase 0 与有界模型先导 |
| [AH-1226](https://linear.app/yoyooyooo/issue/AH-1226/benchmark-09-完成真实环境自比较与首次原生校准) | 真实环境自比较及原生校准 |
| [AH-1221](https://linear.app/yoyooyooo/issue/AH-1221/benchmark-04-采集实际环境模型请求与嵌套调用证据) | 环境、模型请求与嵌套调用证据 |
| [AH-1227](https://linear.app/yoyooyooo/issue/AH-1227/benchmark-10-发布可复算的环境与模型成绩单) | 可复算成绩单与证据发布 |
| [AH-1228](https://linear.app/yoyooyooo/issue/AH-1228/benchmark-11-接入验证-skill环境回归与新模型筛查) | 验证 Skill、环境回归与模型筛查 |
