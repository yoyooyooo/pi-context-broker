# Notion 消费入口迁移：2026-11-05

本记录对应 `agent-cli-ref-20261105`、[AH-675](https://linear.app/yoyooyooo/issue/AH-675)、[AH-676](https://linear.app/yoyooyooo/issue/AH-676) 及 SC04–08、SC23 的当前切片。它记录已实现的行为和各层证据，不将开发候选等同于 SC22 正式双机验收或 SC24 日用切换。

## 用户入口与调用者

| 调用者 | 当前入口 | 兼容或边界 |
| --- | --- | --- |
| CLI 日常消费 | `list [--query TEXT]`、`read REF`、`use REF` | `read` 检查，`use` 完整取得根与 Requires；list/read 保留 JSON 默认 |
| CLI 管理 | `ctl views/prepare/resolve/operation/sync` 及原 ctl 子树 | 旧五个根入口为同一 AST/handler 的隐藏兼容；历史 next.argv 不改写 |
| CLI 作者 | create/write/update/apply/replace 的明确帮助与维护 Skill | 默认帮助不展开作者命令；原版本校验、unknown operation 和恢复合同保持 |
| Pi 默认 Notion 目录 | 随包 `ntn-skills/sdk.listCatalog` | 完整目录和 Default View 均使用 core 查询/缓存，无目录 CLI 子进程 |
| Pi 发现 | `notion_list({query?,source?,limit?,cursor?})` | 仅 Notion 元数据；分页完整性与来源覆盖分别报告 |
| Pi 检查和资源 | 原生 `read({path})`；固定同 owner 资源支持 `read({paths})` | 不因为使用 canonical/短引用自动启动 Requires 或启用 Skill |
| Pi 使用 | `notion_use({ref,refresh?})` | ref 可为一个或多个所需根；一次 SDK consume 取得完整 Requires；未选 Members 保持目录 |
| Pi 管理 | 按需发现的 `notion_ctl` | 默认不激活；导出当前分支 canonical 证明或明确 source 的 CLI 范围 |
| 普通本地 Skill | Pi 原生发现和读取 | 不进入 Notion 搜索与命名空间 |
| 显式 `source.command` | 原 CLI 兼容路径 | 仍可能产生子进程和逐节点读取，单独观测，不代表默认 SDK 路径 |
| OMP | 原 skill_search/skill_prepare/skill_graph | 本轮 Pi 合同之外的明确兼容，不据 Pi 证据宣称 OMP 通过 |
| 历史会话与 pin | 原版本 receipt/short-ref/固定资源 reader | 不为新工具名改写历史 toolName、正文或 hash |

CLI 构建输入固定为 [23991457c51b9f1255367a1545be00ef8c1a84bb](https://github.com/yoyooyooo/notion-skills-cli/commit/23991457c51b9f1255367a1545be00ef8c1a84bb)。其独立 tarball SHA256 为 `1c5406ae16946496355c05f04a291610a0daf7c77f3e31b3b7baa19c58faf953`；安装后 CLI SHA256 为 `732f21326c4e9a1c4049fa338f45180ec42d17568f653cdebe59bbc6b9aafa65`，SDK 为 `68bf4e8dc199848f2a1572f297dfc76a51246d23e59064bfa7bdf27ce0a91f1f`。Broker 的再打包会改变 bundle 字节，安装门禁分别记录输入与输出身份，不用 package version 代替 hash。

## 模型正文与宿主证明

默认目录只列名称、描述及可复制入口。普通提交不等待后台目录完成；pending/unavailable 明确显示状态，不能被解释为空目录。显式发现可以等待其所需目录，后续普通轮次使用完成的 Default View。

Pi 的 Notion 条目使用记录本名，来源另列；内部 command token、补全 alias 与精确身份保持。普通本地目录和 OMP 的既有形式不随此显示修正改变。`read.path` 的实际 schema 明确接受本地相对/绝对路径或系统给出的 `skill://` / `sr:` 引用，要求原样复制；资源目录里的名称不应转换成猜测的物理路径。

`notion_use` 是 Pi `model-only` 且默认激活的工具。它直接向模型返回根和完整 Requires；Code mode 内部无法调用它来提前发布 use 状态。Code mode 内部执行原生 read 后，如果外层未打印正文或只打印片段，不能据内部成功确认完整正文已送达或成为 active。

原始作者正文不裁切。宿主保存 owner、scope、pin、manifest 和交付证明，模型投影使用会话短引用。通过 `$` 选择的 Notion 主文不再附带物理缓存目录；其支持文件列出可复制的精确资源引用，后续读取延续相同绑定。恢复或无法建立短引用时保留 canonical 引用。

Router 的 Members 是待选择目录。通用指引要求按任务选择 Member，检查时 read、采用指令时 use。此指引不点名某个验收答案，也不代替真实模型选路验收。

`read`/`consume` 在发现作者的新内容时可能进行既有 Records retention/adoption。默认 SDK 并不将整个操作变成无副作用读取；实际写权限、操作状态及写入成本继续沿 core 合同记录。已验证未变路径的零常规写回要求不因此放宽。

## 已保留的失败与修复

| 观察 | 根因与改动 | 证据边界 |
| --- | --- | --- |
| 旧验证驱动固定 skill_prepare/search 名称 | 当前 Pi 驱动迁为 notion_list/notion_use/read，旧名仅用于显式历史 trace | 真实模型结果仍由当前产物独立运行 |
| custom command 目录可能只取得第一页 | 验证 cursor、scope、观察时刻、库/View/身份稳定性并获取后续页；重复游标、缺页、变化与预算失败显式终结 | 兼容来源证据不冒充默认 SDK |
| `$` 包装暴露缓存目录，实际模型随后尝试读目录 | 移除模型侧物理目录，展示已验证支持文件的短引用/canonical ref | 原失败完整保留；单元测试实际沿包装给出的引用续读相同资源 |
| 实际 Pi 已送达 filesystem 来源正文却在确认时报错 | 发现层的 `source: local` 与回执只接受 filesystem 不一致；回执支持真实 local 值并保留历史 filesystem | 不接管 Pi 原生本地 Skill；真实安装复测另记 |
| 初次真实 Gate A 读取 Pi 帮助、目录并生成泛化方案，未选择所需 Member | 保留原 prompt/model/oracle，不将完整根正文送达等同于任务完成；修正包装和通用 Router 指引 | 原次 Gate A 明确失败，不执行其泛化产物 |
| b401 的真实 Gate B 已收到完整资源短引用，仍反复猜测 Pi 安装路径；实际 read.path schema 仅描述文件路径 | 修正 scalar schema 的两处参数说明，保留 native 执行与资源批读；默认目录显示记录本名及来源 | 说明缺口有原始 provider 请求证明，但尚不能证明它是模型失败的唯一原因；A/B 原失败不改判 |

## 验证接线与实际证据

继续使用仓库原有的 [Broker 验证 Skill](https://github.com/yoyooyooo/pi-context-broker/tree/main/.agents/skills/verify-context-broker) 与 [跨仓验证 Skill](https://github.com/yoyooyooo/pi-context-broker/tree/main/.agents/skills/verify-notion-skills-integration)。消费专项进入 `check:broker`，CI/publish 显式构建固定 CLI 输入并安装 Pi 1.4.0。SDK 缺出口、错误输入包和强制将 use 暴露给 Code mode 的反例不能通过门禁。

下列证据已经取得；每项保留自己的产物边界，不能合并测试数量为覆盖率，也不能把旧切片百分比相加：

- CLI C3：受影响 Bun 305 项、Node 恢复 87 项、另外选定的模式恢复 6 项、独立 SDK 20 项及 package smoke 43 项通过；候选源码清单格式和 typecheck 通过。C1 远端 CI 的格式失败另保留，未执行的 tests/build 不算通过。
- Broker 源码消费专项：166 项、1683 断言通过，包含实际 local 来源发现、加载、交付确认和恢复；typecheck 通过。日志 `/private/tmp/ah627-consumption-after-i4jrplvo/test.log`，SHA256 `fa48141191afee128e5fe0cf086eaf3c667b2f004c01201ca2f6b118f4c54198`。
- 独立 Pi、受控 provider、已种入的离线 source fixture：Default View 的 pending → 显式发现 → 后续 ready；Code mode 未打印/截断正文的负例；原生读取、批量和单资源；`$` 包装。零 HTTP 是该离线 fixture 的结果，不是冷 Notion 成本。
- 独立 Pi 的既有 graph driver 覆盖 metadata/use/inspect/native-chain/cold-pin；session driver 覆盖冷 A、保留 A、新 B、恢复 A、inspect、refresh、恢复 B。它们验证宿主行为和版本，不等于真实模型判断质量。
- 更新后的 SDK/Pi Skill 由独立执行者实际运行 `$` 场景，并完成 evidence → cleanup → evidence；根与 Requires 各出现一次，未选 Member 不读正文。证据位于 `~/Library/Logs/pi-context-broker/AH-617-20261105/new-package-wrapper-f0m97z28/evidence`，原件 hash 在 cleanup 后保持。该场景未执行模型自主选择和资源续读，后两项另验。

只观察的 SDK metrics 不包含正文或凭据。需要核对真实交付的私有验证驱动显式订阅同一调用 ID 的 `context-broker.notion-sdk-result`，核对实际 source bytes、绑定和 provider 正文跨度。工具 details、内部成功和同名记录均不能替代这些事实。

## 剩余验收与正式收口

后续 SC04 切片已修正精确引用被无关目录故障全局阻断的问题。明确 canonical/短引用继续通过既有精确 lookup 和 core；目录发现仍报告原错误，已选来源的阻断错误在正文准备前返回。没有新增 resolver、持久层或全局授权豁免，冷态 lookup 的实际元数据请求仍计成本。

原失败保留在 `/private/tmp/ah621-exact-ref-before-xr3s0bue` 与 `/private/tmp/ah621-use-before-to8bsvy_`；修复后两组原 host harness 共 33 项、374 断言通过，日志 `/private/tmp/ah621-exact-ref-after-yfatqb01/test.log`，SHA256 `010869151ba556f496c771fc3708edca2097fcfebfa76cbfccef3681b2720a2d`。此增量不在已有 `b40126dc5ce2` 安装包内，必须随下一固定候选实际复验；不能据源码通过宣称 SC04 全部完成。

该增量的完整消费专项为 169 项、1696 断言，全部通过；typecheck 通过。结果清单 `/private/tmp/ah621-final-hhybqs7g/results.json`，消费日志 SHA256 `6b6bb5dcd69c6e3125be3f226b5748e4900032ed0ef9047c4d9b3ed17be90c00`。

目录名称与 scalar schema 的 fail-before 为 `/private/tmp/ah623-read-schema-before-6jchna24`（12 通过、2 失败，日志 SHA256 `3fa694b09a07cfd0d92c7d03257e1c4d2aedaa1b55a55d8fe0117a808e2ae94d`）。修复后定向 14 项、完整消费 171 项及 typecheck 通过，结果 `/private/tmp/ah623-read-schema-after-a__ygb4y/results.json`。对应真实失败原件位于 `~/Library/Logs/pi-context-broker/AH-617-20261105/graph-sdk-driver-283ltczo/candidate-b40126dc5ce2/evidence/graph-model-B-8Dpc5G`。新说明和名称必须在下一独立候选检查实际 provider 请求，再运行明确登记的模型样本；旧 b401 证据不承担这一增量的安装验收。

基础 input-guard 随后发现：既无候选也无独立 lookup 时，SC04 增量把目录 RATE_LIMITED 错报为 SOURCE_REFERENCE_MISSING。原失败日志 `/private/tmp/ah676-linux-cleanup-ik_qz75_/input-guard.log`（SHA256 `fa94e05b335c649a27f87b0a8c4759dbe2dabb2a50b773f3dbf41f7183433f75`）保留；该分支恢复准确原错误，已找到 exact owner 的正例不受影响。原 input-guard 实跑通过（`/private/tmp/ah621-unresolved-after-pm7x6mp8/input-guard.log`，SHA256 `0b1f1ded737249250faf1b2020a1ca5559064bf2810d70ad4723a0504dde8cd5`）；最终 typecheck 与 171 项消费测试通过，`/private/tmp/ah623-final-90xajqe1/results.json`。

继续检查完整生命周期下的权限、取消、预算和缓存隔离。已有成功样本不能补齐尚未运行的样本。

正式顺序保持 SC23 调用者迁移 → SC22 独立固定候选及 pro/mini → SC20 同条件全任务和纯本地全局 Skill 成本矩阵 → SC21 真实模型 A/B/C/D → SC24 日用切换。最终候选的文件身份、真实 Notion/模型账本和日用指针通过各自实际回执写回 Linear。当前记录不宣称这些后续门槛完成，不改用户日用安装，不构建或切换 Tern。
