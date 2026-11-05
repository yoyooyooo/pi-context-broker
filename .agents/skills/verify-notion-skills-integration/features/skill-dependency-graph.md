# Skill 依赖图

此地图是现有跨仓验证 Skill 的专项，使用真实 Pi 原生选择和 read。Launch/Doctor/离线 Drive/Evidence/Cleanup 复用 [request-engine](request-engine.md)。不要复制出第三个顶层总验收 Skill；实际模型、RPC、进程、安装和 UI 继续使用仓库既有 helpers。

最终安装包与原 AH-560 场景、模型图场景的复跑入口及未通过账本见 [验收索引](../../../../scripts/notion-skill-graph-acceptance.md)。该索引不将旧包或受控结果升级为当前包的真实模型通过。

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

自检拒绝oracle暖化、隐藏/改名本地副本、猜名、错误ref/hash/scope/snapshot、强制叶子、错误kind、预置正文、资源缺失、HTTP200许可消息、空final、重复provider正文、缺ledger/进程退出等假阳性。真实模型先用 `magpie/group/flash-free`，本次实际不可用才用 `magpie/group/worker`，失败原件保留；无可用授权模型标blocked。

CLI/source、实际Notion、真实模型、原生UI、安装产物分栏。旧AH-560、受控provider、单纯schema和编译不代替图验收。证据落checkout外，按run追加并校验hash；清理只处理自有scratch/process/fixture，unknown需要的原operation状态不回收。修改实现时同时给上表对应ID补真实命令与观察结果，不把本地图本身当实现完成。

## SC21 C/D 普通意图与介绍

`scripts/verify-pi-notion-model-cache.mjs --intent-config` 复用本 Skill 的 graph observer、RPC、SDK source ledger、完整正文与资源证明、生成文件检查及 owned exercise。旧 A/B 和旧 custom cache 矩阵保持原入口；此分支不新建总 runner。冻结配置绑定独立安装包、runtime、实际 Pi、全部参与的 harness、生产 Default View 元数据和私有正文 oracle。当前早期反馈为四个独立冷入口各 n=1，最多三次必要续问，每次 300000 ms，仅 `magpie/group/flash-free`，无 fallback、自动重试或失败后续问。

| 入口 | 实际动作和成功条件 |
| --- | --- |
| C `$poteto-mode@notion 介绍下 create-verification-skill` | 显式根和完整 Requires 在首次 provider 中各一份；目标由 native `read` inspect 后完整进入 provider，不能激活目标工作流。普通续问复用原交付；明确再次读取必须有该 turn 自己的真实完整 read 回执，不强制已有固定正文重新访问来源。 |
| D 普通命名介绍 | 原句不含 `$`。只能从实际已展示的目录或 `notion_list` 发现引用，observer 不预植私有目标；介绍读正文、不 use 执行工作流。独立重启后恢复同一实际 session 的续问必须复用已交付内容。 |
| D 自然任务 | 原句不含目标名、准确 ref 或答案。模型实际读项目、自主选择并 use，根与 Requires 完整交付；最终输出须包含路径明确、内容完整的验证 Skill 文件。原生成物 helper 保存文件并单列执行其中一个允许的 owned 应用验证命令；仅计划或模型声称已验证不通过。 |
| D 闲聊 | 有相关非空回答，Skill/资源正文和激活均为零；允许目录在后台运行，不阻塞首 provider。只有完整 source observer 起止、逐 HTTP attempt、EOF 和 host close 齐备后才能报告成本。 |

四个入口均使用真实生产默认名单，source 省略 `command`、`default_view_id`、`profile_id`，`prefetch:false`；不得换成 A/B root-only View 或删减可选项。冷首轮 `pending` 合法，后续普通 turn 必须验证 ready 的完整 owner/name/description 集合。D 初始 observer 的发现集合为空，实际目录交付才授予可读 ref；私有 oracle 和介绍事实不进入提示、guidance 或 consumer cache。冷启动原生 `/skill` 菜单的宿主边界单列，不作 C/D 就绪条件。

~~~bash
node scripts/verify-pi-notion-model-cache.mjs --intent-config /absolute/frozen-cd-config.json --intent-action doctor
node scripts/verify-pi-notion-model-cache.mjs --intent-config /absolute/frozen-cd-config.json --intent-action run
node scripts/verify-pi-notion-model-cache.mjs --intent-config /absolute/frozen-cd-config.json --intent-action review --intent-evidence /absolute/pi-intent-evidence --intent-review /absolute/independent-review.json
node scripts/notion-skill-graph-model.mjs evidence --evidence /absolute/pi-intent-evidence/C-introduce
node scripts/notion-skill-graph-model.mjs cleanup --evidence /absolute/pi-intent-evidence/C-introduce
node scripts/notion-skill-graph-model.mjs evidence --evidence /absolute/pi-intent-evidence/C-introduce
~~~

对每个已运行 case 分别执行 Evidence→Cleanup→Evidence，保留 raw provider、RPC、source、实际 final、失败和文件 hash。`run` 的技术成功只返回 `review_required`；独立语义评审逐 turn 绑定 final SHA，介绍还绑定准确源正文 SHA 和真实答案片段，检查意思、必要事实和无证据的执行声称。语义评审不能补造缺失的正文交付或动作。模型计划生成与控制器随后执行的 owned exercise 分列，不能声称模型已自主执行。

SDK 取消只沿既有严格断言结算 metadata `list`：被动 native `session_shutdown` 与 SDK 起止同 PID，时间位于同一 monotonic 闭区间，完整 metrics/trace/EOF 均在；该回执不算 ready 目录。缺失账本、null metrics、未知正文归属仍是 observation-incomplete。任何 source write 必须另有 Records retention/adoption 与业务写入归因，不能仅因为 operation 是 use 就放行。

