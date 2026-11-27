<h1 align="center">pi-context-broker</h1>
<p align="center">把选中的 Skill、Router 和 Prompt 加入 Agent 的当前任务。</p>
<p align="center">
  <a href="./README.md">English</a> · <a href="./README.zh-CN.md">简体中文</a>
</p>
<p align="center">
  <a href="#安装">安装</a> · <a href="#快速开始">本地快速开始</a> ·
  <a href="#连接-notion-库">连接 Notion</a> · <a href="#文档">文档</a>
</p>

在 prompt 中点名一个工作流：

```text
$design-review review this API boundary
```

Broker 找到 `design-review`，把指令交给模型；正文仍在当前会话分支的有效上下文中时，会直接复用。本地 Skill 无需连接 Notion。

在 [Notion Skills](https://github.com/yoyooyooo/notion-skills-cli/blob/next/README.zh-CN.md) 方案中，Broker 是可选的 Pi 适配器。CLI 负责建库、凭据、内容维护和来源同步；Broker 在 Pi 内提供发现、选择、资源读取和会话上下文控制。创建或连接 Notion 库请从 [CLI 快速开始](https://github.com/yoyooyooo/notion-skills-cli/blob/next/README.zh-CN.md#快速开始)进入。

当前 `next` 开发面向 Pi 与配对的 Notion SDK。仓库保留 OMP 和可选 Tern 配套插件，其当前验收工作延期。独立安装路径见 [OMP 与 Tern](#omp-与-tern)。

## 安装

将已发布的包安装到 Pi：

```sh
pi install npm:pi-context-broker
```

包要求 Node.js `^24.22.3 || ^26.13.1`，内含配对的 Notion CLI、SDK 和随包 Skills；在 Pi 中使用无需另外全局安装 `ntn-skills`。Bun 是构建依赖。

Broker 的请求校验需要 Undici 提供实际发送的正文分块诊断，Node 22 的内置传输不提供该事件。这是 Broker 的运行时要求；独立 Notion CLI 维护自己的 Node 支持范围。

当前真实 Pi 验证使用 Pi 1.6.0。可选 peer 的 `*` 范围允许宿主管理安装依赖，不表示所有 Pi 或 OMP 版本都已验证。升级宿主后按[现有验证入口](https://github.com/yoyooyooo/pi-context-broker/blob/next/docs/verification-routing.md)检查；Node 范围只覆盖列出的维护中 LTS 版本线。

npm 发布包与当前 `next` 源码可能不同。开发或试用未发布改动请遵循[隔离开发指南](https://github.com/yoyooyooo/pi-context-broker/blob/next/docs/isolated-development.md)，源码配对、构建和独立应用状态统一由该入口说明。

日用 `next` 时，把已合入的精确 CLI/Broker 配对构建为独立安装包，放在开发 checkout 之外的稳定目录。归档身份、package 来源切换和新 Pi 进程核对见 [next 安装指南](https://github.com/yoyooyooo/pi-context-broker/blob/next/docs/next-worktree-delivery.md)。临时验证通过 `pi -ne -e /absolute/task/extension.ts` 加载候选，保持日用注册不变。

可以先完成下方[本地快速开始](#快速开始)，也可以直接[连接已有 Notion 库](#连接-notion-库)。

## 快速开始

### 1. 配置 Skill 目录

创建 `~/.pi/agent/context-broker/config.yml`：

```yaml
skillRoots:
  - ~/context/skills
requireAutoload: false
pathMode: home-relative
logPaths: false
```

自定义 Pi agent 目录时，参见[配置解析规则](./packages/context-broker/docs/reference.zh-CN.md#配置)。修改配置后重启 Pi。

### 2. 添加 Skill

创建 `~/context/skills/design-review/SKILL.md`：

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

### 3. 检查发现结果，再提交

在 Pi 输入框执行：

```text
/context-broker doctor
/context-broker find design
/context-broker explain design-review
```

`doctor` 应显示 `Config diagnostics: ok`，且没有命名空间冲突；`explain` 应显示 `design-review` 的 `kind: skill` 和 `inject: full-file`。

然后提交：

```text
$design-review review this API boundary
```

Pi 准备选中的 Skill，并把完整指令放入下一次模型请求。点击 **Stop** 或按 Escape 可以取消准备。复用、恢复和失败处理见[选择与会话行为](#选择与会话行为)。

## 连接 Notion 库

先完成 [CLI 快速开始](https://github.com/yoyooyooo/notion-skills-cli/blob/next/README.zh-CN.md#快速开始)。CLI 使用 `ctl library init --parent PARENT` 创建新库，使用 `ctl library init --library ROOT` 验证现有库。返回的 `library.library_id` 就是 Library 根页面 UUID；Skills 等四张直属表的 ID 是物理绑定，不能代替根页面选库。已有 current 库无需重新建表，也不必先配置本地 Skill 目录。

在 Pi 中使用该入口和选定的配置文件预览连接：

```text
/context-broker connect personal ROOT --config /absolute/project/config.json
```

把 `ROOT` 换成返回的 `library.library_id`，并选择实际使用的绝对配置路径。预览不改配置。确认内容后，执行返回的精确 `--apply` 命令保存 source，再使用同一文件启动 Pi：

```sh
CONTEXT_BROKER_CONFIG=/absolute/project/config.json pi
```

执行 `/context-broker doctor` 和 `/context-broker sources`，再让 Pi 查找已连接库中的一个 Skill，读取返回的精确引用。成功上手包括 source 可用、目录已返回，以及请求的正文已读到。仅保存连接不能证明 Notion 可访问或指令已交付。

鉴权、第一个 Skill 和后续管理也由 CLI 快速开始说明。Broker 使用配对的随包 CLI/SDK 及其已配置凭据。凭据不要写入 Broker 配置。

### 为会话选择 Library

Broker 通过同一随包 SDK 读取 CLI 全局 `default_library`，没有第二套全局默认库。每次输入被接收时，`selectLibrary` 只读本地配置；切到新的根身份时，`resolveLibrary` 校验根页面和四张直属表，空库也要验证。外部修改默认配置从下一次输入生效，同根后续输入复用已验证的绑定。

使用 `/context-broker library ROOT_ID_OR_URL` 切换当前会话分支，`/context-broker library default` 回到 CLI 默认选择，不带参数则显示当前库。fork、rewind 和 resume 只继承活跃分支上的选择。语法无效的参数在接收请求前报错；有效根的验证失败则保留 blocked 请求，后续默认操作不能回落旧库。修复后明确重选。

Source 的 `library` 可省略，此时绑定 CLI 默认库；所选根必须恰好匹配一个启用的 Source。仅连接 Source 不改变默认库。`profile_id` 在当次选定的库内解析，跨库同名 Profile 保持独立；当前库缺少或禁用该 Profile 时，不借用另一库的同名项。

每次 interactive/RPC 输入接收后冻结 Library。切库只影响后续输入的默认发现与 CLI 目标，已经接受的任务、发出的短引用、活跃根及快照 pin 保持原身份。普通 `$name` 仅在当次默认库中匹配；明确的 `$name@source`（或配置的 namespace）按需读取对应已启用来源，再冻结其完整根身份。同次输入可以明确选择多个 Source，其结果不改默认库、Profile 或菜单。带完整 `library=ROOT_UUID` 的引用也可以精确指向另一已启用 Source。

Agent 使用 `notion_ctl({cli_source:null})` 取得已接收任务的 CLI 根范围；明确的 Source ID 则选择该来源的根。消费和管理统一使用返回的 `library` 作为 `--library ROOT`。旧 `source.database`、`--database` 和 `--entry` 选库参数不再接受。

### Source 配置

连接命令会把 source 加入选定文件，也可以在该文件中检查或修改以下选项：

```yaml
sources:
  - id: notion
    type: notion
    # 使用 library.library_id：Library 根页面，而非某张表的 ID。
    library: 00000000-0000-0000-0000-000000000000
    discovery: {maxAge: 5m, offline: false}
    activation: {maxAge: 1h, offline: false}
    prefetch: false
```

`next` 的 Notion 消费统一使用随包进程内 SDK，覆盖元数据、Skill/Router/Prompt 主文、支持文件和有预算的预取。一次 `consume` 负责准备和完整文件目录，首次仅物化选中主文，支持文件沿已验证的固定 File 引用按需读取。Prompt 每次显式提交重新取得本轮内容。诊断和明确管理保留配对 CLI。`source.command`、CLI prepare/read 链和完整 export 回退均已退役；包缺失或不匹配时明确要求升级。OMP/Tern 延后。

首次显式 `$` 可经独立配对 manager 补齐尚未就绪的登记上游成员，再回到普通只读消费。已就绪内容保持原缓存路径。详见[首次显式选择 Source 成员](./packages/context-broker/docs/reference.zh-CN.md#首次显式选择已登记的-source-成员)。

Pi 通过 `notion_list`、`notion_use` 与原生 `read` 提供会话引用：`sr:C` 表示目录候选，`sr:S` 表示固定的选中主文，`sr:R` 表示属于该选择的资源。原样复制返回的引用。`notion_use` 仅向模型顶层开放，不能从 Code mode 内部调用；准备成功与实际完整交付分别验证。这些引用属于当前会话分支，使用时仍检查来源授权和身份。准备、投递与恢复边界见 [Skill 消费运行时](./packages/context-broker/docs/skill-consumption-runtime.md)。

每个 Notion source 可选配 `default_view_id`；不配置就用 API 返回的第一个 View。显式 ID 失效会提示，不静默改选；确认没有 View 时默认远程目录为空。Pi 发送普通消息时不等待远程目录，因此首次请求可能显示元数据仍在准备。每次模型请求使用内存中的当前目录，保留本地 Skill 和已加载正文；显式 `$` 选择会在首次请求前完成准备。View 内未勾选 Default Context 的记录可默认发现，View 外已勾选的记录也不会越过筛选。Pi 原生 `read` 检查选中记录或资源，`notion_use` 和显式 `$` 选择准备根与完整 Requires。独立补全仍展示全库元数据。代码或配置文件改变需要重启宿主，会话内切换 View 不需要。

`/context-broker refresh` 刷新元数据，让后续 selection 可以取得新 snapshot，已有会话正文保留。默认发现只覆盖所选 Library；完整在线结果只能证明该库内不存在匹配，另一库的同名 Skill 属于不同范围。所有字段、scope 隔离、歧义和缓存策略见[source 配置与激活](./packages/context-broker/docs/reference.zh-CN.md#内置-sources)。

Pi 输入 `$` 时先展示已准备的本地与缓存候选，后台目录到达后自动更新当前下拉。按 Esc 可关闭等待中或已展开的下拉；刷新不会重开它，也不会把当前高亮换成另一条记录。普通与排队提交均在接纳时固定选择，缓存仅用于发现，实际消费仍检查权限、完整正文和 Requires。

Notion 缓存按凭据和远端目录身份共用。全库目录与 View 成员使用不同缓存选择，不会因会话筛选缩小其他会话的 `$` 候选。View 选择写入当前会话分支，进程续接时恢复；新会话独立解析默认值。共享刷新保留已加载工作流的固定快照。[缓存合同](./packages/context-broker/docs/reference.zh-CN.md#内置-sources)。

执行 `/context-broker doctor` 检查官方 CLI 版本、能力、认证和 source 访问。缺少依赖或访问失败只将对应 source 标记为不可用，本地 Skill、正常 source 和普通聊天继续工作。已选 Skill 无法加载时，Pi 显示 warning 并继续原用户请求，不注入这些指令、不交付不完整内容，也不宣称已加载。未知简单引用即使使用该 source 的 namespace 也原样透传；已接受或完整身份的引用会明确报告未加载。修复后执行 `/context-broker refresh`。管理 CLI 固定来自同一随包产物，不允许 source 覆写。

`/context-broker sources` 显示后台准备状态、snapshot/version ID、CLI freshness 与安全错误码；`ready` 只表示内容已准备，不代表指令已加载到会话。

### 在当前会话切换 View

```text
/context-broker views
/context-broker view
/context-broker view VIEW_ID_OR_NOTION_URL
/context-broker view notion VIEW_ID_OR_NOTION_URL
/context-broker view default
```

`views` 按 API 顺序列出候选和可复制的选择命令。`view` 不带参数显示当前名称、ID、来源、选择原因及数量。省略 source ID 使用当前选定的 Library，明确指定则查询对应已启用来源。选择只影响当前会话；`default` 恢复配置值或首项兜底。这些命令不调用 LLM。下一条普通用户消息发送后，当前名称和描述才随请求交给模型，正文仍按需读取。固定默认值时，在 Notion source 的 `library` 旁填写 `default_view_id: VIEW_UUID`；不按 View 名字约定，也不保证 API 首项就是界面最左项。

Notion 预取默认为零预算，启动和 View 发现只读取元数据。显式选择 Skill 后才准备完整固定主文；采用指令还会准备 Requires 闭包。资源保留在完整且已验证的文件清单中，实际读取时逐项获取。`prefetch: false` 明确保留这一行为；可选预热需要节点数、字节、时间和速率预算。[Source 配置](./packages/context-broker/docs/reference.zh-CN.md#内置-sources)。

## 为什么使用它

Context Broker 先提供技能名称和描述，再按任务加载选中的正文。Notion 来源依次使用会话选择的 View、配置的 `default_view_id`、API 返回的第一个 View。`Default Context` 只是普通属性，由 View 筛选决定是否使用它。完整 `$`、搜索和显式读取仍能使用 View 外的技能。启动可以准备元数据和快照，不发起模型请求，也不激活正文。

Pi 的 Notion 消费入口为 `notion_list`、原生 `read` 和 `notion_use`。list 只发现元数据；read 检查主文或资源；use 一次取得根与完整 Requires，Members 仍按需选择。普通本地 Skill 使用 Pi 原生发现和读取。全部 Notion 目录与消费共用随包 SDK；旧 `source.command` 配置明确拒绝。每次 provider 输入保留一份与当前工具匹配的精简 `<ntn-skills-guidance>`。管理工具 `notion_ctl` 按需发现，OMP/Tern 在 `next` 延后。

Pi 可用一次 `read({ paths: [...] })` 读取同一 Skill 快照中最多 16 个选中资源，输入使用固定 `sr:R` 句柄或带 snapshot 的 `skill://` 文件引用。文本完整交付；二进制返回已验证的文件信息与本地路径。普通 `read({ path, offset?, limit? })` 保持 Pi 原生行为。选择、预算和投递语义见[固定资源批读](./packages/context-broker/docs/fixed-resource-batches.md)。

可移植 Skill 链接统一使用 `skill://<稳定-skill-id>[/<path>][?library=<根页面-UUID>][&snapshot=<id>]`，例如 `skill://architect/references/review.md?library=44444444-4444-4444-8444-444444444444`。只有实际包含链接的所选文件或明确选定的 Library，才能补足省略的 `library`。显示名和 alias 用于发现，URI 只按稳定 ID 解析。旧 `shared_skill:…` 前缀与公开 `file_id` 参数不再接受；作用域、固定主入口和迁移要求见[精确 Skill 引用](./packages/context-broker/docs/reference.zh-CN.md#精确-skill-引用)。

读取 Notion Skill 正文中的相对链接时，使用 `read({ path: "../review/SKILL.md", from: FIXED_CONTAINING_FILE_REF })`。`from` 是实际包含链接的文件，复制返回的 `sr:S`、`sr:R` 或固定 canonical File ref；嵌套文档不能一律用主文作基准。跨 Skill 需要可靠的 Source 原路径、固定 revision 和精确贡献映射，缓存目录不会重建仓库中的相邻关系。解析后继续使用目标自己已选的会话快照，只做检查，不激活 Requires 或修改 Members。`from` 不能与资源批读或 `refresh: true` 合用。详见[相对文件读取](./packages/context-broker/docs/fixed-resource-batches.md#relative-paths-from-a-selected-file)。

Pi 按需发现的 `notion_ctl` 还管理当前 Notion 工作集。`working_set:"show"` 显示活跃根、共享 Requires 和 UTF-8 指令字节；`"budget"` 加 `max_bytes` 设置明确的 Session 上限；`"release"` 加准确 `roots` 停止应用这些根，其他根仍需要的依赖会保留。释放保留原始会话历史、固定快照与 Notion 数据，默认不自动淘汰。详见[工作集控制](./packages/context-broker/docs/skill-consumption-runtime.md#当前工作集预算与显式释放)。

已有会话在 Notion 编辑和元数据过期后保留已选根与 Requires 的版本。显式 `read` 配合 `refresh: true` 检查当前主文，不改变任务的固定选择；`notion_use` 配合 `refresh: true` 为指定根采用完整当前版本。固定字节缺失时，系统给出明确能力提示并暂不交付受影响的指令闭包，其他独立对话仍可继续。详见[刷新与恢复](./packages/context-broker/docs/skill-consumption-runtime.md#内容变更明确刷新与管理开关)及[配对 next 安装合同](https://github.com/yoyooyooo/pi-context-broker/blob/next/docs/next-worktree-delivery.md)。

用户点名询问某个 Notion Skill 是否存在或可用时，Agent 必须把名称作为 `query` 调用 `notion_list`，并设置 `refresh:true`。已有会话、先前查到或没查到、默认 View 已显示该名称，都不能省略这次核验；仍遵守用户明确指定的来源。查询只读元数据，保留已选 root/Requires 的固定版本。存在性与声明用途直接依据返回的元数据回答；用户要求检查或采用指令时，再读取或使用正文。只有当前新鲜且完整的查询才能说明搜索范围内未找到可用项；离线、过期、失败或部分结果不能证明当前不存在。

| 记录 | 来源 | 模型收到的内容 |
| --- | --- | --- |
| Skill | 发现到的 `SKILL.md` 或 filesystem/Notion source record | 选中的完整 Skill 内容；source 资源共用选中的 snapshot |
| Router | Notion `ROUTER.md` 或本地 catalog | 自身正文及成员索引，成员正文按需读取 |
| Prompt | Notion `PROMPT.md` | 每次显式提交都加入本轮用户任务要求 |

用 `$name` 或 alias 选择记录，也可以通过关键词规则加载 Skill 或显式的 `router:<name>` 目标。Broker 同时提供交互补全和 `/context-broker` 诊断命令。

## 选择与会话行为

Pi 在宿主创建 agent operation 后，于可取消的 `context` 阶段准备选中内容。准备期间可继续编辑和排队输入；原生编辑器保留 running 与 **Stop**。点击 **Stop**、按 Escape 或发送 RPC `abort` 会取消本轮。每次模型请求前的 context 阶段，Broker 的元数据等待、正文准备与恢复共用最多 60 秒预算。准备成功后，首个 provider 请求包含原提示词、图片及完整选中 Skill 正文。Broker 自身失败或超时只给出 warning，继续原用户请求，不注入失败或不完整的 Skill 内容，也不宣称已经 loaded。切换会话仍阻止迟到结果进入新会话。Broker 的目录查询、Skill 加载、来源单项 read 和 CLI scope 验证也各有 60 秒边界；内容搜索沿用 360 秒预算，资源 batch 沿用调用预算，普通 read 保持宿主原生执行合同。

Pi 仅在 `after_provider_response` 收到 2xx 响应头，且完整正文与本次请求的固定选择匹配后，才确认 Skill 为 active。这只表示逻辑上的请求接受，不表示模型响应已经完成，也不是最终 wire 投递。普通 `openai-completions` 的 wire 证明是单独的 Node Undici 实体哈希核对；其他传输不会被记成 wire 已确认。缓存字节和 ready 准备结果都不能单独证明 active。

未知简单 `$name`、`$name@namespace`、金额和 `$bunfs/root/chunks/cli-nxfh2cp0.js` 等路径保持普通文本，不产生失败提示。之前已接受的选择或完整身份 token 不可用时，用户与模型都会收到明确的“未加载”反馈，原文与图片仍只派发一次。歧义及实际已选记录的权限、网络、目录或完整性错误只阻止采用受影响的指令，对话继续；不悄然改选其他来源。完整有效的选择仍经过正常交付检查。

下一次模型请求会包含 Skill 内容。正文仍在有效上下文时，通过 `$` 或 OMP 原生 `/skill:` 再次提交同一记录会复用已有正文。Pi 会在下一次请求前，从当前分支的确切快照恢复缺失的已确认 active 正文，包括压缩或 resume 后的普通续接。分支中没有该确认记录时，不继承激活状态。去重不会从后续请求中移除已经存在的上下文。

## 内容生命周期

CLI 目录只返回 `records`，每条必须包含 `id/kind/locator/name/alias/description/default_context/entrypoint/ref`。Broker 拒绝未知 kind、错误 locator 和旧 `skills/skill` 字段。选中消费将完整主文与文件清单绑定到同一 source、scope、record 和不可变快照。入口文件为 `SKILL.md`、`ROUTER.md` 和 `PROMPT.md`。

用 `$alias@notion` 显式选择 Prompt。每次提交新建 invocation、会话 generation 与 prepared 集合，同轮预检和派发共用固定快照；下一轮再次引用会完整加入本轮用户任务，保留原文与图片。Prompt 不进入原生 Skill、默认发现、后台预取、关键词自动激活或 system prompt。用户取消和切会话阻止旧轮派发；Pi 中超时只撤下未完成的 Prompt 内容，以 warning 继续原请求。双宿主及 detached 补全在 v1 中共享 `identity/kind/source/ref` 与原 UTF-16 编辑范围；接受候选只改草稿。

旧 Bundle catalog 和 session 标记通过 `node scripts/migrate-content-assets.mjs INPUT OUTPUT` 显式转换。运行时只接受 Router；转换写独立输出，保留不可变快照和资源路径。
转换只修改 catalog 记录字段及已识别的 Broker session details，包括结构化 Router 引用和来源回执身份。正文、snapshot ID、资源路径及未知嵌套数据即使含 `bundle:` 或 `kind="bundle"` 也原样保留。混合 catalog 结构及非法 member 会拒绝；原件和已存在输出不会被覆盖。

## 维护与同步

普通产品维护与 Source 同步默认使用实际配对 CLI 随包提供的 `ntn-skills-maintain`、`ntn-skills-sync`。Broker 提供包内路径，供普通原生 `read` 读取；只有 shell 的宿主使用配对 CLI 的 `skills get NAME`，默认输出 Markdown。本任务已经完整加载的指引直接复用。这些产品说明可离线获取，无需 Notion 库或独立的 Skill 安装。

通过随包 CLI 的 `skills` 或 `skills list` 发现目录，`skills get NAME --full` 获取完整正文与参考文件，`skills path NAME` 返回匹配当前包版本的实际目录。`--json` 提供结构化元数据与内容。CLI 升级同时更新随包 Skill；Broker 升级同时更新其配对的 CLI 和 Skill。

工作流来源和写入目标分别选择。随包指引不会选定 Notion source 或 Library；数据操作使用用户明确选择的来源对应的 CLI command，消费和管理都传 `--library ROOT`，不能隐式取第一个来源。普通业务 Skill 的发现与同名歧义规则保持不变。同名 Notion 页面是用户维护的独立工作流，不能凭名称冒充官方 Builtin。

用户明确选择 Notion 团队流程时，在所选来源中读取精确 ref；需要发现时只查询该来源，也可读取默认 View 之外的授权条目。真正采用时调用 `notion_use(ref)` 加载完整 Requires，本任务已准备完整闭包时可复用；被编辑目标仍只 inspect，不激活其工作流。没有原生 use 时可用同来源 CLI 的 `use EXACT_REF --library ROOT_UUID --json`。CLI 使用规范引用，不能消费会话 `sr:` 句柄；没有可用路线就报告无法采用。pending、partial 或访问失败都不能把已选择的流程换成 Builtin。已有任务保留选中版本，只有明确刷新才采用新内容。本地和随包流程继续使用原生消费路线。

只有配置了至少一个未禁用的 `type: notion` source，才在 `$` 候选中显示 `$ntn-skills@builtin`、`$ntn-skills-maintain@builtin` 和 `$ntn-skills-sync@builtin`；尚未连通 Notion 或完成认证也能读取它们。在 Pi 中，零已启用 Notion source 的普通本地会话不暴露 Notion 候选、工具或系统指引。明确需要初始化时，遵循 [CLI 快速开始](https://github.com/yoyooyooo/notion-skills-cli/blob/next/README.zh-CN.md)，或通过随包 CLI 的 `skills get ntn-skills-maintain --path references/setup.md` 读取离线入口。

```text
把这段对话中可复用的方法整理为 Skill，保存到已连接的 Notion 库。
检查选定库的来源，预览这次需要执行的同步。
```

当前 Agent 读取选中的工作流，取得目标来源的真实 CLI argv 与数据库范围。Pi 在启用 `bash` 后，可按需发现并调用 `notion_ctl({cli_source:"SOURCE_ID"})` 获取当前机器的调用元数据；取得该信息不会执行命令或授予工作流权限。配置多个 Notion source 时须明确选择目标，不隐式取第一个。Notion 写入与同步沿用 CLI 自身的预览、精确目标和操作结果合同。同包 CLI 的 native Skill `create/update/register/remove`、import 和 Source 路由，只有被观察到的单条 literal 调用及匹配写入回执才使对应配置来源的目录失效；不推断复合 shell 或外部写入。验证刚写入的条目或查询最新目录时，调用 `notion_list({query:"名称",source:"来源ID",refresh:true})`；省略 source 则刷新所有已配置的 Notion 来源。分别检查返回的 freshness 与 coverage。配置为离线的来源保持离线；已采用的 Skill 版本、已接受草稿和固定引用保持不变。

`/context-broker` 保留 View 选择、元数据刷新与诊断。旧 `/ntn-skills` 命令镜像、专用 `save` 和 Tern 管理面板已退役。把自然语言要求与附件留在普通 prompt 中；选择 Skill 只编辑草稿。

已经接受的引用失效时，用户和模型都会收到明确的“未加载”反馈，原文、图片和其他有效引用仍只派发一次。普通未知 `$name`、`$name@namespace`、金额和路径继续按字面文本处理。

## 更新随包 Skill

随包 Skill 跟随已安装的 Broker/配套插件版本更新。升级这两个包后重启宿主，OMP 使用 `/restart`，即可采用新版工作流与参考文件。`@builtin` 指向随包工作流。Notion 和本地业务 Skill 保持各自的身份与生命周期；当前任务保留已选指引，直到明确刷新。

Notion 数据和已连接来源目录继续由 CLI 管理，相应任务通过维护或同步 Skill 完成。升级 Broker 才会更新其中配对的 CLI/SDK 与工作流；单独升级全局 CLI 不会替换 Broker 已打包的运行时。详见[随包 Skills](./packages/context-broker/docs/reference.zh-CN.md#随包-skills)与[构建输入](./CONTRIBUTING.md#bundling-cli-and-skills)。

## OMP 与 Tern

OMP 与 Tern 使用独立宿主集成。仓库保留其产品代码，当前 `next` 面向 Pi，它们的验收工作延期。

```sh
omp install npm:pi-context-broker
```

在 OMP 安装或升级后，输入 `/restart`，恢复当前会话并执行新版扩展代码。`/reload-plugins` 只刷新发现状态，不重新执行已加载扩展。

OMP（包括 Tern 中运行的 OMP）将有效上下文中的完整 Skill 正文视为已读。`$` 注入标明调用引用、source 的原生宿主名与资源目录，模型可直接使用正文，仅在需要时读取附加资源。目录路径继续遵守 `pathMode` 隐私设置。详见[宿主消费合同](./packages/context-broker/docs/reference.zh-CN.md#宿主发现与选中激活)。

Tern/OMP 加载选中的 source Skill 时，在会话中追加持久、可折叠的 `Read ntn-skills://<alias>` 记录，显示来源、耗时及 `running`、`done` 或 `error` 状态。展示目标省略 namespace，重名时保留页面后缀。终态记录完成后保留，resume 时恢复；未完成的旧记录标为中断。`ntn-skills://` 仅为展示标识，真实读取仍使用 `skill://`。记录及展开详情不进入 provider 消息、压缩或 branch 摘要。其他终端使用文字反馈。启用 Notion source 即可发现和使用，无需安装 builtin。详见[激活合同](./packages/context-broker/docs/reference.zh-CN.md#内置-sources)。

### Tern 补全

OMP 18.10.3+ 中输入 `$` 或 `$前缀`，broker 会自动显示候选下拉。方向键选择，Tab 或 Enter 接受，Esc 关闭。接受后显示原生胶囊；提交时展开回 `$name` 并注入。前缀可以紧接正文，一份草稿也可以包含多个引用。

鼠标点击已接受胶囊的文字内部只移动光标，不会重新打开下拉，与原生 `/skill:` 胶囊一致。输入新的 `$` 前缀仍会正常触发补全。

安装 Tern 配套插件后，`$` 下拉使用更宽的 720 像素布局，为名称留出更多空间；窄 pane 会自动收缩。原生 `/` 菜单保留宿主布局。更新配套插件后，在 OMP 执行 `/restart` 加载对应 broker 扩展。

可选 Tern 配套插件在本地 OMP native pane 提供 **Ctrl+Alt+Shift+K** 手动搜索。从[正式 GitHub Release](https://github.com/yoyooyooo/pi-context-broker/releases)下载完整 `tern-context-broker.tar.gz`，解压后安装目录：

```bash
broker_release_dir="$(mktemp -d)"
curl -fL https://github.com/yoyooyooo/pi-context-broker/releases/latest/download/tern-context-broker.tar.gz -o "$broker_release_dir/tern-context-broker.tar.gz"
mkdir "$broker_release_dir/plugin"
tar -xzf "$broker_release_dir/tern-context-broker.tar.gz" -C "$broker_release_dir/plugin"
tern plugin install "$broker_release_dir/plugin"
tern plugin list --json
```

归档包含 query、随包 CLI、三份 Skill 及资源、生产依赖和许可声明。Tern 安装目录，不直接安装 tar URL。升级时重新下载并解压，在安装命令后加 `--force`。源码开发先进入[隔离开发指南](https://github.com/yoyooyooo/pi-context-broker/blob/next/docs/isolated-development.md)，再按[构建输入](./CONTRIBUTING.md#bundling-cli-and-skills)明确选择 Tern。两种补全都只编辑草稿；提交后由 Broker 加载选中内容。

两个插件可以同时安装：Tern 呈现原生界面，OMP 继续执行 broker 扩展，并负责上下文注入。从自动下拉切换到手动搜索时，先按 **Esc**，再按 **Ctrl+Alt+Shift+K**。两个菜单目前没有显式互斥，验收未覆盖同时打开。详见[双插件共存说明](./packages/tern-context-broker/README.zh-CN.md#双插件共存)。

配置、更新和卸载见 [Tern 子包指南](./packages/tern-context-broker/README.zh-CN.md)。源码修改遵循[隔离开发指南](https://github.com/yoyooyooo/pi-context-broker/blob/next/docs/isolated-development.md)。

## 开发

通过[隔离开发指南](https://github.com/yoyooyooo/pi-context-broker/blob/next/docs/isolated-development.md)创建任务自己的 CLI/Broker clone、私有构建和明确的运行输入。两仓源码开发共用这一入口。

按[验证路由](https://github.com/yoyooyooo/pi-context-broker/blob/next/docs/verification-routing.md)选择检查，再遵循[贡献指南](./CONTRIBUTING.md)完成审查与交付。安装包、真实 Notion、Pi 和模型检查分别报告实际观察范围。

## 文档

- [文档导航](./packages/context-broker/docs/README.md)：双语合同、示例与验证入口。
- [Broker 参考](./packages/context-broker/docs/reference.zh-CN.md)：sources、宿主 Skill 目录/read、canonical tokens、snapshots、Skill 优先级、Router、配置、规则、payload 和补全 CLI。
- [Skill 消费运行时](./packages/context-broker/docs/skill-consumption-runtime.md)：Pi SDK 路径、会话引用、可取消准备、active 确认与固定快照恢复。
- [Tern 子包指南](./packages/tern-context-broker/README.zh-CN.md)：手动搜索、profile、草稿保护，以及 GitHub 与本地构建切换。
- [配置示例](./packages/context-broker/examples/config.example.yml)和 [catalog 示例](./packages/context-broker/examples/discovery-catalog.example.yaml)。
- [Broker verification Skill](https://github.com/yoyooyooo/pi-context-broker/blob/next/.agents/skills/verify-context-broker/SKILL.md) 与 [Notion integration verification Skill](https://github.com/yoyooyooo/pi-context-broker/blob/next/.agents/skills/verify-notion-skills-integration/SKILL.md)：checkout 操作规程与 feature maps；[日常安装与原生菜单](https://github.com/yoyooyooo/pi-context-broker/blob/next/.agents/skills/verify-notion-skills-integration/features/daily-installation-ui.md) 单独验证实际安装、斜杠菜单、真实 Notion 与模型消费。CLI consumption 验证位于 [CLI 仓库](https://github.com/yoyooyooo/notion-skills-cli/tree/next)的 `.cursor/skills/verify-notion-consumption/SKILL.md`。这些路由不表示已经通过验收。
- [贡献指南](./CONTRIBUTING.md)：开发检查、验收和发布流程。
- [变更记录](./CHANGELOG.md)和[安全策略](./SECURITY.md)。

## 隐私与支持

Broker 使用宿主 agent 的本地权限。选中的 Skill 内容会发送到你配置的模型 provider，并保存在会话历史中；Router 暴露成员 metadata 和路径，成员正文另行加载。请使用可信 roots、catalogs 与 Notion databases。Notion 凭据由 `ntn-skills` 管理；元数据与选中的正文/资源缓存在本地。Source 错误只暴露安全错误码，不回显原始 stderr 或秘密。路径默认尽量采用 home-relative；`pathMode: hash` 可以进一步隐藏路径，decision 日志默认不记录路径。

本地 Pi/OMP 检查在 macOS 运行过，CI 在 Linux 运行 CLI 和产物检查。Windows path-list 分隔符已适配，但 Windows 运行行为尚未验证。Tern 原生 UI 检查需要 macOS；手动配套插件不支持远程 pane 或 Tern web client。

Bug 请提交到 [GitHub Issues](https://github.com/yoyooyooo/pi-context-broker/issues)，漏洞使用[私密安全报告入口](https://github.com/yoyooyooo/pi-context-broker/security/advisories/new)。项目采用 [MIT](./LICENSE) 许可证；分发查询程序包含依赖许可声明。
