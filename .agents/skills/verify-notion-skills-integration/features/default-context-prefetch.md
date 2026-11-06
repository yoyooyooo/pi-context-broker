# 默认 View、首发注入与后台准备

## 入口

```bash
node scripts/verify-notion-integration.mjs doctor --mode deterministic --view-discovery true
node scripts/verify-notion-integration.mjs run --mode deterministic --view-discovery true --evidence-root /absolute/evidence
node scripts/verify-notion-integration.mjs evidence --evidence /absolute/run
node scripts/verify-notion-integration.mjs cleanup --evidence /absolute/run
```

使用实际安装的 Pi / OMP、公开扩展/RPC 入口和 provider payload 捕获。Notion CLI 与 LLM 是受控 fixture，不代表真实 Notion 或真实 LLM。传入 `--extension /absolute/installed/src/index.ts` 可验证冻结安装产物。

View 专项在进程启动、续接、fork 和 sibling 会话后，先通过公开 `/context-broker refresh` 完成元数据屏障，核验这一步没有 provider 请求，再断言 ready 目录。它不声称无等待的首次普通消息必然已 ready；这一 pending → 后续普通 turn 的边界由下方预取专项实际记录。`/context-broker views` 必须在原始 fixture 调用日志中留下 `command: ctl`、`args[0]: views`；旧 alias 可调用不等于当前内部 caller 已迁移。

Source 的可选 `profile_id` 必须同时配置显式 `database`。默认目录优先级为当前会话 View → source `default_view_id` → 显式 `profile_id` 或与该库匹配的 CLI 机器 Profile 绑定 → 无绑定时的首项 View；Profile 本身选择其共享配置指定的 View 或首项策略。显式 View 不带 `--profile`，完整目录发现不受默认目录过滤结果污染。

`verify-notion-integration.mjs` 没有 `--profile` 选项，且每次 run 新建 CLI config/state/cache/data；它不会继承日常机器的 Profile 绑定。`--view-discovery true` 使用受控 View fixture，不能证明实际绑定读取。source 参数、响应身份、优先级及缓存隔离属于现有 adapter/CLI 回归的契约；真实机器绑定须另有实际配置和读取证据，未运行时不得由 View 或单元结果代填。

## 必须检查的行为

| 场景 | 可观察结果 |
| --- | --- |
| 新建会话、列举 Views、查询当前 View | provider 请求数为 0，未向会话写入默认目录正文或完整 Skill |
| 第一条普通消息 | 一个当前目录，只有名称/描述/位置；未预载 Skill 正文 |
| 首发前选另一个 View | 第一条模型请求直接使用该 View，无旧目录残留 |
| 从 A 切换 B | 下一轮目录替换；B 内未勾选 checkbox 的 Skill 可见，A 外条目不再默认公布 |
| 显式调用 View 外的 Skill | 完整 `$` 选择有效，正文只加载一次 |
| 再次切换 View | 已读正文和固定资源版本保留，不复制、不声称撤回 |
| 无配置 / 显式配置 / default reset | 无 Profile 绑定时首项兜底 / 配置 ID 优先 / 恢复默认解析分别可见 |
| 错误 ID / 零 Views | 前者报告错误而不改选，后者为空目录；普通任务和精确显式调用仍可用 |
| 非空 partial View | 原 CLI 成功返回一个精确成员、`coverage.exhaustive: false` 和非空 `failed_sources`；实际 provider 的同一 View 保留该成员与 `partial="true"`，不替换为空目录或全库目录；来源警告可见，正文准备为零 |
| 来源失败与恢复 | 同一入口的 `failList` 返回 `NOTION_REQUEST_FAILED`；provider 明确为 error，没有沿用 partial 成员冒充成功。恢复源后公开 refresh 不调用 provider，下一普通请求恢复完整目录 |
| 进程重开续接 / fork 到旧分支 | 根据有效分支恢复选择，不拿进程内状态充当持久化 |
| 两个活跃会话 | 切换互不串选；无 Profile 绑定的 fixture 未配置 View 时各自解析首项 |
| 本地 Skill | 不是 Broker 所有的 metadata 仍保留 |
| Pi compaction 后普通续问 | 先证明压缩移除了正文；当前分支成功交付的 active receipt 仍在。普通下一轮用原固定向量 `inspect` 恢复完整正文恰一次，View 不变，不新选版本；再显式 `$` 仍一份 |