改前旧入口拒绝 `--intent-config` 和私有 D seed 负例保留。`--discovery-only true` 的原 `notion-skill-graph-observer-smoke.mjs` 实驱实际 Pi、受控 HTTP 和显式 custom source：首请求无正文，真实 list 元数据先于 read、正文全文进入 provider、未读 Requires/Member。该受控证明不能代替生产 SDK、真实模型 C/D 或正式 SC21 全矩阵。

2026-11-05 的 `85888`／Pi 1.5／flash-free 实模在 C 与 D 命名介绍均出现 `list → notion_use`，没有目标的 native inspect/read；两个首轮自然终局后的续问均未提交。原件在 `~/Library/Logs/pi-context-broker/AH-617-20261105/cd-early-feedback-10ot7qk8/pi-intent-evidence-henERH/`。实际旧 schema 已明确 `read.path` 支持 Notion ref，旧 use 说明也已要求介绍用 read，不能把失败解释成缺少工具。D 首请求无根正文仍误选，不能只归因于 poteto 长正文或目标作者规则（目标规则在误选后才进入模型）。

这组反馈触发一个独立措辞候选：把 read 的 Notion inspect 能力提到描述首部，将 use 的目的明确为应用所选规则，消除 guidance 中“选择来介绍”和“选择来应用”共用 load/selected 的歧义。仅改三处模型可见说明；不按自然语言关键词拦截或转换 use，不增加工具，不改作者正文、原 prompt、oracle 或旧样本。按原 C/D 入口和新独立安装身份检验实际选路后才能判断是否有收益，同时保留 D 自然任务自主选择并 use、显式 use/read、Requires 完整、普通续问复用、固定资源与本地/batch read 的既有反例。受控回归或文字变清楚不证明模型行为已修复，工具 schema/guidance 的新成本也应实记。

## NG10 / NG13 原生发现与显式准备

默认 View 只决定初始目录。按 `agent-cli-ref-20261105`，Pi Agent 从根 Members 目录、原生正文中的准确 ref 或 `notion_list` 元数据结果选择 View 外的受管 Skill / File。`notion_list` 不读正文、不注册 loaded；原生 `read` 用于 inspect 和精确资源，顶层 `notion_use({ref:string|string[],refresh?:boolean})` 准备根与完整 Requires 闭包。inspect 不把 Required 正文当已准备。用户显式 `$` 与 `/skill:` 沿同一 prepare use 协议；未匹配的普通用户字面引用保持既有 soft miss，而已选 Required 缺失、预算、权限或版本失败必须阻断 provider。

~~~bash
bun test packages/context-broker/scripts/host-prepare.test.ts packages/context-broker/scripts/native-read-session.test.ts packages/context-broker/scripts/shared-notion-adapter.test.ts
bun packages/context-broker/scripts/input-guard.test.ts
bun packages/context-broker/scripts/source-runtime.test.ts
node scripts/verify-notion-integration.mjs run --mode installed --host pi --package /absolute/frozen-broker.tgz --skill-graph true --command-json '["/absolute/node","/absolute/installed/ntn-skills.js"]' --graph-cli-source /absolute/notion-skills-cli --evidence-root /absolute/evidence
~~~

实际参数以入口 help / doctor 为准；不得将另一个源 checkout 或临时产物替换 manifest 中已冻结的安装包。当前默认 SDK Graph Gate 的 Pi 工具面为 `read,notion_list,notion_use`；controlled native-chain 另保留单 `read` 专项。observer 逐请求核对真实工具定义，metadata-only list 的结果须匹配实际 SDK listCatalog 结果，use 只接受已发现的精确 refs，自动 Required 不冒充 Agent 自主选中的 Member。所有场景保持 shell 禁用和三层冷目录；来源身份必须带 scope、canonical ID、snapshot、主文 bytes/hash 与 stable File ID。不可从裸名、同名替身、另一库或本地副本补齐。

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

观察端复用 `scripts/notion-skill-graph-model-evidence.mjs`，保留 public provider hook 与实际 wire payload 配对、私有 SDK result、短引用分支事件和源进程账本。默认 SDK 的 list/consume/read/read-resources 逐 operation 配对，CLI child 为零，缺失 metrics/terminal/result 不推断为零；code mode 内部正文不算顶层交付。trace 标明 `toolContract:"agent-cli-ref-20261105"` 后只按新 Pi 工具判定；未标该合同的旧 trace 才保留 legacy `skill_prepare` 解析。`notion_ctl` 是 deferred 管理入口，不进入默认模型 schema。这些 helper 的正反例与现有 graph tests 一起进入 `bun run test:verification`；受控通过仍不代替真实模型成功。

当前原生资源入口同时支持 scalar `read({path:REF})` 与 batch `read({paths:[REF,...]})`，REF 可为已实际发现的 canonical ref 或会话 `sr:R`。batch 必须用原始 SDK `read-resources` manifest/body、安装包自己的资源投影校验器和同一外层 toolCallId 对齐逐文件完整 span；不能从 details、summary 或部分文本推断已交付。错误 owner/pin、未发现的 ref、缺完整外层输出与部分正文均拒绝。资源文件数量、外层工具调用数量和内部 SDK operation 分列计账，一次 batch 不能冒充多次工具往返，也不能掩盖缺失文件。

Pi 默认 graph bridge 使用随包公开 SDK `consume`，同一内核验证完整清单、主文范围、身份、固定版本与 hash，Broker 核对选中身份后直接物化，不再逐节点启动 CLI read。资源通过同包 SDK 固定 `readSkill` 或 `readResources` 物化。显式 `source.command` 与 OMP 保留公开 CLI prepare + 逐 prepared node 固定 read 的兼容边界；上述 `--command-json` 命令验证的是该边界，不能代表默认 SDK。默认目录改用同包 SDK `listCatalog`，公开 operation=list，目录/正文路径都应为零 CLI children。显式 custom command 独立列账；超过默认分页大小时须证明遍历所有页，未验证前不宣称 SC23 全量迁移。旧直接加载与 Prompt 的完整 export receipt 不放宽。本轮独立 Node / Pi 路线与 hash 见 [运行时记录](../../../../packages/context-broker/docs/skill-consumption-runtime.md)。

