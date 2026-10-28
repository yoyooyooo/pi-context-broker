# 美元补全与选择

前置条件：双宿主 extension 与 fixture source 可用。UI 另需真实 Tern + OMP、脚本要求的平台与 Tern 登录；操作本次自建 control endpoint。UI 使用 fixture，不访问 live Notion。

UI fixture 原生 Skill 命令为 `/skill:notion-ui-alpha`。真实远端消费另用 `node scripts/verify-notion-integration.mjs doctor --mode live-fixture --database UUID` 与 `node scripts/verify-notion-integration.mjs run --mode live-fixture --database UUID`；创建唯一页及 `references/guide.md`，finally 仅 archive 本次页与 child pages，GET 回执。该 mode 不证明 Tern UI；只读 live 不替代真实 fixture 端到端。

deterministic/installed 对 Notion 与 filesystem source 均执行 `$` 消费；重名 fixture 提交歧义 `$ui-alpha@notion` 必须无 provider 请求（计数 0），再分别调用两个 qualified native，捕获独立 page body。审阅 `*-duplicates-rpc.json` 与各 provider；不能把歧义拒绝算成整体 run 失败，也不能把错误目标正文算成成功选择。远端 live-fixture 可按 SKILL 中的 `--resume-evidence` 归属/canary 校验恢复，不重新 create。

所有 Notion 候选始终使用 `$alias@namespace`，默认如 `$ui-alpha@notion`，无冲突条目也遵循该格式。同一 source 的 alias 重名时使用 `$alias@page-id@namespace`。本地 Skill/Bundle 与 source 同名时，本地使用 `$name@local`；filesystem source 内部重名保留 canonical token 的路径消歧。裸名存在歧义时仍拒绝。`bun run check` 验证自动补全与独立 query 的引用实际注入所选本地/source 正文且不串选，覆盖无冲突 Notion、同库重名、自定义 namespace、Bundle、未知后缀及 namespace 为 local。`node scripts/verify-native-ui.mjs --name-collision` 在自建 Tern/OMP 中依次接受本地胶囊、提交本地正文且 source 无 read/export、接受 Notion 胶囊并提交远端 fixture 正文，再提交裸名，要求无新增 provider 请求且错误含 `ambiguous` 和两种完整引用。证据为 `collision-result.json`、provider/source calls、`collision-*` 截图及 cleanup 回执；fixture 不证明真实 Notion 网络。

本地 `skillRoots` 按配置顺序、规范化 Skill 名称保留首个命中项，后置源码副本和 system-prompt fallback 不得重新引入同名候选。`bun run check` 的 local-token 回归交换两个 roots，检查补全、普通 `$name`、已有 `$name@local` 与 `skill:` 均消费当前首项正文，并保留独立 filesystem source 的选择身份；`$` 后有空格的错误说明保持普通文字。真实双宿主的配置规则与 `@local` 提交见[注入地图](../../verify-context-broker/features/injection.md)。

Source id 与 namespace 内部的点必须在提交中保留。`bun run check` 还覆盖 `$ui-alpha@team.prod.` 的候选选择与正文注入：解析保留 `team.prod`，去除末尾句号。

Upstream Skill 目录携带可选 `upstream: {repo}` 时，下拉与手动搜索显示 `repo/skill name [skill]`，详情保留完整调用引用。`repo` 取 Notion Upstream 订阅 `Name` 按既有规则生成的 alias，例如 `Pstack` → `pstack`、`Matt` → `matt`；仓库 URL、registry slug 和源子目录不决定此前缀，不需要新增 Notion 字段。输入 `$pstack/` 浏览该订阅成员，输入 `$pstack/cor` 缩小范围；其他订阅的描述提到该前缀也不能混入。接受候选仍插入 `$alias@namespace`，同库重名保留 page ID；显示标签不能成为身份或读取目标。

运行 `node scripts/verify-native-ui.mjs --upstream-labels` 验证 Tern/OMP 原生订阅列表、成员前缀过滤、Tab、Unicode 手动替换、选择零 provider 增量与所选正文一份；审阅 `upstream-result.json`、`upstream-namespace-*` 等截图与 cleanup。运行 `node scripts/verify-pi-pty.mjs run --upstream-labels` 独立验证 Pi 终端订阅成员前缀、精确草稿和双向 native 切换，保留两个冷会话的终端流与退出回执。`bun run check` 还验证重复成员的精确 page selector，以及升级后不复用带旧仓库前缀的 version-1 index。已有 OMP 会话必须 `/restart` 才会加载新代码，普通目录 refresh 不替代重启。两条 UI 路径均使用受控 source/provider，不证明日常安装、真实 Notion 或模型效果。

