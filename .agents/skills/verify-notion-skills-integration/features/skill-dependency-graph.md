# Skill 依赖图

此地图是现有跨仓验证 Skill 的专项，使用真实 Pi 原生选择和 read。Launch/Doctor/离线 Drive/Evidence/Cleanup 复用 [request-engine](request-engine.md)。不要复制出第三个顶层总验收 Skill；实际模型、RPC、进程、安装和 UI 继续使用仓库既有 helpers。

最终安装包与原 AH-560 场景、模型图场景的复跑入口和验收边界见 [验收索引](../../../../scripts/notion-skill-graph-acceptance.md)。该索引不将旧包或受控结果升级为当前包的真实模型通过。

## Notion 来源字段与原生安装语境（SC06/SC07）

用户入口仍为 `notion_list`、原生 `read` 与 `notion_use`。Notion Default View 决定默认目录；作者原文中的 native-loader/editor 字段（例如 `disable-model-invocation`）描述原生安装语境，不单独改变 Notion 工具报告的可发现性、availability 或权限。按当前用户意图选择 read/use，继续尊重实际 disabled、权限失败和工作流执行授权。保留作者正文及字段；不自动 use，不改变本地 Pi 原生加载或 View 成员，不把原生字段说明推广成忽略作者指令。

定向 Drive 复用现有测试，不新建 parser 或平台：

```bash
bun test packages/context-broker/scripts/notion-consumption-tools.test.ts packages/context-broker/scripts/skill-guidance.test.ts packages/context-broker/scripts/pi-read-adapter.test.ts
bun run --cwd packages/context-broker typecheck
```

正例通过公开 guidance/context hook 与真实工具注册/调用核对：新说明只进入 Notion guidance，作者 frontmatter、原历史、native system/path 原样保留，重复投影不增加说明；Pi list 正确给出可用于 read/use 的 Skill refs。反例保留实际 reported disabled、来源 `ACCESS_DENIED`、未知/不完整 coverage、原生 read 禁用与第三方 read 边界，metadata 不加载正文；这些验证输出范围和既有行为，不是权限机制修复。非 Pi list 文案、list 参数与 use schema 保持，`view-prompt` 通用层未改。

## 两条用户路径

Gate A 只有 Pstack Router 根选择和自然任务，不出现 poteto-mode、目标成员名/ref、答案或叶子资源。Agent 从 Members 的用途和准确 ref 自主选择目标，读取完整主文与 feature-map。不得通过普通 Skill 绕路或把目标改 Requires。

Gate B 只有 poteto-mode 类 Kind=skill 根选择和同一自然任务，不混入 `$Pstack`。真正 Requires 在 use 准备时完成；模型从 Members/正文链接自主读同一能力，不能把普通 Skill 改成 Router。

`frozenPrompt(gate, selection)` 是两条提示的唯一生成器，`baseline` 将完整 text、selection、sha256 写入 `prompts.json`。实际运行先以独立只读目录回执确定根 alias/ref/kind，再传 `--router-selection` / `--ordinary-selection`；默认提示仍须绑定真实根后才能作 Gate 证据。冻结后不因模型失败加入叶子提示或答案。目标身份和 bytes/hash 只保留在私有 oracle，首次 provider 输入不能含其正文。

## 图 feature map

| Feature ID | Issue | 本条证据边界 |
| --- | --- | --- |
| NG-SG-06 | AH-567 | Skill/Router 原生 Members/Requires；同库、已启用、准确身份及分页反例。 |
| NG-SG-07 | AH-568 | 来源刷新不覆盖作者关系、手工删除、附加字段、custom和旧pin。 |
| NG-SG-08 | AH-569 | 原生链接编译准确 Skill/File 引用，不靠名字或外部抓取补齐。 |
| NG-SG-09 | AH-570 | Pstack 生产关系/裸路径的已授权计划与实际 Notion readback。 |
| NG-SG-10 | AH-572 | 无 shell 的原生发现/read 与精确资源消费。 |
| NG-SG-11 | AH-573 | Gate A 全冷、暖与真实会话的真实模型。 |
| NG-SG-12 | AH-571 | use/inspect、required闭包、环/缺失/版本/预算拒绝。 |
| NG-SG-13 | AH-574 | `$`、native、read、多目标共用准备、投递、取消。 |
| NG-SG-14 | AH-576 | Gate B 全冷、暖与真实会话的真实模型。 |
| NG-SG-15 | AH-577 | 实际选择版本向量、A/B、resume/fork/rewind/compaction。 |
| NG-SG-16 | AH-575 | 批量共享metadata/Files/Records，图hash绑定和局部失效。 |
| NG-SG-17 | AH-578 | 完整图固定与空机器精确历史，缺失/损坏拒绝current回退。 |
| NG-SG-18 | AH-580 | 完整清单和本地就绪分别报告，按需物化与完整export。 |
| NG-SG-19 | AH-579 | 默认关闭的预算预取、前台优先、取消、不锁可选版本或扩大授权。 |
| NG-SG-20 | AH-581 | 全矩阵与按缺口选择一个Matt小图，独立安装/UI/故障证据。 |

## Observer 接线合同

独立观察真实动作再组成 version=1 trace。禁止先填期望字段，再令模型按这些字段执行。`contractFixture()` 仅供离线自检，不能作为 live 数据或落入宿主可读路径。

| 字段 | 原始观察来源与检查 |
| --- | --- |
| `gate/host/nativeEntry/prompt/selectedRoots` | 原生选择动作与冻结 prompts；Pi、单根和真实 kind一致。 |
| `isolation.oracleRoots/consumerRoots/prelaunch` | 实际 realpath和启动前inventory，独立oracle与CLI/Broker/session三层；cold全空，重试新目录。 |
| `isolation.localSkillInventory` | 实际宿主Skill/plugin发现清单，记录path/packageId/suite/source及可用hash；改名或隐藏副本也必须排除。 |
| `isolation` 开关 | 禁shell、自动扩展、context files、prompt templates；observer只观察，不把oracle加入provider。 |
| `candidates/directorySequence/requiredRefs` | 根目录和required回执；模型选择前候选正文I/O为零，leaf不得伪装required。 |
| `reads` | 原生模型 tool call 及完整正文回执，包含 origin/tool/ref/logicalId/scope/snapshot/sequence/content/sha256/complete；逐字匹配独立 oracle。主文可来自 Pi 顶层 `notion_use`，须附实际 ref（单个或数组）、public consume/read、graph lock、manifest 和 delivery span 证明；OMP/旧会话仍按 legacy skill_prepare 读取；资源仍须 exact native read。 |
| `providerRequests[].contents` | 实际provider messages中的ref/content，目标/资源不得预置；读取后完整字节进入上下文，每请求最多一份。 |
| `httpLedgerObserved/httpAttempts` | 真实直接HTTP账本；冷需body，暖可空；status或networkError及requestIdAvailable/requestId按实保存。 |
| `model` | selector、真实HTTP状态、非空成功final及stopReason；HTTP200许可/额度文本拒绝。worker须有flash-free失败回执hash。 |
| `processes/unknownWrites/replayedUnknownWrites` | 自有host spawn/close原始事件；unknown不覆盖不重放，读取Gate不得远端写入。 |

私有 oracle 使用 `version/roots/target/resources`：roots记录真实根 kind/selection/ref；target记录稳定logicalId/scope/ref/snapshot、独立bodyBytes/bodySha256，resources逐项记录自己的ref/logicalId/scope/snapshot/bytes/sha256。目标名字、答案token和准确ref只能供观察端比较。refs保留实际目录/工具回执的表达，不从名称拼接；canonical身份与固定版本分别匹配。

```bash
node scripts/verify-skill-graph-contract.mjs evaluate --trace "$TRACE_FILE" --oracle "$PRIVATE_ORACLE_FILE"
```

两份路径必须绝对且不同，文件位于消费侧不可见的外部证据目录。评估器返回 `contract-valid` 与 `productAcceptance:not-inferred`；它不认证JSON来源。审查原始RPC/tool/provider/HTTP/进程 artifacts及其hash后，才能将实际执行的层记通过。不能用自己构造的正例对象或模型自述代替真实链路。

## 证明与保留

自检拒绝oracle暖化、隐藏/改名本地副本、猜名、错误ref/hash/scope/snapshot、强制叶子、错误kind、预置正文、资源缺失、HTTP200许可消息、空final、重复provider正文、缺ledger/进程退出等假阳性。旧 NG-SG-11 / AH-560 模型合同继续先用 `magpie/group/flash-free`，本次实际不可用才用 `magpie/group/worker`，失败原件保留；无可用授权模型标blocked。独立日用模型合同见下一节，不能作为旧样本 fallback 或改判依据。

CLI/source、实际Notion、真实模型、原生UI、安装产物分栏。旧AH-560、受控provider、单纯schema和编译不代替图验收。证据落checkout外，按run追加并校验hash；清理只处理自有scratch/process/fixture，unknown需要的原operation状态不回收。修改实现时同时给上表对应ID补真实命令与观察结果，不把本地图本身当实现完成。

## AH-639 独立日用模型合同

