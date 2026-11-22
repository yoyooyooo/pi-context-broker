# Pro / Mini 的 next 日用交付

本轮由 AH-1197 持有双机入口，AH-637 持有 Mini 独立验收，AH-1198 持有配对后的当前时间线。每次交付都要核对两机实际提交、构建字节和新进程；一次正确的路径或旧回执不能覆盖后续更新。

## 唯一当前代码来源

两机使用各自明确的 `next` checkout。CLI 包来自该 checkout 的 `packages/cli`，Broker 来自配对 checkout 的 `packages/context-broker`。不要让普通入口同时保留旧 npm Broker 和新本地 Broker 两份活动扩展。

推进前先核 origin、分支、HEAD 和未提交改动。只对干净的自有 checkout 执行 `git pull --ff-only`；上游已变化或本地有未完成工作时先保存并整合，禁止 force push、merge commit、reset --hard 或覆盖其他会话的改动。

CLI 先完成当前 gate 并提交，Broker 的 CI/publish CLI pin 再绑定该完整 commit。双机都以相同的目标 commit 对齐；不能用 main、发布版本或另一个工作树替代。

## 构建与来源对应

先构建 CLI，再明确选择这份 raw CLI/SDK 构建 Broker：

```sh
# CLI checkout
bun run build

# Broker checkout
NTN_SKILLS_BUILD_ENTRY="$CLI_ROOT/packages/cli/dist/ntn-skills.js" bun run build:broker
```

使用本次已声明的受支持 Node、Bun 与 Git runtime，保留实际 executable/version。临时命令的工具选择与普通 `pi` 的 runtime 分别记录，不能靠临时 PATH 把普通入口的缺项隐藏掉。

两个 build 在 `dist/next-build.json` 写入源文件清单与产物 SHA。Broker 另外绑定所选 raw CLI/SDK 与 Skills。构建途中输入变化会失败。源文件新增、删除、提交后未重建、产物被替换或 Broker 仍嵌入旧 SDK，都会被下列检查拒绝。

```json
{
  "version": 1,
  "cliRoot": "/absolute/cli-next/packages/cli",
  "brokerRoot": "/absolute/broker-next/packages/context-broker",
  "worktrees": {
    "cli": {"root": "/absolute/cli-next", "commit": "COMPLETE_TARGET_CLI_COMMIT"},
    "broker": {"root": "/absolute/broker-next", "commit": "COMPLETE_TARGET_BROKER_COMMIT"}
  }
}
```

```sh
node scripts/verify-next-worktrees.mjs --config /absolute/owned/current-pair.json
```

示例占位符必须换为实际绝对路径和 40 位 commit。检查要求 branch 为 `next`、HEAD 精确匹配、工作树干净、包路径位于对应 checkout、源清单及 raw/embedded 构建对应。每仓还执行非交互 `git ls-remote origin refs/heads/next`，最多等待 10 秒，真实远端必须仍等于目标；旧的本地 `origin/next` tracking ref 不能代替这一步。网络或认证无法完成时记为 `blocked`，不自动拉取或回退到旧回执。

回执版本为 2，含稳定的实际机器指纹。macOS 使用平台 UUID，Linux 使用 machine-id；原值只在进程内读取，回执仅保存带固定域前缀的 SHA-256 和平台名。无法取得受支持的机器身份时 `blocked`，不以 hostname 替代。该结果固定标为 `actual_pi_process:not_run`；它没有启动 Pi。

## 普通入口与新进程

源/包检查完成后，使用 Pi 的公开安装/配置入口选择实际 Broker 工作树。先读回现有 package 来源，再做唯一来源切换，最后再次读回；不要覆盖其他插件、认证、模型或用户会话。包管理器的删除行为也必须符合系统 Trash 约束。

单独核对普通 `ntn-skills` 解析到的实际 CLI，以及普通 `pi` 使用的 Node/Pi 版本。一个显式 Node 候选成功，不证明不带额外参数的 `pi -ns` 可用。

普通 `pi` 可以是原生包入口，也可以是保留日用行为的 exec shim。检查器保留 launcher 的路径和 SHA，并从实际 owned 进程读取 Node executable/version、Pi entry、最近 package.json 的 name/version 与 `pi` bin 对应关系。入口文件名或 shim 中出现的路径不构成 Pi 身份。实际 Pi 必须保持 launcher 的 PID 和 RPC 参数，SDK observer 也必须属于该 PID；结束时核对成功退出及 launcher、Node、entry、manifest 字节未变。缺少实际进程、包/bin 不符或启动额外子进程而未保留 owned PID 时，本次检查失败，不临时改 PATH 绕过。

现有日用检查继续使用同一个入口：

```sh
node scripts/verify-pi-daily-installation.mjs plan --config /absolute/owned/current-daily.json
node scripts/verify-pi-daily-installation.mjs run --config /absolute/owned/current-daily.json
```

daily config 需要配对 worktrees 以及本次归档、CLI/SDK、package 来源等实际身份；先读 `--help` 与 plan 的必需字段。两机在开始本次交付时共同生成并使用同一个 `delivery`：`id` 为新的 UUID，`startedAt` 为本次开始时的 UTC ISO 时间。不能把旧执行的时间或 ID 改写为本次。输入配置仍为 `version:1`，实际日用回执统一为 `version:2`，不兼容旧日用回执。

