# SC13 来源所有权与按需获取验证

日期：2026-11-05。归属 AH-617 / AH-630。

本轮完成 current 消费的来源所有权规划：先验证完整来源目录和共享事实，再获取有效文件实际依赖的来源字节。它衔接[上一轮固定快照与当前缓存按需读取](selected-snapshot-consumption-verification-2026-11-05.md)，不关闭整个 SC13 或 AH-617。

安装后的 SDK 从空 Store 进入 current 路径时，两份各 2 MiB 的 custom/tombstone 原始来源均没有读取或下载；只获取必需的 source main 与 following binary，共 187 B。完整导出逐文件匹配全量字节 oracle。真实 Pi 的主文和资源批读回归通过。另一次真实来源冷读取仍包含首次 current 全树观察，保留其完整成本。

原始证据保存在仓库外，以下以 `ROOT` 表示：

```text
/Users/yoyo/Library/Logs/ntn-skills/AH-617-20261105/ownership-ibnvl6g0
```

## 实现边界

`planSelectedSharedSource` 持有已验证的 immutable binding，给出完整 path/length/content identity 目录及精确路径 materializer。Git、HTTP/local composition、retained snapshot 和 legacy bundle 均复用该 binding；完整 resolver 保留给 authoring 和显式 source refresh。

完整 Base/Mount 目录、大小写/Unicode/file-directory 冲突、声明大小、HTTP locations/origin、local machine/workspace binding 都先于对象读取。当前 Files membership、全部 file events、孤儿事件、缺失 baseline 和原操作 pending 屏障先于来源 acquisition。metadata planner 与最终字节 composition 共用 placement 规则，不给省略的文件制造空 bytes。

既有 custom、tombstone 和被逻辑移动抑制的来源路径不再触发无用的 SHA-256 来源读取。Following move 获取原始 `source_path`，在新路径输出，并保留稳定 File ID 与 custom replacement provenance。完整有效树仍经过原有引用验证和 snapshot 发布；full export 仍验证每个有效文件。

以下依赖明确保留：

- Custom main 仍需要 source main 的额外 YAML；managed name/description 与 native body 的覆盖顺序不变。
- Git OID 不能代替 SHA-256 隐私分类证据；被 custom 覆盖的 Git 原文仍可能需要实际验证。派生 OID→SHA cache 不被当成字节证明。
- 必需 provider 失败必须先于新 body adoption。刚在本次读取中由 following 变成 custom 的文件，仍可能付出原始 source 读取成本。
- 冷 current 仍可能需要完整有效正文来建立版本和引用事实；这不是未观察 current 树的单文件随机访问。

### 隐私别名与失败时的发布顺序

完整已准入 local manifest 中的 SHA 保守限制所有同 SHA 来源别名，即使 local 路径被排除、有效字节来自 HTTP 或 Git。只对实际验证成功的选中字节建立 durable marker；空选择、坏字节和未读取 local 文件不会制造已验证字节证据。

独立审查发现并修复了两个相关问题：一是剪裁 local 路径会漏掉同 SHA public alias；二是 plan 尾部的延迟 marker 会被后续 required-source 失败跳过。最终先验证实际字节并持久化必要的 local marker，再发布 immutable object，最后发布 Git 派生索引。

缓存命中也在实际字节验证后、返回前分类。6 个 HTTP/Git 失败反例先在旧实现真实失败；修复后新增 8 个 case 与相关回归共 33 pass。包括同 resource 并发后项失败、后续 mount 失败、marker 保存失败及空选择/坏字节。没有新增 SDK/CLI 协议或全局事务。

## 安装后的 SDK / CLI

独立验证会话按 CLI 的既有 `verify-ntn-skills` Skill 生成一次 fixture，并执行 `sdk-package-smoke.mjs`。最终运行实际 exit 0、signal null，18 passed / 0 failed；另有 46 项原始证据核对。运行目录：

```text
ROOT/verification/installed-sc13-r15604nz/consumer-candidate02-identity-fixed
```

