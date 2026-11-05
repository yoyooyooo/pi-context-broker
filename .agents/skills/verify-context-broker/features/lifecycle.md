# 会话去重与生命周期

同一有效上下文中避免重复正文；fork 保留正文时跳过，回退/压缩移除必要正文后从对应固定版本恢复，保存并续接保持分支判断。Pi 的 selected、visible 与 active 分别验证；下方旧 OMP runner 的范围保持不变。

## Sub-features

- `session-repeat-fork`：同进程重复与原生 fork 后正文保持一份。
- `session-rewind`：回退到首次加载前，再调用重新注入。
- `session-persist`：`--resume` 与 `--continue` 打开已保存 session，不重复加载。
- `session-compact`：压缩保留正文 skip，移除正文 inject；摘要仅有 XML 标记也 inject。
- `session-xml`：普通消息中的 XML 示例不能抑制首次加载。
- `session-cli-guidance`：普通 baseline 即收到默认 CLI XML，重复/fork/回退/续接的实际 provider 请求均完整且恰好一份。压缩保留时复用；移除或仅剩标记摘要时，在不含 Skill 引用的下一条普通消息上恢复。
- `session-source`：source的正文加载、export snapshot和host metadata index有独立生命周期；执行 `node .agents/skills/verify-context-broker/scripts/control.mjs run source` 观察双宿主续接。CLI错误/超时/coldwarm恢复见[联动会话地图](../../verify-notion-skills-integration/features/session-cache-recovery.md)。本地图旧lifecycle runner不证明Notion source的fork/compact分支。
- `session-pi-active`：实际 Pi 分支存储 active receipt 与 C/S/R；inspect/ready 不激活，完整 visible 加同轮未取消的 2xx headers 才确认。普通消息保留 active；全文缺失时合并固定 roots 恢复一次，之后普通消息不重复准备。Prompt 按每次显式调用处理，不按 Skill 常驻去重。
- `session-pi-print`：Pi 1.4 的首次 `-p` 与 `--continue` 实际 stdout 都是完整 assistant 输出；延迟 `$`／Prompt 正文以公开 `context_edit` 保存在本次真实 user 的模型投影中，原始 user、图片和 assistant/tool 配对不改，最终有效消息仍为 assistant。

## Pi 的分支与实际 provider 验证

[本轮运行时记录](../../../../packages/context-broker/docs/skill-consumption-runtime.md)给出冻结包与逐层证据。实际 SessionManager 的 `packages/context-broker/scripts/session-active-session.mjs` 通过 14 项，`session-short-ref-session.mjs` 通过 13 项及 5 个独立 resume；这些证明状态，不独立证明 provider 内容。`scripts/notion-startup-flow.mjs` 的实际 RPC/PTY 10 项包含 compaction 后独立 resume、固定 inspect 恢复、下一轮无额外准备，以及取消后迟到 2xx 不发布 active。

完整原生 main read 的 v3 receipt 证明源文本是准确完整前缀，允许保留随后的 body-free S/R 目录；部分 read、资源回执、摘要与伪标签不能替代主文。去重只变换当前 provider 投影中的已验证正文跨度，保留原始 JSONL、toolCallId 与 metadata footer。2xx headers 不是响应流完成；默认模型摘要和正式真实 Agent 任务另留证，不能从受控 compaction 推断。

延迟 `$`／Prompt 投影的持久化使用 Pi 公开生命周期：`after_provider_response` 只确认已接受的交付；同一会话、generation 和 signal 仍有效且 `turn_end.outcome=completed` 时，返回当前实际 user 的 `context_edit` 与 machine-only `context-broker` proof，同时保留其他扩展已有的 boundary drafts，不请求额外 provider。proof 复用 `nativePromptSha256` 与原 delivery spans，旧本地 skillRoots 身份元数据也绑定到该精确摘要。下一轮只在公开 `buildSessionProjection()` 已实际包含该 proof 时推进持久化计数；其他扩展丢弃 drafts 不能导致正文漏投。

恢复读取只使用当前分支、经过 compaction 的公开 projection／context，不能从 `getEntries()` 全历史找回已移除正文。machine proof 仅在对应完整 user 投影仍在当前上下文时生效，且不会进入 provider 输入。已取消、错误、未收到成功响应、迟到或回退到其他分支的边界不写入；后续 source 恢复继续依据已有 active 固定版本，Prompt 仍按显式调用处理。`notion_use` 与 native read 的原生 tool result 不走此延迟持久化路径。