安装 Pi + 受控 provider 的首次请求应含 root / Required 完整正文各一份、Members 正文零份。记录实际 tool input/output、完整 body hash、目录 ref、provider context 和源请求账本。native read 的资源 ref 必须来自公开目录/正文，旧路径带稳定 File ID 应解析到固定 owner snapshot 的正确路径。missing Required / budget / cancellation 时 provider 数量为零；RPC abort、new_session、EOF 与真正终端 Escape Stop 分开记录。

## NG15 分支选择图与正文回执

分支上的 `context-broker-selected-graph` custom entry 保存版本化 CLI graph lock，包含实际根、Required edges、scope 和精确 binding。已知目录、候选和后台预取不写该 entry。optional 第一次实际选择时才加入；正文是否仍在当前上下文由完整 hash/bytes/实际消息跨度证明，不能用选择锁或缓存存在推断 loaded。

SC04 的 branch-local C/S/R 表独立于 graph lock；已固定短引用不改绑，刷新创建新 S/R，兄弟分支不可互用。固定旧 pin 或非主文关系不能因 ID 相同而替换为当前候选。按需发现的 Pi `notion_ctl({refs:[...]})` 导出 S/R 的 canonical 精确证明（OMP 仍为 legacy skill_graph），消费端仍重新授权。SC08 另保存版本化 active receipt：完整 visible 证明加同轮未取消的 2xx headers 确认后才激活，inspect/ready 不激活；压缩移除正文后普通消息从固定 roots 恢复一次，不改写原始 JSONL。实际 SessionManager、RPC/PTY 与 SDK-Pi 证据均见运行时记录，状态层成功不等于真实模型成功。

### SC23：会话驱动的 View 元数据调用

`notion-skill-graph-session.mjs --source OWNED_STATE` 是显式 custom-command 的真实进程包装器。它允许当前 `ctl views`，并保留裸 `views` 的旧调用兼容；`ctl doctor`、`ctl cache identity` 的原边界不变，其他管理／作者命令在启动 CLI 前拒绝。包装器不重复实现 CLI 参数解析，多余位置参数仍由独立安装的 CLI 拒绝。此迁移不启用预取，也不把 custom-command 结果算作默认 SDK 验收。

定向回归复用 `node --test scripts/notion-skill-graph-delivery.test.mjs`：实际 `--source` 子进程必须原样转发 View 参数，旧 alias 可用，未知 `ctl sync`、operation、cache clear 和 create 不得启动 CLI。这里的 argv fixture 仅证明包装器协议，实际 View 数据另由安装包验证。

2026-11-05 原件在 `/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/sc23-session-views-gd93lzlk`。同一 `6464469d…` 安装包的真实 `listNotionViews` 经该包装器、随包 C6 CLI 和原 `notion-skill-graph-service.mjs` HTTPS fixture：修复前 `SOURCE_COMMAND_FAILED`，0 CLI children／0 HTTP；仅增加 `ctl views` 白名单后返回准确 View ID、name、database 和 data source。实际账本共 4 次 metadata HTTP、2051 响应字节，正文／写入／provider 均为零；裸 alias 返回相同 View，额外 `sync` 位置参数由真实 CLI 返回 `INVALID_ARGUMENT` 且无新增 HTTP。3 个 CLI child 与服务进程均实际退出，安装文件和驱动 hash 未变。11 项定向测试通过，原 10 pass／1 fail 保留。该小切片不声称重跑完整 A/B 会话矩阵或真实 Notion／模型。

### 分支选择与恢复驱动

~~~bash
CONTEXT_BROKER_PI_SESSION_MODULE=/absolute/installed/pi/dist/core/session-manager.js \
CONTEXT_BROKER_SESSION_EVIDENCE=/absolute/evidence/ng15 \
node packages/context-broker/scripts/session-selected-graph.mjs
~~~

该入口用实际安装 Pi 的 SessionManager、真实 Node 与其公开 append / branch / fork / compaction / open 方法，不使用产品测试 setter。保留独立子进程重启、原始 JSONL、导出的选择图与判定结果。先固定 root + Required 的 A；optional 在库已为 B 时第一次选择只锁自己的 B；fork / rewind 恢复所选祖先而非全部兄弟 entries。压缩移除完整正文后 loaded 为 false，A 的锁仍保留，重载仍用 A；新 session 用 B。

显式 `notion_use({ref,refresh:true})` 在完整准备、确切 File ID 与宿主输出预算全部通过后提交新的 scope 选择。失败保留旧锁。只在 provider 投影中替换已验证的过时/重复正文，原 native tool result、toolCallId、用户消息和 JSONL 不重写；修改跨度后仍保留其余有效回执的准确位置。按需 `notion_ctl` 导出当前选择和真实 delivery 状态，不进入默认 schema；旧 OMP 对应 skill_graph，不包含凭据、机器缓存路径或对话正文。未知 schema/compiler 版本与被篡改的版本向量必须报错。

Pi 的正常 prepare 模型结果使用[确定性投影](../../../../packages/context-broker/docs/skill-consumption-projection.md)，canonical graph、目录 hash、版本和物化证明在 `details.contextBrokerPreparation` v2 中。通用 graph/session 验收以独立 `skill-preparation-evidence.mjs` 校验 compiler、整份 content hash 及各源 span，再与原 CLI oracle 对照；不能从内部 details 的正文或空 loaded 标记证明模型收到内容。旧 v1 只按原格式读取，含新版 projection 的降级 v1 拒绝。正式 graph model gate 的当前驱动按独立 SDK result、分支短引用与 v2 span 验证；旧 canonical-only / CLI-wrapper 样本保持历史身份。迁移后的真实模型复跑未取得证据前，不能用受控路线替它报通过。

