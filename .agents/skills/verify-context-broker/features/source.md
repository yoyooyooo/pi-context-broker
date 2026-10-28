# Source 配置、默认目录与激活

修改 sources、Notion CLI contract、host metadata 或 activation 时使用此地图。用户启用 Notion source 后，Pi/OMP 默认目录只公布勾选 `Default Context` 的 Skill；完整目录继续用于显式调用、搜索与补全。启动完成元数据注册后后台预取勾选项，预取不向会话加载指令；原生 read、`/skill:notion-ui-alpha` 或 `$ui-alpha@notion` 选择后才消费完整 snapshot 及资源。Notion 自动补全和手动搜索始终返回 `$alias@namespace`，重名时返回 `$alias@page-id@namespace`。默认使用包内 `ntn-skills`，外部前置为 Node.js 22.x 中的 22.22.3+，或 24.20.0+、官方 `ntn` 0.22.12+ 及其认证；自定义 `command` 覆盖默认入口。

## Drive

前置：Node.js 22.x 中的 22.22.3+，或 24.20.0+、仅用于构建的 Bun、Pi/OMP已安装，当前扩展可被宿主加载。先运行 `node .agents/skills/verify-context-broker/scripts/control.mjs doctor source`，再运行 `node .agents/skills/verify-context-broker/scripts/control.mjs run source`。实际入口是 `node scripts/verify-notion-integration.mjs run deterministic`，CLI executable fixture只占Notion边界，宿主、read工具、broker、provider capture都实际运行。

- `source-metadata`：首个provider请求可见原生目录name/location，正文marker为零。
- `source-native-read`：受控provider请求真实read工具读取该location，后续provider消息含完整正文。
- `source-dollar-native`：两个宿主分别提交 `$ui-alpha@notion` 并重复，再执行 host 原生命令；反向从冷原生命令切换 `$`。另由同一 runner 在 cold native 参数中加入自身 `$` 引用，确认同轮正文一份且参数完整；Pi 冷调用用 Tab，暖调用再覆盖 Tab/换行分隔。每次核对实际 provider，不因 Pi 路径仅包含正文就判通过。
- `source-resources`：host read读取导出目录的references资源，返回固定resource marker。
- `source-session`：停止RPC后print `--continue`，同一source仍可消费。
- `source-error-recovery`：fixture切换denied、malformed、timeout、duplicate，错误不能变空body成功；刷新后恢复。精确范围和证据见[联动恢复地图](../../verify-notion-skills-integration/features/session-cache-recovery.md)。
- `source-submission`：Adapter 或输入事件类型变化时，复用上述 cold native、双向 `$` 切换、资源及失败恢复；OMP 命令 handoff 和 Pi 输入 digest 分别核对，不只直接调用 Adapter。取消后的旧 handoff 不得派发 provider，也不能误取消下一条提交。后台及会话边界按下方 NS-DEFAULT 地图，实际 Stop 与草稿恢复按 loading 路径，避免另建 Adapter 验证框架。

默认目录筛选、未勾选项显式调用、后台预取、取消隔离与缓存新鲜度另按 [NS-DEFAULT-01～08](../../verify-notion-skills-integration/features/default-context-prefetch.md) 运行 `node scripts/verify-notion-integration.mjs run --mode deterministic --default-context true`。真实页与安装产物分别使用 live-fixture 与 installed，不由确定性路径推断。

真实 CLI 冷缓存、跨会话/进程复用、Notion 正文/资源修改与默认五分钟过期使用 `node scripts/verify-notion-integration.mjs run --mode live-fixture --cache-lifecycle true --database UUID --command-json '["/absolute/ntn-skills"]'`，按 [NS-SESSION-09～12](../../verify-notion-skills-integration/features/session-cache-recovery.md) 分别核对实际 Pi/OMP 终端与 Tern/OMP 菜单/胶囊。有效会话固定 A、新会话未过期复用 A、过期新会话取得 B 为不同断言；既有受控 cold/warm 不替代真实 Notion 编辑与 CLI 空缓存。

