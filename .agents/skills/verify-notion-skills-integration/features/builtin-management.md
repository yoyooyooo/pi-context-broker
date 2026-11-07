# 随包 Skill 发现与消费

Broker 与 Tern 分发三份完整的本地 Skill，经普通发现、选择与加载链路消费。它们不依赖 Notion 认证、全局 CLI 或中央安装回执。

| ID | 用户动作 | 必须观察的结果 |
| --- | --- | --- |
| NS-BUILTIN-01 | 冷安装并启用 Notion source 后输入 `$`，选择 `$ntn-skills@builtin` | 出现精确内建身份；选择只改草稿；提交加载完整正文 |
| NS-BUILTIN-02 | 启用 Notion source 后选择 `$ntn-skills-maintain@builtin` 或 `$ntn-skills-sync@builtin` | 正文及相对 references 可读取；操作指引对应实际安装 CLI |
| NS-BUILTIN-03 | 配置同名本地/Notion Skill | 每个来源有独立身份；`@builtin` 指向包内内容，精确选择不串源 |
| NS-BUILTIN-04 | 零 Notion source、禁用 Notion source、仅启用 filesystem source，再启用尚未连通的 Notion source，之后配置多个 source | 前三种不出现三条 `@builtin` 补全，普通 local/filesystem 候选保留；已启用 Notion 即使连接不可用也出现 builtin，包内资源可离线读取；多来源保留各自 command/database，不隐式选首项 |
| NS-BUILTIN-05 | 独立 npm 和 Tern 归档 | 三份正文和完整资源相同；不借用 checkout 或旧中央目录；升级包后新会话消费新版本 |
| NS-BUILTIN-06 | Pi 普通消费工具与 `bash` 已启用，由 `tool_search` 按需发现管理工具 | 当前 provider 指引给出 maintain/sync builtin 路由与启用的 source IDs；先发现 `notion_ctl`，再取得指定 `cli_source` 的命令范围。初始输入不包含管理 schema 或机器命令；没有 shell/发现能力时不宣称该路由可用 |
| NS-BUILTIN-07 | 作者经 `notion_ctl({cli_source})` 取得真实前缀，由 `bash` 执行 `update --enabled true/false` | 只有 exact source、原始操作身份与 verified/applied 的 `Enabled` 回执触发对应来源的下一次目录刷新；dry-run、unchanged、unknown、非法字段或 Enabled 类型不触发。已加载 pin 不变 |
| NS-BUILTIN-08 | 默认 bundled source 的作者使用单个 `cd ABS && node relativeEntry ...` 并保留完整 JSON | 实际 cwd/entry 与返回的内置命令身份吻合后，仍由原 verified receipt 决定对应来源刷新；额外复合命令、wrapper、重定向、自定义 prefix、错入口或不完整回执不触发 |
| NS-BUILTIN-09 | 同一 Pi 会话 verified 写入后立即 `notion_list`，并继续读取原 fixed ref | 宿主当前 metadata 按需刷新，并发读者共享获取，旧请求不能重新发布旧目录；active preparation 和固定内容保留，固定读取仍校验来源，且不把旧条目重新放回当前目录 |

## 执行路线

先构建本次 CLI/Broker。跨仓本地候选可以用 `NTN_SKILLS_BUILD_ENTRY` 绑定完整的已安装本地 CLI 包；发布依赖规则由 release 路径单独执行。逻辑回归使用既有 `bundled-builtins.test.ts`、`accepted-selections.test.ts`、smoke 与 completion 检查；独立包按本次宿主选择 `distribution-pi` 或 `distribution`，宿主消费和 UI 使用现有 source/editor/Pi PTY 或三 surface 路线。

NS-BUILTIN-06 复用 `skill-guidance.test.ts` 与原 installed `notion-sdk-pi.mjs --scenario scoped-command`。前者验证 deferred → 已发现 → shell/发现能力移除时，指引随实际能力更新且历史不变；后者保留真实 Pi 的三轮 provider 输入、tool_search 和指定 source 回执。管理 schema 仍按需加载；不能以受控 provider 主动发出的正确工具名证明自然任务已有入口指引。实际作者操作另用当前授权的 owned 内容与原操作验收。

NS-BUILTIN-07 复用 `shared-notion-adapter.test.ts` 的原 tool-call/tool-result observer 回归：新增启用、停用两个回执反例先证明旧字段白名单漏掉 `Enabled`，再与既有来源范围、操作身份及无效回执回归一起通过。`notion_ctl` 返回调用前缀和 database 范围，不执行 CLI，也不按子命令筛掉 `adopt` 或 `read --authoring`。`adopt` 保持 disabled，消费目录在 verified enable 后更新；安装态自然作者任务另保留实际工具调用与目录观察，不以单元回归替代。

