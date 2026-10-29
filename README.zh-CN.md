# pi-context-broker

[English](./README.md) | [中文](./README.zh-CN.md)

[安装](#安装) · [快速开始](#快速开始) · [Tern](#tern-补全) · [文档](#文档)

在 Pi 或 OMP 的 prompt 中点名，将 filesystem 或 Notion Skill 与 Router 索引加载到当前任务：

```text
$design-review review this API boundary
```

Broker 找到 `design-review`，将对应上下文发送给模型；只要正文仍在当前会话分支的有效上下文中，就不会重复追加。

## 为什么使用它

Context Broker 先提供技能名称和描述，再按任务加载选中的正文。Notion 来源依次使用会话选择的 View、配置的 `default_view_id`、API 返回的第一个 View。`Default Context` 只是普通属性，由 View 筛选决定是否使用它。完整 `$`、搜索和显式读取仍能使用 View 外的技能。启动可以准备元数据和快照，不发起模型请求，也不激活正文。

Pi 与 OMP 默认收到精简的 `<ntn-skills-guidance>`，包含实际命令 argv、来源/数据库范围、发现/读取/子文件命令与 help 入口。同一有效上下文只保留一份；压缩或回退移除后，在下一次模型请求前补回。该指引与 Skill 正文、远端目录发现分别管理。

Tern/OMP 加载选中的 source Skill 时，在会话中追加持久、可折叠的 `Read ntn-skills://<alias>` 记录，显示来源、耗时及 `running`、`done` 或 `error` 状态。展示目标省略 namespace，重名时保留页面后缀。终态记录完成后保留，resume 时恢复；未完成的旧记录标为中断。`ntn-skills://` 仅为展示标识，真实读取仍使用 `skill://`。记录及展开详情不进入 provider 消息、压缩或 branch 摘要。其他终端使用文字反馈。启用 Notion source 即可发现和使用，无需安装 builtin。详见[激活合同](./packages/context-broker/docs/reference.zh-CN.md#内置-sources)。

| 记录 | 来源 | 模型收到的内容 |
| --- | --- | --- |
| Skill | 发现到的 `SKILL.md` 或 filesystem/Notion source record | 选中的完整 Skill 内容；source 资源共用选中的 snapshot |
| Router | Notion `ROUTER.md` 或本地 catalog | 自身正文及成员索引，成员正文按需读取 |
| Prompt | Notion `PROMPT.md` | 每次显式提交都加入本轮用户任务要求 |

用 `$name` 或 alias 选择记录，也可以通过关键词规则加载 Skill 或显式的 `router:<name>` 目标。Broker 同时提供交互补全和 `/context-broker` 诊断命令。

## 内容生命周期

CLI 目录只返回 `records`，每条必须包含 `id/kind/locator/name/alias/description/default_context/entrypoint/ref`。Broker 拒绝未知 kind、错误 locator 和旧 `skills/skill` 字段。read/export 共享 `record/entrypoint/scope/snapshot_id/version_id/ref`；export 固定 read 选中的快照，核对 portable v2 和完整文件清单。身份为 `JSON.stringify([sourceId,sourceScope,kind,locator.type,id])`，来源独立为 local/notion。

用 `$alias@notion` 显式选择 Prompt。每次提交新建 invocation、会话 generation 与 prepared 集合，同轮预检和派发共用固定快照；下一轮再次引用会完整加入本轮用户任务，保留原文与图片。Prompt 不进入原生 Skill、默认发现、后台预取、关键词自动激活或 system prompt。取消、超时和切会话阻止旧轮派发。双宿主及 detached 补全在 v1 中共享 `identity/kind/source/ref` 与原 UTF-16 编辑范围；接受候选只改草稿。

旧 Bundle catalog 和 session 标记通过 `node scripts/migrate-content-assets.mjs INPUT OUTPUT` 显式转换。运行时只接受 Router；转换写独立输出，保留不可变快照和资源路径。
转换只修改 catalog 记录字段及已识别的 Broker session details，包括结构化 Router 引用和来源回执身份。正文、snapshot ID、资源路径及未知嵌套数据即使含 `bundle:` 或 `kind="bundle"` 也原样保留。混合 catalog 结构及非法 member 会拒绝；原件和已存在输出不会被覆盖。

## 用随包 Skill 维护与同步

安装包始终携带三份 Skill：`$ntn-skills@builtin`、`$ntn-skills-maintain@builtin` 和 `$ntn-skills-sync@builtin`，以及完整的参考文件。只有配置了至少一个未禁用的 `type: notion` source，才会在普通 `$` 候选中显示它们；尚未连通 Notion 或完成认证也能离线读取包内正文与资源，无需先发布到 Notion 或另行安装。没有启用 Notion source 时不显示这三条 builtin 补全。

```text
$ntn-skills-maintain@builtin 把这段对话中可复用的方法整理为 Skill，保存到我的 Notion 库。
$ntn-skills-sync@builtin 检查已连接来源，预览这次需要执行的同步。
```

当前 Agent 读取选中的工作流，使用 Broker 给出的真实 CLI argv 与数据库范围。配置多个 Notion source 时须明确选择目标 source 或 database，不隐式取第一个。命令和资源用法由 `$ntn-skills@builtin` 提供。Notion 写入与同步沿用 CLI 自身的预览、精确目标和操作结果合同。通过配置的 CLI 观察到已验证的真实写入后，Broker 在下一次普通选择时刷新对应来源目录，新建或改名后的 Skill 无需人工刷新即可发现。已加载快照和已接受草稿保持原有归属。

`/context-broker` 保留 View 选择、元数据刷新与诊断。旧 `/ntn-skills` 命令镜像、专用 `save` 和 Tern 管理面板已退役。把自然语言要求与附件留在普通 prompt 中；选择 Skill 只编辑草稿。

已经接受的引用失效时，用户和模型都会收到明确的“未加载”反馈，原文、图片和其他有效引用仍只派发一次。普通未知 `$name`、`$name@namespace`、金额和路径继续按字面文本处理。

## 安装

安装到你使用的宿主：

```bash
# Pi
pi install npm:pi-context-broker

# OMP
omp install npm:pi-context-broker
```

Broker 包需要 Node.js 22.x 中的 22.22.3+，或 24.20.0+。Bun 仅用于构建，不作为生产 CLI 运行时。在 OMP 安装或升级后，输入 `/restart`，恢复当前会话并执行新版扩展代码。`/reload-plugins` 只刷新发现状态，不重新执行已加载扩展。

npm 包和 GitHub `main` 是独立的分发来源。npm 发新版前如需试用当前 checkout，在仓库根目录执行：

```bash
bun install --frozen-lockfile
bun run build

# 选择一个宿主
pi -e ./packages/context-broker/src/index.ts
omp -e ./packages/context-broker/src/index.ts
```

可选 Tern 配套插件使用独立的 [Release 安装入口](#tern-补全)。

## 快速开始

### 1. 配置 Skill 目录

Pi 创建 `~/.pi/agent/context-broker/config.yml`；OMP 创建 `~/.omp/agent/context-broker/config.yml`：

```yaml
skillRoots:
  - ~/context/skills
requireAutoload: false
pathMode: home-relative
logPaths: false
```

自定义 agent 目录或 OMP profile 时，参见[配置解析规则](./packages/context-broker/docs/reference.zh-CN.md#配置)。修改配置后重启宿主；OMP 使用 `/restart`。

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

在宿主输入框执行：

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

按 Enter 立即开始 preparation 并锁定提交，草稿仍可编辑。原生编辑器显示 running 与 **Stop**；点击 **Stop** 或按 Escape 可取消 preparation。期间再按 Enter 不会提交编辑后的草稿。成功后，首个 provider 请求一次性包含原提示词、图片及完整选中 Skill 正文。阻断型激活错误、超时或取消不产生 provider 请求；切换会话也会阻止迟到结果派发。

未知简单 `$name`、`$name@namespace`、金额和 `$bunfs/root/chunks/cli-nxfh2cp0.js` 等路径保持普通文本，不产生失败提示。之前已接受的选择或完整身份 token 不可用时，用户与模型都会收到明确的“未加载”反馈；其他有效 Skill/Prompt/Router、原文与图片仍只派发一次。歧义及实际已选记录的权限、网络、目录或完整性错误仍阻断，不悄然改选其他来源。

下一次模型请求会包含 Skill 内容。正文仍在有效上下文时，通过 `$` 或 OMP 原生 `/skill:` 再次提交同一记录会复用已有正文。回退或压缩移除正文后可以重新加载；去重不会从后续请求中移除已经存在的上下文。

OMP（包括 Tern 中运行的 OMP）将有效上下文中的完整 Skill 正文视为已读。`$` 注入标明调用引用、source 的原生宿主名与资源目录，模型可直接使用正文，仅在需要时读取附加资源。目录路径继续遵守 `pathMode` 隐私设置。详见[宿主消费合同](./packages/context-broker/docs/reference.zh-CN.md#宿主发现与选中激活)。

### 添加 Notion source

插件已包含 `ntn-skills`，无需全局安装。安装支持 `api --notion-version` 的[官方 Notion CLI](https://developers.notion.com/cli) `ntn`（0.22.12+），通过 `ntn login` 或 CLI 既有 token 完成认证，再向同一份 broker config 添加 source：

```yaml
sources:
  - id: notion
    type: notion
    # 换成自己的 Skills database id 或无歧义 selector。
    database: 00000000-0000-0000-0000-000000000000
    discovery: {maxAge: 5m, offline: false}
    activation: {maxAge: 5m, offline: false}
```

不要将凭据写进这份配置。每个 Notion source 可选配 `default_view_id`；不配置就用 API 返回的第一个 View。显式 ID 失效会提示，不静默改选；确认没有 View 时默认远程目录为空。OMP 查询期间编辑器照常可用；用户首次发送后，在模型请求发出前等候并注入当前目录。每轮 `before_agent_start` 只替换 Broker 自己的目录，保留本地技能和已读正文。View 内未勾选 Default Context 的技能可默认发现，View 外已勾选的也不会越过筛选。完整 `$` 与 CLI 仍可显式使用所有已发现记录。代码或配置文件改变需要重启宿主，会话内切换 View 不需要。

`/context-broker refresh` 刷新元数据，让后续 selection 可以取得新 snapshot，已有会话正文保留。不限定 database 的 Notion 发现可能受搜索索引限制；显式 database 可取得该 database 的 exhaustive coverage。所有字段、scope 隔离、歧义和缓存策略见[source 配置与激活](./packages/context-broker/docs/reference.zh-CN.md#内置-sources)。

Notion 缓存按凭据和远端目录身份共用。全库目录与 View 成员使用不同缓存选择，不会因会话筛选缩小其他会话的 `$` 候选。View 选择写入当前会话分支，进程续接时恢复；新会话独立解析默认值。共享刷新保留已加载工作流的固定快照。[缓存合同](./packages/context-broker/docs/reference.zh-CN.md#内置-sources)。

执行 `/context-broker doctor` 检查官方 CLI 版本、能力、认证和 source 访问。缺少依赖或访问失败只将对应 source 标记为不可用，本地 Skill、正常 source 和普通聊天继续工作；激活不可用 source 中已选的已知记录时阻断提交并提示修复方法。未知简单引用即使使用该 source 的 namespace 也原样透传；已接受或完整身份的引用会明确报告未加载。修复后执行 `/context-broker refresh`。显式配置 `command` 会覆盖包内 CLI，其安装由使用者负责。

`/context-broker sources` 显示后台准备状态、snapshot/version ID、CLI freshness 与安全错误码；`ready` 只表示内容已准备，不代表指令已加载到会话。

### 更新随包 Skill

随包 Skill 跟随已安装的 Broker/配套插件版本更新。升级这两个包后重启宿主，OMP 使用 `/restart`，即可采用新版工作流与参考文件。同名 Notion 页面或本地 Skill 保持独立身份；`@builtin` 始终指向随包工作流。

Notion 数据和已连接来源目录继续由 CLI 管理，相应任务通过维护或同步 Skill 完成。Source 专用 `command` 只改变该来源的 executable，不替换随包工作流。详见[随包 Skills](./packages/context-broker/docs/reference.zh-CN.md#随包-skills)与[构建输入](./CONTRIBUTING.md#bundling-cli-and-skills)。

## Tern 补全

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

归档包含 query、随包 CLI、三份 Skill 及资源、生产依赖和许可声明。Tern 安装目录，不直接安装 tar URL。升级时重新下载并解压，在安装命令后加 `--force`。源码 checkout 先按[构建步骤](./CONTRIBUTING.md#bundling-cli-and-skills)生成完整目录，再本地安装。两种补全都只编辑草稿；提交后由 Broker 加载选中内容。

两个插件可以同时安装：Tern 呈现原生界面，OMP 继续执行 broker 扩展，并负责上下文注入。从自动下拉切换到手动搜索时，先按 **Esc**，再按 **Ctrl+Alt+Shift+K**。两个菜单目前没有显式互斥，验收未覆盖同时打开。详见[双插件共存说明](./packages/tern-context-broker/README.zh-CN.md#双插件共存)。

配置、更新、卸载和本地开发见 [Tern 子包指南](./packages/tern-context-broker/README.zh-CN.md)。

## 文档

- [文档导航](./packages/context-broker/docs/README.md)：双语合同、示例与验证入口。
- [Broker 参考](./packages/context-broker/docs/reference.zh-CN.md)：sources、宿主 Skill 目录/read、canonical tokens、snapshots、Skill 优先级、Router、配置、规则、payload 和补全 CLI。
- [Tern 子包指南](./packages/tern-context-broker/README.zh-CN.md)：手动搜索、profile、草稿保护，以及 GitHub 与本地构建切换。
- [配置示例](./packages/context-broker/examples/config.example.yml)和 [catalog 示例](./packages/context-broker/examples/discovery-catalog.example.yaml)。
- [Broker verification Skill](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-context-broker/SKILL.md) 与 [Notion integration verification Skill](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/SKILL.md)：checkout 操作规程与 feature maps；[日常安装与原生菜单](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/features/daily-installation-ui.md) 单独验证实际安装、斜杠菜单、真实 Notion 与模型消费。CLI consumption 验证位于 [CLI 仓库](https://github.com/yoyooyooo/notion-skills-cli)的 `.cursor/skills/verify-ntn-skills/SKILL.md`。这些路由不表示已经通过验收。
- [贡献指南](./CONTRIBUTING.md)：开发检查、验收和发布流程。
- [变更记录](./CHANGELOG.md)和[安全策略](./SECURITY.md)。

## 隐私与支持

Broker 使用宿主 agent 的本地权限。选中的 Skill 内容会发送到你配置的模型 provider，并保存在会话历史中；Router 暴露成员 metadata 和路径，成员正文另行加载。请使用可信 roots、catalogs、source commands 与 Notion databases。Notion 凭据由 `ntn-skills` 管理；元数据与选中的正文/资源缓存在本地。Source 错误只暴露安全错误码，不回显原始 stderr 或秘密。路径默认尽量采用 home-relative；`pathMode: hash` 可以进一步隐藏路径，decision 日志默认不记录路径。

本地 Pi/OMP 检查在 macOS 运行过，CI 在 Linux 运行 CLI 和产物检查。Windows path-list 分隔符已适配，但 Windows 运行行为尚未验证。Tern 原生 UI 检查需要 macOS；手动配套插件不支持远程 pane 或 Tern web client。

Bug 请提交到 [GitHub Issues](https://github.com/yoyooyooo/pi-context-broker/issues)，漏洞使用[私密安全报告入口](https://github.com/yoyooyooo/pi-context-broker/security/advisories/new)。项目采用 [MIT](./LICENSE) 许可证；分发查询程序包含依赖许可声明。

### 在当前会话切换 View

```text
/context-broker views
/context-broker view
/context-broker view VIEW_ID_OR_NOTION_URL
/context-broker view notion VIEW_ID_OR_NOTION_URL
/context-broker view default
```

`views` 按 API 顺序列出候选和可复制的选择命令。`view` 不带参数显示当前名称、ID、来源、选择原因及数量。多个来源时明确写 source ID。选择只影响当前会话；`default` 恢复配置值或首项兜底。这些命令不调用 LLM。下一条普通用户消息发送后，当前名称和描述才随请求交给模型，正文仍按需读取。固定默认值时，在 Notion source 的 `database` 旁填写 `default_view_id: VIEW_UUID`；不按 View 名字约定，也不保证 API 首项就是界面最左项。