Graph harness 18 在原 A/B 和 C/D 入口显式接受 `modelContract: "daily-route-v1"`、`model: "magpie/group/flash"`、`thinkingLevel: "high"`、`rpcTimeoutMs: 300000` 四项。规范化 `modelProfile` 同时进入 doctor、run、trace、cache fingerprint 和 evaluator；C/D 的冻结 config SHA、manifest、case 与 review 保持同一 profile。未声明新合同仍使用原模型限制和默认超时。新合同拒绝旧 flash-free 失败回执、worker 授权、fallback 和 controller 重抽；旧失败与旧预算不改写。每个冻结场景的样本数和顺序由独立 run config 登记，现有 warm / continued-session 能力保留，不能以早期冷 n=1 关闭完整 SC20 / SC21。

| 边界 | 实际驱动与判据 |
| --- | --- |
| 日用 route | CLI 明确传 `--thinking high`；首 prompt 和恢复前由实际 RPC `get_state` 分别核对 provider、model ID 与 thinking。不得拼接字符串掩盖 provider/model 分界差异，也不要求 Pi 未暴露的 `autoRetryEnabled` 字段。 |
| 请求与响应 | 每个实际 provider hook 的 `reasoning_effort` 必须为 `high`，随后实际 HTTP body 的模型、effort 和 payload hash 必须匹配。逐 request sequence 保留实际 assistant provider/model、`responseModel`、usage 与 stopReason；缺失 route 或 usage 保持未知/失败，不能拿选择器或估算补齐。 |
| 重试与项目 | 每个 owned cwd 的 `.pi/settings.json` 精确写入 `retry.enabled:false`、`retry.maxRetries:0`、`retry.provider.maxRetries:0`；不调用会写全局设置的 `set_auto_retry`。五个应用源文件的 task hash 不变，第六个 runtime 文件另存 bytes/hash。创建、启动/恢复、结束、exercise 和清理前重检 live inventory；默认合同仍拒绝第六个文件，新合同也拒绝字节变化、多余文件及 symlink。清理后的 Evidence 使用下述受绑定的保留原件。 |
| 来源隔离 | 新 daily 的 metadata selection、真实任务和补充 retained-source collector 均显式使用对应 owned `NTN_SKILLS_SCHEDULER_ROOT`，不继承日用调度状态；已有冷/暖缓存与来源账本条件继续生效。 |
| 判定与旧样本 | 新 route 不放宽完整正文、Requires、未选 Members、固定版本、权限、取消、历史恢复和语义判据。模型错误 ref 即使到达产品错误边界仍是失败；旧 C9 A/B/C 和 free 的失败原件不覆盖。 |

```bash
node --test scripts/verify-skill-graph-contract.test.mjs scripts/notion-skill-graph-model.test.mjs scripts/notion-model-cache.test.mjs scripts/notion-skill-graph-project.test.mjs
```

清理前保存精确 `daily-runtime-settings.json`，并让 cleanup 回执绑定原 result、project、ownership、profile 与该原件 hash。仅当整个 owned scratch 已不存在且绑定完全匹配时，Evidence 才改用保留材料。活 scratch 中缺失项目、伪 cleanup 标记、原件变更或 ownership 不符都必须失败。系统 Trash 集成要求真实可执行能力；其他平台如实记录 not_run，不能用永久删除或替代 shim 冒充。

### 实际 provider 的 system / developer 指令消息

原 graph observer 和 metadata HTTP 复核须从实际 payload 的顶层 `system` 以及 `messages` 中的 `system` / `developer` 消息读取目录与描述复用依据。Pi 日用 reasoning serializer 可以使用 `developer` 承载同一系统提示；`before_agent_start` 或内部 context 不能代替实际 provider 内容。普通 user、assistant、tool 文本仍不算默认目录；消息 role、正文、工具参数、model/effort 和最终 wire 都不得由观察器改写。内部 `context_with_system` 的系统段处理保留原宿主类型语义。

### 普通 daily D 的共享技术失败停止

原 `--intent-config ... --intent-case D-early` 在显式 `daily-route-v1` 下，遇到来源账本不完整、observer 错误/未验证 provider 输入、宿主关闭失败或 `MODEL_STATE` / `MODEL_ROUTE_EVIDENCE` 时，保留当次结果与成本并停止后续 case。共同判定不读取 ready 实验的 `directorySetup`；原 ready 专项仍额外检查目录、成本与 arm wall。daily 的 `hostFinality` 和 `modelContractFailure` 独立保存，后续通用任务断言不能擦掉原技术原因。剩余未提交 turns/cases 明确为 `not_run`，只在实际发现失败后停止，不倒写此前已经发生的提交。

普通内容/意图断言失败不因此成为共享技术故障：该 case 的依赖续问停止，后续独立 D 场景继续。正文缺失或普通超时本身也不证明共享故障；若同时存在上述来源/观察器/宿主/模型合同失效，按其独立证据判定。旧缺省模型路径保留原继续/availability 停止规则；普通 daily 仍只有原每提交 300000 ms 和固定样本数，不套用 ready 的 1200000 ms 整臂 wall，也不把 scheduled 总和改称 hard wall。原 prompt、四场配置、selector、预算、私有 oracle、真实模型失败均不改动。

`scripts/notion-model-cache.test.mjs` 直接驱动原 `runIntentCases` 函数的循环和实际结果文件保存，只替换本地 RPC/来源边界；分别注入 source、observer、host-finality、model-state、model-route 故障，核后续 prompt 未提交、not_run 原因、成本原行保留，并覆盖内容失败继续与 legacy/ready 原行为。此为离线控制流验证，未启动真实 Pi、Notion 或 provider，不是新的模型任务成功证据。复跑原组：`node --test scripts/notion-model-cache.test.mjs`。

## SC21 C/D 普通意图与介绍

`scripts/verify-pi-notion-model-cache.mjs --intent-config` 复用本 Skill 的 graph observer、RPC、SDK source ledger、完整正文与资源证明、生成文件检查及 owned exercise。旧 A/B 和旧 custom cache 矩阵保持原入口；此分支不新建总 runner。冻结配置绑定独立安装包、runtime、实际 Pi、全部参与的 harness、生产 Default View 元数据和私有正文 oracle。原早期反馈为四个独立冷入口各 n=1，最多三次必要续问，每次 300000 ms，仅 `magpie/group/flash-free`，无 fallback、自动重试或失败后续问。显式 `daily-route-v1` 是另行冻结的模型输入，不改变这些原任务、预算和 prerequisite 断言。

| 入口 | 实际动作和成功条件 |
| --- | --- |
| C `$poteto-mode@notion 介绍下 create-verification-skill` | 显式根和完整 Requires 在首次 provider 中各一份；目标由 native `read` inspect 后完整进入 provider，不能激活目标工作流。普通续问复用原交付；明确再次读取必须有该 turn 自己的真实完整 read 回执，不强制已有固定正文重新访问来源。 |
| D 普通命名介绍 | 原句不含 `$`。可从实际目录或 `notion_list` 选择，也可对实际 provider 已收到的冻结用户原句中的完整字面名称直接尝试 current 主文 `read`；后者先保存未绑定声明，再由本次完整普通目录和真实 read/inspect consume 唯一绑定来源与正文。observer 不预植私有目标；介绍读正文、不 use 执行工作流。独立重启后恢复同一实际 session 的续问必须复用已交付内容。 |
| D 自然任务 | 原句不含目标名、准确 ref 或答案。模型实际读项目、自主选择并 use，根与 Requires 完整交付；最终输出须包含路径明确、内容完整的验证 Skill 文件。原生成物 helper 保存文件并单列执行其中一个允许的 owned 应用验证命令；仅计划或模型声称已验证不通过。 |
| D 闲聊 | 有相关非空回答，Skill/资源正文和激活均为零；允许目录在后台运行，不阻塞首 provider。只有完整 source observer 起止、逐 HTTP attempt、EOF 和 host close 齐备后才能报告成本。 |

四个入口均使用真实生产默认名单，source 省略 `command`、`default_view_id`、`profile_id`，`prefetch:false`；不得换成 A/B root-only View 或删减可选项。冷首轮 `pending` 合法，后续普通 turn 必须验证 ready 的完整 owner/name/description 集合。D 初始 observer 的发现集合为空；已披露 owner 的名称选择与用户原句的未绑定名称尝试分别留证。后者不要求等待默认目录 ready，也不能预先取得私有 oracle 的 owner。私有 oracle 和介绍事实不进入提示、guidance 或 consumer cache。冷启动原生 `/skill` 菜单的宿主边界单列，不作 C/D 就绪条件。

目录观察须将实际 provider XML 与同 scope 的 SDK 元数据逐字绑定。只解码产品编码的一层实体，最后解码 `&amp;`，使作者的字面 `&quot;`（传输为 `&amp;quot;`）仍为字面文本；描述首尾空白和换行也属于作者数据，不能在提取时删掉。名称、描述、owner、scope 任一不符仍拒绝，不能用名称近似匹配或减少 74 项全集断言消除空归属。

`$` 完整正文中的 canonical Members 行可作为同一实际 provider 内的描述依据。原 graph observer 与 SDK Pi driver 共用 `skill-preparation-evidence.mjs` 的 native receipt／span／字节／hash／六字段卡片校验；graph 的来源仍由现有 materialized manifest 与实际 SDK read/preparation 证明。相同正文可属于不同 owner 或 pin，因此还须将该 delivery span 绑定到同一 user 文本中的真实 wrapper ref，复用原 native／short-ref parser，不能仅凭 `provider.contents` 的全文命中认领身份。Default 名称、准确入口与完整 root／Requires 不省略，未选 Members 不读取正文。

