# pi-context-broker

[English](./README.md) | [中文](./README.zh-CN.md)

`pi-context-broker` 让你在 Pi 或 OMP 的 prompt 里用 `$name` 拉取本地上下文。

```text
$design-review review this API boundary
```

插件会找到 `design-review`，注入匹配的本地 `SKILL.md` 或上下文包索引，并在同一个 active session branch 里避免重复注入。

## 它解决什么问题

Agent 环境用久了以后，会积累很多有用上下文：评审清单、项目 runbook、团队流程、provider 说明、调试方法和个人 skill。全部常驻 prompt 会很吵；让模型自己记住文件名不稳定；每次手动打开文件又打断节奏。

Context Broker 在你的 prompt 和本地上下文库之间加了一层很小的路由。你点名要哪个上下文，插件负责解析并注入一次。

它不跑远程索引，不用 embedding 猜测，也不会在后台加载所有内容。选择权在用户手里。

## 你会得到什么

- 用 `$name` 查找本地 skill 和 catalog 记录。
- Pi 交互模式下支持 `$...` 自动补全。
- 支持规则注入，比如 `review this design` 加载 `design-review`。
- 支持显式 `bundle:<name>` 规则目标，用关键词触发 Bundle 索引。
- 支持 bundle，适合大型上下文区域先给模型一个索引。
- 提供 `/context-broker` 命令检查配置和调试查找结果。
- 检查 name 和 alias 的命名空间冲突。
- 在当前 active session branch 里避免重复注入。
- 支持路径隐私配置，覆盖模型 payload、session metadata 和 JSONL 日志。
- 默认限制扫描深度和 skill 文件大小，避免误配 root 后读太多内容。

## 工作方式

Context Broker 有两类记录。

| 记录 | 来源 | 注入内容 |
| --- | --- | --- |
| `skill` | 发现到的 `SKILL.md` 文件 | 完整 skill body |
| `bundle` | YAML 或 JSON catalog | bundle 描述、policy 和成员列表 |

Skill 适合具体操作说明。Bundle 适合做路由。当一组相关 skill 很多时，先给模型成员索引，比一次性塞进所有成员正文更稳。

## 安装

Pi：

```bash
pi install npm:pi-context-broker
```

OMP：

```bash
omp install npm:pi-context-broker
```

不安装，直接试本地 checkout：

```bash
pi -e ./src/index.ts
omp -e ./src/index.ts
```

## 快速开始

### 1. 添加配置文件

Pi 读取：

```text
~/.pi/agent/context-broker/config.yml
```

OMP 读取：

```text
~/.omp/agent/context-broker/config.yml
```

最小配置：

```yaml
skillRoots:
  - ~/context/skills

requireAutoload: false
pathMode: home-relative
logPaths: false
```

### 2. 添加一个 skill

创建：

```text
~/context/skills/design-review/SKILL.md
```

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

### 3. 使用它

```text
$design-review review this API boundary
```

下一轮模型会收到你的 prompt 和 `design-review` 的 skill body。

### 4. 检查插件看到的内容

```text
/context-broker doctor
/context-broker find design
/context-broker explain design-review
```

## Skills

Context Broker 会发现 `skillRoots` 下的每个 `SKILL.md`。

```markdown
---
name: design-review
description: Review architecture and API trade-offs.
autoload:
  enabled: true
  aliases:
    - architecture-review
---

Skill body goes here.
```

默认情况下，`autoload.enabled` 影响规则注入。显式 `$name` 查找仍可以找到已配置的 skills，除非你通过配置或环境变量强制打开 autoload gate。

## Bundles

Bundle 写在 discovery catalog 里。它注入索引，不注入完整成员文件。

```yaml
version: 1
records:
  - kind: bundle
    name: workspace-collab
    description: Collaboration contexts for documents, chat, and tasks.
    aliases:
      - collab
    render:
      type: member-index
      rules:
        - This is a context bundle index, not a concrete skill.
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

Bundle 默认仍然只支持手动按需发现。若希望把 Bundle 实体化为宿主可发现的轻量 Skill，可开启：

```yaml
exposeBundlesAsSkills:
  include:
    - workspace-collab
```

只有需要暴露全部已配置 Bundle 时才使用 `exposeBundlesAsSkills: true`；默认值为 `false`。未配置输出选项时，插件继续在宿主 agent 目录下生成兼容的 flat-file 索引，并通过宿主资源发现注册。

若要让其他分发系统消费稳定的普通 Skill 目录，可以显式配置实体输出：

```yaml
exposeBundlesAsSkills:
  include:
    - workspace-collab
  outputRoot: ~/context/bundles
  layout: skill-dir
  nameTemplate: "{name}-bundle"
  memberPathRoot: ~/context
  registerWithHost: false
```

这会确定性生成 `~/context/bundles/workspace-collab-bundle/SKILL.md`。`outputRoot` 和 `memberPathRoot` 支持 `~`；相对路径按配置文件所在目录解析。`memberPathRoot` 让生成索引保存可移植的 source-relative 成员路径，而不是生成机器的绝对路径。`nameTemplate` 必须包含 `{name}`。`registerWithHost: false` 表示只生成文件，不再把同一索引直接注册到当前 Pi/OMP；适合由其他工具把实体 Skill 分发到全局发现目录。

Context Broker 用 owner manifest 记录 active set、源 Bundle identity 和 content digest。Reconcile 只会把有明确 owner marker 的 stale Bundle 索引移动到 quarantine；未知、无 marker 或截断文件均保留。公开实体目录可以保持稳定，hash 与时间戳只用于 manifest、临时文件和 quarantine。

规则也可以注入同一份轻量索引，而不加载成员正文：

```yaml
id: collaboration-keywords
inject:
  - bundle:workspace-collab