证据为 `*-view-provider.jsonl`、`*-view-rpc.json`、`*-view-result.json`、manifest 与自有进程退出回执。检查实际 provider 中的目录，不只检查配置对象或 UI 提示。

partial 相位只扩原 `notion-integration-fixture.mjs` 的受控列表响应：普通完整库仍返回原三个成员，选定 View 返回原 `UI Alpha` 一个成员，缺失项以原 `UI Gamma` 的 ID 和 `NOT_FOUND` 标入 coverage。`source-cli-calls.jsonl` 的 `catalog-response` 保存实际 stdout 对象、原 argv 和时刻；与 provider 索引、当前分支 session 副本一起核对。Pi 从实际系统目录取得 `sr:C` 后，校验其既有 candidate 绑定的 owner/scope/locator；canonical 入口逐字匹配返回的主文 ref，OMP 仍核原 native 路径旁的 canonical ref。私有绑定只证明公开入口归属，不能代替模型实际看到目录。

此相位不选 Skill、不读取正文、不展开 Requires，也不产生 active 确认。断言拒绝 empty/all-library/complete 冒充 partial、用户消息伪造目录、错误 owner/scope、旧分支句柄及正文混入。复用原 `failList` 后必须在 finally 复位 fixture；仅清理 manifest 所属 scratch 并进系统 Trash。受控 CLI 没有真实 Notion HTTP/core 缓存，不能由本相位推导生产请求、权限或跨进程缓存收益。

接线证据（2026-11-06）：`sc06-partial-view-d_zadb79/fail-before.log` 保留旧 fixture 的实际 `true !== false`；更新后原 `notion-integration-hosts.test.mjs` 为 25/25，包含原入口/正文/压缩断言。该阶段只有本地 fixture 与 oracle 验证，安装实驱当时标为 not run；不继承旧 646 的完整、空、错误 View 结果作为本次 partial 通过。

随后以纯 `d0eee56` harness、`282fb35a…` 安装包和 Pi 1.5 执行一次，原 `QC55vI` 保留为 **failed**：首个实际 provider 的 `system.sections["context-broker-notion-catalog"]` 已包含 647 字节完整目录，但旧 View 读取器只看空 `content`，旧 `nativeEntries` 也只读 `sections.skills`。原 outer exit 1、Pi 按 `rpc.stop` 退出 143，E→Trash→E 后 304 个原件保持哈希；partial/失败/恢复三相位均未运行，不离线改判成功。

调用方现在共用原 SDK 验证器迁入 `notion-default-context.mjs` 的 `providerSystemText`：只回放实际 system 消息的文本及命名 section patches，同名替换、`null` 删除，保留 OMP 顶层 `systemPrompt`。SDK 保持同名 re-export，不另建解析器。`sc06-view-sections-fb92jufh` 保存两个同形态红例、原 28/28 回归及封存捕获的离线解码；非 system 伪造、重复目录、原 owner/scope/单目录要求不变。该阶段的新安装实驱当时尚待授权，包不因这个 observer 修复重建。

### 2026-11-06：同包 View 安装实驱

纯 `130a7e4567ee9aa6d1e7f8deaa3616c9390507b3` 导出的 258 个 harness 文件，配原 `282fb35a8266fc76c49d9ae3e423fff536b5d9b8d7346b059474357cca28d889` 安装包、C8 和 Pi 1.5.0，按原 RPC 120000 ms、n=1、零重试运行一次：`gBLqrM` **passed**。24 次实际受控 provider 调用贯通原完整/空/无效 View、切换、显式选择、续接、fork、compaction 及新增 partial → 来源失败 → 恢复。新结果不改写前述 `QC55vI` failed 或其三个 not_run。

