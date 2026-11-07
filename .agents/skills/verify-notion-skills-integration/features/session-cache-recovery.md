# 会话缓存与恢复

前置条件：harness 创建独立 session 与 fixture source，双 Pi/OMP 原生会话路径可用。缓存证据必须同时核对 source 调用与 provider 当前有效上下文；不修改用户 session。

## SC08/SC12：A/B 会话与失败恢复

复用 `scripts/notion-skill-graph-session.mjs` 和 `scripts/notion-skill-graph-service.mjs`，用独立安装的 Pi、Broker、CLI 驱动真实 RPC／公开工具／HTTPS transport。服务端只复用冻结 CLI 源码的受控 Notion fixture，消费者始终执行独立安装 CLI。它是显式 `source.command` 与受控 provider 的证据；默认 SDK、真实 Notion、实模和正常自加载分别验收。

本分支保留原七景，并增加两条失败门槛：

| 场景 | 实际动作与断言 |
| --- | --- |
| `cold-root-required-a` | 冷消费者首次 `notion_use`；根和 Requires 的 A 正文各一份，未选 Member 无正文。 |
| `old-session-keeps-a` | 服务改为 B；旧会话继续实际选择 A。 |
| `new-session-observes-b` | 新 Pi 会话取得 B；与独立 B oracle 的 scope／owner／pin／正文相符。 |
| `resumed-original-keeps-a` | 重新打开原真实 JSONL，仍保持根和 Requires 的 A。 |
| `failed-refresh-keeps-a` | 只将本次 root 刷新必经的精确 Skills data-source inventory POST 设为 `404/object_not_found`；必须真实命中 fault，公开 `notion_use(refresh:true)` 与对应 CLI 实际失败，后续 `notion_ctl` 和 provider 保持原 A graph lock／绑定／完整正文，B 正文为零，原 JSONL 前缀逐字节不变。 |
| `first-optional-selects-b` | 移除故障后首次读取 optional，只固定其 B；既有根和 Requires 继续 A。 |
| `explicit-refresh-selects-all-b` | 完整成功的显式刷新才切到全部 B；原始 A 历史仍保留。 |
| `resumed-refresh-keeps-b` | 新进程恢复刷新后的真实 session，普通续聊继续 B。 |
| `unavailable-fixed-rejects-current` | 复制第一景真实 delivery 返回的 A fixed ref，在全新 CLI／Broker／session 根读取；当前服务仍是 B。所有 read/files 的 argv 目标必须原样固定输入并明确 `SNAPSHOT_MISSING`，零 HTTP 的 current read/files 也拒绝。原 fixed-main 路线仅允许下述唯一失败 inspect prepare；禁止 current／refresh／use／export 或其他 prepare 回退。没有成功 delivery 或 active／selected graph，独立冷 CLI fixed read 另列一致性回执。 |

服务控制仅有 `revision: "A" | "B"` 与可选布尔 `fail_refresh_root`。该开关模拟本次 root 刷新所需共享身份目录不可用；它不表示某个页面权限被撤销，404 不等同 401／403。当前 graph 从完整 inventory 取得 root 身份，因此故障精确匹配该 Skills data-source 的 POST query，不挂在未执行的 root metadata GET，也不改成正文读取失败。无关 root GET、users/me 等路由保持正常，不篡改历史 archive 或源码缓存。公开 prepare 返回 `CATALOG_INCOMPLETE`，其唯一 `failed_sources` 必须将 `NOT_FOUND` 绑定到该 Skills data source 和 database；原 CLI trace 的唯一失败 POST／404／target 与服务精确路径、请求和响应字节配对。故障的完整路径和账本仍保留在原 `service/http.jsonl`，不能只看到错误就判通过。故障窗口和全局 finally 都复位开关，服务终结的 `stopped.json` 须显示关闭。未知或意外工具错误继续使场景失败；只有计划中的准确 callId／tool／错误类别可继续后置审计，且仍需配对实际非零 CLI exit、原请求 ref 和完整 source metrics。错误不能携带完整正文成功回执。

固定缺失来自新的空状态，不删除旧缓存、不伪造 pin、不向消费者复制 A 正文或 SQLite。这里验证本机 `s_…` 固定引用不可用时的拒绝；可恢复的共享 pin 正例仍由原双机旧格式演练和相应 reader 证据承担。

固定失败的 source oracle 按原 adapter 的 `command, ref, ...options` 位置读取目标，不以 `args.includes(ref)` 判定。额外调用只允许原 list/views/schema 与 ctl views/doctor/cache identity 元数据入口；即使账本完整、HTTP 为零、没有模型交付，也不能用另一 current read/files 或其他内容命令绕过固定引用。复核反例与红→绿原件保存在本节既有 evidence 根的 `fixed-reference-review-01/`，原 17/17 源码回归保留为先前阶段结果。

固定主文在原 Broker 中走 `prepare --purpose inspect` 的激活路径。该路径可以仅省略主文 `file_id`，但 source oracle 必须先从第一景实际成功 delivery、完整 projection proof、selected graph 和 graph lock 独立证明主文 File ID／owner／entrypoint／snapshot／scope／database，再构造唯一允许的固定 target。实际 argv 必须精确等于该 target、inspect、原 database、`--max-age 0 --metrics`；没有 refresh、额外根或 query。唯一非零 CLI 回执必须为 `SNAPSHOT_MISSING`，同 scope／pin 的唯一根 `not_ready`、唯一节点 `failed`，`prepared_nodes=0`、`instruction_bytes=0`、`observed_bindings=[]`，无 content／binding／graph lock 或 Requires；完整 source trace 不能有正文／写入。随后实际 provider 与 graph 仍须证明没有交付或激活。这是已证明主文入口的兼容归一，scalar 资源和其他 prepare 不获得例外；read/files 继续逐字匹配原 fixed ref。

该驱动直接接受参数，没有独立 `doctor`／`run` 子命令。先用原 installed Doctor 核工具与归档，再由驱动的内置检查绑定实际 installed package、CLI／driver／service hash 和空根。`CLI_FIXTURE_SOURCE` 是冻结的 C7 fixture 源码目录，不是消费者源码 fallback。

```bash
node scripts/verify-notion-integration.mjs doctor --mode installed --host pi --package "$BROKER_TGZ" --command-json "[\"$NODE\",\"$CLI_ENTRY\"]"
node scripts/notion-skill-graph-session.mjs --extension "$BROKER_ENTRY" --package-path "$BROKER_TGZ" --cli-entry "$CLI_ENTRY" --cli-source "$CLI_FIXTURE_SOURCE" --evidence-root "$SESSION_EVIDENCE_ROOT" --bun "$BUN"
node --test scripts/notion-skill-graph-delivery.test.mjs
```

原测试文件的 installed refresh fault 回归仅在显式设置 `BROKER_SESSION_CLI_ENTRY`、`BROKER_SESSION_CLI_SOURCE`、`BROKER_SESSION_BUN` 三个绝对路径时启用：它启动同一受控 HTTPS 服务、执行一次独立 CLI prepare refresh，核 fault 命中／非零退出／metadata-only，另探测无关路由和 finally disarm；没有 Pi 或真实 Notion。未配置时该安装门槛明确 skipped，不能由纯 Node 用例数推断已经运行。临时目录按输出的 owned 路径保留原件后交系统 Trash。

各路径使用绝对值，并通过 owned PATH 选择已冻结的实际 Pi。保留原 120 秒 RPC／CLI 上限、30 秒 source 上限、`prefetch:false` 和 `maxAge:"0"`；即时 A/B 不能代替默认五分钟真实时钟验证，也不能将 9 景与原 7 景次数相减计算收益。主消费者、独立 A/B oracle、额外固定 CLI 对照分别列账；`controlledService` 汇总全部实际 HTTP／响应字节，retention/adoption 不预设为零写。两个失败景另外要求没有正文或写入。

终结后 `sourceAccounting` 将所有 CLI 回执及其原进程 spawn／close 与连续的服务 HTTP journal 对账；完整 trace 的 method／HTTP status／request bytes／response bytes 多重集合必须与服务全量相等。唯一允许未报告 metrics 的情形是本地 `ctl cache identity --database …` 已记录转发 SIGTERM、非超时终结且没有 stdout／响应；它仍列为非成功、metrics 未观察，不能补为零。`serverHttpFullyCovered` 与 `allInvocationMetricsPresent` 是不同结论，HTTP 全量闭合不覆盖该子进程缺少自身账本的事实。其他缺 metrics、缺进程终局、额外／缺失服务请求或字节不符仍失败。

每景保留原 plan、工具参数／错误、RPC、provider、原 CLI response／metrics 和服务 HTTP；`manifest.sessions` 绑定关闭后复制的原 JSONL。失败刷新另保存前后原文件及前缀 hash 证明，固定缺失保存来自真实第一景 delivery 的输入与冷根声明。先核 manifest 终局、每个 owned 进程 close、原件与安装 hash，再按 `ownership.json` 将该次 scratch 交给原系统 `/usr/bin/trash`，保留 evidence 并复核原件 hash；不调用永久删除，不处理旧 run 或用户状态。失败和未关闭进程不因 PID 消失而记成功。

2026-11-06 的原函数红例与源码回归位于 `/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/sc12-session-final-kwko86id`。`planned-errors-fail-before.log` 保留旧 planner 的 2 fail／1 pass，SHA256 `9d4d694c406f77604e0cd8aa1d3b3f1661355c508b43144be9b73ca233a54ef3`；它只导出原函数供原测试调用，未先改逻辑。原 `30bc…/graph-session-GedwqY` 七景保留历史身份。该轮源码门禁封存时实际 7＋2 景尚未运行，不能由纯 Node 回归或旧包通过推断；后续实际终局单列如下。

同根 `run-c8-prepare-01/fail-after-handoff.json` 保留 bace／C7／Pi 1.5 首次实际运行：前四景通过，第五景失败，后四景未运行。实际 refresh 正确使用 current ref 和 `--refresh` 并取得 B；原 root metadata GET 故障零命中，不能将成功刷新当成预期失败。原 129 HTTP 与完整账本、自然终局、故障复位及 E→Trash→E 均保留。修复该受控注入路径的独立红→绿位于 `refresh-fault-review-01/`：原安装 CLI 红例 fault=0／exit0，改注入点后的首轮 21/22 已真实命中 404、CLI exit1，但旧 oracle 错把目录错误期待成页面级 `NOT_FOUND`，故仍保留失败；后续精确断言上述 `CATALOG_INCOMPLETE` 及失败来源。它不覆盖或改写这次 Pi 失败，实际九景仍需按修正后的冻结驱动另行授权执行。

该局部门槛最终 `pass-after-02.log` 为 22/22、零 skipped，SHA256 `1986afb5ff90f53ef5b61216496c33543b904c55411b714ce56576c927a17741`。独立 C7 CLI 非零退出，3 次 metadata／0 body／0 write、唯一 inventory 404；无关 users/me 和 root GET 正常，finally 关闭故障后同 inventory 返回 200，服务自然退出。三次父控探测单列服务账本，不能并入 CLI 请求数或作为性能收益。没有执行 Pi／真实 Notion／实模。

同根 `run-5f03-02/fail-after-handoff.json`（SHA256 `8ec3d6d3e7c35eb7df1fc7bb1b6b7683e4ebec73e47652613b83625d4fed8535`）保留第二次 bace／C7／Pi 1.5 实际九景：前八景通过，包括准确 inventory 404 的失败刷新保持 A、成功刷新至 B 和进程恢复 B；第九景因旧 oracle 禁止合法 fixed-main inspect prepare 而失败。实际用户／Pi 输入保持第一景完整 A ref，内部 prepare 只省主文 File ID、保留同 owner／path／A pin；唯一根失败 `SNAPSHOT_MISSING`、0 prepared／0 body／0 write，后续 provider 无 A/B 正文、selected graph 为空。五个 Pi 均自然 exit0，64 个 owned 子进程均终结，fault 最终关闭；原 411 份证据保持、scratch 经系统 Trash 处理。原整体 FAILED 不改为 PASS。

`fixed-main-review-02/` 保留原实际 capture 和同形单元 fail-before，以及最窄修正后的 `unit-pass-after-01.log`：24 PASS／1 显式 HTTPS SKIP（SHA256 `7631a74eaba8b95a70943cec8ca2c74ca8e86be6d8ade4aeb109233155c4d823`）。`acceptance-sidecar.json` 仅离线重放原九景的 source／RPC／provider／history：前八景继续通过，第九景在上述精确主文例外下通过；没有新 Pi、source 或 model 调用，不改原失败。两次一次性离线 reader 的工具可见时点／PID 字段错误及纠正也保留，不能算消费重试。57 个完整 metrics 回执与服务 153 HTTP／37196 请求字节／198656 响应字节逐多重集合相等；另一个 `ctl cache identity` 为 SIGTERM，原回执没有 metrics 字段，仍单列未观察。账本含独立 A/B oracle 的 18 次受控写入，主消费者与固定缺失消费者写入均为零；不能把总服务成本写成消费者零写或新候选节省。