match:
  - contains:
      - 团队协作
```

规则目标必须显式使用 `bundle:` 前缀；不带前缀的目标保持原有的 Skill-only 行为。Bundle 规则只按已配置 discovery catalog 中的精确 name 或 alias 匹配，不做模糊匹配。

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

# 不设置时，broker 使用配置文件旁边的 context-broker/rules。
ruleRoots:
  - ./context-broker/rules

discoveryCatalogs:
  - ~/context/catalogs/workspace.yaml
extraDiscoveryCatalogs:
  - ./context/catalogs/project.yaml

requireAutoload: true

# 默认关闭。选择需要实体化的 Bundle；以下配置生成稳定 Skill 目录，
# 但不在当前宿主重复注册，便于交给外部分发系统。
exposeBundlesAsSkills:
  include:
    - workspace-collab
  outputRoot: ~/context/bundles
  layout: skill-dir
  nameTemplate: "{name}-bundle"
  memberPathRoot: ~/context
  registerWithHost: false

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
| `CONTEXT_BROKER_HOST=pi\|omp` | 强制宿主默认路径解析 |

Path-list 分隔符跟随平台：macOS/Linux 用 `:`，Windows 用 `;`。

## Rule files

Rule files 默认放在 `context-broker/rules/*.yml`。每个文件描述一个触发 profile。

```yaml
id: architecture-review
inject:
  - design-review
  - bundle:workspace-collab
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

一个生成文件也可以通过顶层 `rules` 数组声明多个 profile；这适合由同一份场景配置投影一组 Bundle 触发规则：

```yaml
version: 1
rules:
  - id: scene-coding
    inject:
      - bundle:scene-coding
    match:
      - contains:
          - 编码场景
  - id: scene-research
    inject:
      - bundle:scene-research
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
  - path: ./members/docs/SKILL.md
```

如果文件是 `SKILL.md`，Context Broker 可以从 frontmatter 读取 `name` 和 `description`。只有需要覆盖 metadata 时，才需要手写这两个字段。

完整示例见 [`examples/discovery-catalog.example.yaml`](./examples/discovery-catalog.example.yaml)。

## 注入 payload

Skill 注入：

```xml
<context-broker-record kind="skill" name="design-review" path="~/context/skills/design-review/SKILL.md">
<body>
...
</body>
</context-broker-record>
```

Bundle 注入：

```xml
<context-broker-record kind="bundle" name="workspace-collab" path="~/context/catalogs/workspace.yaml">
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
/context-broker roots
/context-broker catalogs
/context-broker materialize
/context-broker find <query>
/context-broker explain <record>
```

用子命令，不要用 colon-style command name。Pi 会把 colon suffix 用于命令冲突消歧。

## 安全与隐私

这个包运行在宿主 agent 进程里，权限等同于宿主。只从可信来源安装。

Context Broker 的设计目标就是把你选中的上下文发给模型：

- 匹配到 `skill` 时，完整 `SKILL.md` body 会发送给模型，并写入本地 session history。
- 匹配到 `bundle` 时，只发送成员 name、description、policy 和 member path，不发送成员 body。
- 配置 `exposeBundlesAsSkills.include` 后，选中的 Bundle 会实体化为轻量索引；`registerWithHost` 开启时才把名称、描述和位置直接注册到当前宿主。
- `outputRoot`、`layout: skill-dir` 与 `nameTemplate` 可以生成供外部分发系统消费的稳定 `<name>/SKILL.md`；相对 `outputRoot` 按配置文件目录解析。
- 生成索引 reconcile 受 owner scope 约束：stale owned index 与 invalid owner manifest 进入 quarantine，不永久删除；不修改 unowned file。
- Session JSONL 会保存注入内容。
- `CONTEXT_BROKER_LOG_FILE` 会记录匹配 query 和 record name。除非设置 `logPaths: true`，否则不会记录路径。
- `pathMode: home-relative` 会尽量避免暴露完整 home 目录路径。
- `pathMode: hash` 可以进一步隐藏路径。

不要把 `skillRoots` 指向不可信仓库。Skill 本质上是 prompt content，可以指挥模型。

## 平台支持

已在 macOS 上测试 Pi 和 OMP。Linux 应该可用。Windows path-list 分隔符已适配，但在 CI 覆盖前仍是 best-effort。

## 维护者与贡献者

### 本地开发

```bash
bun install
bun run check
bun run test:host
bun run test:global-config
npm pack --dry-run --json
```

### 发布流程

配置 npm Trusted Publishing 后，用 tag 脚本发布：

```bash
bun run release:check patch --no-push
bun run release patch
```

脚本会创建临时本地 release branch、更新 version files、提交、创建 tag、推送 tag，然后由 GitHub Actions 从该 tag 发布。

### 首次手动发布

配置 Trusted Publishing 之前，需要从真实 TTY 发布，让 npm 完成 2FA 或 web authentication：

```bash
npm login --auth-type=web --registry https://registry.npmjs.org
npm publish --access public --registry https://registry.npmjs.org --auth-type=web
```

Agent shell tools 通常不是 TTY，可能会因为 `EOTP` 失败。
