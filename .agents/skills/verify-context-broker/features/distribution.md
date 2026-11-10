# 独立安装与发布门禁

用户安装 npm broker 或 Tern 归档后，运行入口及依赖应完整；发布检查失败不能产生发布 commit、tag 或 push。

## Sub-features

- `package-runtime`：npm tarball 解包、生产依赖安装后能加载所选 Pi 或 OMP 扩展，连续请求正文各一份；各宿主单独留证。
- `package-query`：npm/Tern 两个独立 Node 查询程序能解析中文 alias、UTF-16 编辑范围且不返回 Skill 正文。
- `package-closure`：Tern manifest、Luau 依赖、独立 query、CLI/SDK/runtime manifest 和三份随包 Skill 的完整参考资源都在归档中；Broker 与 Tern 的三份消费运行时文件逐字节相同，不含退役的 builtin.luau/save-workflow。
- `package-docs`：npm/Tern 双语 README、broker 参考和贡献指南的本地链接与章节锚点在解包后可达。
- `release-gate`：检查失败阻止 commit/tag/push；成功且 `--no-push` 只产生本地 tag；规划模式不执行检查。
- `package-desktop`：独立 Tern 插件安装后的实际界面由 [编辑器地图](editor.md) 覆盖。
- `package-source`：`node scripts/verify-notion-integration.mjs run --mode installed --host pi --package /absolute/pi-context-broker.tgz` 在独立临时 prefix 安装指定归档，实际 Pi 加载安装后的扩展并消费 source。先 `doctor --mode installed --host pi` 带同一 `--package`；省略 `--host` 才执行双宿主。旧 positional `installed` 仍为 parser 的显式兼容，当前规程统一推荐 `--mode`。未运行时不能用源码 source 结果代替，详见[安装消费地图](../../verify-notion-skills-integration/features/installed-consumption.md)。
- `package-sdk-pi`：原 artifact runner 以明确 fixture 驱动同一独立安装包的默认 SDK all14，再以 distinct-names fixture 验两条名称与失败来源场景，以独立 ambiguous-names fixture 验歧义错误候选的复制和消费；实际 Pi RPC、provider serializer HTTP、完整正文、目录、资源和会话终局一起验收。

## How to get to it (user POV)

- 从 npm 安装 `pi-context-broker`，由 Pi/OMP 加载其 extension；运行 `context-broker-complete`。
- 下载对应 GitHub Release 的 Tern 归档，解包后通过 `tern plugin install /absolute/extracted-directory` 安装。Git 源码目录用于开发，需要先完成构建。
- 维护者运行 `bun run release patch`，或者使用 `release:check`/`--dry-run` 查看计划。

## Driving it with control.mjs

Preconditions:

- Node.js 22.x 中的 22.22.3+，或 24.20.0+、仅用于构建的 Bun、精确 Pi 1.4.0 或 1.5.0、npm、tar；完整双宿主路线另需 OMP 和 Git。其它 patch／预发布／未知版本仍拒绝。npm registry 网络可用。
- `control.mjs doctor distribution-pi` ready；完整路线用 `doctor distribution`。runner 构建并打包当前 checkout，或消费明确提供的候选目录；不调用仓库的真实 release，不创建线上发布。