首轮从原 `context_with_system` 的 custom message 观察 receipt；恢复轮仅从当前 `buildSessionProjection().entries` 观察有效 receipt，不回退扫描整个历史。receipt 保留在原 `system-context.nativeInjection`，与下一实际 provider 的 PID、session、leaf、事件顺序一对一绑定并消费一次；完整 user 内容及 span 必须匹配。`provider-request.nativeInjection` 只记录关联，机器 proof 或合成正文不加入 provider／wire。缺 receipt、摘要／截断、旧分支、未来 merged-user hash、重复 receipt／user、错误 source／scope／owner／pin／version／正文或 canonical card 均不支持省略；两个合法来源即使正文相同，也不能跨 wrapper 借用。

定向入口为 `node --test --test-name-pattern 'native Members description' scripts/notion-skill-graph-model.test.mjs`。完整受影响回归沿用原 graph、shared evidence 与 SDK Pi tests，检查首轮与恢复轮的实际正文归属；验证器通过不证明真实模型已自主选路。

~~~bash
node --test scripts/notion-skill-graph-model.test.mjs scripts/notion-model-cache.test.mjs scripts/notion-skill-graph-delivery.test.mjs scripts/notion-skill-graph-host-index.test.mjs
~~~

~~~bash
node scripts/verify-pi-notion-model-cache.mjs --intent-config /absolute/frozen-cd-config.json --intent-action doctor
node scripts/verify-pi-notion-model-cache.mjs --intent-config /absolute/frozen-cd-config.json --intent-action run
node scripts/verify-pi-notion-model-cache.mjs --intent-config /absolute/frozen-cd-config.json --intent-action review --intent-evidence /absolute/pi-intent-evidence --intent-review /absolute/independent-review.json
node scripts/notion-skill-graph-model.mjs evidence --evidence /absolute/pi-intent-evidence/C-introduce
node scripts/notion-skill-graph-model.mjs cleanup --evidence /absolute/pi-intent-evidence/C-introduce
node scripts/notion-skill-graph-model.mjs evidence --evidence /absolute/pi-intent-evidence/C-introduce
~~~

已授权的定向早期反馈可用同一入口显式传 `--intent-case C-introduce` 或 `--intent-case D-early`；省略该参数仍执行原四场。选择前仍完整校验原四场配置、全部 prompt hash、来源和总预算，不删除未选配置来缩小合同。Doctor、manifest 和每场 evidence 都保存 `executionScope`。C 为一首轮加至多两条原有条件续问，最多 3 次 / 900000 ms；另外三场 D 标为 `not_run`。D-early 固定原三个 D，保留命名介绍的一条重启恢复条件续问，最多 4 次 / 1200000 ms；C 标为 `not_run`，不再次提交。未选原因均为 `not_selected_for_early_feedback`。两种选择均保持每次 300000 ms、零自动重试和 fallback；技术通过仍需原独立语义审阅，全部所选场景通过的总状态为 `partial`，不能成为四场通过或正式 SC21 验收。Doctor、run、review 必须重复同一显式选择，旧四场证据和失败保持原样。D 自然任务保留原只输出完整方案的提示；生成文件检查和后续 owned exercise 仍由控制器执行并单列，不改为要求模型执行项目。

~~~bash
node scripts/verify-pi-notion-model-cache.mjs --intent-config /absolute/frozen-cd-config.json --intent-case C-introduce --intent-action doctor
node scripts/verify-pi-notion-model-cache.mjs --intent-config /absolute/frozen-cd-config.json --intent-case C-introduce --intent-action run
node scripts/verify-pi-notion-model-cache.mjs --intent-config /absolute/frozen-cd-config.json --intent-case C-introduce --intent-action review --intent-evidence /absolute/pi-intent-evidence --intent-review /absolute/independent-review.json
~~~

~~~bash
node scripts/verify-pi-notion-model-cache.mjs --intent-config /absolute/frozen-cd-config.json --intent-case D-early --intent-action doctor
node scripts/verify-pi-notion-model-cache.mjs --intent-config /absolute/frozen-cd-config.json --intent-case D-early --intent-action run
node scripts/verify-pi-notion-model-cache.mjs --intent-config /absolute/frozen-cd-config.json --intent-case D-early --intent-action review --intent-evidence /absolute/pi-intent-evidence --intent-review /absolute/independent-review.json
~~~

对每个已运行 case 分别执行 Evidence→Cleanup→Evidence，保留 raw provider、RPC、source、实际 final、失败和文件 hash。`run` 的技术成功只返回 `review_required`；独立语义评审逐 turn 绑定 final SHA，介绍还绑定准确源正文 SHA 和真实答案片段，检查意思、必要事实和无证据的执行声称。语义评审不能补造缺失的正文交付或动作。模型计划生成与控制器随后执行的 owned exercise 分列，不能声称模型已自主执行。

### 介绍意图的已知候选与实际 use

`assertIntentTurn` 只将 verified preparation 中 `purpose: use` 且目标节点 `state: prepared` 计为目标激活。use 图内仅有 `state: known` 的 Member / reference 是候选元数据；目标的独立 `purpose: inspect` 不因内部 SDK operation 为 `consume` 而变成 use。真正以目标为 root 或 Required 的 prepared use 仍拒绝；完整目标 read、实际 provider 正文、首次显式根与全部 Requires、允许的模型调用和副作用门槛均保留。

真实 C `sc21-daily-early-mu3y6io8/remaining-v2/cd-evidence/pi-intent-evidence-ib85Vf/C-introduce` 只有两个模型 `read`。根 use 的目标是 known/member、没有正文；目标 consume 则是 inspect/prepared、Required 为空。旧断言只按 ID 命中节点，误将候选判为激活。原 `failed`、两条未提交续问、raw observer/source/provider/final 不改写，也不重新提交 C。

### SC06 目录曝光对照：实验入口

同一 intent runner 接受显式 `phase:"SC06-discovery-prototype"` 与 `discoveryExperiment:{"version":1,"mode":"full-cards"}` 或 `mode:"on-demand-cards"`。实验必须选择 `--intent-case D-early`，仍完整校验原四场配置，C 为 `not_run`；原三个 D 的 prompt、命名介绍的重启续问、每次 300000 ms、最多四次提交、零 retry/fallback 均不变。没有实验字段时，普通 SC21 的 phase、实际 ready 74 条断言与原 A/B、C/D 行为保持原样；不能把旧失败换成实验结果。

两份配置仅 mode 和 owned `evidenceRoot` 不同。冻结同一独立包/runtime、CLI/SDK、Pi/model/参数、生产 Default View 74 条及 scope、原完整四场 prompt/oracle/project、全部原 harness；此外把实际执行的 `scripts/skill-consumption-cost.mjs` 路径和 SHA 加入两臂相同的 harness 清单。Doctor 返回 `comparisonSha256`，必须相同才能配对。它只忽略曝光 mode 与 evidenceRoot，换源、名单、正文、prompt、包、工具、预算或 observer 都会改变该值。每场沿原驱动创建空 CLI/Broker/session roots；命名介绍的恢复续问保留原 session/cache，不重置为新的冷样本。

~~~bash
node scripts/verify-pi-notion-model-cache.mjs --intent-config /absolute/discovery-full-cards.json --intent-case D-early --intent-action doctor
node scripts/verify-pi-notion-model-cache.mjs --intent-config /absolute/discovery-on-demand-cards.json --intent-case D-early --intent-action doctor
node scripts/verify-pi-notion-model-cache.mjs --intent-config /absolute/discovery-full-cards.json --intent-case D-early --intent-action run
node scripts/verify-pi-notion-model-cache.mjs --intent-config /absolute/discovery-on-demand-cards.json --intent-case D-early --intent-action run
~~~

这是两个可调用的呈现实验，工具仍是原 `read/notion_list/notion_use`。graph observer 在 Pi 公开 `context_with_system` 中只定位唯一的 `context-broker-notion-catalog` section：`full-cards` 逐字返回原内容；`on-demand-cards` 去掉该 section 的 Skill/Router 卡片容器，并加一句不含目标的 `Notion cards are on demand; discover them with notion_list.`。当产品已经把某个 list 描述投影为复用默认卡片时，该 hook 只从自己正在移除、仍含完整 description 且有明确 source/name/current ref 的 Skill 卡片，将完全相同的描述搬至第一处匹配的实际 `notion_list` 输出；多个同引用 list 只保留一份。默认卡片自身已省略描述时不回填；无来源标签的 Router 或未知形态不凭 host details 补造来源。原 View 状态、已有 guidance、原生本地目录、其它 section、图片/工具配对、作者正文、details 和原始历史不变；非目录断言只精确允许并记录上述 description 字段搬移，不修改 SDK 目录或来源。不展示卡片不是完整空目录；pending/error 状态照原文保留，标记不声称 count、ready 或成功。

私有证据保存输入目录的完整 metadata 归属、前后 section 原文/bytes/SHA、整组消息 SHA 和非目录内容 SHA；发生描述搬移时另存 `restoredDescriptions` 的来源卡片、tool call、描述 bytes/SHA 与前后工具文本 bytes/SHA。这些证明不进入模型。隐藏的目录只以 `discovery-input-catalog` 观察，不能授权模型引用。`notion_list` 的实际输出、模型复制引用、read/use/Requires/固定资源仍经过原身份和完整性交付门禁。每个 provider 必须绑定本次 public projection，完整投影片段必须出现在实际 system 中且不重复，恢复描述的工具文本也须逐 call 原样到达，再与现有 transport 的实际 HTTP body 配对；只在 onPayload 私改 JSON、跳过 public hook、复用旧投影、混入原卡片或修改 scope/正文都不能通过。实验对 ready **输入**仍要求同一完整 74 条来源目录；正常 SC21 对模型可见目录的 74 条断言没有放宽。

