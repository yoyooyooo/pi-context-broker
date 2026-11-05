# SC11 单次读取内的完整目录复用

日期：2026-11-05。归属 AH-617 / AH-628。

本轮衔接[来源所有权验证](source-ownership-consumption-verification-2026-11-05.md)定位的重复 Skills 元数据查询：逻辑 selector 取得完整目录后，将同一次读取的观察传给 native-reference 编译。CLI / SDK 的公开结果、持久 catalog 和现有缓存期限保持原合同；SC11 更广的字段投影及需求批次继续独立推进。

原始证据保存在仓库外，以下以 `ROOT` 表示：

```text
/Users/yoyo/Library/Logs/ntn-skills/AH-617-20261105/metadata-5jji3m2y
```

## 实现与边界

CLI 实现提交为 [21152ee](https://github.com/yoyooyooo/notion-skills-cli/commit/21152ee0fc39833f069e90406396a95d758d841e)。该提交的 [metadata consumption 合同](https://github.com/yoyooyooo/notion-skills-cli/blob/21152ee0fc39833f069e90406396a95d758d841e/docs/shared-metadata-consumption.md)说明完整观察、当前页和公开目录的区别。`freshCatalogForRead` 在每次 Effect 执行内创建临时观察集合，强制刷新目录。观察携带完整原始行、scope、完整 library descriptor 副本及 data-source 绑定；在获取来源之前核对这些绑定和 complete 标记。

目录投影仍为已注册 property ID 对应的 `Name / Description / Kind / Skill ID / Enabled / Default Context` 六属性。Disabled 行保留在完整观察中，公开 catalog 的 enabled 过滤保持原语义；不使用 `catalog.records` 伪装完整 inventory。没有增加跨请求缓存、TTL 权威、持久 raw inventory 或 SDK/CLI 协议字段，新的内部入口未从 core 公共 index 导出。

Catalog 与 native-reference 查询共用 metadata inventory reader，完整校验 list envelope、incomplete status、推进 cursor、终页 null cursor 和既有 native cursor 上限。短页或空中间页不会提前结束。Raw record、parent、物理页面重复和逻辑身份冲突检查仍由原调用者负责，未将 graph 的全体 raw-row 严格规则套给其他调用者。

完整选中页仍单独 GET，Source、Files、关系和所有权事实不从六属性目录补造。目录与完整 GET 之间 Name/Description 变化时，当前 record 拥有 self-reference 元数据；逻辑 Skill ID 漂移在来源或正文获取前失败。物理 page-ID 入口仍读取该页的当前身份。当前根的身份 claim 总是保留，不能因外部 inventory 漏掉当前根而放过冒用其 Skill ID 的另一页。

本轮新 handoff 只用于 native-reference 元数据解析。Graph 全属性观察、Members/Requires 的关系查询与 inventory 路径未迁移；当前整树观察、引用验证、source ownership、历史 pin 和 full export 保留。

## Core 回归及失败留痕

新公开读取用例在旧 HEAD 上先实际得到 9 pass / 12 fail / 82 assertions，exit 1。N=101 时旧实现查 4 页，N=300 时查 6 页；逻辑身份漂移错误成功，坏 list object 或终页 cursor 要到正文读取后才失败。原件为 `ROOT/cli/scalar-metadata-red-01.log`，SHA-256 `2949deadde68ac9f16e50676ed58233bb9bfc68e1897e50f69cfa3a81185d67e`。

最终组合运行覆盖新增 22 个 case，以及既有 catalog、snapshot、native references、Router、target snapshot 和 graph batching，共 **166 pass / 0 fail / 1,572 assertions**，10 个文件，真实测试进程 exit 0。该数来自一次终版组合运行，不累加早期重跑。`ROOT/cli/metadata-regression-final.log` SHA-256 为 `9231b1cdbcc7ad47d1dda5009319c847b4ed463a61eb09bc6889f06732b02930`。

其中包括 disabled/unavailable 外部目标、空中间页、同 scope refresh、同一 Effect 重执行、变更 credential、当前根元数据变化、逻辑身份漂移、当前根 claim、公开输出/持久 catalog 不泄露 raw rows，以及 malformed envelope、重复 cursor、外来 parent、重复物理页和 disabled 身份冲突。

一次既有回归为 137 pass / 7 fail：旧 shared-catalog fixture 省略真实 list envelope 的 `object` 字段。只为该模拟响应补上 `object: "list"`；产品拒绝错误 envelope 的检查与新反例均保留。首次 typecheck 的三个新 fixture 行类型错误通过 `Record<string, unknown>` 注解修正，未使用 `any` 或双重断言。所有首次失败日志保留。

终版全仓 typecheck、11 个变更代码/测试/脚本文件格式检查和 `git diff --check` 通过。没有运行含永久删除清理的聚合测试。

### 五档目录规模的实际受控成本

五档 case 在全部断言通过后输出 `SC11_METADATA_COST` 台账，以下直接取自终版日志。每次均独立完整 GET 当前根一次、读取当前根正文一次，不读取其他 Skill 正文；这里仅计 Skills 目录响应。

| Skills 行数 | Skills 请求 | 每页返回行数 | Decoded JSON bytes |
| --- | ---: | --- | ---: |
| 1 | 1 | 1 | 930 |
| 10 | 1 | 10 | 8,598 |
| 100 | 1 | 100 | 85,728 |
| 101 | 2 | 100 / 1 | 86,662 |
| 300 | 3 | 100 / 100 / 100 | 258,272 |

每页实际 property ID、cursor、行数与 responseBytes 均在 `ROOT/cli/metadata-cost-evidence.json`，SHA-256 `5fd8ad9616a5c60825c4194b9601607c6490f301d14b613b169e9f1fedf9e682`。这是内存 provider 的真实 JSON 编码量；`wire_bytes: null`，不当作生产 HTTP 或延迟证据。

## 独立安装 SDK / CLI

使用一次冻结的 101 行 fixture，分别安装旧包和候选包，输出目录完全独立。Fixture SHA-256 为 `1a6f9dbdc5ba49d4527e62f892532ea0e52a0253cc807d08131150d2fcd7fc10`；原件位于 `ROOT/verification/scalar-inventory-qmk_dea4/fixture-01/fixture.json`。

新增场景通过 loopback Notion 服务实际裁剪六属性和分页，分别执行 SDK 冷 logical read、SDK 显式 refresh，以及独立空 Store 的 installed CLI `read RESOURCE --from LOGICAL_REF`。每个入口都核对完整当前页、available/disabled 外部引用、实际 HTTP trace、完整正文和逐文件 offline export；refresh 同时改变根和 disabled 目标元数据。两个消费 Store 初始没有共享事实或对象；原 ownership 和其他 smoke case 保持不变。

旧包实际 **18 pass / 1 fail**，exit 1、signal null、无超时。唯一失败是每次 101 行查询实际 4 页，而非 2 页。三阶段在数量断言之前已完成正文、引用和完整导出核对；旧 cold / CLI 为 179,204 B Skills 响应，refresh 为 179,226 B。两轮分页的实际 response SHA 也相同，这是该受控 fixture 的重复 payload 证据。

原失败保存在 `ROOT/verification/scalar-inventory-qmk_dea4/consumer-red-01`；`scalar-inventory-evidence.json` SHA-256 为 `e998d43185d978c68ab63f7587d8c5c7db7a905a53691b77777dccc28835f091`。26 个子命令均有终局；自有 npm cache 经 Trash 回收，58 份原件与安装入口 hash 保持。

候选包在新的 `ROOT/verification/installed-sc11-g10jhk8g/consumer-green-01` 独立安装，以 Node.js 24.20.0 / npm 11.19.0 执行，实际 **19 pass / 0 fail**，exit 0、signal null。外层进程 PID 12032，耗时 34,315.562 ms；输入包、fixture 和 harness 的 hash 在运行前后保持一致。安装后的 CLI / SDK dist 与下方候选包身份逐项相同。

| 安装态入口 | 旧包 Skills 请求 | 候选 Skills 请求 | 旧包 Skills 解码响应 | 候选 Skills 解码响应 |
| --- | ---: | ---: | ---: | ---: |
| SDK 冷 logical read | 4 | 2 | 179,204 B | 89,602 B |
| SDK 同 Store 显式 refresh | 4 | 2 | 179,226 B | 89,613 B |
| 独立冷 Store 的 CLI `read --from` | 4 | 2 | 179,204 B | 89,602 B |

三阶段均只有一轮 `100 / 1` 行分页，cursor 为 `null → offset-100`，六属性投影、无行筛选及末页 disabled 目标均有实际 loopback 台账。每阶段完整当前页 GET 为 1，外部目标 page/body 读取为 0；正文、native-reference 元数据和逐文件完整 export 与独立 full-page oracle 相符。刷新反映修改后的根与 disabled 目标元数据。完整 trace 与服务端实际请求、解码字节对账，未知字节、dropped、in-flight、失败和取消均为 0。

`consumer-green-01/report.json` SHA-256 为 `9914fed6348eddb887fae151f252cbbefb732311b31b13ef1d660e53952ed92a`；`scalar-inventory-evidence.json` 为 `b5bd0fd96c5b290ead52cac3c49777878bbb5e98904c9d95936488f73a043283`；原始 `scalar-inventory-notion-requests.jsonl` 为 `7a9d8cd2292bebab1d3c3725cdeecca7042f2839ab1d64a3c0c4e515b78b0d37`。

26 个子命令均有 code/signal 终局记录，其中 `STATE_CORRUPT`、`SNAPSHOT_MISSING` 两个 exit 1 是预期负例。只将自有 npm cache 交给系统 Trash；210 份原件及安装入口 hash 在清理前后保持，安装结果与完整导出保留。

安装执行由主会话完成，独立原件审查通过：审查者按冻结 fixture 的行和实际六属性重建逐页响应，重算长度与 SHA-256，并核对 ledger、metrics、三份实际导出和 tarball 内外的安装字节。新会话 agent 使用规程的行为评估未完成，不据此声称验证 Skill 的行为改善已通过。

## 同目标的真实来源冷读

复用前轮真实样本的目标、资源路径、`resource-only` pipeline、1 次 cold / 其余 0 次以及 120,000 ms 预算。配置仅替换安装后的 CLI 路径和新的 evidenceRoot；来源读取从空的自有状态开始，doctor 只执行离线 version/help。没有生产写入或模型调用。

新 run 为 `ROOT/broker/live-source-01/source-20261105T045941272Z-e051645d`。实际产品进程 PID 12635，exit 0、signal null，无超时、取消或失败。前后均只有一次受测 CLI 读取；材料观察直接检查其自有缓存，没有再发起读取命令。

| 真实冷读指标 | 前轮已安装包 | 本轮已安装包 |
| --- | ---: | ---: |
| HTTP 总请求 | 19 | 16 |
| Metadata 请求 | 14 | 11 |
| Skills 目录分页请求 | 6（两轮各 3 页） | 3（一轮） |
| Current-body / retained-body 请求 | 4 / 1 | 4 / 1 |
| Write / provider 请求 | 0 / 0 | 0 / 0 |
| 请求字节 | 1,767 B | 1,530 B |
| 解码响应字节 | 1,532,016 B | 815,762 B |
| CLI 进程耗时 | 12,179.436334 ms | 9,825.129167 ms |

该样本总响应减少 **716,254 B（46.75%）**。旧 trace 最后的第 17～19 次请求是第二轮 Skills 分页，三页基线合计 716,060 B；本轮这三次请求消失。保留的第 3、6 个响应另分别减少 172 B、22 B，这额外 194 B 不归因于本次实现。剩余第一次 Skills 分页实际为 `255,758 / 216,563 / 243,567 B`，合计 715,888 B，仍是后续优化的主要成本。

两次 trace 均完整，未知请求/响应字节、dropped、in-flight 和 retry wait 均为 0；新样本 16 次 HTTP 全部成功。前 16 个请求按 kind、body-kind、target 和 method 对齐。安全 live trace 不含完整 URL query 或响应 payload hash，字段投影归因结合冻结的实现和安装态真实 loopback 台账，不把同字节数当成生产 payload 相等。

返回资源仍为 3,374 B，SHA-256 `3ef9aa54c7b00037fdab33db08c9e29d760a9e3855587ea956748d6a93d311e5`。`record / entrypoint / scope / snapshot_id / version_id / path / ref / source / file_bindings / native_references / members / required / content / range / has_more` 逐项相同；四个有效文件的路径、字节及 hash 和九个缓存对象也完全相同。现有整树物化和 retained-body 成本仍在，不能由 provider 为 0 推断其消失。

前后各一个样本，只能报告此次耗时，不建立稳定延迟改善或 p95 结论。比较原件为 `ROOT/broker/live-source-01/comparison.json`，SHA-256 `ee7180f05c7854fd86f09df244c573e6f96b4cc250c0432c6e1592cd6e2cf150`。

外层 Python 封装曾将 driver 的多段 JSON stdout 当作单个 JSON 解析而报错；实际 driver 与产品进程均已 exit 0。保留 `orchestration-parse-error.json`，随后只从同一已完成 run 生成 evidence，未重跑来源样本。原 driver 校验 coverage、命令身份、stdout/stderr、每次 spawn/close、snapshot manifest 和冻结 driver 的原始 hash 均通过。

使用 driver 的既有 cleanup 将唯一自有 working 目录交给系统 Trash；清理前的 15 份原件 hash 保持，清理后重新生成的 evidence 也逐字一致。`evidence.json` SHA-256 为 `130d76327b2abe94ec09c66cd83c46416ef593b9e7586d0860f15bd130bc91eb`，`artifactIntegrity.valid: true`。

## 候选包身份

本次独立 build / npm pack 均实际 exit 0。构建前后的 7 个产品源码 hash 一致，原件在 `ROOT/cli/candidate-source-files-01.json`。

| 产物 | SHA-256 |
| --- | --- |
| CLI candidate tarball | `024dbe86488d20f1665f5d3b957f333f6e28852fa3251c1896269fb36c274e60` |
| CLI dist | `e5b547906b328b9e3700c3fbc8ec214ddd2789ba113bd2e7a41c6b9888d93b69` |
| SDK dist | `7beb7e37b796098095b0342e9855aaaf67672f47baf8f8cc77db9e188533acd9` |

Tarball 为 1,489,166 B，64 个包文件；保留在 `ROOT/cli-pack-01/ntn-skills-0.1.0.tgz`。实际安装身份见 `ROOT/verification/installed-sc11-g10jhk8g/installed-identity.json`；安装后的 CLI 同时用于本轮真实来源样本。

## 未由本轮证明的范围

SC11 的需求图、选择 ID 批次、返回字节预算、其他字段投影及完整关系分页矩阵仍需独立推进。首次 current 全树观察、Git 隐私读取和 legacy ZIP 成本不因目录复用消失。

本轮不把前轮实际 Pi 的通过沿用为新包 Pi 结果，也不重新尝试冻结失败的真实模型样本；SC20 全矩阵、SC21 模型 Gate、pro/mini 与正常日用切换没有由本轮推断通过。