跨项目、Pi/OMP 和命令写法共用 Notion 缓存时，另执行 `node scripts/verify-notion-integration.mjs run --mode deterministic --shared-catalog true`，按[共享缓存 NS-SESSION-13～15](../../verify-notion-skills-integration/features/session-cache-recovery.md#共享-notion-缓存)检查一份 catalog/index/export、原始校验时间、共享刷新和会话 A/B 固定版本，并执行两仓 identity/TTL/隔离回归。它使用真实宿主与受控 source/provider，不代替真实 Notion 或原生菜单；菜单继续用 `verify-native-ui.mjs --catalog-cache` / `--catalog-cache-failure`。

并发发布另按 [NS-SESSION-16～21](../../verify-notion-skills-integration/features/session-cache-recovery.md#并发发布与首次正文) 运行 `node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs run --mode storage --case catalog-order,snapshot-race`，在产品修改前保留 fail-before，修复后重跑相同命令取得 pass-after。实际双宿主首次正文另运行 `run --mode hosts --case host-first-body`，负例为 `run --mode storage --case snapshot-mismatch`；同时间与时钟回退使用 `run --mode storage --case catalog-equal-time,catalog-clock-rollback`。显式 gate 确保旧 list 晚完成及两个完整 export 竞争；要求 catalog 不回退、两个 load 都成功且完整字节一致、active cache 无 losing stage，允许重复 read/export。两种 mode 均为无凭据的受控 source；hosts 实际启动 Pi/OMP 并先完成 discovery。Doctor、case selector、完整命令与独立 evidence/Trash cleanup 见所链地图。


真实 Notion 生命周期 fixture 由 CLI 发布为原生页；先验证未接受的直接编辑返回 `PUBLICATION_DIVERGED`，再用 `operation inspect-edit` 与带精确 `--expected-version` 的 `operation accept-edit` 接受自建页版本，随后验证过期刷新。不手工改发布标记、不预热三端缓存。

原生UI另运行 `node .agents/skills/verify-context-broker/scripts/control.mjs run notion-editor`。真实只读Notion运行 `node scripts/verify-notion-integration.mjs run live --database DB --skill-ref skill://PAGE/SKILL.md`；可以 `--command-json '["/absolute/ntn-skills"]'` 选安装命令。已授权独立测试页的create到archive路径见[联动Skill](../../verify-notion-skills-integration/SKILL.md)。live/model/installed均不由deterministic通过推导。

真实模型消费使用 `node scripts/verify-notion-integration.mjs run --mode model --database DB --skill-ref skill://PAGE/SKILL.md --model magpie/group/flash-free --model-prompt TEXT`，默认双宿主；`--host pi|omp` 只运行指定宿主并保留另一宿主未运行状态。选择实际包含参考资源的页，检查 metadata 无正文、模型自主读取入口与资源、内容进入 provider、HTTP 成功及非空成功 final 回复。Pi 终端补全另按[独立终端规程](../../verify-notion-skills-integration/features/dollar-completion-selection.md#pi-独立终端)验收；Tern UI runner 不覆盖 Pi。

加载界面回归另运行 `node scripts/verify-native-ui.mjs --notion-loading`。首项从原生 `$` 补全接受 cold Skill，等待 65 秒，跨过已移除的 60 秒命令总时限；断言 Enter 立即开始 preparation、原生 running/Stop 可见、草稿可编辑，期间 Enter 不二次提交。provider 前会话显示唯一持久 `Read ntn-skills://<alias>` 记录，目标没有 namespace 前缀，展开/收起详情后，done 或 error 终态均保留。首个 provider 请求必须含原 prompt 与完整正文 canary 一份；随后单独提交编辑后的 draft 并核对顺序。覆盖暖读取、受控 4 秒 cold `/skill:`、36 秒单请求失败 `NTN_UNAVAILABLE` 后恢复、Escape 与真实 native Stop 取消及重试；Stop 使用 32 秒受控读取。长 CLI 场景验证 Broker 无总时限，单次网络预算另由 CLI transport 测试验证，不把受控等待解释成真实 Notion HTTP。覆盖模型真实 `read skill://`，以及同 pane 精确 JSONL 会话 quit/resume。图片与 session switch 另由 RPC 验证，不计为 UI 覆盖。用 `BROKER_UI_EXTENSION=/absolute/installed/pi-context-broker/src/index.ts` 可验证已安装扩展入口，source/provider 仍是隔离 fixture。完整步骤与证据边界见[激活快照地图](../../verify-notion-skills-integration/features/activation-snapshot-resources.md)。

依赖故障另运行 `bun run test:source-dependencies`：双宿主实际启动，覆盖缺 source command、缺 `ntn`、版本过低、缺 `--notion-version` 和未认证；普通聊天、本地与正常 source 继续，选择不可用 source 时不发 provider，修复 command 后 refresh 恢复。`node scripts/verify-native-ui.mjs --source-dependencies` 覆盖真实 Tern/OMP 启动提示、普通聊天、本地自动补全、失败 namespace 中未知引用原样透传，以及真实 Tab 接受另一 source 的已知候选后 read 失败阻断 provider；手动 picker 继续可用。`node scripts/verify-artifacts.mjs` 在独立生产安装上重跑双宿主依赖场景，并检查 npm/Tern query 随附的 CLI 与 notices；CLI fixture 不证明远端认证成功。

## Evidence 与清理

runner输出独立 `/tmp/broker-notion-evidence-*`，manifest记录mode、各host分支和未运行入口；provider/RPC/decision transcripts保留，scratch在另一个目录。`node scripts/verify-notion-integration.mjs evidence --evidence /absolute/run` 核对通过和文件存在；`cleanup --evidence /absolute/run` 只将ownership证明属于本次的scratch移入系统Trash，不删除证据。control自身证据再用 `control.mjs evidence /absolute/control-run` 核对。

## 证明边界

仅metadata stub不等于正文；read工具返回不等于模型理解；$注入不等于默认目录或native命令；本地fixture不等于远端Notion认证。任何分支失败或未运行须如实报告，不用已有会话旧正文、手写方法调用或其他宿主结果冒充该入口。

## AH258–260 shared content acceptance

Shared CLI boundary accepts records only and read/export record plus entrypoint. Validate JSON tuple identity [sourceId,sourceScope,kind,locator.type,id], canonical typed locator, fixed snapshot/version/scope, portable v2 kind/main and full inventory. Reject malformed/legacy wire and mismatch without fallback. Subscription refs encode upstream:UUID and never act as content page UUID.

No execution is claimed by this map update; final owner runs and retains the evidence.

