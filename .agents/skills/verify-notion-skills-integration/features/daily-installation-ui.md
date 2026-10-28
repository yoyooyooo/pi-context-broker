# 日常安装、原生菜单与真实 Notion 消费

该路径用于回答“日常 Tern/OMP 中是否能找到并使用这个真实 Notion Skill”。使用当前安装和现有认证，只读既有页；不创建远端 fixture，不更改用户配置，不安装 CLI 或替换日常插件。

```bash
node scripts/verify-daily-notion-ui.mjs --database UUID --skill-ref skill://PAGE/SKILL.md --mode captured
node scripts/verify-daily-notion-ui.mjs --database UUID --skill-ref skill://PAGE/SKILL.md --mode captured --invocation dollar
node scripts/verify-daily-notion-ui.mjs --database UUID --skill-ref skill://PAGE/SKILL.md --mode captured --invocation dollar --lifecycle --lifecycle-selection alias@namespace
node scripts/verify-daily-notion-ui.mjs --database UUID --skill-ref skill://PAGE/SKILL.md --mode model --model provider/model --model-prompt '当前已授权的自然任务'
node scripts/verify-daily-notion-ui.mjs --database UUID --skill-ref skill://PAGE/SKILL.md --mode model --model provider/model --invocation dollar --model-prompt '介绍这个 skill'
```

`captured` 是默认模式，使用 fake provider 保存完整导出正文的 digest/出现次数；真实 Notion 的 `list --database UUID --refresh`、`read --refresh`、固定 snapshot 的 `export` 与日常 source 发现/激活仍由真实 `ntn-skills` 执行。预期正文来自固定 snapshot 的导出入口，不能拿格式不同的规范化 read 视图替代。`$` 注入按全部非 frontmatter 原文匹配；原生 `/skill:` 另使用当前 OMP 的 `buildSkillPromptMessage` 渲染同一导出入口，以精确匹配宿主实际转换后的完整消息，并记录 `native_expectation` digest，避免表格空格压缩造成误报。该模式不发起真实模型推理。

`captured --invocation dollar` 是独立 cold dollar-only 路径：新建实际 Tern/OMP 会话，以日常 installed companion 查询与真实 `.sf-overlay .sf-item` / `.sf-item.sel` 证明目标候选，Tab 接受 `.sf-editor .sf-t-strong` 胶囊并核对完整草稿，检查选择前后 provider 事件计数不变，再提交到同一 captured provider。首次提交必须只有一次 main-context provider 调用，且固定导出的完整正文恰好一次。它不要求 `Default Context` 或 native catalog stub，不修改真实 Notion 勾选状态；native slash 和 manual search 明确 `not_run`。这里的 cold 指新会话首次提交，不宣称日常 source/cache 为空。

自动美元入口先只输入一个 `$`，等待真实可见候选并保存 `first-dollar-menu` 截图，再追加目标前缀；不删除或重输 `$`。`manifest.results.first-dollar-menu` 记录该步骤，目标选择、Tab 胶囊与正文消费仍单独断言。

`--lifecycle` 只接受 captured dollar，以明确的完整 selection 避免启动前 list/read/query 预热。selection 使用既有成功目录回执中的完整值；重名时必须为 `alias@page-id@namespace`，不能用不再对应实际候选的 `alias@namespace`。受控分支保留实际 installed broker、companion、CLI、认证与 source 身份，只克隆选定 source/config 到 owned 目录和空 Broker cache。owned metadata transport 等待 gate 后才转发真实 `list --refresh`；首个草稿必须恰好是单个 `$`，截图先于 list success，也不能以等待 metadata 的 observer/session_start 作为输入前置条件。放行后不重输即可出现实际候选，保存 `lifecycle-cold-first-input-bare-dollar-menu` 截图并记录 `manifest.lifecycle.firstBareDollarMenu`，随后只追加目标前缀。菜单失败必须保留该 case 的 no-menu 截图与失败阶段，不重输、改 alias 或先 `/restart` 消除失败。首次实际 Tab 接受后，才用真实 list/read/snapshot export 固定完整预期正文并交叉核对 selection/page/source 身份；胶囊保持到提交前，provider 增量始终为零。

