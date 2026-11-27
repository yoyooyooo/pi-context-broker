# Broker 参考

[English](./reference.md) | [中文](./reference.zh-CN.md) · [项目概览](https://github.com/yoyooyooo/pi-context-broker/blob/main/README.zh-CN.md)

Pi/OMP broker 的完整配置、发现与注入参考。首次使用先看[快速开始](../README.zh-CN.md#快速开始)。

[Skills](#skills) · [Routers](#routers) · [配置](#配置) · [Sources](#内置-sources) · [规则](#rule-files) · [命令](#命令) · [补全 CLI](#补全-cli)

### Library 身份与会话选库

Source 使用 `library` 配置根页面 UUID 或 Notion URL，即 CLI 初始化返回的
`library.library_id`。Skills、Files、Records、Sources 四张直属子表的 ID 是物理绑定，
不能作为选库参数。SDK v3 校验 descriptor v2、根页面与四张表；空库同样先验证绑定。
旧的 `source.database`、`--database`、`--entry` 选择参数不再支持。

Broker 通过同一 SDK 解析 CLI 全局 `default_library`，没有第二套全局默认库。
每次输入调用只读 `selectLibrary` 读取本地配置，配置中的默认库变化从下一次输入生效；
切到新根身份时调用 `resolveLibrary` 校验远端绑定，同根后续输入复用已验证的上下文。
`/context-broker library ROOT` 切换当前会话分支，`default` 选择 CLI 默认库。
Source 省略 `library` 时只绑定这一个默认库；所选根页面必须恰好匹配一个启用的 Source。
切库失败保留 blocked 请求，后续默认操作不会回落到之前的库；修复后明确重选。
命令只接受根 UUID、Notion URL 或 `default`。无效参数在接收选库请求之前报错，不改当前选择。
`profile_id` 始终在当次接收输入时选定的 Library 内解析，也支持省略 Source 的 `library`。
跨库同名 Profile 保持独立；当前库缺少 Profile 或 Profile 被禁用时直接失败，不回落另一库。
CLI 全局 `shared_profile` 仍只匹配它显式绑定的 `library_id`。

每次 interactive/RPC 输入被接收时冻结 Library。A 切 B 只改变后续提交的默认发现、
新候选范围和 `notion_ctl` 的 `cli_source: null`。已经发出的短引用、已接收任务、活跃根与快照 pin
保留原身份。带完整 `library=ROOT_UUID` 的引用可路由到其他已启用 Source，
不改变默认库。CLI 管理和消费统一传返回的根身份：`--library ROOT`。

普通 `$name` 和默认发现只查询当次接收输入时选定的 Library。明确的 `$name@source`
或配置的 namespace 按需查询对应已启用来源，然后保留其完整根身份。同次输入可以明确使用
多个 Source；外库结果不会进入默认菜单或改写 Profile。元数据工具省略 `source` 时使用
已接收任务的 Library，明确指定时只查询该启用的 Source。


## Skills

Context Broker 通过原有 `skillRoots` 和内置 filesystem source 发现 `SKILL.md`，通过内置 Notion source 发现远端 Skill 元数据。

原有 roots 的 `$` 发现与配置驱动的 Skill 调用均按 root 顺序扫描，同一规范化 Skill 名称只保留首个命中的记录。Source 记录保留独立 identity 和 canonical token，见[内置 sources](#内置-sources)。希望优先使用已分发版本时，把运行时目录放在源码目录前面。扫描会跟随目录和 `SKILL.md` 软链接，但保留发现时的路径作为相对引用基准；断链和指向祖先的循环链接会跳过，深度、忽略目录和文件大小限制仍然有效。这不会重写 Skill 正文中的链接或 Router 显式成员路径。

```markdown
---
name: design-review
description: Review architecture and API trade-offs.
autoload:
  enabled: true
  aliases:
    - architecture-review
---

Review the design for ownership, boundaries, failure modes, and migration cost.
```

`requireAutoload` 默认为 `true`，配置驱动的 Skill 调用和关键词规则仅匹配 `autoload.enabled: true` 的 Skill。显式 `$name` 查找和补全不受此开关限制。`CONTEXT_BROKER_REQUIRE_ENABLED` 可以覆盖配置调用和规则使用的开关。

## 随包 Skills

普通产品维护与 Source 同步默认使用实际配对包中的 `ntn-skills-maintain`、`ntn-skills-sync`。指引提供普通原生 `read` 所需的精确路径，只有 shell 时提供配对 CLI 的 `skills get NAME` argv，不预加载正文。`get` 默认输出 Markdown；`--path RELATIVE_FILE` 读取一个参考文件，`--full` 包含所有支持文件，`--json` 输出结构化结果。`skills list` 发现包内目录，`skills path NAME` 定位匹配当前包版本的实际目录。这些命令离线工作，无需 Notion 库或独立的 Skill 安装。工作流来源与数据目标分别选择：写入 Source 和 Library 必须明确，不隐式取第一个来源。普通业务 Skill 的发现规则保持不变。

明确选择的 Notion 团队流程保留精确来源、记录和已选版本。需要发现时查询该来源，再读取精确 ref；查看不代表采用。真正采用时调用 `notion_use` 加载 Requires，已经准备完整闭包时可复用。没有原生 use 工具但有 shell 时，沿所选来源的 CLI 执行 `use EXACT_REF --library ROOT_UUID --json`；CLI ref 必须是规范引用，不能使用会话 `sr:` 句柄。两条路线都不可用则报告无法采用。通用宿主使用实际可用的 `skill_prepare` purpose `use`。pending、partial 或访问失败都不能静默换成 Builtin。被编辑 Skill 本身只 inspect。本地和随包流程保留原生选择路线；已选指引保留到明确刷新。

`$ntn-skills@builtin`、`$ntn-skills-maintain@builtin` 和 `$ntn-skills-sync@builtin` 是 Broker 与独立 Tern query 随包提供的普通本地 Skill。只有配置了至少一个未禁用的 `type: notion` source，才会在 `$` 发现与补全中出现；零已启用 Notion source 时文件仍随包保留，但不会显示候选。即使尚未完成 Notion 连接/认证、没有全局 `ntn-skills` executable，已启用时也能离线读取随包入口与相对参考文件。选择、草稿与加载均使用普通 `$` 链路。

在 Pi 中，零已启用 Notion source 的普通本地会话不暴露 Notion 候选、工具或系统指引。明确初始化时，仍可通过 CLI 的 `skills get ntn-skills-maintain --path references/setup.md` 读取离线入口。日常 CLI 是 `ntn-skills list [--query TEXT]`、`read REF`、`use REF`；`files` 和 `export` 按需使用，管理命令收在 `ctl`。Pi 中需要执行已授权维护或同步任务时，按需发现 `notion_ctl`，用 `{cli_source:"SOURCE_ID"}` 取得所选来源的 executable 与 Library 根页面范围；这条路线要求 `bash` 已启用。取得目标范围不改变指引来源。OMP/Tern 演进延期。

私有随包内容使用 `builtin:<name>` 身份，启用后使用固定 `@builtin` 选择器。同名 filesystem 或 Notion 条目保持独立身份与选择器；namespace 为 `builtin` 的配置来源也不能冒用这三个官方 token。指向同一随包文件的物理别名先去重，再处理本地名字优先级。

升级 Broker/配套插件即可升级配对的 CLI、工作流与资源，扩展代码变化后重启宿主。随包 Skill 没有独立安装状态或更新流程。Notion 和显式配置的本地 Skill 保持各自的身份与生命周期。包版本变化不会静默替换当前任务已选中的指引。

宿主命令面保留 `/context-broker` 的会话/View 选择、刷新与诊断。CLI 任务通过普通 `$` 工作流或实际 CLI 完成，不再注册 `/ntn-skills`、专用 save 包装和 Tern 管理/schema 面板。

## Routers

Router 写在 discovery catalog 里。它注入索引，不注入完整成员文件。

Notion Router 使用 `ROUTER.md`；CLI 统一生成正文和确定性成员索引。Broker 只加载选中的入口。订阅 Router 只有在 CLI 已发布活动成员映射后才可用。

```yaml
version: 1
records:
  - kind: router
    name: workspace-collab
    description: Collaboration contexts for documents, chat, and tasks.
    aliases:
      - collab
    render:
      type: member-index
      rules:
        - This is a context router index, not a concrete skill.
        - Select the needed member before acting.
        - Read the selected member file before using member-specific details.
    policy:
      memberBody: read-before-use
      scope: members-only
    members:
      include:
        - docs
        - chat
```

输入 `$workspace-collab` 时，模型会看到 bundle 描述、policy 和成员列表。它不会自动收到 `docs` 和 `chat` 的正文，除非后续步骤读取它们。

规则也可以注入同一份轻量索引，而不加载成员正文：

```yaml
id: collaboration-keywords
inject:
  - router:workspace-collab
match:
  - contains:
      - 团队协作
```

规则目标必须显式使用 `router:` 前缀；不带前缀的目标保持原有的 Skill-only 行为。Router 规则只按已配置 discovery catalog 中的精确 name 或 alias 匹配，不做模糊匹配。

## 内容生命周期

CLI 目录只返回 `records`，每条必须包含 `id/kind/locator/name/alias/description/default_context/entrypoint/ref`。Broker 拒绝未知 kind、错误 locator 和旧 `skills/skill` 字段。选中消费将完整主文与文件清单绑定到同一 source、scope、record 和不可变快照；兼容路径的完整导出还核对 portable manifest v2 与每个文件。入口文件为 `SKILL.md`、`ROUTER.md` 和 `PROMPT.md`。

用 `$alias@notion` 显式选择 Prompt。每次提交新建 invocation、会话 generation 与 prepared 集合，同轮预检和派发共用固定快照；下一轮再次引用会完整加入本轮用户任务，保留原文与图片。Prompt 不进入原生 Skill、默认发现、后台预取、关键词自动激活或 system prompt。取消、超时和切会话阻止旧轮派发。双宿主及 detached 补全在 v1 中共享 `identity/kind/source/ref` 与原 UTF-16 编辑范围；接受候选只改草稿。

`agent_start` 释放 preparation 后，本轮已提交的 Prompt 快照仍决定入口与资源读取，上游更新不会替换本轮资源。轮次结束、取消、重置/刷新和会话边界清除这份权限；新提交重新准备正文与资源，不写入会话级 loaded 标记。

旧 Bundle catalog 和 session 标记通过 `node scripts/migrate-content-assets.mjs INPUT OUTPUT` 显式转换。运行时只接受 Router；转换写独立输出，保留不可变快照和资源路径。
转换限于 catalog 记录及已识别的 Broker session envelope/details。正文、不可变 snapshot ID、资源路径和未知嵌套字段按原值保留；只迁移 schema 所属 kind、Router 引用及来源回执身份。混合 catalog 结构及非法 member 在输出前失败。仓库根目录可执行独立回归 `bun test scripts/migrate-content-assets.test.mjs`。

## 配置

配置解析顺序：

1. `CONTEXT_BROKER_CONFIG`
2. `<agentDir>/context-broker/config.yml`
3. `<agentDir>/context-broker/config.yaml`
4. `<agentDir>/context-broker/config.json`

设置了 `PI_CODING_AGENT_DIR` 时，`agentDir` 使用该路径。否则使用宿主默认值：

- Pi: `~/.pi/agent`
- OMP: `~/${PI_CONFIG_DIR:-.omp}/agent`

完整配置示例：

```yaml
skillRoots:
  - ~/context/skills
extraSkillRoots:
  - ./.agents/skills

# 不设置时，broker 使用配置文件旁边的 rules 目录。
ruleRoots:
  - ./context-broker/rules

discoveryCatalogs:
  - ~/context/catalogs/workspace.yaml
extraDiscoveryCatalogs:
  - ./context/catalogs/project.yaml

requireAutoload: true

# absolute | home-relative | basename | hash
pathMode: home-relative
logPaths: false

scan:
  maxDepth: 8
  maxSkillBytes: 65536
  ignore:
    - .git
    - node_modules
    - dist
    - build
    - coverage
```

### 内置 sources

`sources` 在现有配置里增加有类型的来源。`skillRoots`、`extraSkillRoots`、discovery catalogs 及其环境覆盖继续与 sources 共存，现有用户配置无需迁移。相对 filesystem roots 与 `cacheDir` 基于消费端工作目录解析，`~/` 展开到 home 目录。

```yaml
sources:
  - id: local
    type: filesystem
    roots: [~/context/source-skills]
    requireAutoload: false
  - id: notion
    type: notion
    enabled: true
    namespace: notion
    # 消费用配对 SDK；管理用随包 CLI。
    # 将示例值替换成自己的 Library 根页面 ID。
    library: 00000000-0000-0000-0000-000000000000
    cacheDir: ~/.cache/context-broker/notion
    discovery: {maxAge: 5m, offline: false}
    activation: {maxAge: 1h, offline: false}
    prefetch: false
    requestTimeoutMs: 30000
```

| 字段 | 适用类型 | 含义 / 默认值 |
| --- | --- | --- |
| `id` | 两种，必填 | 唯一 source 身份；允许字母、数字、`.`、`_`、`-` |
| `type` | 两种，必填 | `filesystem` 或 `notion` |
| `enabled` | 两种 | 默认 `true`；`false` 跳过发现并禁止激活 |
| `namespace` | 两种 | 默认 `id`；字符规则同 `id`；作为内部 canonical token 前缀及 Notion selection token 后缀 |
| `roots` | Filesystem，必填 | 非空路径数组，指向包含 Skill 的目录 |
| `scan` | Filesystem | `maxDepth`、`maxSkillBytes` 为非负安全整数，`ignore` 为字符串数组；默认顶层 `scan` |
| `requireAutoload` | Filesystem | 默认顶层 `requireAutoload`，再默认 `true`；为 true 时，该 source 的发现按 `autoload.enabled` 过滤 |
| `library` | Notion | 可选 Library 根页面 ID 或 Notion URL；省略时绑定 CLI 全局 `default_library`，不会从第一个或唯一 Source 推断默认库 |
| `default_view_id` | Notion | 可选稳定 View ID；会话选择优先，未配置时使用 API 顺序中的第一个 View |
| `cacheDir` | Notion | 默认 `~/.cache/context-broker/notion`；保存可重建的元数据索引、当前入口和按需资源；不是内容历史权威 |
| `discovery` | Notion | 元数据 `list` 策略：`maxAge`、`offline` |
| `activation` | Notion | 选中消费策略：`maxAge`、`offline`；由 SDK 统一执行 |
| `prefetch` | Notion | 默认预算为零；省略、`false` 和旧值 `true` 均不预热正文。显式对象可设置 `maxNodes`、`maxBytes`、`maxDepth`、`maxTimeMs` 和 `rateShare`；必要的非零限额启用有界预取，depth 可为零。显式选择仍可用 |
| `requestTimeoutMs` | Notion | 以 `NTN_SKILLS_REQUEST_TIMEOUT_MS` 传给 CLI 的单次网络尝试超时；正整数且 ≤ 2147483647；CLI 默认 30000 |

`maxAge` 接受 `0`，或整数加 `s`、`m`、`h`、`d`。省略策略时使用 CLI 默认值。`offline: true` 优先于 `maxAge`，只使用已有 CLI 缓存；缓存不存在或不完整时失败，不悄然联网。[schema](../examples/config.schema.json) 拒绝未知 source 字段和类型不匹配的配置；source id 唯一性由 broker 运行时检查。

每次网络尝试独立计时；分页和限流等待可能延长 SDK 操作。Broker 的后台目录请求和 Pi 每次模型请求前的 context 阶段分别受 60 秒总时限约束；超时或失败不持续占用输入。显式 `requestTimeoutMs` 设置 SDK 本次操作或管理 CLI 的环境。Escape、Stop 和会话取消会中止所属 SDK 操作或管理进程树。发现与正文准备各自保持新鲜度策略；Broker 不另设持久目录缓存或重置 SDK 的验证时间。

Pi 的 `$` 每次按键只筛选内存候选。会话启动时分别读取本地 Skill、随包维护 Skill 和 SDK 的纯本地候选快照，在线验证在后台继续。快照复用已有持久缓存的最近完整目录与较新的部分结果，并应用最新拒绝事实；它不提供当前授权、完整正文或 Requires 证明，也不能用部分空结果证明不存在。目录刷新完成后自动更新仍有效的当前下拉，不等待 Default View 或文件投影。排序变化保留高亮身份；高亮记录消失后取消选择，用户须重新选择。Esc 在等待和已展开状态都关闭本次意图，迟到结果不会重新打开。普通输入和排队输入在接纳时分别冻结显示过的 Skill 身份、Library 与 Source，后续草稿或刷新不能换绑。

在线 Notion 元数据使用 `listCatalog`，补全预热使用 `readCandidateSnapshot` 的纯本地元数据。Skill/Router 准备、Prompt 直接加载和有预算的预取均调用 `consume`；支持文件使用 `readSkill` 或当前批量资源操作。配对 SDK 一次返回完整 manifest 与准确主文，Broker 首次只物化主文，保留所有 File 绑定供按需续读；`manifest_complete` 不代表全部文件已经在本地。Prompt 每次显式提交取得本轮内容。`source.command`、CLI prepare/read 回退和完整 export 快照路径已移除。旧包或不完整的包明确失败，需要一起升级配对 CLI/SDK 与 Broker。OMP/Tern 延后。

### 首次显式选择已登记的 Source 成员

真实用户提交的 `$` 可以为已登记但还没有 current 消费内容的上游成员执行有限的增量准备。Broker 先精确绑定 Library、登记 Source、member 与稳定 Skill 身份。尚无 Skill 行的成员只存在于候选元数据中，不伪造 page ID 或 `skill://` 引用。缓存候选区分 `ready`、`materializable`、`preparing`、`blocked` 和 `unknown`；按别名唯一匹配需要完整目录，部分发现不能授权写入。

已配置的 manager 经独立配对管理入口执行物化，保留已有物化成员，为 use 准备必要 Requires，Members 继续按需加载。该路径只写后续消费必需的持久契约，不生成 Notion 阅读投影。manager 未配置、身份歧义、策略阻止或写入未决时明确失败，不临时换成本地任意 CLI，也不为了让首次使用成功而跟随新的上游版本。

原生根没有登记 Source、但 Requires 中存在尚未就绪的登记 Skill 时，SDK 为该真实根返回新鲜且完整的 Requires 关系证明。manager 重新校验根身份与关系摘要，只准备这些依赖，随后 Broker 再次消费原根。错误文本与 Members 不构成管理权限。

管理回执通过核验后，CLI 退休相关持久事实，Broker 退休本作用域元数据与旧 source jobs，然后重新走普通只读 `consume`。完整图、正文和文件目录仍须通过原有消费验证才交给 Pi。管理完成不等于 loaded 或 delivered。回执 `scope` 由消费端真实凭据校验，`manager_scope` 独立保留固定写入方作用域，两者不同不能混用。管理 effects 与消费 effects 分别记录，pending/unknown 不会被随后消费的零写结果覆盖。

已就绪内容仍走原缓存消费路径，不附加 discovery 或 management 调用。列表、补全、模型 read、预取、恢复与可配置规则注入均没有管理权限；Markdown 代码和引用示例中的 `$` 也不授予该权限。取消只结束前台等待与本输入的发布资格，已经受理的管理操作保留可恢复状态。已有会话 pin 不被自动替换。

配对 runtime 只接受 SDK v3，SDK 与 runtime 清单的能力必须一致。消费恒为零语义写入，不再接收 `readOnly` 参数。candidate-snapshot v1 提供候选元信息，并在同一次组合操作进入 View 读取前通知目录已结束；SDK 与清单都必须声明该能力。catalog-directory v1 在一次操作中提供完整目录与 Default View 两份独立投影，全库无关失败不会隐藏有效 View；缺少能力在调用前失败。

Git-only 与混合 Skill 都暴露完整的当前文件目录。CLI/SDK 以每文件显式 native、resource 或 source descriptor 决定权威；编辑 Notion 阅读投影不会自动接管 Git/resource 内容，主文以 Notion 为权威。Broker 只消费准确正文和 File 绑定，不执行 adoption、不维护第二套归属。Notion 页面历史和 Git 历史不属于该消费协议。

认证沿用 `ntn-skills` 项目已有 token；需要显式配置时，通过可信秘密输入管道执行 `ntn-skills ctl config set-token --stdin`。CLI 优先选择 saved token，再选择非空 `NOTION_API_TOKEN`；缺少凭据返回 `AUTH_REQUIRED`。Broker 和 Tern 配置没有 token 字段。

构建把独立 `ntn-skills` CLI、三份工作流 Skill、运行依赖与许可声明随两个产品分发。Pi 的 SDK 与 CLI 来自同一份选定的 `ntn-skills` 包，具体版本由[构建输入](../CONTRIBUTING.md#bundling-cli-and-skills)决定。在线 Notion source 使用项目自己的 HTTP 引擎。`/context-broker doctor` 调用随包 CLI 的 `ctl doctor --library ID`，要求 `transport: direct_http`、`notion_api_version: 2026-03-11` 及有效认证，可能填充缓存。未显式选库时，CLI 使用自己的全局默认库。Offline Notion 发现要求已有完整缓存，随包 Skill 则无需 Notion 访问或这些缓存。

来源失败保留脱敏的 source/code/message。认证、网络和响应格式失败仍使该来源不可用；合法的部分目录则保留精确记录，附带非阻断的 `CATALOG_INCOMPLETE` 提示，并使用页面限定 token，不能据此证明无结果或名字唯一。默认 View 失败时，默认目录为空且显示修复方法，完整目录中的精确显式选择仍可用。实际正文交付仍检查选中记录的权限和快照完整性。本地 Skill 和普通聊天继续工作，不把失效的显式 View 偷换为其他 View 或全库。

Pi 注册扩展和编辑器后在后台发现元数据。交互式和 RPC 的普通输入、无关的原生文件读取不等待冷目录、慢请求或发现失败。一次性 `pi -p` 的 print 或 JSON 提交则在首次可取消的 context 阶段等待已有目录请求，再发送第一条模型请求。此处只等待元数据，不加载正文；取消或切换会话会停止等待，目录失败仍明确显示不可用，不解释为空目录。

当前目录作为一份临时目录数据消息加入最终请求，只包含名称、描述、来源身份和准确引用，不包含未选正文。其他扩展提供精确系统提示时，这份目录仍然可用，安全规则和工具声明保持不变。重复投影只替换 Broker 自己的目录，不追加目录历史或改写原生会话。目录仍在等待或暂不可用时提供 `notion_list` 入口；pending 不表示目录为空。后台请求仍计入发现成本。显式 `$`、精确 `/skill:` 输入、`notion_list`、`notion_use` 和 Notion read 继续检查所需目录、权限、身份和固定快照。选择失败阻断部分指令派发，已替换会话的旧准备不能迟到发布。普通续接保留已经 active 的指令及其选中快照。

当前有效请求中，同一身份、同一版本的完整 Skill 与资源正文只保留一份。重复 `read` 或 `notion_use` 仍执行用户明确要求的操作，但模型投影可复用已存在的完整正文和生成目录，只保留必要确认与各次 effects。只有同一请求中存在可信完整副本时才能省略，摘要或历史 loaded 标记不能替代全文。原始会话和工具结果保持完整。撤下旧正文也不抹掉已经发生或尚未确认的操作结果。详见[正文与模型投影](skill-consumption-runtime.md#presentation-and-proof)。

Notion 网页修改发生在 CLI 缓存之外。精确引用固定身份，不承诺每次联网：当前读取可以复用仍合格的观察，固定读取保留历史。Broker 保留 SDK 原始验证时间和 remote/cache 来源，metadata、read 与 use 共用同一 scoped 资格观察；旧缓存或历史 pin 不能清除较新的拒绝。精确依赖失败只更新实际依赖，不猜成根节点禁用。取消、旧代次与同代次迟到旧请求均不能覆盖已经接受的新验证。

公开 `notion_list` 和首轮提交上下文能到达原目录 TTL，不依赖编辑器补全。命中不续期，并发到期核对复用已有请求所有者；交互输入保留 pending 非阻塞，print/JSON 在可取消边界等待。`/context-broker refresh` 明确重取当前目录和 View；失败保留错误或 partial，不把旧结果称作新鲜成功或空目录。分页摘要包括实际 availability、View 与覆盖，状态变化后不能静默拼接两代分页。

### 显式远程内容搜索

用户要求搜索 Skill 内容时，调用 `notion_list({search_in:"content",query:"独特词句",source:"team",limit:20})`。省略 `search_in` 或使用 `search_in:"metadata"` 保持原元数据查询，不启动 MCP 或 OAuth。内容查询要求非空 query、已启用且在线的 Notion 来源、已验证的 Library root，以及 1–50 的 limit。省略 source 时使用已接收任务选定的 Library；指定 source 可查询另一已启用来源。SDK 先确认根页面及其表绑定的访问，再把 query 发到该连接，不向多个连接广播。

MCP transport、OAuth 和凭据只由同包 CLI/core 持有。REST 与 MCP 凭据相互独立；显式 MCP Token 优先，其失败不切换到另一个 OAuth 账号。缺少可用 grant 时，显式 Pi 前台内容搜索可以显示授权屏并打开系统浏览器，Esc 只取消当前查询的等待者。headless、RPC、print、JSON 不打开浏览器；授权需求结果提供 `ntn-skills auth mcp login` 供用户主动登录。宿主总预算至多六分钟，SDK 分别限制授权五分钟、搜索六十秒。回调不可用、拒绝和超时都会结束等待。

成功命中经过 fresh REST 的精确 owner、物理页面、Source 和 Skill Enabled 准入；支持文件命中归到所属 Skill。结果标记 notion_remote_match、native/projection/supporting_file 表示、coverage:remote_non_exhaustive 和 exhaustive:false。Notion 标题或投影命中不证明固定 Skill 快照或 Git 资源的精确字节包含该词。空结果、过滤后的空集合和 partial 不能证明不存在。

内容搜索不建立本地全文索引，也不缓存结果页；始终返回 next_cursor:null 和 pagination:not_supported。任何 content cursor，包括旧 metadata cursor，都在 MCP I/O 前拒绝，原 metadata 分页不变。refresh:true 只刷新所选 REST 目录，不承诺刷新远程全文索引。搜索不采用指令，不修改 root/Requires pins 或 active 图。请求、session/branch/tree、来源、metadata 或已接纳资格发生变化时，旧正结果、空结果和错误均不可发布。授权成功只恢复参数未变且仍有效的原请求。

用户点名询问某个 Notion Skill 是否存在或可用时，Agent 必须把名称作为 `query` 调用 `notion_list`，并设置 `refresh:true`。已有会话、先前查到或没查到、默认 View 已显示该名称，都不能省略这次核验；仍遵守用户明确指定的来源。查询只读元数据，保留已选 root/Requires 的固定版本。存在性与声明用途直接依据返回的元数据回答；用户要求检查或采用指令时，再读取或使用正文。只有当前新鲜且完整的查询才能说明搜索范围内未找到可用项；离线、过期、失败或部分结果不能证明当前不存在。 显式 source 只刷新该来源，省略则刷新已接收任务选定的 Library；离线策略保持不变。后续分页沿返回的 cursor 继续，不再次刷新。Disabled Skill 可以不出现在可用目录中，这不代表对应 Notion 页面不存在。

当前资格、固定选择与已经交付的文字分别处理。已知禁用阻止新的应用与隐式恢复，不删除已交付的历史解释。已知权限拒绝或认证 scope 变更阻止 Broker 后续受控投递／恢复相应已验证正文，不改写原 session，也不声称能撤回已经发送的请求。明确新选择须完整通过固定文件、身份与响应预算校验才替换旧图，失败保留原选择。

`Default Context` 明确保留为可选的作者组织／View 筛选属性，不作为第二个可用开关或全文注入开关。保留现有值、稳定 schema 和作者读写入口，因为真实 View 与其他集成可以使用它。没有筛选它的 View 中，切换该字段没有独立效果；明确筛选它的 View 则按正常目录新鲜度改变成员。`Enabled=false` 不能被它解禁。本批不重命名、删除字段，也不强制隐藏用户管理视图中的列。

Pi 在 input 边界保留本次选中的原文、图片和身份，待 `agent_start` 提供操作 signal 后，在 `context` hook 内获取目录、图与正文。每次模型请求前的 context 阶段共用最多 60 秒预算，包含 print/JSON 的 metadata 等待、正文准备和固定上下文恢复；source 忽略取消时也按期返回。Broker 失败时撤销未确认的指令，发出非阻塞 warning，继续原始用户请求。权限、完整性、投影、最终 payload 和持久化检查仍拒绝无效 Skill 内容或激活回执，但不再中止用户对话。Pi 原生编辑器及后续消息队列保持可用。**Stop**、Escape、RPC `abort` 和切换会话仍取消所属获取，迟到的结果不能变成新的选择或投递。

公开 `notion_list` metadata 调用、`notion_use` 调用与 `notion_ctl cli_source` 验证各有 60 秒操作预算。Broker 拥有的单项 read 在引用解析、准备和原生文件读取之间共用此预算；无法接管原生 read executor 时，read hook 的来源获取仍有界。普通原生 read 保持原参数、结果与执行预算。内容搜索沿用 360 秒总预算，并包含最初的 Library 解析；资源 batch 沿用显式 `timeBudgetMs`（默认 30000，最多 120000）和 `RESOURCE_TIME_BUDGET` 错误。期限到达或用户取消都会结束 Broker 边界等待，即使 producer 忽略 signal。超时返回受控工具失败，对话继续；迟到结果不能新增来源回执或激活。`cli_source` 的时限只覆盖 root 验证，另行授权的 CLI 进程仍使用自身时限。

序列化之前，降级会按经过验证的回执范围或归属明确的工具结果移除 Broker 指令，保留用户原文与图片。最终 payload 降级仅修改能识别的原生消息位置和 tool-call ID，保留其他工具声明、图片及 provider 签名。目前只有 OpenAI-completions 配合已有 Undici 观察能证明实际请求字节；其他 serializer 不会被标为 wire-confirmed。未知 payload 形状依赖前面的安全上下文投影，不递归猜测并替换任意字段。请求已发送后的失败不能撤回已发字节，也不能据此产生新的 active 确认或持久化回执。

Pi 仅在当前请求未取消，且 `after_provider_response` 返回 2xx 状态时记录 active 指令。写入 `context-broker-active-sources` 前，会核对本次请求中的完整正文；Notion 记录还须匹配固定的 `use` 图。该事件发生在收到响应头时，早于响应流结束；它只确认逻辑上的请求接受，不代表模型完成，也不是最终 wire 投递。`before_provider_request` 不是最后一次载荷修改：更晚的 handler 仍可替换 payload，响应事件也不含 body。普通 `openai-completions` HTTP 路由会先核对序列化后的工具结果和 Broker 拥有的 user/custom 投递，绑定实体摘要，并且只有 Node Undici 在该 run 的模型端点上观察到同一摘要时才记录 wire 回执。已知不一致不会确认 active、selected 或 persisted。已经发出的 body 保持 dispatched，不会被改写成 provider 状态 0。其他 API、mock provider 和非 Undici 传输明确不是 wire 证明。`/context-broker request` 最多打印 32 条内存记录，只含哈希、计数、固定 snapshot pin、copied/reused/retired、净化后的 `remote_writes`/`author_content` 和错误，不含源正文、path、ref 或密钥，也不新增模型工具。标量和批量 `contextBrokerResource` 与主文、preparation 一起核对。同一模型端点上无法归属到单一 run 的并发发送记为 unknown，不能变成 wire 成功。进程内 mock payload 即使 2xx 也只是 logical-only。缓存文件、`ready` 结果、选中图、摘要和仅展示的 loaded 日志都不能单独证明 active。[Skill 消费运行时](skill-consumption-runtime.md) 说明这些独立的当前状态。

Pi 1.4 只在启动或 reload 时通过 `resources_discover` 收集扩展资源路径，没有提供目录晚到后刷新原生 Skill 菜单的扩展 API。Broker 将晚到元数据放入当前请求的 `<ntn-skills-view-catalog>`，精确 `/skill:` 输入仍经过准备门控。Pi 的 Notion 命名面把连续且来源相同的卡片放进 `<catalog-cards>`。每张卡片保留作者名称、完整描述、location 和可选 ref。自闭合卡片表示同一请求里已有完全相同的描述，所以这里省略。空元素表示作者描述本身为空。OMP 和其他非 Pi 面继续使用原来的 `<available_skills>` 与 `<available_routers>`。`$` 补全是独立入口，不能证明原生菜单已经刷新。Broker 不为更新菜单自动 reload 当前会话。

OMP 保留原行为：查询目录时不阻塞编辑器，首次普通提交会在调用 provider 前等待当前 View。每轮 `before_agent_start` 生成一份 `<ntn-skills-view-catalog>`，按精确路径移除 Broker 自己的旧目录项，保留其他本地条目和会话正文。新建会话、列举或切换 View 均不自行调用模型。默认零预取预算不会在注册或切换目录时准备正文；显式预算可以在后台准备所选 View 的有限子集，不构成选择或激活。完整目录和 View 查询各自保留覆盖范围，新鲜度或某个页面可读都不能补成完整覆盖。

Notion 元数据发现统一经过随包 SDK。Core 管理凭据、Library 隔离、目录新鲜度与 HTTP 请求预算。`source.command` 已移除。Broker 的 `cacheDir` 只保存可重建的元数据入口和选中主文、资源，不是另一套权威目录。目录按 SDK 的凭据 scope 隔离；source ID、namespace 仍保留在每条选中记录中。显式相对 `cacheDir` 按工作目录解析，不能据此推导跨 Skill 的作者路径。

未显式配置 activation 或共享 Profile 规则时，Skill 消费继承配对 SDK 的一小时正文默认值。已有 `activation.maxAge: 5m` 仍是五分钟覆盖；改为 `1h` 才会采用新时长。本地 Library 路由不会另行启动远程验证。同一凭据作用域和 Library 下，新进程可直接复用完整且未过期的 root 与 Requires 图，无需 HTTP，并保留原始 `validated_at`。显式刷新、过期、缺字节和未知凭据作用域继续走在线准入；已知精确拒绝仍阻止消费。目录保持独立策略，正文仍有效时也可能刷新元数据。

目录年龄始终从 SDK 原始 `validated_at` 计算。读取缓存或重启进程不会续期。过期菜单可以在单次后台刷新期间展示已有记录，位置仍绑定精确身份，新增候选追加，消失候选禁用。临时故障保留失败原因和短暂重试间隔；认证、权限或 scope 失败撤下候选。`discovery.offline` 仅使用合格缓存。目录刷新不读取正文，切换 Library 也不改写已接收任务和固定版本。升级扩展后启动新进程；`/context-broker refresh` 只刷新当前代码所读的数据。

新会话没有 Notion `$` 候选时，先核对当前宿主自己的 source 配置和实际安装 Broker 路径，不先改远端数据。Pi 与 OMP 配置独立；安装 Tern companion 不等于已加载 OMP 扩展。当前 SDK 目录发现不设额外的整条操作 deadline，内部每次网络尝试遵循配对 core 的请求预算；目录发现应仅处理元数据并消除逐成员重复请求。旧 Bundle catalog 必须显式转换并回写配置引用后才能交给 Router-only runtime，保留原件并另行迁移目录生成器；普通 refresh 不转换 schema，也不重新执行升级的扩展代码。所选 View 控制原生默认发现；完整 `$alias@namespace` 补全不受 View 限制。

`SOURCE_RESPONSE_INVALID` 也可能表示 source CLI 与当前宿主实际安装的 Broker 使用不同 wire schema。例如 CLI 目录已有合法的 `upstream: {repo}` 元数据，旧 Broker 的严格 record schema 尚未声明该字段，就会拒绝整份目录。核对真实 CLI 响应和安装目录中的 `src/notion-source.ts`；checkout 验收通过不代表安装包已更新。安装匹配的 Broker 构建并回写该宿主的 package 引用后，重启 Pi，或在 OMP 执行 `/restart`。目录 refresh 只重读数据。最后使用日常 source 配置，在真实终端核对候选、Tab 接受和完整正文投递。


记录身份为 `JSON.stringify([sourceId,sourceScope,kind,locator.type,id])`，source 独立为 local/notion；filesystem 使用真实文件路径。Notion 自动补全通常插入 `$alias@namespace`，重名时加 page ID。已接受的选择在当前 preparation gate 开始时同步冻结；前一轮准备或执行期间接受的新草稿不会改变前一轮身份，也不会被前一轮结束清掉。

独立 query/手动搜索统一插入既有完整身份语法：Notion 使用 `$alias@<规范化-page-id>@namespace`，filesystem 使用 `$name@<编码-local-id>@namespace`，原有本地 roots 使用 `local`。别名改名后仍按相同精确身份解析。官方随包 Skill 固定使用 `$name@builtin`；候选 label 保持简短可读。`skillRoots` 内同名仍按 root 顺序保留首项，独立 source 与 kind 不合并，共享选择器仍拒绝歧义。

CLI 目录带有 `upstream: {repo}` 的 Skill，在自动补全与手动搜索中显示 `repo/skill name [skill]`，例如 `pstack/correct [skill]`。`repo` 取已校验 Notion 订阅 `Name` 对应的调用 alias，不取仓库 URL 或 registry slug；Skill 名使用原始 `name`。输入 `$pstack/` 浏览该订阅下的 Skills，继续输入 `$pstack/cor` 缩小范围。已知订阅前缀只返回该订阅成员，不会因其他订阅的描述包含此前缀而混入。自动补全接受来源限定的选择器，独立 query/手动接受额外包含精确 page ID；两者都保留 source/page identity。此字段用于显示和搜索，不参与正文、快照或身份校验。

返回的完整选择器优先于 source alias 简写。本地 `$name@local` 在补全显示无后缀名字时也可调用，并选择保留的本地记录。因此 namespace 为 `local` 的 source 不会让已接受的本地 token 与带 page ID 的 source token 再次歧义；真正共享同一本地选择器的条目仍拒绝调用。

Source id 与 namespace 内部的点保留为选择器的一部分，例如 `$ui-alpha@team.prod`；句末句号不计入调用引用。

名字冲突时，自动补全显示来源限定的候选。已接受选择的精确 read 返回目标 not-found 时，用户收到提示，模型收到 `context-broker-unavailable` 和 `state: not-loaded`。完整身份 token 不在当前目录时报告 `catalog-unavailable`，不虚构 Notion 查询结果或 metadata。这些记录绝不算 loaded；同一提交重复组装 context 时不重读、不重复追加缺失说明，下一次用户提交仍可重试。

未知裸名 `$name`、简单 `$name@namespace`、金额、`$bunfs/root/chunks/cli-nxfh2cp0.js` 等路径、转义与 Markdown 示例继续按普通文字处理。缺失选择旁的原文与图片仍只派发一次。Pi 遇到歧义或已选记录的权限、网络、source、目录、完整性错误时，扣留未确认的指令并提示 warning，用户请求继续，不悄然改选其他来源。

### Pi 会话短引用

Pi 为 Notion 记录提供归属当前会话分支的不透明引用。它们是定位符，不是凭据或文件系统路径。

| 前缀 | 绑定内容 | 返回入口 |
| --- | --- | --- |
| `sr:C` | 已授权目录候选，尚未固定选中快照 | `notion_list` 与 View 元数据 |
| `sr:S` | 选中主文的确切 scope、record、snapshot、version、File 和正文 hash | `notion_use` 与完整原生主文 read |
| `sr:R` | 属于某个 `sr:S` 的资源，固定 owner、path、File、bytes 和 hash | 准备结果的目录或原生 read 的 `skill-directory` 尾部 |

### 精确 Skill 引用

统一协议为 `skill://<稳定-skill-id>[/<path>][?library=<library-root-uuid>][&snapshot=<snapshot-id>]`。
CLI、SDK 与 Broker 共享 `ntn-skills/ref`，均要求 `SKILL_REF_VERSION = 2`。
消费时复制返回的引用。`sr:C`、`sr:S`、`sr:R` 属于当前会话分支；可移植身份使用 canonical `skill://`。

| 引用 | 含义 |
| --- | --- |
| `skill://architect` | 已明确绑定的 Library 中稳定 ID 为 `architect` 的 Skill；读取其所选版本的主入口。 |
| `skill://architect/references/review.md` | 该 Skill 的准确文件路径；Library 来自实际包含链接的所选文件或入口已绑定的库。 |
| `skill://architect?library=44444444-4444-4444-8444-444444444444` | 完整当前身份 `{ libraryId: "44444444-4444-4444-8444-444444444444", skillId: "architect" }`。 |
| `skill://architect/references/review.md?library=55555555-5555-4555-8555-555555555555` | 显式指定另一套已配置 Library 中的目标，独立校验目标权限与所选快照。 |
| `skill://architect?library=44444444-4444-4444-8444-444444444444&snapshot=s_<64位十六进制>` | 从指定不可变 manifest 选择该 Skill 的主入口。 |

`library` 是 Library 根页面的规范 UUID。Skills、Files、Records、Sources 四张表都是它的直系子项。Source alias、显示名和表 ID 不用于选库。
省略它需要真实上下文：实际包含链接的所选文件，或命令/source 入口明确绑定的一套库。
没有上下文就报错；全局只找到一个同名 Skill 也不能补出作用域。
记录的 `id` 是完整 root URI，`ref` 带明确主文路径；locator 中的 `shared_skill` 仅保留为 Notion adapter 类型。

URI 中只使用稳定 Skill ID，不以 name、alias 或物理页面 ID 兜底。
新 ID 使用小写 ASCII 字母、数字、`.`、`_`、`-`；改显示名不会改变 ID。
文件路径保持大小写，空格和 Unicode 按路径段编码。重复或未知 query、编码后的分隔符、越界路径与 fragment 都拒绝。
省略 path 表示 Skill 本身，读取时使用对应 current/fixed manifest 的主入口，不把所有 kind 都写死为 `SKILL.md`。

固定引用只在目标所选 manifest 中解析。路径或旧字节缺失时，不切到当前版本。
原生 File ID 保留为内部 binding 证据；冻结 Source 文件可以没有投影的 Notion File 行。
公开 `file_id` 参数与旧 `shared_skill:…` 前缀不再接受。迁移旧 File-ID 引用必须先核对原 manifest，
再生成准确路径 URI；直接删参数可能读到另一个文件。

同一 Skill 内的文档继续使用相对路径。跨 Skill 优先写稳定 URI；只有实际包含链接的文件保留可靠
Source 原路径与固定 revision 时，才可解析跨 Skill 相对路径。缓存布局不构成相邻关系。
`read({path:"skill://architect/references/review.md", from:FIXED_CONTAINING_FILE_REF})`
从包含文件绑定省略的 Library；同 owner 继承该文件的 pin，跨 owner 保持目标自己的会话 pin。
显式跨 Library 还需要目标来源自己的配置与权限。
Members 与 Requires 仍是同库关系：Requires 显式维护；导入只在 Members 省略时，才可能从准确、有效且
唯一的链接推断成员。不确定就跳过，显式空列表保留，后续人工关系修改不被自动覆盖。
读取引用本身既不激活 Requires，也不修改这两类关系。

`notion_use({ref:REF})` 接受返回的 `sr:C`、`sr:S` 或 canonical 主入口 `skill://` 引用；`ref` 也可以是本次需要一起使用的多个根。它加载根与完整 Requires 闭包，以应用其指令。介绍、摘要或检查 Skill 使用原生 `read({path:REF})`，不启用 Requires。资源复制系统返回的准确引用。按需发现的 `notion_ctl({refs:[REF]})` 可导出固定 `sr:S`、`sr:R` 的 canonical 证明，未固定的 `sr:C` 不能提供该证明。

读取相对链接时，`read({path:RELATIVE_PATH, from:FIXED_CONTAINING_FILE_REF})`
接受选中的 `sr:S`、`sr:R` 或固定 canonical File ref。基准必须是实际包含链接的
文件。跨 Skill 解析需要该文件当前 Source 贡献映射，继续使用目标自己的会话固定
版本，并保持检查语义。未固定候选、资源批读和 `refresh:true` 不能用于这个入口。
详见[相对文件读取](fixed-resource-batches.md#relative-paths-from-a-selected-file)。

Pi 的正常 use 结果呈现所选根引用、完整正文和精简资源/关系目录。完整 hash、graph lock、规范身份与物化证明保留在工具 details 和显式证明导出中。确定性编译器逐字保留作者正文，用版本化回执将源 hash、渲染 hash 与实际内容位置绑定；重复读取和显式新选择只派生新的 provider 投影，不编辑会话原件。OMP 保留既有结果形状。[呈现与证明合同](skill-consumption-runtime.md#presentation-and-proof) 定义当前回执和完整内容边界；公开消费使用 list/read/use。

`notion_list` 保留完整名称、说明、来源、可用状态和分页，重复 `id/scope` 留在宿主 details。复制 `next_cursor` 继续同一查询；覆盖不完整或来源失败不等于空目录。当前 Notion 选择只注入固定引用、可用资源目录和完整正文，通用规则由宿主集中提供。恢复选择使用 canonical 固定引用，不把重启后的目录宣称为已注册资源入口。完整原生主文 read 保留精确正文前缀并复用精简目录，完整目录留在 `contextBrokerRead.directory`。源内容和 Notion 管理数据保持完整。详见[呈现与证明合同](skill-consumption-runtime.md#presentation-and-proof)。

`notion_ctl` 注册为 deferred，默认未启用。需要管理或导出证明时，可通过 Pi 可选的 `tool_search` 按需发现；禁用了工具发现的宿主需显式启用该工具。`notion_ctl({cli_source:"SOURCE_ID"})` 请求一个已启用 Notion source 的本机 CLI 调用元数据，要求 `bash` 已启用，且与 `refs` 互斥。返回 `{kind:"host_cli_scope", sourceId, command, database?, executed:false}`，解析真实配置命令或随包入口，不假设全局 CLI 已安装，不访问网络或执行命令。未知或禁用来源明确失败。取得元数据不授予执行权限，也不证明连通性。图与 `refs` 导出保持可移植且不含机器路径。

OMP 保留既有宿主协议的 `skill_search`、`skill_prepare({roots,purpose})` 和 `skill_graph`。这些是兼容调用方，不是第二套 Pi 默认工具。历史调用、pin 和会话回执保留原版本，不在持久会话中批量改名。

绑定先写入分支记录，再对外显示，并在 resume 时重放。当前分支没有的引用明确失败。每次使用仍校验当前授权来源、完整 owner 身份及固定快照。未知、格式错误、scope 不符或 owner 不匹配的引用不能回退为文件系统读取或当前内容。分配引用本身不读取或激活正文；`sr:S`、`sr:R` 也不证明已经投递。

### Pi 读取标题

Notion 主文在收起时沿用 Pi 原生 Skill 标题：
`[skill@notion] repo-docs-governance (ctrl+o to expand)`。支持文件显示
`[file@notion] repo-docs-governance / references/guide.md`，批量读取显示第一个路径和其余文件数。
展开提示跟随 Pi 配置的快捷键。展开后保留原始读取引用与原生结果；本地 Skill 继续显示 `[skill]`，
错误、图片提示、读取行号与工具背景沿用 Pi 的行为。

`@notion` 标识提供该 Skill 的 Notion 目录，其中的文件也可以由 Git 或其他资源提供字节。
已知重名条目会附上来源信息。标题直接使用本次准备或资源读取取得的元数据，不额外查询或读取正文。
显示元数据随工具结果保存，重放会话保留当时的名称与实际文件路径。缺少有效显示元数据的旧结果或未知版本使用原生标题。
名称不改变工具参数、准确引用、授权、选择状态或投递回执。

### Pi list 和 use 结果

Pi 将 `notion_list` 显示为 `[list@notion]`，包含查询词、结果数和紧凑的候选预览。分页区分当前页与全部匹配项。折叠时仍保留部分覆盖、来源失败、过期或离线提示。只有保存的响应明确证明目录新鲜、在线、完整且没有来源失败，空结果才显示为没有匹配项。远端内容搜索始终不保证穷尽；展开后保留命中片段与限制说明。

`notion_use` 显示 `[skill@notion]`、选定根的名称、其他根数量，以及去重后的已加载 Requires 数量。`loaded` 只表示本次调用准备了指令，不表示工作流已经执行，也不证明后续 provider 接受了请求。显式刷新成功显示 `reloaded`，不据此断言版本发生变化。展开后直接显示解码后的 Markdown 正文及资源、关系目录。目录条目不代表支持文件已经读取。

两个工具沿用 Pi 主题、原生工具外壳和用户配置的展开快捷键。加载中、取消和错误摘要保持可见；展开错误保留原始诊断。渲染器只使用已记录的结果，不做查询，不改变工具正文、引用、选择或交付凭证，因此会话恢复使用当时记录的名称和正文。无法识别的结果格式回退到原始文本。现有原生 `read` 渲染保持不变。

### 宿主发现与选中激活

Notion 用法指引由 Broker 在运行时负责，不在全局 `AGENTS.md` 或 `CLAUDE.md` 重复常驻；这些文件只保留跨 Agent 的偏好与行为规范。正常 Pi 指引只讲选路和授权边界，分页、刷新与参数细节留在工具定义中，具体工作流留在选定的 Skill 正文中。原生能力不足时才补充对应来源的 CLI 后备路径。没有启用 Notion source 时，不注入 Notion 指引、目录或工具。

Pi 在 provider 派发前根据公开的 active-tool 列表生成 `<ntn-skills-guidance>`。日常消费使用 `notion_list`、原生 `read` 与 `notion_use`；本地 Skill 保留原生发现和读取。原生读取接受准确的 `sr:C`、`sr:S`、`sr:R` 和 canonical `skill://` 引用。原生发现与读取齐全时，不附上重复 CLI argv 或 shell 模板。缺少能力时，仅在 `bash` 已启用的情况下提供所选来源的 CLI 后备说明；指引不会启用工具。管理使用上文按需发现的 `notion_ctl`。普通续问复用完整正文，当前明确要求的 read/use 仍通过可用且已授权的入口执行。介绍与检查把指令当作内容，不采用其中的工作流或前置检查。`notion_use` 保持模型直接调用；Code mode 内层成功不能证明模型收到完整正文。

OMP 与没有公开工具能力 API 的宿主保留既有 CLI 指引。argv 与宿主命令使用同一 resolver，保留各已启用来源的 id 与可选 database，`list-args`、`read-args`、`files-args`、`resource-read-args` 提供带范围的后备语法。保留 JSON 输出核对 `ok`/`error` 和快照身份，语法失败查看子命令 help。两种指引本身均不发现内容、执行命令或激活 Skill。

会话 `sr:` 句柄归属 Broker，独立 CLI 不接受它们。CLI 后备路径使用已返回的 canonical 引用或已选 snapshot/path。只有会话句柄时，可用所选来源的 CLI `list`，按确切 record 身份取得同一候选的 canonical 引用；不由名称猜身份，也不向 `sr:` 追加路径。资源优先复制系统返回的 canonical ref。

宿主观察当前随包 CLI 的字面 `ctl library import` 和 `ctl library source` 调用。Source 动作为 `apply`、`refresh`、`enable`、`disable`、`remove`、`takeover` 和 `restore-follow`。结果必须匹配实际命令、operation 及准确的 library/database/data-source 身份。import 核对稳定 Skill、合法物理页面与准确库归属。删除后重建可以改变物理 page ID；结果只触发重新发现，不直接提供替换正文。Source 声明核对全部子结果：仍存在的成员为 ready，上游删除的成员为 removed 且 files=0，删空也按此收敛。文件接管仍要求 ready 子结果，并匹配 Source 路径、稳定 File 和目标 Skill。启停结果须匹配请求的布尔值及准确的 metadata target 绑定；移除必须返回 `action: remove`、`state: removed`、`status: removed`，ready 子任务回执不能证明 Source 已清退。Source 页面始终不作为 Skill 页面。

成功 `applied` 或 `removed` 只让对应配置来源在下一次发现时刷新。普通 `unchanged` 不刷新；同 operation 的显式 `--resume`，以及 `--supersede OLD --operation NEW`，返回 unchanged 时可恢复此前写入的可见性。supersede 要求新旧身份不同，并与 resume、真正的 dry-run 互斥。数据库 ID、HTTP(S) Notion URL 和精确配置别名采用同一归属。旗标接受等价语法、import 的多个不同 `--native PATH` 以及精确文件接管参数。takeover 默认 resource，`--as native` 明确选择可编辑正文。拒绝重复单值参数、重复 native 路径、动作不支持的旗标、真正的 dry-run 和复合 shell。

写入失败时，如果错误携带已确认且匹配的当前 operation，也可让目录失效，因为部分内容可能已经写入。import 要匹配 Skill 上下文；Source 要匹配有限父意图与输入指纹，子任务不能冒充父任务。supersede 交接前的错误可以仍指向显式指定的旧意图，这只允许保守重读，成功结果必须属于新 operation。错误仍是错误。识别到真实宿主截断 footer 且 entry 能精确归属时，只保守刷新一次，不声明成功，不补读 artifact 或声明文件。没有 operation 上下文的本地预检失败、未知输出、多个 JSON 或 JSON 正文内的截断标记都不算完成写入。

自动刷新保留来源 offline 策略，不取消已接受草稿，不替换会话已经选择的内容。宿主观察之外的写入继续依赖正常时效或 `/context-broker refresh`。旧 create/apply/sync 回执、独立 operation 路由与 OMP artifact 跟随已从此 observer 退役。

CLI 成功读取返回顶层 `content`（正文）、pinned `ref`（相对 `read --from` 的基准）和 `snapshot_id`（`files` 的目标）；`record` 是元数据。资源使用清单返回的文件 ref/path。介绍与摘要只描述工作流，不执行其准备、仓库检查或运行步骤。

Pi 只在 provider 投影中替换本扩展拥有的旧指引，不重写原始 JSONL。工具变更、重复、fork、持久续接、压缩和回退后都提供一份当前指引；公开 `context_with_system` handler 在 conversation context handlers 完成后复核当时的工具列表，并保留原 leading system 消息。用户/助手/工具中的示例和仅含标记的摘要保持普通内容，不能压掉扩展自己的指引。OMP 保留原有效上下文去重与恢复方式。

宿主/Broker 提供的完整 Skill 正文或成功读取返回的正文可以直接使用。介绍、摘要无需再次读入口、列缓存目录、查包清单或代理界面元数据；只有当前任务确实需要资源内容时才读取支持文件。本地 Skill 的相对路径以实际包含链接的文档目录为基准。Pi 读取 Notion 相对引用时，把该文档的固定 ref 传给 `from`；CLI 使用同一 ref 的 `--from`。跨 Skill 的 Source 链接通过身份映射解析，不从缓存目录猜相邻路径。Pi 与 OMP 保留各自可用工具，目录 description 不算已加载正文。

Pi 与 OMP 的选中 Skill payload 在完整正文旁提供经过转义的 `skill-directory` 和按任务读取资源的指引。Notion 记录还提供选中版本的 pinned `skill-ref` 与 `snapshot-id`。Pi 的 `hash`、`basename` 模式隐藏本地目录后，原生工具仍可使用公开的固定引用及准备结果中的资源目录。使用 CLI 后备路径的宿主继续保留来源/数据库范围，执行 `files SNAPSHOT` 或 `read SNAPSHOT --path RELATIVE`。已加载正文的提示明确保留用户任务边界：加载不授权执行工作流、环境探测或前置动作；介绍只把这些指令作为内容说明。

普通本地 Skill 保留 Pi 原生发现和 read。显式配置的 filesystem source 继续使用其元数据目录与选中快照机制。Notion source 发布所选 View 的 Skill 与 Router 元数据；`default_context` 通过 View filter 影响成员名单，Prompt 保持仅显式调用。Pi 显示作者名称、明确来源和准确入口引用。read 只检查所请求内容；`notion_use`、`/skill:` 与 `$` 准备所选指令及 Requires，Members 在选中前保持候选。复制宿主实际公布的名称或引用。OMP 保留 `notion-ui-alpha` 等宿主名称与 metadata 路径激活；这些展示名称不成为 Skill ID，可移植链接使用返回的 canonical 引用。

目录注册后，显式配置的预取预算可对初始 View 中最多 `maxNodes` 个可用 Skill/Router 根发起一次公开 `prepare --purpose inspect --priority prefetch`。预取不展开 Members、不准备 Requires 闭包、不读取 Prompt、不导出宿主目录、不追加会话锁，也不投递正文。`maxBytes` 限制完整成功 preparation JSON 与每份主文，不是网络传输配额；`maxTimeMs` 限制任务生命周期，`rateShare` 使用同一 CLI 调度器的独立低优先级通道。前台选择或资源读取会取消预热，不等其迟到回调；服务压力推迟预热，不增加后台重试。前台等待者独立持有取消状态。激活仍校验 CLI 缓存资格，正文默认一小时，失败不隐式回退旧内容。切会话取消所属工作；移出 View 不移除当前会话已加载的指令。

默认激活策略下，Notion 修改或缓存过期都不替换当前分支已选的确切 Skill 快照。新会话（包括在另一进程中新建的会话）重新检查引擎缓存资格：可用快照直接复用，命中不推进 `validated_at`；当前观察过期后，先重新校验再选择版本。选中图绑定可跨重启和压缩保留，与正文投递状态分别管理。相对资源始终跟随选中快照。

Pi 在下一次 provider 请求前恢复有效上下文中缺失的已确认 active 指令，包括压缩或进程 resume 后的普通续接。恢复读取当前分支已确认的快照向量，核对完整字节与 hash，并保留原图；不会沿新变化的 Requires 边扩展，也不会替换为当前内容。固定内容缺失、无效或恢复超时时，扣留对应内容并提示 warning，用户请求继续。回退或切换分支只使用该分支的确认记录；仅选中的绑定和未确认的准备不能激活指令。真实终端与原生编辑器的验收入口见 [NS-SESSION-09～12](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/features/session-cache-recovery.md) 与[依赖图验证地图](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/features/skill-dependency-graph.md)。

当前完整、稳定的 Notion 页面在缓存校验后可直接读取人工编辑，显式刷新使用 `read CURRENT_REF_OR_PAGE --refresh`，不再要求先 inspect/accept-edit。旧 pinned snapshot 保持不可变。读取不推进 upstream 版本，不改变归属。Tracked 内容可读，但通过 CLI 修改其正文、资源、Name/Description 须修改源或显式 fork；Default Context 等组织属性可独立编辑。Publication 尚未完成、读取时图发生变化、资源权限/缺失和完整性错误仍明确失败；同步继续将本地手改视作冲突。

扩展根据当前宿主 API 选择 Adapter。Adapter 负责原生目录注册、提示词呈现、编辑器装配、输入返回值及提交协议。OMP 使用命令提交与 handoff 回执；Pi 保留已接受的输入，在可取消的 context 阶段准备，并在 provider 响应边界确认投递。共享 preparation gate 管理取消归属；Pi 的提交与队列仍由宿主管理。`CONTEXT_BROKER_HOST` 只选择配置和独立补全的备用默认路径，不切换当前宿主的提示词、编辑器或提交协议；显式 agentDir 优先。

OMP 的 print/json 模式执行原生 source `/skill:` 命令时，命令等待触发的 agent turn 结束后返回，确保进程不会在 provider 请求开始前退出。交互与 RPC 模式仍由宿主管理 turn。

Pi 的显式 `$` 和原生 Skill 准备采用与工具一致的紧凑 Notion 标签。等待时立即显示一行 `[skill@notion] reframe, sharpen · loading…`，不铺开原始预算数字。结束后保留可展开的会话记录，沿用 Pi 主题和用户配置的展开快捷键。内容获取完成为 `ready`，只有确认已投递给 provider 后才改成 `loaded`；检查读取显示 `read`，获取失败显示带 warning 的 `unavailable`。展开详情包含原因、来源、准备预算及选中的版本和快照。终态记录可在 resume 后恢复，未完成的历史记录显示中断；用户 Stop 仅清除待处理 widget，不再追加 warning。展示消息的 `content` 为空，元数据放在 `details`，不进入 provider 消息、上下文、压缩或 branch 摘要。实际引用仍为 `skill://` 或会话 handle，展示记录不是模型工具调用。目录发现不会在选择前注入正文，复用已选快照也不追加重复准备记录。

Pi 在可取消的 `context` 阶段获取选中内容，原生编辑器和后续消息队列保持可用。Broker 不禁用 Enter，也不吞掉后来排队的 prompt 或图片。**Stop** 和 Escape 取消当前操作。准备成功后，首个 provider 请求包含原提示词、图片附件及完整选中正文；Broker 失败或超时时扣留失败的获取、提示 warning 并继续原请求。用户取消和切换会话会使待完成的准备失效，迟到结果不能派发。OMP 保留通过命令执行的 preflight 及提交 gate。

OMP 在每轮系统提示中说明：宿主或 broker 提供、且仍在有效上下文中的完整 Skill 正文已满足“使用前读取”要求。Broker Skill payload 标明调用引用、source 的 qualified 原生宿主名、完整入口已加载状态与入口资源目录。模型应直接使用正文，无需仅为重新加载或确认身份再次读取入口、列缓存目录或检查包清单。任务需要的参考资源仍可读取；相对路径从该目录解析，`~` 展开为用户目录。`pathMode: hash|basename` 继续隐藏目录；source 资源仍可使用 qualified `skill://` URI。目录描述与 Router 索引不代表成员正文已加载，压缩或回退移除正文后仍须重新读取。Tern 自动胶囊和手动搜索沿用这条 OMP 提交合同。该提示规则仅用于 OMP。Pi 保留宿主原有提示；真实 Notion 发现、入口与资源消费独立使用联动 Skill 的 `--mode model --host pi` 路径验收，终端选择使用[Pi 独立终端规程](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/features/dollar-completion-selection.md#pi-独立终端)。

OMP 将交互 `/skill:` 与调用提示词转到扩展命令中等待，避免触发宿主 input hook 的 30 秒预算。Broker 不再设置完整加载的总时限，由 source CLI 对每次网络尝试独立执行 `requestTimeoutMs`（默认 30000）。模型原生 `read` 通过非可见 overlay 等待机制保留当前会话与编辑器。请求失败阻断提交；Escape 和 Stop 取消整个 preparation。

OMP 无界面激活保留 25 秒保护，早于宿主的 30 秒事件限时；到期显示 `SOURCE_ACTIVATION_TIMEOUT` 并终止 source 进程树。这是独立于单请求 `requestTimeoutMs` 的宿主事件保护。`context-broker-submit` 是 broker 内部恢复交互提交的命令，需要有效的待提交 id。

OMP 原生 Skill 消息的完整 metadata 入口路径通过 broker 持有的 index 映射还原 source identity，因此后续 `$` 选择不会再次注入同一正文，即使发现期间生成了新的 metadata 入口。仅名字相同、路径属于另一来源的 Skill 不会被视为已加载。

Source 正文仍在当前有效上下文时，OMP 原生 `/skill:` 复用已有正文，只发送调用参数和图片，不再追加正文或新的 loaded 回执。回退或压缩移除原正文后，可再次完整激活。

Pi 保留已接受的原生 `/skill:` 输入与图片，不由宿主提前执行不可取消的正文读取。Context 准备解析选中记录，将完整正文与调用参数一起提供。复用检查归属本扩展的投递证据和有效上下文；完整原生主文 read 还附带回执与固定引用目录。缺少正文的标记和用户编写的 XML 都不能证明投递。压缩后缺失的已确认 active 内容按前述固定快照路径恢复。

原生命令参数包含所选 `$` 引用时，同一轮也只发送一份正文。Pi 首次激活与复用均完整保留空格、Tab 或换行分隔后的参数。

Pi 的 Notion Skill/Router 路径对每个来源图调用一次 SDK v3 `consume`，同次取得已校验的图、完整主文和完整文件 manifest。Broker 发布入口前核对根、scope、物理 owner 与 File 绑定。每次操作独立持有 environment、cwd、runtime 与 abort signal。缺失或不兼容的 SDK 明确返回 `SOURCE_SDK_UNAVAILABLE` 或 `SOURCE_SDK_INCOMPATIBLE`，无 CLI 回退；OMP/Tern 工作延后。

完整文件 manifest 带有准确路径 ref、hash 与字节数；独立 native binding 保留可选 File ID，冻结 Source 文件可以没有投影的 File 行。宿主初始只在 `entry` 投影中保存主文。标量资源使用 SDK `readSkill` 的准确 File ref 与自有 output，批量资源使用 `readResources`。两者都核对 scope、owner、选定内容、存在的 native File binding 与完整 bytes/hash，只发布请求文件；二进制保持字节。未知路径、中断输出和不匹配结果不能成为 ready。缓存字节缺失时，只有当前权威仍匹配所选内容才可重新取得，不提供远端历史快照恢复。

公开准备结果分别报告 `manifest_complete`、`local_files_ready`、`materialized_paths` 和 `loaded`。成功的原生资源结果携带 `contextBrokerResource`，包含确切文件身份与 hash；仅当实际返回文本包含完整预期字节时，`delivered_complete_text` 才为 true。资源回执不是主指令 loaded 回执。即使没有下载资源分块，当前元数据或权限校验仍可能发起请求。

Prompt 同样使用 SDK `consume`，不再有完整 export 兼容路径。缓存只是所选操作的可丢弃本地材料，按凭据 scope、owner 和所选内容隔离。诊断仅暴露安全错误码，不回显原始 stderr 或凭据。

Filesystem source 扫描本地文件以提取 frontmatter，只将元数据发布到进程私有的临时 index；metadata-only 目录不表示 scanner 不读取原文件字节。首次选中激活会将完整 Skill 目录复制为进程 snapshot，保留资源；原生 read、原生命令与 `$` 共用这份选中副本。该 filesystem snapshot 不要求 Notion export receipt，selection 也不跨进程持久化。

激活后的原生宿主发现发布独立 alias 主文，frontmatter 的 name 改为 qualified 宿主名；没有 frontmatter 时添加 name/description header，正文保持原样。入口投影只发布主文与 `host_index` 身份回执，记录原始/发布 hash 并明确 `loaded:false`。资源通过已校验的完整 manifest 解析。发布 alias 不刷新所选内容，也不代表已向模型交付。

修改配置或扩展代码后重启宿主（OMP 用 `/restart`）。选中正文仍在有效上下文时，原生 read、原生 `/skill:` 与 `$` 复用该 pinned snapshot。Pi 按需从固定快照恢复已确认 active 内容；没有 active 确认的选择仍遵循 activation 策略。OMP 在正文离开上下文后，复用准备字节前仍检查 read 策略。进程内映射不延长 freshness，也不代表上下文已加载。`/context-broker refresh` 刷新元数据、取消旧代际准备、发布新宿主 discovery generation 并清除进程内激活映射，不重新执行扩展代码、替换会话内容或推进已确认 active 的快照。新会话遵循当前 activation 策略。Discovery freshness、准备结果 freshness、pinned resources 与 active 会话上下文是独立状态。

本 checkout 的验证入口：[broker verification](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-context-broker/SKILL.md)、[Notion integration verification](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/SKILL.md)，以及 CLI 仓库 `.cursor/skills/verify-ntn-skills/SKILL.md`（[仓库](https://github.com/yoyooyooo/notion-skills-cli)）。这些是操作规程，不代表某个版本或环境已经通过验收。在broker checkout运行 `bun run check:broker` 验证当前代码，按integration Skill执行同一候选的安装后SDK/HTTP检查。实际Pi与真实Notion沿保留的SDK及日用安装/候选助手，在AH-1063单独执行。这些检查不证明原生终端UI；OMP/Tern延期。


### 环境变量

| 变量 | 作用 |
| --- | --- |
| `CONTEXT_BROKER_CONFIG` | 使用一个显式 config 文件 |
| `CONTEXT_BROKER_ROOTS` | 用 path-list 替换 `skillRoots` |
| `CONTEXT_BROKER_EXTRA_ROOTS` | 追加 skill roots |
| `CONTEXT_BROKER_DISCOVERY_CATALOGS` | 用 path-list 替换 `discoveryCatalogs` |
| `CONTEXT_BROKER_EXTRA_DISCOVERY_CATALOGS` | 追加 discovery catalogs |
| `CONTEXT_BROKER_REQUIRE_ENABLED=0` | 规则匹配时允许所有发现到的 skills |
| `CONTEXT_BROKER_REQUIRE_ENABLED=1` | 强制要求 `autoload.enabled: true` |
| `CONTEXT_BROKER_LOG_FILE` | 写入 JSONL decisions 和 injections |
| `CONTEXT_BROKER_HOST=pi\|omp` | 选择配置与独立补全的备用默认路径，保留当前宿主的 Adapter |

Path-list 分隔符跟随平台：macOS/Linux 用 `:`，Windows 用 `;`。

## Rule files

Rule files 默认放在 `context-broker/rules/*.yml`。每个文件描述一个触发 profile。

```yaml
id: architecture-review
inject:
  - design-review
  - router:workspace-collab
match:
  - exact:
      - review this design
  - regex:
      - '^design review:'
  - contains:
      - architecture
    not:
      - contains:
          - no context
```

一个生成文件也可以通过顶层 `rules` 数组声明多个 profile；这适合由同一份场景配置投影一组 Router 触发规则：

```yaml
version: 1
rules:
  - id: scene-coding
    inject:
      - router:scene-coding
    match:
      - contains:
          - 编码场景
  - id: scene-research
    inject:
      - router:scene-research
    match:
      - contains:
          - 深度研究
```

旧的单 profile 文件格式继续兼容。若顶层 `rules` 非空，插件以其中的有效规则为准。

如果想换 rule 目录，设置 `ruleRoots`。

## Discovery catalogs

Catalog 是独立 YAML 或 JSON 文件。YAML 更容易 review，是推荐格式。

成员可以按 name 引用已发现 skill：

```yaml
members:
  include:
    - docs
    - chat
```

成员也可以指向 catalog 相对路径下的文件：

```yaml
members:
  - type: local
    path: ./members/docs/SKILL.md
```

如果文件是 `SKILL.md`，Context Broker 可以从 frontmatter 读取 `name` 和 `description`。只有需要覆盖 metadata 时，才需要手写这两个字段。

远端成员固定使用 `{type: remote, source: {namespace: production}, id: "skill://review?library=44444444-4444-4444-8444-444444444444", locator: {type: shared_skill, library_id: 44444444-4444-4444-8444-444444444444, skill_id: review, page_id: <UUID>, database_id: <UUID>, data_source_id: <UUID>}, ref: "skill://review/SKILL.md?library=44444444-4444-4444-8444-444444444444"}`。`ref` 可附加 `&snapshot=s_<sha256>` 固定版本，不填写 path、scope 或 cached path。`source.namespace` 精确匹配已启用配置源的 namespace，未配置 namespace 时匹配该源 id；不从 label 推测，也不通过 catalog 授予凭据权限。

Broker 在源目录发现后按当前凭据范围内的 record、完整 locator、kind 和 ref 解析成员，只读元数据。未知、离线或歧义成员保留在索引中并明确标记 unavailable，同时进入 doctor 诊断；本地成员继续可用。Agent 按需读取成员 ref。已有远端 Router 可直接作为 `kind: router` 加同一 remote 身份字段的 catalog record（入口为 ROUTER.md），不重复生成页面或成员；已交接的 scene 应移除重复的本地 Router 与规则。

本地 Router 声明的入口缺失（`ENOENT`/`ENOTDIR`）或超过发现扫描上限（`LOCAL_ENTRY_TOO_LARGE`）时也保留在目录中：保留声明的 name、path、ref、id 与明确 unavailable 原因；超限时同时保留 bytes/max。它们仍计入 Router 数量，发现阶段不读取不可用入口正文。

完整示例见 [`discovery-catalog.example.yaml`](../examples/discovery-catalog.example.yaml)。

## 注入 payload

Skill 注入：

```xml
<context-broker-record kind="skill" name="design-review" path="~/context/skills/design-review/SKILL.md">
<body>
Review the design for ownership, boundaries, failure modes, and migration cost.
</body>
</context-broker-record>
```

Router 注入：

```xml
<context-broker-record kind="router" name="workspace-collab" path="~/context/catalogs/workspace.yaml">
  <description>Collaboration contexts for documents, chat, and tasks.</description>
  <rules>
    <rule>Read the selected member file before using member-specific details.</rule>
  </rules>
  <policy memberBody="read-before-use" scope="members-only"></policy>
  <members>
    <member name="docs" path="~/context/skills/docs/SKILL.md">Document reading and editing context.</member>
  </members>
</context-broker-record>
```

## 命令

```text
/context-broker status
/context-broker doctor
/context-broker refresh
/context-broker sources
/context-broker connect SOURCE ENTRY --config /absolute/config.json
/context-broker roots
/context-broker catalogs
/context-broker find <query>
/context-broker explain <record>
```

用子命令，不要用 colon-style command name。Pi 会把 colon suffix 用于命令冲突消歧。

`/context-broker find <query>` 列出每条匹配记录的选择器、kind、来源和完整路径，包括共用一个选择器的记录。它不注入记录。

`/context-broker sources` 显示本地准备任务的 queued/running/ready/error/cancelled 状态、代际、snapshot/version ID、CLI freshness 和安全错误码，不发起模型请求。Ready 只表示内容已准备，不表示指令已在当前会话中加载。

## 安全与隐私

这个包运行在宿主 agent 进程里，权限等同于宿主。只从可信来源安装。

Context Broker 的设计目标就是把你选中的上下文发给模型：

- 匹配到 `skill` 时，完整 `SKILL.md` body 会发送给模型，并写入本地 session history。
- 匹配到 `router` 时，只发送成员 name、description、policy 和 member path，不发送成员 body。
- Session JSONL 会保存注入内容。
- `CONTEXT_BROKER_LOG_FILE` 会记录匹配 query 和 record name。除非设置 `logPaths: true`，否则不会记录路径。
- `pathMode: home-relative` 会尽量避免暴露完整 home 目录路径。
- `pathMode: hash` 可以进一步隐藏路径。

请使用可信 roots、catalogs 与 Notion databases。Skill 本质上是 prompt content，可以指挥模型。Notion 认证留在 CLI 既有凭据存储/环境中；元数据与选中的正文/资源缓存在本地，选中内容会发给配置的模型 provider。

## 会话去重

Broker 注入前检查当前分支的有效上下文。再次提交同一记录会提示 `already loaded`，不会追加第二份正文；已加载的正文仍随会话上下文发送给模型。

Fork 保留正文时仍跳过；回退或压缩移除正文后可以重新注入。普通用户、助手或工具消息里的 XML 示例不算加载证据。

## 补全 CLI

npm 包提供 `context-broker-complete`，从 stdin 接收一条 version 1 JSON 请求，向 stdout 返回一条 JSON 响应。它按 `cwd` 查询随包 Skills、配置中的 sources、原有 roots 和 catalogs，不继承宿主系统提示中的 Skill。Notion 补全使用配置的 discovery 策略与 CLI 既有认证查询元数据，不返回 Skill 正文。Source 失败仍保留可用候选，另通过可选 `failures` 数组返回，Tern 提示后继续打开可用候选。无效请求或配置仍以非零退出码失败，诊断写入 stderr。

```json
{"version":1,"text":"Use$des","cursor":7,"cwd":"/workspace/example"}
```

可选字段 `config` 用于指定 broker 配置路径。所有偏移都以 UTF-16 code units 计数，包括 `edit.len` 中的原始文本长度：

```json
{
  "version": 1,
  "edit": {
    "from": 3,
    "to": 7,
    "len": 7,
    "prefix": "$des"
  },
  "items": [
    {
      "identity": "[\"local\",\"\",\"skill\",\"local\",\"local:/workspace/example/skills/design-review/SKILL.md\"]",
      "kind": "skill",
      "source": "local",
      "ref": "/workspace/example/skills/design-review/SKILL.md",
      "value": "$design-review@local%3A%2Fworkspace%2Fexample%2Fskills%2Fdesign-review%2FSKILL.md@local",
      "label": "$design-review [skill]",
      "description": "Review architecture and API trade-offs."
    }
  ]
}
```

这个响应假设 Skill 位于配置 roots 中的示例路径；value 携带完整精确身份，label 保持可读。`edit: null` 表示光标前没有 `$` 补全前缀；光标落在 emoji surrogate pair 中间会被拒绝。别名、模糊排序与 Router 优先规则和 broker 共用；调用方应用编辑前必须检查草稿没有变化。

Notion source 可选 `default_view_id` 稳定 ID；当前会话选择优先，未配置时使用同一内容库 API 首个 View。

### Select a View for this session

```text
/context-broker views
/context-broker view
/context-broker view VIEW_ID_OR_NOTION_URL
/context-broker view notion VIEW_ID_OR_NOTION_URL
/context-broker view default
```

`views` lists API-ordered choices with exact selection commands. `view` without arguments reports name, ID, source, selection origin and count. Omitting the source ID uses the selected Library; an explicit source ID targets another enabled Source. Selecting a View changes only the active session; `default` resets to configured selection or first-View fallback. These commands do not call the LLM. The next ordinary user submission receives the new names/descriptions; full Skill bodies remain on demand. A source may set `default_view_id: VIEW_UUID` beside `library` in YAML. Names are never special and API order is not promised to match UI tab order.

The active-branch custom entry `ntn-skills-view-selection` records version, source ID and canonical View ID. A null View ID resets the session override. It contains no instructions and is not a model message. Resume and branch navigation replay their own entries; parallel sessions never share mutable choice state. Validate a requested View before persisting it. Stale asynchronous callbacks are fenced at session boundaries. View selection does not modify source configuration files, withdraw previously loaded bodies or re-execute the extension.

View 管理调用 `ctl views`；发现使用 `list --view`、`list --default-view` 或默认 SDK 的对应入口。显式 custom CLI 须实现这些路线。CLI 保留历史 `views` alias，当前 Broker 调用方使用 `ctl`。缺少 View 能力时明确报错，不静默退回 checkbox 发现；受支持的显式 list/read 仍可用。

### 大型远程库的按需读取

Notion source 默认不预取正文：省略 `prefetch`、设置 `false` 或旧布尔值 `true` 都是零预算。目录只展示名称、说明和准确入口；正文与资源按任务选取。只有显式非零预算对象才启用上文的有界 inspect 预热，不逐页 read/export，不准备 Requires，也不生成已交付记录。关闭预取保留元数据目录、完整 `$` 补全、显式 read/use 与固定版本校验。

## 原生读取、缓存与会话固定版本

Pi 通过 `read` 检查远程 Skill 后，只有实际完整交付的工具正文才可供后续问答复用；这不证明 Requires 已准备或该工作流已 active。随后明确 use、`/skill:` 或 `$` 仍须满足所选根和完整 Requires 的合同，复用有效正文时不重复注入。部分读取、错误结果、用户粘贴的标签或已被压缩移除的正文都不能替代实际交付。

会话续接沿用原来选定的固定快照，包括关联资源。Notion 后续更新由新的当前读取或显式复验发现，不会把旧会话的 A 主文与 B 资源混合。新会话可以复用有效 CLI/Broker 缓存；已有会话是否保留正文是另一层状态。模型提供方自己的 token cache 与这些应用缓存互相独立。