| ID | 用户入口与动作 | 可观察 assertion |
| --- | --- | --- |
| NS-SELECT-01 | 用户输入 `$` 与目标名称前缀请求候选 | 发现的 Notion Skill 出现在候选，名称、说明与目标标识正确；候选出现不等于正文激活。 |
| NS-SELECT-02 | 用户选中目标并提交 `$` 引用 | 接受的引用解析到所选 URI，真实 provider 收到对应正文；重名 fixture 不串选。 |
| NS-SELECT-03 | 用户重复提交同一 `$` 引用，在 `$` 与原生 `/skill:` 之间双向切换，或在原生命令参数中引用同一 `$` | 两个宿主分别核对 decisions 与 provider 当前上下文，同一快照均保持一份正文；原生命令参数完整到达 provider。Pi 不得仅断言包含正文。历史正文保留不误报为新注入，重复和切换不新增 loaded 回执。 |
| NS-SELECT-04 | 在真实 Tern/OMP 编辑器输入、选择并提交 Notion 候选 | 原生界面实际出现候选并接受选择，提交后 provider 捕获匹配目标正文；截图必须与操作及请求证据对应。 |
| NS-SELECT-05 | 目录观察仍在 CLI `list` TTL 内时输入 `$` | 立即显示该缓存目录，不发起新的 discovery refresh。 |
| NS-SELECT-06 | 目录观察超过 TTL 后输入 `$`，或刷新失败 | 先显示上一份缓存并运行一次后台刷新。partial 菜单保留 identity 位置；强制文件补全保留当前选择，下一次查询使用新目录。暂时性失败显示原因并保留旧候选，5 秒内不重复请求；认证/权限/scope 失败撤下旧 source 候选。`discovery.offline` 不访问网络。 |

```bash
node scripts/verify-notion-integration.mjs doctor --mode deterministic
node scripts/verify-notion-integration.mjs run --mode deterministic
node scripts/verify-native-ui.mjs --notion
node scripts/verify-native-ui.mjs --catalog-cache
node scripts/verify-native-ui.mjs --catalog-cache-failure
```

前两条通过主 harness 覆盖双宿主消费，其余命令专门覆盖真实原生 UI。`--catalog-cache` 另验证新进程从过期磁盘 index 先显示候选、六秒延迟刷新期间选择不变、Tab 零 provider 增量、提交正文一份和下一次查询采用新目录。`--catalog-cache-failure` 使用同一过期 index，在新进程首次只输入一个 `$`；远端完成前必须出现缓存候选，后台 `NOTION_REQUEST_FAILED` 可见但不清空候选，Tab 和提交仍读取所选正文，下一次查询仍可用缓存。该分支回执须为 `refreshFailurePreservesCached: true`、`nextQueryUsesRefresh: false`。审阅 `catalog-cache-result.json`、`catalog-cached-choice`/`catalog-refreshed-choice`/`catalog-next-query` 截图及 cleanup。不能把直接构造 `$` prompt 当成 UI 选择通过，也不能把 UI fixture 称为 live 验证。

主 harness 证据看 manifest、两个宿主的 provider/decisions jsonl 与 rpc JSON；UI 审阅其实际输出的操作记录、截图与 provider 证据，不假设未留存的产物存在。failed、取消导致未提交、未运行或无 provider 证据不记 pass。

## 目录新鲜度