| 实际指标 | Cold current | 只改 Name/Description 后显式 refresh |
| --- | ---: | ---: |
| 受控 HTTP source 请求 | 2 | 0 |
| 受控 source response 正文字节 | 187 B | 0 B |
| Loopback Notion 读/查询 | 11 | 10 |
| Notion 写入 | 0 | 0 |
| Node Store 对象读取 start/end | 29 对 | 29 对 |
| 两份未选 2 MiB source 的请求/对象读取 | 0 / 0 | 0 / 0 |
| SDK 完整有效目录 | 3 文件 | 3 文件 |
| Installed CLI 完整 export | 全路径/长度/hash 匹配 | 全路径/长度/hash 匹配 |

Cold seed 的 `shared_local_records` 为空，四份 source body 都未缓存。获取正控制是 source `SKILL.md` 179 B 和 following binary 8 B。两份被排除源均为 2,097,152 B；它们没有出现在 source ledger 或 Store 读取记录，最终对象目录也没有对应 hash。

两次导出均实际执行 installed CLI 的 `--offline --projection snapshot`。它们包含完整 3 文件和 `.ntn-skills.json`，逐项匹配 full-byte composition oracle。Canonical main 从 162 B 变为 188 B，source YAML 的额外字段仍在，两个非 main 文件字节不变。Source 187 B 是这个受控 provider 的正文量，不是整次操作的总网络量或 wire bytes。

既有 partial-cache 用例同时通过：未选 missing/corrupt 大对象不影响固定主文或小资源；显式选中时分别报 `SNAPSHOT_MISSING` / `STATE_CORRUPT`；partial export 拒绝，完整 clone 的 export 逐文件一致。资源批次 4 文件 / 101 B 的 UTF-8、BOM、CRLF、空文件、binary 内容均核对。

关键原件包括 `ownership-current-evidence.json`、三个 ownership 请求/对象 JSONL、两次 SDK result、两份实际导出，以及 run 上级的 `independent-evidence-review.json`、`evidence-index.json`。独立审核 hash 为 `5f2b0bc651c7b0f97a77a1d3921fedbd02f8022aa103d591c28d3e8368488896`；124 份证据索引 hash 为 `57be8ed99864c9551e7d4789ec48cf6beb4bcb05c880ac0d7352f5c19dc7cd52`。

### 保留的首次失败

首次 candidate02 smoke 为 17 passed / 1 failed。新增 case 在 `/v1/users/me` 被 `INVALID_RESPONSE` 阻断：受控响应 ID 不符合产品既有 UUID schema。只修正 harness 的身份数据，产品 tarball 和原 fixture 没有变化，使用全新安装目录复跑；没有放宽产品校验或验收断言。首次失败原件留在同级 `consumer-candidate02`。

candidate01 也完整保留，因审查发现 marker 发布顺序问题而在最终验收前被 candidate02 取代。开发期导入/格式/类型与测试设置失败均保留；其中导入尚未导出的那次失败没有运行测试主体，不作为语义红灯证据。

## 实际 Pi 与独立 Broker 包

从本次 installed CLI 构建 Broker，独立 npm pack/install。Pi 1.4.0 / Node 24.20.0 从安装包加载 extension，使用默认 bundled SDK，没有配置 `source.command`。共 14 条记录命令退出 0，失败/超时均为 0。

```text
ROOT/broker/candidate02-pi-4666ddbbb8
```

| 场景 | 实际结果 | 终局及清理 |
| --- | --- | --- |
| `partial-entrypoint` | 5 次 controlled provider request；SDK consume 2 / read 1；只读取主文与所选资源，未选大对象 reads=0；完整目录仍为 4 文件 | 2 个 catalog child 全 close，3 条 observer chain 全终局；28 份原件 cleanup 后 hash 全相同 |
| `resource-batch` | 5 次 controlled provider request；`read-resources` 2 次，没有逐文件 read/consume；4 个资源；7 B binary 原件保留；serializer loopback replay 1 请求 / 16,616 B | 2 个 catalog child 全 close，3 条 observer chain 全终局；25 份原件 cleanup 后 hash 全相同 |

两条路径均执行 Doctor → Drive → Evidence → Trash Cleanup → Evidence。两个 owned scratch 原路径已不存在，证据目录只新增各自 `cleanup.json`；额外自有 npm 工具 scratch 也已 Trash，包与证据保留。

