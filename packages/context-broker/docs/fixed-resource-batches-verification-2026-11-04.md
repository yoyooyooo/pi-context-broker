# SC07 固定资源批读：2026-11-04 验证记录

关联 [AH-617](https://linear.app/yoyooyooo/issue/AH-617)、[AH-626 / SC07](https://linear.app/yoyooyooo/issue/AH-626)、[AH-620 / SC03](https://linear.app/yoyooyooo/issue/AH-620)。接口语义见[固定资源批读合同](fixed-resource-batches.md)。

本切片已将独立 SDK、默认 bundled source、Pi 原生 `read(paths)`、资源投影与会话去重接通。最终独立安装包通过四条实际 Pi 受控路径；另有同一冻结任务的一次真实模型冷／暖跟进。SC07 的全部用户旅程、正式 SC21、跨机恢复和日用切换继续分别验收，AH-617 与 AH-626 保持 In Progress。

## 实现范围

CLI 新增独立的 `RESOURCE_READ_CONTRACT_VERSION = 1`、`readResources` 与纯 decoder。SDK/consume 仍为 v1，非空 `consume.requestedFiles` 仍未启用。一个资源批次只属于一个 owner 和固定 snapshot；主文、混 pin/owner、重复别名、坏 hash 和超预算均不能产生部分 ready。

固定 File ID 可以纠正过时 path hint。文本保留 BOM、CRLF、Unicode 和空文件；binary 的原字节由标准 base64 机器结果承载，Broker 负责本地物化。只有完整 snapshot JSON、但选中对象缺失时，先做同 pin retained admission，再仅恢复缺失的选中对象；坏 hash 不进入恢复分支。远端 locator 域、合法带冒号的 shared identity 编码同时补齐反例。

Pi 使用已有 `read`，`path` 与 `paths` 互斥。scalar 分支委托公开 native factory，保留图片、settings、offset/limit、进度和渲染行为；第三方 read 不被覆盖。Pi 一批最多 16 个文件，SDK 显式上限为 64；SDK 原字节预算与 Broker 的 1 MiB 序列化上下文预算分别执行，不截断。

资源证明绑定 toolCallId、scope/owner/pin/File、源 hash、实际 JSON span 和 rendered digest。资源保持 `loaded: false`，不冒充主文或启用工作流。provider 中已有的非空完整正文只出现一份，原始工具结果仍完整保存在 session；空正文和 binary 元数据保持原样，压缩后可从仍保留的完整结果恢复。

## 冻结产物

CLI 提交：[1f36c77](https://github.com/yoyooyooo/notion-skills-cli/commit/1f36c770be6d4b6dcb09049d30a0f066dda47031)。

| 产物 | SHA-256 |
| --- | --- |
| CLI candidate 02，`ntn-skills-0.1.0.tgz` | `d3971bee42c8cc627182a3dea3cdce57d215d3ddf40bcf81a7216b81b629ceee` |
| 独立 installed SDK，`dist/sdk.js` | `4516486e434f6f9fe8e12b2be7fc67fda9d3c5f1f14f311a85051a9a8afef781` |
| Broker candidate 03，`pi-context-broker-0.0.2.tgz` | `5e611734cf42e88169455a180fb3cf13aaf5cef6cdb3c43e9a97ca42ad1fa6c8` |
| Broker bundled SDK，`dist/ntn-skills-sdk.mjs` | `38251f5f08f42710366dce09fc79e2548defcbf9482e939bea93ed81c7cfe8a8` |

Broker 从独立安装的 CLI package 构建，不直接 import CLI checkout。Bun 重新 bundle/minify，因此 SDK 输入与 bundled 输出的 hash 分开记录。45 个 Broker `src` 文件与最终安装包逐文件一致；四个 Pi 场景确认 package inventory 前后不变。runtime manifest 明确记录 resource-read capability v1。本页是验收后补充的记录，产物身份以上表归档 hash 为准。

私有证据根：`/Users/yoyo/Library/Logs/ntn-skills/AH-617-20261104/resources-7ftsyg4q`。下面的证据名均相对此根；源正文、凭据及 signed URL 不进入本页。

## 定向与独立 SDK 验证

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| CLI 消费／快照／SDK 初轮定向回归 | 97 passed，551 assertions | `cli/tests-final.log` |
| 三类独立审阅问题修复后的 resource + SDK | 19 passed，139 assertions | `cli/fix-regression.log` |
| 最终独立安装 SDK | 16 passed | `cli-consumer-03/report.json`、`cli-installed-03.json` |
| Broker 消费链 | 123 passed，1,022 assertions | `broker/consumption-final-01.log` |
| 最后引用 schema 改动 | 4 passed，32 assertions | `broker/read-schema-final-01.log` |
| Pi driver 反例 | 21 passed | `verification/driver-tests-04.txt` |
| source observer / cost observer | 37 / 19 passed | `broker/source-observer-tests-01.log`、`broker/cost-observer-tests-01.log` |
| 两仓 TypeScript 与限定 diff 检查 | passed | CLI final/fix typecheck、`broker/typecheck-final-03.log` |

上述测试组有重叠，不相加成独立用例数。没有使用会改写 Tern 或永久删除共享 fixture 的宽泛 test/build 聚合器。

Core 受控冷 retained 测试记录实际 object ID 集合：只读选中对象、共享 chunk 去重、81 个 chunks 分为两次有界查询，未选主文和资源无正文获取。npm/Pi fixture 则明确为 warm source，不能用其零 HTTP 证明冷下载。

独立 SDK 的 headers/body 取消都使用合法 retained pin 和真实 localhost HTTP：各观察到一次请求，cancelled 后 response/scope 关闭，metrics 一次且 in-flight 为零。早期错误 fixture 在进入 HTTP 前即 SNAPSHOT_MISSING 的失败报告保留，修复后另建目录运行，未覆盖旧样本。

## 最终 installed Pi

四个场景均使用真实 Pi 1.4.0、Node 24.20.0、独立安装 Broker03、默认 bundled SDK；provider 和 source 数据由受控 fixture 提供。

| 场景 | Provider 请求 | SDK consume | SDK read-resources | SDK 单文件 read | 源 HTTP | 清理后复核 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `resource-batch` | 5 | 0 | 2 | 0 | 0 | passed |
| `resource-batch-short-refs` | 6 | 1 | 2 | 0 | 0 | passed |
| `native` | 4 | 1 | 0 | 1 | 0 | passed |
| `prepare` | 5 | 2 | 0 | 0 | 0 | passed |

资源的两次操作是初读与同会话 repeat，每批严格一次 `read-resources`。canonical 场景不投递主文；短引用场景先明确 inspect，再从实际目录提取四个签发的 `sr:R`，主文仅来自这次 inspect。两类场景不能互相替代。

四个资源合计 101 B：UTF-8 45 B、BOM/CRLF 49 B、empty 0 B、binary 7 B。原始文本字节与 hash、零长 span、实际二进制文件均重新核对。repeat 仅把两个非空文本在 provider 中替换为 `Already available.`，原始 session 不被改写，未选资源不进入 Broker 物化树。

实际 read schema 确认互斥分支、16 文件上限以及完整引用 pattern。首次与 repeat 工具结果分别为 canonical 1,452/1,389 B，短引用 903/840 B。这是工具内容字节，不能冒充整个任务 token 或成本改善。

同一 installed pi-ai serializer 经 localhost HTTP replay 核对公开 onPayload 与实际请求字节：canonical 16,268 B、短引用 14,632 B、prepare 14,975 B；机器 details/proof 不进入 API message 字段。该 replay 没有调用生产模型。

每条路径都完成 Doctor → Drive → Evidence → Cleanup → Evidence，先封存原始 session、provider capture、observer ledger、binary，再回收 owned scratch。初始 CACHE_MISSING 发现诊断保留，Default View/menu 未由本路径证明。汇总：`verification/broker03-verification-summary.json`。

## 验证规程的新会话实驱

独立的新会话读取两个仓库的现有验证入口，使用最终包与 warm fixture 另外执行一次短引用路径，完成 Doctor → Drive → Evidence → Cleanup → Evidence。它复核实际四个 sr:R、1 次 consume + 2 次 read-resources、正文/binary hash、provider 去重、主文来源、无新增资源 graph 绑定与进程终局。清理前 26 个文件的 hash 在清理后全部保持，owned scratch 已不存在。

运行不需要 root 提供技术提示、命令修补或替换场景；root 提供运行路径，并在过度阅读时提醒进度。该次评价发现一个非阻断歧义：evidence 命令的 `cleanup: false` 表示本次调用没有请求 cleanup，不代表上次清理回退。应查 `cleanup.json.status = trashed` 和 owned scratch 不存在；验证地图已补充此解释。

证据：`fresh-skill-resource-01/fresh-session-review.json`，SHA-256 `3625a17efada6ec339a01cf1f1034fc56f6b3dc2dcdae1caac43160662753210`。这条新会话实驱仍属于受控 provider，不能并入真实模型样本。

## 真实模型：首轮失败与最终候选跟进

这是显式要求 inspect 并一次读取两个指定资源的补充任务，不是正式 SC21 A/B/C/D。固定 selector 为 `magpie/group/flash-free`；最终样本实际 responseModel 为 `upstage/solar-mini4`。oracle 在独立 state 中只读取得，24 次源请求单列，没有预暖 consumer。

首轮 Broker02 的模型把类别前缀当成完整资源引用，又复制错候选引用，随后绕到本地只读文件。SDK 没有进入；最终文本流仍在输出时被 120 秒总时限截断。结果保持 cold failed、warm not_run、sourceComplete false。两个未知子进程使现有 helper 拒绝 cleanup：原始会话已归档，owned scratch 保留，`model-resource-01/cleanup-blocked.json` 记载实际拒绝，不绕过守卫。

据此修正 read.paths 的入口描述，要求从所选快照目录原样复制完整引用，schema 拒绝裸前缀。最终 Broker03 仅运行一次冻结跟进；配置只改变 extension/packagePath，prompt、selector、profile、counts、120 秒时限和 observer 不变。这不构成引用可靠性改善的统计证明。

| 指标 | 冷轮 | 同进程暖轮 |
| --- | ---: | ---: |
| 正常最终 stop / agent_end | 有 | 有 |
| Provider 请求 | 4 | 4 |
| 工具调用 / 工具轮次 | 4 / 3 | 4 / 3 |
| inspect / 单批 read(paths) | 1 / 1 | 1 / 1 |
| 选中源字节 | 7,397 B | 7,397 B |
| 任务耗时 | 55.184 s | 25.493 s |
| 累计 provider JSON bytes | 231,861 | 435,640 |
| SDK consume HTTP | 16 | 1 |
| SDK read-resources HTTP | 0 | 0 |

每轮实际轨迹为 search 与 graph 描述请求、inspect、单次双资源 read、最终回答。graph 描述没有被执行；没有 bash、write/edit 或工作流执行。两份回答均对照所选原件介绍前置、操作、证据和清理。每类只有一个样本，不给 p95 或性能改善结论；暖轮保留历史，累计 provider bytes 反而更大。

两个资源的原字节为 3,374 B 与 4,023 B，机器 hash、模型文本和 JSON span 均匹配冻结原件。暖轮所有已观察 payload 中主文及两资源各一份。批读模型文本只有 status/files 和 kind/ref/path/content，完整机器结果留在 details；真实运行没有封存 raw provider payload，任意非文本字段的完整扫描仍为 unknown。受控 serializer replay 的证明范围单列在上一节。

全程源请求 36 次：31 metadata、5 body、0 write；4 个 CLI 与 4 个 SDK 操作均有终局，host code 0，无 unmatched children。模型 HTTP 的八个 terminal 仍记为 `failure / errorCode 20`，安全账本不能确定原因；完整 assistant、最终 stop、agent_end 与传输成功分类分别报告，没有把这八条改成 successful。wire bytes、模型内部重试/队列归因未知。

最终样本的 13 个归属明确原始文件先归档并核对 hash，再由原 helper 完成清理；清理后 retained/report 和归档 hash 均保持。证据：`model-resource-02/model-followup-review.json`、`model-resource-02/cleanup-receipt.json`。前者 SHA-256：`306c331d12d9d5732d5d951d1a97a5c4e30e54845229897bc8ab27e6aaea423a`。

## 尚需推进：current inspect 的源成本

这次 live 冷 inspect 的五个 body 请求属于既有 consume：一次 retained source 请求、四次 current file GET。未选 README 也已下载并写入 SDK objects cache，原件 2,761 B；它没有进入 Broker 资源物化树，也没有在保留会话中投递完整正文。因此只证明本次批读本身按选择返回、没有追加 HTTP，不能宣称端到端未选资源零下载。

只读定位到 `graph-prepare → targetSnapshot(..., "entrypoint")`：固定 pin 分支使用 entrypoint 需求，未固定 current 分支仍进入完整 snapshot 观察。全冷的各 File 没有 observation，均走 `body_read / unobserved`。后续完整版本又包含全部 file hashes、bindings、native references、relations 与 source/ownership 状态，不能简单过滤成 main 却继续声称完整 current 版本。

[AH-630 / SC13](https://linear.app/yoyooyooo/issue/AH-630) 下一步应区分已有可信完整 pin 与未固定 current：前者可复用 metadata-only manifest 和 selected-file materializer，仅物化主文；后者只有证明 current 状态对应那个完整 manifest 后才进入 entry-only。首次未固定原生修改需要完整观察时据实计费，不给旧 pin 新 freshness，不延后 full-body deadline，也不绕过 pending/unknown/native-reference 检查。

后续反例要记录实际请求对象集合：四文件只选两资源、只有 main 缓存、只有历史 manifest 而无 current observation、未选文件的正文/Path/File ID 变化、相同 mtime 跨 full-body deadline、Required/native-reference 与 pending 状态变化。实际主文与完整 manifest/version 等价后，再复跑相同真实任务验证资源直到 batch 才取得。