会话替换撤销旧 ctx：pending input 必须以 handled 结束，不能在 catch 中通知旧 UI 导致 Pi 回退为普通 prompt。生命周期取消不得调用已撤销 ctx 的 abort，也不能取消后一个提交；dispatch receipt 在真正 session 边界或原 consumer 确认前仍拦住重复提交。受控 Proxy 回归与实际 installed Pi new_session / EOF 结果分别保留，真正 TUI Stop 仍需独立终端证据。

### 实际 Pi 终端选择与 Stop

当前 Pi 1.4 的 Notion 目录异步完成，启动画面的 `[Skills]` 不能作为冷启动前置。原 PTY driver 先观察完整空编辑框和该 fixture 两次 metadata list 的实际成功退出，再以实际 `$` 候选和 Tab 接受验证目录已可用；前两步仍要求 provider 为零，不能由内部 metadata 回调代替实际候选。只等空编辑框就输入会落在 metadata pending 时段，原失败 `pty-c4-stop-j6_96xrz/broker-pi-graph-pty-sBq9K5` 保留。`escape-stop` 可以独立运行以验证当前取消合同。旧 `selection` 场景还要求 `/skill:` 原生菜单 Tab，Pi 的延后目录不会自动补入 startup 菜单，该子路径未通过时必须单列，不用 `$` 成功覆盖。

2026-11-05 的 fail-before 位于 `/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/pty-c4-kywlib7c/broker-pi-graph-pty-zcJfgx/`：同 `66a64e3b` 包在第一步等待旧 startup Skill 行而超时，provider 为零；Ctrl+O 的只读诊断原件另存 `startup-ui-probe/`，展开后仍无同步 Notion native 菜单。原失败和旧包历史通过均保留。

同一证据根下 `pty-c4-stop-ready-7qr_byjj/broker-pi-graph-pty-ocu8dX` 已实际完成 `$` 候选、Tab、Escape、CLI 130 和重试，但准备预算不可见，整体仍为失败。Pi 1.4 在运行中把 `sendMessage(..., {triggerTurn:false})` 延后至本轮结束；延后 context 准备现在用公开 `ui.setWidget` 立即显示同一预算和 Stop 提示，终结／会话替换清除 widget。只有仍属于当前 run/generation 且原生 signal 已取消的 context 才正常结束；真实获取错误仍 abort 并报错，旧 ctx 不可被重新读取或用于取消新提交。

修复的独立包 `d5dc05bf79a19b3f7983e6e9ce80724b1513a0293c679b65b3123f87c689ab8e` 使用 C4 CLI/SDK；`pty-feedback-fix-9h0je71c/actual-pty/broker-pi-graph-pty-YT6GPK` 的 `escape-stop` 通过。实际终端可见 8 nodes／depth 4／8192 instruction bytes／131072 context bytes；Escape 后所有 prepare 子进程退出 130、provider 仍为零、widget 消失，同会话重试的 root 与 Requires 完整且各一份、Members 为零，Pi 自然退出 0。Pi 自身保留普通 aborted 提示，Broker 不再追加 SOURCE_CANCELLED 扩展堆栈。此为实际 TUI + custom-command + 受控 SQLite/provider 的证据，不是默认 SDK 真实 Notion 或模型验收；后续 C5 统一候选须保留自身身份和受影响验证。对应 `host-prepare`／`session-active`／`native-read-session` 44 项、input guard 和 `check:broker` 均通过，原失败日志不覆盖。

~~~bash
node scripts/verify-pi-graph-pty.mjs doctor --package /absolute/frozen-broker.tgz --command-json '["/absolute/node","/absolute/installed/ntn-skills.js"]' --cli-source /absolute/notion-skills-cli
node scripts/verify-pi-graph-pty.mjs run --package /absolute/frozen-broker.tgz --command-json '["/absolute/node","/absolute/installed/ntn-skills.js"]' --cli-source /absolute/notion-skills-cli --cases selection,escape-stop --evidence-root /absolute/evidence
node scripts/verify-pi-graph-pty.mjs evidence --evidence /absolute/retained-run
~~~

入口实际安装冻结的 Broker 包，核对已安装 Pi 的 @earendil-works 身份，使用独立 HOME / 配置 / session / Broker / CLI 目录。实际 PTY 输入 Tab 接受 $ 和 /skill 候选；候选与接受动作正文 I/O 为零。提交后完整 root / Requires 各一份、Members 零份；仅 read 工具可用。Escape 场景先等真实 CLI HTTP 等待和源子进程启动，再发送实际 Escape 字节，检查 CLI 130、所有源后代退出、provider 零次和无迟到正文，随后同会话重试。准备预算和 Stop 提示必须在实际终端可见。

保存 raw terminal.ansi、逐步 screen.json、实际按键、provider body bytes/hash、source request ledger、session JSONL 与自然退出证据。2026-11-03 的 v3 安装包两场景通过，运行目录 ng15/broker-pi-graph-pty-QFA9Nc；之前 pw7jMY 的 Escape 功能通过但预算隐藏，整体 failure 保留。实际 Pi + 受控 provider / SQLite 输入证明宿主终端边界，不能代替真实模型选路或生产 Notion 验收。清理命令只将该 manifest 所属 scratch 移到系统 Trash，保留证据目录。

最终 entry-ready runtime 已用 v4 + CLI7 重跑同两场景，ng15/broker-pi-graph-pty-SF1Awi 的 selection / escape-stop 均通过且自然退出。实际 Tab、预算行、Escape、CLI 130、provider 零次及同会话重试继续由原始终端和进程账本证明。v5 仅修正文档，下面的逐文件等价回执将这份实际执行结果关联到 v5；没有把它描述为 v5 重跑。

## NG18 宿主清单与按需资源