SDK/CLI 完整 `request_metrics` 报告受控 warm/offline 范围的零请求；独立 source-server HTTP ledger 没有采集，其计数保持 `null`。不把缺失台账写成零。两个场景保留 `sdk-fixture / CACHE_MISSING` 的 discovery failure；上一轮对应场景也有相同记录。这里证明指定读取路径，不证明目录全面健康、Default View/menu 或短资源句柄。

## 真实来源冷读取

沿既有 source baseline driver，仅替换前轮配置中的 installed CLI 路径与 evidenceRoot。原目标、resource path、120 秒预算及 resource-only cold=1/warm=0 均保持。没有生产写入或模型调用。

```text
ROOT/broker/live-source-01/source-20261105T032645860Z-c0a2b551
```

| 实际指标 | 本轮结果 |
| --- | ---: |
| CLI 启动 / 退出 | 1 / 1，exit 0，signal null |
| 单次资源读取耗时 | 12,179.436334 ms |
| HTTP attempts | 19 |
| Notion metadata / current body / retained body | 14 / 4 / 1 |
| Notion write / 外部 provider / failed attempts | 0 / 0 / 0 |
| Request / decoded response bytes | 1,767 / 1,532,016 |
| Retry wait | 0 ms |
| 返回所选资源 | 3,374 B |
| 完整有效文件 / 缓存对象 | 4 / 9 |

所选内容 SHA-256 为 `3ef9aa54c7b00037fdab33db08c9e29d760a9e3855587ea956748d6a93d311e5`；snapshot/version 和完整文件清单与前轮留存的已验证原件一致。只返回所选资源，不把缓存的其他文件混入输出。

完整 trace 无丢弃、in-flight=0。这条样本仍包含首次 current 全树观察，不证明来源请求减少；上轮同一路径为 19 HTTP / 10,483.808458 ms，两次单样本不构成延迟改善结论。`provider=0` 不代表没有 retained 获取成本。此 live trace 未独立证明 ZIP 格式或 wire bytes。

Cleanup 通过系统 Trash 回收 owned working 目录，31 份清理前原件逐项 hash 不变。最终 review 为 `ROOT/broker/live-source-01/live-source-review.json`，SHA-256 `d5442fe03e546aa7cc84f2ca6d2a62d3c6a7b27da4cd4e06c969917209cab31a`。

### 剩余大头：同一次读取内重复获取 Skills 目录

对既有 trace、返回的 native reference 结果和冻结源码控制流作只读归因，六次 metadata 请求指向同一个 Skills data source，构成两轮完整分页。每轮三页分别为 255,930 / 216,563 / 243,567 B，合计 716,060 B；两轮合计 1,432,120 B，占本次全部 decoded response bytes 的 93.4794%。这些是 Skills 元数据，独立于 retained-body 请求，也不是重试。

| HTTP 次序 | 用途 | Decoded response bytes |
| --- | --- | ---: |
| 3 / 4 / 5 | 逻辑 `shared_skill` selector 经 `openSnapshot` → `catalog({ refresh: true })` 解析 | 716,060 B |
| 17 / 18 / 19 | 完整当前树中的主文外部 Skill 链接触发 native-reference inventory 查询 | 716,060 B |

两处查询均投影 `Name / Description / Kind / Skill ID / Enabled / Default Context` 六个属性，无行筛选，按 `page_size: 100` 分页。Scalar `read` 没有安装 graph preparation 的共享 inventory context，也没有将 selector 解析时的完整 inventory 传给 native compiler，因此外部链接编译再次获取目录。

下一步归属 **SC11 / AH-628**：在同一次 scalar current read 内，把完整六属性 inventory 从 selector 准入保留到 native-reference 编译；仅在同授权 scope、同 library descriptor 和同 data source 下复用。保留完整分页、物理页面与逻辑身份冲突、disabled/unavailable、owner/scope 和全树引用验证，不能用只含 enabled 项的 `catalog.records` 代替完整观察。现有 graph query 请求全部注册属性，不能直接套用并扩大字段成本；也不建立跨请求新鲜度缓存。

可研究消除的重复组是第二轮 3 次请求 / 716,060 B；本轮尚未实现或重新测量该收益。该瓶颈不归于 SC14 / AH-631 的 expired Records。Trace 未记录调用栈或 response payload hash，调用链是结合上述证据作出的归因；相同长度不证明 payload 逐字节相同或远端事务快照。

