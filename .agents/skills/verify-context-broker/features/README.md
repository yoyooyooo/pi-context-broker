# Context Broker 验证地图

从用户入口选择路径，不按哪个脚本最方便来缩小验收。所有命令从仓库根目录执行，先读取 [Skill](../SKILL.md) 的启动、隔离、证据和清理约定。

## Baseline preconditions

- 已安装依赖并完成 `bun run build`；Node.js 22.x 中的 22.22.3+，或 24.20.0+、仅用于构建的 Bun、目标宿主在 PATH。
- 执行 `node .agents/skills/verify-context-broker/scripts/control.mjs doctor <功能参数>`，要求退出 0、`status: ready`，记录实际版本。
- 运行助手每次新建证据目录；原始 runner 每次新建配置、session 和 fixture。不要复用用户正在工作的实例。
- CLI/RPC 在隔离 HOME、白名单环境中用受控 provider；UI 需要 macOS、Tern 登录和原生窗口；真实模型使用已有 magpie 登录。
- 缺工具、平台不符、模型无授权或无登录时，列出未运行入口、尝试的命令和缺失条件，不改成另一入口宣布通过。

## Driving conventions

用 `node .agents/skills/verify-context-broker/scripts/control.mjs run <功能参数>` 运行一组现有脚本。它先 Doctor、保存命令及原始证据路径；不修改 runner 的断言或提供假成功。按改动选择地图，所有受影响的入口都要覆盖。

原生控制使用 `.sf-editor` 和输入框 placeholder 等已有句柄；必须点击时依据当前 rect，不能沿用另一窗口的坐标。`get_state`/`get_messages` 是宿主只读观察，prompt、fork、branch、compact 是原生动作。不能靠直接调用插件内部 setter 证明用户行为。

## Proof and skip reporting

- 记录功能 ID、用户入口、Doctor 版本、执行命令、退出状态、原始证据绝对路径。
- UI 结合截图/layout、操作 transcript、draft 变化、provider 内容与请求数量。
- 注入结合 broker decision、持久 session、每次 provider 正文计数；模型执行还需独立真实模型路径。
- 默认压缩与受控摘要分别报告，不把受控 provider 的 OK 当成模型理解指令的证据。
- run 完成后执行 `control.mjs evidence`，验证 teardown 后证据保留。Tern 核对 `cleanup.json`、`owned-processes.json`、`host-processes.jsonl` 与 `omp-exit.json` 的真实退出。Pi PTY 核对各冷会话 `actions.json`、原始 `.ansi`、`provider.jsonl`、`driver-exit.json` 与 `cleanup.json`。清理不能改变功能 failed/未运行状态。
- 一条路径通过不扩大为全部功能通过。此地图里说明的覆盖边界必须在报告中保留。

## Features

| 功能 | 参数 | 功能地图 |
| --- | --- | --- |
| 发现、规则、默认 CLI XML 指引和注入 | `injection` | [上下文注入](injection.md) |
| 自动补全和手动搜索 | `editor` | [编辑器补全](editor.md) |
| 去重与会话变化 | `lifecycle` | [会话生命周期](lifecycle.md) |
| 指令效果与默认摘要器 | `model` | [真实模型](model.md) |
| 安装产物与发布门禁 | `distribution` | [分发和发布](distribution.md) |
| Notion source与默认宿主Skill、持久 Read 记录与 preparation 提交锁 | `source` | [Source发现与激活](source.md) |
| Notion 勾选项默认目录与后台预取 | 独立 `verify-notion-integration.mjs --default-context true` | [默认上下文与后台预取](../../verify-notion-skills-integration/features/default-context-prefetch.md) |
| Notion CLI 正文缓存、跨会话/进程复用与远端修改 | 独立 `verify-notion-integration.mjs --mode live-fixture --cache-lifecycle true` | [会话缓存与恢复 NS-SESSION-09～12](../../verify-notion-skills-integration/features/session-cache-recovery.md) |
| Notion 跨项目/宿主共用目录与导出、共享刷新与会话固定版本 | 独立 `verify-notion-integration.mjs --mode deterministic --shared-catalog true` | [共享缓存 NS-SESSION-13～15](../../verify-notion-skills-integration/features/session-cache-recovery.md#共享-notion-缓存)；真实 Pi/OMP + 受控 source/provider |
| Notion原生补全与手动选择 | `notion-editor` | [跨仓补全地图](../../verify-notion-skills-integration/features/dollar-completion-selection.md) |
| Pi 原生终端候选、草稿、提交与双向切换 | 独立 `verify-pi-pty.mjs doctor\|run` | [Pi 独立终端](../../verify-notion-skills-integration/features/dollar-completion-selection.md#pi-独立终端)；真实 PTY + 受控 source/provider，不能证明 live Notion/模型 |
| 日常安装的真实 Notion 菜单与消费 | 独立 `verify-daily-notion-ui.mjs --mode captured\|model` | [日常安装与原生菜单](../../verify-notion-skills-integration/features/daily-installation-ui.md) |
| 随包 Skill 发现、正文和资源消费 | `distribution`、`source`、`editor` | [随包 Skill](../../verify-notion-skills-integration/features/builtin-management.md) |

查询排序/namespace/Router 规则等逻辑还应执行已有 `bun run check`。该检查不证明界面、真实模型或远端 CI。产品新增入口时，更新对应地图，不默默将其并入旧入口的通过结论。

日常安装路径复用实际 HOME/agentDir 和既有认证，在自建 Tern daemon/window 中复制日常 installed companion、正常自动加载日常 installed broker；不遵循 fixture runner 的临时 broker config。使用独立入口时按该地图记录实际版本、路径/hash、原生菜单与消费证据；不由 `control.mjs source/notion-editor` 的通过代替。

随包 Skill 验收使用隔离配置与独立安装产物；三个包内 Skill 应在未安装中央 Skill 的情况下可发现、加载和读取资源。用户已有同名 Skill 保留独立身份。