两臂加载同一原 `observeConsumptionCost` 被动观察器。`consumption-cost-*.jsonl` 与 `discovery-cost-*.json` 按每次原进程保存累计 provider JSON/实际 HTTP request bytes、工具 schema、默认目录、guidance、正文诊断跨度、工具调用/轮次、原 Pi usage 和提交到首 provider/首有效文本/完成的时间。on-demand 提示自身 bytes 单列；诊断跨度可能嵌套，不能相加或由字符估 tokens。缺失 usage/HTTP response bytes 保留 null。source 启动、取消、恢复、HTTP attempts/bytes 与 private extra proof 继续沿原 whole-case 账本单列，不重复分配到工具轮次。技术失败也保留已发生的成本，不能用更少调用或较短失败当收益；所有原条件续问和独立语义判断完成后才可评估完整任务。

实际 Pi 的前置接线沿原 `notion-skill-graph-observer-smoke.mjs`，显式传入原 all14 的已种离线 fixture（不是 distinct/ambiguous fixture）。每臂使用同一已安装包与 tgz、CLI/SDK、Pi、prompt、工具及初态，独立复制 source 状态并建立空 Broker cache/session；由原 `packageIdentity()` 核对 archive 与 installed src/dist，前后再次核 hash。SDK 分支 `source.command` 缺省，discovery/activation offline、prefetch false；不启动来源服务或将受控模型伪装为 magpie。原无这些新参数的 custom-command smoke 保持原行为。

~~~bash
node scripts/notion-skill-graph-observer-smoke.mjs --extension /absolute/installed/node_modules/pi-context-broker/src/index.ts --package-path /absolute/frozen/pi-context-broker.tgz --cli-entry /absolute/cli/node_modules/ntn-skills/dist/ntn-skills.js --sdk-fixture /absolute/original-all14-fixture.json --discovery-only true --discovery-mode full-cards --evidence-root /absolute/new/full-cards
node scripts/notion-skill-graph-observer-smoke.mjs --extension /absolute/installed/node_modules/pi-context-broker/src/index.ts --package-path /absolute/frozen/pi-context-broker.tgz --cli-entry /absolute/cli/node_modules/ntn-skills/dist/ntn-skills.js --sdk-fixture /absolute/original-all14-fixture.json --discovery-only true --discovery-mode on-demand-cards --evidence-root /absolute/new/on-demand-cards
~~~

该受控层沿原 90000 ms 单次 prompt、n=1、三次 localhost HTTP：首请求选择 `notion_list`，下一步只复制实际默认可用 metadata 的 ref 给 native `read`，最后完整正文恰一份进入 provider。它不使用私有 target seed，inspect 不读取 Requires/Member。正常本地 Skill canary 的 metadata 必须留在每次实际 system，未选正文不得出现；原工具 schema、guidance、项目路径和 canary 均进入成本口径。原 graph observer 仍逐 body 绑定 public projection→provider→HTTP，成本 observer 最后加载；输入目录严格对齐 fixture 的完整 Default View，full 原字节不变/on-demand 只隐藏卡片。fixture 的两条默认目录是受控层，不替代生产 74 条校验。

成功要求原 `RPC.closeInput()` 自然退出 0、完整 `observer_end`、每个 SDK/HTTP 终局与实际返回值闭合；来源 HTTP/CLI 必须为实际完整账本的零。`run-0/launch.json`、`cost-submission.json`、`consumption-cost.jsonl`、`discovery-cost.json`、`source-accounting.json`、`rpc-lifecycle.json`、原 provider/source 原件与 installed/runtime 身份一同保存。按原 owned Evidence→Trash→Evidence 流程封存，失败不得重写。该层是 source 已暖、Pi/Broker 新状态的接线验证，不声称冷 Notion 延迟或全任务收益；之后才在独立窗口运行上面的原 D 两臂。

### 显式保存标题与位置注记的文件提取

提取器须识别 `Save the file:` 后的反引号路径及括号位置注记，逐字节保留完整fence正文。注记可说明workspace/等目录，不能给第二候选文件；原owned-root、遍历、双斜杠、多路径、冲突、空文件与不完整/歧义围栏门槛保持。识别文件不授予执行资格，缺完整Skill或依赖仍不可exercise。

### 未具名文件清单与完整生成文件

仅在没有显式 fence 文件名或前置路径标题、准备从正文首行推断文件名时，将闭合代码块内至少两行裸合法路径视为文件清单，不将后面的路径误存为第一份文件正文。显式 info、标题或 `path:` 首行标签指定的文件仍可完整包含路径列表；保存源文本 bytes/hash/span，不修改其换行。真实冲突定义、空文件、路径越界、未闭合/歧义围栏、缺 Skill 与引用缺失继续失败。

`notion-skill-graph-project.test.mjs` 保留 LF/CRLF、显式路径列表文件和真实冲突的回归。按原 bytes/hash/span 核对所有提取文件，不改写原模型文本或历史失败。

文件可提取只证明产物保留；任务语义、允许的执行入口和实际功能结果仍分别验证，提取成功不能消除这些失败。

### SC06 同次 provider 的生成卡片描述复用

当前产品在最终 `context_with_system` 仅复用本次仍完整可见的描述。`notion_use` 必须通过原 compiler/projection、完整 body span 和 session binding；native `read` inspect 必须通过原 v3 receipt、原始正文 span/hash/bytes 与 selected `sr:S` 的完整 source/locator/owner/scope/ref/pin 绑定，仅解析正文结束后的原生成 footer。根正文、生成目录、关系边、精确引用、details、receipt 与历史字节均不改。随后默认卡片与精确验证的 discovery 模型投影可省同身份同元数据的 description；同次另一份完整描述离开上下文后自然恢复。已有默认卡片自身不能使所有重复默认项同时失去描述；共享一个 `sr:C` 的不同 configured source 也保持各自完整身份键，未获同 source witness 的卡片保留描述。

当前 `sr:C` 不能仅按 owner 借用固定 `sr:S` 或带 snapshot 的关系；未知 compiler、摘要、截断、伪标签、错误 tool call、foreign scope/source、不同 locator 或 metadata 一律不省略。`$` 的 Skill wrapper 没有同类生成 Members 目录，Router custom wrapper 也没有本片所需的完整目录证明，因此这些包装保留原描述，不新建 receipt。完全相同的 Members/Requires 关系仍按原工具内容保留；本片不改正文 compiler、SDK、工具 schema 或默认曝光策略。

独立 oracle 复用 `scripts/skill-preparation-evidence.mjs` 的原完整交付验证，未调用产品去重函数来生成 expected。SDK-Pi 和 graph observer 在**同一份实际 provider**中检查缺失描述的完整 card、current ref 和来源绑定；HTTP 断言仅把 byte-identical 的实际工具文本接回原 host evidence。原 74 条身份/完整覆盖断言继续生效。graph 的 `exactToolOutputCopies` 如实为 0 时，另记有完整来源 hash/bytes 与同次卡片 witness 的 `metadataProjections`；未知字段变化或没有完整 witness 都失败。on-demand 的描述搬移只搬走原本可见的元数据，public hook→provider→localhost HTTP 保留原 handler 正反例；实际 Pi 与真实 D 两臂须绑定当前候选，不继承其他 pair 的结果。

SDK 取消只沿既有严格断言结算 metadata `list`：被动 native `session_shutdown` 与 SDK 起止同 PID，时间位于同一 monotonic 闭区间，完整 metrics/trace/EOF 均在；该回执不算 ready 目录。缺失账本、null metrics、未知正文归属仍是 observation-incomplete。任何 source write 必须另有 Records retention/adoption 与业务写入归因，不能仅因为 operation 是 use 就放行。

改前旧入口拒绝 `--intent-config` 和私有 D seed 负例保留。`--discovery-only true` 的原 `notion-skill-graph-observer-smoke.mjs` 实驱实际 Pi、受控 HTTP 和显式 custom source：首请求无正文，真实 list 元数据先于 read、正文全文进入 provider、未读 Requires/Member。该受控证明不能代替生产 SDK、真实模型 C/D 或正式 SC21 全矩阵。

这组反馈触发一个独立措辞候选：把 read 的 Notion inspect 能力提到描述首部，将 use 的目的明确为应用所选规则，消除 guidance 中“选择来介绍”和“选择来应用”共用 load/selected 的歧义。仅改三处模型可见说明；不按自然语言关键词拦截或转换 use，不增加工具，不改作者正文、原 prompt、oracle 或旧样本。按原 C/D 入口和新独立安装身份检验实际选路后才能判断是否有收益，同时保留 D 自然任务自主选择并 use、显式 use/read、Requires 完整、普通续问复用、固定资源与本地/batch read 的既有反例。受控回归或文字变清楚不证明模型行为已修复，工具 schema/guidance 的新成本也应实记。

## NG10 / NG13 原生发现与显式准备