归因原件：`ROOT/broker/live-source-01/metadata-inventory-attribution.json`，SHA-256 `dd27fb4b5274fe7d6bc5f7c1cd7b74dca5c78350cd723de4a4c8f1df562cc2c8`。没有新增网络请求、测试或产品源码修改。

## Legacy ZIP 的明确成本

Retained source 选择只读取所选对象缓存，同 hash 只读一次；选中损坏对象不会被下载修复，未选 corrupt/missing 对象保持原样。若缺失的选中对象需要 legacy bundle 恢复，仍验证完整 ZIP 与所有成员，全部成功后只发布缺失的所选对象。

受控 retained 测试选中 16 B `guide.md`，仍实际取得完整 2,097,517 B ZIP，覆盖 65 个唯一 chunk；未选大成员为 2,097,152 B。完整 ZIP SHA 为 `e093bc9f4d2ce49a592e74b4d2cdf0bae9a04992c891420796a833ecf5d17c75`。`whole_archive_cost=true`；65 是 chunk 数，不是 HTTP 请求数。该 fixture 为 1 次 retained-body 查询，decoded JSON response 2,939,106 B；这些值不是实测 wire bytes。

证据：`ROOT/cli/retained-acquisition-evidence.json`。不把仅发布 16 B 改写为仅下载 16 B，也不把这条受控 ZIP 证据代替上节真实来源格式证明。

## 定向回归与包身份

| 回归组 | 实际结果 |
| --- | ---: |
| Current composition、snapshot、成本、refresh/protection、文件生命周期 | 76 pass |
| 固定选择、current receipts、cache、graph release、SDK boundary | 76 pass |
| 纯 composition / placement | 55 pass |
| Selected-source / Git materialization | 25 pass |
| Fixed HTTP/local 安全命名集 | 25 pass |
| Source-plan admission / alias privacy 安全命名集 | 19 pass |
| Retained source | 13 pass |
| 每对象 privacy publication 及相关回归 | 33 pass；新增 8 case |
| 最终 consumer 再验 | 16 pass |

各组有重复复验，不相加作为唯一 case 数。完整命令/退出/日志 hash 均保存在 `ROOT/cli`。全仓 TypeScript 检查通过，变更代码格式与 `git diff --check` 通过。没有运行两个含永久删除 cleanup 的测试文件的全文件 suite；使用已审阅的安全命名集。

| 产物 | SHA-256 |
| --- | --- |
| CLI candidate02 tarball | `12c590a610099e342563b818df66128878b072acce1c426b7b05fea056a045a7` |
| Installed CLI 输入 | `c46eca21db687596f816c8106e2b5047a906657e650e5484819789000378ab22` |
| Installed SDK 输入 | `9d5aa05338cbce5f976ba11cb50424d8770ccbea854f924a914d39ba844499d8` |
| Broker tarball | `faeb20f5e569db5a646c85aa45f917e9ff9a7f0c2bb7bb660e98ed9e1db41820` |
| Broker bundled CLI | `cf34f3f4a412ac73c717aa4fbceba47cb7c9011337d3ca97d773994ca59e898a` |
| Broker bundled SDK | `cd210acdf429e6522296f6ec7c1019ae2e99346cb1a383c4f4f53406dd7a6463` |

两次 CLI 安装的源码产物 hash 完全相同。Broker 会再次 bundle CLI/SDK，因此其输出 hash 单列；pack 与 installed Broker 的 57 个 src/dist 文件逐项相同，运行后未改变。CLI/Broker 原有 staged 工作和其他未跟踪文件保持原样，私有源正文和原始日志没有进入提交。

## 尚未覆盖的范围

SC11/SC12 前置、首次 current 完整观察、新发生的 ownership 转换、Git 隐私分类读取、legacy ZIP 文件级迁移及 SC17/18 后续仍独立推进。完整 SC20 矩阵、正式 SC21 模型 Gate、pro/mini 与正常日用切换没有由本轮推断通过。

本轮没有重新尝试上一轮冻结失败的真实模型样本；历史失败与未完成清理的原件均保持。完成的是来源所有权这一实现和验证切片，不是整个消费链验收。