以下索引从 0 开始，来自本轮 `pi-view-provider.jsonl` 的实际 system sections；目录始终恰一份，状态与精确成员分别核对。

| 状态 | 实际 capture 与边界 |
| --- | --- |
| complete | provider 0 为首项 View、一个 `UI Alpha`、`partial="false"`；provider 23 在来源恢复后回到同一完整 View。中间正常切换另保留实际 Alpha/Beta 目录 |
| empty | provider 19/20 为 `origin="first" status="empty"`、零成员；不回退成全库目录 |
| invalid-config | provider 17/18 为 `origin="configured" status="error" code="NOT_FOUND"`，不自动改选 |
| source-failure | provider 22 为 `status="error" code="NOTION_REQUEST_FAILED"`，没有把旧 partial 成员当成功目录 |
| partial-source | provider 21 保留一个精确 `UI Alpha`、`partial="true"`；同区间实际 CLI stdout 的 `coverage.exhaustive=false`、`failed_sources` 含 Gamma/NOT_FOUND，公开 `sr:C` 与当前分支 owner/scope/locator 一致 |
| pending | **本 View run 没有 pending capture**，它沿原公开 refresh 元数据屏障后发消息。独立同包/同 `130a7e4` SDK 场景 `validation-130a7e4/pi150-default-view` 的 request `90541:1` 为 pending、`:2`/`:3` 为 ready（各两个成员）；不能写成这 24 次 View 调用覆盖了六态 |

账本是 **81 次受控 custom CLI 调用 + 13 条 stdout/失败响应观察 = 94 条日志**，不是 94 次 HTTP。partial、来源失败、恢复三个区间分别有 5/7/3 次 CLI 调用，均没有 prepare/read/use/export 正文调用；不从受控 fixture 推断生产 HTTP、核心缓存或权限收益，也不补造逐 CLI 子进程退出指标。外层 runner 自然退出 0；9 个原生 Pi 均由既有 `rpc.stop` 关闭，实际 code 143、signal null，不能记作 Pi 自然退出 0 或 stdin EOF。

证据根为 `/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/sc06-view-sections-after-5c5421rd`：`handoff.json` SHA `eefab15eb01f73ed1f11044525b11332e4c79f2b02e6ed586f73bd783cd99751`，`actual-review.json` SHA `0c03244b8c43b01908350674e57aeb4769aed588f1b658badbc93ea941af7eee`，`selected-system-catalogs.json` SHA `ce8d1e0ce85a9aad3e00d48525386508e78e94a11c165cb45656efabd56c5b63`。`ece.json` SHA `beef2e30d41b2c1cccbf7259ebee3557958d4c4a92a7c747a8772f6ba0132cea` 记录原 Evidence→系统 Trash→Evidence、391 个封存文件哈希保持、101 个非敏感 scratch 文件保留、auth 内容未复制，以及 258 个 harness 文件、87 个包成员、旧失败原件和日用三哨兵均未变化。

pending 的独立 SDK 原件在 `sc06-c8-sdk-all14-zzcex1t7/validation-130a7e4/pi150-default-view/evidence/default-view/`：`default-view.json` SHA `82c8b34602760299a57fe504812eb4d76a142052b553a8bf101bbc1153d33e02`，`provider.jsonl` SHA `f3c892445ac6af2432bc232894844ad3606548b50a715463754b5143e5d68a4f`。这是另一受控 SDK fixture；本 View run 仍属 custom CLI，真实 Notion SDK 来源、生产 74 项目录和真实模型未由此补验。

