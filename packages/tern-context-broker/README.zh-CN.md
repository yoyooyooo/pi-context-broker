# Tern Context Broker

[English](./README.md) | [中文](./README.zh-CN.md) · [项目概览](https://github.com/yoyooyooo/pi-context-broker/blob/main/README.zh-CN.md)

[安装](#安装) · [使用](#使用) · [配置](#配置) · [开发](#本地开发)

可选 Tern window 插件，在本地 **OMP native GUI 草稿**中选择上下文。Broker 提供自动 `$` 菜单和原生胶囊，配套插件提供更宽的菜单布局与 **Ctrl+Alt+Shift+K** 手动搜索。选择后继续编辑 prompt，准备好再提交。

## 前提

- Tern 提供 `session:surface`、`session:event`、`sessions:current` 和 `cx:pick`；当前 API 核对使用 Tern 0.9.5。
- OMP 18.10.3+，已加载 Context Broker 扩展。
- Tern 的 PATH 中有 Node.js 22.x 中的 22.22.3+，或 24.20.0+，或显式配置 `node`。
- 工作目录已知的本地 OMP native pane。Terminal pane 使用各宿主的 Broker editor；手动搜索不支持远程 pane 和 web client。

Broker 安装见[项目快速开始](https://github.com/yoyooyooo/pi-context-broker/blob/main/README.zh-CN.md#快速开始)。配套插件包含 query、CLI 和工作流 Skill；在线 Notion source 使用官方 `ntn` 0.22.12+（支持 `api --notion-version`）与既有认证。一个 source 不可用时，本地及其他正常来源仍可选择。

## 安装

使用[正式 GitHub Release](https://github.com/yoyooyooo/pi-context-broker/releases)中的完整 `tern-context-broker.tar.gz`。下载、解压后安装目录：

```bash
broker_release_dir="$(mktemp -d)"
curl -fL https://github.com/yoyooyooo/pi-context-broker/releases/latest/download/tern-context-broker.tar.gz -o "$broker_release_dir/tern-context-broker.tar.gz"
mkdir "$broker_release_dir/plugin"
tar -xzf "$broker_release_dir/tern-context-broker.tar.gz" -C "$broker_release_dir/plugin"
tern plugin install "$broker_release_dir/plugin"
tern plugin list --json
```

归档包含 `query/completion.mjs`、`query/ntn-skills.mjs`、三份 `query/builtin-skills` 目录及参考资源、生产 `query/node_modules` 与许可声明，安装后无需另下载依赖。`tern plugin list --json` 应显示 `context-broker` 为 `ready` 且无 problems。安装会重载运行中的 daemon；否则下次启动生效。

升级时重新下载、解压，然后执行 `tern plugin install <解压目录> --force`。Tern 接受目录或 git source，不直接安装 tar URL。源码 checkout 未提交生成运行时，须先按[构建步骤](https://github.com/yoyooyooo/pi-context-broker/blob/main/CONTRIBUTING.md#bundling-cli-and-skills)构建再安装。卸载使用 `tern plugin remove context-broker`。

升级 Broker 代码后，在 OMP 执行 `/restart`。`/reload-plugins` 只刷新发现，不重新执行已加载扩展；`tern plugin reload` 只重载配套插件。

## 使用

1. 在 OMP 输入 `$` 或 `$design` 这样的前缀。
2. 自动菜单用方向键选择，Tab 或 Enter 接受，Esc 关闭。胶囊编辑、删除和 undo 归 Broker 管理。
3. 手动搜索先按 Esc 关闭自动菜单，再按 **Ctrl+Alt+Shift+K** 选择候选。取消不改草稿。
4. 核对 prompt 后提交。选择本身不请求模型，提交时 Broker 加载内容，并保留原文、附件和其他引用。

手动选择只执行一次原生范围编辑，插入普通精确 token：Notion 沿用 `$alias@page-id@namespace`，filesystem 使用编码后的本地身份。Label 保持简短，身份不从 label 反解。自动补全可以保留短 token，因为 Broker 在提交边界捕获已接受的身份；两条路径都保留目录变化前的精确选择。

已选目标消失时，用户和模型都会收到“未加载”反馈。完整身份不在目录时只说明当前目录不可用，不假称已做远端 read。其他有效引用和原文仍只派发一次。未知简单 `$name`/`$name@namespace`、金额和路径保持字面文本；实际权限、网络、完整性或歧义错误仍阻断激活。

Preparation 期间草稿仍可编辑，但不接受第二次提交；原生 **Stop** 或 Escape 可取消。前一轮运行期间新接受的草稿归下一次提交。Broker 的持久 `Read ntn-skills://<alias>` 行仅用于展示；模型真实资源读取使用已选目录或 `skill://` 快照引用。

上游 Skill 可用 `$pstack/` 浏览订阅，或 `$pstack/cor` 缩小范围。订阅 Name 决定 `pstack/correct [skill]` 之类的 label，页面身份与来源仍明确保留。

**Cancel pending Context Broker native operation** 会使待返回的 query/picker 失效并释放配套 UI 操作锁；Esc 关闭可见 picker。公开进程 API 没有子进程取消 handle，已启动的元数据查询可能运行到十秒超时，但迟到结果不会编辑草稿。

## 随包工作流

Pi、OMP TUI 和 OMP native GUI 使用相同的普通 `$` 入口：

```text
$ntn-skills@builtin 说明这个任务需要的 CLI 命令。
$ntn-skills-maintain@builtin 把这段对话中的可复用方法保存到 Notion。
$ntn-skills-sync@builtin 预览这次要求的同步。
```

三份 Skill 的正文及参考文件始终随包提供，但只有配置了至少一个未禁用的 `type: notion` source，才会在 `$` 补全中显示。即使 Notion 尚未连接或认证，启用后仍可离线读取，且无需全局 `ntn-skills`、事先发布或手动安装；没有启用 Notion source 时不显示这三条 builtin 候选。当前 Agent 使用 Broker 提供的实际 CLI argv 与 source/database 范围，多个来源须明确选择。三个 `@builtin` 身份与同名本地文件、Notion 页面相互独立。

配套插件不再提供 CLI 命令镜像、save 包装、管理 reader 或 install/publish 面板。宿主中的 `/context-broker` 保留 View 选择、刷新与诊断。升级 Broker/配套插件即可更新随包工作流。

## 双插件共存

| Surface | 输入、选择和派发归属 | 配套插件作用 |
| --- | --- | --- |
| Tern 中的 Pi TUI | Pi Broker adapter/editor | 不编辑 terminal 草稿 |
| Tern 中的 OMP TUI | OMP Broker adapter/editor | 不编辑 terminal 草稿 |
| Tern 中的 OMP native GUI | OMP Broker native editor | 手动精确 token 插入和自动菜单样式 |

自动菜单加宽到 720 像素，长名称最多占行宽 60%，窄 pane 自动约束宽度；原生斜杠菜单保持宿主布局。打开手动搜索前先关闭自动菜单，两条触发路径不会显式关闭彼此。

手动回调在编辑前检查 pane、cwd、Tern workspace/session、surface/editor、全文、UTF-16 光标和请求归属，只修改已选前缀范围。中文和 emoji 偏移不能切开 surrogate pair。公开 Tern 快照不提供 OMP conversation/branch、附件和 undo revision；相同可见快照不能证明中间没有变化。插件不发送附件替换或虚构 session event。会话切换、附件与 undo 行为需独立真实宿主验证。

## 配置

Query 默认读取 `~/.omp/agent/context-broker/config.yml`，应与 Broker 当前 profile 的 sources、roots、catalogs 一致。Notion command、database、namespace 与缓存策略配置在 Broker 中，凭据留在 CLI 的既有认证。

可选配套配置保存在 `<Tern config>/plugin-data/context-broker/config.json`，独立于安装源码：

```json
{
  "node": "/absolute/path/to/node",
  "config": "/absolute/path/to/context-broker/config.yml",
  "agentDir": "/absolute/path/to/profile/agent"
}
```

三个字段都可选，请替换成实际路径。macOS 默认 Tern config 为 `~/Library/Application Support/Tern`，可用 `TERN_CONFIG_DIR` 覆盖；插件更新保留这份独立配置。旧 `builtinAgentDirs`、`cliConfigHome` 和 `cliStateHome` 不再使用；query 认证沿用 source command/environment。

独立 query 搜索随包 Skill 与完整配置目录，不受当前会话 View 限制；只读元数据，不继承 system prompt 中动态发现的 Skill。Broker 独立准备所选 View 的内容，提交时加载所选完整正文和资源。

## 本地开发

在仓库根目录执行：

```bash
bun install --frozen-lockfile
bun run build
tern plugin install ./packages/tern-context-broker --force
omp -e ./packages/context-broker/src/index.ts
```

TypeScript、CLI 或 Skill 资源变化后重新构建、安装复制包；只改 Luau 时重新安装即可。实时 Luau 开发使用 `tern plugin link ./packages/tern-context-broker` 直接引用源码，再用 `tern plugin reload` 重载。已有复制包须先备份或移到系统废纸篓，`--force` 不覆盖链接；切回复制 Release 前执行 `tern plugin unlink context-broker`。日志与运行配置放在链接源码之外。

`bun run test:ui` 使用隔离的真实 Tern 窗口与 OMP 宿主，配合受控 provider/source fixture，检查自动胶囊、正文次数、手动 Unicode 替换、取消与焦点变化，并保留截图和证据。Pi TUI、OMP TUI、真实 Notion 内容和模型实际使用指令有各自验证入口，不能由单个原生窗口结果替代。

## 排障

手动搜索打不开时，聚焦本地 OMP native composer，把光标放在 `$` 或前缀后。缺候选时执行 `/context-broker doctor` 和 `/context-broker find <query>`，再核对双方 profile。Node 启动失败时检查 Tern 的 PATH 或显式 `node` 设置。缺少 `query/node_modules` 或 builtin 目录表示源码安装不完整，使用完整 Release 归档或重新构建。

配套插件读取配置的元数据，以当前用户权限启动 Node。Notion source 使用配置的 CLI 和 discovery 缓存策略，候选文字不会当 shell 代码执行。参见[安全策略](https://github.com/yoyooyooo/pi-context-broker/blob/main/SECURITY.md)与 [MIT 许可证](./LICENSE)。