- **Pi 安装路径。** 运行 `node .agents/skills/verify-context-broker/scripts/control.mjs run distribution-pi`，对应 `node scripts/verify-artifacts.mjs --host pi`。只构建 Broker npm 包，在独立 prefix 实际安装；核对随包 CLI、SDK 与 runtime manifest 后，用实际 Pi RPC 和 provider 观察连续两次正文交付，重跑安装态 source 故障与恢复场景。manifest 的 host 为 pi，OMP/Tern 记 notRun。未提供 SDK fixture 时，`defaultSdk` 明记 `not_run / fixture_not_provided`，不代表默认 SDK 已验收。
- **完整路径。** 运行 `node .agents/skills/verify-context-broker/scripts/control.mjs run distribution`。该路线分别执行 `verify-artifacts.mjs --host pi` 和 `--host omp`，再执行 release tests；OMP 路线另打包、解包 Tern。npm 只安装生产依赖且跳过 install scripts/peer 自动安装。每个宿主的两次真实 prompt 分别要求 provider 中正文恰好一份，不能互代。
- **独立查询。** 两份 query 从仓库外独立 Node 进程接收 `中文😀\n使用 $架构 tail`，返回身份限定的 `$design-review@…@local` 与正确 UTF-16 from/to/len；结果无私有 body marker；拆开 emoji surrogate 的 cursor 以非零退出。
- **默认 SDK 闭包。** 未配置凭据的 Notion source 在两份独立 query 中都应返回 `AUTH_REQUIRED`，同时保留本地候选；`SOURCE_SDK_UNAVAILABLE` 不是此正例的替代结果。2026-11-05 远端 run `42091391270` 的 Pi 两版本门禁通过，后续 Tern query 因归档缺少 SDK/runtime manifest 在该断言失败；原日志保存在 `~/Library/Logs/pi-context-broker/AH-617-20261105/pi15-compat-tyqr9arj/remote-ci/job-127470034246.log`（SHA256 `6648406e56d165f477f6f1ed3cfc1116a33a1b401a2e998d549d598927b2f45d`）。修复复用同一构建循环分发 CLI、SDK 和 manifest，原 closure 在启动宿主前核对三份文件；仍须实际运行 query 的凭据拒绝和原 artifact 路径，不能只凭文件存在声称可消费。保护已有 Tern staged 改动时，在明确 owned 的源码导出目录执行完整构建，不能在用户工作树运行会覆盖 query 的全量构建。
  本机修复后已在 `sc26-tern-sdk-z8jbdh6k/` 保存原 artifact 全路径与 7 项 pack 定向测试结果：实际 OMP `18.16.0` 的 8 次受控 provider 请求、两个独立 query 和 source 故障/恢复均通过；Tern 随包 SDK/manifest 与 Broker 逐字节相同。重建的 Broker 归档仍精确为 `85888eeda4683ba53c79b84640839220a4162d8902a8ed321d30ba9fd4e42d3e`，86 项发布文件不变。原 Tern staged 字节保持；保留 owned 源码导出、安装、session 与 runner 的真实 teardown。该本机结果不能替代 CI 固定 OMP `18.10.3` 的后续结果，也不代表 Tern 桌面或 Pi 真实模型验收。
- **文档导航。** 解包后从 npm 的双语 README、双语参考和贡献指南、Tern 的双语 README 递归检查本地链接与标题锚点，防止下沉文档漏包或投影仍指向 workspace。线上链接与实际 Markdown 呈现需另行核对，不由文件存在替代。
- **发布行为。** 同一命令执行 `node --test scripts/release.test.mjs`。它创建临时 repo 与本地 bare remote、受控 registry 回复及检查命令，观察 commit count、tag、remote refs、拒绝 push 的 hook。检查失败无发布 refs；成功 `--no-push` 有正确版本的 annotated tag，原 main 不变；规划模式未执行 gate。
- **证据。** manifest 指向 `broker-artifacts-*`，含 `archives`、`npm/package`、`tern`、`provider.jsonl` 和 session；release tests 的各个 `pi-context-broker-release-*` 保存 repo/remote.git 与 gate.json。transcript 保留所有断言结果，完成后执行 `control.mjs evidence`。
- **桌面安装。** 本路径仅检查 Tern 文件完整与查询能力；需要证明真实插件装入窗口并能交互时再执行 `run editor`。`verify-native-ui.mjs` 的 `BROKER_UI_EXTENSION` 只选择 Broker 扩展，companion 仍从当前已构建 checkout 重新归档；不能称为直接消费此前冻结的同一 Tern tar。日常 UI runner 使用日常 installed companion，是另一条来源边界。

- **随包消费。** 冷安装在显式启用 Notion source 后公布三份 `@builtin` 候选，连接暂不可用也保留离线设置工作流；未启用时不公布。选择正文后可读取相对参考文件。两份产物的 Skill 库存一致，同名本地/Notion 内容可以精确消歧。复用现有包/宿主检查。
- **补全身份。** 只有已启用 Notion source 时才公布随包工作流。它们的 `$name@builtin` 与包内完整 identity/ref 一起核对；本地及远端候选保留精确身份限定格式。不可仅凭 `@builtin` 后缀接受普通本地文件，也不可用三段 token 的旧断言拒绝合法随包候选。

## 默认 SDK 的 CI 安装门禁

原生 `context-broker-host-e2e.mjs` 的 fixture 只有本地 Skill，没有 Notion source。
Pi 的首次及继续会话都必须保持零 Notion guidance、目录与工具，两个本地正文仍各一份。
OMP 保留原有 guidance 行为；不能为了让旧断言通过而给 Pi fixture 增加 Notion source。
已启用来源的目录和 guidance 仍由下述实际 SDK 场景单独验证。