受控 transport 将源 discovery 的 `--max-age`/`--offline` 替换为单独 `--refresh`，避免互斥策略冲突；转发完整 CLI stdout/stderr 后等待 Node 自然退出，不能用立即 `process.exit()` 截断大目录 JSON。这只改变该 owned 分支的调度，不修改日常 source 策略。

矩阵顺序为 `lifecycle-cold-first-input`、`/new` 后 `lifecycle-new-session`、`/restart` 后 `lifecycle-restart-retained`、退出 OMP 后另一进程的 `lifecycle-fresh-process`。`/new` 要求 PID 不变且 session file 改变；restart 保留同一 session file 与已完成 user/assistant turn；最终进程 PID 与 session file 均不同，未执行 restart。每次实际 overlay/selected item、Tab 胶囊、精确草稿与完整正文一次分别取证。该 route 证明受控 metadata 调度与 Broker 空缓存，不证明 CLI 内容缓存为空或正常日常配置已通过；普通 daily captured/model 必须另跑。

`model` 需要当前授权覆盖指定模型，使用自然任务 prompt。默认 `--invocation native` 通过原生 `/skill:` 菜单显式激活；`--invocation dollar` 在新会话中接受真实 `$` 候选胶囊后提交，覆盖 cold dollar 完整正文消费。两者都必须观察 provider 请求中的完整正文、真实成功 HTTP 响应和成功助手文本，不要求模型自主发现 Skill。模型可使用原生 `read` 与 `glob`；runner 允许选定 snapshot 内的入口、包清单和参考资源读取及目录查询，记录实际行为而不通过禁用这些工具制造零重复读取。`~/` 路径按用户目录展开。日志区分入口、清单、资源与 glob；技能介绍应直接使用正文，资源任务则检查实际参考文件读取。captured 默认（或 `--invocation native`）仍覆盖三个既有入口，显式 dollar 只运行上述 cold dollar 路径。

示例 UUID、PAGE 和 provider/model 必须替换为当前实际值。模型 prompt 不含 `$`、`/skill:`、`skill://`、CLI 名或凭据提示；runner 自动在菜单接受的原生命令或 `$` 胶囊后附加自然任务。不要把 token 放入参数。

默认 captured 与 model native 规程要求目标属于日常来源选中的 View：配置 `default_view_id` 优先，否则 API 首项。runner 独立查询该 View，不以 checkbox 替代成员检查，不修改真实页面。`--invocation dollar` 不要求默认 View 成员，仍按完整目录的精确记录调用。目录有局部失败时保留诊断并使用页面限定 token，不能声称全库完整。

日常 CLI 需要当前 `records` 协议，以及 `views`、`list --view`、`list --default-view`。普通 `$` 读取完整目录；默认 View 只决定原生默认发现，不限制显式调用。来源/Kind/页面身份独立，Router 不代替其成员，未配置匹配能力的旧 CLI 会报告错误，不回退到旧 checkbox 逻辑。

AH423/AH275 的加载体验分别检查 Tern Pi terminal、Tern OMP terminal、OMP native GUI；本 runner 不替代三个 renderer。普通 `$...@builtin` 选择不提交，维护由当前 Agent 使用实际 CLI 完成。保留用户原话与图片，核对原操作和真实页面。取消、pane/cwd/session/branch/附件变化后旧回调不得晚写；手动 token 与自动 capsule 分别验证。

## 实际读取范围与隔离

runner 要求 macOS、Node.js 22.x 中的 22.22.3+ 或 24.20.0+、已安装 Tern/OMP、Tern 登录、现有 Notion 认证与构建完整的日常 companion。它从当前 `TERN_CONFIG_DIR` 或 `~/Library/Application Support/Tern` 的 `plugin-data/context-broker/config.json` 读取 `config`、`agentDir`、`node`；这些字段必须明确指向实际日常目录。然后读取该 broker config 中与目标 database 相符的唯一启用 Notion source，使用其中的 `command` argv（未配置时遵循 broker 的 `ntn-skills` 默认）。普通路径不接受 checkout config 或临时 source override；只有显式 lifecycle 分支克隆选定 source 并采用上述 controlled metadata transport。命令输出中的认证诊断不保存；manifest 仅记录 CLI 实际路径/hash 和附加参数数量，不保存附加参数值。