压缩 oracle 依据 AH-627 的 `agent-cli-ref-20261105` 已校准合同：已实际送达并确认 active 的来源，必要全文被 compact 移除后应在普通续问恢复同一版本。Pi 不再沿用旧“普通续问正文必须为零”的断言。保留 fork 到选择前的零正文负例；压缩前、压缩后和恢复后的原生 session 副本必须显示同一 owner/scope/pin/hash 与同一确认/选择，不接受 orphan receipt、仅准备成功或新 `inspect` 冒充 `use` 确认。OMP 保留其显式 reload 的兼容边界。旧失败原件不改写。

## 真实内容与模型

使用已有只读授权的库和 View。模型模式需明确 `--model provider/model`、自然任务和 `--view VIEW_ID`。要求模型选择入口、成功读取正文及同快照支持文件，实际网络成功并把两份内容送入后续请求。模型与预算须沿当前已批准配置冻结，不修改全局模型选择。记录失败，不把受控 provider 或 HTTP 200 单独算作完成。Pi 复制实际广告的短引用或 canonical ref，OMP 保留宿主兼容入口；均须核验源 owner/scope/pin、完整回执和实际进入 provider 的字节，不能把 metadata stub 或 preparation details 当成已投递正文。

2026-11-06 的同包真实模型两原型结果见 `skill-dependency-graph.md` 的“两种真实 D 原型”。两臂各三景首provider均pending；on-demand每景只有首请求，后台完成Default74没有进入下一请求，因此没有ready卡片曝光的有效配对。普通聊天无正文读取、无目录强制等待，shutdown取消保持独立状态；介绍与自然任务均存在真实选路失败，不能用较少工具/输入称收益。没有采用on-demand为产品默认策略、扩大样本或改变原预算，普通全局Skill的Default名称/描述/准确入口合同保持。

## 有界预取与压缩专项

```bash
node scripts/verify-notion-integration.mjs doctor --mode deterministic --default-context true --host pi --extension /absolute/installed/src/index.ts
node scripts/verify-notion-integration.mjs run --mode deterministic --default-context true --host pi --extension /absolute/installed/src/index.ts --evidence-root /absolute/evidence
node scripts/verify-notion-integration.mjs evidence --evidence /absolute/run
node scripts/verify-notion-integration.mjs cleanup --evidence /absolute/run
node scripts/verify-notion-integration.mjs evidence --evidence /absolute/run
```

沿原 `scripts/notion-default-context.mjs` 驱动，不另建验证平台。`--default-context true` 是验证分支开关，不能把产品的 `prefetch: true` 解释成自动下载。产品省略预取、`false` 和旧 `true` 均为零预算；专项分别验证三种配置仍有默认目录、没有正文准备。正例显式使用 `{ maxNodes: 1, maxBytes: 65536, maxDepth: 0, maxTimeMs: 5000, rateShare: 0.1 }`，不修改用户配置。Prompt 继续排除默认发现和预取。

配置预取目前沿 public CLI `prepare --purpose inspect --priority prefetch`，即使日常 Pi 正文消费使用 SDK，也不能把这条兼容执行路径记成 SDK 请求。受控 fixture 的调用日志保留 `command` 与原始 `args`；`ctl views` 等新入口和旧 alias 共用一层分发，不能只凭规范化后的 operation 名称宣称调用方已迁移。

调用账本按真实 CLI 输出合同加观测参数：`prepare` / `ctl prepare` 自带 JSON，只追加 `--metrics`，不支持 `--json`；`use` 采集机器证据则需要 `--json --metrics`。fixture 同样拒绝非法 `prepare --json`，避免受控专项掩盖已在独立 C6 包实际 PTY 中观察到的 parser 失败。故障原件与修复后原 PTY 验证分别保留，不通过重打包改变对照。

