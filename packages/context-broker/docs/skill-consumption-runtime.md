# Pi Skill 消费运行时：SDK、短引用与有效指令

## 当前 next 单轨入口

本页维护当前消费、会话与投递合同。公开配置见[英文参考](reference.md)和[中文参考](reference.zh-CN.md)，具体运行状态保留在对应 Issue/PR。

Pi 注册 `notion_list({query?, source?, limit?, cursor?, refresh?})`、`notion_use({ref, refresh?})` 和原生 `read`。list 只返回候选元数据，`count`/`has_more` 表示当前查询分页；`coverage` 报告来源完整性，`freshness.sources` 独立报告原始验证时间、当前年龄、时限、策略和过期状态，未知观察为 null。完整覆盖不代表刚验证过，不把空页解释为最新完整空目录。创建后验证发现或要求最新目录时可用 `refresh:true`：指定 source 只刷新该配置来源，省略则刷新全部已启用配置来源，离线策略不变。它不改变当前回合或已采用的 root/Requires 版本；分页游标跨刷新失效，不能与 `refresh:true` 合用。`ref` 可为一个返回引用或一起需要的多个根。use 一次准备根与完整 Requires，read 只检查主文或精确资源，未选 Members 不读正文。普通本地 Skill 保留 Pi 原生路径。

用户点名询问某个 Notion Skill 是否存在或可用时，Agent 必须把名称作为 `query` 调用 `notion_list`，并设置 `refresh:true`。已有会话、先前查到或没查到、默认 View 已显示该名称，都不能省略这次核验；仍遵守用户明确指定的来源。查询只读元数据，保留已选 root/Requires 的固定版本。存在性与声明用途直接依据返回的元数据回答；用户要求检查或采用指令时，再读取或使用正文。只有当前新鲜且完整的查询才能说明搜索范围内未找到可用项；离线、过期、失败或部分结果不能证明当前不存在。 未找到只针对可用目录，不能据此推断物理 Notion 页面不存在。普通关键词搜索继续遵守既有 TTL；此规则由模型判断用户意图，不在宿主里匹配自然语言关键词。

完整目录与 Default View 通过随包 `listCatalog` SDK 复用 core 查询和缓存。Skill/Router、Prompt 及有预算的预取统一进入 `consume`；首次物化主文并保留完整 File 目录，子文件沿准确绑定按需读取。`source.command`、CLI prepare/read 与完整 export 消费路径已删除，旧 SDK capability 缺失直接失败。管理和 doctor 保留配对 CLI。OMP/Tern 的当前验收范围单独报告。

`notion_use` 使用 Pi 的 `exposure: model-only`、`defaultActive: true`，只允许模型顶层调用。`notion_ctl` 为 `deferred`、默认不激活，按需导出固定 canonical ref 或显式 CLI source。旧 `skill_prepare` 会话回执仍按原验证规则读取，历史 toolName 和正文不重写。内部返回、摘要、截断和只落盘不形成完整外层交付；正式边界仍由实际 provider 的完整正文和有效证明决定。

被动 `context-broker.notion-sdk` 观察目录/正文操作及安全请求指标；私有验证驱动可显式订阅 `context-broker.notion-sdk-result` 取得同一调用 ID 的实际返回值。默认运行不订阅原文结果，metrics 不含凭据或正文。现有消费专项包含新工具、分页/覆盖、旧版本回执和 SDK 缺导出反例；安装态、真实 Notion/模型与双机验收另留每次产物身份，旧运行结果不自动升级为新合同结果。

## Choosing a tool and waiting for the CLI

用户要求按某个 Skill 完成任务时，用 `notion_use({ref})` 准备根与完整 Requires；
只介绍、比较或检查内容时用 `read({path})`，不把 `ref` 当作 read 参数。只读任务
也可能需要采用指令，但选择指令不授权执行命令、写入或委派。复用当前完整结果；
“查看最新”用 read refresh，“采用最新”才用 use refresh。

`notion_ctl({cli_source: "SOURCE_ID"})` 返回当前明确 source 的配对 CLI argv、
数据库范围和 `execution`，不执行命令或证明权限。与 `refs` 互斥，只接受一个
启用且无歧义的 source，不猜全局安装或第一个来源。普通消费结果不携带机器路径。
`execution.default_cli_timeout_ms` 为 `600000`；显式 `--timeout` 也使用毫秒。
宿主等待窗口需覆盖该预算及启动、收尾余量。前台无法持续等待时，保留同一后台
进程、Store 和凭据范围，等到真实终局；短轮询结束不授权杀掉或重复写入。

## 从正文相对引用读取

Pi 的单文件入口支持 `read({path:RELATIVE_PATH, from:FIXED_CONTAINING_FILE_REF})`。
`from` 复制实际包含链接的主文 `sr:S`、资源 `sr:R`，或带 snapshot 的 canonical
File ref。嵌套子文档使用自己的 owner、固定 manifest 与准确路径；未固定的 `sr:C` 不能作为基准。
`path` 可以是相对文件路径或 `skill://` 引用；后者省略的 Library 来自 `from`。
相对路径不接受绝对路径、`~/`、query 或 fragment。
`from` 不与 `paths` 批读或 `refresh:true` 合用。

