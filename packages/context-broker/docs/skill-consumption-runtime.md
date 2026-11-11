# Pi Skill 消费运行时：SDK、短引用与有效指令

## 当前入口合同：agent-cli-ref-20261105

本次调用者对照、已保留失败及分层验证见[新消费入口迁移记录](notion-consumption-contract-2026-11-05.md)。

Pi 注册 `notion_list({query?, source?, limit?, cursor?})`、`notion_use({ref, refresh?, readOnly?})` 和原生 `read`。list 只返回候选元数据，`count`/`has_more` 表示当前查询分页，`coverage` 单独报告来源完整性；未知覆盖为 null，不把空页解释为完整空目录。`ref` 可为一个返回引用或一起需要的多个根。use 一次准备根与完整 Requires，read 只检查主文或精确资源，未选 Members 不读正文。普通本地 Skill 保留 Pi 原生路径。

默认来源的完整目录与 Default View 都通过随包 `listCatalog` SDK 复用 core 查询和缓存，不启动目录 CLI，也不新增 Broker 缓存权威。显式 `source.command` 继续使用旧 CLI 合同及其派生目录缓存；管理命令、OMP 和其他明确兼容路径分别计量。不能据此宣称整个会话没有子进程或网络。

`notion_use` 使用 Pi 的 `exposure: model-only`、`defaultActive: true`，只允许模型顶层调用。`notion_ctl` 为 `deferred`、默认不激活，按需导出固定 canonical ref 或显式 CLI source。旧 `skill_prepare` 会话回执仍按原验证规则读取，历史 toolName 和正文不重写。内部返回、摘要、截断和只落盘不形成完整外层交付；正式边界仍由实际 provider 的完整正文和有效证明决定。

被动 `context-broker.notion-sdk` 观察目录/正文操作及安全请求指标；私有验证驱动可显式订阅 `context-broker.notion-sdk-result` 取得同一调用 ID 的实际返回值。默认运行不订阅原文结果，metrics 不含凭据或正文。现有消费专项包含新工具、分页/覆盖、旧版本回执和 SDK 缺导出反例；安装态、真实 Notion/模型与双机验收另留每次产物身份，以下历史结果不自动升级为新合同结果。

## 消费效果与严格只读

当前消费可能将原生编辑后的内容保存为不可变历史。version-1 `effects` 是这次操作的结果：`remote_writes` 为 `none`、`retained` 或 `unknown`，`author_content` 为 `unchanged` 或 `unknown`；`retention` 列出 Skill page、File、operation 及 confirmed/unknown 状态。它不是已选快照的历史写入清单，也不由 HTTP200、缓存命中或自然语言自述推导。

`notion_use` 在结构化内容中返回 effects，标量原生 read 在完整原文后追加 `<notion-effects>`，Pi `$`/native 注入在同轮添加独立效果文本并保留到原生历史。主文 v3 和资源 v2 回执只覆盖原始内容 span；目录去重和资源去重保留效果文本。多来源部分失败、取消或丢失 ACK 继续披露先前已观察效果与未知状态。旧生产者缺少回执时不能称零写。

`readOnly:true` 传给现有 CLI 请求层的语义写拦截，CLI 对应 `--read-only`。需要留存时以 `SHARED_OBSERVATION_REQUIRED` 在首个写前拒绝；内部不允许的写以 `NOTION_READ_ONLY` 失败。固定或已有留存的内容可返回 none。随包 SDK 与构建 manifest 均须声明消费效果 version 1，否则严格请求在调用前失败；显式 source.command 接收同一 CLI flag，旧命令不支持时显式失败。标量参数不改变原生本地读取、图片、分页或批量固定资源的原有合同。