完整 prepare / consume 清单的每项必须含 path、bytes、sha256 和准确固定 ref；shared Files 还需同 owner 的稳定 File ID/page 绑定。Pi 默认 consume 的主文范围、scope、record、snapshot、version、ref 和 hash 由共享合同严格验证；custom command / OMP 的主文 fixed read 继续逐项与 prepare 比对。初始宿主只保存 main 到 entries/SNAPSHOT/tree，外部 .broker-entry.json 明确 projection=entry、manifest_complete=true；它不能被旧完整 .broker-snapshot.json 消费。local_files_ready 与 materialized_paths 只反映逐文件验证结果，不等于 loaded。

原生资源 read 从清单选确切项，Pi 默认由同包 SDK `readSkill` 取得字节；custom command / OMP 仍为自有 CLI `read REF --output NEW_STAGE`。两者比较同一完整公开回执与真实文件 SHA/bytes 后再发布。未选大资源不出现；二进制保持原字节，物化成功不自动等于完整文本进入 provider。错误 File ID、跨 scope、旧路径无身份、坏 hash、取消和不完整输出必须失败，不猜名或退回 current。嵌套 main 可读同一树中其他目录的文件；仅有清单不能绕过 native read 的当前授权边界。目录和缓存命中仍可能产生权限 Metadata 请求，零 resource chunks 不等于零 HTTP。

实际 tool result.details.contextBrokerResource 保留准确 ref、id、scope、snapshot_id、version_id、path、file_id、bytes、sha256、materialization 与 delivered_complete_text。只有完整工具文本匹配字节/hash 才能标 delivered_complete_text；资源回执始终 loaded:false，不代替主文 contextBrokerRead。会话替换后晚到结果不留 receipt。host alias 旁的 .broker-host-index.json 只证明原始/发布 main 的身份和 hash，projection=host_index、loaded=false，不能作完整快照或上下文投递证明。

~~~bash
bun test packages/context-broker/scripts/notion-entry.test.ts packages/context-broker/scripts/host-prepare.test.ts packages/context-broker/scripts/native-read-session.test.ts
CONTEXT_BROKER_GRAPH_CLI=/absolute/installed/ntn-skills.js CONTEXT_BROKER_GRAPH_CORE=/absolute/notion-skills-cli/packages/core/src CONTEXT_BROKER_GRAPH_EVIDENCE=/absolute/evidence/ng18 bun test packages/context-broker/scripts/prepare-adapter.test.ts
~~~

2026-11-03 的 CLI6 / 真实 Node + SQLite 适配测试通过主文、Required、BOM/CRLF、文本/二进制资源、固定版本与未选 256KiB 资源不落地；18 项宿主边界回归通过。保存 ng19/partial-cli6-adapter.log 与 partial-host-boundaries-final.log。输入守卫原先只在 export 注入“资源缺失”的夹具不能覆盖新的 main-only 准备，保留该旧 full-export 负例，另补实际 read has_more=true 的准备阻断；首次旧断言失败日志保留。最终安装 Pi 的 native-chain 与真实 Notion 跨机 partial 分栏验收，不把上述受控结果代替它们。

最终 CLI7 的五项真实 Node/SQLite 适配及 59 个断言全部通过：ng18/broker-v4-tyjIGw/adapter-cli7.log。Broker 完整包 test 退出 0，85 项 Bun 回归通过；需安装 CLI 的五项另外按前述入口执行，不能把默认 skip 当通过。v4 的实际安装 Pi 16 场景、真实 SDK/受控 HTTP observer 分别保存在 pi-context-broker 的 ng20/broker-notion-evidence-l27VCB、broker-notion-evidence-s1bZ8E、graph-observer-http-V6XkFD；其中实际 root→View 外 Member→稳定 File ID 旧路径资源、host_index 与 entry receipt 均已验证。RPC abort 仍按宿主限制单列，不能替代实际 Escape。

文档修正版 v5 为 ng18/broker-v5-n6LhcK/pi-context-broker-0.0.2.tgz，SHA-256 为 0f148de305b95b0faf1b4e7d9e8ab862b00f4d03cd69f20f1d7d76afed84d1c5。v4/v5 独立安装共 62 个包文件逐字节比较，仅 CONTRIBUTING.md 改变，其他 61 文件相同；src/dist 的 47 个运行文件、package.json、CLI7/CLI8 输入和三份 builtin Skill 均有哈希证明，见 installed-equivalence.json、v4-v5-runtime-equivalence.json。v4 的实际执行证据据此关联 v5。后续 SDK 病例暴露的 lazy 资源 OS 别名修复使用独立 v6；v5 的等价证明不覆盖这次产品变更，正式模型 Gates 和日用切换须绑定修复包的新 identity。

Graph harness 2 将源码版本/hash 写入 Doctor、result 和 cache fingerprint；完整 search/prepare 输出按原 toolCallId 与实际 provider 消息核对，并验证 root/Required 每次最多一份且保持所选版本。owned `PATH/ntn` 与旧 `NTN_SKILLS_NTN_BIN` trap 只作用于隔离宿主，保留旧 CLI/login 调用记录，pass 要求零调用。首轮真实 A `ng14/final-package/graph-model-A-SQ1pSW` 保留 failed，不授权 fallback；完整 Router/Members 已进入 provider，旧 harness 却隐藏了产品合法工具。新工具面的 v5 受控 SDK 证据是 `ng14/harness-v2/graph-observer-http-gr7I2n`；`graph-observer-http-i3KRMi` 的未物化资源 `/tmp` alias 失败独立保留，须用 `scripts/notion-skill-graph-observer-smoke.mjs --resource-location alias` 对修复包复验。受控 provider 证据不能替代正式 A/B。

