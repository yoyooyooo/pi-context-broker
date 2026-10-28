---
name: verify-notion-skills-integration
description: "验证 Notion Skills source 与随包 Skill在 Pi/OMP、Tern 中的发现、原生读取、补全、包内资源消费、会话恢复与独立安装包。修改 source、builtin 或宿主集成、升级宿主及验收产物时使用。"
---

# Verify Notion Skills Integration

从本仓库根目录执行命令。先按变更选择下列地图；使用真实 Pi/OMP extension 与 provider 边界捕获，不把直接调用 adapter 或 CLI 当成宿主消费通过。此 Skill 的维护目录在 `.agents`，不修改用户全局配置。

缺失引用按 [selection 的 Missing-reference regression route](features/dollar-completion-selection.md#missing-reference-regression-route) 验收。未知名字/source/alias 与限定引用及选中目标明确 typed not-found 原样透传；真实已选记录故障仍失败。双轮混合三种 Kind、图片、单次派发及取消/切会话需独立证据，不修改历史冻结结论。

| 功能地图 | Feature IDs |
| --- | --- |
| [配置与发现](features/source-configuration-discovery.md) | NS-CFG-01～07 |
| [宿主 Skill 发现与读取](features/host-skill-discovery-read.md) | NS-HOST-01～04 |
| [默认上下文与后台预取](features/default-context-prefetch.md) | NS-DEFAULT-01～08 |
| [美元补全与选择](features/dollar-completion-selection.md) | NS-SELECT-01～06 |
| [激活快照与资源](features/activation-snapshot-resources.md) | NS-ACT-01～04 |
| [会话缓存与恢复](features/session-cache-recovery.md) | NS-SESSION-01～21 |
| [安装包消费](features/installed-consumption.md) | NS-INSTALL-01～04 |
| [日常安装与真实原生菜单](features/daily-installation-ui.md) | NS-DAILY-01～08 |
| [随包 Skill](features/builtin-management.md) | NS-BUILTIN-01～05 |

## Doctor 与入口
安全发现：`node scripts/verify-notion-integration.mjs --help` 在解析 run 前退出，不创建目录或启动宿主。Doctor 的版本探测使用独立 owned HOME/XDG/application roots，并返回该次 probe scratch；审阅后进系统 Trash。Doctor 不读取远端或证明认证。


```bash
node scripts/verify-notion-integration.mjs doctor
node scripts/verify-notion-integration.mjs run
```

默认 mode 为 `deterministic`。Doctor 接受与 run 相同的 mode 及其选项，只检查工具存在、实际入口与版本；不认证、不启动模型请求，不证明功能通过。工具缺失、版本不满足或配置参数缺失时如实报告，不安装替代入口冒充通过。

```bash
node scripts/verify-notion-integration.mjs doctor --mode deterministic
node scripts/verify-notion-integration.mjs run --mode deterministic
node scripts/verify-notion-integration.mjs doctor --mode deterministic --default-context true
node scripts/verify-notion-integration.mjs run --mode deterministic --default-context true
node scripts/verify-notion-integration.mjs doctor --mode live --database DB --skill-ref skill://PAGE/SKILL.md
node scripts/verify-notion-integration.mjs run --mode live --database DB --skill-ref skill://PAGE/SKILL.md
node scripts/verify-notion-integration.mjs run --mode live --database DB --skill-ref skill://PAGE/SKILL.md --command-json '["/path/ntn-skills"]'
node scripts/verify-notion-integration.mjs doctor --mode live-fixture --database UUID
node scripts/verify-notion-integration.mjs run --mode live-fixture --database UUID --command-json '["/path/ntn-skills"]'
node scripts/verify-notion-integration.mjs run --mode live-fixture --default-context true --database UUID --command-json '["node","/absolute/ntn-skills/dist/ntn-skills.js"]'
node scripts/verify-notion-integration.mjs run --mode live-fixture --database UUID --resume-evidence /absolute/FAILED_EVIDENCE
node scripts/verify-notion-integration.mjs run --mode live-fixture --cache-lifecycle true --database UUID --command-json '["/absolute/ntn-skills"]'
node scripts/verify-notion-integration.mjs run --mode live-fixture --database UUID --model provider/model --model-prompt TEXT
node scripts/verify-notion-integration.mjs doctor --mode model --database DB --skill-ref skill://PAGE/SKILL.md --model provider/model --model-prompt TEXT
node scripts/verify-notion-integration.mjs run --mode model --database DB --skill-ref skill://PAGE/SKILL.md --model provider/model --model-prompt TEXT
node scripts/verify-notion-integration.mjs run --mode model --host pi --database DB --skill-ref skill://PAGE/SKILL.md --model magpie/group/flash-free --model-prompt TEXT
node scripts/verify-notion-integration.mjs run --mode model --host omp --database DB --skill-ref skill://PAGE/SKILL.md --model magpie/group/flash-free --model-prompt TEXT
node scripts/verify-notion-integration.mjs run --mode model --consumer-isolation true --database DB --skill-ref skill://PAGE/SKILL.md --model AUTHORIZED_PROVIDER/MODEL --model-prompt '介绍这个 skill 的用途和主要约束。'
node scripts/verify-notion-integration.mjs run --mode model --consumer-isolation true --consumer-resource references/guide.md --database DB --skill-ref skill://PAGE/SKILL.md --model AUTHORIZED_PROVIDER/MODEL --model-prompt '读取附带的 references/guide.md，摘录核心步骤。'
node scripts/verify-notion-integration.mjs doctor --mode installed --package /absolute/package.tgz
node scripts/verify-notion-integration.mjs run --mode installed --package /absolute/package.tgz
```
`live` / `live-fixture` / `model` 可附加 `--extension ABSOLUTE_INSTALLED_ENTRY`，从已安装 broker 启动真实双宿主；`--command-json '["node","ABSOLUTE_INSTALLED_CLI"]'` 选择实际安装 CLI。Doctor 记录这两个精确入口的 SHA-256 与宿主版本。installed Doctor 对待安装包记录 hash 和 pending-install；run 在 npm 安装并选择实际 extension 后更新 `manifest.extension`、`doctor.extension` 和 `extensionReadback`，再将同一 realpath 传给宿主。evidence 校验三者一致，并在入口仍在时重读其 bytes/hash；scratch 已回收时仅报告 retained-readback，不假称还能读取入口。run 隔离 CLI config/state/cache/data 与所有 XDG bases；live source 仅继承现有 token 或官方 `ntn` HOME 登录，不继承用户 CLI 的可变状态/缓存，也不复制认证。由父控选定独立 fixture 库；不得给共享 Skills 库新增 schema 字段来凑前提。

工具解析复用共享 `resolveHost()`，Doctor 同时记录可执行 file/prefix/path 与独立 identity realpath。安装执行 npm 的合法 argv；Volta 在 HOME 隔离前用 `volta which npm` 选入口，不能执行 npm symlink 的 `volta-shim` realpath。普通 shell/shebang/symlink 的执行路径语义保留，绝对 trash 同样处理。


示例中的 DB、PAGE、TEXT、模型与包路径须替换为当前任务的实际值；`--command-json` 是 JSON argv 数组，不是 shell 命令串。live/model 使用现有授权配置；不要求用户提供 token、不显示凭据、不改登录或用户 CLI 配置。model 必须已有任务授权覆盖实际模型调用。

`--view-discovery true` 的 deterministic 专项使用真实 Pi/OMP 和受控 CLI/LLM，验证首条消息前零 provider、View 替换、显式配置/首项兜底、空/失效区别、会话恢复/分支及并行会话。见 [默认目录验收地图](features/default-context-prefetch.md)。`--default-context true` 旧专项仅测试一个采用 checkbox 筛选的 View 的预取，不再表示 checkbox 是独立全局开关。真实 live/model 使用 `--view VIEW_ID` 或默认首项，并确认目标实际在该 View；不得为验收修改用户页面。

`--consumer-isolation true` 是 model 的显式 `$` 消费分支，接受未勾选的现有页；要求命令为 PATH 上的 `ntn-skills`，使用仓库外空 cwd、独立各根、正常工具和隐藏本地路径的 payload。介绍要求零工具调用；`--consumer-resource RELATIVE_FILE` 要求真实模型经公共 CLI 读取选中快照中的资源，并匹配原件 hash。逐宿主观察实际 provider 请求和工具交互是否暴露实现或缓存路径。完整边界及证据字段见[真实模型地图](../verify-context-broker/features/model.md#隐藏实现路径的消费回归)；不替代默认的自主发现/native-read recipe，不是文件系统沙箱。

上游托管页使用 `--upstream-database UUID`，将已知订阅库 ID 登记到本次独立 CLI 配置；不改远端 schema 或用户配置。真实读取继续验证订阅归属和发布状态，未配置时保留 `UPSTREAM_NOT_CONFIGURED`。

`--cache-lifecycle true` 仅适用于 live-fixture，独立于 `--default-context`。验证实际 Pi/OMP 终端和 Tern/OMP 原生 `$` 的空 CLI 缓存、重复消费、新会话/新进程，以及直接修改 owned Notion 正文/资源后的发布检查、精确版本接受、默认五分钟过期与会话固定版本，证据按 [NS-SESSION-09～12](features/session-cache-recovery.md) 分别审阅。

跨项目/宿主共享目录使用 `node scripts/verify-notion-integration.mjs run --mode deterministic --shared-catalog true`，按[共享 Notion 缓存地图](features/session-cache-recovery.md#共享-notion-缓存)运行 Doctor、审阅 `shared-catalog-result.json` 和双宿主 provider/RPC，再执行原 evidence/cleanup。它验证等价远端选择的一份目录/导出、共享刷新、旧会话固定 A 与新会话共用 B；不访问真实 Notion、不证明原生菜单或真实模型。CLI identity 与 TTL/身份负例使用地图所列两仓回归入口。

并发 catalog/snapshot 发布与真实 Pi/OMP 首次正文使用本 Skill 的 [NS-SESSION-16～21](features/session-cache-recovery.md#并发发布与首次正文)。先运行 `node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs doctor --mode storage`，再用 `run --mode storage --case catalog-order,snapshot-race` 保留 fail-before；修复后以同一命令取得 pass-after，并运行 `--case snapshot-mismatch` 及 `--case catalog-equal-time,catalog-clock-rollback`。实际双宿主另用 `doctor --mode hosts` 与 `run --mode hosts --case host-first-body`，必须先完成两个真实宿主 discovery，再并发首次 `$`。两种 mode 使用隔离的受控 source，不需要凭据；snapshot 允许重复 read/export，要求两个 load 的完整字节一致且 active cache 无 losing stage。Doctor/run 每次输出各自 evidence，使用该 runner 的 `evidence`、`cleanup`、再次 `evidence`，保留所有独立失败。地图给出完整命令、显式 gate、逐项证据与证明边界。


Adapter、输入事件或回执调整继续使用现有 host、selection、activation 与 default-context 地图。目录覆盖另复用[注入地图](../verify-context-broker/features/injection.md)；编辑器分别验收 Tern/OMP 与[Pi 独立终端](features/dollar-completion-selection.md#pi-独立终端)。运行通过只证明实际执行的入口，不从一种宿主协议推断另一种。
真实 Pi 输入现有可执行入口为 `node scripts/verify-pi-pty.mjs doctor` / `run`，支持 `--extension ABSOLUTE_INSTALLED_ENTRY`。两次冷 PTY 覆盖候选、Tab 接受草稿、Enter 提交及 `$`/native 双向切换；受控 CLI/provider 仅证明终端投递。Tern/OMP 继续使用 `verify-native-ui.mjs --notion`，不从 RPC 推断输入 UI。


当前用户指定后续真实模型 E2E 使用 `magpie/group/flash-free`。日常 model recipe 的 `--model` 使用该 selector；OMP 的 smol/slow/plan 角色与主模型一致，Pi 只传主模型 selector。其它真实模型 helper 也应显式指定该 selector，不继承未指定的角色模型。

## 执行与证明边界

| Mode | 实际路径与边界 |
| --- | --- |
| deterministic | 双 Pi/OMP 原生 extension/provider 捕获；Notion 与 filesystem source 的 metadata/read/native RPC+print/`$`/resource；Notion native cold print；metadata 后注入、repeat、continue；重名歧义拒绝、两个 qualified native 独立正文、错误/超时/cold-warm；主 run 调用 OMP source lifecycle helper 覆盖真实 fork/branch/compact-remove+refresh。fixture 不证明真实 Notion 或模型效果。 |
| live | 必须指定 database 与 skill-ref；只读既有页的 list/read/export，再双宿主 provider 捕获，不创建或修改远端页；不能替代 live-fixture 端到端。 |
| live-fixture | 必须指定 database UUID，可提供 command-json；以唯一动态 name 创建独立真实测试页与 `references/guide.md`，list/read/export 后双宿主消费；finally 通过 ntn 官方 API 仅 archive 本次页与 child pages，并 GET 确认。当前任务已授权，禁止永久删除或触碰无关页。`live-fixture-create.json` 与 `live-fixture-cleanup.json` 保存无 token 回执。 |
| model | 必须指定 database、skill-ref、model 与 model-prompt；默认分别执行 Pi 与 OMP，可用 `--host pi` 或 `--host omp` 只执行一个宿主。Doctor 同样只检查选定宿主。使用继承的现有授权配置、独立临时 broker/cache/session，要求模型从 metadata 自主选择 native read、读取入口与关联资源、正文进入 provider、成功 HTTP 响应，以及非空且以 stop 或 length 成功结束的 assistant final 回复；不得由确定性 provider 或另一宿主结果推断通过。非 model mode 拒绝 `--host`，live-fixture 附加 model 仍执行两宿主。 |
| installed | 必须给绝对 tgz 路径；实际 `npm install --prefix scratch` 后，在安装产物上完成双宿主与 deterministic 相同消费路径。checkout 结果不能替代。 |

live-fixture 创建 deadline 为 15 分钟，`intent.json` 保存 create-started/unknown。失败后不得盲目重建：`--resume-evidence` 指向原失败证据绝对目录，先校验旧 scratch ownership/input 的唯一 fixture name，再 catalog exactname 唯一匹配并 read canary；确认归属后本次不 create，消费完成最终 archive。可同时指定 `--model` 与 `--model-prompt`，对同一真实页执行模型路径后 archive；实际模型授权与凭据规则仍适用。

原生 UI 是独立入口：

```bash
node scripts/verify-native-ui.mjs --notion
node scripts/verify-native-ui.mjs --notion-loading
node scripts/verify-native-ui.mjs --source-dependencies
node scripts/verify-native-ui.mjs --upstream-labels
node scripts/verify-native-ui.mjs --catalog-cache
node scripts/verify-native-ui.mjs --catalog-cache-failure
node scripts/verify-pi-pty.mjs run --upstream-labels
```

这条命令使用真实 Tern + OMP 和 fixture source，观察原生编辑器的补全、选择、提交与 provider 请求。它不访问 live Notion，也不能标为 live 验证。需要该脚本所要求的 Tern/OMP、平台与现有 Tern 登录；只操作自建窗口和 control endpoint。主验证 control 的 source route 与 notion-editor route 是编排入口，不能扩大底层命令的证明范围。

`--notion-loading` 用自建 Tern/OMP 入口验证 preparation 与持久 `Read ntn-skills://<alias>` 会话记录，展示目标不含 namespace 前缀。隔离页保持 `default_context: false`，防止后台预取提前完成等待；每个 cold 场景从不含已加载正文的上下文开始，refresh 不移除有效指令。首项接受原生 cold `$ui-alpha@notion` 补全并等待 65 秒，验证超过旧 60 秒命令总时限仍能成功，覆盖即时 preparation、原生 running/Stop、草稿编辑与阻止二次提交，再以实际 pinned export 核对首个 provider 请求的原 prompt 和完整正文各一份。后续覆盖 draft 顺序、暖读取、受控 4 秒 cold `/skill:`、36 秒单请求 `NTN_UNAVAILABLE` 后恢复、Escape 与实际点击 native Stop 后重试、真实工具 `read skill://`，以及同 pane 精确 JSONL 的 quit/resume 终态保留与普通续接。真实 read 使用独立空缓存和重新启动的自有宿主，避免复用前面场景已准备的 native 路径；等待期间检查 provider 边界、source read 与原生 Stop。宿主可在创建工具行前将 URI 改写为 pinned snapshot 路径，不能要求行中出现 `skill://`。Stop 使用 32 秒受控读取以容纳取证和草稿编辑。操作步骤、展示记录与真实工具的区分、证据检查见[激活快照地图](features/activation-snapshot-resources.md)。图片和 session switch 另由 RPC 验证，不能声称此 UI runner 已覆盖。`BROKER_UI_EXTENSION` 可指定已安装扩展；隔离 fixture 时序不证明真实 HTTP 耗时或真实模型行为，单次网络预算另由 CLI transport 回归验证。此处定义验收 procedure，不代表已经通过。

同一 `--notion-loading` run 另以 checkbox 过滤 View 内的所属页和独立空缓存验证 `defaultContextNativeStop`。首个 provider 请求只有元数据；后台准备期间实际 Stop 取消前台消费者，后台仍以一次 read/export 完成，取消的提交不派发，显式重试消费完整正文及同快照资源。保留取消、后台完成与资源消费截图。

`--source-dependencies` 使用缺失的 source executable 与另一条已发现、未加入默认 View 的受控 source，检查启动提示、普通聊天、本地自动补全与手动搜索继续工作。失败 namespace 中未匹配的引用须原样派发，不能回退读取另一 source；真实 Tab 接受已知 source 候选后注入其 read 故障，要求显示 `ACCESS_DENIED`、无 export 且 provider 请求不增加。双宿主完整依赖矩阵另运行 `bun run test:source-dependencies`；包内 CLI 与安装后矩阵见[安装包地图](features/installed-consumption.md)。

日常已安装环境使用独立入口，详细配置范围、菜单动作和证明边界见 [日常安装地图](features/daily-installation-ui.md)：

```bash
node scripts/verify-daily-notion-ui.mjs --database UUID --skill-ref skill://PAGE/SKILL.md --mode captured
node scripts/verify-daily-notion-ui.mjs --database UUID --skill-ref skill://PAGE/SKILL.md --mode captured --invocation dollar
node scripts/verify-daily-notion-ui.mjs --database UUID --skill-ref skill://PAGE/SKILL.md --mode captured --invocation dollar --lifecycle --lifecycle-selection alias@namespace
node scripts/verify-daily-notion-ui.mjs --database UUID --skill-ref skill://PAGE/SKILL.md --mode model --model provider/model --model-prompt TEXT
node scripts/verify-daily-notion-ui.mjs --database UUID --skill-ref skill://PAGE/SKILL.md --mode model --model provider/model --invocation dollar --model-prompt '介绍这个 skill'
```

默认 captured 使用真实 Notion CLI、日常 source 和自动加载的 installed broker，复制日常 installed companion 到自建 Tern 实例；覆盖 `/skill:` 菜单、自动 `$` 胶囊与手动搜索实际选中后提交，确认 native 所需的当前 View 成员前提。`captured --invocation dollar` 则只运行新会话首次 `$` 实际候选/选中项、Tab 胶囊与精确草稿、选择零 provider 增量，再提交到 captured provider 并核对一次 main-context 调用中完整导出正文恰好一次；不要求 `Default Context` 或 native catalog，native/manual 明确 not_run。cold 指首次会话提交，不表示日常缓存为空。model 默认 native，也可指定 `--invocation dollar` 在新会话实际接受 `$` 候选并提交；它观察正文进入真实 provider、成功网络响应、助手文本及实际 read/glob，区分入口重复读取与必要资源使用。这些路径均不创建远端 fixture 或修改用户配置；captured 不调用真实模型。配置/OMP 安装改动后的已有会话需要 `/restart`；Tern `plugin reload` 不代替 OMP 重启。

自动美元入口先以单个 `$` 和实际可见候选证明首次补全，再追加目标前缀；保留 `first-dollar-menu` 截图与对应 manifest 结果。`--catalog-cache-failure` 的新进程用同一首次输入验证过期目录先出现、后台暂时性失败不撤下旧候选、选择不派发且提交正文一份，详见[美元补全地图](features/dollar-completion-selection.md)。

`--lifecycle` 是既有 runner 的独立受控分支，只接受 captured dollar。必须给完整 `--lifecycle-selection alias@namespace`，不能启动前 list/read/query 来推导它。该分支克隆当前选定日常 source 到 owned config 与空 Broker cache，以 owned transport 将真实 CLI 的首次 `list --refresh` 挡在首个实际草稿截图之后；不清空 CLI 内容缓存，不冒称正常日常路径或真实网络请求数。矩阵依次覆盖新进程首次输入、同进程 `/new`、保留 conversation 的 `/restart`、退出后不经 restart 的另一新进程。每项需要真实菜单、精确胶囊、接受到提交前 provider+0、完整固定导出正文一次；失败保留 stage 与 no-menu/failure 截图。不能用 `/restart` 修好后的当前窗口代替新会话通过，也不能换 alias、重复输入或重试来掩盖首次失败。正常日常 source 与真实模型路径另跑，受控 metadata 调度不能替代它们。

生命周期 selection 必须与既有真实目录回执的完整 value 一致；重名时包含 page ID。首个受控草稿恰好是 `$`，metadata gate 放行后不重输即出现候选，再追加目标前缀。该额外证据见 `manifest.lifecycle.firstBareDollarMenu` 和 `lifecycle-cold-first-input-bare-dollar-menu` 截图。

随包 Skill 使用 [内容地图](features/builtin-management.md)，复用现有 distribution/source/editor 路径。独立 npm/Tern 产物在未配置 Notion source、全局 CLI 和中央 Skill 安装时，三份内建 Skill 仍可经普通 `$` 发现、加载正文与相对资源；多来源操作使用各自真实 argv/database。`/ntn-skills` 命令镜像、管理面板和 save 桥已退役。

## Evidence

run 的 scratch、host cwd 和 TMPDIR 使用系统临时根（macOS `/private/tmp`，其他 POSIX `/tmp`），检查该根及祖先无 `.agents`，避免外部 TMPDIR 在用户目录下导致日常技能被扫描。`--evidence-root ABSOLUTE_DIRECTORY` 仅改变证据父目录，与 scratch 分离；不改变宿主 cwd 或 Skill 发现范围。使用本次实际输出的 evidence 绝对目录：

```text
node scripts/verify-notion-integration.mjs evidence --evidence /absolute/evidenceDIR
```

报告 mode、宿主实际版本、执行命令、feature ID、入口动作、观察结果、失败与未运行项，以及 evidence 路径。审阅 harness 留存的 transcript、provider 捕获及实际资源/读取观察；不要假设未输出的文件或字段存在。
证据合同包含 `manifest.json`、`pi-provider.jsonl`、`omp-provider.jsonl`、`pi-rpc.json`、`omp-rpc.json`、`pi-decisions.jsonl`、`omp-decisions.jsonl` 和 `owned-processes.jsonl` 的实际 spawn/close 事件；fixture 另有 `source-cli-calls.jsonl`，不能把它当成 live 网络证据。`manifest.scratch` 指向另一个临时目录，其 `ownership.json` 确定 scratch 归属；cleanup 确认每个持有宿主的 close 事件后回收 scratch，写 `cleanup.json`。未执行路径不能因文件存在而记 pass。
扩展路径还保留 `pi-fs-`/`omp-fs-` 系列、`*-cold-print-provider.jsonl`、`*-duplicates-rpc.json`；OMP source lifecycle helper 返回的证据文件按本次 manifest/实际输出定位，不能杜撰文件名。live-fixture 的 create/cleanup 回执与 intent 要一起审阅，unknown、恢复归属校验失败或未确认 archive 均不得记为完整 pass。
live/fixture CLI 调用另保留 `command-receipts.jsonl`：调用前 started，close 后 exit code/signal/timeout、stdout/stderr 原始 bytes 与 SHA-256、JSON 判定及脱敏 diagnostic。原始 stdout/stderr 不落盘，认证值、URL 与长 token 脱敏；无响应、非 JSON 或非零退出均失败，不能算 pass。创建前 intent 与拿到 ID 后的 create 回执先保存，unknown 操作不重放；失败前已知 ID 和归属证据保留。
默认上下文专项证据以本次 manifest 的分支与文件清单为准。provider/RPC 证明目录与会话消费，source 调用和 freshness 证明准备与复用边界；命令次数本身不能证明真实网络请求数。预取不生成激活或 `Read ntn-skills://` 记录。专项地图的失败、取消、过期及跨进程分支逐项报告。
model 每个实际执行宿主独立保留 `pi-real-model-observer.jsonl` / `pi-real-model-result.json` 或 `omp-real-model-observer.jsonl` / `omp-real-model-result.json`；失败也保留 result。observer 记录 selector、计数、脱敏的目标 source read 结果，以及 `assistant_final` 的 bytes、textSha256、脱敏 text、stopReason 和 success；通过必须存在非空且 stopReason 为 stop 或 length 的成功 final 回复。不保存 raw provider payload、RPC frames 或凭据。result 的 host/status 与 manifest branches 必须对应实际宿主；未执行宿主在 `manifest.notRun` 中标明，不能用单宿主 pass 替代双宿主结论。model 不要求普通 deterministic 的 provider/rpc 文件。


通过必须有对应入口动作与可观察 assertion。退出码 0、Doctor 就绪、补全出现、正文读取、provider 收到正文、真实模型执行是不同证据层。单宿主通过不能替代另一宿主；failed、超时、跳过、未运行及证据缺失均不得写成 pass。此文档只定义验收，不声称任何命令已经运行。

## Cleanup

```text
node scripts/verify-notion-integration.mjs cleanup --evidence /absolute/evidenceDIR
node scripts/verify-notion-integration.mjs evidence --evidence /absolute/evidenceDIR
```

cleanup 仅将该次 evidence 关联的 scratch 移入系统 Trash，不删除 evidence。证据与 scratch 必须是独立 `/tmp` 目录；不能以 evidence 或用户目录充当 scratch。成功与失败都保留证据，不永久删除，不批量 kill 用户进程。清理后 evidence 命令仍须能读取本次证据；清理成功不代表功能通过。
`evidence` 返回 `functionalStatus` 与缺失文件 `missing`，失败时也可审阅保留下来的证据；`status: preserved` 仅证明文件保留，绝不覆盖 manifest 的 failed/running。Pi PTY 的 evidence/cleanup 用其独立入口和目录，不混用本 helper 的 ownership。