有限模型、故意破坏的反例及源码对应见 [RetentionDisclosure](https://github.com/yoyooyooo/pi-context-broker/blob/4fde322f94e3b74f400f18fa46e4aa5ebf4f6a97/verification/models/consumer-observations/flows/README.md)。它检查效果披露和只读写边界，不证明任意 LLM 最终回答，也不将模型结果替代真实 Notion/Pi 的 Session、payload 和 HTTP 审计。

## 以下为此前产物的历史实现与证据

本记录承接 [AH-617](https://linear.app/yoyooyooo/issue/AH-617)，覆盖 SC04 / AH-621、SC08 / AH-627、SC09 / AH-624、SC10 / AH-625 的本轮实现与证据。历史 [启动检查点](skill-consumption-startup-checkpoint.md) 和 [成本基线](skill-consumption-baseline-2026-11-04.md) 的失败原件保留；本页不把受控 provider、状态层或单元测试升级为真实模型验收。

后续 SC05 的能力化指引、显式 CLI 范围与介绍任务回归另见[消费指引记录](skill-consumption-guidance.md)。本页 package-03/04 的结果与原失败保持原有产物边界。

## 已接通的产品路径

Pi 的默认 Notion Skill / Router 准备通过随 Broker 包交付的 `ntn-skills/sdk` 执行一次 `consume`。返回的完整 manifest、主文范围、scope、物理 owner、snapshot、版本、File 绑定和 hash 通过同一个公开消费内核验证，Broker 再核对宿主选中身份并直接物化主文。它不再为每个准备节点启动一次固定 CLI read。固定资源使用同包 SDK `readSkill`，仍核对完整公开回执与实际文件 bytes / SHA。

SDK 与公开 CLI 共用 Effect 的 Notion / Store / Credential / Clock / 调度服务；每次调用有独立 scope、捕获的 env / cwd 和 AbortSignal，不修改 `process.env` 或 `process.cwd()`，也没有新增 daemon 或缓存权威。共享解析器处理 duration；消费内核只执行一次完整结果解码。SDK 不可用、协议或包版本不兼容时明确失败，不暗中换旧 CLI。

发现目录仍使用公开 CLI，因此“准备零子进程”不能写成“整个 Pi 会话零子进程”。显式 `source.command` 保留 prepare + fixed read 的兼容路径；OMP、Prompt 与预算 prefetch 未在本轮迁为 SDK。SDK 的非空批量 `requestedFiles` 仍属于 SC07，不能从资源单读成功推断已经实现。

## 会话分支短引用

| 类型 | 公开形态 | 内部绑定与使用 |
| --- | --- | --- |
| 候选 | `sr:C` 加 22 个随机字符 | canonical 身份、scope、来源与物理 owner；不代表已选版本或已激活 |
| 固定主文 | `sr:S` 加 22 个随机字符 | 完整身份、snapshot、版本、主 File、入口路径和正文 hash |
| 固定资源 | `sr:R` 加 22 个随机字符 | 固定 owner、精确 File / path、bytes / hash；不替代主文 loaded 回执 |

每个短引用为 26 UTF-8 字节。相同兼容绑定复用已有句柄；刷新生成可区分的新 S / R，旧句柄不漂移。目录与 search 发布 C，prepare 与完整原生主文读取发布 S / R。句柄在当前真实 SessionManager 分支追加并读回后才对外可见；resume / fork / rewind / compaction 按祖先历史恢复，兄弟分支的私有句柄不可用。

完整目录按一次同步投影批量规划：每轮从真实分支重放一次，使用本批临时反向索引；有新绑定才追加并统一读回验证，全部命中时不写会话。没有跨调用、跨 await 或按 sessionId 保存的引用缓存。74 个候选的热目录从 148 次分支读取降为 1 次；新批次仍验证所有旧绑定和每一个新返回引用后才显示。

短引用不是授权。每次消费继续经过当前来源授权、完整 scope 与物理身份检查；未知或伪造 `sr:` 明确失败，不猜名字或把它当本地路径。固定旧 pin 的关系不能因 canonical ID 相同而改写为当前 S；未固定的非主文关系也不猜测为候选。作者正文、原始 graph lock 和 source directory 保持不变。

`skill_graph({refs:[...]})` 可导出 S / R 的 canonical 精确证明；跨进程或机器的独立消费者仍需自己的认证与验证。C 不能导出成伪造的固定版本。资源读取成功只表示其准确字节已物化；二进制回执可以正确地为 `delivered_complete_text:false`。

## 输入、取消、active 与 visible

Pi input 阶段同步冻结用户已接受的身份、文本、参数和图片，不在尚无运行信号的阶段等待远端准备。实际准备移至建立 agent signal 后的 context 阶段；失败显式 abort 本轮，避免宿主忽略扩展异常后带 partial 指令请求 provider。原生 `/skill:` 的提前展开只由当前 invocation 的受控回执处理，历史标签或用户伪标签不能取得激活权。

以下状态分别保存、分别验证：

- selected：该分支选中的版本与 Required 图。
- ready / cached / materialized：已验证内容或文件，不等于已经送入 provider。
- visible：本次实际 provider 输入中存在完整且精确匹配的正文跨度。
- active：当前会话启用的 Skill / Router 规则；inspect 不产生 active。

`before_provider_request` 只记录 pending。`after_provider_response` 在同一 invocation / session / generation、信号未取消且实际 2xx 时，确认已准备并完整投递的 active 集。这个事件表示响应 headers 已到达，**不代表响应流完成或模型任务成功**。迟到 headers 不能复活被取消的会话。完整正文通过公开 `sendMessage(triggerTurn:false)` 持久化，不引入下一轮 steering。

普通后续消息保留 active。压缩移除必要正文时，从精确已选版本恢复；同一来源的固定 roots 合为一次 SDK inspect，既不改绑 current，也不重新计算 use 图。恢复成功后的下一条普通消息不重复准备。去重依据 scope、身份、snapshot、hash、编译器和实际完整消息跨度；Prompt 继续按每次显式任务处理。

完整原生主文读取保留源文本作为精确前缀，随后可附 body-free 短引用目录。v3 receipt 明确证明 start=0 的完整正文范围；部分 read、摘要和仅有 hash 都不能充当全文。上下文投影只替换已验证的正文跨度，保留资源目录和原始 toolCallId；历史 JSONL / tool result 不重写。

## 可复跑入口

在 Broker checkout 根运行，先读取各入口 help 和本次 Doctor。证据使用新的绝对目录；不重用失败 run，不将路径例子当作实际文件。

```bash
bun run --cwd packages/context-broker test:consumption
bun run test:verification
node scripts/notion-startup-flow.mjs --help
node scripts/notion-sdk-pi.mjs --help
node packages/context-broker/scripts/session-short-ref-session.mjs --help
```

独立构建使用已冻结、具备 `./sdk` 导出的 ntn-skills npm/tar 包，`NTN_SKILLS_BUILD_ENTRY` 指向该包的 CLI。执行 `bun scripts/build-tern.mjs --target broker --package-out /absolute/new-package`，只构建 Pi 包。构建器校验 CLI / SDK 同一个真实 package root，生成 `ntn-skills-runtime.json`。仓库原有默认构建依赖不具备这个新 SDK，因此本轮显式选择上述源码冻结包；没有发布 npm 新版，也没有替换日用安装。

实际 Node 等价入口：

```bash
node scripts/verify-notion-sdk-installed.mjs \
  --package /absolute/independent/node_modules/pi-context-broker \
  --fixture /absolute/frozen/fixture.json \
  --pi-package /absolute/installed/pi/package.json \
  --out /absolute/new-evidence
```

RPC / PTY 生命周期入口为 `node scripts/notion-startup-flow.mjs run --extension /absolute/candidate/src/index.ts --evidence-root /absolute/new-parent`。实际 SessionManager 的 active 与 short-ref drivers 分别位于 `packages/context-broker/scripts/session-active-session.mjs`、`session-short-ref-session.mjs`；其输入与输出以脚本公开参数为准。状态层成功不能替代 provider 正文证明。

## 本轮冻结产物

| 项目 | 身份 |
| --- | --- |
| CLI SDK 提交 | `6e8031b`，`feat(sdk): share scoped Node consumer runtime with CLI` |
| Broker 实现与热目录修复 | `7e99142`、`5f00dc6`，均已推送 main |
| ntn-skills tar | `ntn-skills-0.1.0.tgz`，SHA256 `38a8a58134b3ecfe3c96e1a17a991a2953652b878b8a8c9674a4b4c8dd74af9d` |
| Broker 当前候选 tar | package-04 `pi-context-broker-0.0.2.tgz`，SHA256 `7ffa678ad049a5d863c1b1dc3135d14d02ec0e5d1469dbff120312d24038e5d2` |
| 完整启动 / 生命周期受测 tar | package-03，SHA256 `3b4056a55bcee73a53c7da473fac5f09e708e9839c2bdda5b57c7a5ac656410a` |
| 原启动对照 / Node 适配 tar | package-02，SHA256 `f0ce9580b3534b15e0ee13069925bd0b92666cc5b1af09731bf22a99a0844698` |
| 执行环境 | Node 24.20.0、Pi 1.4.0；Bun 仅作构建和单元验证 |

本轮私有证据根为 `/Users/yoyo/Library/Logs/ntn-skills/AH-617-20261104/throughput-zqzp5es9`。凭据、完整 provider 内容与私有源数据不提交仓库。

## 已完成的分层证据

| 证据 | 结果 | 实际证明范围 |
| --- | --- | --- |
| `sc10-cli/consumer-06` | 独立 Node / npm 11/11；严格声明检查通过 | SDK 包闭合、CLI 等价、隔离 env / cwd、取消、类型；不依赖另一 checkout |
| `sc10-broker/verify-02` | 9/9 | 一、二、三根共享 Requires 分别只调用一次 SDK；默认准备 CLI 为 0，公开 CLI 对照分别为 3/4/5；正文、版本、文件和 graph lock 全等 |
| `sc10-pi/run-04` | package-04 真实安装 Pi 3/3 | `$`、原生主文/资源、search→C→三根 prepare；共 3 consume + 1 read、6 个目录 CLI、prepare/read/export CLI 为 0、10 次受控 provider 请求 |
| `sc04/session-short-ref-gsOpGg` | 13 项状态检查 + 5 个独立 Node resume 通过 | 实际 SessionManager 的分支映射、旧 pin、刷新、导出、压缩与续接；不是模型验收 |
| `sc08-sc09/session-active-session-M3D6Um` | 14/14 | 实际分支 active、固定 A/B、失败刷新、fork / rewind / compaction 和独立进程恢复 |
| `sc08-sc09/broker-notion-startup-evidence-bvNX4Q` | package-03 真实 Pi RPC / PTY 10/10 | 延迟目录、精确失败阻断、RPC abort、Stop、new session、EOF、压缩后固定恢复与迟到 2xx；此前 p6rqyI 原件保留 |
| `sc10-broker/pack-04/consumption.*` | 81/81，565 个断言 | 最终消费专项，包含批量分支、固定引用、active、主文/资源与取消反例；typecheck 通过 |
| `final-verification-01` | 109/109 | 既有规程、被动 SDK/CLI 成本观察器、真实本地 proxy exit 与缺终局反例 |

实际 SDK-Pi 三场景使用受控离线 snapshots / catalog 和受控 provider；SDK / CLI HTTP 均为 0，不能推广为真实冷网络零请求。默认 View 没有 seed，每场景的默认 View 请求明确保留 `CACHE_MISSING`，因此该 run 不证明 native menu/default View。7 字节二进制资源的真实文件 SHA 与公开 owner / File / snapshot 回执一致，未声称完整文本投递。

正式生命周期 run 中，11 份含 Skill 的 provider 输入各有完整 204 字节正文一次，21 份 system context 均无该正文。实际 RPC abort 的 provider 数已从历史失败的 1 修复为 0；新会话与迟到 response 没有发布旧 active。控制源和控制 provider 的标签始终保留。

首次 SDK-Pi run 的 native 断言曾错误要求 RPC 参数暴露缓存绝对路径；修正验证器，确认真实 `sr:R` 与实际文件后新 run 通过。原失败报告未改判。所有 owned scratch 清理使用系统 Trash，保留原始 JSONL、输出和 hash；既有不相关暂存内容保持原样。

组合验证发现 macOS `/tmp` / `/private/tmp` 的同文件别名问题：旧 hook 用路径字符串寻找 pending main receipt，可能漏记已完整读取的正文。现改为在授权、路径和 signal 检查完成后直接绑定本次主文 snapshot；资源分支不取得主文回执，result 仍验证完整 source bytes。显式目录 symlink 反例及当时专项 73/73、513 个断言通过。package-03 相比 package-02 的 53 个 src/dist 文件只有 `host-skills.ts` 这一处运行时代码不同，另有文档变动；默认 SDK-Pi 和生命周期均在 package-03 重新执行。package-04 再改变三个短引用相关源文件及对应 `dist/completion.mjs`，SDK / CLI bundles 全同；重新执行 SDK-Pi 及真实模型对照，没有将 package-03 的 31 样本或生命周期冒称为 package-04 重跑。

## 非阻塞启动的完整对照

package-03 run `sc09-startup-final/skill-startup-EyOpl5` 与旧基线 `startup-baseline/skill-startup-N6Riym` 各有 31 个可核对时序的实际 Pi 样本，受控目录每次延迟 2,000ms。新 run 同时满足新增的 proxy 自退出回执要求；旧 proxy 退出仍为 unknown。warm 是 Broker catalog 已暖但 Pi 新进程，不是同进程暖启动。

| 组 | 样本数 | 旧首请求中位数 ms | 新首请求中位数 ms | 新 p95 ms |
| --- | ---: | ---: | ---: | ---: |
| cold-delay | 5 | 6,948.523 | 396.589 | 不报告，n < 20 |
| cold-failure | 5 | 6,801.322 | 368.183 | 不报告，n < 20 |
| warm-primer | 1 | 单列，不参与 warm 统计 | 606.208 | 不报告 |
| warm-catalog-new-process | 20 | 4,664.270 | 372.046 | 445.824 |

31/31 均在目录完成前进入 provider，正文请求为 0。后台目录工作仍执行并单独计量；新的冷组最后目录完成中位数约 4.80s，暖组约 2.52s。首请求改善不等于目录网络成本归零。p95 使用 nearest-rank；首有效文本取真实 `message_update/text_delta`，不以 `message_end` 代替。前后顺序观测没有随机化，provider capture 回调边界也有公开说明；它证明受控关键路径改善，不代表生产 API 或模型总延迟按同一比例下降。

旧基线 120 个 source child 为 78 次 list 加 42 次 `ctl cache identity`，新 run 的 89 个为 47 次 list 加同样 42 次 identity；全部逐 ID/PID 核对 close。最终新 89/89 次调用均在任务结束后才开始；89 个 proxy 实际 exit 分别为 74 次 code 0、15 次受控 failure list 的 code 1，均在 child close 后、host close 前。宿主关闭中位数仍为 cold 5.09s、failure 5.02s、warm 2.85s，后台成本没有藏入“零等待”。

独立复核验证全部 31 host close、89 child close、89 proxy exit，及 provider request / response hooks。原 package-02 run `skill-startup-Zqt3Gf` 保留：其 proxy 自退出未记录，且原报告的 no-onPayload 文字不准确，独立 review 给出勘误。最终 driver 只增加真实 exit 观察及严格配对，未改变 prompt、provider、source argv、timeout 或 quiet 时序。较早不完整候选 `skill-startup-eSQbSH` 的 timeout 和缺失 close 继续保留，未混入本轮完整样本。

## 真实模型观测及发现的缺口

`sc10-model/skill-model-cost-SCPGN3` 使用 package-03、默认 SDK 配置（完全省略 command）、`magpie/group/flash-free`、原问题“请用一句话回答：12 加 7 等于多少？”，5 个 cold 与 20 个同进程 warm 全部正常 stop 并正确回答。五个进程均闭合；实际为 20 次目录 CLI、95 次 metadata HTTP、SDK 调用与正文 HTTP 均为 0。旧同题基线为 25 次 CLI / 96 次 metadata（含一次 retry）。模型 25 次 HTTP 都收到 200，但 transport 终结回执为 reader failure / errorCode 20；应用层正常结束与 HTTP stream 完成分开报告。

冷首 provider 中位数为 518.755ms，首有效文本 2,357.538ms，任务结束 2,724.594ms。首次 payload 为 46,818 JSON bytes（旧 93,409）；该差值包含目录尚未到达的非阻塞语义，不能称作同一完整目录的纯压缩收益。

这个 run 同时暴露了必须修复的 warm 回退：首 provider 中位数 109.132ms，旧基线 26.459ms。目录在 warm-4 到达，74 个候选首次登记；warm-5 至 20 没有新增 binding，却仍每候选两次完整 branch replay、一次 targetKey 全表扫描及一次全表比较。回退主要发生在 input→agent_start，不能只展示冷启动收益。这份完整 run 原样保留，后续批量投影修复使用同题、同模型、同样本数另行比较。

### 批量投影后的真实对照

package-04 的 `sc10-model-final/skill-model-cost-yN7n0t` 再执行相同的 5 cold + 20 warm。配置只改变安装包 / extension 路径；prompt、模型、工具、样本数、freshness 和 observer 均相同。25/25 正常 stop、回答正确，五个 owned host 与 source 观察闭合，安装 runtime 前后 hash 一致。

| 真实普通任务 | 旧日用基线 | package-03 回退样本 | package-04 |
| --- | ---: | ---: | ---: |
| cold 首 provider 中位数，n=5 | 11,318.941ms | 518.755ms | 602.530ms |
| 同进程 warm 首 provider 中位数，n=20 | 26.459ms | 109.132ms | 23.973ms |
| 同进程 warm 首 provider p95 | 37.802ms | 119.071ms | 30.942ms |

两次 SDK 候选的目录到达时间不同：package-03 为 warm-4，package-04 为 warm-8。因此另取两者均有完整目录的 **warm-8 至 20，共 13 个对应点**：每轮 payload bytes 完全相同（77,439 至 79,323），目录跨度尺寸相同；各有 74 个唯一 canonical candidate、相同 scope / 完整 target 集合、零后续绑定膨胀。13 点首 provider 中位数从 **115.059ms 降至 27.572ms**，每一对都更快；配对节省中位数 86.097ms。n < 20，不给这个子集 p95。

最终 cold 首有效文本中位数为 2,955.905ms、任务结束 3,645.289ms；warm 为 2,159.905ms、2,566.273ms。模型服务延迟与扩展提交开销分开，不把 source-only 或首 provider 时间称为任务总耗时。首次 payload 仍为 46,818 bytes，warm payload 的完整值全部保留。

最终源侧为 20 CLI / 96 metadata HTTP / 0 SDK 正文调用 / 0 body HTTP；第 5 个进程包含一次真实 retry，等待 1,204.321ms。该进程的解码响应总字节为 null，不能以另外四个进程的已知字节补齐。进程结束前的 quiet 只说明已观察操作安静，不等同 metadata producer 的独立终局；真正的 start/close/metrics 与最终 reconciliation 分别保留。

模型侧 25 个 request start/end、25 个 HTTP 200 对应 25 个正常应用 stop；流终局单独为 23 个 failure / code 20、2 个 completed，没有推断 code 20 的成因或将其改写成成功流。实际发送 body 合计 1,585,165 bytes，provider 报告 input 295,794、cacheRead 128,000、output 300、totalTokens 424,094；这些不是 wire bytes 或推算费用。独立审阅核对 257 个原件 / session、所有观察链、runtime、时间、usage 和 payload→sent hash，无差异。

额外真实 Skill 任务 `skill-model-cost-7gd44M` 冻结为“请介绍 $ntn-skills-maintain@notion 的用途和健康检查入口，只解释，不执行。”，有一个 cold 和一次 warm 重复。两次 final 都命中弱答案谓词，但独立语义审阅**不接受为任务成功**：cold 额外执行两条 bash 环境探测，并混淆正文明确的 `ntn-skills ctl doctor` 与 create/write/replace/update 写操作；warm 延续了健康入口的混淆。三个实际 provider 请求均已收到同一 16,288 字节完整正文一次，不能将失败归因于未投递正文。

该 Skill run 有 4 次已观察 CLI、2 次 SDK，33 次已观察 HTTP（30 metadata、3 body），但两条 bash 子孙进程的完整网络与终局未观测，总 HTTP 保持 null，report 保持 incomplete。不能用看似本地的 shell 命令或正确回答子串补造零费用或语义通过；不换模型、不加入答案、不覆盖原 run。这一结果作为 SC07 / SC21 的介绍与执行边界、真实 Agent 回答质量缺口继续跟踪。

两次 SDK 都是 consume：cold 13 次已观察 HTTP，warm 1 次。parent transport observer 另外看到的 14 次非 model 请求与这 14 个 SDK attempts 对应，不能再次加到 source 33 上。正文投递证据来自三个实际 `provider_request`，其 payload hash 分别匹配 transport sent body；并非模型自述已阅读。

### 证据保留与清理

最终启动 run 新旧共 863 个原件 hash 未变。两批 ordinary 的 10 个 session 加失败 Skill 的 1 个 session 已逐字归档，权限 0600；两个 ordinary 各 84 个原始证据文件在既有 evidence→cleanup→evidence 后完全不变，仅新增 cleanup receipt，自有 scratch 已进 Trash。失败 Skill 的 15 个证据文件、原 session 和 scratch 保留原位：两个 unmatched children 的终局未知，未绕过 cleanup 门槛。原回退、失败、unknown 与未执行范围都没有被后来的成功覆盖。

## 后续边界

SC05 的模型投影与机器证明分离、SC06 两种目录的真实自主选路比较、SC07 批量资源消费，以及字段 / 缓存 / Records / 附件 / 文件级迁移仍按各自子票验收。26 字节短引用只证明 locator 缩短，不能单独声称整轮 token 或任务总成本下降。完整 canonical graph lock 目前仍在 prepare 输出中。

本轮独立安装与受控证据不替代 pro / mini 跨机历史恢复、四条正式真实 Agent Gate、默认模型摘要、日用新会话和回滚验收。父票及这些未完成范围继续开放。