v6 同病例已在 `ng14/harness-v2/graph-observer-http-M4pV6s` 通过：真实安装 Pi、随包 CLI、实际 SDK 七次请求；三工具定义真实可见，完整 search/prepare JSON 按原 toolCallId/bytes/hash 进入 provider，root/Required 各一份、初始 Member 零份；尚未物化的资源经 `/tmp` alias 读取完整 70 B/SHA，外部文件与 shell 被拒，两个旧 ntn trap 零调用。observer 未改写工具输入。harness 汇总 SHA 为 `c95c7fead6e1c133f79ae565496dbf6c71c4b07d431774abab01d968f8634c2f`。v6 包 `ng18/broker-v6-ff353lls/pi-context-broker-0.0.2.tgz` 的 SHA 为 `1fa9127cfa9f0162d76dabea383d72cbded490234cc66f4b1a5cb8903c8db5d6`；62 个安装文件与 tar 全等，相对 v5 仅 `src/host-skills.ts` 改变。`installed-identity.json` 和 `package-identity-boundary.json` 记录完整差异、48 个 runtime/manifest 文件及错误旧包配对反例。正式 A/B 与原 15 个真实模型用例另按新包留证。

Broker7 随包 CLI9 修复全库 discovery 将共享管理表误作 legacy Skill 的问题，Broker 产品源码不变。包为 `ng18/broker-v7-_kp72c6m/pi-context-broker-0.0.2.tgz`，SHA `2a818890602d0e408c5175ed8e43691b50dbccd0357503a5fdf8bdb9f68a0455`；62 个安装文件逐字同 tar，v6→v7 仅 `dist/ntn-skills.mjs` 改变。48 文件 runtime/manifest 汇总 SHA 为 `37181275839f42f04ef9d163991b3d03a4bad4ee96b8e1d8d598c7e31f2f5d8e`，错配 v6 archive 的反例继续被拒。首次 npm offline 因 redis metadata 未缓存的失败保留；新独立 consumer 安装与 schema prepare / operation list 均通过。

最终同包 SDK 证据 `ng14/harness-v2/graph-observer-http-hV3lRI` 使用尚未激活的真实日用候选 `/Users/yoyo/.local/share/context-broker/installed/ah561-2a818890602d/node_modules/pi-context-broker` 及其 embedded CLI：七次实际请求、三工具、完整输出 hash 链、alias 资源 70 B、外部路径/shell 拒绝、旧 ntn traps 零调用均通过。harness SHA 仍为 c95c7fead6e1c133f79ae565496dbf6c71c4b07d431774abab01d968f8634c2f，未重写工具输入。共享生成物同步回执是 ntn-skills evidence 的 `ng05/shared-runtime-assets-GKA60n/receipt.json`（9 文件、9 public checks；受保护 Tern completion 不变）。正式 A/B 与原 15 用例仍按实际模型证据验收。

Graph harness 3 将整篇正文生成的正则改为 literal 扫描，保留 raw/HTML/JSON 三种表示、同起点最长匹配、非重叠计数与 assistant/model 引用排除。before-provider 观测异常必须写 `observer-error` 并使 Gate 无效；实际 transport 仅接受已核验 payload，并记录 wire-body SHA。不得把 hook 抛错后的真实 HTTP 错写成 provider 零次，也不得以观测故障授权模型 fallback。

冻结回执 `ng14/harness-v3/freeze.json` 对应 harness SHA `565d414f70bcfb1742ba94a04efb7f4dad218fc8a3f9324f85eb7560c905d4b6`。17 项回归通过；实际日用候选 Broker7/embedded CLI9 的 `graph-observer-http-RJRIM3` 通过 56,423 B 主文接缝，7 次 provider proof 与真实 server wire SHA 逐次匹配，root/Required 完整各一份、三工具、alias 资源 70 B、外部路径/shell 拒绝、ntn traps 零次。legacy 首例可经父进程冻结的 `toolSurfaceFile` 保持单 read，仍要求同样 provider proof；A/B 默认三工具不变。产品包、TASK、oracle、model、timeout 与预算均未修改。

`ng14/harness-v3/prior-attempts.json` 独立保存旧样本分类和原文件 SHA。旧 B `final-v7/graph-model-B-O04HQP` 的 8 次 before-provider hook 因 `Regular expression too large` 失败；虽有 8 次真实 HTTP，却没有可验证的 provider payload，属于 harness-invalid，不能从 session 离线伪补。旧 A `graph-model-A-eXJd7p` 有完整 20 次 provider/transport、46 次 tool call、零 hook 错误，保留真实任务失败。两者均不触发 availability fallback；新版受控 SDK 通过不能替代真实模型 A/B 复验。

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

2026-11-03 的真实 owned 图、独立 CLI7、同一 A root + Requires 的一组对照通过，见 ng19/retained-prefetch-MnBaye/manifest.json。显式预算为 1 节点、64KiB、depth 0、45 秒 owner 上限、rateShare 0.25；保留全部公开回执和真实 HTTP trace。

| 一组固定版本对照 | 前台等待 | 预取加前台总时间 | 请求数（不含 manifest restore） | 响应字节 |
| --- | ---: | ---: | ---: | ---: |
| 零预算 | 4.832 秒 | 4.832 秒 | 9 | 37,730 |
| 显式预算 | 3.999 秒 | 9.782 秒 | 13 | 52,821 |

每条独立 manifest restore 另为 11 Metadata + 1 retained-body 请求；该一次样本中的预取 retained 响应 4,257 字节全部用于随后选择，未用 instruction/retained-response 字节均为零。所有阶段 current-body、远端写入、provider 均为零，两路 scope/pin/main hash 完全一致。前台局部等待缩短不能抵消此次增加的总耗时、Metadata 与响应字节；这不证明普遍收益，默认保持零预算。

## Graph harness 4：真实广告与不可知归属

观察器将实际 provider 中已经完整提供的 native 主文路径与同一 scope/owner/snapshot 的 manifest 核对；wrapper 省略 `file_id` 时只能匹配唯一条目，不能猜其它路径。目录中的 unpinned ref 只证明稳定候选身份，最终消费仍须命中 oracle 的 pin、File ID、正文 SHA 和字节数。路径穿越、改 owner/版本/File ID 和 assistant 伪造广告均拒绝。