默认 View 只决定初始目录。按 `agent-cli-ref-20261105`，Pi Agent 从根 Members 目录、原生正文中的准确 ref 或 `notion_list` 元数据结果选择 View 外的受管 Skill / File。`notion_list` 不读正文、不注册 loaded；原生 `read` 用于 inspect 和精确资源，顶层 `notion_use({ref:string|string[],refresh?:boolean})` 准备根与完整 Requires 闭包。inspect 不把 Required 正文当已准备。用户显式 `$` 与 `/skill:` 沿同一 prepare use 协议；未匹配的普通用户字面引用保持既有 soft miss，而已选 Required 缺失、预算、权限或版本失败必须阻断 provider。

~~~bash
bun test packages/context-broker/scripts/host-prepare.test.ts packages/context-broker/scripts/native-read-session.test.ts packages/context-broker/scripts/shared-notion-adapter.test.ts
bun packages/context-broker/scripts/input-guard.test.ts
bun packages/context-broker/scripts/source-runtime.test.ts
node scripts/verify-notion-integration.mjs run --mode installed --host pi --package /absolute/frozen-broker.tgz --skill-graph true --command-json '["/absolute/node","/absolute/installed/ntn-skills.js"]' --graph-cli-source /absolute/notion-skills-cli --evidence-root /absolute/evidence
~~~

实际参数以入口 help / doctor 为准；不得将另一个源 checkout 或临时产物替换 manifest 中已冻结的安装包。当前默认 SDK Graph Gate 的 Pi 工具面为 `read,notion_list,notion_use`；controlled native-chain 另保留单 `read` 专项。observer 逐请求核对真实工具定义，metadata-only list 的结果须匹配实际 SDK listCatalog 结果，use 只接受已披露 owner 的引用或经同一实际来源唯一映射的 name/alias，自动 Required 不冒充 Agent 自主选中的 Member。所有场景保持 shell 禁用和三层冷目录；最终来源身份必须带 scope、canonical ID、snapshot、主文 bytes/hash 与 stable File ID。未绑定名称不是身份或正文交付证明，不可用同名替身、另一库或本地副本补齐。

`scripts/notion-skill-graph-model.mjs` 的当前配置默认 `sourceMode:"sdk"`，生成的 source 必须省略 `command`；`cliCommand` 仅用于冻结输入身份与显式 command 分支。现有 `viewId` 走真实 View；历史 `profileId` 必须显式指定 `sourceMode:"command"`，独立报告 custom/profile 兼容结果，不能由包装 CLI 冒充默认 SDK。按下列顺序从冻结配置复跑，selection 使用独立 metadata scratch，不预热后来全冷 consumer，也不读取私有 oracle：

~~~bash
node scripts/notion-skill-graph-model.mjs doctor --config /absolute/frozen-graph-config.json
node scripts/notion-skill-graph-model.mjs selection --config /absolute/frozen-graph-config.json
node scripts/notion-skill-graph-model.mjs run --config /absolute/frozen-graph-config.json
node scripts/notion-skill-graph-model.mjs evidence --evidence /absolute/retained-run
node scripts/notion-skill-graph-model.mjs cleanup --evidence /absolute/retained-run
node scripts/notion-skill-graph-model.mjs evidence --evidence /absolute/retained-run
~~~

selection 成功回执中的精确 selection 与 `result.json` 绑定 `selection` / `selectionReceipt` 后再 run。当前 selection 在独立 scratch 中执行两个普通 prompt 与一次 metadata list，共三次本地受控 provider HTTP；它读取真实 Notion metadata，但正文和真实模型调用都为零，完整计入 setup 成本。旧的零 provider 回执不再证明新增续轮条件。普通冷启动首轮默认目录可以是 pending，不能把它解释为成功的空 Default View，也不能用旧的首请求 exact-one 断言阻塞真实执行；目录 metadata 完成后，下一条普通用户 turn 必须独立证明 ready 的 root-only 名单、准确入口及零正文 I/O。显式 `$` 根使用与普通默认目录是两个观察点，完整根正文投递不能代替后续模型自主选 Member、读资源与完成任务。

观察端复用 `scripts/notion-skill-graph-model-evidence.mjs`，保留 public provider hook 与实际 wire payload 配对、私有 SDK result、短引用分支事件和源进程账本。默认 SDK 的 list/files/consume/read/read-resources 逐 operation 配对，CLI child 为零，缺失 metrics/terminal/result 不推断为零；code mode 内部正文不算顶层交付。trace 标明 `toolContract:"agent-cli-ref-20261105"` 后只按新 Pi 工具判定；未标该合同的旧 trace 才保留 legacy `skill_prepare` 解析。`notion_ctl` 是 deferred 管理入口，不进入默认模型 schema。这些 helper 的正反例与现有 graph tests 一起进入 `bun run test:verification`；受控通过仍不代替真实模型成功。

### 名称引用的 observer 边界（harness 16）

名称是选择表达，canonical ref 是身份。observer 保留模型的原始参数，不把 name/alias 改写后送入工具，也不放宽 consume 的 canonical `root.target` 合同。已实际披露的 owner 可由同一来源的 record 名称或 alias 唯一映射；未披露的全库条目本身不授予读取资格。固定名称只使用该 pin 的历史 manifest，不能被 current 目录的改名重绑，原 scope/pin/File ID/路径与完整字节证明继续有效。

未披露 owner 的直接名称读取只接受实际 provider 中与冻结用户原句完全一致的 user 消息。selector 必须是其中的完整字面文本，不能是更长词的子串、assistant 引用或未验证工具文本；这条规则不分析“介绍/使用”等意图词。准入仅允许无 pin 的主文尝试，不授权猜资源、固定版本或 `notion_use`。`message_end` 先保存原 args/hash/sequence、prompt/provider hash、literal span 和当时已有 source 回执集合，claim 不含 owner。调用后必须有新完成的普通目录覆盖及 read/inspect consume 回执，把相同 name/alias 唯一绑定 scope/owner/主入口；缺页、失败来源、歧义、旧回执、错误 scope/owner/main 或部分正文均不通过。同窗明确成功的 View/profile/query/page 投影保留原成本，不能证明名字唯一；仅在另有完整 ordinary 目录时排除其选择作用，失败或无法归属的 list 不会被忽略。

Broker 的 source work 可以发生在 assistant `message_end` 与 observer `tool_call` 之间。名称选择在前者冻结，后者保留原 admission 时点；目录、read 和完整 native/provider 证明都匹配后，源归属才可使用真实 authored 时点。该条件不回填消息时间，也不能把真正早于模型选择的正文读记为合法选择。named use 仍核完整 graph lock、根和 Requires、主文 manifest、实际投影 span 与下一 provider；固定资源不靠重复主文成功冒充资源已交付。

~~~bash
node --test scripts/notion-skill-graph-model.test.mjs scripts/notion-skill-graph-host-index.test.mjs scripts/notion-skill-graph-model-evidence.test.mjs scripts/skill-preparation-evidence.test.mjs scripts/verify-skill-graph-contract.test.mjs
~~~

Graph harness 15 通过 Pi 公开 `systemPromptOptions.sections` 添加原样的 owned project paths 文本，不再从 `before_agent_start` 返回整段 `systemPrompt`。该早期观察另记 `catalog-before-agent-start`，`context_with_system` 的 sections 只保存诊断 hash；两者都不能授权目录读取。`catalog` 只解析 `before_provider_request` 实际 payload 的 system 文本，并绑定该次 payload SHA，再与实际 HTTP wire 对照。用户文本、assistant 工具参数、未验证 tool body 中的伪目录均不算目录发现；已完整验证的 Skill 正文及其原工具结果仍按原 oracle 授权 Members / 资源引用。实际 provider 中与冻结用户 prompt 完全相同的明确固定资源 ref 仍可凭独立 owner manifest 直接标量或批量读取，不要求先交付主文。错误 scope、pin、File ID 或 manifest 的本地目录在主文准入处即拒绝，不借目录文本绕过完整性检查。

原 metadata selection 仍保持两个普通用户 turn 和三次受控 provider；每一次 provider 都独立核对最终目录、system 字节和实际 wire，不以两个早期 hook 代替三个模型输入。保留每次原失败与独立回归，不离线重判通过。后续候选必须明确记录此 observer 迁移作为输入差异，任务、预算、工具、目标和私有答案保持原冻结合同；该迁移自身不代表真实模型选路已改善。

原 `--public-boundaries true` 专项从实际 provider 的原生 `<skill location>` 或完整 `<context-broker-record ref>` 复制主文读取入口。后者必须同时通过原 owner / scope / pin / File ID、完整正文 hash / bytes 和实际 payload hash 绑定；任意 XML、仅内部回执、缺正文、重复正文和错身份均不能授权。标量 `read` 继续按同一 toolCallId 验证完整源文件。caller 与包的版本分别绑定；observer 变化不得改写旧失败，也不得改变正式任务或模型预算。

该专项的 Member 读取若由 `sr:C` 元数据进入，准入时的 claim 只证明 owner / scope / path；fixed pin / File ID / 完整 hash / bytes 必须由实际 read 结果对独立 fixture 核对。实际 authored call、admission、prepare argv / requestId、完整结果的 callId / sequence 均须配对，时序要求 authored → prepare → 完整结果，不要求 prepare 早于原生工具准入。`AuDn6P` 因前述正文重复没有执行到这条后置断言；其原 raw 只用于保留旧 `admitted.expected` 假设的离线红例和迁移后后验，不能替代修复产品后的完整专项实驱。