原 `context-broker-smoke.mjs` 的历史加载正例也必须提供该合同：单记录与部分已加载场景使用 Pi `buildSessionProjection()` 的对应 `entries`／`messages`，多记录场景保留 OMP `buildSessionContext()` 路径。原 skip／部分注入断言不变；sibling 负例仍以空有效 context 加其他分支的 `getEntries()` 证明全历史不能抑制加载。2026-11-05 统一 C4 检查已保留旧夹具失败：`unified-c4-e1f7-m585ghan/check.log`（位于 `~/Library/Logs/pi-context-broker/AH-617-20261105/`），SHA256 `876761f87b7ef91507cec857df802362c6e0a2aca9be3799f28c51fa2b093f79`；该次检查的后续消费／安装门禁未执行。

同一提交的远端 CI run `42072328437`／job `127403934820` 也在第一个旧正例 `smoke:476` 失败；完整原日志 `unified-c4-e1f7-m585ghan/ci-e1f7-job-127403934820.log` 共 95,647 bytes，SHA256 `1e9fa4eb8923f7d8cda1669869750c179f95dece3f0a6e7d552ca756233c89da`。三个夹具迁移后仅重跑原 smoke，`smoke-fixture-fix/smoke.log` SHA256 `724d681727082bfd88c9d81ebd5915d3ce1df4ea575f5a553ddab2a7868c945f` 通过；完整 check 和独立候选在该修复提交后继续，不能把此单项结果填成安装通过。

## How to get to it (user POV)

- 重复提交同一个 `$name`。
- 使用宿主 fork 或选择历史消息回退，再提交相同引用。
- 通过压缩命令整理历史，再调用该 Skill。
- 退出后用 `--resume <session>` 或 `--continue` 续接。

## Driving it with control.mjs

Preconditions:

- Node.js 22.x 中的 22.22.3+，或 24.20.0+、仅用于构建的 Bun、OMP；`control.mjs doctor lifecycle` ready。
- 本路径只验证 OMP；Pi 的跨进程重复由 [注入地图](injection.md) 覆盖。

- **完整生命周期。** 执行 `node .agents/skills/verify-context-broker/scripts/control.mjs run lifecycle`。runner 提交 baseline 与 `$lifecycle-context`，再重复；RPC `fork` 创建不同 session 文件但正文不重复，`branch` 回退后正文为零，再次 prompt 变为一。
- **持久续接。** runner 主动结束 RPC，再分别 `--resume` 与 `--continue` 打开保存的 session；`get_state` 核对 sessionFile，provider 正文依旧一份。
- **Pi 原生 print。** 执行 `node packages/context-broker/scripts/context-broker-host-e2e.mjs pi`；完整注入入口仍为 `control.mjs run injection`。前者连续启动实际 Pi `-p` 与 `--continue`，每轮 stdout 必须含预期 `OK`，每轮 provider 中两份选中 Skill 各只有一份完整正文。随后用该 executable 对应安装包的公开 SessionManager 读取实际 session，核对 raw user 未改、唯一 edit 指向第一次真实 user、最后模型消息为 assistant、原两条身份 receipt 与 projected user 的 digest 一致。`native-projection.json` 记录该模块路径/hash及投影；不能只用 session 里的 assistant 文本替代 stdout。
- **三个压缩边界。** 原生 RPC `compact` 分别保留正文、移除正文、只保留 XML marker 摘要；`get_messages` 确认压缩后正文为 1/0/0，再提交引用后三者都为一，decision 分别 skip/inject/inject。
- **CLI 引导恢复。** 同一路径检查当前有效消息中的 `ntn-skills-guidance`。keep/remove/marker 压缩后分别为 1/0/0；先提交不含 Skill 引用的普通消息，确认完整指引恢复为一，再验证 Skill 正文的独立重载。该路径使用真实 OMP 压缩及受控摘要，不代表真实模型自主调用 CLI。
- **普通 XML。** 先提交包含 `<context-broker-record>` 的普通示例，provider 中 fixture 正文为零；真正调用后为一，再调用仍为一。
- **证据。** manifest 指向 `context-broker-lifecycle-e2e-*`，含 `fork-branch-resume`、`compact-keep`、`compact-remove`、`compact-marker`、`ordinary-xml` 子目录；每个有 `provider-context.jsonl`、`decisions.jsonl`、`sessions`。核对动作顺序、正文份数、决策与实际保存的文件。RPC stop 已等退出，再运行 `control.mjs evidence`。