未知正文归属独立标为 `observation-incomplete`。配置 `retainedSourceProofRepo` 后，仅在 Pi 退出后使用同 CLI Effect 引擎取得已经观测到的 immutable bundle metadata；独立 oracle 的进程与 HTTP 账本不混入 consumer。纯离线 verifier 校验两层 canonical SHA、owner 与 chunk 清单，随后只按同一实际 CLI receipt 中出现的 bundle/Records DS 关联归属。ZIP 中已下载的其它资源不算 native read、provider 正文或 loaded。

实际 Pi system `<docs>` 段广告的自身通用帮助文件使用共享 `notion-pi-help.mjs` 校验：真实 executable/package bin 确认规范根，只准存在 regular `.md` 与完整合法帮助读取中的包内 Markdown 引用；拒绝内部 symlink、未广告文件、越界及拼错包名。帮助回执独立为 `host-help`，不能满足任何 Notion Skill/resource 断言。H3 原 4 次正确帮助路径与 1 次非法路径的离线复验在 `ng14/harness-v4/actual-pi-help-boundary.json`。

`ng14/harness-v4/combined-home-final.json` 保留 78 项组合回归。H3 的原 result/trace/provider 文件全部保留，`offline-h3-Fe0Sip/result.json` 只派生 immutable 归属：A 的 7 个、B 的 2 个未知 retained 请求均得到唯一 owner，consumer HTTP/read/provider 数量不变，新增 HTTP 为零；两者仍因真实未消费所需正文而失败。文件解析只修明确的编号标题/长外层 fence；B 的同长嵌套 fence 仍报告歧义，A 的纯规划仍是零文件。

H4 最终源码聚合 SHA 为 `a58708b78cb9c4f4029f9c22b81478eccfd0a506828d4a24b9bbc181d4915ddd`，冻结回执 `ng14/harness-v4/freeze.json` 的 SHA 为 `3728fe47eee9d1cdd71d5f88f88e49c8b9ffc04109248add3f222ec46e5b31f1`。实际 Broker8 日用候选与随包 CLI9 的 `graph-observer-http-ejGbJE` 通过 9 次 provider/wire 哈希配对：56,423 B root 完整 prepare/provider、Required 各一份、已广告 `~/...` 原路径的 115 B Required 完整 native 读取、4,080 B Pi 帮助独立回执、三工具完整输出、70 B alias 资源、外部/shell 拒绝与旧 CLI traps 零调用。受控结果不冒充真实模型 Gate。

`sdk-attempts.json` 保留 `uGldin` 的观察器 HOME 前缀漏处理和 `66q5vw` 的不恰当测试组合：Pi 对 56,423 B 文件按正常 50 KiB 页限制截断，不能算完整读取。最终将大正文投递与短 Required 的完整原路径复读分别验证，产品、TASK、oracle、model 与 timeout/budget 均未修改。

### H5：已完整读取的 host-index 主文与相对资源

H4 的 `ng20/pi-cache-evidence-y6izS4` 失败保留：主文完整读取后，真实正文链接对应的 index 资源在 sequence 29 被共享观察器误拦。H5 只在实际广告的 index 主文完整读取成功后，用 `.broker-host-index.json` 与已验证 entry manifest 绑定 scope、owner、snapshot、main File ID/hash 和 `manifest_id`；只允许该正文实际出现且同一 manifest 声明的相对资源。资源最终读取仍须匹配精确 File ID、pin、SHA 和字节数。提前读取、部分主文、未提及 sibling、篡改身份/manifest、raw `..` 和内部 symlink 继续拒绝。

新增回归红绿与 80 项组合结果在 `ng14/harness-v5/{host-index-before,host-index-after,combined}.json`。实际 Broker8 日用候选与随包 CLI9 的 `graph-observer-http-g5KmVF/result.json` 通过 10 次 provider/wire 配对：实际广告 index main 完整 441 B → 确切绑定 → 正文相对资源 77 B；原三工具、Required 唯一正文、帮助独立回执、Optional 资源、外部/shell 拒绝和 legacy traps 零调用均保。首个受控 SDK `CAjyRg` 因 runner 对重复主文 provider 去重的错误假设而失败，原完整 tool 回执与失败均保留，后续断言同时核原 tool 正文和 provider 已有正文。

H5 八文件聚合 SHA `83576bdd32d0e1c3419da8665adf035a0e3b456091dd6e21c46f268ff3532f19`；冻结回执 `ng14/harness-v5/freeze.json` SHA `9057024b67af5540810739218c91c6c9d686cc0b262057804f87fcb13f77e226`。本次仅观察器/受控夹具/验收文档变化，没有产品、任务、oracle、模型或预算变化，也未自行运行真实模型。

### H6：已发现资源的可选身份字段

H5 原冷样本 `ng14/final-h5/graph-model-A-G3kOyT`、`graph-model-B-ti3uRk` 保留 failed。独立诊断 `ng20/h5-gate-diagnosis/diagnosis.json` 保存 A 三次实际输入、已发现目录、public read 和最终 native read 的完整身份链。三个资源的 owner/current path 已实际发现，产品成功补齐 session pin/File ID，H5 却因输入省略可选 `file_id` 而误拦。B 混接 record directory/snapshot 与猜测路径仍是实际输入错误。原 300000ms timeout、缺成功 final 和 collector 不完整均保留；pmset 合盖睡眠与样本及 collector 延迟重叠，不由这些失败授权模型 fallback。

H6 对省略 File ID 的请求要求实际已发现的 same-owner/current manifest path，并唯一解析 scope、owner、path、snapshot、File ID、SHA、bytes。显式 File ID 保留公开的稳定身份语义：旧显示路径可以不同于 current path，但该 owner/path/File ID 组合必须已由真实正文或目录提供，且由 verified manifest 唯一绑定；未发现的路径不能借用正确 File ID。显式 pin/身份冲突、scope/pin 歧义、未发现资源与 B 混接 native 路径继续拒绝。call 保存完整 expected 身份，result 只接受同一身份且完整物化的正文，不能因字节相同换绑 File ID。metadata-only `skill_prepare` 发现合同不变。