实际 provider 将 Broker 的临时目录消息转换成 user 文本。验证器通过原生最终
context 的 customType、PID、请求顺序及完整内容摘要绑定这份文本，再核对 SDK
返回的完整 View。普通 user 文本和工具参数中的同名标签不能取得这份证明。
安装态 HTTP 重放必须再次核对相同字节，不能把宿主内部观察当成已发送请求。

CI 与 publish 从同一精确 CLI commit frozen install/build，再使用该 checkout 的原 `scripts/sdk-fixture.ts --outdir NEW_ABSOLUTE_DIRECTORY --catalog` 生成受控 fixture。原 all14 fixture 使用 `$RUNNER_TEMP/ntn-skills-sdk-fixture`；第二份追加 `--distinct-names`，写到 `$RUNNER_TEMP/ntn-skills-name-fixture`；第三份追加互斥的 `--ambiguous-names`，写到 `$RUNNER_TEMP/ntn-skills-ambiguity-fixture`。第三份保持各记录的 owner、正文与 Requires，只让 a/c 的名称和 alias 相同，不把 foreign 记录加入权威目录。artifact 分别接收 `--fixture`、`--name-fixture`、`--ambiguity-fixture`，并开启 `--require-sdk`。缺少声明的 fixture 必须在打包或启动宿主前失败，不能退成通用安装路线。普通安装路线的 optional fixture 不改变 CI 的必跑要求，`check-gates` 同时拒绝 producer 漏接、路径漏传、条件跳过、吞掉失败或缺失原件上传。

人工复跑时，`CLI_CHECKOUT` 指向同一固定版本的 CLI 源码，`CLI_ENTRY` 指向完整 CLI 安装入口，`CANDIDATE_DIR` 只含冻结候选，三个 `SDK_*FIXTURE_ROOT` 均为不同的、新的仓外绝对目录：

```bash
node "$CLI_CHECKOUT/scripts/sdk-fixture.ts" --outdir "$SDK_FIXTURE_ROOT" --catalog
node "$CLI_CHECKOUT/scripts/sdk-fixture.ts" --outdir "$SDK_NAME_FIXTURE_ROOT" --catalog --distinct-names
node "$CLI_CHECKOUT/scripts/sdk-fixture.ts" --outdir "$SDK_AMBIGUITY_FIXTURE_ROOT" --catalog --ambiguous-names
NTN_SKILLS_BUILD_ENTRY="$CLI_ENTRY" CONTEXT_BROKER_CANDIDATE_DIR="$CANDIDATE_DIR" \
  node scripts/verify-artifacts.mjs --host pi --fixture "$SDK_FIXTURE_ROOT/fixture.json" --require-sdk \
    --name-fixture "$SDK_NAME_FIXTURE_ROOT/fixture.json" \
    --ambiguity-fixture "$SDK_AMBIGUITY_FIXTURE_ROOT/fixture.json"
```

runner 复用刚刚独立安装的同一个 `installed` 路径，调用原 `notion-sdk-pi.mjs run --scenario all`，随后显式执行 `name-references`、`name-reference-failed-source` 和独立的 `name-reference-ambiguity`，不再次打包。`defaultSdk` 保留14景，`namedSdk`保留原两条名称场景，`ambiguitySdk`单列实际错误候选→复制入口→read/use；对应 fixture 未提供时分别明确 not_run。每项保存 fixture/driver、plan/result 路径与 hash、真实退出和终局。所有 plan 必须保持同一 package、bundled runtime 和开启的全部断言，每一景都须通过且 observer 已关闭。候选必须进入实际 provider，不能只藏在 details；歧义阶段不得准备正文或 active。完整目录取得成功后的同步消歧错误，与实际 SDK 请求失败分别计账，不能把所有 failed list 放过。两 workflow 无论成功失败都上传 owned 安装目录、SDK scratch 和三份 fixture（含隐藏文件）。Linux 保留 scratch，不调用 macOS Trash。身份与逐来源归因见[安装消费地图](../../verify-notion-skills-integration/features/installed-consumption.md)。

