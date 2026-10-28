# 上下文发现与注入

用户在 prompt 中点名 Skill/Router 或匹配关键词规则，Context Broker 将上下文附加到当前会话；重复点名时不会追加第二份正文。

## Sub-features

- `inject-dollar`：中文/emoji 正文中连续两个 `$name` 都加载，第二次提交保持每个正文一份。
- `inject-rules`：默认 agentDir 下的 config/rules 生效；两个 roots 含同名 Skill 时只消费首个 root 的正文，关键词加载第一项，后续 `$name@local` 加载第二项。global-config runner 同时将 `CONTEXT_BROKER_HOST` 设为另一宿主，仍须使用当前宿主的提交与正文协议。
- `inject-discovery`：alias、Router 优先、namespace、显式 `router:` 规则由现有逻辑回归覆盖。
- `inject-persistence`：跨进程 `--continue` 保留已加载记录，单一持久会话。
- `inject-source`：配置source后默认宿主目录只含metadata；首次read、native /skill或$触发完整snapshot，provider可见正文。执行 `node .agents/skills/verify-context-broker/scripts/control.mjs run source`；CLI fixture不证明真实Notion，live走[source地图](source.md)。
- `inject-loaded-omp`：OMP/Tern 的完整 Skill 正文满足使用前读取要求；自然的技能介绍不应再次列缓存目录、读入口或包清单，资源任务仍可按提供目录读取参考文件。日常真实 `$` 入口使用[日常安装地图](../../verify-notion-skills-integration/features/daily-installation-ui.md)的 model dollar 路径，观察实际工具行为；仅检查 payload 文案不能证明模型行为。Pi 保留宿主原有提示，真实发现与资源消费走[source 地图](source.md)的独立 model 路径，终端选择另走[Pi 终端规程](../../verify-notion-skills-integration/features/dollar-completion-selection.md#pi-独立终端)。
- `inject-cli-guidance`：Pi/OMP 默认加入 `<ntn-skills-guidance>`；包含真实 CLI argv、精确读取与固定版本子文件/help 入口，不预加载正文。同一有效上下文及跨进程续接仅一份；host runner 同时检查实际 provider 与持久消息。

## How to get to it (user POV)

- Pi 或 OMP 输入 `$design-context`；引用可紧接正文，多引用可出现在一条 prompt。
- 在 broker config 指定 roots/catalogs，通过 alias 或规则关键词请求上下文。
- 输入 `$router-name`，或命中配置中的显式 `router:<name>` 规则目标。
- 重新启动宿主时加 `--continue`，继续已保存会话。

## Driving it with control.mjs

Preconditions:

- Node.js 22.x 中的 22.22.3+，或 24.20.0+、仅用于构建的 Bun、Pi、OMP 可执行；`control.mjs doctor injection` ready。
- 配置、Skill 和模型 fixture 由 runner 创建，不读取用户的全局 broker 配置。

- **双宿主提交与续接。** 执行 `node .agents/skills/verify-context-broker/scripts/control.mjs run injection`。OMP 使用 RPC 用户输入，Pi 使用 print；随后退出并 `--continue` 再次提交 `中文😀先使用$design-context，再用$review-context。请一起评审`。两次 provider 上下文中的两个 fixture marker 与完整 CLI 指引都分别恰好一份；持久会话只有一条 CLI 指引，decision 为一次合并注入、随后两条 already-loaded skip。OMP print/bootstrap 不替代用户输入边界的激活验收。
- **默认配置、规则与宿主覆盖。** 同一命令随后执行 global-config runner，OMP 走 RPC 用户输入，Pi 走 print；也可独立运行 `node packages/context-broker/scripts/context-broker-global-config-e2e.mjs`。两宿主分别将 `CONTEXT_BROKER_HOST` 设为另一宿主，保留显式 agentDir；两个 roots 提供同名且正文不同的 Skill，先提交 `load first`，再继续并提交 `$second-context@local`。第一份正文两次都只有一份，第二份第一次为零、第二次为一，后置 root 的两个 marker 均不得进入 provider；session 中恰好两个 broker custom message。覆盖项只影响默认路径，不能改变当前宿主的提示、输入返回或资源指引。编辑器装配另按[编辑器地图](editor.md)的 Tern 与 Pi 入口验收；本路径不证明 UI。
- **发现与 Router。** 执行 `bun run check` 覆盖 alias/ranking/Router index/规则类型/隐私边界。原生 Skill/Router 混合提交另走 [编辑器地图](editor.md)。逻辑回归通过不能声称 Pi/OMP 所有 Router 入口均已实际驱动。
- **证据。** manifest 指向 `context-broker-host-e2e-*` 与 `context-broker-config-e2e-*`：每个 host 下的 `provider-context.jsonl`、`decisions.jsonl`、`sessions/*.jsonl`。确认只有真实 `.jsonl` 被计入，锁文件不能当 session。结束后运行 `control.mjs evidence` 核对 transcript 和证据目录仍在。

## Gotchas

- 在 fixture HOME 中直接运行 Volta shim 可能递归。使用已有 harness 的真实入口解析，不取消 HOME 隔离。
- 已加载正文仍随有效会话发送；skip 不是 provider 中正文为零。
- `$` 自动补全与提交注入是两个入口，发现成功不证明注入成功。
- `/context-broker` diagnostics 是观察入口，host runner 没有实际驱动它的全部子命令；命令改动需单独驱动受影响命令并保存输出。
- Router 只提供成员索引；不能把成员 Skill 全文出现当成 Router 正常注入结果。
- 已选记录的权限、网络、目录不完整、响应及完整性失败仍显式失败。明确接受的记录返回 typed target-not-found 时，保留原用户材料与其他成功上下文，同时写入用户可见和模型可见的 not-loaded 说明；该说明不是 loaded 回执。普通未知文本不触发 source read。
- 本地记录与 source 同名时，补全使用 `$name@local` 与 `$name@namespace`；裸名按歧义拒绝且显示候选引用。`node scripts/verify-native-ui.mjs --name-collision` 验证本地与 source 胶囊实际提交、所选正文、local 不触发 source read/export，以及裸名拒绝时不新增 provider 请求。

## AH258–260 shared content acceptance

Router cleanly replaces domain Router in config/types/catalog/UI/payload/session markers, with explicit historical asset conversion only. Inject Router own body/member index/resources, never members automatically. Prompt enters each explicit submission user-task content and never system/native/default/auto context. Skill/Router loaded state follows active identity context; same-name records remain independent.

No execution is claimed by this map update; final owner runs and retains the evidence.

## Missing-reference regression route

Use the existing dual-host injection/source routes above and the integration [selection map](../../verify-notion-skills-integration/features/dollar-completion-selection.md#missing-reference-regression-route); extend owned fixtures rather than inventing a runner flag. In each Pi/OMP surface submit literal `$bunfs/root/chunks/cli-nxfh2cp0.js`, unknown bare alias, `$unknown@notion`, `$unknown@unknown-source` and `$unknown-source/unknown` both alone and mixed with valid Skill/Prompt/Router selectors. Preserve exact Unicode text and real images. Submit two rounds: one provider dispatch per accepted round, valid records prepared once per round, Skill/Router active-context deduplication and fresh Prompt task content on the second round; Router member bodies remain absent.

Unknown literal aliases require no missing-reference toast, source read/export or cross-source fallback. Accepted exact selections require visible not-loaded feedback and model context on typed not-found; an exact manual token absent from the catalog reports catalog-unavailable without inventing a remote response. Preserve original text/images and other loaded content, and never mark a missing item loaded. Repeated context in one submission emits no duplicate explanation; a later submission can retry. Permission/network/incomplete/integrity failures still produce zero dispatch. Exercise Stop/Escape and session changes during delayed preparation, then require zero late dispatch and a successful next draft. A next draft's accepted choice must survive the prior turn ending. Bootstrap text, escaped references and fenced examples remain non-activating.