OMP 安装定位在实际 agentDir 同级 `plugins/node_modules/pi-context-broker`，并读取 `omp-plugins.lock.json` 的启用状态、安装 package 的入口与版本/hash。允许日常安装本身为符号链接，manifest 会同时记录安装路径与 realpath，不能把版本号推断为源码新旧。runner 不传 `-e broker`、`--no-extensions` 或 `--no-skills`，让 OMP 正常自动加载日常 installed broker；只用 `-e observer/fakeprovider` 做消费观察。继承现有 HOME/agentDir 的登录、模型与普通扩展，未复制模型凭据文件。当前会话中的其他插件或子 agent 可能也调用 fake provider；通过选定正文出现与本次提交窗口区分消费，不能凭首次 provider 调用判定主会话。

日常 companion 从当前 Tern `plugins/context-broker` 复制到本次临时目录，逐文件 hash 比较后安装到独立 `TERN_CONFIG_DIR`。临时 plugin-data override 仍指向实际 daily broker config/agentDir。独立 daemon socket、control socket、窗口、工作目录、OMP sessions 与截图目录均位于该次 evidence 下；只操作这个 endpoint。正常 broker/CLI 会使用实际 daily cache 并可能更新目录/快照缓存；不改业务配置或远端内容。

运行目录使用系统临时根（macOS `/private/tmp`），避免长 socket 路径；窗口显式打开该自有 cwd。Tern shell readiness 使用独立的 30 秒预算；source 不设整段加载总时限，每次网络尝试默认 30 秒。正文基线必须 `export SNAPSHOT --projection snapshot`，入口逐字节等于同次完整 `read.content`，不能拿 source projection 的 Markdown 排版来比较消费快照。资源定位使用当前 `records/sha256(ContentRecord.id)/snapshots/SNAPSHOT` 布局。

这里的 `agentDir` 决定发现、补全配置与日常 Broker 安装定位。随包 Skill 从安装产物直接读取，不依赖中央数据根；参见[随包 Skill](builtin-management.md)。

日常 broker source 或 OMP extension 安装改变后，已有 OMP 会话需要 `/restart`；`/reload-plugins` 不能代替。companion 改动使用 `tern plugin reload`，仍需 OMP 重启才能刷新其 source 菜单。runner 新建会话不需要对用户已有窗口发这些命令。

## 验收动作