## SC08-SC22 Pi 默认 SDK 会话恢复

当前 Pi 合同使用同一 `scripts/notion-sdk-pi.mjs --scenario session-lifecycle`。`SDK_PACKAGE` 为独立安装的 Broker 根，`SDK_FIXTURE` 为 CLI 原 `sdk-fixture.ts --catalog` 输出，`SDK_LIFECYCLE_EVIDENCE` 为新的仓外绝对目录。fixture 为离线暖 source，Broker cache、agent 设置与会话从 owned 空目录开始；不借用用户 session 或日用设置。先冻结包、CLI/SDK/runtime 清单和 fixture，后运行：

`doctor` 从实际 Pi package 根执行一次 Node ESM 解析，按 `pi-ai` 的公开 `import` exports 定位 serializer，兼容嵌套或提升到上层的依赖安装。解析阶段不执行 serializer；核对最近 owning package 的名称与 Pi 版本，记录模块和 package.json 的真实路径、SHA256。`doctor`、`plan.json` 和逐请求 serializer 记录保存同一身份；HTTP 重放前再次核对文件未变。版本不匹配、包归属错误或未导出入口必须拒绝，不能添加依赖 symlink 或退回猜测路径。此本地 Node preflight 与 Agent 工具、source CLI 子进程分别计账。

```bash
node scripts/notion-sdk-pi.mjs doctor --package "$SDK_PACKAGE" --fixture "$SDK_FIXTURE" --scenario session-lifecycle
node scripts/notion-sdk-pi.mjs run --package "$SDK_PACKAGE" --fixture "$SDK_FIXTURE" --scenario session-lifecycle --out "$SDK_LIFECYCLE_EVIDENCE"
node scripts/notion-sdk-pi.mjs evidence --evidence "$SDK_LIFECYCLE_EVIDENCE"
node scripts/notion-sdk-pi.mjs cleanup --evidence "$SDK_LIFECYCLE_EVIDENCE"
node scripts/notion-sdk-pi.mjs evidence --evidence "$SDK_LIFECYCLE_EVIDENCE"
```

受控 provider 与父驱动共享的 `tool-plan.json` 只通过 `publishToolPlan` 发布：在同目录独占创建临时文件，完整写入后用 `rename` 替换原路径。初始、普通、生命周期和 live 模式的 16 处写入使用同一入口；其它报告仍使用原 `save`。provider 继续严格 `JSON.parse`，不忽略空文件或部分 JSON、不增加读取重试。写入或替换失败保持旧计划并传播原错误，临时文件随本次 owned scratch 交系统 Trash。

2026-11-06 的 Broker `1e23f5e` CI run `42178766964`／job `127763231400` 保留 all14 的 13 PASS／1 FAIL：取消景实际出现 `response_held → signal_aborted`，随后 assistant 报 `Unexpected end of JSON input`，未到晚到 callback，不能因 RPC abort 成功与进程自然退出而判取消门槛通过。原 artifact 在 `~/Library/Logs/pi-context-broker/AH-617-20261105/ci-1e23-failure-7_dnjq04/`，zip SHA256 `7813cff289ac87a9e87ccf9c77da2a323ec610772a0b04e119b987e802c5e109`。CI 没有捕获当次 plan 读取字节，因此该次恰好读到截断窗口仍是有源码和时序支持的归因，不写成已直接观察。

对应确定性离线红→绿保存在同一 Logs 根的 `sc08-tool-plan-atomic-kexw13g1/`。原测试在真实文件 `open('w')` 后、写入前暂停，直接读到已发布文件为 0 B 并重现同类 parse error；另核写入／rename 失败不能破坏旧计划。`fail-before.log` 为 3/3 预期失败，SHA256 `e2b1e8dabf7a17798fa1ba8a734b0a21b52e0ead108c135cc272e1054ea34d0e`；修复后同三例通过，`pass-after.log` SHA256 `31946011edf73bf2452ac32b4ec8c835863cd8c72805d35fda27c49dd6d4b3ee`，原 SDK driver 测试整组 107/107，`sdk-test.log` SHA256 `102f7ea2188bbe0de269f75917b46020f2688eeb8376a8552c3e2d05827cbfb1`。切点始终释放，无 sleep 调度；原 `/abort/`、真实晚到 callback、分支无 active／正文、超时和零重试断言不变。此离线切片未启动 Pi、SDK consumer、真实来源或模型；随后完成的独立安装 `session-lifecycle` 实驱与 CI 见下节，原 CI 失败不重判。

| 实际入口 | 正反例与证据 |
| --- | --- |
| 普通 turn → `notion_list` → 单次 `notion_use` 的 a/b/c 多根 | 根与共享 base 完整交付一次；实际 SDK 原结果、top-level tool result 和下一 provider 正文分别核对。重复普通 turn 不新增正文 SDK 操作。 |
| RPC `fork` 到选择前、`switch_session` 返回、`clone` 选择后分支 | 未选择分支无 active/graph/selected handle；复制旧分支实际 `sr:S` 到原生 read 得到 `SHORT_REF_UNKNOWN`，且 body SDK +0。返回与 clone 后四份全文仍各一份，固定 scope/snapshot/version 不变。预期负例工具调用必须实际执行并出现在下一 provider，不能从成本账本删掉。 |
| 原生命令 context 的 `navigateTree` 退回选择前，再返回选择后 | 使用真实 SessionManager 的 `getBranch()`，不以所有历史 entries 代替当前分支；退回后正文为零，返回后完整恢复有效历史。 |
| RPC `compact` → 普通续接 → EOF → 新 Pi 进程指定同一 session | 真正触发 Pi compact 生命周期；owned settings 缩短保留 token，受控摘要不包含源正文。`get_messages` 先证明四份正文已移除，随后一次 bundled SDK `inspect` 读取四个已固定 target；`required_closure` 不重新展开。下一实际 provider 四份全文各一次；新进程 resume 不再次准备正文。 |
| 新会话 `$a` 已派发 provider 后 RPC `abort`，再释放晚到响应 | 必须观察 `response_held → signal_aborted → response_callback(aborted=true)`、SDK/进程终局和后续普通 turn 正文为零。此次已派发输入单独计为 1，不写成 provider=0；prepared a/base 短引用可留作元数据，但 active/selected graph 为零。 |
| 分支切换或退出期间仍在进行的 metadata list 被取消 | SDK/Pi driver 必须用真实 `native-session-events.jsonl` 结算：同 PID 的 `session_tree` 或 `session_shutdown` 必须严格落在该 SDK start/end 单调时钟区间内，不加容差。完整 hash-chain、EOF、metrics 与逐 attempt 计数仍必需；取消 ID／边界／HTTP attempts 单列，不计为成功目录。缺 metrics、未知状态或取消正文操作均拒绝；至少一个 completed list 才证明默认发现。不得通过等待目录结束绕过实际取消。 |
| 新进程普通无工具回答完成时，默认 SDK 目录仍在初始化，然后直接 EOF | 在 owned `config.json` 的真实 `node:fs.readFile` callback 处暂停，SDK 和返回字节不变；普通 provider 必须在目录未完成、正文为零时正常返回。随后直接关闭 RPC 输入，真实 `session_shutdown` 释放原 callback，只有产品 owner signal 负责取消。该第三进程不得先等目录、预热或加入延时逃过窗口。原 SDK start/end、完整 metrics/trace、observer EOF 与宿主自然 exit0 必须闭合；只接受一条 shutdown-cancelled list，completed list 为零，不宣称默认目录 ready。初始化 callback 必须释放且无 pending。 |

审阅 `lifecycle-launch.json`、`lifecycle-steps.json`、逐阶段 `*-branch.json`、`fixed-restore.json`、`messages-after-compact-before-restore.json`、逐进程 `rpc-frames*.json` / `rpc-lifecycle*.json`、`native-session-events.jsonl` 和 `observer*.jsonl`。被动 native event handler 必须在 Broker 之前注册，记录事件入口；在产品 await 之后才执行的 handler 不能作为取消发生时刻，不补时间容差。新增 `shutdown-pending-before-eof.json` 必须保留关闭前仍有 SDK pending 的事实；`observer-shutdown.jsonl` 与 `source-finality-shutdown.json` 证明关闭后的实际终局，不能由 exit0 单独推断完成。每进程独立 SDK hash-chain 与 terminal，全部关闭才封存和 cleanup；真实 session 文件原样归档。所有 provider capture 均通过已安装 pi-ai 序列化并向本地 HTTP 发出，schema、正文、历史、工具与字节累计在 `provider-http.json` 中；受控摘要质量、真实模型、真实 Notion、冷 source 与双机恢复仍分别验收。

目录 owner 回归复用 `bun packages/context-broker/scripts/catalog-menu.test.ts` 内的 `catalog-menu-session.test.ts`：原暖目录、旧 context 退休、新会话菜单与取消切换断言不变；追加真实阻塞 command catalogue 子进程，`session_shutdown` 返回前该 PID 必须已关闭，不能通过释放读屏障让其自然完成。host metadata generation 先退休，随后 owner abort/await；旧 promise 不得发布目录、通知已退休的 session 或从旧菜单重启请求。command 子进程门禁与上述默认 SDK／真实 Pi 门禁分别保留。

### 2026-11-06：原子计划发布后的安装与 CI

`8650132` 的原子 tool-plan 发布只修受控 provider fixture；实际安装产品仍为 `282fb/C8`。用纯865原driver、同4a43输入和Pi1.5执行一次 `session-lifecycle`，外层180秒/RPC60秒、n=1、0重试。driver自然exit0、2,460.218ms，3个Pi都自然exit0；post-dispatch abort的实际请求 `29398:2` 依次 held→abort→晚到callback aborted=true→end，原 `/abort/` 断言通过。取消分支 active=0、selected graph=0、pins=[]，允许prepared未active元数据，随后普通消息无正文；fork/clone/switch/tree/compact/resume和pending目录EOF均保留原断言。

实际15 SDK（12 list、3 consume）/0 source HTTP/0 CLI/0远端模型；17份安装serializer请求累计171,933 B，3工具调用。原Evidence→系统Trash→Evidence后93原件、87包文件、8helper、daily三哨兵与Tern原暂存保持。证据 `sc08-tool-plan-installed-wrz4fx6a/handoff.json` SHA `194927b42970dc444111a8c01a30c03f30e906dc44840783d997c1623cf64fcb`，原报告 SHA `d75b8dee844f97e683ee92fa8a8529739f798c13c7d6a74c6a45250b94e7835f`，ECE SHA `ba2eee3c4535370c69d9eed290e565eeed2dadebfbfd34667a07745e649a3d2b`，均在本Skill既有 AH-617 Logs 根。

