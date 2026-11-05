# Pi Agent：搜索、注入与原生读取的最小必要上下文

归属 [AH-617](https://linear.app/yoyooyooo/issue/AH-617)、[SC05 / AH-622](https://linear.app/yoyooyooo/issue/AH-622) 与 [SC06 / AH-623](https://linear.app/yoyooyooo/issue/AH-623)。承接已有 [prepare 投影](skill-consumption-projection.md) 和 [能力化指引](skill-consumption-guidance.md)。

本次优化 Pi Agent 获取、选择和读取 Skills 的完整调用过程。Notion 管理面继续保留完整源内容、目录、关系和历史；呈现精简发生在 Broker。判断收益同时看全部 provider 请求和工具往返，不能以首轮变短代替任务完成。

## 呈现与资源入口

| 入口 | Agent 收到的内容 | 宿主保留的内容 |
| --- | --- | --- |
| `skill_search`，当前 Pi 有 `read` 或 `skill_prepare` | 候选 `ref/kind/name/description/source/in_default_view/availability`，总数、分页和来源失败；不重复 `id/scope` | 完整原搜索结果；短引用仍绑定确切 owner 和 scope |
| 当前 `$` / 原生选择注入 | `kind/name/ref`、一个可用资源目录、完整正文；通用指导集中在宿主块 | 原身份、版本、binding、源 hash/bytes 和实际 XML span |
| active 恢复、隐藏目录或无原生 read | 固定 canonical ref 与完整正文；不声明本地目录可读 | 完整固定版本和投递证明 |
| 完整原生主文 `read` | 原始主文作为精确前缀，尾部文件仅 `path/ref/bytes`；关系仅 `ref/kind/name/description/availability` | `contextBrokerRead.directory` 保存完整 canonical 目录，原 v3/toolCallId/span 合同继续生效 |

目录投影复用 `skill_prepare` 的同一确定性函数，不裁剪文件或关系行。作者的 frontmatter、Members 标题、XML、代码和其他正文仍是完整不透明字符串。原始会话、Notion 数据及完整管理/导出内容没有被重写。

搜索的候选短引用改为一次批量登记，沿用同一分支表；12 个候选的定向测试为冷投影 2 次、暖投影 1 次 branch read，不逐卡片重放整条分支。缺少原生消费能力或未知能力时保留原完整搜索形态。

恢复入口特意使用 canonical fixed ref。实际重启后的恢复准备不经过当前进程的 `readRecords` 登记；若只给 `sr:S` 和尚未登记的目录，资源续读可能落到普通文件读取。恢复现在直接提供可保留 owner/snapshot、替换资源路径的引用，也避免在外层恢复事务检查之前新增短引用写入。当前选择的短引用仍配已登记目录。共享指导明确不能给 `sr:` 追加路径，也不能把主文件 `file_id` 沿用给另一个资源。

## 冻结对照

证据根：`/Users/yoyo/Library/Logs/ntn-skills/AH-617-20261105/agent-context-vi6wk1ja`。

基线来自 Broker `dcc2e86537d9bac62ce8c5d8844da848b7cf15c0`。两臂各自在仓外构建、npm pack 并安装到独立 consumer；各 82 个安装文件与本臂 tar 逐字一致，45 个 `src` 文件仅 `index.ts`、`host-skills.ts`、`skill-context-projection.ts` 不同。两包使用同一已安装 CLI/SDK/runtime manifest，fixture 和 runner 也相同；本次没有重新构建 CLI。

| 输入 | SHA-256 |
| --- | --- |
| 基线 tar | `9371a725edd2c929156d74c3c0840553b3ea405acd6c98d2c97bbda91164eae7` |
| 候选 tar | `f44041957252b226f8a92fe5aa638556e4f9dec7089055b64c09716da12bee5f` |
| 构建输入 CLI entry | `e5b547906b328b9e3700c3fbc8ec214ddd2789ba113bd2e7a41c6b9888d93b69` |
| 构建输入 SDK entry | `7beb7e37b796098095b0342e9855aaaf67672f47baf8f8cc77db9e188533acd9` |
| 两包 bundled CLI | `66dcba837080e8f323d255dc2974800b63f2ba73a345168dc83c91da3a16b53a` |
| 两包 bundled SDK | `7df9a544df9729aa277f12084cce8b980987ac77a7d58bc57867727e0fcbe4ea` |
| 两包 runtime manifest | `59c1b976e1dc2391b785a8c266fc2ea543220594f3e6909f318f3c2d1405cb7d` |
| fixture | `1a6f9dbdc5ba49d4527e62f892532ea0e52a0253cc807d08131150d2fcd7fc10` |
| 逐轮 runner | `d0a98c067b9cf8ab094344d88525f50107b9d57d9877af88549a3de3ef5efcc5` |

使用真实安装的 Pi 1.4.0、Node 24.20.0、Bun 1.4.3。两臂分别执行一次 `dollar`、`native`、`prepare`，保持已有 prompt、工具、timeout、源初态和语义 oracle。每个实际 provider capture 都经 installed pi-ai 的 OpenAI serializer 发到自有 localhost HTTP；保留实际 POST 原件并核对 hook payload bytes/hash。TranscriptContext 含宿主 details，其字节数独立记账，不计作模型 HTTP 输入。

## 全场景实际请求结果

下表统计每个场景的全部请求，包含 tools schema、工具结果和重复携带的历史内容。

| 场景 | Provider 请求数，两臂相同 | 工具调用数，两臂相同 | 基线 HTTP bytes | 候选 HTTP bytes | 减少 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 搜索后 `$` 选择根及 Required | 3 | 1 | 34,102 | 30,035 | 4,067（11.93%） |
| 搜索 → 原生主文 → 返回的资源引用 | 4 | 3 | 43,138 | 41,070 | 2,068（4.79%） |
| 搜索 → prepare → 同会话重复 prepare | 5 | 3 | 60,736 | 58,473 | 2,263（3.73%） |
| 合计 | 12 | 7 | 137,976 | 129,578 | 8,398（6.09%） |

原生资源读取仍直接复制主文 footer 的实际 `sr:R`，没有插入额外 inspect。prepare 的三根与共享 Required 保持四份不同源正文，重复调用后每份在 provider 中只有一份，原始会话保留两次完整结果。

解码后的组件分别为：美元注入整块 **3,835 → 847 B**，六条候选搜索结果 **1,909 → 1,235 B**，原生目录 footer **726 → 537 B**。完整正文和源 hash 相同。必要资源定位指导从 **2,038 → 2,163 B**，每个场景首轮因此增加 **125 B**；这项成本已计入上表。解码文本与 JSON 转义后的 HTTP 增减分别度量。

独立按 API JSON 编码后的 content 复算，差异完全闭合：搜索减少 722 B × 9 次，美元注入减少 2,998 B × 1 次，原生 footer 减少 201 B × 2 次，共享指导增加 125 B × 12 次，净减少 8,398 B。24 次请求的 tools schema hash 均相同，没有未解释的剩余变化。fixture 主文只有 24–30 B，比例不外推到所有生产 Skills。

SDK 调用数两臂相同：美元 1 次 consume；原生 1 次 consume + 1 次 read；prepare 2 次 consume。每景两次 catalog CLI child，正文没有另起 CLI。两臂均为 warm controlled offline fixture，来源 HTTP 为 0；每景仍保留一次 Default View `CACHE_MISSING`，对应 child exit 1，不能写成 Default View 已验证或所有 child 均成功。所有实际宿主、SDK 和来源进程观察链均已终结。

每臂每景只有一个样本；本次不推断真实模型的 token、价格、回答质量、选路成功率、生产网络成本或延迟分布。进程耗时保留在执行回执中，不能将冷启动和本机调度差异当作性能胜出。

## 回归与恢复

71 项定向测试、791 条 assertions 通过，包含完整正文的 BOM/CRLF/Unicode/伪标签、跨来源同名与 disabled、引用分支、未知 proof、重复投递、能力回退和恢复路径；类型检查通过。逐轮观察 helper 为 29/29，包含错误 HTTP bytes、遗漏/更改工具结果与调用、机器 details 泄漏和被篡改目录的负例。首次测试夹具假设及共享 oracle 导致的失败原件继续保留，没有覆盖。

独立安装的候选还通过既有 `rpc-active-recovery`：真实 Pi 重启及实际 `SessionManager.appendCompaction` 移除正文后，下一次普通提交恢复固定正文，后续普通提交不重复获取。场景故意让目录返回 `RATE_LIMITED`，仍保留该恢复边界。恢复呈现的 canonical/no-directory 另外检查实际 capture；相对资源引用转换由定向测试验证。没有实跑恢复后的资源 `read`，也没有验证真实模型摘要。

六景原件分别在 `verification/{baseline,candidate}-{dollar,native,prepare}-01/`；逐轮 POST 和对应 receipt 在各场景 `provider-requests/`，总表为 `provider-http.json`，呈现合同为 `compact-context.json`。基线使用 `--expect-compact-context false`，明确标为 `not_required_for_baseline`；候选为 true。恢复证据在 `verification/broker-notion-startup-evidence-8RmEba/`。清理仅处理已核对终局的自有 scratch，封存产物和原始证据保留。

独立审阅后，七处证据均已执行 `evidence → cleanup → evidence`；各自 scratch 移入系统回收站，209 个原件的 SHA-256 全部保持不变。完整清理命令、PID、退出码和逐文件基线保存在 `verification/cleanup-checks.json` 及相邻 `*-retained-before.json`。包、fixture、首轮失败和全部原始会话继续保留。

## 继续推进的范围

SC05 和 SC06 保持进行中。默认 View / Members / search 跨入口卡片去重、两种目录策略的真实模型比较、正式 A/B/C/D、跨机和日用安装仍由原任务分别验收。

另一个已静态定位的调用差异是：固定单资源 `read(path: sr:R)` 在尚未准备主文时仍可能先经 inspect/activate，批量 `read(paths)` 已能直接读固定资源。后续应保留 scalar 的 offset/limit、图像/文本和错误语义，再消除不必要主文准备；本次没有修改或宣称验证了该路径。
