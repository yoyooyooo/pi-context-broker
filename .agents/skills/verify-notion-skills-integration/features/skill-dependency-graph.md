# Skill 依赖图

此地图是现有跨仓验证 Skill 的专项，使用真实 Pi 原生选择和 read。Launch/Doctor/离线 Drive/Evidence/Cleanup 复用 [request-engine](request-engine.md)。不要复制出第三个顶层总验收 Skill；实际模型、RPC、进程、安装和 UI 继续使用仓库既有 helpers。

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