Pi 的 `cli_source` 按需结果另含 `write_guidance`：使用返回前缀和明确参数组成单条字面 bash 命令，保留完整 JSON；变量、wrapper、管道或重定向不属于自动失效 observer 的可归属调用。原因是目录刷新依赖宿主实际交付的完整写入回执，并非监听任意子进程 stdout。原 `skill-guidance.test.ts` 与 installed scoped-command validator 核对该字段逐字进入结果，同时确认默认每轮指引不加入这些命令细节；完整回执条件保持不变。

NS-BUILTIN-08 来自 2026-11-07 的 Pro v5 真实失败：作者已保留完整 JSON，但使用开头 `cd ABS &&` 加相对内置入口，三次 `notion_list` 的计数为 `[1,1,1]`，未达到启停应有的 `[1,0,1]`。两次写入 verified、最终 Enabled=true、Pi 自然 EOF，均不改变目录观察失败的判断；原 run 与独立语义失败回执分别保留在本轮 owned evidence 中。新增 `cli-write-invalidation.test.ts` 先复现无 dirty 通知，再验证这个有界形式、引号/转义、实际路径和错误回执。仅默认内置 source 支持此形式，Node executable 逐字匹配；cwd 和 entry 的独立 `..` 段拒绝，其他 CLI 参数不作路径推断。自定义 command 继续保留原直接调用规则。源回归与真实模型目录启停验收分别记录，不以 parser 通过替代实际 `[1,0,1]`。

NS-BUILTIN-09 的 v6 真实作者仍为 failed `[1,1,1]`，即使已经使用完整字面命令和 JSON；对实际回执在同一已安装 observer 的本地 replay 证明两次都各触发一次 `changed(["notion"])`。缺口在下游 host metadata：旧 `notion_list` 只等待既有 readiness、继续读取旧目录。v7 将该通知接到 metadata-only lazy 失效，不取消 active preparation 或清空固定内容；metadata 代际约束覆盖正常目录发布、named/exact lookup 和 graph commit。明确 snapshot 的 retained owner 只辅助固定解析，仍通过原 source/SDK 校验，也不成为当前目录项。完整 writer→list 回归先 RED 后 GREEN，host/native/session 80/80、869 断言与 typecheck 通过；并发单次获取、旧请求晚到、fixed Requires、权限拒绝和 active preparation 均在该受影响小集内。

2026-11-07 08:39–08:41 UTC，正常 HOME、无 source/extension/model/tools override 的 v7 真实作者续验通过。对精确 owned Skill 的实际顺序为 `notion_list=1 → verified Enabled=false → notion_list=0 → verified Enabled=true → notion_list=1`；三次查询 coverage exhaustive=true、failures=[]，两次回执只改变 `Enabled`，page 均为 `4115636c-236e-8182-a4f8-c222ac1368b5`。`evidence/pi-author-v7/result.json` 的 status/task_status 为 passed、graceful_eof=true，owned Pi 已 close；SHA256 为 `bb5db31af76e1b10f3f0f2320d053773b31d5d0b077b7cb961743baea25bd928`，完整证据根见[安装实录](installed-consumption.md#2026-11-07-本机候选与-normal-pi-实录)。这份成功不改判 v5/v6 的失败。

fresh session 的 `pi-consumer-v7` 实际完成主文检查与两 reference 各两次 `sr:R` 读取，身份和原始输出 hash 相同，但未调用预期的 `notion_use`，原任务保持 failed；其额外 unfixed 读取及两次 CLI `--refresh` 也保留，不能据此声称最小成本。08:46–08:47 UTC 的独立 `pi-activation-v7` 则实际执行 `notion_list → notion_use(purpose=use, status=ready) → 两资源各 read 两次`，6次工具调用全部成功，最终包含两份 reference 的验收短语，正常 EOF。输入的资源 URI 带 File ID 而未带 snapshot，实际 `contextBrokerResource` 回执全部绑定到已激活图的相同 owner/scope/snapshot/version。功能 `task_status=passed`；整体仍是 `task_passed_observation_partial`，独立 fetch observer 未覆盖 SDK transport 且有一个 preload 日志无完整终态，未捕获 provider context，不能量化 wire/body 抑制。原结果和独立身份核对分别为 `evidence/pi-activation-v7/result.json` 与 `evidence/activation-v7-identity.json`；详细路径/hash/账本见安装实录。

分别检查 Pi terminal、OMP terminal、OMP native GUI 的候选、接受草稿、完整正文和资源。Tern 手动 picker 插入完整身份 token；宿主自动补全在接受事件记录精确身份。正文、资源、CLI 指引、多来源隔离和实际模型使用分别报告，不以候选出现代替正文消费。

维护任务由普通 Agent 加载内建 Skill 后执行 public CLI：当前读取 → pinned apply；首次 connect → 后续 run。真实 Notion 验证使用本次有归属的内容与原操作，核对内容、恢复和冲突；不要求日常用户执行额外证明步骤。

`/ntn-skills` 父子命令、管理/schema palette、专用 save 工作流和中央安装管理 runner 已移除。CLI 的显式 `ctl builtin install/update` 仍用于用户主动管理的本地副本，其验证归 CLI 仓库；不再是 Broker 安装或发现的前置条件。
