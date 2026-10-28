---
name: verify-context-broker
description: "验证 Context Broker 的 Pi/OMP 注入、会话生命周期、随包 Skill 发现与消费、OMP/Tern 原生补全、真实模型效果及独立安装包。修改这些行为、升级宿主或验收产物时使用。"
---

# Verify Context Broker

面向首次接手本仓库的 agent。所有命令从仓库根目录执行；先读 [功能地图](features/README.md)，按改动选择功能，使用已有 harness 驱动真实宿主。Skill 和地图在 `.agents` 下维护，不修改全局 Skill 或用户的运行配置。

缺失引用改动按 [injection 的 Missing-reference regression route](features/injection.md#missing-reference-regression-route) 验收：普通未知文本原样透传；明确接受的引用失效时向用户与模型说明未加载，不能写 loaded 回执；权限、网络与完整性失败仍明确阻断。

## Launch

```bash
bun install --frozen-lockfile
bun run build
```

构建成功应输出 `Built standalone broker query and Tern plugin query`，产物包括 `packages/context-broker/dist/completion.mjs` 与 `packages/tern-context-broker/query/completion.mjs`。依赖已安装且当前改动已构建时不重复安装或构建。构建会更新根 README/CONTRIBUTING/SECURITY/CHANGELOG 的 npm 分发投影，不把生成副本当成另一个文档来源；broker 双语参考在 `packages/context-broker/docs` 直接维护，Tern 双语指南随 GitHub 目录与归档分发。

跨仓开发先构建 CLI，再以 `NTN_SKILLS_BUILD_ENTRY=/absolute/notion-skills-cli/packages/cli/dist/ntn-skills.js bun run build` 构建 Broker。产物内含独立 CLI 与三份完整 Skill/参考资源；正式发布使用依赖中固定的已发布 CLI。无需安装回执、中央 Skill 目录或宿主命令镜像。

本项目没有独立常驻服务器。CLI harness 每次创建临时 HOME、agentDir、sessionDir，加载仓库扩展，在 Pi/OMP 的 print 或 RPC 模式提交真实 prompt。启动器会在 HOME 隔离前解析 Volta 的真实入口，再用 Node 执行 Node CLI；不要把 HOME 改回用户目录来绕过启动问题。

原生 UI 由 `scripts/verify-native-ui.mjs` 启动独立 Tern daemon 和窗口，使用唯一 `control.sock`、`daemon.sock`、`TERN_CONFIG_DIR`、broker config 和 agentDir。就绪条件依次为自有 daemon socket、window control ready、`tern ctl ready` 的 shell prompt、`.sf-editor` 出现。该路径要求 macOS、Tern 0.8.3+、OMP 18.10.3+；它复用 OS 的 Tern 登录和进程 PATH，不能称为无凭据环境。只操作本次 control endpoint，不操作用户已有窗口。

通用 `model` 路径使用已有 OMP 登录与模型配置；Notion integration 的 `--mode model` 默认分别启动 Pi 与 OMP，也可用 `--host pi|omp` 单独执行。Broker 配置、缓存和 session 放在临时目录。只调用 `magpie/group/flash-free`，不主动改用户模型或凭据；成功的实际响应才证明认证可用。两条入口的覆盖范围分别报告。

## Doctor
Harness help is safe before setup: `node .agents/skills/verify-context-broker/scripts/control.mjs --help`, `node scripts/verify-notion-integration.mjs --help`, `node scripts/verify-native-ui.mjs --help`, and `node scripts/verify-pi-pty.mjs --help` exit before creating a run or launching a host. Doctor uses a unique owned temporary HOME and XDG/application roots; its output names retained probe scratch for system-Trash cleanup. It does not prove authentication.


先执行与目标功能匹配的只读检查；任何异常先重跑 Doctor，再查该次证据：

```bash
node .agents/skills/verify-context-broker/scripts/control.mjs doctor editor
```

最后一个参数可为 `injection`、`editor`、`lifecycle`、`model`、`distribution`、`source`、`notion-editor`。Doctor 输出 Node 版本、实际 host executable/arguments、宿主版本、所需工具、平台以及构建产物 hash。要求 `status: ready` 和退出码 0。它不启动会话、不调用模型、不证明认证或功能成功。

CLI/RPC helpers 只用 Node.js 22.x 中的 22.22.3+，或 24.20.0+ 启动；Bun 仅用于构建。CI 使用 Node.js 24.20.0，宿主版本当前为 OMP 18.10.3、Pi 1.2.0、Bun 1.3.14；Doctor 记录本机实际版本，不能把本机通过当成另一版本或远端 CI 的通过。版本不同可做本机验证，但报告差异；宿主升级要重验对应路径。编辑器缺产物先 `bun run build`，缺宿主明确报告，不用别的入口冒充。

## Drive

```bash
node .agents/skills/verify-context-broker/scripts/control.mjs run editor
```

`run` 自动执行该功能的 Doctor，使用现有脚本，串行执行同一功能的所有命令，任一失败停止，并保留本次证据。不要每次都运行全部功能；按地图覆盖所有受本次改动影响的入口。

| 功能参数 | 实际执行 | 能证明什么 |
| --- | --- | --- |
| `injection` | 双宿主 host-e2e + global-config-e2e | 默认 CLI XML、多引用注入、重复、关键词规则、默认 agentDir 配置与持久续接；OMP 使用 RPC 用户输入、Pi 使用 print |
| `editor` | verify-native-ui | 长名称宽下拉与窄窗口边界、自动胶囊、胶囊内点击不弹下拉、删除/撤销、Skill/Router 混合提交与重复、手动 Unicode 替换/取消/焦点变化 |
| `lifecycle` | lifecycle-e2e | 同进程、fork、回退、续接、压缩保留/移除正文与仅标记摘要、XML 示例后首次加载；普通消息上的默认 CLI 引导恢复 |
| `model` | verify-real-model | Skill 指令效果、真实默认摘要器、压缩后再次注入、每个普通请求的一份 CLI XML、实际请求 model selector |
| `distribution` | verify-artifacts + release.test | 安装后运行、独立查询程序与 Luau 依赖完整性、发布检查阻止 commit/tag/push |
| `source` | verify-notion-integration deterministic | source metadata、默认宿主Skill目录、真实read/native /skill、延迟activation、资源与持久续接；受控CLI不证明远端Notion |
| `notion-editor` | verify-native-ui --notion | `$alias@namespace` 的原生自动补全、chip、手动选择与 provider 正文 |

`model` 发起真实网络请求；只在当前任务需要且已有授权覆盖此模型时执行。无授权或登录缺失时完成其余可达路径并记录未运行。`distribution` 的生产依赖安装需要 npm 网络；发布行为只在测试创建的临时 Git 仓库运行。

Notion/source 改动还需读取 [source地图](features/source.md) 和 [跨仓联动Skill](../verify-notion-skills-integration/SKILL.md)。`source` 使用无凭据CLI executable fixture并实际启动双宿主；真实Notion只读、真实模型和独立安装有单独mode，必须分别报告执行情况。

随包内容按 [随包 Skill 地图](../verify-notion-skills-integration/features/builtin-management.md) 复用 `distribution`、`source` 与 `editor`。安装后直接从 `$` 选择三份 `ntn-skills` Skill，明确内建身份使用 `@builtin`。检查完整正文、相对资源、同名来源消歧及实际 CLI/source 指引。

日常 Tern/OMP 的真实 Notion Skill 没出现在菜单时，另用 [日常安装与原生菜单地图](../verify-notion-skills-integration/features/daily-installation-ui.md)：`node scripts/verify-daily-notion-ui.mjs --database UUID --skill-ref skill://PAGE/SKILL.md --mode captured`。该独立入口读取 actual daily source 与 installed broker/companion，在自建 Tern 中验 `/skill:`、`$` 胶囊和手动搜索真实提交；不通过 checkout fixture 代替日常可用性。`--mode model --model provider/model --model-prompt TEXT` 使用当前已授权模型验证显式菜单激活后的正文消费与成功响应；与上述固定模型的通用 `model` route 分别报告。日常配置或 extension 安装变化后已有 OMP 必须 `/restart`。

OMP/Tern 已加载正文消费使用日常 model route 的 `--invocation dollar --model-prompt '介绍这个 skill'`。在新会话接受真实 `$` 胶囊后检查模型直接回答，且实际开放的 `read`/`glob` 未被用于重读入口或确认包清单。Pi 使用独立宿主与原生终端，按[补全地图](../verify-notion-skills-integration/features/dollar-completion-selection.md#pi-独立终端)核对 `$`、原生 `/skill:` 和双向切换；普通文本补全不以 Tern 胶囊验收。资源任务另以 integration `--mode model --host pi` 检查模型自主读取入口和固定快照资源。该检查验证模型行为；源码中的提示和确定性 provider 捕获只能证明投递，不能替代真实模型路径。
Pi terminal automation now has a reusable entry: `node scripts/verify-pi-pty.mjs doctor`, then `node scripts/verify-pi-pty.mjs run`. It starts two cold real PTYs and sends prefix → Tab → task/Enter for `$ui-alpha@notion` and `/skill:notion-ui-alpha`, including both switch directions. The source executable and provider remain controlled fixtures. Doctor refuses unsupported installed Pi flags. An installed broker can be selected with `--extension /absolute/installed/entry`. Evidence is raw terminal bytes and exact key actions, not synthesized screenshots or real-model proof.


修改 Adapter 时复用现有地图。`injection` 核对反向 `CONTEXT_BROKER_HOST` 覆盖后当前宿主协议不变；`source` 核对 cold native、双向 `$`、资源与回执；默认上下文专项和 `--notion-loading` 核对取消与下一次提交。编辑器装配同时使用 `editor` 与 Pi 独立终端规程。只补受影响步骤和观察结果，不为内部重构新增独立 Skill 或复制同一套验收。

扩展改动的代码检查仍用 `bun run check`，编译或单元测试不能代替上述宿主/界面路径。修改 OMP 扩展后使用 `/restart`；`/reload-plugins` 不重新执行已加载扩展。Tern companion 的修改使用 `tern plugin reload`，不能用它代替 OMP 重启。

## Evidence

每次 `run` 输出 `Verification evidence: <绝对目录>`。目录位于系统临时目录，名称以 `broker-verification-<功能>-` 开头，包含 `manifest.json` 和按命令分开的 stdout/stderr transcript。manifest 记录本次功能、Doctor 的实际版本/入口、每条命令、时间、退出码/信号、原始 runner 证据目录；只记录执行过的路径。既有脚本和它们的行为断言负责判定通过，助手不复制这些断言。

清理后执行下面的命令，把最后一个参数换成刚输出的真实绝对目录：

```text
node .agents/skills/verify-context-broker/scripts/control.mjs evidence <本次绝对目录>
```

要求 `status: preserved`。该检查证明命令完成且 transcript/证据目录仍存在，不代替人工阅读截图或核对 provider 内容。

证明标准：

- 对应用户入口 → 实际动作 → 可观察状态变化；不能只截最后一屏或只看 `inject` 日志。
- 补全出现、草稿接受 `$name`、broker 判断、provider 收到正文、模型执行指令分别证明不同环节。明确验到了哪一层。
- 去重计数检查实际 provider messages，正常应有一份正文；不能把会话包含旧正文误报为“重复注入”。
- 用户/助手/工具中的 XML 示例、摘要里的标记都不是正文加载证据。fork/回退/压缩按当前有效上下文判断。
- 确定性 provider 替代的是已有 provider 边界的外部服务。生命周期 fixture 控制摘要内容和保留边界，宿主压缩准备、branch、persist、conversion 仍真实运行；它不证明默认 LLM 摘要器。只有 `model` 的 `fromExtension: false` 和传输证据证明真实默认摘要路径。
- 原生 UI 保留 `shots/live/*.png` 和 `*.layout.json`，结合操作 transcript 与 `provider.jsonl` 判断；手动选择成功还必须证明没有新增 provider 请求。
- 真实模型只记录 selector、fixture canary 计数和状态；不记录请求 URL、header、token。不要把真实用户配置、会话或凭据拷进证据包。
- 独立安装应在解包目录运行；checkout 通过不证明归档完整。未运行 Pi 包安装不能由 OMP 安装结果代替。
- `--dry-run`/`--precheck` 不等于完全无副作用：当前 release 在输出计划前会 fetch/prune tags 和查询 npm。不要在用户工作树运行发布来证明测试；使用临时仓库的 release.test 观察 Git refs 和 push hook。

## Cleanup

原始 runner 在 `finally` 中结束自己启动的 RPC、窗口和 daemon。print 进程应自然退出；RPC 的 SIGTERM/SIGKILL 是行为完成后的主动 teardown，不能冒充自然成功退出。integration 的 `owned-processes.jsonl` 保留实际 spawn/close 事件，cleanup 在每个持有宿主的 close 证据齐全后才回收 scratch。Tern runner 另保留 `host-processes.jsonl`、`omp-pid.json`、`omp-exit.json` 与直接 Tern children 的退出状态；`cleanup.stopped` 由观察到的退出生成。Pi PTY `cleanup.json` 分别记录自然退出、实际 returncode、主动信号及 PTY 关闭；强制退出不能冒充自然成功。

成功和失败均保留证据、session、截图与 scratch fixture。不要按进程名批量 kill，不驱动/关闭其他 endpoint，不在失败后 reset/clean 用户工作树。运行结束但发现自有进程仍在时，核对 `owned-processes.json` 的 PID、command、唯一 socket 后只处理该实例；PID 已复用时不能依据旧记录发送信号。

需要释放磁盘时，先确认 runner 已结束、证据已审阅，再移到经过验证的系统废纸篓。macOS 使用 `/usr/bin/trash <本次绝对目录>`；其他系统先确认回收站实现。禁止永久删除，禁止在 cleanup 删除证据。

## Helpers

唯一新增助手为可执行的 `scripts/control.mjs`，使用方式就是上述 `doctor`、`run`、`evidence`。它按自身路径定位仓库根目录，复用已有 Node runner。Doctor 不探测真实模型认证；run 不安装宿主、不发布、不改全局配置。脚本原始证据格式由对应功能地图说明。
Pi PTY helper 使用 `.agents/skills/verify-context-broker/scripts/pi-pty-driver.py` 与 `terminal_screen.py`（Python 3 stdlib，无新增依赖）。`node scripts/verify-pi-pty.mjs evidence --evidence ABSOLUTE_DIRECTORY` 区分 `functionalStatus` 与证据保留；审阅后 `cleanup --evidence ABSOLUTE_DIRECTORY` 只将关联 scratch 进 `/usr/bin/trash`，再执行 evidence。候选/草稿 `.ansi` 是真实终端增量，`.screen.json` 是完整流经 VT 光标/擦除/滚动处理后的当前字符屏幕；判定当前编辑框前缀及其下选中候选后才发 Tab，再核对接受后的完整草稿，禁止 raw substring 命中启动目录或历史 token 算成功。完整 `terminal.ansi` 与 `actions.json` 一起审阅。Scratch/cwd/TMPDIR 使用无 `.agents` 祖先的系统临时根；`--evidence-root ABSOLUTE_DIRECTORY` 仅控制证据父目录，不改变 Skills 发现范围。父子命令补全、取消/Stop、真实服务与真实模型尚须各自后续场景，不由这一基线推断通过。

Pi 的 ready 要同时满足完整当前帧中空编辑框、fake footer、精确的 `[Skills] notion-ui-alpha` 与后续非空 `[Extensions]`，以及本次 fixture 的 list/read/export-completed 调用和 broker 最终快照 receipt/bytes/hash。`pi_readiness.py` 只读已有 source 调用和已发布快照，不向真实应用注入测试状态；源目录未完成的早期空框不能触发首次输入。保留 `source-readiness.json` 和 source CLI JSONL；不加固定 sleep，两个冷方向仍须实际输入、候选、Tab 和 Enter。

共享 `resolveHost()` 返回可执行 `file`/`prefix`、命令 `path` 与单独 `identity` realpath。普通 shell/shebang/symlink 保留合法命令拼写；Volta 在 HOME 隔离前经 `volta which <basename>` 解析实际入口，简单 Node shebang 才转换为显式 Node argv。installed npm 与绝对 `/usr/bin/trash` 复用该策略，不能直接执行 `volta-shim` identity。


维护时使用 `/maintain-verification-skill`，同时更新地图里的入口、命令和证明边界。UI selectors、宿主协议或脚本变化后，重跑受影响功能，确认清理后证据仍存在。