| ID | 用户入口与动作 | 可观察 assertion |
| --- | --- | --- |
| NS-DAILY-01 | 读取日常安装、source、真实 database 的完整 catalog 与选定页 | database 覆盖诊断保留；PAGE 按精确身份匹配；CLI read 返回完整正文与 snapshot；实际安装版本、路径、hash 入 manifest。 |
| NS-DAILY-02 | 日常 installed companion 查询 source 候选，然后输入 `/skill:` 前缀 | invocation 来自实际 query candidate；canonical 由 catalog 的 namespace/alias 与同来源 page 消歧信息确定，再与实际 daily source metadata stub 核对 native name。原生斜杠菜单实际出现选定 Skill，保留菜单截图/state。 |
| NS-DAILY-03 | 接受原生菜单、提交 `/skill:` | 草稿接受正确命令；Enter 立即进入 preparation 并阻断派发，期间 Enter 不提交第二条，失败、超时或取消零 provider 请求。provider 边界包含同一导出正文经当前宿主渲染后的完整消息，且成功助手响应；captured 证明宿主消费，model 另证明真实模型与网络成功。 |
| NS-DAILY-04 | captured 输入 `$invocation` 前缀、接受胶囊并提交 | invocation 使用实际候选引用，Notion 始终为 `$alias@namespace`，重名时为 `$alias@page-id@namespace`；真实可见 overlay 候选、选中项、接受胶囊和精确草稿截图对应，选择前后 provider 事件无增量。默认 captured 证明先前 `/skill:` 与本次 `$` 在同一会话保留且仅有一份完整正文；`--invocation dollar` 则证明新会话首次提交只有一次 main-context captured provider 调用且完整正文一次，native/manual 为 not_run。model 使用 NS-DAILY-07，不将 captured 结果替代真实模型。 |
| NS-DAILY-05 | 默认 captured 在 Unicode 草稿中快捷键手动搜索、选中并提交 | 搜索截图、替换后草稿截图，选择动作本身没有新增 fake provider 请求；提交后 provider 保留且仅有一份正文。model 或 captured dollar-only 模式不运行该项，标 not_run。 |
| NS-DAILY-06 | 成功、失败或超时后 finally | 只结束持有的 ChildProcess；cleanup 回执记录每个自有窗口/daemon 的实际退出码/信号与 stopped 状态；保留证据，清理失败令整体 failed。 |
| NS-DAILY-07 | model 指定 `--invocation dollar`，新会话接受 `$` 候选胶囊并提交自然任务 | 实际菜单/草稿/提交截图与 invocation 对应，provider 首次包含完整正文且成功响应。审阅工具观察：技能介绍没有重读入口、列缓存目录或读取清单；资源任务能读取所需参考文件。保留真实模型可能产生冗余读取的结果，不将其误记为提示已经生效。 |
| NS-DAILY-08 | 显式 lifecycle，新进程首个 `$` 输入在真实 source metadata 成功前；再 `/new`、`/restart`、退出后新进程 | 每项保留实际可见菜单/选中项/接受胶囊/提交与响应截图，接受到提交前 provider+0，提交一次 main context 且完整正文一次。metadata-events 与 early-draft 时间证明 gate；PID/session file 与 provider turn 数证明四项不同生命周期。无菜单/无 composer 是失败，不用 restart、重试或别名改写掩盖。 |

原生候选断言查询 `.sf-overlay .sf-item` 与目标 `.sf-item.sel`；不从包含输入/ghost/caption 的整棵 tree 搜名称来证明菜单存在。先输入 `/`，等待命令菜单打开，再输入 `skill:` 并导航到实际目标。接受的 `/skill:` 可显示为 `.sf-editor` 内灯泡 `sf-t-icon` 和精确 native name 的 `sf-t-strong` 胶囊；菜单接受断言采用该实际渲染结构，正文消费另由 provider 观察证明。captured 将 smol/slow/plan 一并指定 fake 模型，避免继承日常角色模型发起真实网络请求。
手动 picker 从完整 tree 中定位具有 `.ck-item` class 且 `aria-selected="true"` 的候选子树，invocation 位于子节点 `mark`，`[skill]` 位于 label；分别核对两者，不要求父节点 text 拼接子节点文本。选择前后核对完整 Unicode 草稿，并确认选择动作没有触发 provider 请求。
自动 `$` 选择同样必须命中实际可见 overlay 项与 `.sf-item.sel`，不能以 query 成功或输入文本代替 popup/activation。接受后保留 `automatic-dollar-selection-state.json` 与截图、`manifest.results.dollar-selection` 的 provider 前后计数。冷捕获只证明菜单选择、草稿与该次提交的完整正文消费；取消、preparation 中阻止二次提交、超时恢复、缓存冷启动和真实模型效果需各自专项证据，不能从此路径推断。

每个等待阶段都有 timeout；同步 CLI/control 子命令也有限时。真实模型完成等待上限为 10 分钟，HTTP 200 仍需完整助手响应与 agent_end 才通过；captured 提交为 60 秒。失败保留最后界面/state，无法截图时保存 failure-capture 原因。失败、超时、未运行项和缺证据项不得标 passed.

## Evidence 与证明边界

每次输出 `broker-daily-notion-ui-*` 绝对目录。`manifest.json` 记录 mode、阶段状态、时间、动作结果、实际安装和 source 路径/hash、版本、invocation/canonical/native derivation、CLI read/body digest、catalog coverage/freshness、启动参数与隔离端点。`actions.jsonl` 记录动作，`consumption.jsonl` 保存选定正文 digest/次数、请求 selector、响应状态、脱敏助手文本与实际 read 观察；不保存完整 provider payload、provider URL、header 或凭据。host log 仅保留字节/时间回执，避免分块日志泄露秘密。`installed-query.json` 记录实际 bundled query 与唯一选中候选。

