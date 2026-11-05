# SC13 按需快照消费：2026-11-05 验证记录

关联 [AH-617](https://linear.app/yoyooyooo/issue/AH-617)、[AH-630 / SC13](https://linear.app/yoyooyooo/issue/AH-630)。本切片完成固定快照与有效 current 缓存的按需对象验证，并贯通独立 SDK、bundled SDK 和真实 Pi。源归属规划、冷 current 首次完整观察、旧 ZIP 路径及全部 SC13 场景仍未完成，两张票保持 In Progress。

## 实现与边界

CLI 复用一个固定快照选择器处理 manifest、entrypoint、target 和 all。先验证完整不可变清单与目标身份，再校验本次选择的对象。完整目录始终保留；未选对象缺失或损坏不阻断主文或其他资源，选中该对象时仍须明确失败或按原规则恢复。只有缺失对象可以从相同 scope、owner、pin 和完整 frozen tree 的 retained 记录恢复；坏 hash 不被静默覆盖，不转向当前版本。完整 export 仍逐文件校验。

current 缓存先判断原有 TTL、正文期限、pending、失效和数据库范围，再复用经过真实完整字节/hash 与共享引用检查的本地 receipt。receipt 绑定完整规范 SnapshotSchema，包括 File 绑定与关系元数据；使用固定 stored snapshot，不把动态 default_context 写入证明。旧或失配 receipt 回到完整验证。SQLite 仅为这一类可重建证明允许更新 payload/retired 状态，其他 cache/dispatch 仍保持原冻结规则。receipt 不更新观察时间、期限、generation 或 clear fence。

materialized_paths 表示本次实际验证的选择。只有选择覆盖整个清单时才报告所有文件 ready。SDK/consumer 版本仍为 1，resource-read 仍为独立 v1。合法带冒号的 shared identity 和稳定 File ID 的旧 path hint 同时按已有身份合同修正。CLI 包补入资源合同和按需快照合同。

合同见相邻 CLI 仓库的 docs/selected-snapshot-consumption.md；可复跑入口仍是现有两仓验证 Skill 与本仓[消费地图](../../../.agents/skills/verify-notion-skills-integration/features/skill-consumption.md)。没有第三套总入口。

## 冻结产物

| 产物 | SHA-256 |
| --- | --- |
| CLI candidate 02，ntn-skills-0.1.0.tgz | `6cba3fcbc4eac28830248fe7863daa1292fd59f90823d5bd125c954d7dbd31c9` |
| 独立 installed CLI，dist/ntn-skills.js | `4f5f74275b8c9b3ef58da532a0df5281e2dae2ef36ddb32a2a6b99f787d5ae0d` |
| 独立 installed SDK，dist/sdk.js | `01f4602f4eaa1ffbe7e97daf793f0d077be0279b978e824eff55a762ef0ee6fa` |
| Broker candidate 01，pi-context-broker-0.0.2.tgz | `7be0c44c5e6be919daf3c2abb2f1058d5ce199776f6c868ddfc3715fc17cb269` |
| Broker bundled CLI，dist/ntn-skills.mjs | `f89579b3e4ceb0ee2cc24fb7b2df4c24f13f6da36e23650fc78ae960cae35004` |
| Broker bundled SDK，dist/ntn-skills-sdk.mjs | `e550536edae6782b04b05f10e97dc90160d5768c6584bf1dc307d02f4b9d618b` |

Broker 只从独立安装 CLI 构建；Bun rebundle/minify 后的输出与输入 hash 分开记录。45 个产品源码文件与安装包逐一一致，79 个已归档包文件在 Pi 回归前后保持不变。runtime manifest 保留 sdk/consumer/resource-read v1。

CLI 的 354 项构建输入冻结在 cli-input-freeze-02.json，SHA `b4e32dfacc04604d190f1a7e23453e0b5ad64097c53c318c50150daa321fc546`。Broker 的最终验证输入冻结在 broker-input-freeze-03.json，SHA `e9fe50c9d6bde27e5dbc0ed3db74c1de71722bda57e550e49cfbb4027b5e9b0b`；driver SHA `cbcb2341437ed175687983ea98a9a034a580d3f61d97146485eff5e0a332f23e`。后两次冻结只修验证脚本，产品包没有重建。本页及地图结果链接在验收后补充。提交前还移除了 CLI 按需快照合同末尾的一个空行；该文档正文与归档包一致，产品源码、bundle 与验证输入原件不变。上述收尾不计入已冻结运行输入，归档包身份仍以上表 hash 为准。

以下证据路径相对私有根目录：

`/Users/yoyo/Library/Logs/ntn-skills/AH-617-20261105/entrypoint-e7kmxr3z`

源正文、完整 session 和原始请求证据留在此目录，不进入 Git。

## 定向验证与独立 SDK

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 核心选择与消费定向组 | 81 passed，547 assertions | cli/fixed-selected-final-integration-02.log |
| 缓存及引用证明相关组 | 72 passed，491 assertions | cli/sc13-current-proof-final-2.log |
| 真实 Node SQLite 持久化、修复与 clear fence | 6 passed，8 skipped（未选中） | cli/sc13-current-receipt-sqlite-related.log |
| 独立安装 SDK smoke | 17 passed | cli-consumer-02/report.json、cli-smoke-02.json |
| Pi driver 单位验证 | 23 passed | broker-harness-unit-2.log 及 verification 下两次修正回执 |
| 两仓 typecheck、限定格式/diff、合同 self-test/map | passed | cli、broker 下相应 final/typecheck/contract 日志 |

这些组有重叠，不相加成独立用例总数。fixture03 使用实际 Node 24.20.0，经真实 SQLite Store 发布；Bun fixture 的早期失败单独保留。没有运行会删除共享 fixture 或改写 Tern 的聚合测试/构建。

SDK fixture 的主文为 42 B、小资源为 53 B，两个未选大对象各为 2,097,152 B。partial clone 先经公开 current consume 真正完成整树验证，再移出一个大对象并损坏另一个。实际 Node 对象读取账本如下，字节是各次 API 返回值之和，不是物理磁盘 I/O：

| 步骤 | 不同对象数 | 完成读取次数 | 返回字节 |
| --- | ---: | ---: | ---: |
| 初次完整 current 验证 | 4 | 6 | 4,194,483 B |
| 固定 consume | 1 | 2 | 84 B |
| 有效 current consume | 1 | 2 | 84 B |
| 固定 read | 1 | 2 | 84 B |
| 小资源 batch | 1 | 1 | 53 B |

三次主文步骤均未读取小资源或两个大对象。目录仍完整包含四项。缺失大对象被选中返回 SNAPSHOT_MISSING，损坏对象被选中返回 STATE_CORRUPT；partial export 失败且没有成功输出。完整 clone 的两次 export 各交付四文件，共 4,194,399 B，逐文件 bytes/hash 匹配。CLI files 子进程返回四项目录，但该子进程对象 I/O 未被观察，不声称它零读取。

独立审阅对三个实际 SQLite 数据库做只读比较：对应 observation 整行及 payload 相同，validated_at 为 1793840607638、started_at 为 1793840607619、正文期限为 1793840907619，generation 为 1、invalidated 为 false；fence 为 generation 1 / retired_through 0。receipt 的原始、retired、修复后 payload 相同，retired 从 1 经公开 SDK 完整检查恢复为 0。审阅前后 DB/WAL hash 不变。这证明保留终态一致，不冒充逐事务时间线。

审阅原件：verification/sdk-evidence-review-01.json，SHA `2f7ebf505c3b0049682f8ce2512d7fa268b4cefe5d9d164efdca7e5770fa2e2e`。核心最终 diff 的独立只读审阅未发现错 pin/owner、腐损静默恢复、TTL/fence 绕过或 partial 误报 all-ready 的阻断问题。

## 实际 installed Pi 与新会话

使用真实 Pi 1.4.0、Node 24.20.0、独立安装 Broker01、默认 bundled SDK、受控 provider 和离线 source fixture。四个场景全部通过：

| 场景 | Provider captures | SDK 调用 | 本地 serializer HTTP |
| --- | ---: | --- | --- |
| partial-entrypoint | 5 | consume ×2，read ×1 | 不适用 |
| resource-batch | 5 | read-resources ×2 | 1 次，16,616 B |
| native | 4 | consume ×1，read ×1 | 不适用 |
| prepare | 5 | consume ×2 | 1 次，15,323 B |

合计四个实际 session、19 次 provider capture、9 次 SDK 调用；源 HTTP 为 0，正文 prepare/read/export CLI 为 0，8 个 catalog CLI 子进程全部关闭。observer 完整、trace 未丢失、host close 有直接证据，package_unchanged 与 evidence_stable 均为 true。serializer HTTP 是本机受控 replay，不是生产模型请求。

partial-entrypoint 实际执行 search → 固定 native 主文 → current inspect → 小资源。主文完成四次 42 B 读取，小资源完成两次 53 B 读取，共 274 B；两个大对象读取为零，缺失/损坏状态未被修复。主文与所选资源绑定同一 owner/scope/pin/version，最终 provider 中各恰好一份完整内容。显式 inspect 的完整 source 投影保持原样，较早的 native 主文副本被替换，其完整固定目录仍保留。原始 RPC/session 三份工具结果均未改写。

汇总：verification/pi-installed-verification-summary-01.json，SHA `71b6c2b1ee4700fcee778fadcb83be88473299205877cf274d1effd7d9849f40`。四个成功场景的 98 份原件在 Evidence → Cleanup → Evidence 后 hash 全部不变，owned scratch 已 Trash。

另一个独立新会话仅依照真实 Skill、地图、安装包和 fixture 路径，实际完成相同五步流程，五条命令均 exit 0，partial-entrypoint passed。它独立审阅 session/provider/object/source 原件，27 项核对全部通过；28 份原始 evidence 与 17 份清理前 audit 文件 hash 不变，产品、driver、Skill、地图及 fixture 在该次执行前后不变，scratch 已 Trash。

证据在 verification/fresh-skill-01 和 verification/fresh-skill-01-audit，重点包括 review-before-cleanup.json、inputs-before.json 和 retention-after.json。该次 provider 的主文份数依次为 [0,0,1,1,1]，小资源份数为 [0,0,0,0,1]。默认 View 子进程的 CACHE_MISSING 仍保留，其退出码 1 没有被纳入通过范围，默认 View/menu 仍未验证。warm current 使用 offline 策略且 stale=true；本次不证明在线 TTL 新鲜度。TTL/pending/fence 由独立 Core/SQLite 反例验证。新会话实驱证明规程可执行，不等于真实模型、默认菜单或冷源验收。

## 最终 CLI 的真实 Notion 冷读取

既有 source-baseline helper 使用最终独立 installed CLI，从空的自有 state 只执行一次 current 资源 read；没有 prepare/files 预暖，也没有模型调用。配置与 sample order 先冻结。独立 oracle 使用另一份隔离 state，其 19 次来源请求另记。

| 指标 | 单次 cold-001 |
| --- | ---: |
| CLI 操作 / 启动 | 1 / 1 |
| 返回所选资源 | 3,374 B |
| 完整 source HTTP | 19，全部成功 |
| metadata / body / write / provider | 14 / 5 / 0 / 0 |
| 请求 / 响应字节 | 1,767 B / 1,531,994 B |
| CLI 耗时 | 10,483.808458 ms |
| 请求队列等待 / 重试等待 | 51.059416 ms / 0 ms |
| 有效清单文件 / 实际缓存对象 | 4 / 9 |

所选输出原始字节/hash、完整四项清单、snapshot 和 scope 均与独立 oracle 匹配；CLI 只返回所选资源。与此同时，四项有效文件都已在本地，另外还有来源对象：冷的未固定 current 仍进行完整观察，不能将此样本描述成仅下载 3,374 B。记录的是可观察响应实体字节，不是 wire bytes；ZIP 具体格式没有独立证明，不从 provider HTTP=0 推断不存在 whole-archive 成本。每组仅一个样本，不给 p95、性能改善比或模型投递结论。

审阅：verification/live-source-01/live-source-review.json，SHA `aeace1cf6408f366ecefba63fa1ae382adca63d94474c20490e58b2c17db7a53`。完整运行目录为其下 source-20261105T021707456Z-c0c2fadf。15 份原始证据在清理后 hash 不变，owned working 已 Trash。

## 真实模型：失败保持失败

沿用已冻结任务，selector 固定为 magpie/group/flash-free；一次 cold 和计划中的一次 warm，120 秒截止，没有换 prompt、fallback 或重跑。Doctor 通过，运行实际 exit 1。首轮模型 HTTP 持续约 101.982 秒，103.640 秒才提交 search；111.943 秒提交 read 与 inspect，两个 SDK consume 随后启动并在 120.002 秒截止时取消。read 使用 search 实际返回的完整 sr:C 引用，引用匹配，不是裸前缀。

| 项目 | 状态 |
| --- | --- |
| 四次 CLI 目录命令 | passed，exit 0 |
| cold 任务、成功非空 final | failed，final 为 0 |
| 两个 SDK consume | cancelled，未获得 ready |
| warm 与资源 batch | not_run |
| 所选完整正文进入 provider | unknown，未证明 |
| 全程完整来源成本 | unknown/null |
| 原件、会话与冻结输入归档 | passed |
| owned scratch 清理 | blocked |

已观察到 29 次来源 metadata 请求（27 success、2 cancelled），观察到 body/write/provider 请求为 0；一个未归属 CLI child 虽已正常关闭，其 descendants transport 未被观察，不能把 29 称为完整总量。两个模型 HTTP 都有 200 headers，但 terminal 都为 failure/errorCode 20，不能记为成功。host 的另外 10 次 source HTTP 与 SDK 账重叠，不重复累加。

此次窗口大部分消耗在首轮模型响应；证据不足以把超时归因于 SC13 产品，也不能将其记为模型验收通过。原始 session 只归档自有的一份，不复制 auth/config；12 份原件 hash、三条 ledger 哈希链、8 项冻结输入均通过复核。

审阅：verification/model-01/model-review.json，SHA `520b6f57a0270af504f5c565701284be05d1d3005eb23bbeacc3ae0e25d2296d`。source.unmatchedChildren 为 1，不满足已有 cleanup gate，因此未调用 cleanup，保留 /private/tmp/skill-model-cost-scratch-OXVM38。

## 保留的失败与下一步范围

CLI candidate01、Bun fixture01、SQLite 路由缺失的 fixture02、receipt 冻结 payload 的失败日志均保留。candidate02/fixture03 修正了实际 Node 持久化路径后重新构建、安装和验证，没有覆盖旧样本。

Pi partial01 在启动宿主前因原始 SDK metrics 未经过现有 safeRequestMetrics 规范化而失败；修正后保持完整性判据。该样本 evidence_stable=false，scratch /private/tmp/notion-sdk-pi-Smiacc 保留。partial02 的脚本错误地期待 inspect 被替换；既有生产去重优先保留显式完整 delivery。先核对其原始证据 11 组判据，再仅纠正替换方向并补上 native 主文被替换、目录保留的检查；没有降低完整正文/身份/pin 判据。partial02 继续标 failed，26 份原件 hash 不变后正常 Trash；partial03 在新目录通过。

后续沿 SC13 的有效来源归属规划推进 custom 覆盖、tombstone、move 和 metadata-only 场景，在真实请求/对象集合上减少首次来源获取。SC11/SC12 前置、Git 内容身份转换、旧 retained ZIP 成本和 SC18 文件级迁移仍分别完成。完整 SC20/SC21 矩阵、pro/mini 恢复与日用切换不由本切片替代。