CI／publish 主宿主固定为 Pi 1.5.0，CLI producer/build 在两份 workflow 中钉同一完整 SHA；该输入包含 C7 的共享目录名称解析、薄 files/manifest SDK，以及原生成器的 opt-in 歧义 fixture。`check-gates` 返回实际 `cliSourceRevision`，禁止以同一 package version 替代源码/产物身份。CI 追加 owned npm prefix 的 Pi 1.4.0：先核实际 version，复跑原 native print／continue，再对主 artifact manifest 指向的同一独立安装目录执行原 SDK all14、原两条 names 和独立歧义场景。主步骤使用 Bash pipefail 保留完整日志，只在 `defaultSdk`、`namedSdk`、`ambiguitySdk` 均通过后从唯一 manifest 导出 installed 路径。兼容步骤不重新 pack、不重复整个 CLI/check，也不能用源码路径顶替；两宿主 SDK 与 native 原件均 always 上传。Publish 保持单 job，不使用版本 matrix 重复发布。

历史 C6 commit `6415836c5910528ddf4aef95346dec2537943013` 修复公共 replace 的精确等值文件/metadata 处理，并将原独立作者与 unknown 恢复门禁接入 package smoke；当时 SDK 与 C5 `5125f418d51bc59f55ed248a26503403451113e6` 逐字节等价、CLI bundle 身份更新。该历史等价不扩展到 C7，任何阶段都不能用同一 package version 冒充同一产物。

这条路线使用离线暖 fixture、owned 空 Broker cache/session、实际 Pi 与受控 provider；每个报告必须写明实际版本。允许版本通过 Doctor 只表示可执行，必须保留该版本自己的 artifact/all14、native print／continue 与 PTY Stop／retry 结果，才能证明兼容。旧 Pi 1.4 证据不能替代新 Pi 1.5，旧 `66a64` 包的 1.5 版本拒绝原件继续保留。它不覆盖真实 Notion、真实模型或日用切换。默认目录与恢复边界详见[原 SDK 恢复地图](../../verify-notion-skills-integration/features/session-cache-recovery.md)。2026-11-05 的漏接线负例保存在 `/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/unified-c4-0f0b02-wj9ya_hr/ci-sdk-wiring/fail-before.log`，SHA256 `5412df3aa56f96ce512131125b03e00cfccf2d911956b6893c0fb798e4504ecd`；原 workflow 未变时新门禁报 `GATE_SDK_FIXTURE_MISSING`，旧门禁误绿记录同时保留。

远端 run `42080157508` 在 workflow 解析阶段拒绝 job env 中的 `runner.temp`，jobs 与 check runs 均为空，安装门禁没有运行。错误 HTML/API 原件保存在同一证据根的 `remote-8c2a7f6/`。按 [GitHub context availability](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability)，runner context 用于 step；生成和消费 fixture 直接使用 runner 提供的 shell 变量，上传 action 的 step with 仍可使用 `runner.temp`。原 `check-gates` 增加 job/全局位置误用 runner context 的负例；本地 gate 通过后仍须回读远端实际 job。

2026-11-05，C5＋e9 候选归档 SHA256 `85888eeda4683ba53c79b84640839220a4162d8902a8ed321d30ba9fd4e42d3e` 已分别通过实际 Pi 1.5.0／owned 官方 Pi 1.4.0 的原 artifact 必跑 SDK 路线，两个 all14 的每景和 observer 终局均通过。证据根 `~/Library/Logs/pi-context-broker/AH-617-20261105/pi15-compat-tyqr9arj/` 的 `actual-artifacts.json` 绑定两个独立安装目录，report hashes 分别为 `ada1c8b8ca5a9980f8c9642a02f418e6f8e3f173b40b2f949f06aa0e1a4887b6` 与 `5008f0942121068064807855fa5ceec437f7813e6d9b638545020cbae1e874cf`；每个原 SDK Evidence → Cleanup → Evidence 已完成。两版本原 native print／continue 均输出两次 OK，Pi 1.5 的原 PTY `escape-stop` 通过实际预算提示、Stop、子进程取消、provider 为零、重试完整交付与自然退出，日志 SHA256 `c3d9f7d402c5be1dfcdcc4a077485a4736881000480f115c05b92ca53b8711ed`。PTY 使用明确 custom command 受控源；不代表默认 SDK 取消或真实模型。此次两个 lifecycle 均未自然命中初始化 list 取消；其终局动作通过不能改写旧 Linux null metrics 失败，仍需保留 C5 SDK 初始化窗口实测与后续 CI 实际结果。此处没有给旧冷启动 native `/skill` 菜单分支补写通过，也没有切换日用安装。

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