当前原生资源入口同时支持 scalar `read({path:REF})` 与 batch `read({paths:[REF,...]})`，REF 可为已实际发现的 canonical ref 或会话 `sr:R`。batch 必须用原始 SDK `read-resources` manifest/body、安装包自己的资源投影校验器和同一外层 toolCallId 对齐逐文件完整 span；不能从 details、summary 或部分文本推断已交付。错误 owner/pin、未发现的 ref、缺完整外层输出与部分正文均拒绝。资源文件数量、外层工具调用数量和内部 SDK operation 分列计账，一次 batch 不能冒充多次工具往返，也不能掩盖缺失文件。

Graph harness 17 在默认 SDK scalar `read({path})` 保留一个窄产品校验入口：模型实际 authored args 与工具参数完全相同，原 `sr:C/S/R` token 已逐字披露、仍由当前分支和独立来源回执证明，且追加内容确实违反产品 token 语法时，将原错误参数交给已安装产品。observer 不替换 ref、不给模型正确答案，也不生成授权错误代替产品的 `SHORT_REF_INVALID`。例外不接受未知或未逐字披露 token 的后缀，包括同 owner 的另一短引用；有效形状但未知或未披露 owner 的 ref、旧分支、非 SDK、batch、多余参数、真实路径越界和 shell 维持原拒绝。

这类调用记录 `invalid-short-ref` 与 validation attempt；原 tool result 记录实际 error text/code/hash/bytes，始终 `complete:false`，不写正文 delivery ledger、不发现新引用、不证明激活。错误码不同、意外成功、嵌套结果以及后来正确读取，都不能把该次 invalid input 或整个任务改为通过。实际 `SHORT_REF_INVALID` 及增量 SDK / 源对象读取为零由原 installed `name-references` 场景另验；原生文件路径不降级由产品既有边界测试和代码路径保障，本项不声称实测文件系统调用次数。已有后台 metadata 工作必须单列，observer 单测不替代真实 Pi 产品执行。

运行 `node --test scripts/notion-skill-graph-model.test.mjs scripts/notion-model-cache.test.mjs` 核对公开引用语法、来源归属和观察缺口。新的 observer 结果绑定本次源码与输入；保留原失败，不据纯验证器修正宣布模型验收通过。

Pi 默认 graph bridge 使用随包公开 SDK `consume`，同一内核验证完整清单、主文范围、身份、固定版本与 hash，Broker 核对选中身份后直接物化，不再逐节点启动 CLI read。资源通过同包 SDK 固定 `readSkill` 或 `readResources` 物化。显式 `source.command` 与 OMP 保留公开 CLI prepare + 逐 prepared node 固定 read 的兼容边界；上述 `--command-json` 命令验证的是该边界，不能代表默认 SDK。默认目录改用同包 SDK `listCatalog`，公开 operation=list，目录/正文路径都应为零 CLI children。显式 custom command 独立列账；超过默认分页大小时须证明遍历所有页，未验证的调用路径不得继承其他入口的结果。旧直接加载与 Prompt 的完整 export receipt 不放宽。实际 Node / Pi 路线按 [运行时合同](../../../../packages/context-broker/docs/skill-consumption-runtime.md)。

安装 Pi + 受控 provider 的首次请求应含 root / Required 完整正文各一份、Members 正文零份。记录实际 tool input/output、完整 body hash、目录 ref、provider context 和源请求账本。native read 的资源 ref 必须来自公开目录/正文，旧路径带稳定 File ID 应解析到固定 owner snapshot 的正确路径。missing Required / budget / cancellation 时 provider 数量为零；RPC abort、new_session、EOF 与真正终端 Escape Stop 分开记录。

## NG15 分支选择图与正文回执

分支上的 `context-broker-selected-graph` custom entry 保存版本化 CLI graph lock，包含实际根、Required edges、scope 和精确 binding。已知目录、候选和后台预取不写该 entry。optional 第一次实际选择时才加入；正文是否仍在当前上下文由完整 hash/bytes/实际消息跨度证明，不能用选择锁或缓存存在推断 loaded。

SC04 的 branch-local C/S/R 表独立于 graph lock；已固定短引用不改绑，刷新创建新 S/R，兄弟分支不可互用。固定旧 pin 或非主文关系不能因 ID 相同而替换为当前候选。按需发现的 Pi `notion_ctl({refs:[...]})` 导出 S/R 的 canonical 精确证明（OMP 仍为 legacy skill_graph），消费端仍重新授权。SC08 另保存版本化 active receipt：完整 visible 证明加同轮未取消的 2xx headers 确认后才激活，inspect/ready 不激活；压缩移除正文后普通消息从固定 roots 恢复一次，不改写原始 JSONL。实际 SessionManager、RPC/PTY 与 SDK-Pi 的验证边界见运行时合同，状态层成功不等于真实模型成功。

### SC23：会话驱动的 View 元数据调用

`notion-skill-graph-session.mjs --source OWNED_STATE` 是显式 custom-command 的真实进程包装器。它允许当前 `ctl views`，并保留裸 `views` 的旧调用兼容；`ctl doctor`、`ctl cache identity` 的原边界不变，其他管理／作者命令在启动 CLI 前拒绝。包装器不重复实现 CLI 参数解析，多余位置参数仍由独立安装的 CLI 拒绝。此迁移不启用预取，也不把 custom-command 结果算作默认 SDK 验收。

定向回归复用 `node --test scripts/notion-skill-graph-delivery.test.mjs`：实际 `--source` 子进程必须原样转发 View 参数，旧 alias 可用，未知 `ctl sync`、operation、cache clear 和 create 不得启动 CLI。这里的 argv fixture 仅证明包装器协议，实际 View 数据另由安装包验证。

### 分支选择与恢复驱动

~~~bash
CONTEXT_BROKER_PI_SESSION_MODULE=/absolute/installed/pi/dist/core/session-manager.js \
CONTEXT_BROKER_SESSION_EVIDENCE=/absolute/evidence/ng15 \
node packages/context-broker/scripts/session-selected-graph.mjs
~~~

该入口用实际安装 Pi 的 SessionManager、真实 Node 与其公开 append / branch / fork / compaction / open 方法，不使用产品测试 setter。保留独立子进程重启、原始 JSONL、导出的选择图与判定结果。先固定 root + Required 的 A；optional 在库已为 B 时第一次选择只锁自己的 B；fork / rewind 恢复所选祖先而非全部兄弟 entries。压缩移除完整正文后 loaded 为 false，A 的锁仍保留，重载仍用 A；新 session 用 B。

显式 `notion_use({ref,refresh:true})` 在完整准备、确切 File ID 与宿主输出预算全部通过后提交新的 scope 选择。失败保留旧锁。只在 provider 投影中替换已验证的过时/重复正文，原 native tool result、toolCallId、用户消息和 JSONL 不重写；修改跨度后仍保留其余有效回执的准确位置。按需 `notion_ctl` 导出当前选择和真实 delivery 状态，不进入默认 schema；旧 OMP 对应 skill_graph，不包含凭据、机器缓存路径或对话正文。未知 schema/compiler 版本与被篡改的版本向量必须报错。

