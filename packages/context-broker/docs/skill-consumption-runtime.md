# Pi Skill 消费运行时：SDK、短引用与有效指令

## 当前 next 单轨入口

本次调用者对照、已保留失败及分层验证见[新消费入口迁移记录](notion-consumption-contract-2026-11-05.md)。

Pi 注册 `notion_list({query?, source?, limit?, cursor?})`、`notion_use({ref, refresh?})` 和原生 `read`。list 只返回候选元数据，`count`/`has_more` 表示当前查询分页，`coverage` 单独报告来源完整性；未知覆盖为 null，不把空页解释为完整空目录。`ref` 可为一个返回引用或一起需要的多个根。use 一次准备根与完整 Requires，read 只检查主文或精确资源，未选 Members 不读正文。普通本地 Skill 保留 Pi 原生路径。

完整目录与 Default View 通过随包 `listCatalog` SDK 复用 core 查询和缓存。Skill/Router、Prompt 及有预算的预取统一进入 `consume`；首次物化主文并保留完整 File 目录，子文件沿准确绑定按需读取。`source.command`、CLI prepare/read 与完整 export 消费路径已删除，旧 SDK capability 缺失直接失败。管理和 doctor 保留配对 CLI。OMP/Tern 延后；本文历史结果不代表其当前可用性。

`notion_use` 使用 Pi 的 `exposure: model-only`、`defaultActive: true`，只允许模型顶层调用。`notion_ctl` 为 `deferred`、默认不激活，按需导出固定 canonical ref 或显式 CLI source。旧 `skill_prepare` 会话回执仍按原验证规则读取，历史 toolName 和正文不重写。内部返回、摘要、截断和只落盘不形成完整外层交付；正式边界仍由实际 provider 的完整正文和有效证明决定。

被动 `context-broker.notion-sdk` 观察目录/正文操作及安全请求指标；私有验证驱动可显式订阅 `context-broker.notion-sdk-result` 取得同一调用 ID 的实际返回值。默认运行不订阅原文结果，metrics 不含凭据或正文。现有消费专项包含新工具、分页/覆盖、旧版本回执和 SDK 缺导出反例；安装态、真实 Notion/模型与双机验收另留每次产物身份，以下历史结果不自动升级为新合同结果。

## 消费不写远端

Pi `read` 与 `notion_use` 不公开 `readOnly`。携带该旧参数时，无论值为 true 或 false，都在 I/O 前返回 `INVALID_ARGUMENT`。随包 SDK v2 不接收这个参数，当前消费恒零语义写入，不通过首次读取 retention/adoption 或写 Records。旧选择缺少所需本地字节时，明确获取当前候选并重新选择，不承诺远端历史恢复。

SDK 与构建 manifest 必须具备匹配的消费能力，缺失时在操作前拒绝；旧 `source.command` 同样在配置入口拒绝。此边界由 `notion-sdk.test.ts` 的无 readOnly 能力门槛和当前独立安装 HTTP 检查验证，不依赖用户选一个保护开关。

version-1 `effects` 只包含 `version`、`remote_writes` 和 `author_content`。确认零写时必须是 `none` 与 `unchanged`；缺失或不完整的观察保守报告 `unknown`，后续零写结果不能覆盖它。旧 `retained` 状态和 `retention` 字段均拒绝，包括空数组。`notion_use`、原生 read 和注入的效果文字保留原正文 span；多源失败与取消继续携带本轮已观察的结果。实际 SDK 写入拒绝边界、HTTP 记录和 `host-prepare.test.ts` 等回归共同验证零写，不能仅凭输出字段宣称通过。