回归在 `ng14/harness-v6/`：`references-before.json` 记录 H5 上新增七例全部失败、旧两例通过；`stable-alias-before.json` 保留初版严格 path 比较误拦既有 File ID alias 的失败。最终 `combined.json` 为 88/88，包含原 80 项及八个新增病例。原三条无 query 输入、任选省略字段、已发现旧路径 alias、未发现 alias、显式错误 pin/File ID、scope/pin 歧义与调用后身份漂移均有独立断言。

同 Broker8 日用候选和 embedded CLI9 的两个实际 SDK run 均通过：`graph-observer-http-NGwP8n` 使用实际发现的旧显示路径和稳定 File ID；`graph-observer-http-Hgm7jA` 从实际 prepare.directory.files 取得 canonical ref 后省略 snapshot/file_id。入口为 `scripts/notion-skill-graph-observer-smoke.mjs`，分别使用 `--resource-location ref` 和 `--resource-location unqualified-ref`，都保留 `--host-index-resource true`。每次各 10 对 provider/wire、Member 资源 70 B 完整 read/provider、index 主文 441 B 与相对资源 77 B、完整工具输出、外部/shell 拒绝、legacy trap 零调用、14/14 source close 和 Pi observedExit。此处为受控 provider 证据，不代替真实模型 Gate 或 legacy。

H6 八文件聚合 SHA `293c5d2718f326b43143e68a9623413d31386eae7413546e4713fcabd491726d`；`ng14/harness-v6/freeze.json` SHA `b4e28f3bdc6720d87ed155dbb28ebec18663263ad14f954b9ed297f1ee85d48c`。产品、TASK、oracle、工具面和预算未变，原 H5 Gate/matrix 共 70 份证据哈希不变。Tern 工作字节保持原 SHA，既存 stage 差异由 root 的独立恢复回执记录并保留。

### H7：公开主入口、原生 wrapper 与实际作者时点

H6 原结果保留。独立 `ng20/h6-gate-diagnosis/b-and-native-location.json` 证明 B 的首次 blocked prepare 使用了已公布的 poteto/unslop owner，合法省略 `/SKILL.md`，被观察器自建的窄 URI 语法误拦；legacy 的 native main 路径则已在真实 Pi user `<skill location="...">` 中完整投递，并具备 delivery/public read/manifest 身份链。原 legacy initial 仍为 10 pass/1 fail。A 的 `ng20/h6-a-eager-review-JuV3Ra/diagnosis.json` 证明 11 次假 eager 来自较晚的 observer admission：实际 assistant 已 authored read，Broker 随后 await prepareRead，observer 才记录调用。独立派生移除这 11 次误判后仍为资源覆盖失败；A/B 成功 final 有八组文件标题，却没有生成 Skill 主入口。原失败与证据不覆写，也不据此把模型任务改判通过。

H7 每个 observer 调用方（含 legacy）直接注入实际 installed extension 同目录的 `parseNativeReference`，删除复制的窄语法。省略主路径只可按实际已发现 owner 和已验证 metadata 的唯一 scope/entrypoint 解析，不从 basename 猜 owner，也不硬编码 `SKILL.md`。显式 pin/File ID 与 H6 已发现 alias 边界继续精确核验。Pi native wrapper 的 location 必须来自真实非 assistant provider 内容，且完整主文与 loaded delivery receipt、manifest、公有 read 的 owner/scope/pin/File ID/hash/bytes 一致；assistant 引用、部分正文和身份冲突均不放行。

`message_end` 到达时记录真实 authored tool call、call ID、原始参数与 hash；只有后来 allowed call 和完整 read/prepare 身份均匹配，归属判断才使用该较早时点。admission 原时点仍保留，不拿 message 创建时间回填。未 authored、参数/身份错配和真正早于作者选择的 source read 继续失败。legacy 新增显式 `--case cold-native-command`，复用原 boot/turn/assert/cleanup，标记 targeted 单例且与 resume 互斥；默认 initial11 与 updated6 不变。

同轮产物收集器识别明确的“文件路径”标题，将 owned project 内绝对路径规范为相对路径，正文逐字保留；越界、同长度嵌套 fence 歧义、缺 Skill/frontmatter 和缺引用资源仍失败，TASK 与产物达标要求不变。`ng14/harness-v7/` 保留 observer 红例 4 fail/2 pass、collector 红例 2 fail/3 pass，最终 `regression-final.json` 为 96/96。

实际 installed Broker8/CLI9 的 SDK `graph-observer-http-PUEbMb` 与 `graph-observer-http-wutwR7` 各通过 10 对 provider/wire。前者完成 native command 主文 389 B 重读、provider 一份正文、裸 owner prepare、authored→真实 prepareRead→late admission 链和省略 query 的 canonical resource，15/15 source close；后者保留旧显示路径/File ID alias 与 host-index 相对资源，14/14 source close。两者均有 Pi observedExit，旧 CLI traps 零调用。

H7 最终九文件聚合 SHA `b43eeaef8f76b5bf5c97eab4fd10de3367321d1fa5282dde423119e1958910f2`，`ng14/harness-v7/freeze.json` SHA `92c369b047339eb1388cb7081890212e539616d074dada0fdb90427849155cd4`；installed parser 精确路径及 SHA `a68207cd5163e85f68c0bb0de749cca5ed146581f7b098af9cc8245beb3f9a34` 一并绑定。两 SDK 原 aggregate `c0165eb3923b887a1dd62fa85b11d3794363f0216532992cd79b4cf14074729d` 不重写，随后唯一 helper 变化为 collector；`sdk-project-boundary-final.json` 证明 SDK 调用的创建/检查项目函数逐字不变。两份独立 review 无阻断项。产品、TASK、oracle、工具面、预算和 Tern 工作字节未改；受控证据与真实模型 Gate/legacy 结果分开报告。
