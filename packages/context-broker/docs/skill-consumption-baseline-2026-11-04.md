# AH-617 / SC02 消费成本基线（2026-11-04）

本报告对应 [AH-619](https://linear.app/yoyooyooo/issue/AH-619)，可复跑入口见 [成本规程](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/features/skill-consumption-cost.md)。结论是测量工具与旧路径基线已经建立；表中的失败仍为失败，后续重构、全矩阵、双机和日用安装不由本报告推断。

## 固定条件与原件

实际 Node 24.20.0、Pi 1.4.0、Bun 1.4.3。Pi 实际解析到 `/Users/yoyo/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`。真实模型批次固定为 `magpie/group/flash-free`，prefetch false。真实服务批次在同一机器顺序运行；网络未控制，所有真实重试、慢样本及未知值保留。

日用扩展在 `~/.local/share/context-broker/installed/ah503-302159449a60/node_modules/pi-context-broker/`。其目录名称不作为版本证据。

| Artifact | SHA-256 |
| --- | --- |
| 实际日用 embedded CLI，2,254,960 bytes | `47c42b15b0364c05877eb5ad5c68bf6ff765b5688c057420ed1ea4578c19bac5` |
| AH-561 b10 历史 archive | `41150cbaf9b05b1ad4e3223b511833ea96e8be3dd4c309918320ac4aabfb1e50` |
| 历史 archive 内 CLI | `86beaec4c379c299517b451388d28ef09e014b0b4fc5c45db804d09450683c18` |

实际 CLI 与 archive 内 CLI 不同。实际扩展文件树与 CLI 分开冻结，不能声称整个日用安装等同于该 archive。所有费用数字使用真实文件的身份。没有更改日用安装。

下文 `ROOT` 为：

```text
/Users/yoyo/Library/Logs/ntn-skills/AH-617-20261104/implementation-i228260z
```

| 批次 | 原件目录 / plan hash |
| --- | --- |
| 真实普通模型，5 cold +20 warm | `ROOT/sc02-model/skill-model-cost-6O32Wi`；`49e23ac882c4335b0783ed6a16b226d9d48587940618a418899f80e1ed4c6f23` |
| Source 四初态，50 例 | `ROOT/sc02-source/source-20261104T070640475Z-d3c1ede1`；`cfcd142c12241c5809371be12f1890805f1c6c95d69a5e72ff39e965af2e18a9` |
| 独立单资源，5 cold | `ROOT/sc02-source/source-20261104T072837094Z-e5c7ceb7`；`2841eea2a8c7caedc73ea02c068a9921ec43c5befe8aea271d1f2dbfc7ce5f4e` |
| 资源 planning / 独立 oracle | `ROOT/sc02-source/resource-planning-20261104T072157720Z` |
| 历史 Gate B 分解 | `ROOT/sc02-historical-gate-b.json` |

每批原始 plan、executed driver 字节、逐事件账本、原始值、hash 与 cleanup 回执均保留在对应目录。实现最后的空账本初始化、答案反例、transport reader 链校验和后台账本 reconciliation 等修正不回写既有 plan，也不声称旧 run 已执行这些新增行。旧模型 plan 未包含后来新增的 driverSha256/answerPredicate，原 report 未包含 sourceComplete；执行字节与独立复核作为追加证据保留。

## 真实普通模型任务

任务原文是“请用一句话回答：12 加 7 等于多少？”。25/25 得到正确答案，0 tool round；全部 5 个 Pi 进程通过 EOF 正常关闭。Cold 是独立空 CLI/Broker 缓存的新进程，warm 是最后一个进程内保留历史的 existing session。

| 指标 | Cold n=5 median | Warm n=20 median | Warm p95 |
| --- | ---: | ---: | ---: |
| 提交→首个 provider hook | 11,318.941 ms | 26.459 ms | 37.802 ms |
| 提交→首个模型 HTTP | 11,324.330 ms | 28.118 ms | 39.788 ms |
| 提交→首个有效文本 | 15,276.354 ms | 2,529.584 ms | 3,321.604 ms |
| 提交→任务完成 | 15,284.614 ms | 2,776.470 ms | 4,702.342 ms |
| provider JSON bytes | 93,409 B | 95,057.5 B | 原始分布见 report |
| 工具轮次 | 0 | 0 | 0 |

Cold 只有 5 例，p95 为 null。Warm payload 从 93,566 B 增至 96,549 B，包含保留的历史，不能解释为相同长度的新会话请求。

Cold 模型报告 input 分别为 31,935、32,077、32,373、32,017、31,698，cacheRead 均为 0。Warm 的 input 与 cacheRead 分开报告；不能把单独的 input 当作总上下文 token。25 次 hook payload hash 全部与 Undici 实际发送 body 对齐。

每个 cold 进程有 5 次 source CLI；合计 96 次 Notion HTTP，全部为 metadata，正文/写入/附件 provider 为 0。四例 source decoded response 为 1,473,593 B；另一例有未知响应字节的 attempt，所以总字节为 null。该例真实发生 1,118.826 ms retry wait，已计入 20 次 attempts；其余各 19 次。后台 source 成本与模型完成时间分开。

25 个模型请求都收到 HTTP 200，其中 23 个 SSE 的 Undici 终局为 code 20 的取消/error，2 个为 completed。任务答案已成功，但 transport 原始 outcome 仍保留 failure；不能把这些 HTTP 终局改写为 completed，也不能由它们推断模型任务失败。失败流的 entity bytes 仅代表已观察到的 chunks，不证明完整响应体。模型 SDK retry/queue wait、TCP/TLS wire bytes 均未知；response entity 与 decoded bytes 按 content-encoding 区分。

## Source 四初态：prepare 后逐节点固定 read

目标为 Pstack Router；本次返回 1 个 prepared node、1 个 effective 文件，主文 20,872 B。每个正常测量路径实际执行 `prepare --purpose use`，再为每个 prepared node 启动固定 pin 的主文 read，因此本目标每例 2 个 CLI 进程。它证明当前重复进程路径，不声称已测出多 Requires 节点的扩展曲线。

| 初态 | n | passed / failed / not_run | median | p95 | HTTP median | decoded response median |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| Cold | 5 | 5 / 0 / 0 | 7,429.406 ms | null | 13 | 1,543,772 B |
| Warm | 20 | 20 / 0 / 0 | 1,296.949 ms | 1,719.726 ms | 1 | 364 B |
| Expired unchanged | 20 | 20 / 0 / 0 | 6,722.999 ms | 15,846.292 ms | 11 | 1,628,669 B |
| Partial | 5 | 0 / 5 / 0 | 970.416 ms | null | 1 | 364 B |

Warm 的 5m 策略和 expired 的 1s 策略在执行前冻结。每个 expired 样本有实测至少 1001ms 的等待，并检查返回的 source/freshness；没有用 refresh/0 冒充自然 TTL 过期，也没有修改机器时钟。等待本身作为初态建立记录，不混入表中 prepare→fixed-read 的时长。

5 个 partial 都是 `SNAPSHOT_MISSING`：仅将已验证的自有主文对象移入 Trash，manifest 保持不变，随后固定 pin 路径失败，没有 current fallback。表中 970ms 是失败结束的时间，不是恢复成功延迟。

包括 setup 在内，107 次 CLI、5 次初态 Trash 共 112 个 child 全部记录 spawn/close；总计 389 次 source HTTP，Notion write 0。6 份 setup 成本独立保留。本批有 11 次 retained_body chunk 读取，provider=0 不能解释为“没有 ZIP”。

## 单资源触发整包物化

独立目标为 `ntn-skills-maintain` 的 `references/operations.md`。5 个正式 cold 样本各只有一次当前资源 read；此前没有 prepare、files 或 main read，也没有使用 planning/oracle 的状态。

- 请求 k=1 个资源，effective manifest N=2 个文件。
- 每例 1 个 CLI、13 次 HTTP；5/5 passed，0 failed，0 not_run。
- median 6,898.467 ms，p95 null。原始值为 23,834.496、6,469.023、6,898.467、6,806.397、7,517.428 ms；最慢首例未替换。
- 每例 returned effective resource 为 16,021 B；immutable retained ZIP 中该资源为 15,914 B，二者不同。
- 对应 ZIP 为 12,760 B，实际 trace 命中其 bundle/chunk；retained Records response decoded JSON 为 38,852 B。base64 编码载荷字节数未知。
- 唯一资源 child 结束后、任何后续 CLI 之前，自有缓存中的 2 个 retained source 对象和 2 个 effective 对象均完成 hash/bytes 校验。只有所请求资源进入 CLI stdout；没有模型投递或激活结论。

Source response decoded bytes 的 median 为 814,959 B，它既不是 ZIP 大小也不是模型 payload。Provider 下载 HTTP=0，因为 ZIP 走 inline Records。单资源仍物化 N=2 的证据已成立。

规划与 oracle 分开计量：3 个 child、16 次 HTTP、824,438 response B、12,346.496 ms；其中独立 metadata oracle 为 3 次 HTTP。没有把规划费用藏入或排除出正式样本的原始账本。

## 普通消息的旧启动等待

旧安装基线目录：

```text
/Users/yoyo/Library/Logs/ntn-skills/AH-617-20261104/startup-baseline/skill-startup-N6Riym
```

实际 Pi +受控 source/provider，list 每次延迟 2000ms；原生 RPC 在目录准备前提交。31/31 观察完整：5 cold-delay、5 cold-failure、1 primer、20 warm。此处 warm 为暖 Broker catalog、新 Pi 进程。

| 组 | n | 提交→provider median | p95 | 每例 source list |
| --- | ---: | ---: | ---: | --- |
| Cold delay | 5 | 6,948.52 ms | null | 3 |
| Cold failure | 5 | 6,801.32 ms | null | 4 次失败；第 4 次发生于 provider 之后 |
| Warm / new process | 20 | 4,664.27 ms | 4,880.29 ms | 2 |

各例正文 prepare/read/export 均为 0，所有宿主和 source 均记录终局。受控 provider 不触发真实 onPayload，HTTP/token 为 null，不能把 stream 的 context JSON 当模型 payload。

较早的 `skill-startup-eI3GaP` 已包含一部分 SC09 源码，保留为不适合作旧包基线的历史记录。最终候选 `skill-startup-eSQbSH` 的 31 计划也全部保留，但出现 warm timeout、观察器晚启动以及 source 在 Pi close 后才记录 start 的缺口，整体为 baseline-incomplete。独立 raw 复核有 87 source starts、85 closes，缺失的 2 个终局不补造。不能用其冷组通过或部分较快 warm 样本宣布完整性能改善。

候选分组的描述统计如下，均为受控 provider、checkout source tree，不是新安装包的真实模型加速验收：

| 组 | 计划 / 任务完成 | 提交→provider median | p95 | 完整后台观察 |
| --- | --- | ---: | ---: | --- |
| Cold delay | 5 / 5 | 381.967 ms | null | 5 |
| Cold failure | 5 / 5 | 479.582 ms | null | 5 |
| Primer | 1 / 1 | 4,974.771 ms | null | 1 |
| Warm / new process | 20 / 19 | 386.795 ms（19 个已观察值） | null | 18 |

Warm-4 在 30s deadline 内没有 provider，之后留下 SIGKILL 终局；warm-6 任务完成但未完整观察后台 source。29 例观察完整，2 例不完整。部分长延迟发生在 observer 扩展开始之前；没有归因给 metadata，也没有删掉这些慢值。原 observer/driver 五文件已按 plan 封存，修正后的 reconciliation 只新增独立回执，不覆盖原 report/result。

同级 `startup-final-reconciliation-eSQbSH.json` SHA 为 `a4bc641ec477868922e1db23cee63e82a736a315f74221504c98b83cf538728d`；完整原值和比较条件在 `startup-final-comparison-eSQbSH.json`。记录到的 205 个 PID 检查时均已消失，这不能补成两个缺失的 source close。

比较报告附加 validation 曾把 message_end 当作首文本，产生假 `derived-time-mismatch:submitToFirstEffectiveTextMs`；统计表仍使用原 report 的正确数值。追加 `startup-final-first-text-erratum-eSQbSH.json` 用实际 `message_update.firstEffectiveText` 重新计算，旧包 31/31、候选 30/30 已知值完全匹配，另一个候选原值仍为 null。没有改写原件；真实不完整项保持不变。

## 历史 Gate B 的 20,087 B 与 53,538 B

来源为 AH-561 的 `worker-B10-H12-600s-E0yytF/runs/graph-model-B-wp97sw`；模型 `magpie/group/worker`，任务是 poteto-mode + Requires unslop，与本次普通 flash-free 算术任务不同。

- 完整 root snapshot entry 为 41,537 B，其中从 byte offset 21,450 开始的 `\n## Members\n` 后缀为 20,087 B，包含前导换行。20,087 B 不是整个正文。
- Required unslop 为 5,938 B；prepared instructions 共 47,475 B。
- 一个组合 context-broker custom message 为 53,538 B，hash 为 `0157b195d8d75c225af9fdb8f9de01052245f4e9a0887834438176744fffe4fb`，在 3 次 provider 请求中出现。
- 53,538 B 不是整个 provider payload。与 prepared instructions 的差值 6,063 B 含 XML escaping、envelope 和 metadata，不能全部叫作可删除证明。
- 不从这些字节推出 token，不把历史 Gate 作为新包/新任务通过或加速证据。

trace、observer、result 与 source-response 的完整 hash，以及 source span 的独立 hash 均在 `sc02-historical-gate-b.json`。

## 反例、清理与完成边界

离线反例覆盖缺失/截断观察、漏计附件和 retry/queue、空 final/许可提示伪成功、换模型/任务/TTL、只缩首轮却增加工具轮次、source drift、真实 child spawn failure/timeout 和失败 stdout。原始结果与归因分开；失败不可由 cleanup 或统计器提升为 passed。

Source 50 的 112 份 raw stdout、资源 planning 的 18 份 JSON、资源 5 的 30 份 JSON 已审计，无凭据或签名 URL，raw hashes 不变。两个正式 source working 根及规划的自有可变根已移入 Trash，所有原始证据、manifest 和 partial 备份复核不变。真实模型 scratch 也已回收，88 份既有证据逐份保持原字节。

Startup 按清单将 29 个已证明拥有的外部目录移入 Trash，三个 run 的证据树逐文件 hash 前后不变；cleanup 回执 SHA 为 `756603aac5318490902c4d6223463d55a1cd5a2f42bc4db67a5abd3fa0247672`。未捕获引用的 candidate aliases 和一处早期未记录路径的 Doctor probe 保持 blocked，未猜测其路径或回收，不能声称所有临时目录已清空。失败终局和不完整观察继续保留。

本票不关闭 AH-500 的完整 N/k 范围，也不把整个 1,120 组合矩阵、A/B/C/D 真模型、独立安装、pro/mini 或正常日用验证标 passed。SC09 的功能进展与尚未通过的 RPC input-abort 继续记录在 [AH-624](https://linear.app/yoyooyooo/issue/AH-624)。

