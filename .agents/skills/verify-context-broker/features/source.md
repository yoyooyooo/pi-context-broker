# Source 配置、默认目录与激活

修改 sources、Notion CLI contract、host metadata 或 activation 时使用此地图。Notion 默认目录公布当前 View 的 Skill/Router，Profile 及选择优先级见[默认目录地图](../../verify-notion-skills-integration/features/default-context-prefetch.md)；完整目录继续用于显式调用、搜索与补全。Pi 默认使用 SDK 发现和消费，日常工具为 notion_list/read/notion_use，本地 Skill 保留原生读取；OMP 与显式 custom command 保留兼容 CLI 路线。预取默认零预算，只有显式有界预算才预热，且不向会话投递指令。read 检查所请求内容，use、`/skill:` 或 `$` 才准备所选根与完整 Requires，资源按需读取。复制实际宿主公布的名称、来源和准确引用，不把 OMP 的 notion-* alias 当 Pi 显示名。外部前置为 Node.js 22.x 中的 22.22.3+，或 24.20.0+及项目自己的有效 Notion token；自定义 command 不作为默认 SDK 失败的静默回退。

文中 `SKILL_REF` 从本次 CLI 回执的 `record.ref` 原样取得；共享身份的编码与物理定位区别见下方 shared content 合同，不从 page UUID 或显示名重拼。

## Drive

前置：Node.js 22.x 中的 22.22.3+，或 24.20.0+、仅用于构建的 Bun、Pi/OMP已安装，当前扩展可被宿主加载。先运行 `node .agents/skills/verify-context-broker/scripts/control.mjs doctor source`，再运行 `node .agents/skills/verify-context-broker/scripts/control.mjs run source`。实际入口是 `node scripts/verify-notion-integration.mjs run deterministic`，CLI executable fixture只占Notion边界，宿主、read工具、broker、provider capture都实际运行。