## Gotchas

- 摘要 fixture 通过宿主公开 compaction hook 选择保留边界；本路径证明真实宿主的准备/会话变更/持久化/请求转换，不能证明默认 LLM 摘要器。
- 默认摘要效果另见 [真实模型地图](model.md)。普通 XML 不是正文，摘要 marker 不等于已加载证据。
- RPC 帧可大于 64 KiB，不能换成有固定行长限制的解码器。
- print 自然退出与 RPC 主动 stop 是不同完成标准；SIGTERM 不单独证明行为通过。
- Pi `-p` 首次与 `--continue` 必须实际输出完整预期 assistant 文本；session 内存在 `OK` 不能代替 stdout。`context-broker-host-e2e.mjs` 在断言前保存每端 `first-stdio.json` / `continued-stdio.json`、原始 provider/session/decisions、真实 executable identity 与 owned process spawn/close；OMP 另保存每轮 RPC/lifecycle，不把未观察的 stderr 填零。失败仍保存顶层 `result.json`，不降低输出断言。
- CI 与 Publish 的 `Native CLI host regressions` 失败时，上传这一步创建的 `/tmp/context-broker-host-e2e-*`、`context-broker-config-e2e-*`、`context-broker-lifecycle-e2e-*` 受控证据，保留 7 天。上传或 preserved 只保留原失败，后续未执行的安装门禁仍为未执行；证据不存在时报告 warning。
- 2026-11-05 c66 远端 job 127376933166 的 Pi 首轮 empty stdout 已在本机原 harness 复现。增强留证后的原件 `/tmp/context-broker-host-e2e-103jxB` 显示 stdout/stderr 均空且退出 0，provider 1 次、session 先 assistant OK 后 context-broker custom message；Pi 1.4 print 仅打印最终 assistant 消息，因此这是实际用户输出失败。对应 log `/private/tmp/ah676-native-host-diagnostic-dgiizmtm/run.log` 的 SHA256 为 `77a2b32fa5592faa688cba6ebad7bfdbeb5a3b03ded00511aed061d5f426d1e2`。修复后原 Pi print/continue 已通过，日志 `/private/tmp/ah676-pi-print-after-qwvzviis/run.log` SHA256 `55753496d0f206aa702f22b00625529c41355191b8c98072e5957ff942b115ba`；启动取消／迟到／压缩恢复四项的日志 `/private/tmp/ah676-print-startup-recovery-jz27uipk/run.log` SHA256 `1367cc1e9ce89c355f1074a35364993b1cc96fed44d5ae2af7c2511e4292d9a2`。这些是当前源码加真实宿主、受控来源／provider 的证据，不代表最终独立候选、真实模型或日用切换通过。
- 同批最终双宿主门禁包含上述原生投影断言，日志 `/private/tmp/ah676-print-final-p4_b2j7y/hosts.log` SHA256 `cb79f8716bc50c599eb0e365e3ee0942e128efc2322c8471b9dfe6b5da5f3d96`；`native-projection.json` 在 `/tmp/context-broker-host-e2e-zlK58k/pi/`。对应原 `session-active`／`native-read-session`／`host-prepare` 三组 43 项通过，另有 typecheck 与 OMP 全 lifecycle；实际默认 SDK 独立包仍须在统一候选上复跑受影响的 `$`／恢复路径。
- 不在用户正在编辑的 session 上 fork/branch/compact；只操作 runner 创建的临时会话。

## AH258–260 shared content acceptance

Each accepted submission owns invocationId/sessionId/generation and an identity-keyed prepared snapshot set. Preflight/task/final dispatch use one fixed snapshot; next Prompt submission must invoke again. Cancel/timeout/session changes abort preparation and reject late dispatch without consuming a new submission. Preserve original text and images.

No execution is claimed by this map update; final owner runs and retains the evidence.

