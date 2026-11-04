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

## Pi 的分支与实际 provider 验证

[本轮运行时记录](../../../../packages/context-broker/docs/skill-consumption-runtime.md)给出冻结包与逐层证据。实际 SessionManager 的 `packages/context-broker/scripts/session-active-session.mjs` 通过 14 项，`session-short-ref-session.mjs` 通过 13 项及 5 个独立 resume；这些证明状态，不独立证明 provider 内容。`scripts/notion-startup-flow.mjs` 的实际 RPC/PTY 10 项包含 compaction 后独立 resume、固定 inspect 恢复、下一轮无额外准备，以及取消后迟到 2xx 不发布 active。

完整原生 main read 的 v3 receipt 证明源文本是准确完整前缀，允许保留随后的 body-free S/R 目录；部分 read、资源回执、摘要与伪标签不能替代主文。去重只变换当前 provider 投影中的已验证正文跨度，保留原始 JSONL、toolCallId 与 metadata footer。2xx headers 不是响应流完成；默认模型摘要和正式真实 Agent 任务另留证，不能从受控 compaction 推断。

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
- **三个压缩边界。** 原生 RPC `compact` 分别保留正文、移除正文、只保留 XML marker 摘要；`get_messages` 确认压缩后正文为 1/0/0，再提交引用后三者都为一，decision 分别 skip/inject/inject。
- **CLI 引导恢复。** 同一路径检查当前有效消息中的 `ntn-skills-guidance`。keep/remove/marker 压缩后分别为 1/0/0；先提交不含 Skill 引用的普通消息，确认完整指引恢复为一，再验证 Skill 正文的独立重载。该路径使用真实 OMP 压缩及受控摘要，不代表真实模型自主调用 CLI。
- **普通 XML。** 先提交包含 `<context-broker-record>` 的普通示例，provider 中 fixture 正文为零；真正调用后为一，再调用仍为一。
- **证据。** manifest 指向 `context-broker-lifecycle-e2e-*`，含 `fork-branch-resume`、`compact-keep`、`compact-remove`、`compact-marker`、`ordinary-xml` 子目录；每个有 `provider-context.jsonl`、`decisions.jsonl`、`sessions`。核对动作顺序、正文份数、决策与实际保存的文件。RPC stop 已等退出，再运行 `control.mjs evidence`。

## Gotchas

- 摘要 fixture 通过宿主公开 compaction hook 选择保留边界；本路径证明真实宿主的准备/会话变更/持久化/请求转换，不能证明默认 LLM 摘要器。
- 默认摘要效果另见 [真实模型地图](model.md)。普通 XML 不是正文，摘要 marker 不等于已加载证据。
- RPC 帧可大于 64 KiB，不能换成有固定行长限制的解码器。
- print 自然退出与 RPC 主动 stop 是不同完成标准；SIGTERM 不单独证明行为通过。
- 不在用户正在编辑的 session 上 fork/branch/compact；只操作 runner 创建的临时会话。

## AH258–260 shared content acceptance

Each accepted submission owns invocationId/sessionId/generation and an identity-keyed prepared snapshot set. Preflight/task/final dispatch use one fixed snapshot; next Prompt submission must invoke again. Cancel/timeout/session changes abort preparation and reject late dispatch without consuming a new submission. Preserve original text and images.

No execution is claimed by this map update; final owner runs and retains the evidence.