Pi 的正常 prepare 模型结果使用[确定性投影](../../../../packages/context-broker/docs/skill-consumption-runtime.md#model-content-and-machine-proofs)，canonical graph、目录 hash、版本和物化证明在 `details.contextBrokerPreparation` v2 中。通用 graph/session 验收以独立 `skill-preparation-evidence.mjs` 校验 compiler、整份 content hash 及各源 span，再与原 CLI oracle 对照；不能从内部 details 的正文或空 loaded 标记证明模型收到内容。旧 v1 只按原格式读取，含新版 projection 的降级 v1 拒绝。正式 graph model gate 的当前驱动按独立 SDK result、分支短引用与 v2 span 验证；旧 canonical-only / CLI-wrapper 样本保持历史身份。迁移后的真实模型复跑未取得证据前，不能用受控路线替它报通过。

会话替换撤销旧 ctx：pending input 必须以 handled 结束，不能在 catch 中通知旧 UI 导致 Pi 回退为普通 prompt。生命周期取消不得调用已撤销 ctx 的 abort，也不能取消后一个提交；dispatch receipt 在真正 session 边界或原 consumer 确认前仍拦住重复提交。受控 Proxy 回归与实际 installed Pi new_session / EOF 结果分别保留，真正 TUI Stop 仍需独立终端证据。

### 实际 Pi 终端选择与 Stop

当前 Pi 1.4 的 Notion 目录异步完成，启动画面的 `[Skills]` 不能作为冷启动前置。原 PTY driver 先观察完整空编辑框和该 fixture 两次 metadata list 的实际成功退出，再以实际 `$` 候选和 Tab 接受验证目录已可用；前两步仍要求 provider 为零，不能由内部 metadata 回调代替实际候选。只等空编辑框就输入会落在 metadata pending 时段；保留该次失败。`escape-stop` 可以独立运行以验证当前取消合同。旧 `selection` 场景还要求 `/skill:` 原生菜单 Tab，Pi 的延后目录不会自动补入 startup 菜单，该子路径未通过时必须单列，不用 `$` 成功覆盖。

延后的 context 准备通过公开 `ui.setWidget` 显示预算与 Stop 提示，并在终结或会话替换时清除。只有仍属于当前 run/generation 且原生 signal 已取消的 context 才正常取消；真实获取错误仍 abort 并报告，旧 context 不能取消新提交。PTY 验收必须实际看到该提示，不用 RPC 或延后显示的消息替代。

~~~bash
node scripts/verify-pi-graph-pty.mjs doctor --package /absolute/frozen-broker.tgz --command-json '["/absolute/node","/absolute/installed/ntn-skills.js"]' --cli-source /absolute/notion-skills-cli
node scripts/verify-pi-graph-pty.mjs run --package /absolute/frozen-broker.tgz --command-json '["/absolute/node","/absolute/installed/ntn-skills.js"]' --cli-source /absolute/notion-skills-cli --cases selection,escape-stop --evidence-root /absolute/evidence
node scripts/verify-pi-graph-pty.mjs evidence --evidence /absolute/retained-run
~~~

入口实际安装冻结的 Broker 包，核对已安装 Pi 的 @earendil-works 身份，使用独立 HOME / 配置 / session / Broker / CLI 目录。实际 PTY 输入 Tab 接受 $ 和 /skill 候选；候选与接受动作正文 I/O 为零。提交后完整 root / Requires 各一份、Members 零份；仅 read 工具可用。Escape 场景先等真实 CLI HTTP 等待和源子进程启动，再发送实际 Escape 字节，检查 CLI 130、所有源后代退出、provider 零次和无迟到正文，随后同会话重试。准备预算和 Stop 提示必须在实际终端可见。

保存 raw terminal.ansi、逐步 screen.json、实际按键、provider body bytes/hash、source request ledger、session JSONL 与自然退出证据。若 Escape 功能成功但预算隐藏，仍按完整合同判为失败并保留。实际 Pi + 受控 provider / SQLite 输入证明宿主终端边界，不能代替真实模型选路或生产 Notion 验收。清理命令只将该 manifest 所属 scratch 移到系统 Trash，保留证据目录。

## NG18 宿主清单与按需资源

完整 prepare / consume 清单的每项必须含 path、bytes、sha256 和准确固定 ref；shared Files 还需同 owner 的稳定 File ID/page 绑定。Pi 默认 consume 的主文范围、scope、record、snapshot、version、ref 和 hash 由共享合同严格验证；custom command / OMP 的主文 fixed read 继续逐项与 prepare 比对。初始宿主只保存 main 到 entries/SNAPSHOT/tree，外部 .broker-entry.json 明确 projection=entry、manifest_complete=true；它不能被旧完整 .broker-snapshot.json 消费。local_files_ready 与 materialized_paths 只反映逐文件验证结果，不等于 loaded。

原生资源 read 从清单选确切项，Pi 默认由同包 SDK `readSkill` 取得字节；custom command / OMP 仍为自有 CLI `read REF --output NEW_STAGE`。两者比较同一完整公开回执与真实文件 SHA/bytes 后再发布。未选大资源不出现；二进制保持原字节，物化成功不自动等于完整文本进入 provider。错误 File ID、跨 scope、旧路径无身份、坏 hash、取消和不完整输出必须失败，不猜名或退回 current。嵌套 main 可读同一树中其他目录的文件；仅有清单不能绕过 native read 的当前授权边界。目录和缓存命中仍可能产生权限 Metadata 请求，零 resource chunks 不等于零 HTTP。

实际 tool result.details.contextBrokerResource 保留准确 ref、id、scope、snapshot_id、version_id、path、file_id、bytes、sha256、materialization 与 delivered_complete_text。只有完整工具文本匹配字节/hash 才能标 delivered_complete_text；资源回执始终 loaded:false，不代替主文 contextBrokerRead。会话替换后晚到结果不留 receipt。host alias 旁的 .broker-host-index.json 只证明原始/发布 main 的身份和 hash，projection=host_index、loaded=false，不能作完整快照或上下文投递证明。

~~~bash
bun test packages/context-broker/scripts/notion-entry.test.ts packages/context-broker/scripts/host-prepare.test.ts packages/context-broker/scripts/native-read-session.test.ts
CONTEXT_BROKER_GRAPH_CLI=/absolute/installed/ntn-skills.js CONTEXT_BROKER_GRAPH_CORE=/absolute/notion-skills-cli/packages/core/src CONTEXT_BROKER_GRAPH_EVIDENCE=/absolute/evidence/ng18 bun test packages/context-broker/scripts/prepare-adapter.test.ts
~~~

Graph harness 2 将源码版本/hash 写入 Doctor、result 和 cache fingerprint；完整 search/prepare 输出按原 toolCallId 与实际 provider 消息核对，并验证 root/Required 每次最多一份且保持所选版本。owned `PATH/ntn` 与旧 `NTN_SKILLS_NTN_BIN` trap 只作用于隔离宿主，保留旧 CLI/login 调用记录，pass 要求零调用。未物化资源 alias 须用 `scripts/notion-skill-graph-observer-smoke.mjs --resource-location alias` 核对。受控 provider 证据不能替代正式 A/B。

Graph harness 3 将整篇正文生成的正则改为 literal 扫描，保留 raw/HTML/JSON 三种表示、同起点最长匹配、非重叠计数与 assistant/model 引用排除。before-provider 观测异常必须写 `observer-error` 并使 Gate 无效；实际 transport 仅接受已核验 payload，并记录 wire-body SHA。不得把 hook 抛错后的真实 HTTP 错写成 provider 零次，也不得以观测故障授权模型 fallback。

## NG19 默认零预算与可取消预取

未配置、false、旧 boolean true 或不完整预算均为零预算，初始目录不触发正文读取。开启时必须显式给出非零节点、字节、时间和速率份额；depth 可以为零。一个源的候选在同一次公开 CLI prepare inspect 中处理，最多选择初始 View 中的 maxNodes 个可用 Skill / Router，不递归 Members，不读 Prompt 或自动取得完整 Requires 闭包。

~~~yaml
prefetch:
  maxNodes: 2
  maxBytes: 65536
  maxDepth: 0
  maxTimeMs: 5000
  rateShare: 0.1
~~~

maxBytes 限制完整成功 prepare JSON（包括正文、目录和观察向量），也限制单篇主文；它不是网络总传输字节配额。真实请求数、下载字节、准备时间和未被后续选择使用的字节必须另用 HTTP ledger 计量。CLI 的 --priority prefetch、--queue-budget-ms、--time-budget-ms、--rate-share 沿同一 Effect owner / Notion scheduler。预取有额外限速 lane，不能放慢前台 lane；跨进程有前台排队时直接 defer。429 / 529 保留共享 server cooldown 后停止本次预取，不另套重试。prefetch 传 sharedReadOnly，并在 transport 拒绝所有非只读 mutation。

Broker 只记录 prefetched prepared 的安全身份/bytes/hash 诊断，不导出宿主全目录，不 append 会话 graph lock，不注入正文或派发 provider。之后真实选择仍走完整 freshness / scope / permission 复验。前台选择、资源读、Requires 准备、会话变化或总时限取消当前预取；即使回调晚到也不能发布 prepared。最后一个前台 waiter 取消释放其进程，单 waiter 取消不能杀死其他 waiter。预取权限失败不阻断无关前台，实际 Requires 失败仍硬失败。

~~~bash
bun packages/context-broker/scripts/source-runtime.test.ts
CONTEXT_BROKER_GRAPH_CLI=/absolute/installed/ntn-skills.js CONTEXT_BROKER_GRAPH_CORE=/absolute/notion-skills-cli/packages/core/src CONTEXT_BROKER_GRAPH_EVIDENCE=/absolute/evidence/ng19 bun test packages/context-broker/scripts/prepare-adapter.test.ts
~~~

CLI 对应 preparation-execution.test.ts、notion.test.ts 和实际 Node/SQLite notion-request-scheduler.node.test.ts。对照必须固定任务、所选版本与安装包，比较无预取 / 显式少量预算的真实等待、总请求和浪费字节；没有测得收益不改默认零预算。受控 SQLite 输入、真实小图 API、实际 Pi 和真实模型分别记录，不混用。

~~~bash
node packages/context-broker/scripts/prefetch-cli-counterfactual.mjs --command-json '["/absolute/node","/absolute/installed/ntn-skills.js"]' --graph EXACT_RETAINED_GRAPH_ID --entry EXACT_DATABASE_ID --root-id EXACT_SHARED_SKILL_ID --evidence-root /absolute/evidence/ng19 --samples 1
~~~

此只读对照在两个独立空配置/state/cache/data 根中各自 restore manifest，保留相同已验证 A vector；默认零预算一路直接 use，显式预算一路先 inspect root 再 use 同一根和 Requires。只继承原有环境认证，不复制秘密。单独报告 manifest 成本、前台等待、预取加前台总时间、所有真实 HTTP/字节、未被选择的预取 instruction/retained-response 字节；遇到截断 trace、未知字节、当前正文或远端写入立即失败。公开CLI对照不冒充宿主自主模型或实际前台抢占测试。

| 一组固定版本对照 | 前台等待 | 预取加前台总时间 | 请求数（不含 manifest restore） | 响应字节 |
| --- | ---: | ---: | ---: | ---: |
| 零预算 | 4.832 秒 | 4.832 秒 | 9 | 37,730 |
| 显式预算 | 3.999 秒 | 9.782 秒 | 13 | 52,821 |

## Graph harness 4：真实广告与不可知归属

观察器将实际 provider 中已经完整提供的 native 主文路径与同一 scope/owner/snapshot 的 manifest 核对；wrapper 省略 `file_id` 时只能匹配唯一条目，不能猜其它路径。目录中的 unpinned ref 只证明稳定候选身份，最终消费仍须命中 oracle 的 pin、File ID、正文 SHA 和字节数。路径穿越、改 owner/版本/File ID 和 assistant 伪造广告均拒绝。

未知正文归属独立标为 `observation-incomplete`。配置 `retainedSourceProofRepo` 后，仅在 Pi 退出后使用同 CLI Effect 引擎取得已经观测到的 immutable bundle metadata；独立 oracle 的进程与 HTTP 账本不混入 consumer。纯离线 verifier 校验两层 canonical SHA、owner 与 chunk 清单，随后只按同一实际 CLI receipt 中出现的 bundle/Records DS 关联归属。ZIP 中已下载的其它资源不算 native read、provider 正文或 loaded。

实际 Pi system `<docs>` 段广告的自身通用帮助文件使用共享 `notion-pi-help.mjs` 校验：真实 executable/package bin 确认规范根，只准存在 regular `.md` 与完整合法帮助读取中的包内 Markdown 引用；拒绝内部 symlink、未广告文件、越界及拼错包名。帮助回执独立为 `host-help`，不能满足任何 Notion Skill/resource 断言。正确帮助路径与非法路径均保留独立断言。

`sdk-attempts.json` 保留 `uGldin` 的观察器 HOME 前缀漏处理和 `66q5vw` 的不恰当测试组合：Pi 对 56,423 B 文件按正常 50 KiB 页限制截断，不能算完整读取。最终将大正文投递与短 Required 的完整原路径复读分别验证，产品、TASK、oracle、model 与 timeout/budget 均未修改。

### H5：已完整读取的 host-index 主文与相对资源

host-index 资源只在实际广告的 index 主文完整读取成功后，用 `.broker-host-index.json` 与已验证 entry manifest 绑定 scope、owner、snapshot、main File ID/hash 和 `manifest_id`；只允许该正文实际出现且同一 manifest 声明的相对资源。资源最终读取仍须匹配精确 File ID、pin、SHA 和字节数。提前读取、部分主文、未提及 sibling、篡改身份/manifest、raw `..` 和内部 symlink 继续拒绝。

### H6：已发现资源的可选身份字段

H6 对省略 File ID 的请求要求实际已发现的 same-owner/current manifest path，并唯一解析 scope、owner、path、snapshot、File ID、SHA、bytes。显式 File ID 保留公开的稳定身份语义：旧显示路径可以不同于 current path，但该 owner/path/File ID 组合必须已由真实正文或目录提供，且由 verified manifest 唯一绑定；未发现的路径不能借用正确 File ID。显式 pin/身份冲突、scope/pin 歧义、未发现资源与 B 混接 native 路径继续拒绝。call 保存完整 expected 身份，result 只接受同一身份且完整物化的正文，不能因字节相同换绑 File ID。metadata-only `skill_prepare` 发现合同不变。

回归须包含无 query 输入、任选省略字段、已发现旧路径 alias、未发现 alias、显式错误 pin/File ID、scope/pin 歧义与调用后身份漂移；严格 path 比较不得误拦既有 stable File ID alias。

在选定安装包运行 `scripts/notion-skill-graph-observer-smoke.mjs`，分别使用 `--resource-location ref` 和 `--resource-location unqualified-ref`，保留 `--host-index-resource true`。核对实际发现的旧路径与 stable File ID、prepare.directory.files 返回的 canonical ref 省略可选字段后仍正确解析、完整主文与资源、provider/wire 配对、source close、Pi observedExit、外部/shell 拒绝及 legacy trap 零调用。受控 provider 证据不能代替真实模型 Gate 或其他 caller。

### H7：公开主入口、原生 wrapper 与实际作者时点

H7 每个 observer 调用方（含 legacy）直接注入实际 installed extension 同目录的 `parseNativeReference`，删除复制的窄语法。省略主路径只可按实际已发现 owner 和已验证 metadata 的唯一 scope/entrypoint 解析，不从 basename 猜 owner，也不硬编码 `SKILL.md`。显式 pin/File ID 与 H6 已发现 alias 边界继续精确核验。Pi native wrapper 的 location 必须来自真实非 assistant provider 内容，且完整主文与 loaded delivery receipt、manifest、公有 read 的 owner/scope/pin/File ID/hash/bytes 一致；assistant 引用、部分正文和身份冲突均不放行。

`message_end` 到达时记录真实 authored tool call、call ID、原始参数与 hash；只有后来 allowed call 和完整 read/prepare 身份均匹配，归属判断才使用该较早时点。admission 原时点仍保留，不拿 message 创建时间回填。未 authored、参数/身份错配和真正早于作者选择的 source read 继续失败。legacy 新增显式 `--case cold-native-command`，复用原 boot/turn/assert/cleanup，标记 targeted 单例且与 resume 互斥；默认 initial11 与 updated6 不变。

同轮产物收集器识别明确的“文件路径”标题，将 owned project 内绝对路径规范为相对路径，正文逐字保留；越界、同长度嵌套 fence 歧义、缺 Skill/frontmatter 和缺引用资源仍失败，TASK 与产物达标要求不变。observer 与 collector 的正反例分别保留在原测试入口。

## SC21：生成物的独立执行

入口继续是原 `notion-skill-graph-model.mjs exercise`。`--command-json` 保留四条受控原项目测试命令，结果明确为 `existing-project-check`；文本命中与原项目测试成功不能充当生成 helper 实驱。`--review` 才接受 controller 独立审阅的完整文件、原 result/final/五文件项目 SHA、精确 Node executable/args 与有限预算，将全部生成文件安装到另一个 owned 项目副本并执行一个 helper。审阅回执留在 consumer 外；模型、Notion 或旧失败样本都不会因本地回归而补跑。

| Feature → 用户入口 | 真实驱动与正反例 | Evidence → Cleanup |
| --- | --- | --- |
| 原项目命令 → `exercise --command-json` | 原 Node/npm 测试仍执行；否定句里的命令不变成 helper 证据；daily 第六文件前后使用同一 profile | `existing-project-check.*`、PID/close、原项目完整性；保留历史旧回执的读取 |
| 完整产物 → `exercise --review` | 完整 Node helper 在独立项目通过真实 loopback POST 创建、GET 读取；逐一绑定实际安装 bytes、argv、预算、真实进程、请求和结果 | 独立 `graph-generated-exercise-*` 保存原 result/plan、review、所有生成文件、stdout/stderr 与 owned 输出哈希 |
| 实驱门禁 → 同一 `exercise` | 无独立 review、原技术失败、不完整/改动文件、错误 SHA、越界/符号链接、覆盖源文件/运行时配置、argv/interpreter/预算不符均在 spawn 前拒绝 | 原模型结果保持不变；反例不创建执行副本；原 A/B/C/D 失败继续保留 |
| 执行终态 → 同一 `evidence` | nonzero 与 timeout 保留 failed；只打印 PASS 的 helper 即使退出 0，也只记 completed 和 independent-review-required | 实际 PID、信号、close 和 owned group 消失；原 `evidence → cleanup → evidence`，仅系统 Trash 自有 scratch，保留不可变回执 |
| D 自然任务 → 原 intent runner/review | D 不自动挑命令，技术通过且完整产物后记 `waiting-for-independent-exercise`；passed review 必须绑定新 helper 执行回执，旧项目检查不满足 | 内容/功能独立评审仍审实际行为和请求结果；完成一次执行不自动推导全部 feature 通过 |

此入口是经审阅程序的有限执行器，不是通用沙箱或副作用判定平台。controller 必须先检查完整 helper 的 imports、参数、资源与进程归属，只批准 owned 项目和 loopback 路线；不得读取生产配置/凭据或启动脱离 owned group 的进程。完整 receipt 字段和复跑命令见 [验收索引](../../../../scripts/notion-skill-graph-acceptance.md#generated-artifacts-and-execution)。原 `notion-skill-graph-project.test.mjs`、`notion-skill-graph-model.test.mjs` 与 `notion-model-cache.test.mjs` 覆盖本表，继续进入既有 `test:verification`。

终态门禁另保三条反例：setup/copy 故障在已分配 ownership 下保存 `not_run` 与失败阶段，未 spawn 时仍可原 driver ECE；未知继承管道到达硬截止后只销毁 runner 自有管道，保留 `closeObserved: false`/输出不完整并阻断 driver cleanup；最终 acceptance 在 scratch 尚在或 cleanup 未绑定 result SHA 时拒绝。专门的 detached 负例由测试预先标识并拥有其 child PID/起始身份/token，外层只结束该 child 并保存自己的 ECE，不回写被测失败或追认 driver 清理成功。

Linux CI 仍运行完整 helper/loopback/失败/finality 核心断言。仅系统 Trash ECE 和清理后 acceptance 正例要求 macOS 且 `/usr/bin/trash` 可执行；缺能力时保留 owned 夹具并明确输出 `System Trash ECE not_run`，不整项 skip、不换成 rm、不伪造清理通过。测试环境可用 `GRAPH_TEST_DISABLE_SYSTEM_TRASH=1` 重放该缺能力分支；生产 cleanup 合同不变。