[865 CI attempt1](https://github.com/yoyooyooo/pi-context-broker/actions/runs/42182196099) 和 [a08 CI attempt1](https://github.com/yoyooyooo/pi-context-broker/actions/runs/42184373169) 的 check、native host、独立安装 Pi、Pi1.4、OMP/Tern及pack步骤全部通过。CI生命周期的17份serializer为175,826 B，单独保留，不能混成上述本机171,933 B。两份完整CI日志分别 SHA `9e90928cbf65fd105cabdd63d70ec8acc46d31f7debb2a6cd6a4fc1b0edcf9da` / `3d4709c5c78d332a5aee1fc95f24ec157293ac5b71ef75330dc189d2b2128d73`，没有workflow重跑。原1e23的13 PASS / lifecycle FAIL仍失败；这次不代表真实Notion或模型任务成功。

### SC08 压缩保留全文与伪标签的显式变体

`--scenario session-compaction` 复用上述 lifecycle、RPC、受控 provider、SDK observer 和 Evidence/Cleanup；不加入 `all`，原 `session-lifecycle` 的 17 次 provider 路线不变。它在同一条生命周期中增加两个普通续接，预期为 19 次 provider、三个 Pi 进程、比原路线多一次 fixed `inspect`。每次实际运行均核对这些断言，不能从纯 Node 回归预报通过。元数据 list 的完成／取消及实际成本继续按原账本观察，不预填调用数。

```bash
node scripts/notion-sdk-pi.mjs doctor --package "$SDK_PACKAGE" --fixture "$SDK_FIXTURE" --scenario session-compaction
node scripts/notion-sdk-pi.mjs run --package "$SDK_PACKAGE" --fixture "$SDK_FIXTURE" --scenario session-compaction --out "$SDK_COMPACTION_EVIDENCE"
node scripts/notion-sdk-pi.mjs evidence --evidence "$SDK_COMPACTION_EVIDENCE"
node scripts/notion-sdk-pi.mjs cleanup --evidence "$SDK_COMPACTION_EVIDENCE"
node scripts/notion-sdk-pi.mjs evidence --evidence "$SDK_COMPACTION_EVIDENCE"
```

第一边界从当前真实分支的原 use 用户 entry 开始保留。真实 `compact` 必须留下原 `notion_use` toolCallId、完整 content 和原 host receipt；`get_messages` 的正文各一次，随后普通 provider 仍各一次、body SDK 增量为零。不能靠保留 raw JSONL、手工 `confirmActiveSources` 或另造 receipt 代替有效上下文。第二边界使用原独立进程 resume 后已有的普通用户 entry 作为 keep 起点，移除原工具正文和恢复投影；摘要只放首次实际工具结果已披露的 name／`sr:S` 及 `loaded="true"`／`Already loaded.` 伪标签，不附任何可信 receipt 或正文。`get_messages` 必须四正文为零，随后一次 fixed `inspect` 恢复原四个 scope／owner／snapshot；下一真实 provider 各正文一次。原单次摘要删除和固定恢复步骤仍保留，因此三次受控 compaction 分别记录「保留全文」「删除后仅摘要」「伪标签」，不宣称真实模型摘要质量。

每次都要绑定真实 `session_before_compact` 返回、Pi 保存的 compaction entry、`firstKeptEntryId`、`session_compact(fromExtension=true)`、实际 `get_messages` 和下一 provider；压缩 hook 本身不得发起 provider 或读取 source body。`compaction-variants.json`、`kept-compact-rpc.json`、`messages-after-kept-compact.json`、`forged-compact-rpc.json`、`messages-after-forged-compact.json` 与 `forged-fixed-restore.json` 补充原生命周期证据。原 full receipt 缺失／改动、toolCallId 脱离、短确认替代、user 冒充、重复全文、keep 起点越过正文、非真实 hook、伪标签引用漂移或夹入正文都必须拒绝。固定恢复继续复用原反例：不能改 current、use、scope、pin、版本或 Requires 集合，SDK 内部成功仍不是 provider 交付。

2026-11-06 实施证据位于 `/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/sc08-compaction-variants-wa0z13iv`：`coverage-fail-before.json` 仅记录原 bace 17-provider 已通过样本缺两个实际变体，原通过报告不改写；`semantic-fail-before.log` 是原 branch oracle 忽略有效压缩证据而产生的 13 个 `Missing expected exception`，不是缺 export／TypeError，也不是产品失败。针对性纯 Node 的 `unit-pass-after-02.log` 17/17 通过；该开发阶段尚未运行新 Pi 变体，后续安装实驱另列如下。

**2026-11-06：独立安装 Pi 的四种压缩语义已通过。** 纯 `da80d9a1b68698449125e00b743ec3e10bea6839` 的八文件原 harness，绑定纯 `128b59d776648ab2eca2b8b14c9a09a267958faa` 构建的 Broker 归档 `14acc956a1bde32ddde4966b5298266c3b52898c5da92abe1a718c74c822dfba`。实际安装 86 文件与归档一致，内嵌 C7 CLI/SDK 不变；Pi 1.5.0、Node 24.20.0、原 `4a43f63c…` fixture。Doctor ready 后单次执行，外层 180000 ms、原内部 RPC 预算不变、n=1、0 重试；driver 2.51 秒自然 exit 0。

| 实际 compaction 与下一 provider | 压缩后、恢复前四正文 copies | 下一实际 provider 四正文 copies | body SDK 增量 |
| --- | --- | --- | ---: |
| kept：保留原 use entry、toolCallId、全文与 receipt | 各 1 | `KEEP_COMPACTED` 各 1 | 0 |
| summary：删去原全文，只剩受控摘要 | 各 0 | `RESTORE_COMPACTED` 各 1，固定原四个 pin | 1 次 fixed inspect |
| forged：只有公开 name/sr:S/loaded 标签，无可信 receipt | 各 0 | `RESTORE_FORGED_LABELS` 各 1，固定原四个 pin | 1 次 fixed inspect |

共有三次真实 compact 事件；summary 同时验证「删除全文」与「仅摘要后固定恢复」，因此覆盖四种合同语义，不称为四次 compact。每次均绑定真实 compaction entry、firstKeptEntryId、fromExtension、get_messages 与下一 provider；压缩 hook 自身 provider/body SDK 均为零。原 use 的 content/receipt hash 和 toolCallId 在 kept 中逐字保持，伪标签没有得到投递资格。两次恢复都为原四个 owner/scope/snapshot 的 inspect，未扩 Requires、不回退 current；独立进程 resume 复用完整投影，body SDK 为零。

实际共 19 provider／localhost serializer 请求、3 次工具调用、196296 B 完整请求体；3 个 Pi 进程均自然 exit 0/signal null，17 个 SDK 操作中 4 个 body、13 个 metadata list，后者 11 完成、2 取消。两次取消分别与真实 session_tree/session_shutdown 绑定，HTTP 均有完整零账本；无 CLI source 子进程、生产 Notion 或真实模型调用。该受控摘要仅验证宿主的压缩／恢复合同，不证明真实模型的摘要质量，也不替代 SC21。

原件在上述根 `da80-frozen/actual-n1`；`handoff-actual-14acc9.json` SHA256 `70ac4c9b20fd14d54f099843edd6a9c1f70e08849c11748bb6c086371ba51e21`，`compaction-variants.json` 为 `cd13be7b400b6df4af0998995de85ce3535b9029e49f005463cfde597b38227e`，`provider-http.json` 为 `263eb9500bb3df8ba8eab98f900b656226cd1d33a6ec1ebcbc51968387dcb61c`。原 Evidence→系统 Trash→Evidence 的 cleanup 状态为 trashed，仅移走 owned scratch；107 个原件与本次实际 daily3 前后哈希一致。原 all14 和历史失败未重跑或改判。

### C12 同包压缩恢复增量（2026-11-07）

C12 的 `a9ba19e` 改变原生回执与有效分支关联，不能直接继承 C9 的三变体结果。执行前登记 AH-638 comment `c75750c4-ad2d-44be-bc2a-dc0a57ccfecf`，使用同一 C12 tar `d1d69e9c3d5ff07df2eceb0ecce02523468808be69b9e06b7b9fc0b4a19741a2` 的 strict 安装、Pi 1.5.0、Node 24.20.0 和原 `4a43f63c…` offline fixture。复用已冻结 `1f991217` harness；六个生命周期／compaction／oracle 函数跨 C9、1f、967 和 c187 字节一致，967 的普通场景 EOF 改动位于本场景独立返回之后。没有重新打包或改变原断言。

原 `session-compaction` 单次实驱通过：doctor 一次 ready，run 一次自然 exit0，2,309.962 ms；外层 doctor 60秒／run 180秒、原 RPC 预算、n=1、0 retry/fallback 保持。

| 真实 compact 分支 | 压缩后、恢复前 a/b/c/base 正文 | 下一实际 provider 正文 | 后续 body SDK |
| --- | --- | --- | ---: |
| kept，保留原 toolCallId／完整 content／receipt | 各一份 | 各一份 | 0 |
| summary，移除正文，仅摘要 | 各零份 | 各一份，原四个固定 pin | 1 次 fixed inspect |
| forged，仅公开 loaded 标签 | 各零份 | 各一份，原四个固定 pin | 1 次 fixed inspect |

三次 compact 自身 provider／body SDK 都为零。实际累计 19 个 provider capture，均通过安装 pi-ai 向 localhost 序列化，完整请求体 184,474 B、3 次工具调用；14 次 SDK＝10 list（8 completed、2 与真实 session_shutdown 绑定的 cancelled）＋4 consume，CLI／来源 HTTP／生产 Notion／远端模型均为零。新进程 resume 后首条普通续问保留完整投影，正文 SDK 增量为零；resumed 进程后续仍包含其他 consume。三个 Pi 均实际 close code0、source EOF 无 pending。本景四正文合计103 B，证明恢复正确性，不外推大正文或生产性能，也不从 C9 的 17 SDK 或字节差推算真实来源收益。

原 Evidence→系统 Trash→Evidence 三步 exit0，106 份原件 hash 保持，owned scratch `/private/tmp/notion-sdk-pi-QEFxqE` 原位置不存在，三个 Pi 与 driver PID 均已退出。证据根 `/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/c12-compaction-7g_iv_nf`：`actual-n1/report.json` SHA `94a00000b486f6e50e90fa342cf774b71804fb648b30e193542722e8e8bd493c`；`actual-n1/session-compaction/compaction-variants.json` SHA `7dafd7ae26d25470d847406c662a031e7d819e6b61fb68587d493569630de411`；同目录 `provider-http.json` SHA `f159317aafd40da098a31606983614726d658e8f34d130127957d36fb29e49e0`。原命令与冻结预算在 `commands.json`／`plan.json`。此结果补当前候选的安装恢复，不能证明真实模型摘要质量、冷 Notion 或 Mini；原 C 内容失败与正式 SC20/21、日用门槛保持。

额外的简化审计曾对 kept serializer 的顶层 tool content 直接匹配多行源正文，得到零次；该原失败另存，未被改判。root 直接读取同一 `013-serializer-request.json`，确认正文位于已声明的 JSON envelope `records[].content`，换行在该层仍转义；解码后的四个值分别为25／24／30／24 B，逐项匹配原 SDK source SHA／ref，整个原 tool content 的1,599 B及SHA也保持。澄清原件为同一证据根 `root-serializer-clarification.json`，SHA `37b1e410b692ea39267f5bcb08e915510dfd1975694946e1f06abde42f63edc6`。复核应沿原 encoding／完整性合同，不能把未解包的子串计数当作正文丢失；这次只读澄清没有重跑场景或升级辅助脚本为通过。

### 原生 `/skill` 的逐轮交付

NS-SESSION-02 的原生 `/skill:` 必须跨过第一次 provider：完整根与 Requires 首轮送达，执行一次完整根 native read，并经 `turn_end` 持久化后，后续至少两个 provider turn 仍各只含一份正文。已完整交付的 Requires 不得因一次本地投影编辑被重复恢复。根 read 的实际工具回执保留，provider 可用 `Already loaded.` 替换重复正文，但其资源目录、toolCallId、原始工具消息与顺序不变。

Pi input hook 保留用于阻止提前展开 `/skill:` 的保护换行。有效 user 投影、`nativePromptSha256` 与正文 span 必须使用同一份文本；不得在接回 machine proof 后只删除模型文本中的换行。图片、其他扩展已有的 context edit、原始 user 和 assistant/tool 消息均保留。普通 `$`、取消、分支退休与压缩后的固定恢复仍跑原用例，不能以修复重复为由接受失效证明。

原 `input-guard.test.ts` 所调用的 `soft-miss-regressions.test.ts` 同步检查两条公开输入路径：匹配但正文缺失的 `/skill:` 和不可用 namespace 中的未知引用。Pi 的 user 投影必须精确等于原文，仅 `/skill:` 前有一个保护换行；不得用 `trimStart` 或包含关系掩盖额外文本。OMP 保留原调用及任务展开合同。相邻图片、有效 Prompt／Router、未匹配目标零读取和取消断言不变；旧要求模型文本直接以 `/skill:` 开头的失败日志保留。

本地定向入口为 `bun test packages/context-broker/scripts/session-active.test.ts --test-name-pattern 'deferred slash selection'`，复用该文件的图和原会话夹具；同时审阅 `native-read-session.test.ts` 的完整/局部/伪造回执反例。真实安装路径复用原 `notion-skill-graph-observer-smoke.mjs --public-boundaries true`，按其现有参数绑定独立 installed extension、CLI 和 source。逐请求核对 `provider-http.jsonl`、`run-0/observer.jsonl` 与保留的 native session，根和各 Requires 的完整正文 copies 始终为 1。仅检查首次 provider 或 source prepare 成功不足以验收。

2026-11-05 的 `4d3ba0bfc6ee` 原 public-boundaries 失败保留在 `~/Library/Logs/pi-context-broker/AH-617-20261105/sc06-graph-sections-bu8z7s6o/graph-smoke-public-final/graph-observer-http-AuDn6P`：10 次实际受控 HTTP 请求中，第二次起根为 2 份，三个 Requires 到第十次各为 10 份。原 session 经 Pi public `buildSessionProjection` 和 4d3／646 两个已安装包的原证明函数离线回放，均复现保护换行删除后的 hash/span 失效；回放位于相邻日期目录 `sc06-slash-receipt-tmeixkir`。两包相关 context/turn_end 段及证明模块字节相同，因此它是既有 `/skill` 缺陷。离线回放不算新安装宿主通过；旧失败原件不改写，修复后的真实安装结论须绑定新包。

2026-11-05 的 `85888eeda468`／Pi 1.5.0 确定性负例保存在 `~/Library/Logs/pi-context-broker/AH-617-20261105/catalog-shutdown-aogzipc4/pi-before`：普通回答期间一条 SDK list pending，实际 EOF 已释放原 config callback，宿主自然 exit0，但 observer end 仍 `active_sdk=1`，没有 SDK end／metrics，故不能封存或 cleanup。run log SHA256 `4c446f029c1e314d68c204a9c1d6168f098bb011ee6995df899dad6a3cee8cf4`。同目录 `menu-before.log` SHA256 `63998ca9d5054a7915ac5a9f72ae6376a814ca59a531e87a302dfa15ff63b47f` 保留 command source 在 shutdown 返回后 PID 仍存活的负例。原真实模型 D-chat 的 unknown 账本仍保留在 `cd-early-feedback-10ot7qk8/pi-intent-evidence-henERH/D-chat`；受控修复后的新样本不能改写其状态。

新 `6464469dff1b` 独立归档绑定 C6 CLI／同 C5 SDK，Pro Pi 1.5.0 在上述目录的 `pi-after-02` 通过完整生命周期：3 个实际进程、5 个 session、17 次 provider 输入经已安装 serializer 发出本地 HTTP，累计 171471 B；3 次工具调用、14 次 SDK 操作（11 list，其中 2 次取消；3 consume）、0 CLI 子进程、0 source HTTP，全部自然 EOF exit0。新会话切换和快回答退出均有真实 shutdown、完整取消 metrics／trace 和观察终局，第三进程没有 completed list，不记为目录 ready。run log SHA256 `095e78ecc91e3c436f86084fbaaa4f4f6cf39d92933f57abaa866a024ef29ffd`。同包首轮 `pi-after` 已闭合 source 终局，但旧观察器在 Broker 之后才记录 resumed 进程 shutdown，晚于 SDK end 325667 ns，因此严格失败；原件保留，后续只修观察点顺序，没有时间容差或产品重包。此运行不包含真实 Notion／模型质量验收，也不将旧候选数字直接相减计算收益。

普通非生命周期场景也在 Broker 之前注册仅观察 `session_shutdown` 的 handler，并把原始事件交给同一严格取消断言。结束前一次 source drain 不能证明后续 Default View 请求不会启动，因此不得用额外等待消除这个窗口。`scoped-command` 的配置查询没有读取正文；背景 list 取消仍必须有真实边界与完整账本。2026-11-05 同 `6464469dff1b`／owned Pi 1.4.0 的旧 all14 原件位于 `~/Library/Logs/pi-context-broker/AH-617-20261105/release-646-3v4uztce/pi14-sdk-evidence`：13 景通过，scoped-command 的第一次 list 完成、第二次 list 被 shutdown 取消且 EOF／metrics 完整，但旧普通场景没有边界 observer，故严格失败。该报告保留，不能用 CI 未命中此窗口的成功覆盖。

同归档的观察点修复收口位于该目录的 `pi14-sdk-after-observer`／`pi15-sdk-after-observer`：driver SHA256 `9f80b42d384b5ed587ca8e9b9c6f734b4f163c737debd25e984998ace827ef07`，两版各 all14 通过、8 文件 harness 全程不变，且各进程均自然 EOF、源账本完整。两次 scoped-command 的 list 均完成，不声称再次命中取消窗口；两版生命周期分别实际观察 3／2 条满足严格边界的取消。`published-equivalence.json` 核对原安装、原 artifact 新安装和两次 PTY 安装的 86 个发布文件均与归档逐字节一致。原 native print／continue 两版与 Pi 1.5 PTY Stop／预算／重试均通过；PTY 首次误加 `prepare --json` 的失败保留，原 wrapper 修正参数后才复验通过。9 份本地运行已按各原 helper 或原生宿主临时目录的明确所有权完成 Evidence → Cleanup → Evidence，`cleanup-proof.json` 记录 1909 个原文件 hash 不变；失败报告未改写。

Broker `9f935638` 的 Linux CI run `42102802964`／job `127509716242` 全部门禁通过，原 log SHA256 `93d86120916b0949214ffbecd84f86d7da950b06854eb03d22708d1f9ab57849` 与下载 artifact 保存在同目录 `remote-ci/`。其中 Pi 1.5 主门禁、Pi 1.4 兼容门禁分别实际 all14 通过，均包含真实初始化取消的完整终局。CI 使用当时已提交的 driver `66e32b4b`，不包含上述普通场景观察点小修；两个 Linux 成功报告不能替代原 Mac 窗口失败或后续修复后的验证。

2026-11-05 远端 CI run `42083659039`／job `127442964922` 首次实际走完原安装入口并执行 all14：前 13 景通过，生命周期动作和终局已闭合，但一条被真实 tree 切换取消的 list 返回 `metrics_observed=true`、`request_metrics=null`，因此最终账本失败。原目录 `unified-c4-0f0b02-wj9ya_hr/ci-sdk-wiring/remote-7ba5121`（位于 `~/Library/Logs/pi-context-broker/AH-617-20261105/`）保留 CI log SHA256 `970cefc0c75c43ada42920d701acb971b868c0c94ee84c03b9422f3e7dba1517` 和下载的完整原件。其 SDK 区间为 `191194066553..191197258593 ns`，同 PID tree 边界 `191197233235 ns` 在区间内；仅此事实不能补造缺失成本。新取消断言的原失败回放仍必须拒绝这份 null metrics，不能把旧报告改为通过。

同一 `66a64e3b` 归档在 Pro 上通过新增的原 `verify-artifacts --host pi --fixture ... --require-sdk` 全门禁，包含同一独立 installed 路径上的 all14；使用现有归档目录，未从改变中的源码重新 pack。`ci-sdk-wiring/artifact-66a64-sdk-7ryewoq6/acceptance.json` SHA256 `2801cdb94fb67c0b83041b44a73f2f9c711a782db1bac533e438447c140215e2`，report SHA256 `658031325f7d9a4785e2654a7345155254398e803b397b3f6f2677939cf81074`。该次没有命中初始化取消，不能消除前述 Linux 失败；SDK 初始化取消修复仍须在新冻结候选上取得完整实际账本。60 项原 driver 回归与已封存日志回读只证明新断言接受真实 complete 记录、拒绝 null／错 PID／区间外／取消 body／漏 attempt，不能代替新候选的运行。

2026-11-05 的 `66a64e3b` 候选首轮 all14 保存在 `/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/unified-c4-0f0b02-wj9ya_hr/sdk-all-pi14`：scoped-command 通过，其余 13 景的 RPC 已执行，但 HTTP 重放因旧驱动假定嵌套 pi-ai 路径而失败，不能记为场景通过。原件、终局与失败状态保留；修复解析后使用新证据目录重跑同包。用户日用 Pi 此时为 1.5.0，冻结合同的 1.4.0 来自 owned 官方独立安装，后者的验收不覆盖 1.5 日用兼容。

2026-11-05 的 b40126dc 独立包样本 `/private/tmp/ah627-sdk-native-2ocefldg/evidence`：2 个实际 Pi 进程、4 个 session、16 次 provider 输入、3 次工具调用（含预期旧引用拒绝）、10 次 SDK list、3 次 consume、0 CLI 子进程、0 source HTTP；实际序列化累计 157590 B。run log SHA256 为 `382779a547f0d086eb1efebf8870aad3c4aac9d161090695cca87d6fb060ae75`。新增 inspect/固定 target 断言另对已封存原始 observer 回读通过，记录在相邻 `fixed-restore-review.json`，未改写原证据。三个 harness 校准失败同样保留；四次 evidence → cleanup → evidence 全通过，196 个原件 hash 未变，receipt 为 `/private/tmp/ah627-sdk-cleanup-d6c8ilz1/receipt.json`。此样本不包含后续 SC04/schema 修复，正式候选必须重新取得自身记录。

原 `notion-startup-flow.mjs` 的 `rpc-abort,rpc-new-session,rpc-late-response,rpc-active-recovery` 仍保留。它们在同一 b401 包的真实 Pi 上通过，保留目录为 `/private/tmp/ah627-pi-startup-before-pdwj_jcg`；该组是受控 command source，不能替代上述默认 SDK。准备完成前取消的 provider=0，与已经派发后的晚到取消是两个不同边界。

真实 Notion fixture 的独立入口为 `node scripts/verify-notion-integration.mjs doctor --mode live-fixture --database UUID` 与 `node scripts/verify-notion-integration.mjs run --mode live-fixture --database UUID`。唯一页与 `references/guide.md` 创建、消费、finally archive 本次页及 child pages 的 GET 回执保存在 `live-fixture-create.json`、`live-fixture-cleanup.json`；它不自动证明本地图的错误/超时与 cold/warm，仍须对应确定性证据。只读 live 不替代远端端到端。

仅 deterministic/installed 主 run 调用 OMP 的 runSourceLifecycle 子 helper，真实 fork/branch/compact-remove+refresh 的 assertion 必须审阅 helper 返回的实际证据文件及 manifest 列出的 `omp-source-lifecycle-cli-calls.jsonl`。fork/branch 后按有效上下文判定正文；compact-remove 后再次消费必须恢复正文。refresh 必须调用 `list --refresh` 并重建 metadata，只等待元数据完成，随后可后台预取所选 View 成员；预取不得发起 provider 请求或写入 loaded/Read 记录。该 helper 只证明实际执行的 OMP，不扩展为 Pi 或 live 结论。双宿主后台与生命周期按 [默认上下文地图](default-context-prefetch.md) 独立取证。Notion native cold print 看 `*-cold-print-provider.jsonl`，不由暖路径推断。

live-fixture 恢复 recipe：`node scripts/verify-notion-integration.mjs run --mode live-fixture --database UUID --resume-evidence /absolute/FAILED_EVIDENCE`。创建 deadline 15 分钟；成功与失败均保存 `live-fixture-create.json`，失败包含 allowlist 投影的 operation/page/receipt/stage，不保存任意 stdout。unknown 不得再次 create；先检查原 operation receipt，需要继续发布时仅用产品 `resume OPERATION_ID`。旧 scratch ownership/input、原 create 回执的精确 pageId、catalog 的该 ID/name/database 与 read canary 均通过后本次不 create，最后 archive。不能只凭同名重建或清理。

只恢复 cleanup 时运行 `node scripts/notion-fixture-cleanup.mjs /absolute/EVIDENCE`（可选第二参数为项目 CLI command JSON）。它读取原 create 回执中的 owned pageId 和 operation ID，以 `ctl archive PAGE_ID --operation ORIGINAL_ID --dry-run` 取得可证明归属的完整页集合，再通过同一正式归档入口逐页处理。该入口在派发前保存 intent；unknown 先 GET reconcile，未确认已归档时不重放不明 PATCH，不重新 create。每个目标只有 GET 确认 inTrash=true 才记 archived。`live-fixture-cleanup.json` 在请求前及 finally 保存结果，保留 previousAttempts；未完成为 failed/blocked，原失败 run 不会变 pass。父页 inventory 不完整或存在无法证明归属的 child 时阻止归档。旧 shared create 没有持久 ownership 回执时明确拒绝。

| ID | 用户入口与动作 | 可观察 assertion |
| --- | --- | --- |
| NS-SESSION-01 | 用户冷启动会话，发现并激活目标 | fixture 实际发生首次读取，provider 收到正确正文；不能由仅候选出现推断缓存成功。 |
| NS-SESSION-02 | 用户在暖会话重复发现、读取或激活目标，并从原生 `/skill:` 切到 `$` | fixture 调用记录与 decisions 显示实际缓存复用边界；双宿主跨入口 provider 保留且仅有一份正文，内容不串到重名目标。Pi 的可信 native receipt 必须与仍在有效上下文中的正文 digest 配对；孤立 receipt 或普通用户 XML 不得抑制激活。 |
| NS-SESSION-03 | 用户持久化后通过 continue 续接同一会话，再提交引用 | 两宿主实际恢复 session；按恢复后的有效上下文决定加载，provider 中目标正文完整且不新增重复副本。 |
| NS-SESSION-04 | 用户遇到 fixture 错误或超时后再次走可用读取路径 | 错误/超时有真实失败记录；可用路径读到真实正文，失败值不冒充可用缓存。若恢复路径未执行，明确未运行。 |
| NS-SESSION-05 | 用户在 OMP 对 source 激活后的真实会话 fork/branch | 子会话与分支实际建立，provider 正文与当前有效上下文一致，不以旧 branch 日志冒充新上下文通过。 |
| NS-SESSION-06 | 用户 compact 移除正文后重新激活，再 refresh source | compact-remove 后 provider 恢复真实正文；refresh 实际发生 `list --refresh` 并重建默认目录，后续 View 成员后台准备不向会话注入正文；helper 返回证据对应实际动作。 |
| NS-SESSION-07 | 用户用失败 evidence 恢复真实 Notion fixture | ownership/input unique name、catalog exactname 唯一与 read canary 均验证；本次无 create，最终 archive/GET 回执确认，仅操作所属页。 |
| NS-SESSION-08 | Tern/OMP 新进程首个 `$`、同进程 `/new`、保留 conversation 的 `/restart`、退出后新进程 | 运行既有 daily runner 的 `--mode captured --invocation dollar --lifecycle --lifecycle-selection alias@namespace`，重名时 selection 包含 page ID 并与既有真实候选一致。首个草稿恰好是一个 `$`，先于 gate 后真实 list 成功；放行后不重输即可出现实际候选，再追加目标前缀。无启动前 list/read/query、无 session_start metadata 等待；各项真实菜单/胶囊直到提交前 provider+0，完整固定正文一次。PID/session file 与 user/assistant turn 证明新会话、保留会话、新进程的区别。失败截图和阶段保留，不换 alias、重复输入或先 restart 掩盖；完整证据规程见[日常安装地图](daily-installation-ui.md)。 |
| NS-SESSION-09 | `live-fixture --cache-lifecycle true`，独立空 CLI/Broker 根分别启动实际 Pi 终端、OMP 终端、Tern/OMP 原生窗口 | 未勾选的 owned 页在首次激活前无 read/export；首次 `$` 实际下载 Notion 正文、导出固定 snapshot，provider 中经 XML 转义的完整正文含 frontmatter 恰好一份。终端保留真实 PTY 输入、ANSI 与解析 screen；Tern 另保存实际菜单、Tab 胶囊及提交截图。 |
| NS-SESSION-10 | 首次 `$` 后同会话重复、`/new` 和退出后的新进程 | provider 正文一份；后两者复用完整 immutable export，Notion 正文请求为零，CLI `validated_at` 不前移。CLI 进程调用与实际 Notion HTTP 分开计数。 |
| NS-SESSION-11 | 父控用公开 `read --refresh`、固定 ref 的 source export、公开 pinned `apply` 发布自建正文和 guide 的 B，再强读回验 | 有效旧会话继续 A；新会话在各自默认五分钟有效期内仍 A。只修改 create 回执所属对象；不重发未知写入、不手工改 marker。此分支证明正式发布后的缓存行为，不计 external-editor 验收。 |
| NS-SESSION-12 | 按每端实际 `validated_at` 等待默认 300000 ms 过期后再次使用 | 已加载旧会话仍 A；新会话实际请求 Notion 并导出不同的 B snapshot；真实 read 工具消费同一 B snapshot 的 guide，资源读取不再请求 Notion。使用真实时钟、默认策略和完整 HTTP 账本。原生编辑的未发布修改另按下方独立 recipe 取证。 |
| NS-SESSION-13 | `--mode deterministic --shared-catalog true`：不同 cwd、Pi/OMP、source ID/namespace、命令拼写和等价 database selector | 两个真实宿主首次 `$` 均消费正确完整正文；只建立一份 catalog/index 和一次 immutable export，第二端不新增 list/export，不推进原始 `validated_at`。独立宿主会话与 provider 捕获分别保留。 |
| NS-SESSION-14 | 同一 shared-catalog run 在一端 `/context-broker refresh`，保留两个已加载会话，再分别启动两个新进程 | 共享 catalog 选择新的不可变观察；两端旧会话仍 A，新会话读取 B，另一宿主复用同一 B export，正文各一份。此处 Notion transport/provider 为受控 fixture，不宣称真实远端编辑或真实模型通过。 |
| NS-SESSION-15 | CLI identity 回归与 Broker catalog-cache 回归 | 等价数据库 selector 共用身份；凭据和远端查询范围变化隔离；本地 TTL、创建偏好、namespace、项目路径、命令拼写不分区；按当前策略从原始校验时间重算 TTL，过期/强制刷新在另一端可见，旧格式和损坏目录重建。 |
| NS-SESSION-16 | `storage --case catalog-order`，旧 list 回应完成后挡住 stdout，新 discovery 先完成并发布，再放行旧回应 | 共享 catalog 的 alias、原始 `validated_at`、indexId 均保留新观察；另一个独立进程 lookup 仍见新 alias/时间，两次 discovery 返回的 metadata 路径仍可读。 |
| NS-SESSION-17 | `storage --case snapshot-race`，两个独立 API 进程同时首次 read/export | 两个完整 export 均已写完各自 stage 后，先放行 A 并等其 load 完成，再放行 B；两个 load 都成功且返回同一路径/快照，body 与 read 原件逐字节相同；最终仅一个完整 immutable snapshot，active cache 不留 losing `.stage-*`。允许重复 read/export。 |
| NS-SESSION-18 | `hosts --case host-first-body`，真实 Pi/OMP 各自完成 discovery 后并发首次 `$` | discovery 后无正文 read/export 和 provider；两个实际宿主在 read/export gate 上都就绪后依次放行。两次首次提交均成功，各 provider 含同一完整固定正文及 frontmatter 恰好一次；最终 inventory/resource hash 与 receipt 完整匹配且无 losing stage。只证明受控 source/provider 与实际宿主投递。 |
| NS-SESSION-19 | `storage --case snapshot-mismatch`，同 snapshot 的完整 export 资源字节不同 | winner 先完成，另一份 export 的资源与 inventory/content ID 一致地受控改变，主正文相同；后者明确 `SOURCE_OUTPUT_CONFLICT`，不能静默成功或替换 winner 的正文、receipt、完整资源 inventory。 |
| NS-SESSION-20 | `storage --case catalog-equal-time`，按 NS-SESSION-16 调度，两份 `validated_at` 完全相同 | 后预约且先完成的观察保持选中；延迟旧回应不能更换 alias、index 或独立 lookup 结果。时间相同不能代替请求顺序。 |
| NS-SESSION-21 | `storage --case catalog-clock-rollback`，按 NS-SESSION-16 调度，后预约观察的 `validated_at` 更早 | 后预约观察仍保持选中，原始校验时间不改写；请求顺序与 TTL 分开验证。 |

```bash
node scripts/verify-notion-integration.mjs doctor --mode deterministic
node scripts/verify-notion-integration.mjs run --mode deterministic
```

这组 recipe 包含 metadata、首次 `$`、repeat、continue 与 fixture cold/warm、错误/超时路径。不能以进程重启日志代替实际 continue，也不能把历史 session 中已有正文误判成新注入或当成读取请求已发生。

NS-SESSION-08 是[日常安装地图](daily-installation-ui.md)的受控 metadata 调度分支，使用实际日常 CLI/source 身份、owned 空 Broker cache 与 gate，不能称为正常日常 source 验证或 CLI 内容缓存冷启动。`/restart` 后当前窗口可用不能代替 `/new` 和下一新进程；真实日常 source smoke 与模型效果另取证。该分支不取代本地图已有双宿主 continue/fork/branch/compact 验收。

审阅 `manifest.json`、`source-cli-calls.jsonl`（fixture only）、两个宿主的 provider/decisions jsonl 和 rpc JSON。错误 fixture 被正确断言为预期失败与整个验证命令失败是不同层：只在该 ID 的实际 assertion 满足时记 pass；被跳过、超时未收口或证据缺失不得 pass。

运行后 `node scripts/verify-notion-integration.mjs evidence --evidence /absolute/evidenceDIR`。审阅后 `node scripts/verify-notion-integration.mjs cleanup --evidence /absolute/evidenceDIR`，再执行 evidence；manifest.scratch 指向独立 `/tmp` scratch，ownership.json 用于归属，cleanup.json 记录清理结果。只将 scratch 移入系统 Trash，保留 evidence 与失败记录。本文未执行验证。

真实 CLI 内容缓存与 Notion 编辑使用独立入口：

```bash
node scripts/verify-notion-integration.mjs doctor --mode live-fixture --cache-lifecycle true --database UUID --command-json '["/absolute/ntn-skills"]'
node scripts/verify-notion-integration.mjs run --mode live-fixture --cache-lifecycle true --database UUID --command-json '["/absolute/ntn-skills"]'
```

该专项要求实际 Tern/OMP 与 Pi，使用现有项目 token 和三组独立 CLI config/state/cache/data、Broker cache 与 sessions。默认有效期来自实际 CLI freshness。`cache-lifecycle-result.json` 逐宿主记录 A/B snapshot、完整正文 digest/bytes、验证时间、每阶段正文请求/export/provider 增量；`cache-HOST/safe-source-requests.jsonl` 记录 CLI 生命周期及项目引擎实际 HTTP attempts/waits，只保留分类、方法、耗时、字节数和安全响应元数据，不含 endpoint、路径、header、payload 或凭据。缺失/截断账本不能推断零请求；完整显式空账本才证明零请求。终端 uiEvidence 保留 PTY 字节、解析 screen 和退出回执；Tern 独立 uiEvidence 包含截图及 cleanup 回执。deterministic provider 不证明真实模型效果。创建与 finally archive 沿用 owned fixture 回执；失败保留阶段，部分宿主通过不能计为全量通过。专项不替代既有超时、continue/fork/branch 或正常日常安装验收。

自动 runner 的 `publication` 回执保存公开 pinned apply 的原 ref、操作 ID、结果与 B 读回；`notRun` 明确列出独立 external-editor 分支。不能用它证明未发布原生修改的检查或接受。

### 独立原生编辑分支

先用原 create 回执确认 owned 页和可编辑 reference，并保存 A 的 pin、文件 hash 与原发布状态。通过原生 Notion UI 只编辑已批准的 owned 正文或 reference，记录实际页面、前后文字和界面证据。不得使用通用 PATCH、改写 Publication 字段或修改其它页来模拟外部作者。

从父控独立 CLI 根执行公开 `read PAGE_ID --refresh`，保存当前版本/正文或实际返回的发布冲突；稳定原生修改可能已经可读，不强制伪造 `PUBLICATION_DIVERGED`。需接受既有 managed publication 的精确编辑时，使用独立安装的 `ntn-skills-operator operation inspect-edit PAGE_ID`，核对完整正文、reference 集合与 version，再执行 `ntn-skills-operator operation accept-edit PAGE_ID --expected-version EXACT_VERSION`。这两个命令属于 operator 工件，不属于日常 CLI。检查、接受及强读回验分别留证；任何未知写入沿原 operation reconcile，不重试原请求。保持三端缓存隔离，单独标注此分支实际完成范围；未执行不得记 pass。

## 共享 Notion 缓存

Notion 的 `Default Context` 只控制默认目录和后台准备，不表示项目归属。默认全局 cache 按凭据与实际远端目录复用；namespace/source ID 属于调用和宿主注册。显式 `cacheDir` 仍控制存储位置。不要为验收给 Notion 增加项目字段，也不要把会话固定版本当作可变远端内容的项目分叉。

从 Broker checkout 根目录运行：

```bash
node scripts/verify-notion-integration.mjs doctor --mode deterministic --shared-catalog true
node scripts/verify-notion-integration.mjs run --mode deterministic --shared-catalog true
bun packages/context-broker/scripts/catalog-cache.test.ts
```

共享专项复用现有 integration 的 Doctor、RPC、provider 捕获、进程 ledger、evidence/cleanup。`scripts/notion-shared-catalog.mjs` 在独立项目目录启动真实 Pi 和 OMP，以同一受控 source/cache 验证 NS-SESSION-13～14；保留 `shared-catalog-result.json` 和四个 `shared-*-provider.jsonl`/`-rpc.json`/`-decisions.jsonl`，核对 index、原始校验时间、A/B snapshot 和 list/export 增量。RPC 收口后主动 teardown 不冒充自然退出。该 route 不执行原生菜单、真实 Notion 或真实模型；原生菜单刷新/失败仍跑 `node scripts/verify-native-ui.mjs --catalog-cache` 和 `--catalog-cache-failure`。

NS-SESSION-15 的 CLI 边界从 CLI checkout 执行 `bun test packages/cli/test/cli.test.ts --test-name-pattern 'consumer catalog identity'`，对应 [C20](https://github.com/yoyooyooo/notion-skills-cli/blob/main/.cursor/skills/verify-ntn-skills/features/sync-cache-verification-plan.md#cache-time-and-identity-matrix)。CLI 的 `ctl cache identity --database SELECTOR` 必须与实际 list 选择一致；不加入 cwd、命令字节/mtime、PATH、cache roots 或整份本地 config。Broker 回归使用独立 CLI 子进程，并验证身份隔离、共享刷新、策略 TTL 和损坏恢复；实际宿主投递只由上述 shared-catalog run 证明。

用本次真实 evidence 路径执行 `evidence`、`cleanup`、再次 `evidence`，保留失败记录。修改 Skill 只维护规程；只有具体运行回执才能记录通过。

### 默认 SDK 重复使用与派生缓存复用

默认 SDK 的目录观察和正文权限仍由 CLI Core 决定。Broker 只复用已验证的本地投影：metadata index 以实际投影内容为身份，位于对应 scope 下；时间与 freshness 不进入投影 hash。相同的全目录与 View 投影、重复 discovery、同一固定 owner 的名称与别名应指向同一完整 index。内容或 scope 变化另建投影，旧路径与字节保持可读；返回值仍采用本次观察的 freshness，缓存存在不能覆盖源端拒绝或把本地读取当作一次新校验。

固定资源投影以 scope、owner、snapshot 与规范文件路径定位，File ID 与规范路径各有一个确定性的身份回执，记录 ref、bytes、sha256。带同一 File ID 的旧路径提示复用规范文件，不因每次调用或拼写变化新增回执。查到本地文件后仍调用原 SDK read，继续验证权限、scope、owner、pin、File ID、返回 output 与内容 hash；SDK 使用已有文件的相同字节复用合同。没有新的 source list/export、旁路权限判断或另一套正文 cache。

宿主原生目录分为私有可变入口与不可变正文投影。相同 owner、scope 与实际名称/描述在同一实例复用 metadata index；默认 Notion entry-ready 的 host 正文及 `.broker-host-index.json` 在已验证 source entry 的同级 `.host-indexes/<hash>` 跨实例复用，位于 source tree 之外。key 包含来源身份/路径、scope、owner、snapshot/version、完整 manifest 身份、来源正文及实际 alias 正文/回执，不包含实例的临时 index。完整写入 owned stage 后原子 rename；竞争失败者须逐目录、正文与回执核对已发布赢家，symlink 或字节冲突明确失败。

每个实例仍保留自己的可变 metadata alias，因此一个会话切到 B 不会改动另一会话的 A 入口。`refresh` 与新会话继续执行原目录观察和准备，`loaded` 状态清空不会重新复制相同不可变投影；本地复用不延长 TTL，也不能替代来源权限检查。更换显示名称/描述、owner/scope 或固定版本保留不同投影；损坏投影不能成为源端拒绝后的退路。未激活的 metadata stub、filesystem 副本和旧 full-export 分支的进程目录仍单独计数。

从 Broker checkout 根运行现有回归；完整三文件中的共享解析用例需要与当前 CLI 候选一致的内嵌 SDK 编译物。先保留原 fail-before，再在最终 SDK 编译物到位后运行同一完整命令，不把过滤后的通过数替代整组结果。

```bash
bun test packages/context-broker/scripts/shared-notion-adapter.test.ts packages/context-broker/scripts/notion-entry.test.ts packages/context-broker/scripts/fixed-resource-source.test.ts --timeout 30000
bun test packages/context-broker/scripts/host-prepare.test.ts packages/context-broker/scripts/native-read-session.test.ts packages/context-broker/scripts/session-active.test.ts --timeout 30000
bun packages/context-broker/scripts/catalog-cache.test.ts
bun run typecheck
```

| 场景 | 现有回归中的验收 |
| --- | --- |
| 1. 重复目录观察 | `repeated SDK metadata observations`：全目录与 View 的相同投影共用路径；刷新观察仍执行 SDK，freshness 取本次值，目录实体集合不增加；内容变更、scope 隔离和拒绝均保留。`SC25 fixed names` 同时核对固定 owner 的名称与别名复用同一 metadata 路径。 |
| 2. 并发目录观察 | `simultaneous SDK metadata discovery`：三个并发 paired 观察的六个结果共用一个完整 index；Pro active cache 没有竞争失败的 owned stage。 |
| 3. entry 资源失败与重试 | `corrupt and interrupted resource outputs`：错误字节和取消不发布 ready 文件；相同 owner 可重试成功，materialized 状态只在成功后推进；Pro 退还本次 owned stage。 |
| 4. entry 资源暖读 | `warm entry resources`：第二次 fetch 使用已验证的 ready 文件，仍执行源端校验；递归实体集合保持不变，拒绝后既有字节保持不变。 |
| 5. scalar 资源首次与重复读取 | `one scalar output read`：直接物化选中资源、不加载主文；重复读取返回相同固定路径且仍调用 SDK，递归实体集合稳定。 |
| 6. scalar 资源不同拼写 | `warm scalar resource spellings`：File ID、带旧路径的同一 File ID、规范 path-only 请求共用实际文件；SDK 拒绝与返回错误 scope 仍失败，文件与回执集合不变。 |
| 7. scalar 错误与取消 | `corrupt or symlinked SDK output`：错误字节、symlink、执行中取消均不发布 ready 资源；开始前已取消时零 SDK 调用；Pro 不遗留本次 owned stage。 |
| 8. binary batch 重复使用 | `binary batch projection`：只物化选中的二进制字节，无主文或 entry manifest；再次使用相同 pin/file 不新增实体，损坏文件仍明确冲突。 |
| 9. 原生目录重复刷新和激活 | `repeated host metadata refresh and activation`：四次 refresh+use 以及 session switch 后再次 use 继续实际观察和准备，metadata 路径、published 目标和递归实体集合均不增加；后续来源拒绝与投影损坏仍失败，源 snapshot 字节不变。`native alias version changes` 验证 A→B→A 复用先前发布、两版原件均保留；`native directory creation can recover` 使用真实失效 TMPDIR 后恢复，失败 Promise 不能阻断后续刷新。 |
| 10. 原生 metadata 变更 | `host metadata reuse isolates owners`：改变一个描述只产生该记录的新投影，其他路径不变，旧描述仍可读取；相同记录换 scope 不能复用旧路径。 |
| 11. 跨实例/进程原生投影 | `independent host instances` 与 `separate host processes`：两个独立实例及两个自然退出的 Bun 子进程调用公开 host API，同一完整 source 身份和正文共用一个物理正文/manifest；两侧仍各执行来源 load，分别记录共享文件 bytes/hash 和私有目录/symlink，递归计数不跟随 symlink。此测试不是实际 Pi 或真实 Notion。 |
| 12. 共享发布与冲突 | `concurrent host instances`：三个并发实例只发布一份，Darwin active cache 不留本次 owned stage，后续实例拒绝坏回执。`shared native publications isolate display aliases` 验证别名 A→B→A；`another host rejects` 验证坏正文与被换为 symlink 的共享 parent，冲突不覆盖原件。原 `native alias version changes` 另核两个实例同时保持不同固定版本，互不改写 alias。 |

发布完整 index/receipt 优先使用原子 rename。需要退还的资源 stage 仅限当前操作创建的绝对路径；Pro 使用已验证可执行的 `/usr/bin/trash`，结束后确认原路径不存在，禁止永久 unlink/rm 或扫描用户目录。其它平台没有这个已验证入口时保留 owned stage，因此测试只在 Darwin 要求 stage 清空；暖读不新增实体、正确字节、权限与身份断言在所有平台都执行。回收测试 scratch 继续走已有 verification cleanup，不能把来源状态、操作回执或失败证据当作临时目录清理。

这组验收减少同内容、同 scope、同 pin 重复使用的派生实体增长，不承诺整个缓存有界。CLI Core 的 observations/对象/Records、Broker 的 metadata/resource 投影、用户已有 snapshot/pin 与操作历史分别核对；不同版本的历史保留与跨版本 GC 不由本组断言证明。显式旧 `source.command` 的 catalog journal 仍需按其独立路径计数。宿主只退还已被同一实例替换的私有 alias/stub，保留 immutable published snapshot；不能在 shutdown 扫除整个进程临时根，因为 filesystem 来源的固定副本也在该根，持久原生会话可能继续引用它。新共享投影不迁移/删除旧 UUID root，不假设旧进程已退出。Notion 原生 prompt 使用来源 immutable snapshot 路径，而非宿主 alias。

#### Source、installed 与 live 的证明层级

Source 层使用上述真实源码和受控 SDK/source，记录原命令、exit code、失败日志及前后目录/字节证据。它证明复用与拒绝语义，不证明已安装包、Pi 工具投递、真实 Notion 成本或模型行为。2026-11-07 的原始复现保存在仓外 `verification-evidence/notion-skills/cache-reuse-20261107-uvs773xi/`：`red.log/json` 保留六处增长失败；`focused-1` 保留一次目录排序断言失败及随后修正，`full-2` 中八个缓存场景通过，但整组仍为 99 pass / 11 fail（缺少内嵌 SDK 编译物）。完整组必须在最终构建后另存新回执，不能改写这些失败；`catalog-2`、`types-2` 分别保留兼容路径和类型检查结果。

同日宿主层复现与修复在 `verification-evidence/notion-skills/pro-local-loop-20261107-6wru9epq/evidence/cache-host/`：`red` 保留两处 UUID 目录增长失败；`host-final` 为最终源码下三文件 75 pass / 0 fail、828 个断言，包含同进程会话切换、权限拒绝、损坏投影、A→B→A 和临时根失败恢复。`alias-retention` 另核对 Trash 只移动 symlink、不移动其目标。此处不声称整个 host 临时根跨进程复用或安全退出回收；真实 Pi 与跨入口的 Core 复用仍按后续层级验收。

后续跨实例修复的独立证据根为 `verification-evidence/notion-skills/pro-local-refinement-20261107-9jv57mcm/evidence/cache/cross-instance-v1/`。`fail-before.log` 保留两实例得到两个不同 UUID 发布目录、三并发实例产生三份的两个原始失败；最终 `host-final-stage-count.log` 为受影响三文件 86 pass / 0 fail、908 断言，`typecheck-final.log` 退出 0，`skill-validate-offline.log` 记录 skill-creator 原 validator 通过。`projection-counts.json` 绑定相同 source/host 字节 hash：该单 Skill 样本正文 101 B、manifest 803 B，第二实例旧实现新增 904 B；新实现两次独立进程结束后仍只有一份，第二进程共享普通文件增量 0 B。每个新进程仍留 4 个私有目录（含根）和 1 个 symlink、0 个普通文件；这是已激活单 Skill 的测量区间，不能外推所有目录、未激活 stub 或历史空间。初次 inventory 跟随 symlink 重复计入共享文件的失败保留在 `process-counts-inventory-fail.log`，后续按 lstat 递归而不遍历链接，运行结果为 `process-counts.log`。这些受控 source/进程证据不代表实际安装、真实 Notion/HTTP 或模型通过。

首份统一 CLI 候选材料构建到位后，同目录 `cache-final` 记录原 cache 三文件完整 110 pass / 0 fail、533 个断言；执行前后源码与编译物 hash 均未变化。该次内嵌 CLI SHA-256 `7e5eb15d4940a975f1c486e679993e7037b919d216b9d4a749838a4557ae6a38`、SDK SHA-256 `042caf6a535501513be3a216283946b80b05960b81ce89619a79e7115dad3f62`，log SHA-256 `ca38cfb983d84a3c7d340e5c2f79d7ac4aa726cd25d27530a6b4acc836d0ddbc`。这是 source 回归使用当次 SDK 编译物的结果，不能单独作为实际安装、真实 Notion 请求数或模型消费的通过凭据；后续候选的真实产物身份与受影响增量见[安装实录](installed-consumption.md#2026-11-07-本机候选与-normal-pi-实录)，不把该次 hash 称为后续最终包。

Installed 层先冻结独立 CLI、Broker extension、内嵌 SDK 的实际入口、realpath、版本和 SHA-256，再使用本 Skill 原有 installed/SDK Pi route。仅 checkout 测试或成功 pack 不能记作本地安装体验通过。跨 CLI 与 SDK 复用还须在实际 Pi 进程及独立 CLI 两侧保存以下无敏感值回执：

1. 两侧实际 HOME、XDG config/cache/state 与 `NTN_SKILLS_CONFIG_HOME`、`NTN_SKILLS_CACHE_HOME`、`NTN_SKILLS_HOME` 的最终绝对根，以及对应 Core SQLite、objects/snapshots 的实际位置。默认 Core 状态根为 `~/.local/state/ntn-skills`；显式覆盖优先，包路径与 source namespace 不自行分库。相对配置根按各自 cwd 解析，不能只核对 shell 环境后假定 Pi 一致。Broker `cacheDir` 是派生投影位置，独立存在不表示 Core 正文重复缓存。
2. 等价 database/registration/upstream 选择、scope/credential identity 摘要、record owner、snapshot/version、文件 File ID/path 与正文/资源 hash；不记录 token。cwd、入口文件名、namespace 或本地 TTL 改变不应分裂远端身份；凭据或实际远端范围改变必须隔离。
3. 在同一有效 scope 和原始 freshness 有效期内，先由一个入口准备目标，再由另一个入口消费同一 pin/对象。保留双方完整 `request_metrics`/HTTP 账本，核对第二入口符合暖读条件时零 Notion 请求，并核对实际对象/投影路径、递归实体数与 bytes/hash，而非只看两个独立的 cache-hit 标志。source SDK 调用次数、CLI 子进程次数、Notion HTTP 次数及传输字节分别记账。
4. 重复 catalog/View 观察、同一资源重读和新会话重用后，同内容投影实体稳定；仍执行当前 source 检查，错误 scope/拒绝保持失败。当前版本更新或默认 TTL 到期沿原缓存规程获取新观察，旧会话 pin 与旧文件字节保持不变；明确区分必要新版本实体与相同内容重复增长。

Live 层在已有任务授权覆盖的 Notion 记录和实际 Pro Pi 中执行相同跨入口条件，复用既有 live/model 的 Doctor、provider/RPC、HTTP ledger、evidence 和 cleanup。受控 SDK 测试不替代真实请求计数；真实 Notion 成功也不替代模型消费回执。未执行的层保持待验收，不新增验证平台或另建 Skill。

## 并发发布与首次正文

复用本 Skill 的可执行 [concurrency harness](../scripts/verify-cache-concurrency.mjs)，不运行旧 `/private/tmp/broker-concurrent-vpvgU2/investigate.mjs`。入口位于本 Skill，工作目录仍为 Broker checkout 根目录。`storage` 不启动宿主，不继承凭据，不访问真实 Notion。Node 编排两个 Bun 子进程，直接导入当前 checkout 的 `notion-source.ts`，复用现有 `createNotionFixture()`。`hosts` 使用现有 RPC、隔离环境、fake provider 和 process ledger helper，实际启动 Pi/OMP 及当前 checkout extension，不从 API 结果推断宿主通过。

`--case` 可用名称或完整 ID，也可逗号分隔或重复传入。省略时 `storage` 执行 `catalog-order`、`snapshot-race`、`snapshot-mismatch`、`catalog-equal-time`、`catalog-clock-rollback`；`hosts` 执行 `host-first-body`。跨 mode case、未知参数、未知 case 均拒绝，不静默跳过。每个选中 case 独立运行，独立 assertion 逐条保留；一个 case 失败继续其余 case。Pi/OMP 启动、提交与 teardown 的独立错误也保留。只有全部选中 case 通过才是 run pass，Doctor 就绪和 evidence preserved 均不覆盖失败状态。

先执行 Doctor。Doctor 只在 owned scratch 用 `--version` 探测 storage 的 Bun，或 hosts 的真实 Pi/OMP，并记录 Node 和当前入口 SHA-256。Doctor 不导入运行产品、不发现 Notion、不调用 provider。每次 Doctor 也输出自己的 evidence/scratch，应按下文清理。

```bash
node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs doctor --mode storage --case catalog-order,snapshot-race
node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs doctor --mode hosts --case host-first-body
```

修复前必须保留失败证据，再允许产品修改。以下两个命令是可直接运行的 fail-before recipe。第一个足以挡住修复阶段；第二个单独证明实际 Pi/OMP 首次正文路径。旧代码预期失败项为 NS-SESSION-16 的 catalog alias/validated_at/index 回退，以及 NS-SESSION-17/18 的 active losing stage。已知旧路径两个 load 本来都会成功，不能把重复 read/export 或本来成功的正文加载误报为修复目标。

```bash
node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs run --mode storage --case catalog-order,snapshot-race
node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs run --mode hosts --case host-first-body
```

修复后在同一 checkout 重新执行完全相同命令，分别保存新的 pass-after evidence，再运行 mismatch 负例。各次独立 scratch 保证不复用上次已发布内容。

```bash
node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs run --mode storage --case catalog-order,snapshot-race
node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs run --mode hosts --case host-first-body
node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs run --mode storage --case snapshot-mismatch
node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs run --mode storage --case catalog-equal-time,catalog-clock-rollback
```

调度用 `concurrency-transport.mjs` 的 ready receipt 与逐 consumer release 文件，`fs.watch` 加初次存在检查等待显式 gate，不用 sleep 安排并发。catalog case 先捕获已完成的旧 list，再等新 discovery 真正发布；最后才放旧回应并启动新 lookup。NS-SESSION-16 使用递增校验时间，20 使用相同时间，21 使用后请求校验时间更早的情况。catalog 存储检查读取最高已发布序号的 receipt，alias、时间、index 和独立 lookup 断言不随布局改变。snapshot case 将两个 read 与两个已完成的 export 同时挡住，确保两个 stage 都存在，再让一个 load 完成后放另一个。host case 先等待两个 `/context-broker refresh` 原生命令完成，未勾选 Default Context，防止预取消除首次正文竞争。它没有 UI/menu、真实 Notion、真实模型或取消/崩溃覆盖声明。

review 本次打印的 evidence 绝对目录，不能复用历史路径。`manifest.json` 含精确命令、case/ID、全部 failures、未运行项、Doctor 与 scratch 归属；`CASE-result.json` 逐条记录 assertions。每个 case 子目录含 `gates.jsonl`、原子写入的 `gates/OPERATION.CONSUMER.ready.json`、release 文件与 `source-cli-calls.jsonl`。catalog 另留 `newer-published.json`、`observations.json`、`workers.json`；snapshot 留完整 export receipt、`workers.json`、`cache-state.json` 中最终正文 bytes/SHA-256、receipt、全资源 inventory 和 active stages。mismatch 负例在 `cache-state.json` 分别保存 before/after winner；该负例保留拒绝的 stage 诊断，不把拒绝路径的保留误计为 identical-publication 清理通过。

实际 host case 另保存 `discovery.json`、`completions.json`，以及 `pi-`/`omp-` 的 provider、decisions、RPC 文件。provider 校验当前首次请求中的完整 XML 转义正文和 frontmatter，不只匹配 canary；宿主既有尾部换行呈现归一化与底层 snapshot 的精确字节验证分开。`owned-processes.jsonl` 的真实 spawn/close 回执覆盖 worker、Doctor 与宿主。RPC 完成后的主动 teardown 不声称自然退出。失败与缺失证据均保留，不重试掩盖首次结果。

每次 Doctor/run 的 evidence 分开执行审阅、cleanup、再次审阅。把 `/absolute/EVIDENCE` 替换为该次命令输出的真实路径。`evidence` 报告 `functionalStatus` 和文件完整性，失败证据可正常 preserved；它不把 failed 改成 passed。cleanup 先核对每个 owned 进程的 close，以及 scratch 的系统临时根、prefix、`ownership.json` 的 runId/evidence，再调用系统 `/usr/bin/trash`。只回收 scratch，保留全部 evidence；Trash 不可用或归属/退出回执不足时明确失败，不永久删除或批量 kill。cleanup 后再次执行 evidence 仍可审阅原始失败状态。可用 `--evidence-root ABSOLUTE_DIRECTORY` 只改变证据父目录。

```bash
node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs evidence --evidence /absolute/EVIDENCE
node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs cleanup --evidence /absolute/EVIDENCE
node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs evidence --evidence /absolute/EVIDENCE
```

本文只定义可重跑规程，未执行任何检查，也不声称通过。



## AH258–260 shared content acceptance

Run two explicit Prompt submissions with different materials in one session for Pi and OMP separately. Each provider request must include the current full task requirements; retain real-model results independently. Stop, timeout and session/branch changes must fence old generations, and a subsequent submission must work. Do not count total historical body copies as per-turn proof.

No execution is claimed by this map update; final owner runs and retains the evidence.


## Native kinds RPC

复用 integration 的 `--mode live --native-kinds /absolute/native-kinds.json`，完整 Doctor/run 命令与配置合同见[Skill 入口](../SKILL.md#doctor-与入口)。该分支使用既有 Skill、Prompt、Router 共享记录、实际安装的 CLI/extension 和两个真实宿主，provider 为受控边界。父控先用公开 list、逐项 `read --refresh`、同 snapshot 的 offline files/export 校验完整树与 SHA-256；这只定义本次消费原件，不替代作者预期或远端写入验证。各宿主 CLI config/state/cache 独立，父控预读不使宿主缓存变暖。

每宿主按三个独立 recipe 执行七次 provider 请求，不新增 feature ID 或独立控制器：

| Recipe | 实际动作 | 必须观察到的结果 |
| --- | --- | --- |
| Prompt | 同一 session 连续两次显式提交，当前材料 marker 不同 | 每次当前 user message 有且仅有一份完整 prompt-task，identity、snapshot/version 与正文 SHA 匹配，invocation 非空且不重复；Prompt 不产生持久 loaded 回执。历史 user message 的 Prompt 不计为本轮重复。 |
| Router/member | 先只提交 Router，再显式提交其所列 Skill | 第一请求只有 Router 正文，没有 member 完整正文；第二请求保留 Router 并加入所选 Skill。本行只断言 provider 投递，member I/O 另按下述来源证据判定。 |
| Mixed/continue | 同 session 两次混合三 Kind，停止 owned host 后以 `--continue` 恢复同一 session，再提交第三次 | sessionFile 精确一致且旧材料 marker 保留；当前 Prompt 每轮重新注入，Skill/Router 完整正文在全部 provider messages 中各一份，raw/XML 转义副本合计计数；原生 get_messages 中 Skill/Router loaded 回执各一份、Prompt 为零。 |

产品边界仍是：选择 Router 不得触发 member 正文读取、准备或注入。独立 View 供给规则已触发的预取必须有单独来源证据；不能仅凭存在 View 就把 Router 引发的读取归为预取。native-kinds 当前没有断言 member source I/O，因而不能单独证明 Router 的按需读取边界；仍须由既有 CLI/source trace 与 Router gate 区分父控 oracle 读取、View 预取和 Router 激活。模型未见 member 正文不证明正文未被读取，metadata-only 也不证明磁盘冷。

审阅 `native-kinds-selection.json`、`native-kinds-catalog.json`、`native-kinds-oracles/` 的 read/files/export/完整树及各 `HOST-native-kinds-result.json`。provider、RPC、messages 与 decisions 文件按该 result 的实际 `files` 清单定位；失败保留 `HOST-native-kinds-failed-rpc.json` 及进程 ledger。`safe-source-requests.jsonl` 计量 CLI invocations，不等于真实 Notion HTTP 请求总数；实际请求指标读取留存的公共 `request_metrics`。沿用 integration evidence/cleanup，不把 preserved 改写为 passed。

本分支未覆盖真实 RPC 图片附件、准备期间的原生 composer Stop 或真实模型自主选择/指令效果；这些仍需各自已有入口与证据。它不替代实际 `magpie/group/flash-free`、Tern/Pi UI、Profile 本机绑定或发行包 gate。

AH-498 的旧候选记录：Pi 1.4.0 七次请求全部通过；OMP 18.14.2 首个 Prompt 返回 `agentInvoked:false`，provider 零请求，source 在约 25 秒准备预算到期时取消，因此该宿主失败且后续步骤未运行。RPC 已收口，不能靠增加 harness 等待或删除 provider 单次派发断言解释为成功。原失败保持不变；[execute/command 预算修复](host-skill-discovery-read.md#omp-冷读取与命令预算)后的新候选结果另行取得，本文不预报通过。

## 实际 HTTP 缓存、权限与中断

SC08／SC20 的跨层场景复用 `scripts/notion-sdk-pi.mjs` 的 `http-cache-recovery` 与 `http-interruption`；完整 Doctor／run／Evidence→Cleanup→Evidence 命令见[安装地图](installed-consumption.md#已安装-sdk-的真实-http-消费接线)。同一 frozen helper 提供原 CLI scalar fixture 的真实 loopback HTTP，Pi 及安装 SDK 负责实际请求、缓存和取消；不直接替换 SDK 返回值，不修改系统时钟或 SQLite 验证时间。该 fixture 的根没有 Requires，因此此处不扩充图闭包验收结论。

| cache phase | 实际入口与断言 |
| --- | --- |
| `cold` | 空 current/snapshot/object 状态的实际 Pi native `read`；完整 root 正文、canonical resource 与 scope／snapshot／version 绑定。真实 source HTTP 必须包含所选 owner 正文，未选 reference 目标不读正文。 |
| `warm` | 新 Pi 复用同一 SDK cache；两个目录 list 为 0 HTTP，main consume 保留一次在线 `GET /v1/users/me` 身份校验，目录与正文下载为 0；正文及绑定相同，actual `validated_at` 不前移。该新进程边界不冒称同进程 warm 或全零网络。 |
| `expired` | 使用正常支持的 `activation.maxAge: 1s`，读取上一成功 SDK node 的实际 `validated_at`，只等待尚未经过的一秒时间，然后提交；记录 request 前真实 age≥1000ms、实际新验证时间和同一固定 snapshot。必须实际发 metadata HTTP，source 事实未变时正文 HTTP 为 0。此项不是默认 300000ms 时钟门禁。 |
| `forced` | 原 `maxAge: 0` 合同按 `snapshot.ts` 的 `forceFull` 语义执行：精确重读同 owner 的 main 与两个 supporting file，身份和正文不变；不把这三次 body HTTP 隐藏成普通过期复用。随后通过真实 403／401 拒绝及恢复验证 `notion_use refresh` 与旧固定资源。 |
| `resumed` | 退出后以 `--session` 打开前一实际 Pi 的原 session file；完整历史正文仅一份、原 active receipt 保留，无 body SDK 重读。历史已交付正文不代表新的权限判定成功。 |

403 必须由本次实际 owner page／markdown 请求收到；401 必须由实际身份校验收到。失败工具没有 `contextBrokerRead`／`Resource`／`Preparation` 成功证明；已知拒绝后固定资源在本地 object read 和来源 HTTP 之前失败。恢复后显式在线 use 成功、旧固定资源完整且不准备主文，scope／snapshot／version 不漂移。fixture `denyCurrent` 同时覆盖同一 root 的 page 和 markdown，避免 catalog 解析路线没有访问 page GET 时把“已设置注入开关”冒充真实 403。

中断场景为 `rate-limit`、`disconnect`、`cancel` 三个独立空缓存。429 和 partial disconnect 各只注入一次；同一 source body 必须有两个真实 HTTP attempts，SDK trace 顺序为 failure→success，最终正文实际进入 provider。重试属于原 SDK policy，不能把 controller 重启当 retry 或改变其预算。取消等待源客户端实际收到目标 markdown headers（保留 `markdown_version` query），发送真实 RPC `abort`，将送达／ack 时间与同一个 SDK interval 及原生 tool start/end 绑定；terminal、连接关闭、原生进程退出均闭合后，迟到放行和普通续问不得新增来源请求、激活回执或正文交付。

部分响应有两个不同计量边界：HTTP service 的 `observed_response_bytes` 是服务端已写字节，只有 finish 才填写 `decoded_response_bytes`／完整 hash；SDK `response_bytes` 是客户端已接收 decoded 字节，失败或取消后已知的 prefix 不会消失。失败 attempt 可以有 32B 已接收，但完整响应长度仍未知且没有完整正文交付。不要把它改成成功、当完整正文或把已观察字节抹成 0／unknown。最终成本同时保留 failure/cancel attempt、成功 retry、工具往返和累计 serializer 输入，两个计量边界不相加。

这些新增场景沿用原 run 的 failure 与 evidence 状态，不追认旧失败。当前源码证据明确区分：源 SDK terminal 与 Broker 目录发布、warm identity 与 body reuse、非零 TTL 与 force-full、部分接收与完整交付。原 CLI cache32／默认时钟单测与真实 Pi 证据分列，不能互相替代。只清理本 run ownership 指定且全部宿主／观察器已关闭的 scratch；失败的证据、输入和账本继续保留。

2026-11-06 的 C9／Pi 1.5 实际结果位于 `~/Library/Logs/pi-context-broker/AH-617-20261105/sdk-pi-http-59mmlay9/remaining-v7/`，冻结 driver `4884b812…`、HTTP helper `7ede1e7f…`、原 scalar fixture `24d8f8cd…`。两景整体 PASS；完整身份、请求字节、provider/schema 累计量和 Evidence→Cleanup→Evidence 见[安装地图](installed-consumption.md#已安装-sdk-的真实-http-消费接线)及同根 `acceptance-ledger.json`。

| 实际 cache phase | HTTP attempts／markdown attempts | 完整服务响应 B | 观察结果 |
| --- | ---: | ---: | --- |
| cold | 23／3 | 1184627 | 当前主文与同 owner 两资源；无未选目标正文 |
| warm | 1／0 | 61 | 只验证身份，actual validation time 不变 |
| expired 1s | 8／0 | 997942 | 请求前实际 age 1061ms，无额外等待；随后新 `validated_at`，同 snapshot 与正文 |
| forced 0＋403／401 拒绝和恢复 | 40／10 | 3988527 | 首次 force-full 三正文；实际 403 后固定资源与实际 401 后固定资源均 0 HTTP／0 object read；恢复后旧固定资源各 0 HTTP |
| resumed | 0／0 | 0 | 原 session file 续接，完整主文一份，0 body SDK |

五阶段共 12 次公开工具调用与 25 份 provider 输入。10 个 forced markdown attempts 包含一条真实 403，不能全部称为成功正文下载。`http-interruption` 的 429／disconnect／cancel 分别为 24／24／21 个来源 attempts，所选 root 的失败→成功分别仅重试一次。断流与取消各有 32B 实收 prefix、完整响应长度未知；SDK bytes 保留该 prefix。实际 abort 的原生工具错误为 `SOURCE_CANCELLED`，SDK 仅返回 `{version:1,status:'cancelled',reason:'interrupted'}`，没有 entries 或成功 delivery；晚到放行后普通续问正文为 0，新增来源 HTTP 为 0。三进程自然 EOF，controller retries 为 0。

原 v1–v6 的 setup、目录发布、暖身份、零 age、故障未命中、query 后缀和取消结果假设失败均原样保留。对应 driver／oracle 校准不改 C9 运行时或 SDK retry policy，也不将这些失败改判为通过；真实非零 TTL 由本次实际 phase 补足，默认五分钟、真实 Notion、真实模型与 Requires 仍未由该场景证明。

## NS-SESSION-22 — Real Pi/model cold and warm source matrix

Use `scripts/verify-pi-notion-model-cache.mjs` for a real installed Pi + installed Broker + official Notion CLI + authorized actual model. Its fixture JSON describes an owned two-file Skill and a dedicated native View, selected record/ref, exact source marker/resource and expected final values. Build the oracle in a distinct CLI/XDG root. The standard model helper also isolates its oracle under `model-oracle-cli`; a parent read/export must never prewarm the consumer and then be called a cold run.

This retained matrix explicitly sets `sourceMode:command`; it verifies the custom CLI compatibility path and cannot certify the default bundled SDK. New runs declare `toolContract:agent-cli-ref-20261105`. The original first case keeps its declared `read`-only surface; other cases advertise `read`, `notion_list` and `notion_use`, with `notion_ctl` deferred. The paired graph observer uses the same generated module as the graph gate. The single-Skill observer resolves only actually advertised C/S/R handles from the current branch, then checks the selected owner, scope, snapshot and independent immutable manifest. Full native source prefixes with verified footers count as complete; a truncated body or forged delivery hash does not. Old tool traces require the evaluator's explicit `legacy-pi-tools` contract and never enable old tool names in a new run.

```bash
node scripts/verify-pi-notion-model-cache.mjs --fixture ABSOLUTE_FIXTURE_A_JSON --extension INSTALLED_EXTENSION --package-path FROZEN_BROKER_TGZ --cli INSTALLED_CLI --model magpie/group/flash-free --evidence-root ABSOLUTE_EVIDENCE
node scripts/verify-pi-notion-model-cache.mjs --fixture ABSOLUTE_FIXTURE_B_JSON --extension INSTALLED_EXTENSION --package-path FROZEN_BROKER_TGZ --cli INSTALLED_CLI --model magpie/group/flash-free --evidence-root ABSOLUTE_EVIDENCE --resume INITIAL_EVIDENCE
```

Use the user's requested model order: in AH-560, try `magpie/group/flash-free` first and only after its observed unavailability use the explicitly authorized `magpie/group/worker` with `--previous-failure ABSOLUTE_FLASH_FREE_MANIFEST`. That manifest must bind the same candidate and actual availability failure; an assertion or tool failure does not authorize fallback. Do not run a second model merely to compare it. HTTP 200 with a license message is not successful model use. Do not save raw provider payloads, reasoning, authorization headers or RPC frames.

Initial cases cover empty CLI + Broker state with autonomous native read, cold dollar and cold `/skill:`, same-session repeat and entry switching, new-process reuse, exact session-file resume, explicit zero-age revalidation and empty Broker with warm CLI. An owned A→B edit is separately authorized and verified; the resumed old session must still consume A, while an explicitly revalidated new session consumes B. Do not backdate SQLite to simulate expiry. Server-side model token cache statistics are observations only, distinct from both application caches.

Each successful case requires actual provider requests/responses, a nonempty successful final containing source-only values, one instruction body, receipt-verified resource bytes and no source writes. Official View queries are metadata reads. Request ledgers count CLI operations and actual HTTP attempts separately, including retries; a missing or truncated metric trace cannot establish zero. Cold cases prove empty roots before launching Pi; warm cases prove no body downloads. Same-session repeats can legitimately reuse resource content already in the real model context without another tool call. Save startup/process and per-turn timing separately.

Native entry reads now persist a `contextBrokerRead` proof in the actual completed tool result. It is valid only while its exact successful tool-result bytes remain in active context and identity includes the same credential scope. Partial reads, errors, user-provided XML, resource-only reads and compacted-away bodies do not count as loaded. Subsequent native/dollar invocations reuse that proof rather than reinjecting the body. This explicit command-source matrix restores fixed snapshots through CLI. Pi supporting files use the returned exact resource refs; physical cache directories cannot serve as read entrypoints.

Regression gates: `bun test packages/context-broker/scripts/native-read-session.test.ts`, package `check`, and `bun run test:verification`. The latter checks oracle isolation and refuses false positives for license-only responses, prewarmed cold tests, duplicate bodies, unconsumed resource bytes and hidden read errors. All owned processes must have observed exits before scratch cleanup. Retain failed runs separately; archive only the owned fixture/View and its exact records, never production Skill rows or user caches. This matrix is not TUI keystroke, OMP or Tern acceptance.

The observer excludes model-authored quotations/reasoning from imported-body counts, but still rejects two source-bearing copies. It records numeric usage cacheRead/cacheWrite without saving raw reasoning or provider payloads. Model rereads remain intact in persistent tool history; only the effective provider projection reduces repeated, checksum-proven instruction copies to confirmations. Original cold `/skill:` and autonomous-read failures remain retained even after reruns pass.

A/B continuation reuses the original source command argv and append-only ledger; changed instrumentation commands must not change model guidance. Retry-only case roots are unique per evidence run, and cold roots are checked before launch. `--resume-case` selects an actual previously successful session (no copied session/cache). The 2026-11-03 evidence covers 9 initial plus 6 update/mixed-cache cases, not unrun variations in later runner code. See [acceptance checkpoint](../../../../packages/context-broker/docs/pi-real-model-cache-acceptance.md) for observed outcomes and timing scope.

## 2026-11-07 Pro 正常目录：CLI v3 → Broker v7 SDK 复用实测

模型任务结束后，复用既有 `cross-entry-read.mjs` 对同一 owned page 做一次公开 CLI current read → embedded SDK current read，随后只做一次立即暖重复。继承正常 config/state/cache 根，仅设置 `NTN_SKILLS_REQUEST_TRACE_LIMIT=10000`；没有手工种缓存、正文复制、缓存清理或 Notion 写入。CLI SHA256 为 `6e51c257275ac100a27ecd16d451a3ca32cac23d502cf6ddbcb2194d673f8e43`，SDK 为 `350a53d2b3e2463f006cc048eeaaa16359ff53b84652c3384303b62571be4f44`。

| 实际轮次 | CLI HTTP／响应 B | SDK HTTP／响应 B | 正文／retained-body／写入请求 |
| --- | ---: | ---: | ---: |
| 首轮 | 10 个 metadata／186752 | 0／0 | 均为 0 |
| 立即暖重复 | 0／0 | 0／0 | 均为 0 |

四份 metrics 均 `trace_enabled=true`、`trace_dropped=0`、`in_flight=0`，实际 attempt 数与总数一致；暖重复两端的请求字节也为 0。四次结果的 owner／scope／snapshot／version／正文 hash 全等，完整正文 575 B。原首轮在线复验成本保留，不能只报告暖零请求。

从首轮 SDK 读取前到立即暖重复结束，objects 目录 6373 项、snapshots 目录 2557 项及各自 inventory hash 不变，对应正文对象与 snapshot manifest 的校验保持一致。这仅证明该测量区间的复用，不表示全部历史缓存缩小。仅查询同一 owned scope／identity 的 SQLite observation：基线与最终均为 1 行，原 id `d3e8b48e-8f88-4fab-8944-a0134ef59d67.json` 保持；generation 55 → 74 包含基线后的模型工作，不全部归因于此 probe。

证据根为 `/Users/yoyo/Documents/code/personal/verification-evidence/notion-skills/pro-local-loop-20261107-6wru9epq/evidence/cache-host/`：`cross-entry-warm-v7-summary.json`、`cross-entry-warm-v7-first.json`、`cross-entry-warm-v7-repeat.json`、`normal-owned-observation-before-v5.json`、`normal-owned-observation-after-v7.json`。独立 Pi 模型任务 `pi-activation-v7` 保留 `task_status=passed` 与整体 `task_passed_observation_partial`；本次 CLI／SDK 证据不能补成 observer 全覆盖，也不替代完整 Pi／模型成本矩阵。
