# Broker 参考

[English](./reference.md) | [中文](./reference.zh-CN.md) · [项目概览](https://github.com/yoyooyooo/pi-context-broker/blob/main/README.zh-CN.md)

Pi/OMP broker 的完整配置、发现与注入参考。首次使用先看[快速开始](../README.zh-CN.md#快速开始)。

[Skills](#skills) · [Routers](#routers) · [配置](#配置) · [Sources](#内置-sources) · [规则](#rule-files) · [命令](#命令) · [补全 CLI](#补全-cli)

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

`$ntn-skills@builtin`、`$ntn-skills-maintain@builtin` 和 `$ntn-skills-sync@builtin` 是 Broker 与独立 Tern query 随包提供的普通本地 Skill。入口与相对参考文件在安装后即可离线读取，零 Notion source、没有全局 `ntn-skills` executable 时同样可用。选择、草稿与加载均使用普通 `$` 链路。

Notion 正文编辑使用 maintain，已连接 upstream/local 的维护使用 sync，CLI 命令及资源用法使用入口 Skill。当前 Agent 按 `<ntn-skills-guidance>` 中的真实 argv 和所选 source/database 执行。每个已配置 Notion source 保留自己的 executable 与 scope；多个 source 须明确选择目标。零 source 时使用随包 Node CLI，由 CLI 自己的配置提供默认范围。

私有随包内容使用 `builtin:<name>` 身份和固定 `@builtin` 选择器。同名 filesystem 或 Notion 条目保持独立身份与选择器；namespace 为 `builtin` 的配置来源也不能冒用这三个官方 token。指向同一随包文件的物理别名先去重，再处理本地名字优先级。

升级 Broker/配套插件即可升级工作流与资源，扩展代码变化后重启宿主。使用前无需 publish/install，也不扫描旧中央安装回执。用户自行维护的副本仍是普通文件，可以通过显式配置 roots 发现。

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

CLI 目录只返回 `records`，每条必须包含 `id/kind/locator/name/alias/description/default_context/entrypoint/ref`。Broker 拒绝未知 kind、错误 locator 和旧 `skills/skill` 字段。read/export 共享 `record/entrypoint/scope/snapshot_id/version_id/ref`；export 固定 read 选中的快照，核对 portable v2 和完整文件清单。身份为 `JSON.stringify([sourceId,sourceScope,kind,locator.type,id])`，来源独立为 local/notion。

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
    # 省略 command 即使用包内 CLI。
    # 自定义 CLI：command: [node, /absolute/path/to/ntn-skills/dist/ntn-skills.js]
    # 将示例值替换成自己的 Skills database id/selector。
    database: 00000000-0000-0000-0000-000000000000
    cacheDir: ~/.cache/context-broker/notion
    discovery: {maxAge: 5m, offline: false}
    activation: {maxAge: 5m, offline: false}
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
| `command` | Notion | 默认用 Node.js 启动包内 `ntn-skills`，不查找全局 CLI；字符串覆盖为单个 executable，数组覆盖为 executable 和固定参数；不启动 shell、不做 shell 展开 |
| `database` | Notion | 可选 CLI database id/selector；传给 `list` 与选中后的 `read` |
| `cacheDir` | Notion | 默认 `~/.cache/context-broker/notion`；保存 broker 元数据与导出 snapshot |
| `discovery` | Notion | 元数据 `list` 策略：`maxAge`、`offline` |
| `activation` | Notion | 选中记录 `read` 策略：`maxAge`、`offline` |
| `requestTimeoutMs` | Notion | 以 `NTN_SKILLS_REQUEST_TIMEOUT_MS` 传给 CLI 的单次网络尝试超时；正整数且 ≤ 2147483647；CLI 默认 30000 |

`maxAge` 接受 `0`，或整数加 `s`、`m`、`h`、`d`。省略策略时使用 CLI 默认值。`offline: true` 优先于 `maxAge`，只使用已有 CLI 缓存；缓存不存在或不完整时失败，不悄然联网。[schema](../examples/config.schema.json) 拒绝未知 source 字段和类型不匹配的配置；source id 唯一性由 broker 运行时检查。

Source CLI 命令不设总时限。每次网络尝试独立计时；分页、重试和限流等待可以使完整 Skill 加载超过一分钟。显式 `requestTimeoutMs` 覆盖子进程环境，省略时沿用 CLI 环境及默认值；自定义 command 须自行实现该环境契约。Escape、Stop 和切换会话仍会终止本次 source 进程树。可选的本地 cache identity 探测单独保留五秒上限。

发现时，broker 在 command 前缀后追加 `list [--database <selector>]`；选中激活时追加 `read skill://<page-id>/<entrypoint> [--database <selector>]`；固定资源时调用 `export <snapshot-id> --projection snapshot --format directory --output <broker-stage-directory>`。Discovery 与 activation 分别追加自己的 `--max-age <duration>` 或 `--offline`；显式元数据刷新使用 `list --refresh`。Export 使用 read 返回的不可变 snapshot id，不再次读取未固定的最新正文。

认证沿用 `ntn-skills`，例如通过可信秘密输入管道执行 `ntn-skills ctl config set-token --stdin`，或使用 `ntn login`。CLI 优先级为已有 saved token、非空 `NOTION_API_TOKEN`、`ntn` login。Broker 和 Tern 配置没有 token 字段。自定义 `command` 必须遵守相同 CLI JSON 合同。

构建把独立 `ntn-skills` CLI、三份工作流 Skill、运行依赖与许可声明随两个产品分发，具体版本由[构建输入](../CONTRIBUTING.md#bundling-cli-and-skills)决定。在线 Notion source 另外需要官方 `ntn` 0.22.12+，支持 `api --notion-version`；`NTN_SKILLS_NTN_BIN` 可指定 executable。元数据校验使用既有认证，`/context-broker doctor` 检查所选 source 并可能填充缓存。Offline Notion 发现要求已有完整缓存，随包 Skill 则无需 Notion 访问或这些缓存。自定义 source `command` 保持 list/read/export JSON 合同，并自行负责其依赖检查。

来源失败保留脱敏的 source/code/message。认证、网络和响应格式失败仍使该来源不可用；合法的部分目录则保留精确记录，附带非阻断的 `CATALOG_INCOMPLETE` 提示，并使用页面限定 token，不能据此证明无结果或名字唯一。默认 View 失败时，默认目录为空且显示修复方法，完整目录中的精确显式选择仍可用。实际正文交付仍检查选中记录的权限和快照完整性。本地 Skill 和普通聊天继续工作，不把失效的显式 View 偷换为其他 View 或全库。

OMP 查询目录时不阻塞编辑器；首次普通提交会在调用 provider 前等待当前 View。Pi 在启动阶段准备元数据。每轮 `before_agent_start` 生成一份 `<ntn-skills-view-catalog>`，按精确路径移除 Broker 自己的旧目录项，保留其他本地条目和会话正文。新建会话、列举或切换 View 均不自行调用模型。所选 View 的快照可独立后台准备，不构成激活。完整目录和 View 查询各自保留覆盖范围，新鲜度或某个页面可读都不能补成完整覆盖。

Notion 元数据 index 持久保存在 `cacheDir`，按 `ctl cache identity [--database SELECTOR]` 返回的凭据与远端目录身份共用。Pi/OMP、不同项目、命令写法、source ID/namespace、activation 策略和请求超时不会为同一远端目录另建分区；CLI 在本地将等价 database alias、ID、URL 解析为同一选择。不同凭据或远端查询范围继续隔离。`cacheDir` 显式选择存储位置，默认全局共用；显式相对路径仍按 cwd 解析。command 不支持 identity 能力时沿正常发现路径读取。新进程按原始 `validated_at` 和当前 discovery 策略重新计算年龄，不重置 TTL，也不沿用另一消费端策略算出的 stale 标志。新鲜目录沿用 CLI catalog TTL，默认 60 秒；过期目录先显示，同时只运行一次后台刷新。支持 partial 回调的菜单按 identity 保留位置，新增候选追加，消失候选禁用，提示行不能改草稿。OMP 强制文件补全保留当前候选，下一次编辑器请求采用刷新结果。旧请求取消后立即结束。暂时性刷新失败保留上一份目录、显示原因，5 秒内不重复请求；认证、权限或 scope 失败撤下旧 source 候选。`discovery.offline` 不访问网络。目录刷新不读取正文，选中激活仍校验 scope 与固定快照；`/context-broker refresh` 更新同一份共享目录观察，已加载会话保留其选中快照。

Catalog format 4 在 `catalogs-v4` 保存不可变观察，按调用 `list` 前排他预约的请求序号选择。延迟旧请求不能替换后预约且已发布的观察，校验时间相同或回退也不改变顺序。TTL 仍使用原始 `validated_at` 和当前消费端策略；最高观察的 receipt 损坏时走权威重建，不退回较旧观察。读取扫描发布目录名并解析一份 receipt；预约、观察和会话可能持有的 metadata index 均保留。旧目录格式留在磁盘供检查，新代码不再读取。不可变导出仍按凭据 scope、record、snapshot 共用。竞争失败方核对同一快照的回执和完整资源一致后，将自己的 stage 改名为 `.retained-stage-*` 供检查；字节不同仍明确报 output conflict。保留内容不自动回收。升级扩展代码后，已有 OMP 会话执行 `/restart`，Pi 启动新进程；`/context-broker refresh` 只刷新数据。双宿主回归见[共享缓存与并发验收](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/features/session-cache-recovery.md#共享-notion-缓存)。

新会话没有 Notion `$` 候选时，先核对当前宿主自己的 source 配置和实际安装 Broker 路径，不先改远端数据。Pi 与 OMP 配置独立；安装 Tern companion 不等于已加载 OMP 扩展。自定义 source command 的冷 `list --database ID --refresh` 不设整条命令的 deadline，内部每次网络尝试遵循 `requestTimeoutMs`；目录发现应仅处理元数据并消除逐成员重复请求。旧 Bundle catalog 必须显式转换并回写配置引用后才能交给 Router-only runtime，保留原件并另行迁移目录生成器；普通 refresh 不转换 schema，也不重新执行升级的扩展代码。所选 View 控制原生默认发现；完整 `$alias@namespace` 补全不受 View 限制。

`SOURCE_RESPONSE_INVALID` 也可能表示 source CLI 与当前宿主实际安装的 Broker 使用不同 wire schema。例如 CLI 目录已有合法的 `upstream: {repo}` 元数据，旧 Broker 的严格 record schema 尚未声明该字段，就会拒绝整份目录。核对真实 CLI 响应和安装目录中的 `src/notion-source.ts`；checkout 验收通过不代表安装包已更新。安装匹配的 Broker 构建并回写该宿主的 package 引用后，重启 Pi，或在 OMP 执行 `/restart`。目录 refresh 只重读数据。最后使用日常 source 配置，在真实终端核对候选、Tab 接受和完整正文投递。


记录身份为 `JSON.stringify([sourceId,sourceScope,kind,locator.type,id])`，source 独立为 local/notion；filesystem 使用真实文件路径。Notion 自动补全通常插入 `$alias@namespace`，重名时加 page ID。已接受的选择在当前 preparation gate 开始时同步冻结；前一轮准备或执行期间接受的新草稿不会改变前一轮身份，也不会被前一轮结束清掉。

独立 query/手动搜索统一插入既有完整身份语法：Notion 使用 `$alias@<规范化-page-id>@namespace`，filesystem 使用 `$name@<编码-local-id>@namespace`，原有本地 roots 使用 `local`。别名改名后仍按相同精确身份解析。官方随包 Skill 固定使用 `$name@builtin`；候选 label 保持简短可读。`skillRoots` 内同名仍按 root 顺序保留首项，独立 source 与 kind 不合并，共享选择器仍拒绝歧义。

CLI 目录带有 `upstream: {repo}` 的 Skill，在自动补全与手动搜索中显示 `repo/skill name [skill]`，例如 `pstack/correct [skill]`。`repo` 取已校验 Notion 订阅 `Name` 对应的调用 alias，不取仓库 URL 或 registry slug；Skill 名使用原始 `name`。输入 `$pstack/` 浏览该订阅下的 Skills，继续输入 `$pstack/cor` 缩小范围。已知订阅前缀只返回该订阅成员，不会因其他订阅的描述包含此前缀而混入。自动补全接受来源限定的选择器，独立 query/手动接受额外包含精确 page ID；两者都保留 source/page identity。此字段用于显示和搜索，不参与正文、快照或身份校验。

返回的完整选择器优先于 source alias 简写。本地 `$name@local` 在补全显示无后缀名字时也可调用，并选择保留的本地记录。因此 namespace 为 `local` 的 source 不会让已接受的本地 token 与带 page ID 的 source token 再次歧义；真正共享同一本地选择器的条目仍拒绝调用。

Source id 与 namespace 内部的点保留为选择器的一部分，例如 `$ui-alpha@team.prod`；句末句号不计入调用引用。

名字冲突时，自动补全显示来源限定的候选。已接受选择的精确 read 返回目标 not-found 时，用户收到提示，模型收到 `context-broker-unavailable` 和 `state: not-loaded`。完整身份 token 不在当前目录时报告 `catalog-unavailable`，不虚构 Notion 查询结果或 metadata。这些记录绝不算 loaded；同一提交重复组装 context 时不重读、不重复追加缺失说明，下一次用户提交仍可重试。

未知裸名 `$name`、简单 `$name@namespace`、金额、`$bunfs/root/chunks/cli-nxfh2cp0.js` 等路径、转义与 Markdown 示例继续按普通文字处理。缺失选择旁的其他有效引用、原文与图片仍只派发一次。歧义以及实际已选记录的权限、网络、source、目录或完整性错误仍阻断派发，不悄然改选其他来源。

### 宿主发现与选中激活

Pi 与 OMP 默认追加轻量的 `<ntn-skills-guidance>` 自定义消息，无需 `$` 调用或安装 builtin。实际命令 argv 复用宿主命令的 CLI resolver，并保留每个已启用 Notion source 的 id 与可选 database；多 source 分别列出，不隐式选中一个。每个 source 都提供含实际数据库范围的 `list-args`、`read-args`、`files-args` 和 `resource-read-args` 参数数组，追加到 executable argv 并替换任务占位值。发现优先使用已有元数据或短关键词，选中合适记录后再读正文；`files SNAPSHOT` 列出资源，`read SNAPSHOT --path RELATIVE` 读取指定资源，避免 shell 工具把 `skill://` 参数当文件路径解析。保留 JSON 输出以核对 `ok`/`error` 和快照身份，语法失败查看子命令 help。指引自身不发现内容或激活 Skill。

宿主观察配置中真实 CLI argv 返回的完整成功 JSON。已验证的内容创建/更新、upstream 成员变更和 local sync push，只让对应内容数据库与来源命令的目录在下一次选择时刷新。`operation resume ID` 返回已验证的 publication 或 upstream 终态时，必须与参数中的 canonical operation ID 一致；恢复结果未给 source 范围时，同一配置 CLI 的来源在下一次发现时重读。重复恢复已完成操作也可触发这次保守重读，不据此推断发生了新写入。保留来源的 offline 策略。Read/status/plan/check、operation show/list/reconcile、dry run、普通 mutation 的 reuse/unchanged 和失败都不触发刷新。OMP 截断 stdout 时，沿其公布的 `artifact://` 读取保留原 CLI 调用归属，取得完整结果后才处理。复合 shell 命令、宿主工具之外的写入或始终不完整的输出，继续依赖目录正常时效或 `/context-broker refresh`。自动刷新不取消已接受草稿，不替换会话已经加载的快照。

CLI 成功读取返回顶层 `content`（正文）、pinned `ref`（相对 `read --from` 的基准）和 `snapshot_id`（`files` 的目标）；`record` 是元数据。资源使用清单返回的文件 ref/path。介绍与摘要只描述工作流，不执行其准备、仓库检查或运行步骤。

防重复用 Skill 的有效上下文读取方式，检查完整且归本扩展所有的引导消息。重复、fork 与持久续接保持一份；压缩或回退移除后，下一轮即使不选择 Skill 也补回。context hook 还在模型请求前缺失时补入，覆盖轮内压缩后的请求。用户/助手/工具示例及仅含标记的摘要不能抑制恢复。每次模型请求只含一份 XML；会话文件可以保留压缩前的历史副本。

宿主/Broker 提供的完整 Skill 正文或成功读取返回的正文可以直接使用。介绍、摘要无需再次读入口、列缓存目录、查包清单或代理界面元数据；只有当前任务确实需要资源内容时才读取支持文件。任务已给出相对文件路径时，直接从 Skill 入口所在目录解析并读取，无需先列目录或查找 cwd；CLI 读取保持选中快照。此规则同时适用于 Pi 与 OMP，不通过禁用工具实现，也不把目录 description 当成正文。

Pi 与 OMP 的选中 Skill payload 在完整正文旁提供经过转义的 `skill-directory` 和按任务读取资源的指引。Notion 记录还提供选中版本的 pinned `skill-ref` 与 `snapshot-id`。`hash`、`basename` 路径模式继续隐藏目录：使用提供的 CLI/database scope 执行 `files SNAPSHOT` 或 `read SNAPSHOT --path RELATIVE`，无需暴露本地快照目录即可读取资源。介绍只描述 Skill 的工作流、风格和前置条件，不将其作为当前任务执行。

Filesystem source 将只有元数据的 Skill 入口加入宿主默认技能目录。Notion source 默认发布所选 View 中的 Skill 和独立 Router 元数据；`default_context` 只是页面属性，不再做额外交集。Prompt 保持仅显式调用。完整 Notion 目录仍保留所有记录，供显式 `$` 选择、搜索、补全与 qualified read 使用。模型原生 `read`、原生 `/skill:` 和显式 `$` 都只激活选中的记录。`$ui-alpha@notion` 选择 `/skill:notion-ui-alpha`：宿主 frontmatter name 从内部 `notion/ui-alpha` token 派生，将小写 `a-z`、`0-9`、`-` 以外的字符替换为 `-`，source alias 本身不改名。OMP `skill://notion-ui-alpha` 与目录公布的 metadata 路径走同一激活，路径上的 read selector 保留。

目录注册后，共享 source runtime 以有界并发后台预取所选 View 的 Notion 记录。预取完整读取并导出快照，不向会话发布正文、加载提示或 loaded 回执。同一 scope/page 的前台与后台消费共享正在执行的工作；取消一个消费端不终止其他消费端。后续激活仍由 CLI read 策略校验缓存资格，正文默认五分钟，校验失败不隐式回退旧内容。已预取不代表正文已在有效上下文中。Refresh 取消旧代际后台工作并应用 View 成员变化，退出取消所属任务。移出 View 不移除当前会话已加载的指令。插件保持一个包，在扩展启动时选定 OMP 或 Pi adapter，发现、预取与快照归共同 runtime 管理。

默认激活策略下，Skill 正文仍在当前有效会话中时，Notion 修改或缓存过期都不替换该会话已选快照。新会话（包括在另一进程中新建的会话）重新检查 CLI 缓存资格：五分钟内复用同一快照和完整导出，命中不推进 `validated_at`；过期后读取 Notion，内容变化时导出新快照。相对资源始终跟随选中快照。真实终端与原生编辑器的验收入口见 [NS-SESSION-09～12](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/features/session-cache-recovery.md)。

当前完整、稳定的 Notion 页面在缓存校验后可直接读取人工编辑，显式刷新使用 `read CURRENT_REF_OR_PAGE --refresh`，不再要求先 inspect/accept-edit。旧 pinned snapshot 保持不可变。读取不推进 upstream 版本，不改变归属。Tracked 内容可读，但通过 CLI 修改其正文、资源、Name/Description 须修改源或显式 fork；Default Context 等组织属性可独立编辑。Publication 尚未完成、读取时图发生变化、资源权限/缺失和完整性错误仍明确失败；同步继续将本地手改视作冲突。

扩展根据当前宿主 API 选择 Adapter。Adapter 负责原生目录注册、提示词呈现、编辑器装配、输入返回值及提交协议。OMP 使用命令提交与 handoff 回执，Pi 使用输入转换与展开后输入的 digest 回执。共享 preparation gate 持有取消状态，直到待处理消费者确认取消后才允许下一次提交。`CONTEXT_BROKER_HOST` 只选择配置和独立补全的备用默认路径，不切换当前宿主的提示词、编辑器或提交协议；显式 agentDir 优先。

OMP 的 print/json 模式执行原生 source `/skill:` 命令时，命令等待触发的 agent turn 结束后返回，确保进程不会在 provider 请求开始前退出。交互与 RPC 模式仍由宿主管理 turn。

交互激活在会话中追加持久、可折叠的 `Read ntn-skills://<alias>` 记录，显示来源、耗时及 `running`、`done` 或 `error` 状态。展示目标省略 namespace 前缀，重名时保留页面后缀。展开详情包含选中的版本与快照（如有）。终态记录保留，不按计时器清除。resume 恢复终态记录，并将旧 `running` 记录标为中断。自定义消息的 `content` 为空，展示元数据放在 `details`。记录及展开详情仅用于展示，不进入 provider 消息、上下文、压缩或 branch 摘要。`ntn-skills://` 是展示标识，不是可解析 URI 或模型工具调用。真实读取仍使用 `skill://`；模型原生 `read` 是真实工具调用。目录始终只有元数据；后台预取不会在选择前把正文加入目录或会话。其他终端使用文字渲染。同一实例已选中的快照直接复用，不新增激活记录。

按 Enter 同步开始 preparation 并锁定提交，草稿仍可编辑。原生编辑器显示 running 与 **Stop**。期间再按 Enter 不会提交第二条 prompt；点击 **Stop** 或按 Escape 可取消 preparation。preflight 成功后，首个 provider 请求一次性包含原提示词、图片附件及完整选中 Skill 正文。阻断型激活错误、超时或取消不产生 provider 请求；已明确报告未加载的缺失目标可随其他用户材料继续。取消或切换会话会使待完成的 preparation 失效，迟到的 source 结果不会派发。

OMP 在每轮系统提示中说明：宿主或 broker 提供、且仍在有效上下文中的完整 Skill 正文已满足“使用前读取”要求。Broker Skill payload 标明调用引用、source 的 qualified 原生宿主名、完整入口已加载状态与入口资源目录。模型应直接使用正文，无需仅为重新加载或确认身份再次读取入口、列缓存目录或检查包清单。任务需要的参考资源仍可读取；相对路径从该目录解析，`~` 展开为用户目录。`pathMode: hash|basename` 继续隐藏目录；source 资源仍可使用 qualified `skill://` URI。目录描述与 Router 索引不代表成员正文已加载，压缩或回退移除正文后仍须重新读取。Tern 自动胶囊和手动搜索沿用这条 OMP 提交合同。该提示规则仅用于 OMP。Pi 保留宿主原有提示；真实 Notion 发现、入口与资源消费独立使用联动 Skill 的 `--mode model --host pi` 路径验收，终端选择使用[Pi 独立终端规程](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/features/dollar-completion-selection.md#pi-独立终端)。

OMP 将交互 `/skill:` 与调用提示词转到扩展命令中等待，避免触发宿主 input hook 的 30 秒预算。Broker 不再设置完整加载的总时限，由 source CLI 对每次网络尝试独立执行 `requestTimeoutMs`（默认 30000）。模型原生 `read` 通过非可见 overlay 等待机制保留当前会话与编辑器。请求失败阻断提交；Escape 和 Stop 取消整个 preparation。

OMP 无界面激活保留 25 秒保护，早于宿主的 30 秒事件限时；到期显示 `SOURCE_ACTIVATION_TIMEOUT` 并终止 source 进程树。这是独立于单请求 `requestTimeoutMs` 的宿主事件保护。`context-broker-submit` 是 broker 内部恢复交互提交的命令，需要有效的待提交 id。

OMP 原生 Skill 消息的完整 metadata 入口路径通过 broker 持有的 index 映射还原 source identity，因此后续 `$` 选择不会再次注入同一正文，即使发现期间生成了新的 metadata 入口。仅名字相同、路径属于另一来源的 Skill 不会被视为已加载。

Source 正文仍在当前有效上下文时，OMP 原生 `/skill:` 复用已有正文，只发送调用参数和图片，不再追加正文或新的 loaded 回执。回退或压缩移除原正文后，可再次完整激活。

Pi 原生 `/skill:` 首次调用会展开为用户消息。Broker 只在观察到实际命令输入并核对展开正文后添加不含正文的身份回执；后续 `$` 去重还需回执 digest 对应的用户消息留在当前有效上下文。选中的正文已由 `$` 或原生命令加载时，Pi input transform 保留调用参数与图片，直接复用正文，不再次展开或新增 loaded 回执。压缩移除正文后，单独留下回执不会抑制再次激活；普通用户 XML 也不构成回执。

原生命令参数包含所选 `$` 引用时，同一轮也只发送一份正文。匹配的 native 回执在会话持久化前提供当次选中身份。Pi 首次激活与复用均完整保留空格、Tab 或换行分隔后的参数。

Notion 准备读取 canonical record ref，再用显式 `snapshot` projection 完整导出该确切快照，保留 Router 生成索引及所有资源。View 成员可在选择前准备，其他项在选中时准备。导出入口必须与固定 CLI `read` 字节一致；每文件 SHA-256、字节数、角色必须符合导出回执，portable manifest 只接受 v2。CLI 默认 `source` 导出保留 authored portable 原字节，是独立视图。入口和资源指向同一 pinned 目录，保持相对路径及跨成员稳定 ref。缓存回执 v3 记录 snapshot projection；v2 目录一次改名保留在 `.invalidated-*`，通过固定快照重拉；未知版本明确失败。缓存按凭据 scope、record、snapshot 保存，宿主/source 标签仅留在消费端元数据中，metadata index 使用独立 generation。Scope、identity、snapshot、导出清单或 source 错误阻断激活，不把记录标为 loaded。诊断只暴露安全错误码与退出状态，不回显 subprocess 原始 stderr 或秘密。

Filesystem source 扫描本地文件以提取 frontmatter，只将元数据发布到进程私有的临时 index；metadata-only 目录不表示 scanner 不读取原文件字节。首次选中激活会将完整 Skill 目录复制为进程 snapshot，保留资源；原生 read、原生命令与 `$` 共用这份选中副本。该 filesystem snapshot 不要求 Notion export receipt，selection 也不跨进程持久化。

激活后的原生宿主发现使用独立 alias view，包含选中 snapshot 的完整目录树，也保留嵌套入口目录之外的资源。View 入口 frontmatter 的 `name` 改为 qualified 宿主名；portable main 没有 frontmatter 时，view 添加 qualified name/description header，正文原样保留。Canonical snapshot 的名字与内容保持原样。公布的 metadata 目录指向 view 入口所在目录，让宿主重新发现时保持 qualified 名字与相对资源；broker 的 read 拦截返回 canonical snapshot 路径/内容。发布 alias view 不刷新选中的 snapshot。

修改配置或扩展代码后重启宿主（OMP 用 `/restart`）。选中正文仍在有效上下文时，原生 read、原生 `/skill:` 与 `$` 复用该 pinned snapshot。Branch 或压缩移除正文后，下次激活先按 CLI read 策略重新校验准备结果；进程内映射不延长 freshness，也不代表上下文已加载。`/context-broker refresh` 刷新元数据、取消旧代际准备、发布新宿主 discovery generation 并清除选中激活映射，不重新执行扩展代码或替换已注入的会话内容。新实例或进程遵循当前 activation 策略。Discovery freshness、准备结果 freshness、pinned resources 与会话已加载上下文是独立状态。

本 checkout 的验证入口：[broker verification](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-context-broker/SKILL.md)、[Notion integration verification](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/SKILL.md)，以及 CLI 仓库 `.cursor/skills/verify-ntn-skills/SKILL.md`（[仓库](https://github.com/yoyooyooo/notion-skills-cli)）。这些是操作规程，不代表某个版本或环境已经通过验收。在 broker checkout 运行 `node scripts/verify-notion-integration.mjs doctor` 检查前置条件；按 Skill 使用 deterministic、live、授权的 create/archive、model 与 installed-package 模式。原生 UI 路由是 `node scripts/verify-native-ui.mjs --notion`。


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

远端成员固定使用 `{type: remote, source: {namespace: production}, id: notion_page:<UUID>, locator: {type: notion_page, page_id: <UUID>, database_id: <UUID>, data_source_id: <UUID>}, ref: skill://<UUID>/SKILL.md}`。`ref` 可附加 `?snapshot=s_<sha256>` 固定版本，不填写 path、scope 或 cached path。`source.namespace` 精确匹配已启用配置源的 namespace，未配置 namespace 时匹配该源 id；不从 label 推测，也不通过 catalog 授予凭据权限。

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

请使用可信 roots、catalogs、source commands 与 Notion databases。Skill 本质上是 prompt content，可以指挥模型。Notion 认证留在 CLI 既有凭据存储/环境中；元数据与选中的正文/资源缓存在本地，选中内容会发给配置的模型 provider。

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

`views` lists API-ordered choices with exact selection commands. `view` without arguments reports name, ID, source, selection origin and count. Multiple sources require the source ID. Selecting a View changes only the active session; `default` resets to configured selection or first-View fallback. These commands do not call the LLM. The next ordinary user submission receives the new names/descriptions; full Skill bodies remain on demand. A source may set `default_view_id: VIEW_UUID` beside `database` in YAML. Names are never special and API order is not promised to match UI tab order.

The active-branch custom entry `ntn-skills-view-selection` records version, source ID and canonical View ID. A null View ID resets the session override. It contains no instructions and is not a model message. Resume and branch navigation replay their own entries; parallel sessions never share mutable choice state. Validate a requested View before persisting it. Stale asynchronous callbacks are fenced at session boundaries. View selection does not modify source configuration files, withdraw previously loaded bodies or re-execute the extension.

The CLI must support `views`, `list --view` and `list --default-view`. A custom old CLI reports a default-View capability failure instead of silently reverting to checkbox-based discovery. Explicit list/read remain usable when supported.
