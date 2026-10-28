# OMP 自动补全与 Tern 手动搜索

自动候选属于 OMP 扩展，接受后成为可整体删除/撤销的原生胶囊；Tern companion 提供显式快捷键搜索，选择只修改草稿。

## Sub-features

- `editor-auto`：正文后的 `$prefix` 出现候选，Tab 接受 Skill/Router 为胶囊。
- `editor-atomic`：整体删除、撤销、同一草稿多引用，提交时展开为 `$name`。
- `editor-caret`：鼠标点击已接受胶囊文字内部的多个位置，光标移动、草稿不变、下拉保持关闭；随后输入新的 `$prefix` 仍能补全。
- `editor-width`：长名称候选下拉为 720 像素、名称列有足够空间，光标靠右和窄窗口时菜单保留 pane 内边界；原生 `/` 菜单不受影响。需同时加载更新后的 broker 和 Tern companion。
- `editor-submit`：Skill/Router 混合提交和重复提交的 provider 正文/索引数量正确。
- `editor-manual`：中文/emoji 中间光标的手动替换保持两侧文本且不提交。
- `editor-dismiss`：Esc 取消与焦点变化不修改草稿、不调用 provider。
- `editor-source`：运行 `node .agents/skills/verify-context-broker/scripts/control.mjs run notion-editor`（实际 `node scripts/verify-native-ui.mjs --notion`），验证`notion/ui-alpha`自动候选、胶囊与手动搜索。CLI源为受控executable，真实Tern/OMP提交；不能宣称远端Notion或Pi UI通过。
- `editor-pi`：Pi 独立终端的自动候选、接受和提交另按[Pi 终端规程](../../verify-notion-skills-integration/features/dollar-completion-selection.md#pi-独立终端)运行，保留实际按键、终端画面和 provider。Pi 普通文本引用与 Tern/OMP 胶囊的行为分别核对；Adapter 改动时同时验收两种编辑器，不由 Tern 结果推断 Pi。
- `editor-lifecycle`：既有 `verify-daily-notion-ui.mjs --mode captured --invocation dollar --lifecycle --lifecycle-selection alias@namespace` 覆盖首个进程在 source metadata 成功前只输入一个 `$`，放行后不重输即出现实际候选，再细化前缀；还覆盖同进程 `/new`、保留 conversation 的 `/restart`、退出后的新进程。selection 须取自已知真实候选，重名时包含 page ID。metadata gate 只属 controlled scheduling，正常日常 source 另跑；不新增 harness。
- `editor-catalog-cache`：`node scripts/verify-native-ui.mjs --catalog-cache` 从另一进程预置过期目录，再延迟 source list 六秒；真实菜单须在远端完成前出现，方向键选中的 identity 在刷新后不变，Tab 只改草稿、provider 增量为零；提交正文一份，下一次查询采用新目录。`--catalog-cache-failure` 则在新进程首次只输入 `$`，后台 list 返回 `NOTION_REQUEST_FAILED` 后旧候选仍可选择，提交正文一份，下一次查询仍保留旧目录；完整断言与证据见[美元补全地图](../../verify-notion-skills-integration/features/dollar-completion-selection.md)。
- `builtin-three-surfaces`：Tern Pi terminal、Tern OMP terminal、OMP native GUI 分别选择随包 `$ntn-skills-maintain@builtin`，检查正文、相对资源、实际 CLI 指引及多来源身份。选择只改草稿，宿主原生 slash/file 补全继续可用。
- `maintenance-workflow`：普通 Agent 加载内建 Skill 后经实际 CLI 完成一次内容变更并回读，保留原话、图片与原操作。已退役 `/ntn-skills save` 不再是入口或验收项。
- `host-frozen-driver`：三 surface 统一复用 `scripts/verify-tern-surfaces.mjs`，`scripts/tern-surface-spec.mjs --config /absolute/config.json --out /absolute/new-directory` 生成冻结 spec。`run` 仅允许 `magpie/group/e2e`；`controlled` 使用本地交付 provider，结论仅为 driver 校核。环境通过明确 `hostEnvNames` 从当前进程传入，禁止复制 token 到 spec、脚本或终端命令。版本与 SHA 从实际 executable 采集。候选用 `candidate.identity` 精确匹配当前完整树节点并保留候选 JSON，不以 Tab 默认首项作为身份验证。每步固定 `id` 对应 tree/shot，失败 manifest 的 `verdict.stage` 与 `--resume` 保留已通过的独立 case；request/event 断言按 case reset 后计数。

## How to get to it (user POV)

- 在 OMP composer 输入 `$` 或 `$prefix`，方向键选候选，Tab/Enter 接受，Esc 关闭。
- 在 Tern 的本地 OMP pane 输入 `$prefix`，按 Ctrl+Alt+Shift+K，搜索并选择候选。
- 用退格、撤销以及提交操作胶囊，或关闭手动搜索后继续编辑。

## Driving it with control.mjs

Preconditions:

- macOS、Tern 0.8.3+、OMP 18.10.3+、Node.js 22.x 中的 22.22.3+，或 24.20.0+、仅用于构建的 Bun、tar；Tern 的已有 OS 登录可用。
- `bun run build` 生成查询产物；`control.mjs doctor editor` ready。
- 原生 runner 创建独立 daemon、window、config；禁止对用户已有窗口发送 ctl。
- 宿主身份与目录覆盖的回归复用[注入地图](injection.md)的 global-config runner；不要为 Adapter 单独建立第二套功能地图。

- **完整原生路径。** 执行 `node .agents/skills/verify-context-broker/scripts/control.mjs run editor`。runner 解包 Tern archive 并通过 `tern plugin install` 安装，启动自己的 daemon/window，等待 shell/OMP editor 后输入 `中文😀正文$ui-a`、Tab 接受，退格整项删除，Ctrl+Z 撤销；继续接受 `$ui-ro` 后提交。provider 收到 `$ui-alpha`、`$ui-router`，正文/Router block 各一份。
- **胶囊内点击。** Tab 接受后，从当前 `.sf-editor .sf-t-strong` 取得胶囊文字边界，分别点击宽度的 35%、65%、90% 位置。检查 `.sf-caret` 确实位于胶囊文字内部、草稿未变、`.sf-overlay .sf-item` 为空。光标会拆分文字 span，后续点击沿用首次取得的边界。`shots/live/chip-caret-no-dropdown.png` 保留最终状态；随后继续原有删除、撤销和新补全路径。
- **长名称与边界。** `editor` runner 输入 `$notion-` 查询三个长名称，检查宽菜单和名称列；接着在正文末尾和 620 像素宽窗口打开候选，检查菜单保留 pane 内边界，再恢复 1280 像素窗口确认原生 `/` 菜单仍使用原宽度。证据为 `wide-dollar-menu.json`、`shots/live/wide-dollar-menu.png`、`wide-dollar-right-edge.png`、`wide-dollar-narrow.png`。
- **重复。** 再次接受并提交 `$ui-alpha`，第二次 provider 请求仍各只有一份已加载上下文。
- **手动 Unicode 替换。** 草稿 `前文😀$ui-a tail`，光标位于 `$ui-a` 末尾；Esc 关闭自动候选，Ctrl+Alt+Shift+K 打开 `Search Context Broker content (insert token only)`。Enter 选中后插入该记录的完整身份 token，保留 `前文😀` 与 ` tail`，provider 请求仍为两次。
- **取消与焦点。** `$ui-` 手动搜索后 Esc，草稿不变；`$ui-a` 手动搜索后点击当前 `.sf-editor` rect，picker 关闭、文本不变、provider 无新请求。
- **句柄。** runner 使用 `tern ctl --control <本次socket> tree .sf-editor`、`tree input`、`key`、`type`、`shot`。传给 `type` 的文字采用 JSON 编码；点击坐标来自当前 rect，不复用历史截图坐标。
- **证据与 teardown。** manifest 指向 `broker-native-ui-*`：`shots/live/automatic-mixed.png`、`manual-picker.png`、`manual-replacement.png` 及 layout JSON，`provider.jsonl`、`sessions`、`owned-processes.json`、`cleanup.json`。检查截图可见正确胶囊与 picker，cleanup stopped 为 true，再运行 `control.mjs evidence`。
- **冷启动与会话矩阵。** 使用[既有 daily lifecycle 规程](../../verify-notion-skills-integration/features/daily-installation-ui.md)。固定完整 source token，不预先 list/read/query；首个早期草稿与截图后才放行真实 CLI metadata。输入前不能等待依赖远端 readiness 的 observer/session_start。每项 `.sf-overlay .sf-item`/`.sf-item.sel`、Tab 后 `.sf-editor .sf-t-strong` 与精确草稿分别留证，接受到提交前 provider+0，提交完整正文一次。`/new` 的 PID 不变/session 改变，restart 保留会话和历史，最后新 PID/会话不经 restart。无菜单则保留 no-menu 截图和失败 stage，不改 alias、重复输入或借 restart 掩盖首项失败。

## Gotchas

- 双插件共存验收使用同一 Tern/OMP 实例：OMP 扩展提供自动下拉和注入，Tern 配套插件只执行手动草稿编辑。自动下拉与手动弹框没有显式互斥；现有手动路径先 Esc 关闭自动候选，未覆盖两个菜单同时打开，不得将共存通过写成任何操作顺序都无冲突。
- UI runner 的确认仅覆盖 Tab 自动接受；用户支持的方向选择、Enter 接受或纯 OMP TUI 若被修改，需补驱动，不能由本路径代替。
- 手动搜索使用配置 roots/catalogs/sources，不继承 system prompt 中隐藏的 Skill。source候选刷新与scope身份另见[source地图](source.md)。
- 当前脚本用 `What are we cooking?` 判断空 composer；宿主文案变化时先检查实际 idle 状态，不因超时就修改业务断言。
- `.sf-editor` 的筛选结果会拼接灰色预测文字。焦点取消检查从完整 `tree` 的 `.sf-ed-text.text` 读取实际草稿，排除 `.sf-ed-ghost`；picker 打开前后与关闭后都必须保持原前缀。窗口缩放后重新读取当前 editor rect，不能沿用启动时的点击坐标。
- companion 通过唯一 config/socket 隔离，但保留进程 PATH 和 OS 登录。不要声称它像 fake-provider CLI 一样隔离全部凭据。
- 源码下的 Tern plugin 缺构建 query 时不能安装；修改扩展用 `/restart`，修改 companion 用 `tern plugin reload`。
- 远端 pane、Tern web client 和非 macOS 原生 runner 未被此路径覆盖。

## AH258–260 shared content acceptance

Exercise Skill/Router/Prompt candidates in Pi and OMP with identity/kind/source/ref preserved through draft edits and exact source selection. Preserve UTF-16 ranges, user text and images. Accepting completion must not submit; mixed-kind submission preserves attachments.

No execution is claimed by this map update; final owner runs and retains the evidence.

## Three surfaces

复用 `scripts/verify-tern-surfaces.mjs` 的 `pi-terminal`、`omp-terminal`、`omp-native` 三个入口和各自 owned spec。OMP terminal 明确使用 `PI_TUI_NATIVE=0`，native 使用 `PI_TUI_NATIVE=1` 并观察实际 `.sf-editor`；Pi 按真实终端画面与按键验证。probe 只检查渲染环境。

本轮覆盖 Skill/Router/Prompt 和三份随包 Skill 的身份选择、正文/资源、Unicode 草稿、删除/撤销、图片、取消及 pane/cwd/session 变化后无过期回写。明确接受后失效的选择得到 not-loaded 反馈；普通未知文本保持原样。手动 picker 插入完整身份 token，自动补全通过宿主接受事件保留身份。

`/ntn-skills` 父子命令树、管理面板与专用 save 桥已退役，不作为发布门槛。真实 Notion 维护由普通 Agent 加载内建 Skill 后调用 CLI；一次任务可含多个工具或模型回合。受控 provider 证明 UI、投递内容与请求次数，真实模型和远端内容分别验证。

每个入口保存候选、接受草稿、提交和结果的实际画面及 provider 观察；选择时无请求，提交正文一次，资源绑定所选快照。未运行或受宿主公共能力限制的项明确记录，不用另一个 renderer 的通过代替。

