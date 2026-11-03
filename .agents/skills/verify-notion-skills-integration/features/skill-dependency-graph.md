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
| `reads` | 原生模型tool call及完整read receipt，包含origin/tool/ref/logicalId/scope/snapshot/sequence/content/sha256/complete；逐字匹配独立oracle。 |
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

## NG10 / NG13 原生发现与显式准备

默认 View 只决定初始目录。Agent 可以从根 Members 目录、原生正文中的准确 ref 或 `skill_search` 元数据结果选择 View 外的受管 Skill / File。`skill_search` 不读正文、不注册 loaded；`read` 使用 inspect，`skill_prepare({roots,purpose:"use"})` 才准备根与完整 Requires 闭包。inspect 不把 Required 正文当已准备。用户显式 `$` 与 `/skill:` 沿同一 prepare use 协议；未匹配的普通用户字面引用保持既有 soft miss，而已选 Required 缺失、预算、权限或版本失败必须阻断 provider。

~~~bash
bun test packages/context-broker/scripts/host-prepare.test.ts packages/context-broker/scripts/native-read-session.test.ts packages/context-broker/scripts/shared-notion-adapter.test.ts
bun packages/context-broker/scripts/input-guard.test.ts
bun packages/context-broker/scripts/source-runtime.test.ts
node scripts/verify-notion-integration.mjs run --mode installed --host pi --package /absolute/frozen-broker.tgz --skill-graph true --command-json '["/absolute/node","/absolute/installed/ntn-skills.js"]' --graph-cli-source /absolute/notion-skills-cli --evidence-root /absolute/evidence
~~~

实际参数以入口 help / doctor 为准；不得将另一个源 checkout 或临时产物替换 manifest 中已冻结的安装包。显式自定义工具场景的 Pi allowlist 应包含 `read,skill_search,skill_prepare`；仅 `--tools read` 时自定义工具不可用，native-chain / 真实 Gate 仍保留原生 read 路径。所有场景保持 shell 禁用和三层冷目录；来源身份必须带 scope、canonical ID、snapshot、主文 bytes/hash 与 stable File ID。不可从裸名、同名替身、另一库或本地副本补齐。

当前 graph bridge 为每次公开 CLI prepare 后逐 prepared node 固定 read 主文，并保存完整清单；资源按下文 NG18 通过固定 ref 的 public read --output 单独物化。它不重复拓扑解析，但会启动额外本地 CLI 进程，不能计为单进程。旧直接加载与 Prompt 仍用严格的完整 export receipt；partial 不得放宽或冒充该完整性合同。

安装 Pi + 受控 provider 的首次请求应含 root / Required 完整正文各一份、Members 正文零份。记录实际 tool input/output、完整 body hash、目录 ref、provider context 和源请求账本。native read 的资源 ref 必须来自公开目录/正文，旧路径带稳定 File ID 应解析到固定 owner snapshot 的正确路径。missing Required / budget / cancellation 时 provider 数量为零；RPC abort、new_session、EOF 与真正终端 Escape Stop 分开记录。

## NG15 分支选择图与正文回执

分支上的 `context-broker-selected-graph` custom entry 保存版本化 CLI graph lock，包含实际根、Required edges、scope 和精确 binding。已知目录、候选和后台预取不写该 entry。optional 第一次实际选择时才加入；正文是否仍在当前上下文由完整 hash/bytes/实际消息跨度证明，不能用选择锁或缓存存在推断 loaded。

~~~bash
CONTEXT_BROKER_PI_SESSION_MODULE=/absolute/installed/pi/dist/core/session-manager.js \
CONTEXT_BROKER_SESSION_EVIDENCE=/absolute/evidence/ng15 \
node packages/context-broker/scripts/session-selected-graph.mjs
~~~

该入口用实际安装 Pi 的 SessionManager、真实 Node 与其公开 append / branch / fork / compaction / open 方法，不使用产品测试 setter。保留独立子进程重启、原始 JSONL、导出的选择图与判定结果。先固定 root + Required 的 A；optional 在库已为 B 时第一次选择只锁自己的 B；fork / rewind 恢复所选祖先而非全部兄弟 entries。压缩移除完整正文后 loaded 为 false，A 的锁仍保留，重载仍用 A；新 session 用 B。

显式 `skill_prepare refresh:true` 在完整准备、确切 File ID 与宿主输出预算全部通过后提交新的 scope 选择。失败保留旧锁。只在 provider 投影中替换已验证的过时/重复正文，原 native tool result、toolCallId、用户消息和 JSONL 不重写；修改跨度后仍保留其余有效回执的准确位置。`skill_graph` 导出当前选择和真实 delivery 状态，不包含凭据、机器缓存路径或对话正文。未知 schema/compiler 版本与被篡改的版本向量必须报错。

会话替换撤销旧 ctx：pending input 必须以 handled 结束，不能在 catch 中通知旧 UI 导致 Pi 回退为普通 prompt。生命周期取消不得调用已撤销 ctx 的 abort，也不能取消后一个提交；dispatch receipt 在真正 session 边界或原 consumer 确认前仍拦住重复提交。受控 Proxy 回归与实际 installed Pi new_session / EOF 结果分别保留，真正 TUI Stop 仍需独立终端证据。