lifecycle 另保留 `metadata-events.jsonl` 的 waiting/released/success/failed 时间、`manifest.lifecycle` 的 source/record/token/PID/session 身份与四项结果。首项 expected body 只在实际选中后固定，不能将启动前 warm CLI query 结果写成 cold discovery。source list 进程成功与 CLI freshness 各有独立语义，不能从本地进程退出码推断真实网络请求次数。

原生截图位于 Tern 输出的 `shots` 子目录，`*-state.json` 与菜单接受、提交、响应对应；结合 manifest 和实际截图路径审阅，不凭单张最终屏幕声明菜单可用。`owned-processes.json` 与 `cleanup.json` 保存归属/退出回执，sessions 留在本次目录。runner 不永久删除文件；审阅后才可按仓库 cleanup 规则移到系统 Trash。

CLI freshness 回执说明 list/read 是否发生新鲜远端校验；真实 CLI 成功不能单独证明模型消费，模型成功不能反推资源自然读取。该 runner 只覆盖 OMP/Tern 日常安装，不证明 Pi 安装、发布归档、远端同步或用户已有会话已重启。

真实 CLI 空缓存和 Notion 修改另走 [NS-SESSION-09～12](session-cache-recovery.md)：`verify-notion-integration.mjs run --mode live-fixture --cache-lifecycle true` 创建 owned 页，分别启动实际 Pi/OMP 终端与 Tern/OMP 窗口，等待默认五分钟过期并核对固定正文/资源。它使用独立根与指定 extension/command，不替代本地图的日常 installed source 验收。

## Frozen native GUI entrypoint

For the native branch of AH275 use `node scripts/verify-tern-surfaces.mjs run --surface omp-native --spec /absolute/native-owned-run.json`. This installs frozen companion/config before opening its own real `tern --control SHORT_SOCKET OWN_CWD` window, then requires window-half load log, actual actions/effective keymap and shortcut callback. Tern 0.9.2 `serve` is transport-only and cannot satisfy companion acceptance. Failure to open an owned window fails, with no daily-window fallback. The explicit fixture spec supplies binary/entry/model/scope/hash provenance; it does not require the daily installed path above. The same `probe --surface omp-native --spec PATH` checks supplied companion activation and minimal native renderer without loading Broker/candidate or making a provider request. Exact contract: control `ah275/harness.md`.

Native recipe: focus current editor rect, type owned Skill/Router/Prompt prefix, wait for actual `.sf-overlay .sf-item` with Kind/source, screenshot, Tab or click current candidate rect, verify exact accepted draft and unchanged provider count, screenshot, append task and submit. Unicode manual recipe first Esc, then palette search; select inserts a plain token. Automatic capsule recipe clicks inside current capsule, Backspace deletes one atom and undo restores its expansion. Keep both distinct. Host-native slash/file completion remains available; the retired mirrored CLI command browser is not an acceptance target.

Attach generated PNG through an actual public file dialog/drop action if supported; retain attachment UI before submit and image digest in provider-bound event after submit. No helper or attachment API means `mixed-image` blocked. A maintenance task uses the ordinary bundled Skill, owned destination/ref and a natural request in the same host Agent; one observed task may have multiple tool/provider rounds. Independent CLI readback, operation outcome/reconcile and refreshed candidate evidence remain required before reporting successful maintenance.

Run pane/cwd/workspace and OMP conversation/branch changes during owned delayed preparation; await delayed completion, assert no late provider, then submit a new editable draft. Tern workspace session is not OMP conversation identity. Public Tern snapshots expose no attachment revision, and a retained surface is possible; these races require Broker lifecycle evidence or explicit gates. `manifest.json` records hashes, model/renderer, steps, screenshots, observer digests and actual owned exits. Pending/blocked/missing scenarios never count as full acceptance.
Native shot evidence uses the current `ctl shot` response and existing PNG under owned cwd `target/shots/tern/live`, with bytes/hash in manifest; serve output paths are never reused. Cleanup records host ChildProcess/session exit, owned window exit and exact log-bound daemon PID disappearance, rather than treating socket existence as completion.
