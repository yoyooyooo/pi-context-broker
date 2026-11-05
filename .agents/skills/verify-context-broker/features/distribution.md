# 独立安装与发布门禁

用户安装 npm broker 或 Tern 归档后，运行入口及依赖应完整；发布检查失败不能产生发布 commit、tag 或 push。

## Sub-features

- `package-runtime`：npm tarball 解包、生产依赖安装后能加载所选 Pi 或 OMP 扩展，连续请求正文各一份；各宿主单独留证。
- `package-query`：npm/Tern 两个独立 Node 查询程序能解析中文 alias、UTF-16 编辑范围且不返回 Skill 正文。
- `package-closure`：Tern manifest、Luau 依赖、独立 query、CLI 和三份随包 Skill 的完整参考资源都在归档中；不含退役的 builtin.luau/save-workflow。
- `package-docs`：npm/Tern 双语 README、broker 参考和贡献指南的本地链接与章节锚点在解包后可达。
- `release-gate`：检查失败阻止 commit/tag/push；成功且 `--no-push` 只产生本地 tag；规划模式不执行检查。
- `package-desktop`：独立 Tern 插件安装后的实际界面由 [编辑器地图](editor.md) 覆盖。
- `package-source`：`node scripts/verify-notion-integration.mjs run --mode installed --host pi --package /absolute/pi-context-broker.tgz` 在独立临时 prefix 安装指定归档，实际 Pi 加载安装后的扩展并消费 source。先 `doctor --mode installed --host pi` 带同一 `--package`；省略 `--host` 才执行双宿主。旧 positional `installed` 仍为 parser 的显式兼容，当前规程统一推荐 `--mode`。未运行时不能用源码 source 结果代替，详见[安装消费地图](../../verify-notion-skills-integration/features/installed-consumption.md)。

## How to get to it (user POV)

- 从 npm 安装 `pi-context-broker`，由 Pi/OMP 加载其 extension；运行 `context-broker-complete`。
- 下载对应 GitHub Release 的 Tern 归档，解包后通过 `tern plugin install /absolute/extracted-directory` 安装。Git 源码目录用于开发，需要先完成构建。
- 维护者运行 `bun run release patch`，或者使用 `release:check`/`--dry-run` 查看计划。

## Driving it with control.mjs

Preconditions:

- Node.js 22.x 中的 22.22.3+，或 24.20.0+、仅用于构建的 Bun、Pi 1.4.0、npm、tar；完整双宿主路线另需 OMP 和 Git。npm registry 网络可用。
- `control.mjs doctor distribution-pi` ready；完整路线用 `doctor distribution`。runner 构建并打包当前 checkout，或消费明确提供的候选目录；不调用仓库的真实 release，不创建线上发布。

- **Pi 安装路径。** 运行 `node .agents/skills/verify-context-broker/scripts/control.mjs run distribution-pi`，对应 `node scripts/verify-artifacts.mjs --host pi`。只构建 Broker npm 包，在独立 prefix 实际安装；核对随包 CLI、SDK 与 runtime manifest 后，用实际 Pi RPC 和 provider 观察连续两次正文交付，重跑安装态 source 故障与恢复场景。manifest 的 host 为 pi，OMP/Tern 记 notRun。
- **完整路径。** 运行 `node .agents/skills/verify-context-broker/scripts/control.mjs run distribution`。该路线分别执行 `verify-artifacts.mjs --host pi` 和 `--host omp`，再执行 release tests；OMP 路线另打包、解包 Tern。npm 只安装生产依赖且跳过 install scripts/peer 自动安装。每个宿主的两次真实 prompt 分别要求 provider 中正文恰好一份，不能互代。
- **独立查询。** 两份 query 从仓库外独立 Node 进程接收 `中文😀\n使用 $架构 tail`，返回身份限定的 `$design-review@…@local` 与正确 UTF-16 from/to/len；结果无私有 body marker；拆开 emoji surrogate 的 cursor 以非零退出。
- **文档导航。** 解包后从 npm 的双语 README、双语参考和贡献指南、Tern 的双语 README 递归检查本地链接与标题锚点，防止下沉文档漏包或投影仍指向 workspace。线上链接与实际 Markdown 呈现需另行核对，不由文件存在替代。
- **发布行为。** 同一命令执行 `node --test scripts/release.test.mjs`。它创建临时 repo 与本地 bare remote、受控 registry 回复及检查命令，观察 commit count、tag、remote refs、拒绝 push 的 hook。检查失败无发布 refs；成功 `--no-push` 有正确版本的 annotated tag，原 main 不变；规划模式未执行 gate。
- **证据。** manifest 指向 `broker-artifacts-*`，含 `archives`、`npm/package`、`tern`、`provider.jsonl` 和 session；release tests 的各个 `pi-context-broker-release-*` 保存 repo/remote.git 与 gate.json。transcript 保留所有断言结果，完成后执行 `control.mjs evidence`。
- **桌面安装。** 本路径仅检查 Tern 文件完整与查询能力；需要证明真实插件装入窗口并能交互时再执行 `run editor`。`verify-native-ui.mjs` 的 `BROKER_UI_EXTENSION` 只选择 Broker 扩展，companion 仍从当前已构建 checkout 重新归档；不能称为直接消费此前冻结的同一 Tern tar。日常 UI runner 使用日常 installed companion，是另一条来源边界。