NS-SELECT-05 与 NS-SELECT-06 来自 CLI `list` 原始 `validated_at`、`age_ms`、`max_age_ms` 和 `stale`；新进程不能重置年龄。默认目录 TTL 为 60 秒。`ctl cache identity --database SELECTOR` 的本地凭据/远端目录摘要标识共享持久 index；等价 database selector、不同 cwd、Pi/OMP、source 标签和命令写法共用目录，身份或远端查询范围变化才隔离。自定义 command 不支持该能力时正常 list。`packages/context-broker/scripts/catalog-cache.test.ts` 覆盖独立冷/暖进程、跨项目/宿主/命令复用、当前策略 TTL、共享刷新、凭据隔离和损坏重建；实际双宿主投递沿[共享缓存地图](session-cache-recovery.md#共享-notion-缓存)执行。`catalog-menu.test.ts` 覆盖缓存先出现、提示行不可接受和同菜单刷新。正文仍按激活策略校验 scope 和固定快照。确定性双宿主与 fixture UI 不证明真实 Notion TTL；checkout 验证不代表另一份日常安装。

`list` 必须返回 `records`，且响应里不能有 `skills`。带 `skills` 的整表会被拒绝，页面存在也不会出现在 `$`。2026-10-19 的日常入口曾因此看不到 `resin`；该页 id 是 `3fb5636c-236e-814e-8f88-e4e8e00f051a`，引用是 `skill://3fb5636c-236e-814e-8f88-e4e8e00f051a/SKILL.md`。

## Pi 独立终端
自动化入口（真实终端，受控 source/provider）：

```bash
node scripts/verify-pi-pty.mjs --help
node scripts/verify-pi-pty.mjs doctor
node scripts/verify-pi-pty.mjs run --evidence-root /absolute/review-evidence
node scripts/verify-pi-pty.mjs evidence --evidence /absolute/broker-pi-evidence-DIR
node scripts/verify-pi-pty.mjs cleanup --evidence /absolute/broker-pi-evidence-DIR
node scripts/verify-pi-pty.mjs evidence --evidence /absolute/broker-pi-evidence-DIR
```

可在 doctor/run 附加 `--extension /absolute/installed/broker-entry`。Doctor 记录实际 Pi 入口/版本、extension hash，核对 Pi 广告的 TUI flags 及 Python stdlib PTY；缺少能力时报 blocked。run 使用既有无凭据 Notion executable fixture（`ui-alpha` / `$ui-alpha@notion` / `/skill:notion-ui-alpha`），两个冷会话分别 `$→native→$`、`native→$`。每步保留实际按键、raw byte offsets、原始 `.ansi` 与 `.screen.json`；stdlib VT 字符栅格从完整流处理 UTF-8、光标、擦除和滚动，当前编辑框前缀与其下选中候选行必须同时匹配后才发 Tab，随后编辑框必须恰为规范引用。启动 `[Skills]`、历史正文或候选中的 token 不能证明草稿已接受。未完成的同步帧、未知控制序列或缺失编辑框均拒绝成功；失败保留 `failure.screen.json`。当前 provider messages 正文恰好一份、system catalog 零正文。字符栅格是原始终端流的投影，非原生截图。各分支 `cleanup.json` 与 `driver-exit.json` 来自实际 wait/returncode，强制终止单列；失败证据保留并重跑 Doctor。该入口不访问真实 Notion/模型，不证明后续父子斜杠补全、Stop/取消或跨机器。

首次输入前必须同时观察两项：当前完整终端帧的空编辑框、fake footer、`[Skills]` 下精确 `notion-ui-alpha` 和其后的非空 `[Extensions]`；本次 source 的确切 list/read 参数与 `export phase=completed`，以及 broker 将 staging export 验证并原子发布后的 `.broker-snapshot.json` 和三份 fixture 文件 bytes/hash。只看到空编辑框/model 的早期帧不算 ready。宿主在绑定扩展、`session_start`、`resources_discover` 并设置 autocomplete 后才显示这些资源节；不把所有后台启动活动均已结束作为结论。`source-readiness.json`、ready action 中的 source receipt 与 `source-cli-calls.jsonl` 一起保留；不等待 staging 路径继续存在，也不加固定 sleep。后续真实 prefix/Tab/Enter 与候选、草稿、正文计数断言不变。

Scratch、host cwd、HOME 和 `TMPDIR` 固定在系统临时根（macOS `/private/tmp`，其他 POSIX `/tmp`），运行前确认该根及其祖先均无 `.agents`；不继承外部 `TMPDIR` 将 cwd 放入用户目录。`--evidence-root` 独立控制证据父目录，可放控制根而不会改变 host cwd/TMPDIR 或扫描日常 Skills。cleanup 校验系统根、前缀和 ownership 后以实际绝对路径 `/usr/bin/trash` 回收自有 scratch；不改用户技能和旧证据。


现有 `verify-native-ui.mjs --notion` 只启动 Tern/OMP。Pi 必须另用真实终端或自建 PTY 启动实际 `pi`，不能把 RPC prompt 或 Tern 截图当作 Pi UI 通过。用 Node.js 22.x 中的 22.22.3+ 或 24.20.0+ 启动 harness；不要用宿主编译二进制的 `process.execPath` 代替 Node。

Adapter 装配变化时用现有 `writeFakeProvider` 配合隔离 filesystem source 即可验证终端，不必访问真实 Notion。为覆盖目录与协议分离，可在显式 config/agentDir 下设置 `CONTEXT_BROKER_HOST=omp`；实际 Pi 仍须显示 Pi 候选、接受普通文本引用并完成提交。真实 Notion 与模型效果继续按各自 mode 单独取证。只读历史终端证据不能代替本次编辑器改动后的实际动作。

1. 在独立临时目录准备 broker source config、cache、sessions；用 `--no-extensions --no-mcp --no-context-files --no-prompt-templates --approve --offline --tui-mode regular --session-dir <本次目录>`，显式 `-e <broker/src/index.ts>`。`--approve` 只信任本次自建 fixture，`--offline` 关闭宿主启动联网；两者不授予真实模型或 Notion 写入权限。受控消费复用 `context-broker-e2e-fixture.mjs` 的 `writeFakeProvider`，再 `-e <返回文件> --provider context-broker-e2e --model fake`，捕获路径为 `CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE`。仅记录无凭据 source 配置，不复制用户认证。
2. 自建 PTY 可用 Python `pty.openpty()`，先设 `TIOCSWINSZ`，将 slave 接到 Node 启动器的 stdin/stdout/stderr；master 用 `os.write` 发送实际字符、Tab (`\t`) 与 Enter (`\r`)，用 `select` 持续读取。`spawnHost` 可沿用现有真实入口解析，fixture HOME 不直接运行 Volta shim。输入先只发前缀并观察候选；会自动附加换行的进程输入接口不能用于证明接受前的候选。不要把原始 stdin 转发给模型当作终端验收。
3. 输入 `$` 与目标前缀，观察实际候选；按 Tab 接受后核对草稿中的规范引用（例如 filesystem source 的 `$fs/arg-skill` 或 Notion 的 `$alias@namespace`），再追加任务并 Enter。保存候选、接受后的草稿和提交结果画面。
4. 输入 `/skill:` 与该条目的 qualified 原生名前缀，观察原生候选并按 Tab 接受、Enter 提交；另起独立冷会话验证首次原生调用再切换 `$`。两次冷会话的 provider 分别核对 `$`→native→`$` 和 native→`$`；每次目标正文一份，system catalog 无正文。两个方向均不能由同一暖会话推断。
5. UI 可用受控 provider 验证选中与投递；真实模型使用本轮授权 `magpie/group/e2e`，只通过测试会话 argv/config selector，不修改全局模型。检查冷 `$` 介绍直接响应、没有为加载身份重复读取入口，并按 `host-skill-discovery-read.md` 的 model route 验证必要资源。受控 `OK` 不证明模型使用指令。
6. 保留原始终端转义序列、实际按键动作、候选/接受/提交画面、provider 捕获、逐次正文计数与退出回执。PNG 若由捕获字符栅格渲染须明示；处理 UTF-8 与终端控制序列，不把源码或手工重写画面充作证据。空草稿 Ctrl+D 正常退出后等待 launcher 和宿主关闭，主动终止另记。仅终止持有的进程，禁止 `pkill`、按名称批量清理。缺少 PTY 能力时报告该入口未运行，不能反复试运行其他模型或弱化断言。

该规程不声称某次 Pi 日常安装已经通过；隔离 checkout 验收与实际安装配置分别报告。

主 harness 证据命令为 `node scripts/verify-notion-integration.mjs evidence --evidence /absolute/evidenceDIR`；审阅后调用 `cleanup --evidence /absolute/evidenceDIR` 并再次 evidence。只把关联的独立 `/tmp` scratch 移入系统 Trash，保留 evidence；不把 UI 的其他目录冒充主 harness evidence。本文未执行命令。

## AH258–260 shared content acceptance

Require the same candidate identity/kind/source/ref in Pi, OMP and detached completion v1. Keep UTF-16 edit ranges, original draft and image attachments; accepting a Skill/Router/Prompt candidate changes only the draft. Retain every same-name identity and use exact source selectors; never derive identity from labels.

No execution is claimed by this map update; final owner runs and retains the evidence.

## Missing-reference regression route

Run the existing deterministic/installed dual-host routes and each affected native/terminal surface with owned fixtures. Submit literal `$bunfs/root/chunks/cli-nxfh2cp0.js`, unknown bare alias, `$unknown@notion`, `$unknown@unknown-source` and `$unknown-source/unknown`, alone then mixed with valid Skill/Prompt/Router references and a real image. Repeat in a second round with changed task material. Require exact original text/images, no missing-reference toast/error/abort, one provider dispatch per accepted round and one preparation per valid identity per round. Skill/Router deduplicate active bodies; Prompt contributes the current round's full task requirements again; Router does not load unselected members.

Source-call evidence must show no read/export for metadata misses and no source fallback. Include an unmatched reference in a deliberately failed source's namespace, alone and mixed: it must remain literal and allow other valid records to proceed. A selected target's typed not-found may have its attempted read, but no export, and must pass through literally. Keep ambiguity and genuine failures while activating a selected known record (unavailable source, permission/network, incomplete-catalog and integrity) blocking. During delayed valid preparation, cancel or change conversation through supported public actions, await late completion and require zero late dispatch, then successfully submit the next editable draft. Preserve bootstrap/escaped/fenced-example guards. Record per-host/per-surface provider deltas, source calls, images, actions/screenshots and cancellation/session receipts; mark unavailable actions blocked, not passed. These additions claim no execution and do not alter frozen verdicts below.

## Tern terminal frozen recipes

`node scripts/verify-tern-surfaces.mjs run --surface pi-terminal --spec /absolute/pi-owned-run.json` and `--surface omp-terminal --spec /absolute/omp-terminal-owned-run.json` are separate real Tern terminal paths. They reuse AH255 `isolatedEnv`, `resolveHost`, process-group ledger and public Tern ctl, not the standalone Pi PTY result. Run spec and exact scenario semantics: control `ah275/harness.md`; shared native/terminal evidence rules: [editor map](../../verify-context-broker/features/editor.md#frozen-ah266267275-three-surface-driver).

For each terminal, first observe the actual host startup and ANSI grid with native editor absent. Type only an owned fixture candidate prefix, capture current menu showing Kind/source, press Tab, capture the accepted current input line and zero new request count, then append natural task and Enter. Repeat Prompt with different material in the same session; compare newest user/request markers rather than counting historical Prompt messages as new activation. Router request must contain entry metadata but zero unselected member-body marker; mixed input preserves user Unicode and a real image.
These terminal recipes use `serve` only as observed grid transport; they do not cover companion/window VM. OMP terminal selects `PI_TUI_NATIVE=0` and proves actual grid/native-editor absence; Pi uses its actual terminal renderer contract, never inferred OMP semantics. Explicit spec `hostBinary`, `hostSha256`, `ternBinary`, `model`, `scope` and artifact hashes bind the real fixture entries without depending on a daily install. Native companion acceptance uses the owned window recipe in the editor map.

Parent slash recipe types `/ntn-skills ` then chooses sync→upstream/local→status/check/run and actual owned target metadata one level at a time. Capture every parent without submitting; no `--all` is inferred. Direct `ctl status`/`read` returns actual receipt with zero provider delta. Save uses the current Agent and owned destination receipt, one task, then independent real CLI readback and refreshed `$` consumption. Unknown writes retain operation/reconcile evidence supplied by E2E; no hardcoded target IDs.

Cancellation recipe starts owned delayed preparation, presses Esc/Stop, changes pane/cwd/host conversation through public UI, waits beyond source completion and proves zero late provider delta, editable draft and successful next submit. Without an actual delayed source or supported public session action mark that scenario `blocked`. Pi terminal does not inherit OMP capsule semantics; plain token delete/undo is recorded separately from native atomic capsule delete/undo. Image ingestion uses observed public attachment/drop/dialog capability with the generated `attachment.png`; absence is a real gate.