资格、固定选择和交付的有限边界见 [consumer-state Skill](https://github.com/yoyooyooo/pi-context-broker/blob/next/.agents/skills/verify-notion-consumer-state/SKILL.md)。模型不证明 SDK 的实际 HTTP、serializer 或 LLM 最终回答；这些按 [integration Skill](https://github.com/yoyooyooo/pi-context-broker/blob/next/.agents/skills/verify-notion-skills-integration/SKILL.md) 单独验收。

## 当前工作集预算与显式释放

按需发现 `notion_ctl` 后，使用下面的互斥操作。工作集范围为当前 Session 分支确认的 Notion 指令图，不包含普通本地 Skill、所有聊天文本或模型总 token。

| 操作 | 参数 | 结果 |
| --- | --- | --- |
| 查看 | `{"working_set":"show"}` | roots、Required-only 节点、固定 ref、正文 bytes、当前可见 bytes、历史独立版本 bytes、预算和可释放根 |
| 设置预算 | `{"working_set":"budget","max_bytes":65536}` | 后续 use 在提交前检查已有活跃图与完整新闭包的去重并集；超限整次拒绝 |
| 关闭预算 | `{"working_set":"budget","max_bytes":null}` | 取消此分支明确设置的限制 |
| 释放根 | `{"working_set":"release","roots":["准确固定根引用"]}` | 停止应用这些根，仅移除不再被其他根需要的闭包节点 |

预算单位为 UTF-8 bytes，不是 token。`history.unique_instruction_bytes` 只统计此分支曾确认的独立内容版本，不冒充 Session 文件大小。`visible_instruction_bytes` 根据公开投影中真实完整正文计算；unknown 不是零。默认预算为 null，无自动淘汰。当前实现选择明确限制和释放，让完整 Requires、固定版本和任务语义保持可判断；没有根据压缩标签或最近读取时间推测技能已不再需要。

从 show 复制固定 canonical ref，或使用属于本分支的 selected `sr:S`。未固定候选、别的来源/分支、刷新前的旧 ref 不得释放当前新版本；Required-only 节点必须通过拥有它的根释放。已完全释放的同一固定根重复操作无副作用。释放后的根若仍被其他根需要，继续作为 Required-only 节点存在。

释放追加分支事件并退休正在准备的旧代次，不删除历史消息、snapshot、物化文件，也不写 Notion。下次 provider 投影移除已释放指令；完整源正文和原 toolCallId 仍保存在原始 Session。resume、fork、rewind 和 compaction 只按有效祖先事件恢复；显式再 use 可以重新激活相同固定版本。已确认的历史投递不变成“从未投递”。

缓存容量和工作集大小分别管理。Core 的当前容量策略覆盖它明确列出的可重建 derived SQLite 数据；Broker 的固定导出/物化目录属于外部保护域，不由该策略自动清除。工作集释放不表示回收磁盘，逻辑容量下降也不表示 SQLite 主文件已经缩小。

## 首次连接到 Pi

`/context-broker connect SOURCE ENTRY --config /absolute/config.json` 先返回预览、选中的文件和 `preview_sha256`；返回的命令带 `--apply SHA`，只对同一原始配置和 source 生效。可使用 JSON 双引号包住含空格的路径，也可显式设置 `CONTEXT_BROKER_CONFIG`。不依据配置搜索层级猜测要修改的文件。

同 ID、同 entry 的已启用 Notion source 为幂等结果；冲突 ID/namespace、同 entry 重复来源、符号链接、过期预览都会拒绝。已有其他设置保留，并保留修改前的配置副本。现有文件使用摘要复核后替换，结果明确标记它不是跨任意外部编辑器的原子 compare-and-swap。

结果的 `configuration_saved` 仅确认本地 source 配置。`remote_library:not_verified`、`pi_connection:reload_required`、`body_read:not_observed` 分开保留；用准确文件启动新 Pi，再由 doctor、notion_list、read 或 notion_use 逐层观察。介绍 Skill 用 read；应用已授权工作流用 notion_use；重复普通提问复用当前完整正文；同 owner/snapshot 的已知资源使用一次 read paths 批读。公共 CLI 的 `--metrics` 只增加观测，不改变授权或成功语义。

## 当前会话引用与投递

`sr:C` 是当前目录候选；`sr:S` 是本分支固定主文；`sr:R` 是属于该选择的精确资源。引用只复制公开返回值，不能拼接路径或按名称推断。引用不是授权，每次消费仍检查当前Source、scope与物理owner。不同来源、分支或固定字节不能因同名而合并。

目录、ready/prepared、selected、visible与active分别判断。准备完整不代表已进入provider；session details、loaded标记和摘要也不能替代实际完整正文。普通续问复用当前有效上下文；fork/resume/rewind/compact只恢复当前分支合法绑定，只有摘要时按原固定选择恢复必要正文。

取消或新epoch退休旧任务。迟到SDK结果、headers或provider响应不能复活被取消的选择。明确refresh取得完整新选择后才替换旧pin；失败不延长当前资格。元数据缓存使用原validated_at，刷新正文被拒绝后不能绕过持续权限失败。

普通openai-completions的wire结果还要求Node Undici实际发送实体与本run绑定的摘要一致。2xx只说明收到响应头，不证明流完成、模型任务或最终wire。已知摘要不一致时不能确认active/selected/persisted；已发送body仍记dispatched。in-process mock和无法归属的并发请求保持明确的logical-only/unknown边界。

## 当前验证入口

[Broker Skill](https://github.com/yoyooyooo/pi-context-broker/blob/next/.agents/skills/verify-context-broker/SKILL.md) 按变化路由到现有check、当前SDK/安装与实际Pi助手；[integration](https://github.com/yoyooyooo/pi-context-broker/blob/next/.agents/skills/verify-notion-skills-integration/SKILL.md) 绑定同一CLI/SDK与真实decoder；[consumer-state](https://github.com/yoyooyooo/pi-context-broker/blob/next/.agents/skills/verify-notion-consumer-state/SKILL.md) 维护已有模型和守卫。

`bun run check:broker` 与独立安装/current HTTP不能替代AH-1063的实际日用配置、真实Notion、Pi/provider/model结果。原生终端专项本轮未验收，OMP/Tern延期。旧CLI fixture、双宿主启动与历史版本恢复流程已退出当前地图。