- **随包消费。** 未配置 source 的冷安装可发现三份 `@builtin` 候选；选择正文并读取相对参考文件。两份产物的 Skill 库存一致，同名本地/Notion 内容可以精确消歧。复用现有包/宿主检查。

## Pi 正常日用身份与 SDK 来源归因

`scripts/verify-pi-daily-installation.mjs plan|run --config ABSOLUTE_CONFIG.json` 是正常 autoload 的只读前置检查。`plan` 不启动 Pi；`run` 仅在配置给出的正式包已处于日用 settings 槽位时执行，不替换 source.command、不通过 `-e` 注入目标 Broker、不切换安装。配置的原 archive/CLI 身份之外还必须给 `embeddedSdkSha256`，同时核对 bundled runtime 清单和实际字节。

startup/find 的来源必须实际走 bundled SDK `list`；显式 doctor 的 CLI 子进程和它允许的正文探测独立计账。被动 SDK 操作结果必须完整，host HTTP 必须通过相同 PID、method/status/bytes 和独立响应 request ID 与 SDK attempt 一一对应；缺失、重复或不匹配的 request ID 仍是 unknown。其它插件 HTTP、CLI descendants、SDK HTTP 分开归因。保留原始 RPC、生命周期与每个 owned 进程的终局，再核对 settings、安装文件和 shim 未变化。

该入口仍不执行 provider 或消费工具，因此不能独自关闭 SC24。2026-11-05 的归因改动已有 12 项定向正反例；尚未以最终日用安装实跑。真实日用新会话、完整正文/资源交付和任务结果须在统一候选后另留证据，不把此元数据检查或受控 lifecycle 的 pass 扩大为日用验收。

## Gotchas

- `verify-artifacts.mjs` 缺省仍选 OMP；本批 Pi 候选必须显式使用 `--host pi` 或 `distribution-pi`。Pi 源码 host 回归不等价于独立安装通过，OMP/Tern 结果也不填补 Pi 的未运行格子。
- 正式 Tern 归档必须自带 query/runtime/Skill 资源；冷安装不得借用 checkout、全局 CLI 或旧中央 Skill 目录补齐缺失内容。
- artifact runner 默认会重建当前查询和文档投影；给 `CONTEXT_BROKER_CANDIDATE_DIR=/absolute/candidates` 时复用其中唯一的 Broker npm 候选，OMP 路线另需 Tern 归档，不重新打包。`NTN_SKILLS_BUILD_ENTRY` 选择一个完整 ntn-skills 包的 CLI 入口，SDK 必须来自同包；保留输入 CLI/SDK 及生成 bundle 各自的 bytes/hash。记录实际包与安装入口 hash；不要与源码/构建更新并行，让版本归属明确。
- `release --dry-run` 与 `--precheck` 在返回计划前仍会 fetch/prune tags 和查询 npm；`--no-push` 仍会创建本地 release commit/tag。只用临时测试 repo 验证发布行为。
- 本地测试不是 npm Trusted Publishing、线上 release 或远端 CI 成功的证明；需分别回读对应真实结果。
- Linux CI 的 soft-miss 回归保留明确 owned 的临时目录并打印路径；仅在 macOS 调用系统 Trash。2026-11-05 的 d6c5f490 CI 曾在 cleanup 调用 `/usr/bin/trash` 时因 Linux ENOENT 中止，导致后续 consumption/安装门禁未执行；原日志 `/private/tmp/ah676-d6-ci-job-127356509204.log`（SHA256 `f0121d295af87e9c60c29d71a64ac67979105a1510845e0645b3dc79ff40fa02`）保留。必须回读修复后的远端运行，不能把本地 check 代替它。
- 保留证据仓库，不执行永久删除、git clean/reset 来清理。
