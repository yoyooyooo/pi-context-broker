# CodeMode 关闭：六对保留记录的成本诊断

这是旧 SDK2 合同下 12 个保留 run 的公开派生诊断。它定位后续验证方向；没有实施压缩，也没有证明当前 SDK3 收益。

## 已观察到的等待位置

| 阶段，六个 episode 累计 | Broker 秒 | native 秒 | 差额秒 |
|---|---:|---:|---:|
| 首次 HTTP 前初始化 | 44.671 | 4.531 | +40.140 |
| Provider HTTP→usage 区间并集 | 106.345 | 136.595 | -30.250 |
| 工具执行区间并集 | 70.145 | 0.115 | +70.030 |
| 其他间隙 | 0.731 | 0.636 | +0.095 |
| 单调时钟 endpoint 总计 | 221.893 | 141.877 | +80.015 |

每个 episode 内使用同一 recorder 的单调时钟相减。58 个 provider 区间逐一核对无重叠，每 request 只有一个 HTTP attempt；工具可能并行，使用区间并集，且与 provider 区间不重叠。单独报告的 duration 汇总与 endpoint 分区差额相差约 0.018 ms。

目录初始化、consume 和固定资源读取的 SDK receipt 共记录 164 个成功来源 HTTP attempt，其中 149 个 metadata、15 个 body。初始化目录 list 为 35.306 秒；consume 为 40.595 秒；read 为 21.794 秒；read-resources 为 3.808 秒；后续 list 为 3.454 秒。这些是初始化/工具内部的子操作观测，不能再与表格相加。

Provider HTTP→usage 包含网络、流式响应和客户端接收，不能等同服务器计算时间。本组 Broker 该区间累计少 30.250 秒，因此净增加的 80.015 秒不能归因为模型等待增加。

## 已观察到的输入体积

双方各 29 次请求。Broker 累计 input 120,444，native 106,450，差 13,994；六对首次请求在工具执行前已多 419～425 tokens。Broker 的 tools 数组在全部 29 个请求中保持相同，compact UTF8 JSON 为 9,098 字节；native 为 3,488 字节，差 5,610 字节。公开载荷逐项复核仍保留这些数值。

| 常驻工具定义 | Broker 字节 | native 字节 |
|---|---:|---:|
| read | 3,164 | 684 |
| notion_list | 1,644 | — |
| notion_use | 1,484 | — |
| bash / edit / write / tool_search | 两组相同 | 两组相同 |

工具数组字节差不等于组件级 token 差，也不能直接换算账单。按 `累计 input = 请求数 × 首次 input + 后续相对首次增长` 的恒等式，两组前项差 12,251、后项差 1,743；这不是因果分摊。complementary 的 Broker 多一次请求，continuation 少一次，总次数相同不能抹去路径差异。

## 当前源码与唯一后续候选

旧六次固定 read 均记录 5 次 metadata + 1 次 retained-body 请求。当前源码改为本地对象优先、缺字节才核验 current Library、owner、index 和 descriptor，不能把旧次数与等待直接外推到 SDK3。

**先离线检查当前 SDK3 实际装载的 off 请求载荷；若确认常驻工具契约与宿主指导存在明显可删重复，再选一处语义去重。** 当前源码存在部分重复语义只是候选线索。若当前体积不值得优化就停止；若继续，保持工具名、参数、发现入口、权限、来源、版本与澄清要求，之后才做固定 off 条件的小配对，检查正确交付、误用/需要澄清、累计输入、请求数与分阶段等待。

固定源码定位：

| 仓库 | 固定 commit | 相对路径与行号 |
|---|---|---|
| broker | `7490cbebb6729f466dc6b99eef485e7892b2e7b2` | `packages/context-broker/src/pi-host-adapter.ts`，80–94 |
| broker | `7490cbebb6729f466dc6b99eef485e7892b2e7b2` | `packages/context-broker/src/host-skills.ts`，631–647 |
| broker | `7490cbebb6729f466dc6b99eef485e7892b2e7b2` | `packages/context-broker/src/index.ts`，852–870 |
| cli | `6727bea66a3aaea3368a5cc8f84fad83e67d21c1` | `packages/core/src/fixed-snapshot-files.ts`，100–168 |
| cli | `6727bea66a3aaea3368a5cc8f84fad83e67d21c1` | `packages/core/src/shared-fixed-acquisition.ts`，17–166 |
| cli | `6727bea66a3aaea3368a5cc8f84fad83e67d21c1` | `packages/core/src/resource-read.ts`，339–352 |

## 配对与公开证据

| case | Broker run 后缀 | native run 后缀 |
|---|---|---|
| scripts-assets-02-a-n16-r1 | 001 | 002 |
| references-01-a-n16-r1 | 004 | 003 |
| explicit-01-a-n16-r1 | 005 | 006 |
| complementary-01-a-n16-r1 | 013 | 014 |
| continuation-01-a-n16-r2 | 020 | 019 |
| implicit-01-a-n16-r1 | 024 | 023 |

共同 run 前缀为 `standing42-run-2-codemode-24-`。

- [完整派生数值与定位器](cost-diagnosis.json)：12 run 的分区、每请求 input、provider/tool 事件行号、SDK 子操作与公开 artifact 引用。
- [公开包 manifest](packages/codemode-24/public-manifest.json)：证据路径均相对 `packages/codemode-24`，使用公开 `raw/<sha256>` 路径与公开字节 SHA256。
- 已核验 105 个映射 artifact：12 episode、12 events、58 payload、23 SDK receipt。全部公开字节及长度与 manifest 文件清单一致；事件行号按一对一映射重新定位，时间分区和输入值重算一致。6 个源码文件均与所列固定 commit blob 哈希一致。

示例定位：

- standing42-run-2-codemode-24-001 首次 provider 区间：[run-001-events](packages/codemode-24/raw/0926d00b72f33299c97b222184a6f49966e959d5202d5568052910592d8efe99) 第 40–104 行，公开 SHA256 `0926d00b72f33299c97b222184a6f49966e959d5202d5568052910592d8efe99`。
- standing42-run-2-codemode-24-002 首次 provider 区间：[run-002-events](packages/codemode-24/raw/eb2a591cd292401240cb205e94a2cb3cd5c3eb1586cbb950a57b37e69d45e09d) 第 16–170 行，公开 SHA256 `eb2a591cd292401240cb205e94a2cb3cd5c3eb1586cbb950a57b37e69d45e09d`。

限制：每 case/条件仅一个保留 run，无方差或显著性结论；独立 episode 的目录初始化不代表日常热会话；没有组件级 token 或缓存费用信息；当前 SDK3 的实际载荷和收益仍待验证。公开包用于定位与这些派生数值的复核，不声称可重跑私有原始评分链。