### 实际 Pi 终端选择与 Stop

~~~bash
node scripts/verify-pi-graph-pty.mjs doctor --package /absolute/frozen-broker.tgz --command-json '["/absolute/node","/absolute/installed/ntn-skills.js"]' --cli-source /absolute/notion-skills-cli
node scripts/verify-pi-graph-pty.mjs run --package /absolute/frozen-broker.tgz --command-json '["/absolute/node","/absolute/installed/ntn-skills.js"]' --cli-source /absolute/notion-skills-cli --cases selection,escape-stop --evidence-root /absolute/evidence
node scripts/verify-pi-graph-pty.mjs evidence --evidence /absolute/retained-run
~~~

入口实际安装冻结的 Broker 包，核对已安装 Pi 的 @earendil-works 身份，使用独立 HOME / 配置 / session / Broker / CLI 目录。实际 PTY 输入 Tab 接受 $ 和 /skill 候选；候选与接受动作正文 I/O 为零。提交后完整 root / Requires 各一份、Members 零份；仅 read 工具可用。Escape 场景先等真实 CLI HTTP 等待和源子进程启动，再发送实际 Escape 字节，检查 CLI 130、所有源后代退出、provider 零次和无迟到正文，随后同会话重试。准备预算和 Stop 提示必须在实际终端可见。

保存 raw terminal.ansi、逐步 screen.json、实际按键、provider body bytes/hash、source request ledger、session JSONL 与自然退出证据。2026-11-03 的 v3 安装包两场景通过，运行目录 ng15/broker-pi-graph-pty-QFA9Nc；之前 pw7jMY 的 Escape 功能通过但预算隐藏，整体 failure 保留。实际 Pi + 受控 provider / SQLite 输入证明宿主终端边界，不能代替真实模型选路或生产 Notion 验收。清理命令只将该 manifest 所属 scratch 移到系统 Trash，保留证据目录。

## NG18 宿主清单与按需资源

完整 prepare 清单的每项必须含 path、bytes、sha256 和准确固定 ref；shared Files 还需同 owner 的稳定 File ID/page 绑定。主文 fixed read 必须与 prepare 的完整正文、scope、record、snapshot、version、ref 和 hash 一致。初始宿主只保存 main 到 entries/SNAPSHOT/tree，外部 .broker-entry.json 明确 projection=entry、manifest_complete=true；它不能被旧完整 .broker-snapshot.json 消费。local_files_ready 与 materialized_paths 只反映逐文件验证结果，不等于 loaded。

原生资源 read 从清单选确切项，通过同一自有 CLI read REF --output NEW_STAGE 取得字节；比较完整公开回执与真实文件 SHA/bytes 后再发布。未选大资源不出现；二进制保持原字节。错误 File ID、跨 scope、旧路径无身份、坏 hash、取消和不完整输出必须失败，不猜名或退回 current。嵌套 main 可读同一树中其他目录的文件；仅有清单不能绕过 native read 的当前授权边界。目录和缓存命中仍可能产生权限 Metadata 请求，零 resource chunks 不等于零 HTTP。

实际 tool result.details.contextBrokerResource 保留准确 ref、id、scope、snapshot_id、version_id、path、file_id、bytes、sha256、materialization 与 delivered_complete_text。只有完整工具文本匹配字节/hash 才能标 delivered_complete_text；资源回执始终 loaded:false，不代替主文 contextBrokerRead。会话替换后晚到结果不留 receipt。host alias 旁的 .broker-host-index.json 只证明原始/发布 main 的身份和 hash，projection=host_index、loaded=false，不能作完整快照或上下文投递证明。

~~~bash
bun test packages/context-broker/scripts/notion-entry.test.ts packages/context-broker/scripts/host-prepare.test.ts packages/context-broker/scripts/native-read-session.test.ts
CONTEXT_BROKER_GRAPH_CLI=/absolute/installed/ntn-skills.js CONTEXT_BROKER_GRAPH_CORE=/absolute/notion-skills-cli/packages/core/src CONTEXT_BROKER_GRAPH_EVIDENCE=/absolute/evidence/ng18 bun test packages/context-broker/scripts/prepare-adapter.test.ts
~~~

2026-11-03 的 CLI6 / 真实 Node + SQLite 适配测试通过主文、Required、BOM/CRLF、文本/二进制资源、固定版本与未选 256KiB 资源不落地；18 项宿主边界回归通过。保存 ng19/partial-cli6-adapter.log 与 partial-host-boundaries-final.log。输入守卫原先只在 export 注入“资源缺失”的夹具不能覆盖新的 main-only 准备，保留该旧 full-export 负例，另补实际 read has_more=true 的准备阻断；首次旧断言失败日志保留。最终安装 Pi 的 native-chain 与真实 Notion 跨机 partial 分栏验收，不把上述受控结果代替它们。

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