Pi 的 pending/unavailable 目录断言位于最终公开 `context_with_system` 边界；`before_agent_start` 不再返回强制整段系统提示。常规 package check 中的 `input-guard.test.ts` 分别检查早期事件立即返回、最终系统 section 投影立即返回、错误来源准确可见与正文读取为零；OMP 原事件合同另测。实际安装的两版 Pi、完整默认目录、原生本地 Skill/工具保留及 HTTP serializer 证明继续复用[安装地图](../../verify-notion-skills-integration/features/installed-consumption.md#catalog-projection-after-explicit-preflight)的原 SDK driver，不用这里的直接事件测试替代实驱。2026-11-05 的 CI 42119481764 和本地 `sc06-catalog-projection-soeu76qa/guard-caller/fail-before.*` 保留了旧事件断言失败；后续通过不改写它们。

- `source-metadata`：首个provider请求可见原生目录name/location，正文marker为零。
- `source-native-read`：受控provider请求真实read工具读取该location，后续provider消息含完整正文。
- `source-dollar-native`：两个宿主分别提交 `$ui-alpha@notion` 并重复，再执行 host 原生命令；反向从冷原生命令切换 `$`。另由同一 runner 在 cold native 参数中加入自身 `$` 引用，确认同轮正文一份且参数完整；Pi 冷调用用 Tab，暖调用再覆盖 Tab/换行分隔。每次核对实际 provider，不因 Pi 路径仅包含正文就判通过。
- `source-resources`：Pi 从实际交付目录取得固定资源 ref，OMP 保留实际目录路径读取；两者返回完整固定 resource marker，不从会话 sr: 句柄拼接文件路径。
- `source-session`：停止RPC后print `--continue`，同一source仍可消费。
- `source-error-recovery`：fixture切换denied、malformed、timeout、duplicate，错误不能变空body成功；刷新后恢复。精确范围和证据见[联动恢复地图](../../verify-notion-skills-integration/features/session-cache-recovery.md)。
- `source-submission`：Adapter 或输入事件类型变化时，复用上述 cold native、双向 `$` 切换、资源及失败恢复；OMP 命令 handoff 和 Pi 输入 digest 分别核对，不只直接调用 Adapter。取消后的旧 handoff 不得派发 provider，也不能误取消下一条提交。后台及会话边界按下方 NS-DEFAULT 地图，实际 Stop 与草稿恢复按 loading 路径，避免另建 Adapter 验证框架。

### Pi read 的公开 schema 与执行前校验

Pi `read` 的参数保持顶层 `type: object`，不能用顶层 `oneOf`、`anyOf`、`allOf`、`enum`、`const` 或 `not` 表示标量与批量分支；实际 provider 曾在任何工具调用前拒绝该 schema。公开 `path` 保留原生 `offset`/`limit`、图片、进度回调与原生结果；`paths` 继续只读取同 owner、同固定 snapshot 的资源。两者互斥、批量不得带标量选项、数量及成员类型在 adapter 进入共享 preparation/原生 I/O 前校验；owner、权限、pin 与取消仍由原共享读取层校验，不自动修补坏引用或改为 use。

原入口 `bun test packages/context-broker/scripts/pi-read-adapter.test.ts packages/context-broker/scripts/scalar-resource-read-host.test.ts packages/context-broker/scripts/resource-read-host.test.ts` 同时检查公开 schema 和实际 execute 拒绝，并保留原生设置/图片/完整字段、固定资源、跨 scope、分支及取消的回归。这三个文件仍在 package 的 `test:consumption` 中。原 `scripts/notion-sdk-pi.mjs` 的 schema 报告仅证明顶层 object、公开 path/paths、标量 range 选项及引用 guidance，明确 `validation_boundary: tool_execute`；不再由 schema 推断互斥或批量选项已被执行验证。实际安装/provider 继续用该 driver 的 native、resource-scalar、resource-batch 与 Code mode 场景；schema 静态通过不替代新安装包和真实 provider 接受。

2026-11-06 原模型失败保留于 `~/Library/Logs/pi-context-broker/AH-617-20261105/sc21-c8-ab-7112-7fscsgto/evidence/graph-model-A-m8TE03/` 的 `provider-requests/payload-19.json`、`pi-rpc.json`；HTTP 200 不能覆盖其中的 schema error。对应修复证据为 `~/Library/Logs/pi-context-broker/AH-617-20261105/read-schema-compat-6pv7x5n9/`：原 adapter 回归 5 PASS / 2 FAIL，修复后的上述三组 27 PASS；旧 SDK schema oracle 对新形状的 1 FAIL 原件单列，迁移后原 `node --test scripts/notion-sdk-pi.test.mjs` 120 PASS，TypeScript 检查通过。此处未重建 C8、未重跑模型或真实源，不宣称新产物实模已通过。

修复由 `f1a4f87` 形成独立 C9，归档 SHA `b4ed4cf1240db15b47e831096a848b6b6656f0764bca9c3f3bb2fe63ae4602a8`。原 CI `42202814091` 的同字节包在 Pi1.5/1.4 各17景通过，实际 provider 与 HTTP serializer 都带顶层 flat object；Pro/Mini 各原 live SDK 冷路径也通过目录、根/Requires、固定资源和续聊，实际来源账本见[安装地图](../../verify-notion-skills-integration/features/installed-consumption.md)。随后 C9 A 首实际模型请求29,582 B返回两次 `notion_list`，确认该次整份工具 schema 已被远端接受；`read` 本身尚未被模型调用。之后默认 Router 描述见证的观察器异常阻断第二次发送，原 A failed/B not_run 保留；根因与原回归见[图模型地图](../../verify-notion-skills-integration/features/skill-dependency-graph.md)，不能据 schema 接受宣布任务完成。

默认目录解析与会话 View 选择按[默认目录地图](../../verify-notion-skills-integration/features/default-context-prefetch.md)运行 `node scripts/verify-notion-integration.mjs run --mode deterministic --view-discovery true`。旧 `--default-context true` 通过 View 的 checkbox 筛选运行预取、取消隔离与新鲜度 fixture，checkbox 不是独立全局门禁。这些受控路径不证明真实 Profile 机器绑定；真实页与安装产物分别使用 live-fixture 与 installed，不由确定性路径推断。

真实 CLI 冷缓存、跨会话/进程复用、Notion 正文/资源修改与默认五分钟过期使用 `node scripts/verify-notion-integration.mjs run --mode live-fixture --cache-lifecycle true --database UUID --command-json '["/absolute/ntn-skills"]'`，按 [NS-SESSION-09～12](../../verify-notion-skills-integration/features/session-cache-recovery.md) 分别核对实际 Pi/OMP 终端与 Tern/OMP 菜单/胶囊。有效会话固定 A、新会话未过期复用 A、过期新会话取得 B 为不同断言；既有受控 cold/warm 不替代真实 Notion 编辑与 CLI 空缓存。

跨项目、Pi/OMP 和命令写法共用 Notion 缓存时，另执行 `node scripts/verify-notion-integration.mjs run --mode deterministic --shared-catalog true`，按[共享缓存 NS-SESSION-13～15](../../verify-notion-skills-integration/features/session-cache-recovery.md#共享-notion-缓存)检查一份 catalog/index/export、原始校验时间、共享刷新和会话 A/B 固定版本，并执行两仓 identity/TTL/隔离回归。它使用真实宿主与受控 source/provider，不代替真实 Notion 或原生菜单；菜单继续用 `verify-native-ui.mjs --catalog-cache` / `--catalog-cache-failure`。

并发发布另按 [NS-SESSION-16～21](../../verify-notion-skills-integration/features/session-cache-recovery.md#并发发布与首次正文) 运行 `node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs run --mode storage --case catalog-order,snapshot-race`，在产品修改前保留 fail-before，修复后重跑相同命令取得 pass-after。实际双宿主首次正文另运行 `run --mode hosts --case host-first-body`，负例为 `run --mode storage --case snapshot-mismatch`；同时间与时钟回退使用 `run --mode storage --case catalog-equal-time,catalog-clock-rollback`。显式 gate 确保旧 list 晚完成及两个完整 export 竞争；要求 catalog 不回退、两个 load 都成功且完整字节一致、active cache 无 losing stage，允许重复 read/export。两种 mode 均为无凭据的受控 source；hosts 实际启动 Pi/OMP 并先完成 discovery。Doctor、case selector、完整命令与独立 evidence/Trash cleanup 见所链地图。


真实 Notion 生命周期 fixture 由 CLI 发布为原生页；先验证未接受的直接编辑返回 `PUBLICATION_DIVERGED`，再用 `operation inspect-edit` 与带精确 `--expected-version` 的 `operation accept-edit` 接受自建页版本，随后验证过期刷新。不手工改发布标记、不预热三端缓存。

原生UI另运行 `node .agents/skills/verify-context-broker/scripts/control.mjs run notion-editor`。真实只读Notion运行 `node scripts/verify-notion-integration.mjs run live --database DB --skill-ref "$SKILL_REF"`；可以 `--command-json '["/absolute/ntn-skills"]'` 选安装命令。已授权独立测试页的create到archive路径见[联动Skill](../../verify-notion-skills-integration/SKILL.md)。live/model/installed均不由deterministic通过推导。

真实模型消费使用 `node scripts/verify-notion-integration.mjs run --mode model --database DB --skill-ref "$SKILL_REF" --model magpie/group/flash-free --model-prompt TEXT`，默认双宿主；`--host pi|omp` 只运行指定宿主并保留另一宿主未运行状态。选择实际包含参考资源的页，检查 metadata 无正文、模型自主读取入口与资源、内容进入 provider、HTTP 成功及非空成功 final 回复。Pi 终端补全另按[独立终端规程](../../verify-notion-skills-integration/features/dollar-completion-selection.md#pi-独立终端)验收；Tern UI runner 不覆盖 Pi。

加载界面回归另运行 `node scripts/verify-native-ui.mjs --notion-loading`。首项从原生 `$` 补全接受 cold Skill，等待 65 秒，跨过已移除的 60 秒命令总时限；断言 Enter 立即开始 preparation、原生 running/Stop 可见、草稿可编辑，期间 Enter 不二次提交。provider 前会话显示唯一持久 `Read ntn-skills://<alias>` 记录，目标没有 namespace 前缀，展开/收起详情后，done 或 error 终态均保留。首个 provider 请求必须含原 prompt 与完整正文 canary 一份；随后单独提交编辑后的 draft 并核对顺序。覆盖暖读取、受控 4 秒 cold `/skill:`、36 秒单请求失败 `NOTION_UNAVAILABLE` 后恢复、Escape 与真实 native Stop 取消及重试；Stop 使用 32 秒受控读取。长 CLI 场景验证 Broker 无总时限，单次网络预算另由 CLI transport 测试验证，不把受控等待解释成真实 Notion HTTP。覆盖受控 provider 发起的真实工具 `read skill://`，以及同 pane 精确 JSONL 会话 quit/resume。图片与 session switch 另由 RPC 验证，不计为 UI 覆盖。用 `BROKER_UI_EXTENSION=/absolute/installed/pi-context-broker/src/index.ts` 可验证已安装扩展入口，source/provider 仍是隔离 fixture。完整步骤与证据边界见[激活快照地图](../../verify-notion-skills-integration/features/activation-snapshot-resources.md)。

依赖故障另运行 `bun run test:source-dependencies`，或用 `node scripts/verify-source-dependencies.mjs --host pi` 单列 Pi：实际宿主覆盖缺 source command、API 不可达、正常 list 入口的不兼容目录结构、非 JSON 输出和未认证。普通聊天、本地与正常 source 继续，失败 namespace 中未知字面引用仍派发且不读正文；修复 command 后 refresh 恢复。不兼容目录由真实 list 返回带禁止旧 `skills` 字段的完整结构，实际 decoder 必须拒绝；同进程只移除该字段后 refresh/doctor 必须恢复，保留正反例与实际 argv。显式 custom command 不承诺实现 bundled CLI 的 doctor，所以不能用它冒充默认协议探测。默认 SDK/CLI 版本和文件字节错配另由安装边界与 SDK 负例验证。`node scripts/verify-native-ui.mjs --source-dependencies` 覆盖真实 Tern/OMP 启动提示、普通聊天、本地自动补全、失败 namespace 中未知引用原样透传，以及真实 Tab 接受另一 source 的已知候选后 read 失败阻断 provider；手动 picker 继续可用。`node scripts/verify-artifacts.mjs --host pi` 在独立生产安装上重跑 Pi 依赖场景并检查随附 CLI/SDK identity；OMP/Tern 用独立 `--host omp` 结果。CLI fixture 不证明远端认证成功。

## Evidence 与清理

### SC23 管理调用与写后目录刷新

原 `view-discovery.test.ts` 通过真实受控 CLI 子进程核对 `listNotionViews` 发出的 `ctl views --database …` 及 discovery policy；实际宿主入口继续复用 `--view-discovery true` 的 `/context-broker views`，不能用函数级成功冒充安装态菜单。fixture 同一实现接受旧 alias，但 ledger 保留调用时的 command/args，不能把规范化后的名字当已迁移证据。

原 `cli-write-invalidation.test.ts` 覆盖新的 `ctl operation resume`、`ctl sync upstream/local` 和 `replace`，以及历史 alias。只有配置中真实 CLI 的完整成功回执、原 operation 和已验证目标才刷新相应来源；unknown、错误/混合 operation、dry-run、status/plan、只读 pull、reused 与非法 ctl 嵌套均不刷新，也不重放写入。原磁盘目录场景必须通过工具事件执行 replace 与 ctl resume 后看到新目录，其他 source 不被普通写入刷新；缺 scope 的已验证历史恢复只保守重读同 CLI 的配置来源。

改前原件 `~/Library/Logs/pi-context-broker/AH-617-20261105/sc23-ctl-callers-syfo5ol8/fail-before.log`，SHA256 `17db82a3bdb2c7427ba740310491373f16133d7bab3f9922f7cdbc455efcddbe`：四种新调用均未触发应有目录更新。该驱动在常规 package check 中执行。它证明回执到目录缓存的接线；真实作者写入/unknown 恢复继续复用 CLI 原独立 package smoke，实际安装 Pi 和真实 Notion 分别记录，不由本地事件断言外推。

runner输出独立 `/tmp/broker-notion-evidence-*`，manifest记录mode、各host分支和未运行入口；provider/RPC/decision transcripts保留，scratch在另一个目录。`node scripts/verify-notion-integration.mjs evidence --evidence /absolute/run` 核对通过和文件存在；`cleanup --evidence /absolute/run` 只将ownership证明属于本次的scratch移入系统Trash，不删除证据。control自身证据再用 `control.mjs evidence /absolute/control-run` 核对。

## 证明边界

仅metadata stub不等于正文；read工具返回不等于模型理解；$注入不等于默认目录或native命令；本地fixture不等于远端Notion认证。任何分支失败或未运行须如实报告，不用已有会话旧正文、手写方法调用或其他宿主结果冒充该入口。

## AH258–260 shared content acceptance

Shared CLI boundary accepts records only and read/export record plus entrypoint. Validate JSON tuple identity [sourceId,sourceScope,kind,locator.type,id], canonical typed locator, fixed snapshot/version/scope, portable v2 kind/main and full inventory. Reject malformed wire (including `skills` in place of `records`) and identity mismatches without fallback. Subscription refs encode upstream:UUID and never act as content page UUID.

`shared_skill` locator 含 `page_id`、`database_id`、`data_source_id`、`library_id`、`skill_id`；前三项是物理 UUID，后两项是逻辑 ID。`record.id` 为 `shared_skill:${encodeURIComponent(library_id)}:${encodeURIComponent(skill_id)}`，公共 ref 为 `skill://${encodeURIComponent(record.id)}/${entrypoint}`。保持 CLI 返回的完整编码；公共 ref 不等于 `skill://<page_id>/...`，菜单消歧和精确页失效仍取 locator 的物理 page UUID。共享记录的 `enabled` 必须为 boolean；缺字段拒绝，disabled 记录不进入可消费目录。原 `notion_page` / `upstream_subscription` locator 的有效合同继续保留。

No execution is claimed by this map update; final owner runs and retains the evidence.

