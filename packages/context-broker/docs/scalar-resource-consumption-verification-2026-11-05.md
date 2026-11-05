# 固定单资源直读：Pi 调用链与实际成本

本切片承接 [AH-617](https://linear.app/yoyooyooo/issue/AH-617) 的 SC07 / AH-626 与 SC13 / AH-630。固定资源读取现在直接取得目标文件及独立 owner 证明，再交给 Pi 原生 `read`。受控对照中，五次资源读取的 SDK 调用由十次降为五次，主文对象读取由十次降为零；Agent 的工具调用、原生内容与结构化输出、实际 provider 请求字节保持不变。

优化发生在 Pi 获取资源的调用链。Notion 管理层的作者正文、关系、目录、历史与编辑能力没有修改。模型本来就没有收到这些多余读取的主文，因此本切片不宣称模型 token 减少。

## 改动与兼容边界

旧 `prepareRead` 在读取固定资源时先 `activate` / `consume inspect` 准备 owner 主文，再通过 SDK 输出资源。实际基线的五次资源调用各自重复准备一次主文。

CLI 的 [0bbc352](https://github.com/yoyooyooo/notion-skills-cli/commit/0bbc352a9e0d60f3d95cbce35e0b744450568370) 在 `readSkill(ref, { output })` 中增加 `sha256` 与 `entrypoint_sha256`。前者绑定实际校验的资源字节，后者来自已验证固定 manifest 的主文项；取得后者不读取主文对象。普通 text/lines read 的形状不变。SDK 与 Broker runtime manifest 分别声明 `READ_OUTPUT_PROOF_VERSION = 1` 和 `read_output_proof_version: 1`。

Broker 继续验证启用的来源、owner、scope、pin、版本、稳定 File ID、canonical ref、输出路径及实际 bytes/SHA，然后发布到既有 immutable 资源目录。`sr:R` 的主文 commitment 来自 SDK，不能用句柄自身的 hash 充当新证明。已有 prepared/loaded owner 的文件清单和持久 session binding 也继续约束同 pin 读取；source、native 返回及附 receipt 前均重新检查当前会话、分支和取消信号，并保留操作起点的约束。

Native 只收到替换后的 `path`，其余参数和返回对象不变。直接资源读取没有主文 entry manifest，不写主文 selected graph、delivery 或 active；已有会话 pin 仍受到保护。资源 v1 receipt 始终 `loaded: false`，完整文本状态依据真正返回的 bytes/hash 判断。

兼容范围如下：

- scalar 不使用 batch 的 1 MiB 默认值或 16 MiB 上限；Core 与 Broker source 均验证了 17 MiB 对象。
- 旧 SDK 未声明新能力时，在任何资源操作前回到原路线；声明不一致明确失败。custom command、非 Pi、未固定引用和本地路径保留原路线。
- canonical main 路径即使带 File ID 也走原主文路线，避免新增预读。旧 main-path hint 指向资源时仍由原路线正确解析；resource-path hint 实际指向 main 时明确继续主文准备。
- 分页、BOM/CRLF、空文件、二进制与图像委托保持原生语义。没有新增工具或主文恢复协议。

## 冻结输入与独立安装

对照包含 Broker 和 bundled CLI/SDK 两部分变化，不能称为只改 Broker。两臂使用同一冻结 fixture、最终 driver、Node 24.20.0、实际安装的 Pi 1.4.0、相同读取顺序和受控 provider。

| 输入 | 身份 |
| --- | --- |
| Broker 基线 | `b295cff9dff0b362b024c16de8fd278296c4aba7` |
| CLI 基线 | `21152ee0fc39833f069e90406396a95d758d841e` |
| CLI 候选 | `0bbc352a9e0d60f3d95cbce35e0b744450568370` |
| Broker 基线 tar SHA256 | `6026833f5d5aa574edc74c230cc46edef86a05ff69149664d4b3f358ae079cfa` |
| Broker 候选 tar SHA256 | `84f30502e681b091a61acc05274737861d901d9a2ae139df813ef19ce9bdaa93` |
| CLI 候选 tar SHA256 | `2b0535baaee16e17501d64153e74a61448144f2f33b6c3262453623c36704c44` |
| 冻结 fixture SHA256 | `1a6f9dbdc5ba49d4527e62f892532ea0e52a0253cc807d08131150d2fcd7fc10` |
| 最终 driver SHA256 | `428b3131b8243235ccd43a0a498a5618acb2c997b3e5fb0c048940bd358d33df` |
| 候选 bundled CLI SHA256 | `2070b4dc9e4e781dedd278a97a59ac3fc9863f7cefd769f8a476ce6181d3ebc2` |
| 候选 bundled SDK SHA256 | `10a4f87ddafed9275dcbb96b3799fc0e5cf774c2eb08e0db1e462bc76ca64289` |

基线与候选都由独立 npm 安装包驱动，`source.command` 缺省。候选构建前后 45 个运行时源码文件的 hashes 一致；本报告与最终导航是在验证后补入的文档，不将这些文档追认为当时 tar 已包含的文件。包版本号没有替代实际 tar、源码和 bundle 身份；没有发布 npm 或切换日用安装。

## 五次实际读取

每个 scalar 场景第一工具调用直接 `read`，没有被测 search 或 inspect。所有六次 provider capture 均通过 installed pi-ai serializer 向 localhost 发出真实 HTTP，并保留原始请求体。

| 顺序 | 读取 | 源 bytes | native 文本 bytes | 完整文本 receipt |
| --- | --- | ---: | ---: | --- |
| 1 | UTF-8 全文 | 45 | 45 | true |
| 2 | BOM/CRLF，offset 2、limit 1 | 49 | 71，包含原生续读提示 | false |
| 3 | 同一 BOM/CRLF 文件全文 | 49 | 49 | true |
| 4 | 二进制 | 7 | 11，原生解码结果 | false |
| 5 | 空文件 | 0 | 0 | true |

四份原始资源均按 bytes/SHA 留存，五次读取的原生 `content` 与 `structuredContent` 在两臂逐项一致；host `details` 保留各臂实际证明，候选不再包含主文 materialization。空文件的 raw/session 文本仍为空串；Pi serializer 的 `(no tool output)` 占位按实际 HTTP 字节计数。7 B binary 不是图片 E2E，图像、signal、额外参数和返回对象透传由定向 adapter/host 测试验证。

`resource-scalar-short-refs` 用真实 installed SessionManager 与 Broker bridge 创建 metadata-only seed，再在新 Pi 进程恢复。seed 只含一个 selected 短引用、四个资源短引用和 setup 用户消息，未读取或物化主文，没有 delivery/active。该证据证明持久化资源句柄的恢复读取，不声称 Agent 能在未检查 owner 时首次生成这些句柄。

## 配对结果

以下变化在 canonical 和恢复后的 `sr:R` 两组中相同：

| 指标，每组五次读取 | 基线 | 候选 |
| --- | ---: | ---: |
| SDK 总调用 | 10 | 5 |
| `consume` | 5 | 0 |
| scalar `read` | 5 | 5 |
| `read-resources` | 0 | 0 |
| Node Store 对象 readFile 调用 | 20 | 10 |
| 对象读取返回字节 | 700 B | 300 B |
| 主文对象读取 | 10 次 / 400 B | 0 |
| 实际主文物化文件 | 1 | 0 |
| 主文 selected graph 条目 | 1 | 0 |
| 主文 delivery / active | 0 / 0 | 0 / 0 |
| body-free metadata index stub | 6 | 6 |
| 未选资源读取 / 物化 | 0 / 0 | 0 / 0 |

对象计量来自实际 `node:fs.readFile` 边界，正控制匹配四个资源的返回字节与 SHA；它不是全部文件系统 I/O 的计量。fixture 主文只有 40 B，因此本表证明重复工作被去掉，不外推生产绝对字节或稳定延迟。六个索引 stub 逐个验证不含主文；文件名叫 `SKILL.md` 不等于已物化主文，任何路径下匹配主文 SHA 的文件都不能豁免。

| 实际 provider HTTP | 基线累计 bytes | 候选累计 bytes | 请求 / 工具调用，两臂相同 |
| --- | ---: | ---: | ---: |
| canonical 固定资源 | 63,967 | 63,967 | 6 / 5 |
| 恢复后的 `sr:R` | 58,878 | 58,878 | 6 / 5 |

模型工具文本累计均为 694 B，工具 schema 与结果保留。捕获上下文的机器 details 累计从 12,824 B 降到 10,678 B，这些字段不进入模型 HTTP，不计作模型上下文节省。本切片没有增加 Agent 往返，也没有测量真实模型 token、质量或生产延迟。

## 回归与复审

| 层级 | 本次结果 |
| --- | --- |
| CLI Core / SDK 定向测试 | 24 项，120 assertions；包括缺失 main、empty、binary、17 MiB 和普通 text 形状 |
| 独立 npm Node SDK / CLI smoke | 19/19；声明闭合、output 双 SHA、CLI 等价、既有资源/取消等合同 |
| Broker 最终联合 gate | 109 项，946 assertions；来源、File、short-ref、原生 read、会话和 prepare |
| 最终 runner helpers | 34/34 |
| TypeScript / diff / 地图 | 两仓类型检查通过；diff 与 24-task / 21-journey / 1,120-tuple 地图检查通过 |
| 实际 Pi | 两组 baseline/candidate 配对，加一次候选 native 互操作，共五个正式运行通过 |

额外的候选 `native` 路径保持 search → 主文 → 资源互操作：3 个工具调用、4 个 provider 请求、41,070 B HTTP，1 consume + 1 resource read。它保留完整主文 footer 和真实资源短引用；该既有场景未启用对象 observer，不把其未观测对象数记为零。

交叉复审修正了两处回归风险：普通 canonical main 携带 File ID 时不应新增一次资源预读；已有 prepared/loaded 或持久 session binding 时，同 pin 的主文/资源 commitment 也必须继续匹配。新增反例覆盖这些情况以及 source/native 两阶段 owner 替换、取消、branch rewind 与 legacy 只有 pin 的 receipt。

五个正式运行各有两个离线目录 CLI：catalog exit 0，Default View exit 1。失败 stdout 均为 812 B，SHA256 `fd61bf027c3a05cc15543653231fcc97f46bb06a31e25099ee6b520a49200659`；native 公开结果保留 `CACHE_MISSING`。这些失败与成功 SDK 读取分开，未声明 Default View/menu 已通过。

## 证据与保留

证据根为 `/Users/yoyo/Library/Logs/ntn-skills/AH-617-20261105/scalar-resource-hwkesj3s`。正式对照位于 `verification/baseline-scalar-02`、`baseline-scalar-short-02`、`candidate-scalar-01`、`candidate-scalar-short-01`，native 回归位于 `candidate-native-01`。两个独立汇总为 `scalar-comparison-root.json` 与 `scalar-comparison-agent.json`。

最初的两个 baseline `-01` 保留为观察器分类修正前证据。其功能结果通过，但把六个 metadata stub 也计作主文物化；最终 driver 分开识别并再次执行两臂。CLI fail-before 日志也保留：修正大对象 fixture 的编码方式后，四个 output 用例均先因缺少双 SHA 失败，再在产品补充后通过。

七个 Pi run 已逐个执行 evidence → cleanup → evidence，21 条命令均 exit 0，271 份原件 bytes/SHA 不变，七个原 scratch 经系统 Trash 回收。归档 session、HTTP、observer、资源 bytes、包及终局回执均保留。正式单元测试使用独占临时根；早期 Agent 探查没有逐路径 ownership receipt 的默认临时目录保留，不按名称或时间推定归属。

复跑命令与分层边界见[消费地图](../../../.agents/skills/verify-notion-skills-integration/features/skill-consumption.md)及[资源合同](fixed-resource-batches.md)。本切片不关闭整个 AH-617、SC07、SC13 或正式真实模型/双机/日用安装门槛。