SDK 先根据该文件的当前 Source revision 和原始仓库路径解析唯一贡献目标，
Broker 再按目标自己的 owner、scope 和会话固定版本读取。已选目标不会因这次
解析而换成新版本。没有可靠 Source 上下文时，使用目标的精确稳定引用；不按缓存
位置、名称或相似文件名推断。来源失效、revision 变化、映射歧义、库外路径或离线
无法解析都保留明确错误。

结果沿现有 read 回执返回固定目标引用，只做检查，不激活指令、不展开 Requires，
也不自动修改 Members。取消与分支切换继续阻止旧结果投递。普通本地 read 保持
Pi 原生行为。参数示例见[相对文件读取](fixed-resource-batches.md#relative-paths-from-a-selected-file)。

## Presentation and proof

正常 use 结果保留所选根、Requires 的完整作者字符串和资源/关系目录。编译器不
解析或裁剪作者 frontmatter、标题、XML、代码与链接。目录不加载未选 Member 正文。
完整 graph lock、hash、canonical binding、预算和物化证明留在工具 details，
显式证明导出与模型正文分开。Broker 渲染 hash 不写回 CLI 源内容证明。

当前投影回执绑定编译器版本、完整模型文本 hash/bytes，以及每份源正文的真实位置。
位置使用 JavaScript UTF-16 offset，字节与 SHA-256 使用 UTF-8。实际 content、
toolCallId、scope、owner、pin、图与源 hash 都必须匹配；独立 details、未知编译器、
坏 hash、移位 span 或截断不能构成 loaded。

完整正文只在同一最终请求中已有可信同版本副本时替换为 `Already loaded.`，资源
可用 `Already available.`。生成目录只有完整且同 scope/owner/snapshot/version
的见证存在时才能省略；另一个省略标记、摘要或历史 loaded 状态均不能作见证。
派生回执明确登记省略目录的完整 hash/bytes，重算文本和偏移；被替换正文不再证明
交付。原始 Session 与工具结果保持全文，compaction 后按有效上下文重新计算。

同一固定文件的关系与文件目录完全同 ref/path 时，可把描述归入文件对象并保留
关系 ref。外部、未固定、歧义或冲突关系保持原信息。scalar 撤下只替换已验证正文
span；生成 effects footer 仍须精确匹配该次操作，未知不能变成零写。预算按实际
生成文本在提交选择前检查，不降低 SDK 权限、图预算和源完整性守卫。

最终请求检查冻结 Broker 最后合法投影中的正文、目录、操作事实和工具声明，再与
后续实际发送内容核对。恢复的原用户文本仍承担 user 角色义务，相同 assistant
文字不能替代它。机器回执保留在私有预期中，不进入模型正文。有限模型只证明其
声明状态性质，具体角色、布局、偏移和 HTTP 实体由实际内容与 transport 检查覆盖。

## 消费不写远端

Pi `read` 与 `notion_use` 不公开 `readOnly`。携带该旧参数时，无论值为 true 或 false，都在 I/O 前返回 `INVALID_ARGUMENT`。随包 SDK v3 不接收这个参数，当前消费恒零语义写入，不通过首次读取 retention/adoption 或写 Records。旧选择缺少所需本地字节时，明确获取当前候选并重新选择，不承诺远端历史恢复。

SDK 与构建 manifest 必须具备匹配的消费能力，缺失时在操作前拒绝；旧 `source.command` 同样在配置入口拒绝。此边界由 `notion-sdk.test.ts` 的无 readOnly 能力门槛和当前独立安装 HTTP 检查验证，不依赖用户选一个保护开关。

version-1 `effects` 只包含 `version`、`remote_writes` 和 `author_content`。确认零写时必须是 `none` 与 `unchanged`；缺失或不完整的观察保守报告 `unknown`，后续零写结果不能覆盖它。旧 `retained` 状态和 `retention` 字段均拒绝，包括空数组。`notion_use`、原生 read 和注入的效果文字保留原正文 span；多源失败与取消继续携带本轮已观察的结果。实际 SDK 写入拒绝边界、HTTP 记录和 `host-prepare.test.ts` 等回归共同验证零写，不能仅凭输出字段宣称通过。

工作集控制的本地管理事实使用唯一字段 `session_effects`，包含 `notion_writes`、`history_changed` 和 `cache_reclaimed`。它不冒充消费 `effects` 或正文交付。管理 tool result 仍完整参加最终 wire 检查，丢失、改写或混入非法消费 effects 仍被拒绝；没有旧字段别名。

资格、固定选择和交付的有限边界见 [consumer-state Skill](https://github.com/yoyooyooo/pi-context-broker/blob/next/.agents/skills/verify-notion-consumer-state/SKILL.md)。模型不证明 SDK 的实际 HTTP、serializer 或 LLM 最终回答；这些按 [integration Skill](https://github.com/yoyooyooo/pi-context-broker/blob/next/.agents/skills/verify-notion-skills-integration/SKILL.md) 单独验收。

## 当前工作集预算与显式释放

按需发现 `notion_ctl` 后，使用下面的互斥操作。工作集范围为当前 Session 分支确认的 Notion 指令图，不包含普通本地 Skill、所有聊天文本或模型总 token。

| 操作 | 参数 | 结果 |
| --- | --- | --- |
| 查看 | `{"working_set":"show"}` | roots、Required-only 节点、固定 ref、正文 bytes、当前可见 bytes、各根 context 的 missing/complete、历史独立版本 bytes、预算和可释放根 |
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

取消或新epoch退休旧任务。迟到SDK结果、headers或provider响应不能复活被取消的选择。元数据缓存使用原validated_at，刷新正文被拒绝后不能绕过持续权限失败。

## 内容变更、明确刷新与管理开关

| 事件 | 当前会话行为 |
| --- | --- |
| Notion 或另一个会话修改内容；metadata TTL 到期 | 目录可重新获取，已确认 root 和 Requires 的固定版本不自动替换 |
| 用户只要求看看最新 | `read` 的 `refresh:true` 检查同一 owner 的最新主文，保留旧指令图；返回目录中的精确资源可继续检查 |
| 用户要求采用最新继续任务 | `notion_use` 的 `refresh:true` 完整准备后，只替换明确指定的 roots；任何失败保留原图 |
| 多个 roots 共用已变化的 Requires | 返回涉及的 roots 和可用引用；一起刷新相关 roots，或由用户任务决定释放无用根 |
| Default Context 变化 | 改变默认目录成员资格，不自动加载、卸载或授权正文；完整目录仍可搜索 |
| Enabled 关闭 | 阻止新的当前消费；已有完整固定原字节可继续用于旧会话，不偷偷改版 |
| 真实认证或权限拒绝 | 对应正文从当前请求投影中移除，不能借旧缓存绕过 |

刷新可以复用已返回的 `sr:C`、`sr:S` 或有本分支选择证明的固定 canonical 主文引用，只按所选 manifest 的主路径解析，File ID 不再出现在公开引用中。资源引用、废弃的 `file_id` 参数、错 owner 或错主路径不因 `refresh:true` 变成合法主入口。检查新版资源仍校验原 SDK fixed binding、hash、bytes、当前分支和权限；检查凭据不构成 active 指令。

## 缓存丢失后的会话连续性

清除可重建缓存不删除选择或替换任务版本。完整正文仍在当前上下文时继续复用；compaction 后需要恢复时，仅请求原固定节点和原闭包。缺失原字节不会转为读取最新版本。

恢复按相连的 Required 闭包处理，失败时移除该不完整闭包的指令，保留独立能力，并给 Agent 有限 warning。旧 pins 不变，用户仍能继续普通问答、明确刷新或释放根。一次 context 恢复共享 30 秒读预算；失败有 30 秒重试间隔，避免每个工具轮次重复等待。它不保证远端原版本可重新取得。

真实权限拒绝和取消仍有独立守卫。若后续 hook 在发送前丢掉必需正文或撤销权限，该次不安全请求必须被拦截；下一次移除受影响投影后仍应可继续。警告、输入可继续和实际 provider 回答分别验收，不能用 unit pass 替代真实 Pi 连续输入证据。

普通openai-completions的wire结果还要求Node Undici实际发送实体与本run绑定的摘要一致。2xx只说明收到响应头，不证明流完成、模型任务或最终wire。已知摘要不一致时不能确认active/selected/persisted；已发送body仍记dispatched。in-process mock和无法归属的并发请求保持明确的logical-only/unknown边界。

## 当前验证入口

[Broker Skill](https://github.com/yoyooyooo/pi-context-broker/blob/next/.agents/skills/verify-context-broker/SKILL.md) 按变化路由到现有check、当前SDK/安装与实际Pi助手；[integration](https://github.com/yoyooyooo/pi-context-broker/blob/next/.agents/skills/verify-notion-skills-integration/SKILL.md) 绑定同一CLI/SDK与真实decoder；[consumer-state](https://github.com/yoyooyooo/pi-context-broker/blob/next/.agents/skills/verify-notion-consumer-state/SKILL.md) 维护已有模型和守卫。

`bun run check:broker` 与独立安装/current HTTP 只证明各自受控边界。实际 Pi 沿根目录
`scripts/notion-sdk-pi.mjs` 的当前 SDK v3 场景执行，见[当前验收复现](https://github.com/yoyooyooo/pi-context-broker/blob/next/docs/current-context-candidate.md)。
真实 Notion、自然模型、正常安装和原生终端各自报告实际候选与观察，未执行项保持
not_run。没有当前独立证据时，不宣称 OMP/Tern 或其他宿主已通过。