| 场景 | 必须留下的实际边界 |
| --- | --- |
| 初次目录 pending → 后续普通 turn ready | 允许第一条普通消息尚未完成元数据；后续实际 provider 目录含准确作者名称、来源和入口，正文为零。Pi 的 `sr:` / canonical 入口不作为本地路径读取 |
| 有界后台准备 | `purpose: prefetch`、`state: prepared`、`loaded: false`，记录完整预算、根 owner/scope/snapshot/body hash/bytes；只有一个 inspect，未带 session bindings、没有 export、没有 provider 请求或会话正文 |
| 显式选择与资源续读 | 前台重新执行权限/新鲜度验证，完整正文实际进入 provider；Pi 复制已投递资源的 `sr:R`，OMP 使用已投递 owner 的真实目录；资源完整字节随后进入 provider |
| 前台到来 | 正在运行的 warming 被取消，owned 子进程实际终结；前台版本正常投递，迟到预取不能覆盖它 |
| new_session / RPC stdin EOF | 分别取消待决前台与后台工作，实际 lifecycle 事件、子进程退出、无取消后的 provider 或正文投递可核验；RPC 不等同 native composer Stop |
| 时间预算 / 权限故障 | 超预算取消或安全错误码不得进入会话；修复受控源后前台可恢复，不沿用失败准备 |
| View refresh / 失效重验 | 老 generation 取消，已移出 View 的条目不复活；`maxAge: 0s` 验证失败时不以 stale prepared body 继续请求模型 |
| 进程重开 | 再次有界验证、无自动激活，显式选择和资源读取仍完整；相同 snapshot 身份不单独证明跨进程核心缓存命中 |
| fork / compact | 真实宿主分支与 compact 命令移除有效正文后，显式选择能恢复完整内容。受控 summary hook 仅控制摘要内容，不证明远端 summarizer 质量 |

fixture 仍以 View 的 checkbox 筛选模拟成员变化；checkbox 本身不是第二道全局门禁。View 外成员通过显式选择仍可用。Pi 目录展示作者 `record.name` 与 `source`，OMP 保留兼容宿主别名，断言按各自实际公开入口检查。

### 已退休断言与证据级别

旧专项的全目录 export、后台 `ready` / `loaded`、前后台共用一个下载和 Broker `cacheDir` 冷并发发布，属于已替换的物化模型。当前预取只暖 CLI/core 缓存，产出 `prepared` 元数据；它不发布主机目录、不选择会话版本、不自动展开 Requires 或读取未选 Members。本专项记录旧断言退役原因，不把删除旧断言计为对应能力通过。

安装包、真实 Pi/OMP、公开 RPC、provider payload、取消及 owned 子进程终界是本专项的实驱边界。受控 CLI 返回冻结 wire receipt；它没有真实 core 缓存或 Notion HTTP，不能证明跨进程缓存复用、HTTP 请求下降或远端权限行为。缺少 `request_metrics` 时账本保留 `null` / `sourceMetricsComplete: false`，不补零。核心有界预算与时序 oracle 继续复用 `source-runtime.test.ts` 和 `prepare-adapter.test.ts`；真实源/SDK取消与恢复沿 `session-cache-recovery.md` 和 `activation-snapshot-resources.md` 各自留证。

每次运行保留 `*-default-context-result.json`、provider/RPC/lifecycle、`safe-source-requests.jsonl`、`source-cli-calls.jsonl`、准备后的原生 session 副本和安装身份。先检查 Evidence，再仅清理 manifest 所有的 scratch，最后重新检查 Evidence；原失败和原件 hash 保留。独立安装、真实 Notion、真实模型各自列出 pass / not run，不互相替代。

OMP 的一行 native `read` 会移除源文件最后的换行。本受控资源的实际投影为 32 / 33 字节，产品回执保持 `delivered_complete_text: false`。专项可验证这条兼容读取与生命周期，但其 `acceptance.byteExactResourceDelivery` 必须为 `not_passed`，不能计入完整字节交付。Pi 主线仍要求原文 33 字节、SHA 相等、完整 delivery 回执及相同外层 tool call；只返回 details、错 owner、部分正文都拒绝。
