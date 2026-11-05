# 重复读取：单次对象复用与最小模型确认

日期：2026-11-05（Asia/Manila）。归属 [AH-617](https://linear.app/yoyooyooo/issue/AH-617)、[SC05 / AH-622](https://linear.app/yoyooyooo/issue/AH-622)、[SC08 / AH-627](https://linear.app/yoyooyooo/issue/AH-627) 与 [SC13 / AH-630](https://linear.app/yoyooyooo/issue/AH-630)。承接[固定单资源直读](scalar-resource-consumption-verification-2026-11-05.md)，继续优化 Pi Agent 的获取链路与当前模型上下文。

## 本轮结果

| 同条件配对 | 基线 | 候选 | 已证明的变化 |
| --- | ---: | ---: | --- |
| 固定 canonical 资源的五次 SDK read | 对象读取 10 次、300 B | 5 次、150 B | 每个 SDK 调用区间从两次降为一次 |
| 恢复后的 `sr:R` 资源的五次 SDK read | 对象读取 10 次、300 B | 5 次、150 B | 同样逐次核验，空文件也有读取事件 |
| 重复 native 主文与资源的六次 HTTP 请求体累计 | 67,969 B | 67,235 B | 减少 734 B，约 1.08% |
| 每个场景的工具调用 / provider 请求 | 5 / 6 | 5 / 6 | 没有增加 Agent 往返 |

第一项减少同次固定读取中的重复 Store 对象获取，第二项压短已经去重后的冗长确认。完整作者正文、首次必要内容、资源目录和原始历史保持完整。Notion 管理结构与作者内容没有改写。

这次 baseline 已具备固定资源直读能力；不能把上一轮的 SDK 10→5 或主文读取归零再次算作本轮收益。canonical 与恢复短引用分别运行、分别计量。

## 实现边界

### CLI：同次固定选择复用已获取的 bytes

此前 `targetSnapshot(..., "target")` 通过 `openFixedSnapshotFiles` 读取并验证目标对象，返回 snapshot 时丢弃已取得的 bytes；随后 `readSkill` 再次调用 Store 读取同一文件。

私有 `acquireTargetSnapshot` 现在返回 snapshot 与可选的已选文件。公开 `targetSnapshot` 仍只返回原来的 `ObservedSnapshot`。`readSkill` 仅在 fixed 分支按最终路径使用匹配 bytes；没有匹配时继续原 Store 读取路径。最终 manifest 字节数与 SHA 校验完整保留。

没有跨调用 cache；连续读取两次仍各自读取对象，成功后对象损坏时下一次调用拒绝。current / 未固定选择的 freshness 与 cache 路径保持原行为。内部 bytes 不进入 Snapshot、manifest 或 SDK JSON。这里证明对象读取次数减少，不声称 hash 次数或 CPU 成本减少。

CLI 提交：[98dea442517f8a9afeea7c9f1a1d1b4a5869684f](https://github.com/yoyooyooo/notion-skills-cli/commit/98dea442517f8a9afeea7c9f1a1d1b4a5869684f)，父提交为 `0bbc352a9e0d60f3d95cbce35e0b744450568370`。

### Broker：简短确认与明确失效的投影证明

当前 provider 消息集合已有通过校验的同版本完整正文时，重复主文统一为 `Already loaded.`，重复 scalar / batch 资源统一为 `Already available.`。保留主文 native footer、其他文本块及非正文结构。

确认文本不能成为新的正文证明，即使作者原文恰好等于确认本身。派生 provider native 主文明确写入 `loaded: false`，scalar 资源明确写入 `delivered_complete_text: false`。主文验证器只拒绝显式 false，兼容旧回执没有该字段的情况。原始 tool result 和 session 回执不改；压缩或分支移除较早正文后，可从保留的原始结果重新投影完整正文。

空资源保持空内容。极短非空正文仍维持当前上下文内单份完整正文的规则，固定确认可能比极短原文更长，不能宣称每种输入都严格缩小。partial、failed、image 结果和不匹配 scope / pin 的结果不冒充完整正文。目录证明合同没有扩展。

## 冻结输入与安装产物

私有证据根记为 `ROOT`：

`/Users/yoyo/Library/Logs/ntn-skills/AH-617-20261105/repeat-read-4c3rhftl`

基线 Broker 为前一轮独立安装包，对应源码 `4b8feacbce710ac3005a192aa0e298e022881e6c`；CLI 对应 `0bbc352a9e0d60f3d95cbce35e0b744450568370`。候选先构建 CLI、npm pack 并独立安装，再由该安装包提供 `NTN_SKILLS_BUILD_ENTRY`，只构建 Broker target 并独立 npm 安装。实际 Pi 的 `source.command` 缺省，使用 bundled SDK。

| 产物 | SHA-256 |
| --- | --- |
| 基线 CLI tar | `2b0535baaee16e17501d64153e74a61448144f2f33b6c3262453623c36704c44` |
| 候选 CLI tar | `e96b009bf049c1c3d1a92fd0445302166f8a007f4b998a6c96cd33bf727e3897` |
| 候选独立安装 CLI | `dca94c00e348f61f67edb42fd0c24b8c8ccd80aa15210e81191c327116237759` |
| 候选独立安装 SDK | `8b5daf5095e292292b1763a3ceba4cb8166713a428d536e12aa795767dfa2d84` |
| 基线 Broker tar | `84f30502e681b091a61acc05274737861d901d9a2ae139df813ef19ce9bdaa93` |
| 候选 Broker tar | `71bb10fc805fd15260089f4693e514b0556d2acf3658d2d5b5f360835b987548` |
| 候选 Broker bundled CLI | `69ad8e7a61150ee4c4058434c84e6d415aeac5b6efa0c023fc3da98ee77fcdc0` |
| 候选 Broker bundled SDK | `5cbe0f71464d63c26168492da4cb46ece06274339a979bd71f9046ed11e650f7` |
| 最终 driver | `b0c3f2a4332126e2a4de6c022ad3ee3b3652f7f3b9af397b7d9768cb81c02e2b` |
| 最终 helper tests | `e119fc91ab37f0603d960c3c2e3a15d04c314b62dfd86b3d217c1c6a32268ba2` |
| 共同 fixture.json | `1a6f9dbdc5ba49d4527e62f892532ea0e52a0253cc807d08131150d2fcd7fc10` |

CLI 的 309 个运行源码文件、Broker 的 45 个运行源码文件在构建前后核对一致；两份清单为 `cli/candidate-source-files.json`、`broker/candidate-source-files.json`。consumer、resource、read-output proof 版本均保持 1。候选最终报告及导航链接在构建后补充，不能把这些最终文档声称为当时 tar 的内容。

六次正式运行共用 `verification/driver-freeze-02/`。共同 warm fixture 包含 40 B 主文、45 B guide、49 B BOM/CRLF 文件、7 B binary、0 B empty 及未选文件。SDK smoke 使用另行归属、仅重定位路径的 fixture clone；原 fixture 未改。

## 三组实际 Pi 对照

### 重复 native 读取

`baseline-native-repeat-02` 与 `candidate-native-repeat-01` 的实际工具序列为：search → 首次主文 → 首次 guide → 重复主文 → 重复 guide。首次 read 使用真实 search 返回的 `sr:C`；随后使用首次主文 footer 返回的 `sr:S` / `sr:R`，没有额外 inspect 或测试专用读取。

| 指标 | 基线 | 候选 |
| --- | ---: | ---: |
| 实际 HTTP body 累计 | 67,969 B | 67,235 B |
| HTTP tool content 累计 | 10,864 B | 10,130 B |
| 宿主 details 累计 | 32,904 B | 32,935 B |
| 主文确认 | 274 B | 15 B |
| 资源确认 | 234 B | 18 B |
| SDK consume / scalar read | 1 / 2 | 1 / 2 |
| 工具 / provider 请求 | 5 / 6 | 5 / 6 |

六轮实际 HTTP 的节省分别是 `[0, 0, 0, 0, 259, 475]` B：主文确认减少 259 B，出现在后两轮；资源确认减少 216 B，出现在最后一轮。因此累计差额为 `259 × 2 + 216 = 734` B。

宿主 details 因明确失效标记增加 31 B，这些字段没有进入模型 HTTP。首份 40 B 主文、45 B guide 和完整 native footer 保留。原始 session 仍有两份完整主文与两份完整资源结果；selected graph 为 1、主文 delivery 为 2、active 为 0。provider 在正文首次可见后维持各一份完整内容。

实际 native 主文有正文、目录两个独立文本块。Pi 1.4 的原始资源 RPC 含 `structuredContent`，provider / archived session 自然省略该字段；验证按真实边界检查，不人工补入。此场景没有启用 object observer，对象次数为 unknown / null，不能记为零。

### 固定资源 canonical 与恢复短引用

正式运行分别是 `baseline-scalar-01` / `candidate-scalar-01`，以及 `baseline-scalar-short-01` / `candidate-scalar-short-01`。

| 每条路径的指标 | 基线 | 候选 |
| --- | ---: | ---: |
| SDK read / consume / read-resources | 5 / 0 / 0 | 5 / 0 / 0 |
| Store Node readFile 事件 | 10 | 5 |
| 每个 SDK 区间内的对象读取 | `[2, 2, 2, 2, 2]` | `[1, 1, 1, 1, 1]` |
| 返回源对象字节累计 | 300 B | 150 B |
| 主文 / 未选对象读取 | 0 / 0 | 0 / 0 |
| 主文 / 未选对象物化 | 0 / 0 | 0 / 0 |
| 主文 selected graph / delivery / active | 0 / 0 / 0 | 0 / 0 / 0 |
| metadata stub | 6 | 6 |
| HTTP tool content 累计 | 694 B | 694 B |
| 宿主 details 累计 | 10,678 B | 10,678 B |

canonical 的实际 HTTP body 为 **63,967→63,967 B**；恢复短引用为 **58,878→58,878 B**。此处收益在对象获取，不在模型输入。两种表示分别成对比较，不把跨场景的输入差额归为本轮实现收益。

五次 read 依次为 guide 全文、BOM/CRLF 分页、同文件全文、binary、empty，源对象字节依次为 `45、49、49、7、0`。分页原生文本 71 B、完整 BOM/CRLF 49 B、binary 解码文本 11 B 均保持；empty 的 native/session 原文为空，HTTP 中 Pi 的 `(no tool output)` 占位按实际字节计数。没有真实图片 fixture，binary 不代表 image E2E。

每次 SDK start/end 与对象 start/end 使用同一 observer 的严格递增序号，检查区间、顺序、非重叠、目标路径、API、bytes/SHA 及无孤立事件。SDK observer 没有 RPC id，使用已验证的顺序调用计划对应，未伪造关联 id，也未用总量平均代替逐次证明。

短引用 variant 通过已安装 SessionManager / bridge 创建 metadata-only seed，再由新 Pi 进程恢复；seed 不含主文、物化、delivery 或 active。它证明持久化句柄恢复消费，不声称 Agent 未 inspect 时自主产生了这些句柄。

## 独立复算与证据边界

两名审阅者分别复核三组配对。Root 重算全部 **36 份原始 HTTP body** 的字节数和 SHA，从归档会话真实 `context-broker-short-ref` entries 建立双射；resource 先展开本会话的 selected owner，再比较完整 source、scope、locator、snapshot/version、File 身份、bytes/SHA。

native-repeat 有 12 组绑定（6 C、1 S、5 R），canonical 为 0，恢复资源为 5 组（1 S、4 R）。只有目标完整相同且唯一、同类型、同为 26 ASCII bytes 的句柄才允许对应。两侧 owned cwd 也从各自 launch/report 验证且等长。只应用这些明确的等宽对应及三处确认替换后，原始 HTTP bytes 精确相等，没有其他未解释差异。没有通配删除字段或修改原件。

根复算为 `verification/repeat-comparison-root.json`、`verification/short-ref-bijection-root.json`；独立复算为 `repeat-comparison-agent.json`、`repeat-short-ref-map-agent.json`。最初直接比较遇到进程 request id、会话句柄与 cwd 差异的失败尝试保留在 `comparison-attempts-root.json`，最终归因使用明确身份映射。

六次正式运行的 package unchanged、evidence stable 和全部 observer / child 终局均闭合。每次都实际启动两个 catalog child：普通 catalog exit 0，离线 Default View 因 `CACHE_MISSING` exit 1。失败输出原样保留，不将 Default View 记为通过。来源 SDK/CLI HTTP 为 0 只描述 warm 离线 fixture。

## 验证与保留的失败

| 门禁 | 最终结果 |
| --- | --- |
| CLI Core / SDK 定向测试 | 50 passed，248 assertions |
| CLI TypeScript、修改文件 Biome | 通过 |
| Broker 会话 / 资源 / host 定向测试 | 47 passed，577 assertions |
| Broker TypeScript | 通过 |
| 既有 Pi runner helpers | 42 passed |
| 独立安装 CLI / SDK smoke | 19 cases passed |
| 三组实际 Pi 配对 | 6 个正式运行 passed |

覆盖同次 fixed main/resource、text/output、empty、binary、17 MiB、relative / from / stable File ID、retained manifest、公开 Snapshot 形状、连续读取后损坏拒绝；Broker 覆盖 raw/XML/JSON、tiny/empty、正文恰等于确认、v2/v3、scalar/batch/compiled、不同 scope/pin、partial/failed/images、重复投影及从原始历史恢复。运行代码经相互只读审阅，结论见 `verification/cross-review-root.json`。

首个 `baseline-native-repeat-01` 因 helper 假设主文只有一个文本块而失败。修复验证器以保留真实正文与目录两块，补齐单块/双块、Unicode 字符与 UTF-8 字节、不同长度确认及目录丢失/篡改/合并反例后冻结 driver 02。运行时与已安装包没有因此改动；该次失败与 driver 01 保留，不计入正式配对。CLI 最初 public-shape oracle、类型、格式失败，以及一次根 smoke 汇总键错误，也保留原日志；没有将旧失败重写为成功。

## 归档与清理

七次 Pi 运行（含失败 01）完成既有 `evidence → cleanup → evidence`，21 条命令均 exit 0。清理前 **249 份原件、2,983,184 B** 全部 bytes/SHA 不变，七个精确 owned scratch 已移至系统 Trash，每个运行只新增 `cleanup.json`。249 包含各自 `retained.json`；原 helper 所列 retained 文件合计 242。独立复核见 `verification/repeat-pi-cleanup-cross-review.json`。

另将六个自有测试、fixture、build 临时根归档后逐成员验证：1,296 个条目，含 1,190 个文件、1 个 symlink，文件内容 17,559,792 B。归档保留并验证一个 hardlink；首次验证器只允许普通文件而拒绝的记录留在 `cleanup/archive-validation-attempt-01.json`，归档本身未改。随后六个根和两个可再生 npm cache 共八个目录移至系统 Trash；包、tar、installed consumers、运行原件与日志继续保留。

| 清理证据 | SHA-256 |
| --- | --- |
| Pi 原件清单 | `c3edcc42313ae256be11268bf1a09793ad068d016ebe2f5160af872c933d5e4a` |
| Pi 清理回执 | `4deac3118d1afbc1de581cc65ba02f7f042e1c42b53f228cf70e0e337a1f6b68` |
| Pi 独立清理复核 | `531a556b06eb8c59a549c37b19baafb673ed9f9729e0547ea01c7086f5c33df1` |
| `cleanup/owned-test-build-fixtures.tar.gz` | `db250b9f8766b444cb17f44c975f8e2d30267927222f0f3421a6bbb4f462c6ce` |
| `cleanup/owned-temporary-cleanup.json` | `e5c1a7d59b69ab127a15a8c5a4fea8ad4d6daf388c40a42576660cf2fabf6d03` |

## 尚未覆盖的范围

本轮没有调用真实模型、写生产 Notion、切换日用安装或发布 npm。实际 Pi 与 serializer/localhost HTTP 的成功不能替代正式模型选路、token、生产延迟或跨机验收。current 全树观察、权限与 freshness、冷恢复和网络成本沿对应任务独立验收。

后续可核查 `graph-prepare.ts` 在 entrypoint 获取后再次读取 main 的结构；本轮仅记录静态线索，没有实现或计入收益。AH-617 与相关子任务继续保持 In Progress。

复现入口见[消费链验证地图](../../../.agents/skills/verify-notion-skills-integration/features/skill-consumption.md)的 SC05 / SC08 重复 native 与 SC07 / SC13 固定 scalar 路线。最终报告与导航是本轮提交的一部分，运行源码身份、安装包与原始测量以冻结回执为准。