plan 为 `prepared_not_executed`。run 在新普通 `pi -ns` 中检查实际注册入口与 metadata 路径，并在结束后重验机器、真实远端、worktrees 和构建。回执记录本次开始/结束时间、实际机器、注册入口与进程退出。它不替代正文、真实模型或时间线任务。

Pi 的 `responseModel` 是可选响应信息。现役 cost observer 区分原始未报告、合法报告和非法值；分析器保留未报告为 unknown，不从请求 model 补值。HTTP/SSE 完成仍需真实传输和同请求的响应证据；缺少这项原始状态的旧观察不能按新规则补成通过。

普通真实模型可能由现役 `pi-compact-ui` 注册 `read`。Broker 的公开 hook 将候选或已选主文（`sr:C…`、`sr:S…`）及单个资源（`sr:R…`）解析为不可变文件，再交给该包的内建读取委托。该有限 profile 只接受单路径完整文本读取；原始 `refresh` 布尔参数必须原样保留，显式刷新仍为查看，不改变已激活工作集。task observer 仅在同调用、同轮的当前 v3 主文或 v2 资源回执到达后，保全实际执行参数和完整文件字节。原始短引用必须已存在于实际 native 分支；资源还必须唯一关联此前已选 owner，并匹配其 scope、snapshot、version 和固定 File。entry 投影同时保全并核对完整 `.broker-entry.json`；独立 resource 投影没有该 manifest，不猜测或读取不存在的主文清单。分析器重新核验原始与 prepared 参数、当前 Broker 注册、不可变身份、实际 callback/回执顺序及交付的完整字节，并只接受已审阅 `pi-compact-ui@0.1.3` 的精确 package/index 字节。该 profile 不覆盖批量、部分读取、其他插件或其他工具。旧观察缺少原件时继续失败，不能据事后路径或回执补造证明；更新后用新真实模型运行取证。

如果执行环境不允许读取该检查需要的日用配置，记录具体 blocked，不通过另一条文件路径绕读。可使用公开 Pi API 取得独立的部分证据，但不能把该部分回执标为完整 daily runner 通过。

## 每次更新的完成条件

每机保留目标 commit、干净状态、构建回执、实际 CLI/SDK/扩展路径与 hash、新进程 executable/version、公开来源读回和本次结果。收齐两份本次日用 `result.json` 后，用原入口进行联合检查：

```sh
node scripts/verify-pi-daily-installation.mjs aggregate --config /absolute/owned/current-delivery.json
```

aggregate config 使用相同的 `version:1`、`delivery`、`worktrees`、`cliRoot` 与 `brokerRoot`，另加两份原始回执的路径：

```json
{
  "delivery": {"id": "NEW_SHARED_DELIVERY_UUID", "startedAt": "CURRENT_DELIVERY_START_UTC_ISO"},
  "receipts": {"pro": "/absolute/owned/pro/result.json", "mini": "/absolute/owned/mini/result.json"}
}
```

这是配置增量示例，须与上文的实际配对字段合并。联合检查重新查询真实远端和本机构建，要求两份回执来自不同实际机器、同一交付及同一当前配对与构建，且均由当前检查入口产生。普通 Pi 必须实际注册目标 Broker、完成 SDK metadata 检查并有退出证据。单机重复两次、旧回执、candidate、source/build-only、缺失、失败、blocked 或 not_run 均不能通过。两机任一缺项时，交付项保持开放。

联合 `passed` 的范围是 `two-machine-ordinary-pi-startup-and-metadata`。它仍将 provider/model 与正文消费标为 `not_run`；真实模型与时间线任务沿各自现有验收入口单独取得证据。

本合同不自动发布 npm、不合并 main，也不在每次启动时隐式拉代码或改变已有会话版本。新代码通过下一次已核对的新进程生效；既有任务的内容 pin 仍由消费合同管理。


## 普通模型观察中的包归属

模型和正文证据仍单独采集，不加入上面的 metadata aggregate。复用现役
`analyzeNotionAgentTurn` 分析普通安装时，原始 `get_commands.sourceInfo.source`
可能是用户 settings 中的相对路径，不能将它改写为绝对路径来冒充观测。

分析输入可明确提供 `implementation.ordinaryInstallationArtifact`，指向本次冻结的
JSON 原件（仍用 `path/bytes/sha256` 身份）。内容为：

```json
{
  "version": 1,
  "kind": "ordinary-pi-package-binding",
  "settingsDirectory": "/absolute/user/.pi/agent",
  "settings": {"path": "/absolute/user/.pi/agent/settings.json", "bytes": 1234, "sha256": "ACTUAL_SETTINGS_SHA256"},
  "package": {"index": 1, "count": 2, "source": "../../actual/broker/packages/context-broker"}
}
```

这些字段必须从实际普通 settings 读取。`settings` 与启动原件的 `before.settings`
精确相同（有 `realpath` 等字段时也完整保留）。分析器读回并核对该 settings 原件的字节哈希，
从真实 `packages` 核总数和唯一目标 slot；index 与本次配置的 `packageIndex` 相同，
source 与实际 settings slot 及 user scope 注册原样相同。
分析器只从这个冻结的 settings 目录解析本地来源；包自身的 `sourceInfo.baseDir`
不是解析基准。解析结果、真实注册的 entry/baseDir、干净提交和冻结 package/entry 字节
必须仍属于同一 Broker。原先候选绝对来源的判定不变；缺绑定、改动过的原件、错误目录、
其他来源或包均不能借用归属证明。该可选分析输入不创建新的执行入口，也不修改日用配置。
