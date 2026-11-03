# AH-561：33 个用户故事证据账本

## 2026-11-04 续验与最终交付

两条自然任务链已经在同一 CLI9/Broker10 产品上独立通过：A 从 Pstack Router 出发，采用 H11；B 从普通 Skill 出发，采用 H12。两路各完成 1 个冷首次、2 个暖新进程和 2 个续接样本，均为 5/5 样本、3/3 实际 runs 通过，notRun 为空。日用 Broker 包入口和 CLI shim 已切换，正常新会话也已通过本批交付范围的实际验证；现有旧库 catalog 的 25 条诊断继续保留。

本轮在用户明确授权后使用 magpie/group/worker。模型授权以文件路径和 SHA 绑定到实际模型、入口与冻结 prompt；工具、任务、资源及副作用授权范围保持。两路固定 prompt 使用 600000 ms 的显式预算，历史 300000 ms 场次的超时仍保留原结果。

任务的资源要求始终是完整目标主文、必读 README，以及 create-note.md / search.md 示例二选一。两条最终路线实际都读了两个示例，这没有改变原来二选一的验收门槛。

### 实际交付版本

| 项目 | 实际身份与验证结果 |
|---|---|
| CLI9 | source `dd801c17026d9a289c4359c7bfbbf3286cf1ae9d`；archive `19168be88a6c62b14a48710030cfd940ba241614a53971593d258be7815cc73f`；独立 CLI JS `8c034f9d0808b7d09a014ed8affdfbe89946d7de498f143a13ab5eacac65f869` |
| Broker10 | source `f468bd638263fc37fba25262192052e5707b2d74`；archive `41150cbaf9b05b1ad4e3223b511833ea96e8be3dd4c309918320ac4aabfb1e50`，931572 B |
| 两处安装 | consumer 与实际日用安装的 62 个发布成员逐项一致；48 个 runtime 文件 aggregate `8b3859857288fb5b672f5642229604f02c3eee4b70228ca42f804aedfc909246` |
| 最终 A | H11 aggregate `c356aab81d1673a513f2dbfcefe993583eed8355aa48840afbfc449f574f2114`；5/5 样本、3/3 runs 通过；matrix SHA `a8a5f2d585227b76969c980ff1573d1a291b8eb6bd51d3c654638333b99b7276` |
| 最终 B | H12 aggregate `3252ef8c9a32daed761573b3c595dd8b65ae0ab15dbf20832c46849ef179459b`；5/5 样本、3/3 runs 通过；matrix SHA `e44eb51c72a4c1b38302dd8e72e071ddfce371d51c6d75f0dfb2c3dd7721ea05` |

产品包 source、验证器 source 和后续文档提交分别记账。A 的真实 H11 结果保持原身份；H12 只修正 B 实际遇到的观察问题，不要求 A 为版本号一致而重采。原 17 项旧能力继续引用 H6/H7 分层证据，本轮没有把它们改记为一次新的 Broker10 17/17。

### 本轮修复及验证

Broker9 修复完整资源在 provider 上下文中的重复正文：只有 scope、owner、固定 snapshot、文件身份和内容 hash 都精确一致时才去重。资源读取仍不建立主文 loaded、会话 pin 或额外入口绑定，存储历史中的实际读取记录继续保留。直接回归 21/21、相邻回归 5/5 和类型检查通过；原真实工具结果的离线对照从两份重复 README 正文变为一份。

Broker10 将同一精确合同补齐到合法但没有 FileID 的资源。仅当 proof 和解析引用都确实缺少 FileID 时采用带标签的 path 身份；null、畸形、冲突或不完整证明仍被拒绝。实际 hook 离线对照为 provider 两份完整正文变一份，存储历史仍有两条，mainLoaded 为 false、pin 为 null。直接回归 26/26；合入后的包检查为 99 pass、5 个既有 skip、0 fail，并通过类型检查。较 Broker9，发布包只改变 `src/session-source-snapshot.ts`，completion 文件字节未变。

H11 修复两处合法读取的观察接缝：主文明确的 `File: <code>relative/path</code>` 资源引用，以及实际 provider 的 developer 指令中广告的官方 Pi 帮助文档。同时要求五个样本和三个实际 runs 都通过才判定矩阵通过。106/106 组合回归和真实保留源的离线回放通过；原失败场次保持不变。

H12 修正成功局部读取的记录。模型在已完整读取 README 后合法请求 `offset=1, limit=20`，原 H11 因结果不是完整文件而误记为 error。H12 以实际源行与已安装 SDK 的分页尾注逐字核对，保留成功的 partial 观察；它不把 partial 升级成完整证明，也不消除真正的 native 错误。42/42 直接回归、110/110 组合回归通过，真实源离线回放保留原 67 个证据文件和原失败结论。产品包及图合同未改变。

生成文件提取也补齐两种真实输出格式：语言标记之后的 `path:`，以及代码块正文第一行的精确路径。提取保留原正文 bytes 和 sourceSpan，继续拒绝越界、冲突定义、未闭合代码块、同宽嵌套歧义及不完整 Skill。H9、H10 的组合回归分别为 84/84、94/94。对历史输出的纯提取不改写原 artifact/result。

### 完整产物与实际规程驱动

最终 Broker10/H11 A 的第一暖样本保留完整 7 个文件，其中 1 个 Skill；该 Skill SHA 为 `8fc3ca802130aa3631afe5d5de0502b8e3ae19e66fcbbbfd656cfe2b7c96f175`。A 的 cold 和最后一个 run 原产物仍记为 plan-only。最终 B/H12 的第三个 run 保留完整 4 文件/1 Skill，分类为 complete-skill-files-retained，cold 与第一暖 run 保持 plan-only。各场次的原产物分类继续单独保存。

实际执行证据来自同一任务较早的 Broker9/H9 A 原文生成 helper。5 个应用文件和 5 个生成文件按原字节复制到独立 owned 项目，通过 PORT 入口执行 launch、doctor、查询和创建：缺失查询返回 404，创建返回 201，独立 GET 返回 200，id、subject 和 priority 一致，并记录 ready、health、监听端口与 PID 所属。只停止该自有 PID 53855，将三个精确自有临时路径移入 Trash，证据保留。

这次实驱覆盖明确的 PORT 入口、缺失查询、显式 high 优先级创建、输入 trim 与已存内容查询；默认 npm start、默认优先级、非法输入、重启丢失和多实例隔离没有据此宣称通过。npm test 没有被当成该 Skill 的实驱。验收要求的一条实际生成规程已有独立证据，不为每个样本或 B 另增一套执行配额。

### 每轮原结果

| 场次 | A | B |
|---|---|---|
| CLI9/Broker8/H8 | 3 pass、2 DUPLICATE_BODY fail | cold 失败并超时，4 notRun；不把重复正文推断为超时原因 |
| CLI9/Broker9/H9 | 3 graph pass、1 续接 timeout、1 未运行 | 3 graph pass、1 续接 timeout、1 未运行 |
| CLI9/Broker9/H10 | 5/5 samples、3/3 runs 通过 | 两个 graph samples 通过，但 warm run 因两条合法 read 被 observer 拦截而失败，3 notRun |
| CLI9/Broker10/H11 | 5/5 samples、3/3 runs 通过 | cold 因成功局部 read 被 observer 误标 error 而失败，4 notRun |
| CLI9/Broker10/H12 | 保留上行真实 H11 A 通过结果 | 新独立矩阵 5/5 samples、3/3 runs 通过 |

H9 原 notRun 空数组漏记最后未运行样本的问题另有独立说明，原结果文件未被修正。旧 observer 失败、collector 歧义、timeout 和离线回放都不重分类为原场次通过。

### 实测成本

最终 A 有 13 次 provider 请求完成，最大完整正文副本为 1，无 blocked tool 或 observer error。consumer 有 83 次 HTTP：73 metadata、10 body、0 write，请求 6878 B、响应 9047719 B；另记 retained 9 次 metadata，请求 1742 B、响应 23664 B。token total 为 277467，其中 input 110897、output 28842、cacheRead 137728、cacheWrite 0；reasoning 16866 已有独立字段，不能再次加进 total。账单金额未知。

| 模式 | A task final | B task final |
|---|---|---|
| 冷首次，n=1 | 107149 ms | 143981 ms |
| 暖新进程，n=2 | 138793、88248 ms；中位 113520.5 ms | 141421、169994 ms；中位 155707.5 ms |
| 续接，n=2 | 90979、120340 ms；中位 105659.5 ms | 256560、131858 ms；中位 194209 ms |

最终 B 有 13 次 provider 请求，全部 HTTP 200，canonical 与 wire hash 匹配。15 次完整资源 read 和 1 次合法 partial 读取均保留，每次 provider 最多一份完整资源正文，read error、blocked call 与选择前成员正文读取均为 0。consumer 有 146 次 HTTP（112 metadata、34 body、0 write），请求 29716 B、响应 12907814 B；retained 有 41 次 metadata，请求 38330 B、响应 122627 B，body/provider/write 均为 0，字节未知项为 0。SDK 原始 usage 为 input 208053、output 32522、cacheRead 418688、cacheWrite 0、reasoning 39245、totalTokens 659263；cost 字段 0 不代表已独立核对账单。终局 wall time 为 890370 ms，234 个原证据文件冻结保全，166 个记录的自有 PID 均不存在。

每种模式只有 1–2 个样本，因此不估计 p95，不将不同产品或历史场次拼成一次性能矩阵。root/Required readiness 取首次实际 provider 边界的可观察时点，是上界，不能反推更早的逐节点事件。

### 日用加载与范围边界

日用设置只替换 package index 1 为 Broker10，并更新独立 CLI9 shim；其余 20 个包条目和 source 配置保持。激活回执 SHA 为 `76b84077b92b00ab50cf8e1aed063f0c109c0dd0f21ee7aa924085d47da3f021`。随后正常 Pi 新会话实际自动加载该安装的 `src/index.ts`（SHA `1e7f46453945f0a80b3a5b0d8e70de6760cf20e6f280274b0a37c366e1eab5c5`），未由验证器注入目标扩展或覆盖 source 命令；62 个 Broker 发布成员和 30 个 CLI 发布成员共 92 个文件均与各自 archive 匹配。

实际 find 精确定位 `pstack@notion`：kind 为 router、source 为 notion、page 为 `3fd5636c-236e-817c-ac59-c7ecfced24e7`。默认 source 实际使用包内 `dist/ntn-skills.mjs`（SHA `86beaec4c379c299517b451388d28ef09e014b0b4fc5c45db804d09450683c18`）；其 doctor 返回 direct_http、API 2026-03-11、authentication available，且 skill_read.checked / available 均为 true。

最终正常会话 `daily-pi-um6pwu` 的实际结果为 passed，SHA `edd6426eb6c18794024251271db1aadeaebb0d35296643cfce09f94d5752ddf8`。按实际进程谱系区分的计数如下：

| 观察范围 | 实际结果 |
|---|---|
| 默认随包 CLI 的 Notion 请求 | 33 次，全部 HTTP 200：32 次 metadata，加 1 次显式 doctor 正文探测 |
| 启动及 find | Notion 正文读取 0 |
| 显式 doctor | PID 52110 成功探测 1 个当前 Skill；此正文读取单列，未伪报全程零正文 |
| RPC 与写入 | provider_invocations 0、tool_invocations 0、Notion remote_mutations 0；初末 messageCount 均为 0 |
| 其他既有插件 | 7 次 HTTP 独立保留；6 次有响应，Remnote 的 1 次没有终响应观察，不计为 Broker 请求或虚构成功 |
| 配置与安装 | settings、source、Broker、shim、已审核外部 catalog 均保持；21 个 package 条目保留 |

全局诊断仍明确显示 `Config diagnostics: ok`、`Namespace: failed`。25 条未匹配引用来自现有 agent-kit 的 open-source-bundle 和 matt-engineering-suite 两条本地 Router，仍声明旧数据库 `757d3e81-5a57-476d-b8d1-57b25d49a2ff` 与 data source `b817f726-0d83-47dd-aec6-868d72fbdd09`；当前 Notion source 是 `0b976d0d-9335-4e6c-b9f9-4d8c8ca8c158`。产品按完整 locator 正确拒绝这些旧库成员。本批没有全量改造 Matt 或其他目录/配置，也不将这些成员写成可用或把全局 Namespace 改记为 ok。

日用验证器只接受逐条相同的已审核 25 条诊断，并绑定 catalog SHA `2e6f2be190d667af8c5fd47873be3920e9d8253a0fd14834e9b3e24dc667bc4a`；新增、变更、重复诊断，目标 Pstack 身份错误，配置或当前 source 错误仍阻断。默认 CLI 及后代的 HTTP 必须为 Notion 只读且严格 2xx；host 或无法归属的 HTTP 仍拒绝。正文例外仅允许显式 doctor 启动的唯一 PID，在其实际成功回执确认 skill_read.checked / available 后接受限定 GET 探测。最终 10 项边界回归通过，验证器 source commit 为 `a9fc807e9d28e885f916f15d14dacd53abfe2dec`；产品包及 A/B 图验证器身份未变。

| 原日用场次 | 保留的原结果与原因 |
|---|---|
| s4xiOg、GcDyLU | failed；最初验证器把上述旧库 Namespace 诊断纳入本批阻断 |
| NmLyI0 | failed；原全局 HTTP 观察把其他既有插件的启动网络活动计作 Broker 请求 |
| qA3yKI | failed；显式 doctor 按公开行为探测一个当前 Skill，被原全程零正文假设拦截 |
| um6pwu | 新正常会话实际 passed；按上表精确区分目标、doctor 和其他插件活动 |

前三项修正均有原数据只读回放，回放不改判任何旧失败，也不算新的 Pi 或模型运行。独立复核观察到 Pi 51815 的 process_exit code 0、8 个随包 CLI 的 child_close code 0，并确认记录的 28 个 PID 当前均不存在。外层启动 sessionID/exit 未取得，没有补写成功码；messageCount 为 0 时声明的 session 文件未落盘，原始 RPC 帧也未单独保存，零模型/tool 事件依据绑定 SHA 的结果与已审验证器，未冒称独立解析了不存在的 session。

### 证据保全与清理

| 精确清理批次 | 实际行动 | 保全证据 |
|---|---|---|
| A：22 个路径 | 6 个主 scratch 公共 cleanup；16 个空 doctor 目录 Trash | 587 个原冻结文件、12 份归档原件 SHA 保持 |
| 较早 B：14 个路径 | 3 个主 scratch 公共 cleanup；11 个空 doctor 目录 Trash | 457 个原冻结文件、26 份归档原件 SHA 保持 |
| 最终 B/H12：4 个路径 | 3 个主 scratch 公共 cleanup；1 个空 doctor 目录 Trash | 234 个原冻结文件、20 份 session/manifest/ownership 保全文件 SHA 保持 |
| selection：5 个路径 | 按精确清单公共 cleanup | 65 个原件 SHA 保持 |

45 个指定路径均已不存在，各清理命令退出 0，清理进程均闭合。上述原件数按各批独立记录，不相加冒称互不重叠的全局数量。公共 cleanup 新增各自 cleanup.json，原 result/freeze 和终局中“当时尚未清理”的记录没有改写。两个后来被复用的历史 PID 数字如实保留，没有冒报其不存在，没有向历史或系统 PID 发信号，也未扩大到其他目录。

### 文档与未决历史

本页记录已实测的产品、模型和日用结果。00–04 的一般用法未改变，保留原发布内容；03 中 2026-11-03 的“最终 CLI9/Broker8”属于当日阶段。下文 2026-11-03 的失败结论仍为历史截点，后续成功没有改写原场次。

原 05 单句勘误 operation `ah561-doc-resource-erratum-9379695c85bfee27bbdadce8708d5b23862122eb102ddaaead9b758f1445ea40` 只发出过一次 PATCH，结局仍是 WRITE_OUTCOME_UNKNOWN。后续 GET 观察到 f5 原正文只证明该观察时点的内容，不能据此判定未知操作未派发或未应用。本次完整结果修订与原 unknown 独立登记，不重放、复用或改判旧 operation；实际发布及独立回读回执由两仓最终报告与 Linear 引用。AH560 历史后缀 7292 B、SHA `ce1979985249ee384de19ee268da655b9b85ac0366064c5815cc3b605de211be` 保持逐字不变。

### 关键证据

- A 终局：`worker-A-b10-h11-uiJQ0u/matrix-terminal-xZq1CH/terminal-summary.json`；SHA `8f2d841c80eae963752091169fc0fa78ce150e17a701d986c464f6437d6a0ea5`。
- B 矩阵：`worker-B10-H12-600s-E0yytF/runs/graph-matrix-B-2GU6gv/result.json`；SHA `e44eb51c72a4c1b38302dd8e72e071ddfce371d51c6d75f0dfb2c3dd7721ea05`。正式终局 SHA 为 `e8971af1faed6ab05154062d6530d5b27f6fe1be2022a4ec42fc8f9bbc584be9`。
- H12 组合：`h12-direct-combined-kichbo/result.json`；SHA `27ce0e77fa1d59f0e6a2bf4916b7855e751af4463ddee0d91ef8bd0609534e41`；source `a5718e50190d44ec292e105d6449aaa6e6d6d6c4`。
- 实际生成规程：`A-generated-procedure-lDJY9y/result.json`；SHA `44a7e81aa28e3a056521ff6104a1aef5448ac233562545b026ef13a317e08d0c`。
- 产品包：`broker-v10-qaAKab/result.json`；SHA `536f8b9d7245f4a9885390a4cd6fe05a275f302948dff88e4a64b22f0b72f5c8`。

上述模型与产品的相对证据路径均位于 `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/`；日用回执位于 `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/daily-b10-v2-preparation-TJpiTk/`。

日用正式结果：`daily-scope-review-gJl1xc/validation/daily-pi-um6pwu/result.json`，SHA `edd6426eb6c18794024251271db1aadeaebb0d35296643cfce09f94d5752ddf8`；独立复核：`daily-scope-review-gJl1xc/independent-daily-review-A-1G2vZ4/root-review.json`，SHA `a364bda372d8989ac702d010dc16a5b2c06f5a71db1ef78fb476f3209bbb2a48`。两者相对于上述日用回执目录。日用验证器源码交付回执：`/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/daily-validator-git-Yq1qvN/result.json`，SHA `a49117ebfe021c5f1f722313a1b14e7f72c5f02fabd4184bc30b11c3a71ab445`。

原33个故事的编号、原文、Issue映射、公开入口和顺序保持；JSON historical20261103逐条保留原观察。E01–E63对象和Markdown历史索引不改，当前追加到E88。本账本E88截点的文档操作结果由后续E89独立记录，不以预计结果替代实际回执。

### 最终 Notion 发布与独立回读（E89）

05 页的完整新结果修订已应用。原完整修订 operation 为 `ah561-doc-worker-results-6dab352e5ae42b9b466e3a56dda1ee313d7f7853d13e1177a4e7871ca1d65df7`，PATCH 响应为 Success；随后严格字节断言失败，因为 Notion 把两个裸示例文件名自动转成网址，并在两行表格中加入四个下划线转义。原失败回执和第一次实际读回的 51111 B 正文（SHA `0bb0c0f5c805def141db5ea683bc974406f15e640e798f29b463641ca4f6f8da`）均保留，未改判为逐字通过。

根据这一已知当前正文，另建格式纠正 operation `ah561-doc-resource-code-format-bb06155c496ade987801533ca63107f566b6b114a3e4eeaea8dbb86f6415b385`，只修改一个现存段落，将两个自动网址改为文件名代码文本。该操作只派发一次，保留服务端实际表格转义和全部实质内容。它不是重放旧完整修订，也未重放 E63 的未知勘误。

最终正文为 **51092 B**，SHA-256 `9cf8086675bc3e8f363efaf4d43814d747091d4b6c74a51b6a95c6fc0df4ce92`。格式纠正后的公开 HTTP 回读与独立日用 CLI9 回读都与最终候选逐字相同；父页、属性、33875 B 历史存档及 AH-560 的 7292 B 后缀保持。两次 publisher 均保留各自真实终态：完整修订的 strict verifier 退出 1，单段落格式纠正退出 0；独立 CLI 回读退出 0。原 E63 operation 仍为 WRITE_OUTCOME_UNKNOWN，未重分类。

| 最终证据 | SHA-256 |
| --- | --- |
| 已知成功应用与三处格式差异审阅 | `ac07da4ef9a51c8c74c2a71c88bd3854648c391f254ea38c7c13d425d9981db2` |
| 单段落格式纠正与严格回读 | `41c62954541acb917d47a8dc1c8be5b3cffaa5be43347e76ce3b412a356febba` |
| 独立日用 CLI9 回读 | `e2e983274fb94e36f3ecbbc06f033d38582814ce51629be61aad7ecf30438b4d` |

独立回读使用最终已安装 CLI9，实际为 2 次 GET（1 metadata、1 body），0 write、0 provider，请求 0 B、响应 52567 B；子进程均退出并不存在。最终回执目录为 `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/publication-resource-code-format-xVKzQG/`，独立回读位于其中 `independent-cli9-readback-AjF3P8/result.json`。完整新修订的原回执仍位于同级 `publication-worker-results-v3-xytaO4/`。

[Notion 最终验收页](https://www.notion.so/40d5636c236e813b8b22cb63e2f7d0b5) 已具备本批实测产品、模型、日用和清理结果。00–04 的原阶段文档保持；两仓最终提交/推送及 Linear 关闭记录由外部交付回执引用，避免本文件引用包含自身的未来提交。

### 33 个故事的当前状态

| 故事 | 关联 Issue | 公开入口 | 当前结论 | 证据 | 已验证范围与限制 |
| --- | --- | --- | --- | --- | --- |
| US01 · 作为用户，我希望不安装或登录官方ntn也能使用全部Notion能力，从而迁移彻底且没有隐藏依赖。 | AH-563、AH-566、AH-582 | ctl doctor；list/read/files/export；安装包默认CLI解析 | CLI9/Broker10 两路实际自然任务通过，日用两文件已切换。正常 Pi 自动加载实际 Broker10，随包默认 CLI 以 direct_http 完成认证和显式正文诊断；92 个安装成员匹配对应 archive，无目标扩展注入或 source 命令覆盖。 最终Notion05在E89完成新修订、独立格式纠正和已安装CLI9的51092B逐字回读；原操作结局均保留。 | E02、E18、E26、E29、E35、E38、E40、E42、E43、E46、E47、E48、E49、E50、E52、E53、E54、E55、E56、E58、E59、E62、E63、E65、E72、E73、E81、E82、E84、E86、E88、E89 | 安装、实际入口与最终文档均已验证；实际日用见E88，最终Notion逐字回读见E89。 |
| US02 · 作为库管理员，我希望用本机明确授权安全认证并隔离不同连接，从而凭据不泄露、缓存不会串权限。 | AH-563 | 自有CredentialProvider；分离CLI/XDG roots；scope身份核对 | 原本机授权、scope 隔离与凭据保护证据保留。本轮未改变认证或连接隔离合同，也未改动或披露凭据配置。 | E02、E04、E26、E30、E31、E38、E40、E42、E43、E48、E51、E53、E54、E55、E56、E59、E61 | 认证与隔离按各自原证据；实际日用激活另由E88证明。 |
| US03 · 作为执行维护操作的用户，我希望限流后自动等待恢复但未知写入不重复，从而不用手动sleep且不丢数据。 | AH-564、AH-565 | create/apply/write；原operation恢复；Retry-After队列 | 原限流恢复、写入证据和未知操作边界保留。Notion05 的旧勘误 operation 仍为 WRITE_OUTCOME_UNKNOWN；后续只读看到原正文没有把它改判为未应用，也没有重放。 最终Notion05在E89完成新修订、独立格式纠正和已安装CLI9的51092B逐字回读；原操作结局均保留。 | E03、E04、E25、E30、E34、E35、E41、E43、E49、E50、E55、E59、E60、E65、E89 | E89已证明最终结果页的新修订与独立回读；原unknown仍保留原结局，已知成功后的格式纠正使用独立精确意图。 |
| US04 · 作为同时运行多个CLI的用户，我希望同机不同缓存根共享必要限流预算，从而不会各自以为还有配额。 | AH-565 | 实际Node CLI跨内容根调度 | 原实际 Node CLI 跨内容根共享调度证据继续有效；本轮产品修改限定在资源正文的 provider 投影，未改变调度实现。 | E04、E26、E38 | 原调度范围无新增待项；不宣称跨机器集中协调。 |
| US05 · 作为维护者，我希望用真实入口和独立证据验证每条链路，从而不把模拟或旧成功冒充新能力。 | AH-562、AH-581 | 既有验证Skill入口；公开CLI/Pi/UI独立run | A/H11 与 B/H12 在同一 Broker10 均 5/5 样本、3/3 runs 通过。完整产物、原文 helper 实驱、精确清理和真实日用新会话均有分别绑定的证据；所有旧模型/日用失败、unknown、notRun 与离线回放保留原身份。 最终Notion05在E89完成新修订、独立格式纠正和已安装CLI9的51092B逐字回读；原操作结局均保留。 | E01、E19、E20、E23、E26、E27、E28、E34、E35、E36、E37、E38、E39、E40、E41、E42、E43、E44、E45、E46、E47、E48、E49、E50、E51、E52、E53、E54、E55、E56、E57、E58、E59、E60、E61、E62、E63、E64、E65、E67、E68、E69、E70、E71、E74、E75、E76、E77、E78、E79、E80、E81、E82、E83、E84、E85、E86、E87、E88、E89 | 产品、模型、规程、清理、日用和最终文档均有分层证据；原strict字节失败、格式纠正成功与独立回读分别留存。 |
| US06 · 作为Notion作者，我希望用可读页面链接和关系选择相关Skill，从而不手写UUID或本地路径。 | AH-567、AH-569 | Notion原生Members/Requires；普通链接、mention、Link to page | 原页面链接、mention、Link to page、资源引用与旧 pin 合同证据保留；最终 A 的真实 root-only 路线通过，未新增隐藏目标别名或内容替代。 | E06、E07、E26、E27、E28、E38、E42、E47、E48、E52、E53、E54、E55、E56、E58、E84、E86 | 原链接与资源合同范围完成；两条自然路线已有实际通过证据。 |
| US07 · 作为Notion作者，我希望上游刷新保留自己的附加关系和手工删除，从而不用每次重做配置。 | AH-568 | source refresh plan/dry-run/apply；portable导出/导入 | 原上游刷新、附加关系和手工删除保护证据保留。本轮未执行新的生产 Source 刷新，也未重写上游保护字段。 | E05、E26、E38、E61 | 原上游保护范围无新增待项；不将既有受控刷新改记为本轮生产刷新。 |
| US08 · 作为Pstack使用者，我希望先把这套现有Skill的数据关系校准，从而真实试点可直接使用。 | AH-570 | Pstack精确57绑定census；公开关系读回 | Pstack 57 页生产关系治理及最终 metadata census 保留原证据和截点。当前 A 的自然图路线已通过；本轮没有把原 census 重记为新的全库复扫。 最终Notion05在E89完成新修订、独立格式纠正和已安装CLI9的51092B逐字回读；原操作结局均保留。 | E07、E26、E38、E45、E47、E51、E53、E57、E61、E84、E86、E89 | 原生产治理、两路自然任务与最终文档已有证据；生产数据未因文档发布而扩大变更。 |
| US09 · 作为Pi用户，我希望只选Pstack Router就能让Agent选对成员，从而不用提前提示poteto或叶子技能。 | AH-573 | Gate A root-only installed Pi native read | 最终 CLI9/Broker10 Gate A 在 H11、600000 ms 固定预算下通过 5/5 样本、3/3 runs，notRun 为空；仅选择 Pstack Router，实际到达目标并消费资源。第一暖样本保留完整 7 文件/1 Skill；另有同任务 H9 原文生成 helper 的真实 PORT 驱动证据。AH-573 已据此完成。 | E19、E20、E28、E35、E44、E45、E47、E50、E51、E53、E57、E63、E64、E67、E70、E71、E74、E76、E77、E78、E80、E81、E84 | 本条验收已满足。H9 实驱只覆盖已记录的 PORT 入口，不扩大为默认 npm start、npm test 或全部功能均已执行。 |
| US10 · 作为Pi用户，我希望只选poteto-mode类普通Skill也能继续取相关能力，从而关联消费不被限定为Router类型。 | AH-576 | Gate B普通Skill root-only installed Pi native read | 最终 CLI9/Broker10 Gate B 在 H12、600000 ms 下通过 5/5 样本、3/3 runs，notRun 为空，exit 0。实际 final 体现同 A 所消费叶子资源的项目应用；第三 run 保留完整 4 文件/1 Skill，未执行 B 规程。原 H11 cold 失败与 4 notRun 原样保留。 | E19、E20、E28、E44、E45、E47、E50、E51、E54、E56、E57、E64、E68、E69、E71、E75、E76、E79、E80、E81、E83、E85、E86 | 本条自然路线验收已有完整证据；不新增 B 单独 exercise 或每样本完整 Skill 门槛。 |
| US11 · 作为受限Agent，我希望不依赖shell就能发现和读取准确目标，从而权限小的宿主也能工作。 | AH-572 | read；skill_search；skill_prepare公开工具 | read、skill_search、skill_prepare 的受限工具边界保持；最终 A/H11 与 B/H12 两路均通过。H11/H12 只修复合法读取的观察接缝，工具授权及图合同未放宽。 | E09、E12、E27、E28、E42、E44、E46、E47、E48、E49、E52、E53、E54、E55、E56、E57、E58、E59、E64、E67、E68、E69、E71、E74、E75、E76、E78、E79、E80、E81、E83、E84、E85、E86、E88 | 公开工具和两条自然路线验收完成，AH-572 已由执行方报告 Done。 |
| US12 · 作为使用某个Skill的用户，我希望其真正必读前置在工作开始前齐备，从而不遗漏前置规则。 | AH-571、AH-574 | prepare --purpose use；$和/skill前置完成 | 原 use/Required 前置、首 provider 闭包与原生入口证据保留。Broker10 资源投影不会把资源读取改成主文 loaded、pin 或额外 Required 权限。 | E08、E09、E26、E27、E28、E37、E38、E39、E42、E47、E48、E52、E54、E55、E56、E57、E58、E81 | 原 use/Required 功能范围无新增待项；实际图路线按各自终局留证。 |
| US13 · 作为审查Skill的用户，我希望查看内容时不自动采用全部工作流，从而查看与执行意图清晰。 | AH-571、AH-574 | prepare --purpose inspect；native read默认inspect | 原 inspect 与 use 分离语义保留。资源完整读取及局部读取观察都不隐式采用工作流，也不把资源证明升级为主文 loaded 或 pin。 | E08、E09、E26、E27、E28、E37、E38、E39、E42、E47、E48、E52、E53、E54、E55、E56、E58、E81、E85 | 原 inspect 范围无新增待项；局部读取只能证明实际交付的部分内容。 |
| US14 · 作为选择Router的用户，我希望先获得轻量候选而非全部正文，从而上下文和等待可控。 | AH-567、AH-572 | Router目录；Members元数据 | 最终 A/B 均通过 root-only 按需图路线，成员正文读取没有发生在选择之前；两路每次 provider 的完整资源正文最多一份。目录 metadata 与正文实际消费分别记账。 | E07、E08、E19、E27、E28、E45、E47、E51、E53、E56、E57、E61、E67、E68、E74、E75、E78、E79、E84、E86 | 轻量目录与按需选择边界已有证据；旧 eager 与缺读取失败不重分类。 |
| US15 · 作为维护者，我希望依赖环和版本冲突明确报出，从而失败不会靠截断或猜测隐藏。 | AH-571 | prepare确定版本、Required环、预算错误 | 原依赖环、冲突、预算和 typed 错误证据保留。本轮没有靠截断、猜测或宽松 contract 消除历史失败。 | E08、E12、E26、E27、E38、E42、E43、E45、E50、E51、E53、E54、E56、E57 | 原 typed 错误范围无新增待项；历史 unknown 和超时继续可追溯。 |
| US16 · 作为使用多个Skill的用户，我希望共享依赖只准备并注入一次，从而重复路径不浪费请求和上下文。 | AH-571、AH-575、AH-574 | 多roots一次prepare；菱形共同依赖 | 原多 roots/菱形依赖去重证据保留。B9/B10 另修复完整资源的 provider 投影去重：精确 scope、owner、snapshot、path、内容 hash 匹配后只保留一份完整正文，存储历史仍保留每次实际读取。 | E08、E09、E14、E26、E27、E31、E37、E38、E39、E42、E47、E48、E52、E54、E55、E56、E57、E58、E59、E69、E81 | 原共享依赖范围无新增待项；不由资源投影去重推导未实测的普遍吞吐收益。 |
| US17 · 作为受限访问者，我希望重名、权限或目标缺失时不被替换为其他内容，从而得到准确失败而非错用资料。 | AH-567、AH-569、AH-581 | exact ref、scope、同名/复制/权限typed失败 | 原 exact ref、scope 与 typed 失败保持。B10 只在证明和解析引用都确实没有 FileID 时采用精确路径身份；null、畸形、冲突和不完整证明继续被拒绝。H12 只接受实际源行和 SDK 分页尾注完全一致的成功局部读取。 | E06、E08、E12、E26、E27、E38、E42、E44、E47、E48、E49、E52、E53、E54、E55、E56、E57、E81、E85 | 原精确身份边界无新增待项；不允许按相似路径或其他内容替代目标。 |
| US18 · 作为长会话用户，我希望Notion更新后旧会话继续使用已选版本，从而正文和资源不混版。 | AH-577 | 会话选择图；resume/fork/rewind/compaction | 原历史版本恢复、H6/H7 updated6 的来源保留。B9/B10 不修改存储历史和会话 pin；实际 hook 对照中两次读取仍留两条历史，provider 只保留一份完整资源。最终 A/B 各两个续接样本均通过。 | E13、E15、E23、E30、E34、E36、E37、E39、E42、E43、E48、E49、E50、E55、E58、E59、E69、E81、E84、E86 | 历史更新场景仍绑定原 CLI9/Broker8 场次，不冒称在 Broker10 重新跑过全部 legacy17。 |
| US19 · 作为另一台机器上的用户，我希望凭固定图恢复承诺保留的精确历史，从而不依赖原机本地缓存。 | AH-578 | ctl library graph plan/save/inspect/restore | 原固定图 plan/save/inspect/restore 与跨缓存精确恢复证据保留。本轮未改变 CLI 图锁格式或历史取回合同。 | E15、E30、E59 | 原 CLI 固定图恢复范围无新增待项；未运行的其他宿主范围仍不宣称完成。 |
| US20 · 作为等待冷加载的用户，我希望必要内容通过批量共享查询准备，从而减少可避免的网络往返。 | AH-575 | 同库prepare inventory；选中Files/Records有界批量 | 原共享查询、选中 Files/Records 的有界批量及成本证据保留。最终 A 另有真实分阶段时延和 HTTP 字节账，不以单次冷样本外推普遍性能。 | E14、E26、E31、E38、E40、E56、E84、E86、E88 | 原批量查询范围完成；两路实际性能及日用 HTTP 按各自来源记录。 |
| US21 · 作为启用预取的用户，我希望少量提前准备可取消且不抢前台，从而只在有收益时减少等待。 | AH-579 | 显式prefetch预算；--priority prefetch等公开执行策略 | 原显式预取预算、可取消、前台优先和只读限制的证据保留。本轮未改变预取权限或扩大样本性能结论。 | E17、E33、E60 | 原预算预取范围无新增待项；日用切换另有独立验收。 |
| US22 · 作为修改正文的作者，我希望只使相关引用索引失效，从而不会牵动全库读取。 | AH-569、AH-575 | parent/body/relation/parser派生索引与缓存 | 原 parent/body/relation/parser 索引及精确缓存失效证据保留。本轮资源投影和观察器修复没有引入全库失效或正文预扫。 | E06、E14、E26、E31、E38、E40、E56、E61 | 原精确失效范围无新增待项。 |
| US23 · 作为消费大资源的用户，我希望已固定完整版本按需取文件而完整导出仍拿齐，从而性能与完整性兼得。 | AH-580 | 固定完整manifest；files/read exact；export完整 | 原完整 manifest、按需精确读取和完整导出证据保留。B9/B10 消除重复完整资源正文，H12 将合法分页记为成功 partial 而非完整证明。最终两路均消费所需资源；B 有 15 次完整资源 read、1 次合法 partial，每次 provider 最多一份完整资源正文。 | E15、E16、E27、E28、E30、E32、E42、E43、E47、E48、E52、E53、E55、E57、E58、E59、E69、E70、E81、E84、E85、E86 | 原功能与本轮图资源消费证据齐备；历史导出场次保持身份，不无差别重跑 legacy17。 |
| US24 · 作为安装插件的用户，我希望包内CLI和Broker采用同一新合同，从而不依赖开发机上的巧合配置。 | AH-566、AH-582 | 独立npm安装；随包CLI默认resolver | CLI9/Broker10 发布成员在 consumer 与日用安装逐项一致，包检查 99 pass/5 个既有 skip/0 fail 含类型检查。A/B 均在该包通过；真实正常日用会话再次核对 62 Broker+30 CLI 成员、实际加载入口和默认随包 CLI。 最终Notion05在E89完成新修订、独立格式纠正和已安装CLI9的51092B逐字回读；原操作结局均保留。 | E09、E18、E26、E28、E38、E40、E46、E47、E48、E49、E50、E52、E53、E54、E55、E56、E58、E59、E62、E66、E69、E71、E72、E73、E76、E78、E79、E80、E81、E82、E83、E84、E85、E86、E88、E89 | 安装合同、正常会话及最终文档交付已验证；25条旧库引用诊断继续如实报告。 |
| US25 · 作为使用独立Agent上下文的用户，我希望传准确引用或版本锁即可继续授权读取，从而不依赖父进程隐式内存。 | AH-578、AH-577 | 独立进程exact ref/session binding/graph lock恢复 | 原独立进程 exact ref、session binding 和 graph lock 恢复证据保留。资源投影继续以显式 scope/owner/snapshot/path/hash 绑定；最终 A/B 新进程与续接均通过。 | E13、E15、E30、E36、E37、E39、E59、E81、E84、E86、E88 | 原独立读取、两路会话路径和正常新会话实际加载已有证据。 |
| US26 · 作为取消任务的用户，我希望等待和预取真正停止且不串其他会话，从而不会迟到派发或错误加载。 | AH-565、AH-574、AH-579 | 实际PTY Escape；new_session；EOF；prefetch cancel | 原 PTY Escape、new_session、EOF 和取消证据保留。新 A 终局确认 119 个记录的自有 PID 均不存在；这属于进程闭合证据，不替代原 EOF 观察缺口。 | E10、E11、E17、E27、E33、E39、E60、E84 | 原单条 final EOF 观察限制仍明示；不为补叙述新增终端 cohort。 |
| US27 · 作为生产库维护者，我希望测试有独立owned对象并保留失败证据，从而验收不污染生产或删除历史。 | AH-581 | owned输入/操作/归档；证据不可覆盖；保护核对 | 原生产保护与 owned 证据保留。A/B 模型终局的 172/234 原件与119/166 PID 观察各有原回执；后续45精确路径分四批 Trash/公共 cleanup 完成，原文件 SHA 保持，cleanup.json 新增单列。两复用历史 PID 数字没有误报 absent 或收到信号。 | E21、E22、E25、E30、E34、E35、E41、E43、E48、E49、E50、E55、E59、E60、E61、E62、E67、E68、E74、E75、E77、E78、E79、E80、E81、E82、E83、E84、E85、E86、E87、E88 | 本批已审清理与保全完成；不声称全机临时目录或所有历史 PID 都为空。 |
| US28 · 作为评估性能的用户，我希望看到请求、字节与分阶段实测耗时，从而不被伪冷缓存或一次样本误导。 | AH-565、AH-575、AH-581 | 实际attempt/bytes/queue；五样本分阶段timing | 两路各5样本/3runs的 provider、HTTP、bytes、token与时延完整保留。正常日用另记录33次目标Notion HTTP=32 metadata+1显式doctor正文，全200；其他插件7HTTP独立保留，其中1次无终响应，不能合并为全网络成功或全程零正文。 最终Notion05在E89完成新修订、独立格式纠正和已安装CLI9的51092B逐字回读；原操作结局均保留。 | E04、E14、E20、E31、E32、E33、E34、E42、E45、E47、E48、E50、E51、E53、E54、E55、E56、E57、E58、E59、E60、E61、E67、E68、E74、E75、E78、E79、E83、E84、E86、E88、E89 | E89记录本次两笔已知成功文档更新及独立回读的真实成本；原unknown成本与模型账单未知分别保留，小样本不估计p95。 |
| US29 · 作为维护旧Skill的作者，我希望已有内容由CLI维护，仅必要关系和隐式引用被补正，从而不再手动搬运整套正文。 | AH-568、AH-570 | CLI维护既有Pstack主文/关系/历史pin | 原 CLI 维护与生产关系治理证据保留，00–04 一般用法未变。05 新当前章节记录已实测结果，旧 AH561 结论明确为历史截点，AH560 后缀逐字保留。 最终Notion05在E89完成新修订、独立格式纠正和已安装CLI9的51092B逐字回读；原操作结局均保留。 | E05、E07、E25、E26、E38、E61、E62、E65、E82、E88、E89 | E89已完成本次新完整结果页、单段落格式纠正及独立逐字回读；旧限定勘误unknown保留。 |
| US30 · 作为未来新Skill套件的使用者，我希望相同合同能作用于Pstack之外的数据，从而系统不靠特例硬编码。 | AH-581 | renamed-identities；Required Router/Prompt异构反例 | 原 renamed-identities、Required Router/Prompt 异构反例保留。本轮资源识别、分页观察和 fence 提取采用通用精确合同，未新增按 Pstack 名称硬编码的通过分支。 | E12、E15、E27、E30、E36、E37、E39、E56、E80、E81、E85、E86 | 原泛化反例范围无新增待项；未扩写其他生产 Skill 图。 |
| US31 · 作为日用Pi用户，我希望新会话加载实际通过验收的产物，从而交付和测试版本一致。 | AH-582 | 日用Pi安装选择与新会话实际加载 | 日用Broker10/CLI9精确切换完成，20非目标包与source配置保持；正常新会话实际自动加载并通过本批范围。确切pstack@notion身份、默认随包CLI及其33次只读Notion HTTP已验证。全局Namespace仍有25条已审核旧库诊断，其他插件7HTTP独立保留；四次原失败不改判。 最终Notion05在E89完成新修订、独立格式纠正和已安装CLI9的51092B逐字回读；原操作结局均保留。 | E18、E21、E26、E28、E38、E46、E47、E48、E49、E53、E54、E55、E57、E60、E62、E63、E65、E66、E69、E71、E72、E73、E76、E77、E78、E79、E80、E81、E82、E83、E84、E85、E86、E87、E88、E89 | 日用实际加载及AH-582所需最终文档均已验证，见E88/E89。 |
| US32 · 作为用户，我希望加载/预取不扩大执行和副作用授权，从而内容引用不会变成隐式操作许可。 | AH-579、AH-574 | read-only transport；loaded/injection receipt边界 | 用户明确 worker 授权已生效，并以文件 path/SHA 绑定实际模型、gate、root 和冻结 prompt。工具、任务、资源与副作用边界保持；生成内容本身不授予执行权限，实际 helper 驱动另有原授权和 exact owned 边界。 正常日用的显式 doctor 诊断读取与模型工具授权分开；其他插件网络活动没有被伪报为全局零。 | E09、E16、E17、E27、E28、E33、E37、E39、E42、E47、E48、E51、E53、E54、E55、E56、E57、E59、E60、E61、E64、E69、E71、E76、E80、E81、E85、E88 | 原授权边界无新增待项；H12 的 partial 成功观察不升级完整性或执行许可。 |
| US33 · 作为库管理员，我希望不同内容类型的关系有明确约束，从而不会把Prompt或嵌套路由误当必需指令。 | AH-567、AH-571 | Members/Requires类型约束；prepare明确拒Prompt/Router Required | 原 Members/Requires 类型约束和异构反例保持。资源投影去重及观察修复不把 Prompt 或嵌套路由自动变为必需指令。 | E08、E12、E26、E27、E38、E56、E61 | 原内容类型约束范围无新增待项。 |

## 证据分层索引

### E01 · 冻结验收基线

层次：**controlled / baseline**。

- "/Users/yoyo/Library/Logs/ntn-skills-verification/skill-graph-ng01-MKWuaO/result.json"

### E02 · 独立安装直连只读与认证

层次：**real Notion / earlier installed package**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng02-installed-LMsyeE/manifest.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng02-installed-LMsyeE/identity.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng02-installed-LMsyeE/read-result.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng02-installed-LMsyeE/pinned-resource-read.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng02-installed-LMsyeE/official-ntn-probe.jsonl"

### E03 · 真实owned写入、附件、回读

层次：**real Notion / earlier installed package**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng03/live-installed-02/manifest.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng03/live-installed-02/08-native-body-write.stdout"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng03/live-installed-02/09-native-field-write.stdout"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng03/live-installed-02/10-native-readback.stdout"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng03/live-installed-02/native-reference-api-result.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng03/live-installed-02/attachment-final-result.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng03/final-controlled-yDW8f1/controlled.log"

### E04 · 多进程共享调度

层次：**real Node / SQLite / controlled HTTP**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng04-root-1793681747067.json"

### E05 · 上游字段保护

层次：**controlled HTTPS / public CLI**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng07/controlled/handoff.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng07/controlled/two-refresh-protection.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng07/controlled/portable-reimport.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng07/controlled/public-cli-http.json"

### E06 · 三类原生链接、资源、旧pin

层次：**real Notion UI / installed CLI5**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng08/ui-native-forms/installed5-result.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng08/ui-native-forms/archive-native-result.json"

### E07 · 生产Pstack关系及引用治理

层次：**real Notion / exact census**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng09/final-result.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng09/final-census-WFsuRv/result.json"

### E08 · 统一prepare use/inspect

层次：**core / public Node SQLite**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng12/controlled-o9w_qn2s/handoff.json"

### E09 · 首provider闭包、native链、多根

层次：**installed Pi / controlled provider / Broker v1**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng13/broker-notion-evidence-eoOLkX/manifest.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng13/broker-notion-evidence-6Zd0yH/manifest.json"

### E10 · new_session与RPC abort真实边界

层次：**installed Pi RPC / Broker v2**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/broker-notion-evidence-nvKp7N/manifest.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng13/broker-notion-evidence-G8Hk1k/manifest.json"

### E11 · 终端选择和Escape Stop

层次：**actual Pi PTY / Broker3 historical and Broker4; Broker5 runtime equivalence**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng15/broker-pi-graph-pty-QFA9Nc/manifest.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng15/broker-pi-graph-pty-SF1Awi/manifest.json"

### E12 · 更名、重ID、异构Required

层次：**installed Pi / controlled provider / Broker v3**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/broker-notion-evidence-Fz7HvR/manifest.json"

### E13 · 实际SessionManager和重启

层次：**actual installed SessionManager / independent Node**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng15/selected-graph-D3WrUx/session-evidence.json"

### E14 · 批量查询和精确失效

层次：**real Node HTTPS / three processes / controlled**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng16/controlled/public-cli-evidence.json"

### E15 · 固定图控制与真实Mini恢复

层次：**controlled CLI + real Pro/physical Mini**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/controlled/handoff.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/controlled/public-cli-evidence.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/owned-graph-1793688210678/producer-a-ready.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/owned-graph-1793688210678/producer-a-save.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/owned-graph-1793688210678/current-b-result.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/owned-graph-1793688210678/mini-full-verified.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/owned-graph-1793688210678/mini-partial2-verified.json"

### E16 · Broker按需物化接缝

层次：**real Node SQLite adapter + controlled host**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng19/partial-cli6-adapter.log"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng19/partial-host-boundaries-final.log"

### E17 · 预算预取与只读限制

层次：**controlled core / SQLite / Broker runtime**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng19/core-policy-current-contract.log"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng19/core-policy-deterministic-clock.log"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng19/sqlite-scheduler.log"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng19/broker-runtime.log"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng19/broker-foreground-regression.log"

### E18 · CLI6冻结产物

层次：**installed package identity / before final freeze**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng02-installed-W7xCCt/package/ntn-skills-0.1.0.tgz"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng15/package-v3/pi-context-broker-0.0.2.tgz"

### E19 · 真实root-only目录与实际注册token

层次：**real Notion + installed Pi metadata / no model**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/gates-setup/gate-a-default-catalog.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/gates-setup/gate-b-default-catalog.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/graph-selection-nHopCs/result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/graph-selection-SxmTSw/result.json"

### E20 · SDK观察器五样本与prompt v2冻结

层次：**controlled actual SDK HTTP / no real model**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/graph-observer-http-GGSX54/result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/prompt-v2-freeze-q7ckkC/prompt-freeze.json"

### E21 · 原改动保护

层次：**root verified repository byte/index observations**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/cli-protected.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/broker-protected.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/stage2-commit-receipts.json"

### E22 · owned归档与失败保留

层次：**real owned cleanup / no permanent delete**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/owned-cleanup/failed-owned-result.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng08/ui-native-forms/archive-native-result.json"

### E23 · 原AH560历史15例

层次：**historical real model / old package only**。

- "/Users/yoyo/.local/state/ntn-skills-verification/pi-real-model-cache-_web8gk7/pi-cache-evidence-2givfs/manifest.json"
- "/Users/yoyo/.local/state/ntn-skills-verification/pi-real-model-cache-_web8gk7/pi-cache-evidence-n2TkwW/manifest.json"

### E24 · 生成规程实际执行与反例

层次：**controlled owned project / no real model**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/driver-check-ekEjJ5/result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/prompt-v2-freeze-q7ckkC/related-tests.log"

### E25 · 原unknown写入的独立处理

层次：**real Notion / original outcome preserved**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng09/apply-01/architect-body-result.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng09/apply-01/bodies-result.json"

### E26 · CLI8与Broker完整回归、冻结安装身份

层次：**final CLI8 / earlier Broker4-5 equivalent runtime / complete suites**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/final-checks/cli-final-unit.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/final-checks/cli-final-types.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng19/broker-full-source-check.log"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng02-installed-1C3lIQ/manifest.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng18/broker-v5-n6LhcK/installed-equivalence.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng18/broker-v4-tyjIGw/adapter-cli7.log"

### E27 · Broker4真实Pi十六图场景与Broker5字节等价

层次：**installed Pi / controlled provider / Broker4 with explicit Broker5 equivalence**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/broker-notion-evidence-l27VCB/pi-skill-graph/result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/broker-notion-evidence-s1bZ8E/pi-skill-graph/result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/graph-observer-http-V6XkFD/result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/final-package-checkpoint.json"

### E28 · Broker6正常三工具、SDK真实传输与缺失资源别名

层次：**actual installed SDK HTTP / controlled provider / Broker6**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v2/graph-observer-http-M4pV6s/result.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng18/native-path-alias/fix-result.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng18/broker-v6-ff353lls/installed-identity.json"

### E29 · 当前直连包静态无官方ntn审计

层次：**CLI8/Broker5 package/static audit with explicit historical exceptions**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/no-ntn-audit/final-audit.json"

### E30 · Mini8按需到完整A恢复、六页可恢复归档

层次：**physical Mini / real Notion / final CLI8 / owned cleanup**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/owned-graph-1793688210678/mini-partial8-verified.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/owned-graph-1793688210678/mini-partial8-result.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng17/owned-graph-1793688210678/cleanup/result.json"

### E31 · 修正fixture的批量矩阵与实际Notion三节点成本

层次：**controlled n=3 per condition plus real Notion n=1 per condition / CLI7 bytes equal CLI8**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng16/controlled/handoff.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng16/controlled/corrected/comparison.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng16/production-readonly/installed-1793694337009/verification-result.json"

### E32 · 按需物化完整成本回执

层次：**independent public CLI / core binary fixture / physical Mini; wire and content bytes separated**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng18/lazy-materialization-costs/receipt.json"

### E33 · 预算预取真实owned on/off

层次：**real Notion / isolated CLI7-8-equivalent roots / n=1 per arm**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng19/retained-prefetch-MnBaye/manifest.json"

### E34 · 原十五例当前真实模型失败与独立A→B回执

层次：**real flash-free / Broker5 / failed samples retained; not final acceptance**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-LZOyAZ/manifest.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-X8Dfhw/manifest.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-Qe8hg2/manifest.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/create-a.result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/apply-b-actual.result.json"

### E35 · 当前版本读取失败与首个Graph Gate失败

层次：**actual public CLI8 failure and actual Broker5 real-model failure; not availability**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/v6-current-b.result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/v6-current-b.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/final-package/graph-model-A-SQ1pSW/result.json"

### E36 · 无缓存seed的原生HTTPS服务与完整会话链准备

层次：**controlled HTTPS / actual public CLI8 / no Pi completion claim**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng15/native-service-smoke-h4qtur6s/result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/graph-session-ew8UZ7/manifest.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/graph-session-koAXlN/manifest.json"

### E37 · Broker6真实Pi多节点A/B会话完整链

层次：**installed Pi RPC + public CLI8 Node/SQLite + controlled HTTPS/provider; seven stages passed, no cache seed**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/graph-session-CkKuDu/manifest.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/graph-session-CkKuDu/process-verification.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/graph-session-CkKuDu/oracle-a.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/graph-session-CkKuDu/oracle-b.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/graph-session-CkKuDu/service/http.jsonl"

### E38 · CLI9与Broker7最终运行门

层次：**final source/full package + independently installed Node/SQLite adapter; not real-model task acceptance**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/final-checks/cli9-final-unit.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/final-checks/cli9-final-unit.log"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/final-checks/cli9-final-types.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/final-checks/cli9-final-package.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng18/broker7-package-check-l63yfjdj/result.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng18/broker7-package-check-after-61e_lus3/result.json"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng18/broker7-package-check-after-61e_lus3/check.log"
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng18/broker7-node-adapter-7jbjy743/adapter-cli9.log"

### E39 · Broker7/CLI9真实Pi七阶段A/B会话终验

层次：**actual installed Pi RPC + CLI9 public Node/SQLite + controlled HTTPS/provider; 7/7 functional pass, one late EOF list close/metrics gap and all owned PIDs absent**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/graph-session-5DdQKn/manifest.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/graph-session-5DdQKn/process-verification.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/graph-session-5DdQKn/oracle-a.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/graph-session-5DdQKn/oracle-b.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/graph-session-5DdQKn/service/http.jsonl"

### E40 · CLI9冷logical管理表误识别修复原命令实证

层次：**real Notion / final independently installed CLI9 / original read --refresh without added database; CLI8 failure retained**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/cli9-current-b-verified.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/cli9-current-b.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/cli9-current-b.command.json"

### E41 · Owned A2原unknown与独立当前接受决定

层次：**real public CLI9 write and original-operation review; main accepted_current separately, original parent unresolved and resource still B**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/cli9-restore-a2-actual.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/cli9-a2-original-current-check.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/cli9-a2-accept-current-plan.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/cli9-a2-review-markdown-version-correction.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/cli9-a2-native-v2-verified.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/cli9-a2-accept-current-v2-plan.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/cli9-a2-accept-current-v2-actual.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/cli9-a2-accept-current-v2-reconcile.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/cli9-a2-accepted-current-main.stdout"

### E42 · Broker7原15初始真实模型结果与精确提示诊断

层次：**real flash-free / Broker7 + H3; 1 passed, 2 failed and 8 prerequisite-skipped initial cases; case7 has both invalid URI attempts and one H3 false rejection**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-wJfEnl/manifest.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-wJfEnl/initial-coverage-result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-wJfEnl/failure-diagnosis-v2.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-wJfEnl/failure-diagnosis-path-supplement.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-wJfEnl/autonomous-actual-system-verified.txt"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-wJfEnl/cold-native-command-actual-system-verified.txt"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-wJfEnl/autonomous-public-tool-observer.jsonl"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-wJfEnl/cold-dollar-result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-wJfEnl/cold-native-command-public-tool-observer.jsonl"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-wJfEnl/owned-processes.jsonl"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-wJfEnl/public-cli-processes.jsonl"

### E43 · 旧fenced owned fixture可恢复归档与新owner完整B

层次：**actual CLI9 Notion writes and readback; old unknown/fence retained, independent new owner create and two single-file writes verified; no aggregate replay**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-ANVtV1/retirement-execution-1793701037401/result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/create-a-actual.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/owned-record.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/view-a-verified.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/a-content-verified.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/write-b-main-plan.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/write-b-main-actual.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/write-b-main-verified.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/write-b-resource-plan.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/write-b-resource-actual.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/read-b-main.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/read-b-resource.stdout"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/b-content-verified.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/fixture-b.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/broker8-baseline-configuration-review.json"

### E44 · H3观察器冻结、大正文实际SDK与历史失败分类

层次：**17 controlled Node tests plus actual installed Broker7 SDK provider; 56,423-byte root and matched wire hashes; H4 revision pending**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v3/freeze.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v3/prior-attempts.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v3/graph-observer-http-RJRIM3/result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/legacy-final-harness-ready.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/legacy-final-literal-surface-tests.log"

### E45 · Broker7 H3真实A/B Gates原失败

层次：**real flash-free / Broker7 / H3; original EAGER_MEMBERS and CANDIDATE_IDENTITY outcomes retained, H4 observation corrections pending; no generated procedure execution claimed**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/final-h3/graph-model-A-8Plbzx/result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/final-h3/graph-model-B-TPJVgb/result.json"

### E46 · Broker8独立安装身份与下一轮数据配置

层次：**read-only package identity checkpoint; 48 runtime files matched exact tgz; later actual Broker8 H4 SDK/models are recorded separately in E47/E48**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/broker8-installed-identity.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/broker8-config.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/broker8-baseline-configuration-review.json"

### E47 · Broker8 H4共享观察器冻结与实际SDK

层次：**controlled actual installed Broker8/embedded CLI9 SDK; 78 related checks plus legacy20, exact provider wire hashes, host-help separately measured; this is not real-model task acceptance**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v4/freeze.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v4/graph-observer-http-ejGbJE/result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/legacy-h4-help-home/result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v4/file-extraction/actual-plan-recheck.json"

### E48 · Broker8 H4原15初始实际模型与合法资源alias误拦

层次：**real flash-free, Broker8/CLI9, frozen H4; 2 pass / 1 fail / 8 prerequisite-skipped; read-only diagnosis proves a legal manifest-bound host-index resource was blocked; original failure is retained, no fallback or result rewriting**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-y6izS4/manifest.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-y6izS4/initial-coverage-result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/broker8-initial-flash-free.result.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v4/host-index-resource-readonly-6s0pddit/result.json"

### E49 · H5单次后续cohort准备与当前完整B

层次：**configuration and existing public-read proof only; no H5 real model or fixture restore started; before B / planned after A, unchanged task, budget, markers, tools and 15+2 assertions**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/b-current-after-h4.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/broker8-h5-config.json"
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v5/fixture-root-resource/verification-result.json"

### E50 · H5真实A/B与单Skill原失败及独立诊断

层次：**real flash-free, Broker8/CLI9, H5; original outcomes and later observation-only diagnoses remain separate**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/final-h5/graph-model-A-G3kOyT/result.json" — SHA-256 f12890a448d51c5ca165cb3947ecf7422b32f1c7ff70c7a873307a72f6a32219，33714 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/final-h5/graph-model-B-ti3uRk/result.json" — SHA-256 f0021abd083c85f5f91f45e73446f31acee8f7520eb5158580a1465317af8940，33660 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-DmSpCQ/manifest.json" — SHA-256 614111303dcfc079892dc58c10735371bb0d59988691cc3cf69634e88c3a44ac，17587 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/h5-gate-diagnosis/diagnosis.json" — SHA-256 4af6fbf11d33ccaae569691b6920b28c59687b29671176a06c3b487b1ef20741，98414 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/h5-legacy-diagnosis/diagnosis.json" — SHA-256 d15d49f72657d4595f6fdabaf5c976f83edb26d33222ded1d9bc0a3524aba761，17873 bytes。

### E51 · H5独立retained-source归属补证

层次：**independent real metadata only plus pure offline attribution; 11 metadata, no new body/write/provider; original model failures stay failed**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/h5-supplementary-source-proof-BJqcCf/oracle/proof.json" — SHA-256 19da83e92f37b0456dfe91693db9a982250bba8e889917aba950da2a223e273e，66095 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/h5-supplementary-source-proof-BJqcCf/result.json" — SHA-256 78b08005a06fab8145fc1cd02a039d0b5874adf15ae37fbae51288295b33fd1f，16503 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/h5-supplementary-source-proof-BJqcCf/cost.json" — SHA-256 699e3788317e1e13fac7a29b5b89ada1983dfffaf96a84e0bb46e28929939e68，1178 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/h5-supplementary-source-proof-BJqcCf/derivation.json" — SHA-256 ffa2801e61c9c73b5d27daf1666bc36574569017f01adbc5863a6d810b351f5e，17593 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/h5-supplementary-source-proof-BJqcCf/final-observation.json" — SHA-256 f09a01a574a02154dcc1468ddd14381e5d77bfcdb20835421a90cd12f39b51ef，1430 bytes。

### E52 · H6共享观察器88项回归和两个实际SDK

层次：**controlled regression and real installed SDK with controlled provider, not a real-model task pass**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v6/freeze.json" — SHA-256 b4e28f3bdc6720d87ed155dbb28ebec18663263ad14f954b9ed297f1ee85d48c，19801 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v6/graph-observer-http-NGwP8n/result.json" — SHA-256 8926a6532d188828327ebafde54c4c0025352af0953a86ec9b62d2c4ddc50c09，12238 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v6/graph-observer-http-Hgm7jA/result.json" — SHA-256 190567d3c9cbd39e00b5c5b04659d9898d8b548884c0c5008793823b5788bef3，12208 bytes。

### E53 · H6A原失败与选择时点独立派生

层次：**real flash-free H6A remains failed; independent causal attribution changes only false timing classification from 11 to 0, evaluator remains READ_MISSING, artifact plan-only**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/final-h6/graph-model-A-NFvEez/result.json" — SHA-256 edfe1cc6090750cb370ef7738b34cab9685ea4d416e16531ebd855f7fe8b1a46，36568 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/final-h6/graph-matrix-A-DA0j0c/result.json" — SHA-256 bac39ca43554e131d8a5807579c7e78d062ff065466a79aa6b6f618f00a20919，6681 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/h6-a-eager-review-JuV3Ra/diagnosis.json" — SHA-256 00d1f71e0f71eb2e14a06695190db4cd886a742f7096ab62c5812205d007f90b，23252 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/h6-a-eager-review-JuV3Ra/source-chains.json" — SHA-256 5ebb7e3df2114d620209f21e282fa612f77cacad97af4e935ca71134d10e1f0b，28407 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/h6-a-eager-review-JuV3Ra/derived-selection.trace.json" — SHA-256 ad787a08cf4c29ac420eb0fc6c0d1ef57e1301d8951b1213852ae69423bd544f，612399 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/h6-a-eager-review-JuV3Ra/power-window.json" — SHA-256 e738419104625bb56862a1f70c6576a470899719c621e4b07e4a6a0dc871b60b，4483 bytes。

### E54 · H6B合法裸owner准备输入的观察器误拦

层次：**real flash-free H6B original READ_MISSING and independent public-contract diagnosis; no target/resource read or complete generated Skill inferred**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/final-h6/graph-model-B-xoGFQs/result.json" — SHA-256 83c43d21316816076bc1d50fb01a2fd68ff6f7efc0a46e72a9f7a93d1c36ec57，32879 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/final-h6/graph-matrix-B-7GTgCn/result.json" — SHA-256 b4ad7959eba59c2c03f01c9590247dcd5e07eaf8b6040d62ac453667ee878971，6697 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/h6-gate-diagnosis/b-and-native-location.json" — SHA-256 4d5e3e9d1e0d672eb1473f25dea6caafb6d3264d07ba70a50227b3bc501b6e7e，35315 bytes。

### E55 · H6单Skill初始10pass/1fail与原生主文wrapper误拦

层次：**real flash-free H6 initial11 cases, 10 passed and cold-native-command failed; updated6 not yet observed at this checkpoint, original case numbering retained**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-HEjb03/manifest.json" — SHA-256 bf41b8e2824fce41c9285e536beaf67f540387610f6752ace868f0916ad63a65，55294 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-HEjb03/cold-autonomous-native-result.json" — SHA-256 7a6359b2929bda56690071cfc3694a3afe7548b4429c721843f1818d7e0efe58，3727 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-HEjb03/cold-native-command-result.json" — SHA-256 2fa9d13eb8791c625ed386f405638431b70d3b6c0aa2d50d5e1dd9832fbc9548，1068 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/h6-gate-diagnosis/b-and-native-location.json" — SHA-256 4d5e3e9d1e0d672eb1473f25dea6caafb6d3264d07ba70a50227b3bc501b6e7e，35315 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/h6-legacy-diagnosis/native-location-failure.json" — SHA-256 d4b308c1e344ee1676055bc6b01a27b7feadbccd2fe6db51c0063f55dd18235b，24293 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/h6-legacy-diagnosis/initial-coverage-result.json" — SHA-256 4c0de92c65e1d1006a26670166842798ff586cfb4cf1b00555525e70094de275，56324 bytes。

### E56 · H7三处观察器修复、窄产物识别与最终冻结

层次：**96/96 controlled regressions; two real installed SDK runs with controlled provider, 10 wire pairs each. SDK original aggregate is retained; unchanged project creation/inspection functions bridge the narrow later artifact extractor change. Not a real-model task pass.**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v7/freeze.json" — SHA-256 92c369b047339eb1388cb7081890212e539616d074dada0fdb90427849155cd4，34070 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v7/regression-final.json" — SHA-256 4a0f3ebe681a901bf05ba54cb7315c73c0d7f75ae00558ccf911dea7c8f7d6ab，1931 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v7/graph-observer-http-PUEbMb/result.json" — SHA-256 6cc74e198e2937799ef3cbb7e4a74ddcd49a347d32878118ce975f720586e3fb，14539 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v7/graph-observer-http-wutwR7/result.json" — SHA-256 374023c60ff6be8e36113e0d68e87405539b4ccebae57d8227c3c30097fe7a16，12622 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v7/sdk-project-boundary-final.json" — SHA-256 555926dd0024f767e8943ac8c246932666467a1c57285e3f7c4b0cd6d74c2f51，3124 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v7/independent-observer-review-k0bcKg/review.json" — SHA-256 b3e46098eb1ef546edbdc9c8c16748d8f28ebb28c2e77dfbc922ee15e095e70e，10007 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/harness-v7/independent-project-review-t13uPM/review.json" — SHA-256 f1ccf27dd30d521c8b27ed2ff4d2603aa1bfc867f3ea360670d9eead1712c08c，4689 bytes。

### E57 · H7B真实模型最终READ_MISSING与原失败保存

层次：**Real flash-free/Broker8/CLI9/H7, one cold failed and four later samples notRun. Nine provider responses all HTTP200, successful final, no availability/observer/eager failure; missing native target/resource/project reads and incomplete generated files remain real failures.**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/final-h7/graph-model-B-FUJa9C/result.json" — SHA-256 e6ef4f89a2e0f0570c4e09079a88ae9fdd4dee939109bb95f2dabfd93bc87994，34134 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng14/final-h7/graph-matrix-B-sOq1iM/result.json" — SHA-256 51ccd442d1ae9d77d3afedc3f1fc1112fe390344ed6e53efe68e7164625fb4d1，6714 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/h7-b-diagnosis-vmBDYI/diagnosis.json" — SHA-256 293c36c6f0bf188ac4a0ae79a51f43b84391032b2efd91636f1c6c27d8e1c292，70806 bytes。

### E58 · H7原生入口必要复验与11项分层覆盖

层次：**Real H7 cold-native-command targeted 1/1 pass; initial requirement coverage combines ten individually retained H6 successes with one H7 targeted success. The original H6 10-pass/1-fail manifest is unchanged; not a new all-pass cohort.**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-Y9H1QF/manifest.json" — SHA-256 52402219c2d9b81fe9c38117ce50158f10a75ed6e41daa7d51823ffa757b7e72，15450 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-Y9H1QF/cold-native-command-result.json" — SHA-256 e43a48b0526cc3f9a3f8bbcaa825692f61a5dd8529f2c926316ea5c1f2e33eb4，3712 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/broker8-h7-initial-coverage.json" — SHA-256 05248539256372d63569b4259eb26badf30d1a0f6994c6936d997257cdeb2c6b，53786 bytes。

### E59 · 两精确文件B到A、updated6与17项终态分层覆盖

层次：**Two original public file writes with independent readback; H7 updated6 all pass, genuinely resuming the retained H6 autonomous B session while five newer cases use A. Original case labels including -b suffix are preserved; snapshot identity determines actual version. 17 requirement coverage across H6 initial/H7 targeted/H7 updated is not one new matrix.**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/restored-a-content-verified.json" — SHA-256 97160c04b8cd226266d5e117ca4c690a613eaab803af1e1a153ca722e890bb5e，4357 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/fixture-restored-a.json" — SHA-256 dccb856faeeab12023743f56658ba70e4c582e61c315148f05d24eb6e75f0dc0，2714 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/pi-cache-evidence-tTddSZ/manifest.json" — SHA-256 a798e564c922c3330da79c4028b4651ccb5f3c1154a0394392997f8d7c37eb13，34180 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/broker8-h7-terminal-receipt.json" — SHA-256 9a5168db218dcd5f448e770523693054793bed89c55fd3e3afdf97cd2d11ec55，137740 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/legacy-h6-h7-session-retention.json" — SHA-256 5783224642d2e4028e2827116f18e45f61e4f182b83a958f1cf5ada8e5b625b5，998107 bytes。

### E60 · 两owned页、第三临时View、18个精确目录清理与原改动保护

层次：**Two exact original-create pages archived once and independently retrieved in_trash; third single View deleted through actual UI and confirmed by final census. Eighteen scoped local directories moved to Trash; sessions/prefixes and original failures retained. Deliberate A/B Views remain, and no global /tmp-clean claim is made.**。

- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/cleanup-h7-complete.json" — SHA-256 881d2b064ebd302c4824bf0a7fb3a16a2258769080b30f8372513971186bcc07，4285 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/cleanup-h7-audit.json" — SHA-256 b52f5873cd27ca28a8bc7706d74ed9acc8b06a1a32fb58f68fa7674fa6a852b5，20173 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/owned-single-final-ybVxon/legacy-h6-h7-scratch-trash-complete.json" — SHA-256 6b9933e3276ddd56b9568a8ce0dde5c3e9a8140a3c1ad38fb79462ed1ee21c02，4204 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/h7-b-diagnosis-vmBDYI/cleanup-execution-6CsYI1/result.json" — SHA-256 83c81a2fccf470853bb42b4528453d303b5c358e737a5d4735487ca14eb16ee2，1607 bytes。
- "/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng20/closed-graph-scratch-plan-KMtlaO/execution-tPpHCO/result.json" — SHA-256 f257743d7345f2ef7c74b92186f00f6d1274c0711de3e30c0805bd4cdbca0f67，4060 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/single-view-cleanup-ntWJId/after-ui.json" — SHA-256 8aa3f4a5e93898fed2f32a9808517a37661a2300fcbda976fea386a49b56f651，23376 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/final-protection-FnM8Ik/result.json" — SHA-256 f65217b64962a26957db42f41fd7ede6f7d41439ec52aa9026accad1991aa792，2028 bytes。

### E61 · 最终生产metadata census与独立语义结论

层次：**First phase freezes complete schemas/Skills/Files/Sources/catalog; one separately authorized narrow continuation reads only missing relation/View/cleanup metadata. Raw 42 metadata + 2 unclassified_body counters and both original non-pass statuses are preserved. Two relation responses contain only property IDs/pagination; 48 rotated attachment signing fields are independently normalized only after stable object identity/all non-signing fields match. No new body-content proof, write, Records scan or model request.**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/final-production-census-preparation/plan.json" — SHA-256 b9c045899842d62e8f2880dd8bcc54299f828e8e168c0dab05d34896b5e05f9d，10532 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/final-production-census-43ef191a/result.json" — SHA-256 b1cbcea81523b2bd6134f6ebb1bde217c18881d1a342f61d76f58334c197bf5a，51979 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/final-production-census-runner-k2YR4v/launcher-result.json" — SHA-256 bcf69eee4199e92e63e24a96cc1ad86f6ac0d4afa7fabf0932dfe758da4f9603，1158 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/final-census-continuation-9e5d4b00/result.json" — SHA-256 4818b5828c1cf897322cd7d34880f6816c8148765f68dc11a618f75e8f7e860f，286589 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/final-census-continuation-runner-61Mz8b/launcher-result.json" — SHA-256 fdc7f3f1221a2ae3b4108155e7a4ead1573fa776d273abc83a997cd782526bae，1179 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/final-census-conclusion-JkSnne/result.json" — SHA-256 7f55c7120a7b75aa9f8bb5291fec26eac5316006e5f68dbb66a28dec6cfcaf39，51904 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/final-census-conclusion-JkSnne/receipt.json" — SHA-256 7cdc8620ef173e72682108816debcd897cce2d695340a8baa62a959ba6aa1dd0，630 bytes。

### E62 · 六文档实际发布、5页逐字读回与05页独立接受3项转义

层次：**Six unique pages independently read through installed CLI9; five byte-exact to final candidates, page 05 matches only the explicitly reviewed three-escape Markdown serialization and remains byteExact=false to its original candidate. Two complete AH-558/AH-560 historical suffixes unchanged. Seven page updates have Success responses and zero page dispatches are unresolved. Original strict failures and incomplete first-publisher HTTP totals remain preserved; this is documentation delivery, not A/B task acceptance.**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/publication-complete-TCdBv3/result.json" — SHA-256 0b6b59f9e980ec677f30c52679862331b13103b1afcee9413ab278a601ad84bf，10553 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/publication/independent-cli9-readback-VEUfV9/result.json" — SHA-256 354cb080c95dee3953bbed9e548eeb8c5d89826357034e32f2532ca0846f8fa5，27021 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/publication/accepted-current-serialization-1793717247785.json" — SHA-256 3dfc6a08236b0c0af789944da8b6bab6a4126b1230aa7721a8a493b86d2a3628，1963 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/publication/plans-final-1793716191920.json" — SHA-256 994fc9782a4a28004ed444a7bf5340b28f763652d89b5a343bcc19b84638b6b2，2985 bytes。

### E63 · Notion05限定勘误结果未知与独立基线读回

层次：**One explicit subsequent wording-correction PATCH returned WRITE_OUTCOME_UNKNOWN. Independent CLI9 metadata/body GETs observed the original f5 baseline; they do not establish that the unknown write was undispatched or not applied. Remote correction is not confirmed, no replay or accept-current occurred. E62 remains the earlier six-page cutoff with seven known-successful updates and zero unresolved dispatches; this subsequent operation adds one unresolved outcome. No model task or acceptance requirement changed.**。

- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/publication-resource-erratum-JnpptS/terminal-receipt.json" — SHA-256 dd5a569e87867666ec84c947bc769f237e1f8fecac6d9c601df82e50943d8d87，4578 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/publication-resource-erratum-JnpptS/response.json" — SHA-256 85a76fcac1ad398740943651a966150a0ad83fae7913e53ef1a11a0235778717，405 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/publication-resource-erratum-JnpptS/failure-1793718495515.json" — SHA-256 49da8326d45819abddecdd1f4c94ad925ce77d1360842aac7a69429c7142e0d6，1220 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/publication-resource-erratum-JnpptS/plan.json" — SHA-256 5a117e49c3ab075d9d86fe5ff3fb6f92957eab61fbc8ecffd39ae0e18f3d8ed3，169909 bytes。
- "/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/publication-resource-erratum-JnpptS/independent-cli9-readback-SlZ4gH/result.json" — SHA-256 61e00375830e8f8b8e8307b39d65b14a4e8a15edd679eb241f744b98263f3c93，4205 bytes。

## 2026-11-04 追加证据

### E64 · 用户明确 worker 授权与 H8 绑定、74 项回归及独立审查

Explicit user permission on client date 2026-11-04 permits magpie/group/worker after flash-free task failures. H8 validates the authorization path/hash and exact model, gate, root and frozen prompt; trace/fingerprint retain that proof without injecting it into model input. Two of nine runtime files plus two tests changed. Task, resource, tool, artifact and execution boundaries are unchanged. Seventy-four targeted regressions pass; independent source review has no blockers. This is not a new SDK or real-model pass.

- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/harness-v8/freeze.json` — 5888 B；SHA256 `9beb47caa0c3eedeceb3f17587a0fc28e14444155fba58d803d479097d143354`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/h8-worker-authorization-0hsf8c/final.json` — 5909 B；SHA256 `529fc049c7780b592925036deb12a866abaceb7588583d5595789385e95acd85`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-A-preflight-L3zK6r/independent-H8-review-3Euwdd/review-final.json` — 2601 B；SHA256 `7675d1e42a54133617ea83f3245b8ec2a184d009838c60b2f599cf1142176148`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-authorization-LQWB8k/gate-A.json` — 624 B；SHA256 `50218b4b4e567e8a21c1dc942b10d8931210c8ad0a70863e01f2ffd8c50e9e6d`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-authorization-LQWB8k/gate-B.json` — 623 B；SHA256 `cf30de612ab3228d985515acb6d087e9d0c17225b3d5329fc9e2c557f676c058`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-A-preflight-L3zK6r/gate-A.worker.authorized.matrix.json` — 1490 B；SHA256 `fd0aa547010287a79213a37a061629d37378f7b550a687b8ec538e51730b8b4e`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B-preparation-YmwDC6/gate-B.worker.authorized.matrix.json` — 1492 B；SHA256 `73709a3432bbe745d6eaee0fbfeb084e36897da3830fd9825aaa4442f7eb1f56`。

### E65 · 未决 Notion05 勘误的后续只读核对仍匹配原发布正文

Two public CLI9 GETs again observe the original f5 baseline, not the correction candidate. Parent, properties and complete historical suffix match. The original WRITE_OUTCOME_UNKNOWN remains unresolved; this observation establishes neither undispatched nor not-applied. No replay, accept-current, remote write or model call. Original E62/E63 cutoffs and outcomes remain unchanged.

- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/publication-resource-erratum-JnpptS/independent-cli9-recovery-hpmio7/result.json` — 6731 B；SHA256 `8be6a6dc5b017a6826e49fad477b6cb59cdb80804d406e36daff550d70e2f603`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/publication-resource-erratum-JnpptS/independent-cli9-recovery-hpmio7/collector.cjs` — 6354 B；SHA256 `36691fe5f768aac543002141721818f5da3d542670c18baf90043666ff364d8e`。

### E66 · CLI9/Broker8 日用激活的只读复核与精确候选计划

Local checks only: all 62 Broker and 30 CLI tar members match installed candidates; current settings/shim and backups match, with 20 non-target packages protected. Exact slot and shim candidates derive from final CLI9/Broker8 config; historical stale after paths are not executed. No activation, Pi process, model call, Notion request or test run. Normal metadata-only autoload verification remains pending required gates.

- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/daily-resume-readonly-feu9WP/result.json` — 7884 B；SHA256 `f15d3f75923401ec43fb591ab28899594411b7ffdb0caec5642981dae060aa43`。

### E67 · H8 worker Gate A 原矩阵闭合：3 pass / 2 DUPLICATE_BODY fail

CLI9/Broker8 and H8 with explicit worker authorization: cold one and two warm-new-process samples passed the graph assertions; two continued-session samples failed DUPLICATE_BODY. All five samples remain retained, with no notRun samples. Original artifact receipts remain plan-only because language + path: fences were not recognized. This is not final AH-573 product completion or generated-procedure execution. Root later cleaned the four exact completed H8 scratch roots through the public cleanup command. Original result hashes remain unchanged; newly added cleanup.json files are explicitly acknowledged.

- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-A-preflight-L3zK6r/matrix-terminal-HpaZay/result.json` — 56475 B；SHA256 `bcd0630eab03955ac0d76b6937ccfd71cfcf6df87f2df74f95179a57f10727cd`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-A-preflight-L3zK6r/evidence/graph-matrix-A-pfoNpy/result.json` — 17425 B；SHA256 `8b6d3b09919caf2fc7386e7b1defc3161b918f69546d22f3bc8a1c227af1b30b`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/h8-owned-cleanup-sOBaGX/result.json` — 4564 B；SHA256 `e3a1aff644e569eb86dbf267ac62c6068e422716b4cd3cb7e7ff24f2e3e1517f`。

### E68 · H8 worker Gate B 原 cold 失败，后续 4 项 notRun

The original H8 Gate B run failed DUPLICATE_BODY; its cold sample independently timed out at 300000 ms with NATIVE_SUBMISSION_FAILED, no successful final and no generated artifact. Four later samples were not run. availabilityFailure is false. No evidence establishes duplicate resources as the cause of the timeout; the B9 projection fix does not retroactively cure either original failure. Root later cleaned the four exact completed H8 scratch roots through the public cleanup command. Original result hashes remain unchanged; newly added cleanup.json files are explicitly acknowledged.

- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B-preparation-YmwDC6/diagnosis-0fyFtD/diagnosis.json` — 105027 B；SHA256 `2ba58440f3361a2643e06e89a5be9f17a97445532288d9894c2434839158c30e`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B-preparation-YmwDC6/runs/graph-matrix-B-2GEvrX/result.json` — 6756 B；SHA256 `4a5ed4e43827c15974c7a4a04547a08149df9a71c91a32d00f9cfd542672a953`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B-preparation-YmwDC6/runs/graph-model-B-PZHa5w/result.json` — 45830 B；SHA256 `e7edd07399bbf1faee3eb11ad3881995e1c7e4287ce795e60e905b481f1abf4f`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/h8-owned-cleanup-sOBaGX/result.json` — 4564 B；SHA256 `e3a1aff644e569eb86dbf267ac62c6068e422716b4cd3cb7e7ff24f2e3e1517f`。

### E69 · Broker9 完整资源 provider 去重：21+5 回归、独立审查与包检查

B9 adds exact complete contextBrokerResource proof validation and a resource-only provider projection deduplication key containing scope, owner, immutable snapshot, stable FileID and content hash. Resources remain loaded:false and never establish entry bindings/pins. Stored messages, tool-call IDs, entry restoration and non-resource projection remain unchanged. Red was 18 pass/3 fail; green 21/21, adjacent 5/5, types pass. Offline actual B tool results change only one repeated README provider copy from two to one; no model call. Independent review has no blockers. Package check is 94 pass/5 skip/0 fail plus typecheck, not a new installed live matrix. Root's linear pushed source commit is 967f798aa74e115e25ac0760ba33d554cbb44cce.

- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B-preparation-YmwDC6/resource-dedup-0MwJs4/red.json` — 818 B；SHA256 `fd6992957109ae2586bb604223a3e93d533c471b518c5693593dff31da0f0981`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B-preparation-YmwDC6/resource-dedup-0MwJs4/green.json` — 818 B；SHA256 `1cd9b5c0531089077ad87d83e460d37ce63d9ff4f2bd13d9a985df24d8aeb6df`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B-preparation-YmwDC6/resource-dedup-0MwJs4/adjacent.json` — 751 B；SHA256 `1cb11a8eb50b9d1995355293d44a6696e31fd391b5f0e74a6d1c731918e3ceac`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B-preparation-YmwDC6/resource-dedup-0MwJs4/typecheck.json` — 751 B；SHA256 `2cf3b01b7688c2bcf259d34080373a975c9c9abff91e3ee1d33597387208d346`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B-preparation-YmwDC6/resource-dedup-0MwJs4/offline-replay.json` — 2908 B；SHA256 `9393265724b03527aa4bb3fb860a9b223f4c3ea7440adab9b9e949a6251f0a54`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-A-preflight-L3zK6r/b9-independent-review-WU3vqu/result.json` — 6609 B；SHA256 `b05425a3d564bda3d83016f1bb7fb72f30ba7e27566d0ddafd7ba2db9286edf7`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B-preparation-YmwDC6/broker9-check-NZysCN/result.json` — 1601 B；SHA256 `b7e1d874f852c5a0546a399c345ab39917cab9eef353f37a222b37c2ae301875`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/b9-git-qctinO/result.json` — 6273 B；SHA256 `c112614b7ca1ab13f162234c6f2961f604523d06c05741007fec8dd1a1cfcac6`。

### E70 · Collector 识别语言后 path:：10/10 与原 A 六文件精确提取

The collector adds only a fallback for an explicit language token followed by path:. Existing parsing priority, cleanPath, fence boundaries, body slicing, sourceSpan, conflict and complete-Skill checks remain. The original five tests pass and the five new tests fail under the old parser; all ten pass after the change. Pure analysis extracts six files from the exact original 17338-byte A cold final with matching body bytes, hashes and sourceSpan. All original result/plan receipts remain unchanged and plan-only. No new retained artifact, procedure execution or model call.

- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/collector-path-colon-preparation-Gqq5Jp/final.json` — 2761 B；SHA256 `f2eb84a139bb2859fdd6d249869db115fc648c667a1b6fcc47c8cc7327c979ef`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/collector-path-colon-preparation-Gqq5Jp/red.json` — 2502 B；SHA256 `969d7e1e8717fb99a036f0db37be3d7d646c354d07638b0afe2b64df2417d019`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/collector-path-colon-preparation-Gqq5Jp/green.json` — 2507 B；SHA256 `0a5f9a61725a6765211ba5f75d5df7db3fcf2d25c7ca7bdb9896f297a7d6b599`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/collector-path-colon-preparation-Gqq5Jp/actual-A-cold-extraction.json` — 4378 B；SHA256 `4431a6a1d949d75f2e944726ac2e9ab333cc0af05f0395e7975efa6068fb0242`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/collector-path-colon-preparation-Gqq5Jp/parser-and-regressions.patch` — 6264 B；SHA256 `d8ea9a9726d75623cde8485a813602177ff5054a10654f2d044af922398b52f1`。

### E71 · H9 最终九文件 freeze 与 84 项组合回归

H9 freezes nine runtime files at aggregate 32e7a17c0d80e1ea6608024f76253557b89bc9a100c20235df161211ca4c0e49. Model/contract/project direct tests report 84 pass/0 fail, exit 0. The initial launcher parsed only TAP summaries while Node24 emitted Spec summaries; its zero-counter receipt remains intact. An independent derivation verifies the exact retained stdout as 84/84 without rerunning. Source/test bytes remain frozen and owned PIDs are absent. This is harness evidence, not a B9 real-model pass.

- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-A-preflight-L3zK6r/h9-direct-combined-iqOVoA/freeze.json` — 3525 B；SHA256 `a8be463523085e9d4568a09b0e58bedd524a84c2b3e81483359647f51e217a13`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-A-preflight-L3zK6r/h9-direct-combined-iqOVoA/verified-result.json` — 10125 B；SHA256 `d54b585173534c1913a186dcf520a629388bfa57adf786fb09104bacbcaab46c`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-A-preflight-L3zK6r/h9-direct-combined-iqOVoA/result.json` — 9363 B；SHA256 `5666730b2aebe5288dc651c92ae42fc86a2c9c98aaa441a802276c01f6d85e75`。

### E72 · Broker9 正式包与两处独立安装逐字一致

Broker9 source 967f798aa74e115e25ac0760ba33d554cbb44cce produces archive 8df7b70f61f4631a535ff69ab4b8daaed376a8978bd171f4a1c145b69796a80a. Both independent consumer and daily-candidate installs match all 62 published members; 48 runtime files aggregate to 79c4fc901c949d56d7784e3af62540b2bbc7699e92299a293b04682e21350533. Relative to B8, session-source-snapshot.ts changes as intended; completion.mjs also has verified consistent internal identifier renaming, with unchanged non-identifier text/public properties. The overly narrow one-member expectation failure remains retained. CLI9 input, embedded CLI, entry bytes and protected state remain unchanged. No activation, Notion or provider requests.

- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/broker-v9-y4bWJc/result.json` — 47748 B；SHA256 `0fd437d66e9a5da8c9f167e2f4b75adb73e6c8f9f9cb207564bca0ff4d89e76f`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/broker-v9-y4bWJc/completion-delta.json` — 122226 B；SHA256 `4febfb355b46732e08fb1dd6ee8e2d250c1a40078b86f9e8ad31d0f9ef25784d`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/broker-v9-y4bWJc/failure.json` — 26158 B；SHA256 `193f1786ba68907912d76347840681ed3a059e7ed7be77b47c0b511b2584645e`。

### E73 · 最终 CLI9/Broker9 日用激活计划准备，仍未启用

A new exact plan targets final Broker9 package index 1 and the CLI9 shim. Current settings/shim/source hashes and 20 non-target package entries are protected. This supersedes the executable candidates from historical Broker8 preparation without rewriting that history. Activation and normal metadata-only new Pi session remain gated on the final A/B matrices and required product/procedure evidence. No settings/shim modification, model request or remote write was performed by preparation.

- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/daily-b9-preparation-qu8lyw/plan.json` — 2898 B；SHA256 `2fb74d3bb5292ae4ba4dd7ac69de00a57f16bca100098803186a49834efcce90`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/daily-b9-preparation-qu8lyw/config-cli9-broker9-final.json` — 1093 B；SHA256 `0e0e1593a0038b46510053833a2c75f8efb06e43ecc8ac18e2c432ebce4eda66`。

### E74 · Broker9/H9 Gate A 原矩阵：3 pass、1 续接 timeout、1 未运行

Final installed CLI9/Broker9 with frozen H9: the cold and two warm-new-process samples passed graph assertions; the first continued sample timed out at the frozen 300000 ms deadline. The five-sample design therefore has one further unexecuted continuation. The original result has notRun:[]; retain that accounting defect and report the missing sample independently, never rewrite the original. Original matrix status remains failed, not a completed five-sample pass. Generated-artifact and procedure evidence remain separate. Root later used public cleanup for the six terminal H9 model scratch roots in total. Original result hashes remain unchanged, with cleanup.json added per run. Two metadata selection roots were retained; active H10 consumers and scratch were not touched.

- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-A-b9-h9-SudXYi/evidence/graph-matrix-A-JXNMdx/result.json` — 16316 B；SHA256 `541c11080fe3ac67fa75bf43f7351f4df4f64b4b184eb2d5ecb6eb751a84adf3`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-A-b9-h9-SudXYi/evidence/graph-model-A-hKmBz3/result.json` — 40317 B；SHA256 `62369bc47e784c080fc0a86c9f166ee79418b10dba6ce47054d8a727e4e3efad`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-A-b9-h9-SudXYi/evidence/graph-model-A-r5bMAU/result.json` — 34196 B；SHA256 `5fb3f9dc750306d52d7af1129afa9e8d3ffdf9c7624ffc5b4537a16e69440e1e`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-A-b9-h9-SudXYi/evidence/graph-model-A-P3Dlc7/result.json` — 29111 B；SHA256 `67f8d930d9be1b149cf5daa736d9b48cd76bf8c01f1216ceaddf7a3de8887e61`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/h9-owned-cleanup-3cYHUt/result.json` — 5647 B；SHA256 `f9be28eb2c1691cb1c4f419181b252aeffb8e17b39079211716886ee4738c42d`。

### E75 · Broker9/H9 Gate B 原矩阵：3 pass、1 续接 timeout、1 未运行

Final installed CLI9/Broker9 with frozen H9: the cold and two warm-new-process samples passed graph assertions; the first continued sample timed out at the frozen 300000 ms deadline. The five-sample design therefore has one further unexecuted continuation. The original result has notRun:[]; retain that accounting defect and report the missing sample independently, never rewrite the original. Original matrix status remains failed, not a completed five-sample pass. Generated-artifact and procedure evidence remain separate. Root later used public cleanup for the six terminal H9 model scratch roots in total. Original result hashes remain unchanged, with cleanup.json added per run. Two metadata selection roots were retained; active H10 consumers and scratch were not touched.

- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B9-preflight-CSbqne/runs/graph-matrix-B-5wpSHD/result.json` — 16385 B；SHA256 `b1fb7411fd6e361c398c994c8f955e224de445cf152cc61bbe7b4ea6129e4a99`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B9-preflight-CSbqne/runs/graph-model-B-SNHnuY/result.json` — 56360 B；SHA256 `ab8f1cc1e83e37adeaa2680c4c0deded9c695a69f978495fd29a29b4b4afcccc`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B9-preflight-CSbqne/runs/graph-model-B-X6SPFu/result.json` — 50903 B；SHA256 `c1f1774683bd6a0f2dae6c550b3ec4560a796711920fbbaa25335636c0385f90`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B9-preflight-CSbqne/runs/graph-model-B-8lkhCY/result.json` — 38780 B；SHA256 `5d4858a6f69ed7329dd520616427d7089706843ca1f2ea4c6b67971d2cf2cb94`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/h9-owned-cleanup-3cYHUt/result.json` — 5647 B；SHA256 `f9be28eb2c1691cb1c4f419181b252aeffb8e17b39079211716886ee4738c42d`。

### E76 · H10 首行路径与显式预算/未运行记账：94/94、九文件 freeze 与源码交付

Root applied only the reviewed collector and explicit model budget/unstarted-sample accounting changes in four harness files. The original 300000 ms default remains; the separately declared next cohort uses 600000 ms and new cold consumers. Combined model/contract/project tests pass 94/94 with exit 0, source/test identities unchanged, no provider or Notion requests, and observed owned PIDs absent. Nine runtime files aggregate to 06269fd0aaf7ed81a2d5c536e2815cfc1e6389723bf4e9f4553084567cdbc5cf. Root fast-forward pushed harness source 3a3e06cf95e1363174a08b221d6db07add89f44d; final Broker9 product source/archive remain 967f798 and 8df7b70f. This freeze and pure old-text extraction are not H10 model passes.

- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/h10-direct-combined-G1GLy8/freeze.json` — 5080 B；SHA256 `eda830c42bf3261f2608cf4f149a104054c6ccc94807e49dd13eac4a5d495ff4`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/h10-direct-combined-G1GLy8/execution.json` — 5632 B；SHA256 `72e47122f13c1402dea7f20e4110fc9a654320212dd5a74f61f62b9e48a27708`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/h10-git-v2xjzu/result.json` — 5861 B；SHA256 `71058a4804937ba138de8bf7d3c9e4377f80a6b966408bf98cb055bb2e9bba6a`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/collector-body-path-preparation-mQFLKu/final.json` — 4345 B；SHA256 `fe7219604fe13ef73e18bf8282ad3f70cb99eb185c4bd7f742c02b0e2601c8df`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/collector-body-path-preparation-mQFLKu/actual-plans-analysis.json` — 5856 B；SHA256 `8420c0eb9dfaee6b4294c5286830c3aff9183f26806237b9f8417604eca3004c`。

### E77 · 同 Broker9 的 H9 A 原文生成规程实际 PORT 驱动及精确清理

The exact H9 A cold output was independently derived into five generated files and copied with five unchanged application files into a new owned project. The original helper performed launch/doctor/lookup-ticket/create-ticket via PORT: missing lookup returned 404, create returned 201, and independent GET returned 200 with identical id/subject/priority. Ready/health, cwd, lsof listener and exact PID ownership were verified. This covers missing lookup plus explicit high-priority creation/trimming/stored lookup; it does not cover default npm start, default priority, invalid input, restart loss or second-instance isolation. npm test is not the proof. Only owned PID 53855 was stopped; three exact helper/project temporary paths were moved to Trash, evidence preserved, listener absent, all ten source files and original H9 result unchanged. This actual drive supports AH-573; it is not a H10 model execution or a B-specific new gate.

- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/A-generated-procedure-lDJY9y/result.json` — 2700 B；SHA256 `44a7e81aa28e3a056521ff6104a1aef5448ac233562545b026ef13a317e08d0c`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/A-generated-procedure-lDJY9y/procedure-result.json` — 16503 B；SHA256 `c7471089ae1715db2dee86b2250a56c9f33737f90a676af29e53f0618750c1cd`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/A-generated-procedure-lDJY9y/cleanup-result.json` — 3863 B；SHA256 `088a8830d39a7d180bdc3afbf23c2f81ba868d608729e0527588951732d00314`。

### E78 · CLI9/Broker9 H10/600s Gate A：5 样本、3 runs 全部通过

The original H10 Gate A matrix passed all five samples (one cold, two warm-new-process, two continued-session) and all three underlying runs, with notRun empty. Its consumer used the frozen CLI9/Broker9 identities and H10 runtime at a separately declared 600000 ms prompt budget. Twelve provider requests had matching transport observations, no blocked tools, observer errors or duplicate bodies; maximum body copies was one. All 101 recorded owned PIDs were absent at closure, and runtime files stayed unchanged. Cold and first warm artifacts remain plan-only for ambiguous same-width nested fences; the third run remains incomplete-generated-files. The separate valid B9/H9 cold artifact and actual original-helper PORT execution remain E77, not a fabricated H10 exercise. This is valid B9/H10 A evidence and does not substitute for the pending final Broker10/H11 cohort.

- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-A-b9-h10-k92qBm/evidence/graph-matrix-A-gpPaqS/result.json` — 21474 B；SHA256 `48f61403a1c51c17d629b3ef09b8e2c4a1dbec54aab68ac0d626271f9e43db66`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-A-b9-h10-k92qBm/matrix-terminal-Pw94iM/terminal-summary.json` — 63273 B；SHA256 `5d60a63a20b8a6b5afcc8384d60d8c169e29b0deaec1c4c6c8d69f4e860c2052`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-A-b9-h10-k92qBm/matrix-terminal-Pw94iM/closure.json` — 41227 B；SHA256 `f04144c703abc416f4194469eaf0865658ff812991fbec6701372f71c3d2f69a`。

### E79 · CLI9/Broker9 H10/600s Gate B：原矩阵失败，两图样本通过、后三项 notRun

The original H10 Gate B matrix is correctly failed. Cold run passed; first warm graph sample passed but its run failed with two observed blocked reads: a verified main advertised playbooks/authoring-a-skill.md using File: <code>...</code>, which the discovery parser missed, and the official Pi docs/skills.md was advertised in the actual provider's developer instruction role, which the help parser ignored. The missing FileID was not the observer rejection cause. One warm and two continued samples remained notRun because no complete successful prior consumer cache receipt existed. Six provider requests had matching hashes and HTTP 200, with at most one observed resource body copy. All 96 recorded owned PIDs were absent; 158 original evidence files were frozen. The potential matrix acceptance bug addressed in H11 was found separately; this actual matrix was not misreported as passed. Original blocked reads did not execute and H11 replay never retroactively changes this result. A separate actual hook replay subsequently exposed a noFileID product deduplication gap; Broker10 work is pending and is not an explanation invented for these two observer rejections.

- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B9-H10-600s-h4QLNQ/runs/graph-matrix-B-OSnRR8/result.json` — 12268 B；SHA256 `ae62eba2a8c59450cce300bd0dada1b88dbeab7618e9f3f610064e15748106a5`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B9-H10-600s-h4QLNQ/terminal-WSSCTC/summary.json` — 38778 B；SHA256 `1bc25e35d52ecf37613ee7e647fe154a2a07127e4b4c7ce1370ff7f43284f466`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B9-H10-600s-h4QLNQ/terminal-WSSCTC/original-evidence.json` — 46310 B；SHA256 `e522bebac8f9f11f4f1eb6256d9f949e18f71f8ee4c51e1d9b3e8ef464c9dbe9`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B9-H10-600s-h4QLNQ/terminal-WSSCTC/playbook-discovery-diagnosis.json` — 10671 B；SHA256 `99664c134caaa4375c791f4f51d82e21178757fccd43c064c8d64a27939fdb19`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/pi-help-developer-boundary-preparation-KMrLBl/actual-help-analysis.json` — 15406 B；SHA256 `d8cab56bc23a4ad7471df5a2d71d56cb801bf150661d20492eef06e4358a74d1`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/pi-help-developer-boundary-preparation-KMrLBl/final.json` — 5279 B；SHA256 `fb79bb9c5f34ac09568c25691868e32ceae32eee64f40960dffb3a29cdf3bb68`。

### E80 · H11 观察器与矩阵状态窄修复：106/106 直接回归、真实源离线回放、源码已推送

H11 recognizes explicit verified File: <code>relative/path</code> references through the existing exact owner/scope/snapshot resource boundary, accepts official host help advertised by system or developer instructions while keeping lower-priority messages rejected, and requires all three runs plus five samples to pass before declaring the fixed matrix passed. Only graph-model and Pi-help runtime changed; the other seven runtime files remain identical to H10. Unified model/contract/project/help regressions passed 106/106 with zero skip/fail and exit 0; all thirteen source/test identities were unchanged across the run. Original two help tests were preserved and two new tests appended. The actual B retained main and native wrapper replay changes H10 blocked to H11 allowed, with zero model/provider/Notion calls and 158 original files unchanged. Official help pure comparison registered fourteen advertised files under developer versus zero before, while consumed count remained zero. Root committed and pushed four harness files as 927b7535140f22f6e5b9fbc1b9ad1d796ac298f5. This establishes the harness correction, not a final Broker10 model pass or a new product package identity.

- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/h11-direct-combined-LAwJ5p/result.json` — 5376 B；SHA256 `066f758058483e7bc88877ca4561984db8e9d8b806bedda71c87b26d4adc24e0`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/h11-git-Rzk0La/result.json` — 16073 B；SHA256 `da4965485dab17b304b36d8bd495259adb07cda8689fde9f60d3ff903e3df912`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/h11-model-candidate-HJIhej/actual-source-replay.json` — 6063 B；SHA256 `0c6d41c0a7c7a69a026131d1d1ddac093fc7cfe7f94232d695db4e0547f5aae4`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/pi-help-developer-boundary-preparation-KMrLBl/red.json` — 1597 B；SHA256 `9de9cdb9eceebe5df4928af8eb58d6511eab1b6330b38d51effd05a2804becd3`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/pi-help-developer-boundary-preparation-KMrLBl/green.json` — 1593 B；SHA256 `d7875535e3846452d655d5a0091ef3afa456c6d30076e65d5b03ff4821943223`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/pi-help-developer-boundary-preparation-KMrLBl/actual-help-analysis.json` — 15406 B；SHA256 `d8cab56bc23a4ad7471df5a2d71d56cb801bf150661d20492eef06e4358a74d1`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/pi-help-developer-boundary-preparation-KMrLBl/final.json` — 5279 B；SHA256 `fb79bb9c5f34ac09568c25691868e32ceae32eee64f40960dffb3a29cdf3bb68`。

### E81 · Broker10 无 FileID 完整资源去重：真实 hook 2→1，26 回归及包检查，源码已推送

The actual B warm read had been blocked and did not produce a successful resource proof. A separate offline replay copied its verified immutable entry metadata/body through the actual unmodified installHostSkills, publishNotionEntry and materializeNotionEntryFile hooks. Two complete reads without FileID produced two provider copies before the fix and one after; stored history retained both copies, mainLoaded remained false, main pin null and restored bindings zero. The narrow fix allows only proof.file_id === undefined together with parsed ref.fileId === undefined, retaining exact scope/owner/snapshot/nonempty path/hash validation and tagged identity separation from explicit FileID; null, invalid, mismatched and incomplete proofs remain rejected. Original 21 direct tests were retained with 5 added: red 23 pass/3 fail, green 26/26 exit 0. The merged package check ran 99 pass/5 pre-existing skip/0 fail with tsc and exit 0; protected source/test/CLI/Tern bytes remained unchanged across that check. The original A B9/H10 observed histories contained ten resources with explicit FileID; all three offline projections remained byte-identical, which is not a Broker10 live A run. Thirteen recorded owned replay/test PIDs were absent. Root committed and pushed only product source plus two tests as f468bd638263fc37fba25262192052e5707b2d74; no new model result is inferred.

- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/no-fileid-resource-pQQVk5/result.json` — 9579 B；SHA256 `88d8499a431cd06eb191285eeb446e023f67949627564f81121d5c291b6130da`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/no-fileid-resource-pQQVk5/producer-v2/producer-result.json` — 3747 B；SHA256 `69bf3d307f5f0fbb52b7766a3d19bd27a81169284c053819e0dcc0d8316e25d1`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/no-fileid-resource-pQQVk5/producer-candidate/producer-result.json` — 3754 B；SHA256 `897ee7b33e50d7c819dc4bd67e161ea832c1b4eec50cb87ef94d0f084bab496b`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/no-fileid-resource-pQQVk5/red-v2.json` — 1196 B；SHA256 `8dce8c33443d9f74979c196d614566b28400902da69036d20376ee2f11bf985e`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/no-fileid-resource-pQQVk5/green.json` — 1197 B；SHA256 `08b9004c67fe95f72320e76d95cb2ebe88284c56e8ff931e98c90b81ce647738`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/broker-v10-qaAKab/package-check-IH1tJR/result.json` — 3198 B；SHA256 `1185d8105472435325607aefa3b50cf910b6e8f5b770fd687177f7453f18fe49`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/b10-git-9YKXon/result.json` — 15812 B；SHA256 `a459aae2dec9c22476363f04ec700f035f113aa0b442d9777a158b14662987d6`。

### E82 · Broker10 最终 archive 与双安装身份：62 成员逐项一致，未激活

Broker10 source f468bd638263fc37fba25262192052e5707b2d74 was built and packed with the unchanged CLI9 input. Archive 41150cbaf9b05b1ad4e3223b511833ea96e8be3dd4c309918320ac4aabfb1e50 is 931572 bytes. All 62 tar members are byte-identical in the independent consumer and daily candidate installs; 48 runtime files aggregate to 8b3859857288fb5b672f5642229604f02c3eee4b70228ca42f804aedfc909246. Compared with B9 only src/session-source-snapshot.ts changed; completion.mjs is byte-identical. The exact settings/shim/standalone CLI and prior installed B8/B9 files were preserved, while root separately owns Git index checks. No activation, Notion request, provider request or model validation occurred in packaging. The two installation roots are prepared candidates; final H11 model and normal daily-session evidence remain separate future facts.

- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/broker-v10-qaAKab/result.json` — 89680 B；SHA256 `536f8b9d7245f4a9885390a4cd6fe05a275f302948dff88e4a64b22f0b72f5c8`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/broker-v10-qaAKab/pi-context-broker-0.0.2.tgz` — 931572 B；SHA256 `41150cbaf9b05b1ad4e3223b511833ea96e8be3dd4c309918320ac4aabfb1e50`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/broker-v10-qaAKab/completion-delta.json` — 956 B；SHA256 `5a48aad8b3244f3b247b73a7e9042f77ff907259276e3d3ad88bb7020241271e`。

### E83 · Broker10/H11 Gate B 原 cold 失败：合法局部 read 被误记 error，4 项 notRun

The actual Broker10/H11 600000 ms Gate B matrix failed its only cold sample with HIDDEN_FAILURE; the two warm and two continued samples were notRun. This is the original failed result, not a retrospectively passed graph sample. The native SDK first delivered the complete verified README (2761 bytes). The model later authored offset=1, limit=20 for the same already-discovered immutable file; the native result was isError=false, exact 1163-byte source lines plus a 53-byte continuation footer (1216 bytes total), and delivered_complete_text=false. The H11 observer used !target from complete-file matching to label that successful partial read an error; the unchanged contract then rejected the trace. Four provider requests were HTTP 200 with matching canonical/wire hashes and at most one full resource copy; the partial text's own hash appeared separately at the next provider. No blocked tools or preselection member-body reads were observed. The model produced a stop final, but generatedArtifact remains invalid-generated-files because of conflicting complete definitions; no complete artifact or exercise is claimed. The terminal froze 67 raw files and confirmed all 46 recorded owned PIDs absent; scratch cleanup had not been performed. Broker10 product and H11 runtime remained unchanged. Root authorized only a separate Logs H12 observer candidate, with contract and product unchanged; no H12 fix, tests or final model pass is claimed here. Concurrent A keeps its original H11 cohort; if that cohort passes it is retained without a redundant rerun.

- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B10-H11-600s-f9BiHW/terminal-IwYT0S/summary.json` — 26555 B；SHA256 `7c0621b060ada02189b19a1d098dcf2da23633810c57e4d60b0d7611eb556dcb`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B10-H11-600s-f9BiHW/terminal-IwYT0S/partial-read-diagnosis.json` — 13213 B；SHA256 `20753ef6ed11c02e42cfcbcbd2e84faa6a52e4c7a68cd05e92fa78228dd6c779`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B10-H11-600s-f9BiHW/runs/graph-matrix-B-Jqmsfm/result.json` — 6884 B；SHA256 `34b5ec0a034c9096284080bc2dc37af9403c2c5d4975604e6c4bd979c523c1ac`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B10-H11-600s-f9BiHW/runs/graph-model-B-PfAj5i/result.json` — 48646 B；SHA256 `f87125387e122733595642d63c2fe89c2d4e9634d1801141dbb59f48baffaf41`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B10-H11-600s-f9BiHW/terminal-IwYT0S/original-evidence.json` — 19744 B；SHA256 `98c8a1b6ce5340d27488ff6cfac8dda17730f68ed3bbed7780c27432079a4bd2`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/h11-direct-combined-LAwJ5p/freeze.json` — 2893 B；SHA256 `64372caeaa10ca33f38aa7e708bae005c0115492a0bed5e82bdaad3865868031`。

### E84 · 最终产品 CLI9/Broker10 Gate A（H11）：5/5 样本、3/3 runs 与 root 独立复核通过

Gate A's original CLI9/Broker10/H11 600000 ms matrix passed all five fixed samples and all three runs, with notRun empty and process exit 0. The archive remains 41150cbaf9b05b1ad4e3223b511833ea96e8be3dd4c309918320ac4aabfb1e50, product runtime 8b3859857288fb5b672f5642229604f02c3eee4b70228ca42f804aedfc909246, CLI9 JS 8c034f9d0808b7d09a014ed8affdfbe89946d7de498f143a13ab5eacac65f869, and actual H11 runtime c356aab81d1673a513f2dbfcefe993583eed8355aa48840afbfc449f574f2114. Thirteen provider requests completed with matching transport, no blocked tools, observer errors or duplicate full bodies; maximum copies was one. All 119 recorded owned PIDs were absent and 172 original files were frozen and reverified. Root independently reviewed the matrix, each raw run and final identity, then reported AH-573 Done; no Linear write is performed by this preparation. First warm retained seven complete generated files including one Skill (SHA8fc3ca...), but no npm test or other exercise was executed in this cohort; cold and last-run plan-only observations remain. The actual earlier H9 helper PORT drive stays separately bound to its true model/product origin in E77. A keeps its historical H11 identity after H12 is integrated; no rerun is required solely to align harness version names.

- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-A-b10-h11-uiJQ0u/evidence/graph-matrix-A-RMjkB1/result.json` — 21544 B；SHA256 `a8a5f2d585227b76969c980ff1573d1a291b8eb6bd51d3c654638333b99b7276`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-A-b10-h11-uiJQ0u/matrix-terminal-xZq1CH/terminal-summary.json` — 62517 B；SHA256 `8f2d841c80eae963752091169fc0fa78ce150e17a701d986c464f6437d6a0ea5`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-A-b10-h11-uiJQ0u/matrix-terminal-xZq1CH/closure.json` — 43407 B；SHA256 `d8222f0a141ed49c00ccf3407b9caa4959f36b3240e8920c85035f583e944c0a`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-A-b10-h11-uiJQ0u/matrix-terminal-xZq1CH/freeze.json` — 51742 B；SHA256 `5b9a5b54ca9ea7398e0ddf4ee868c773b31106bf95a4bc10fc7c2cf779a3d543`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-A-b10-h11-uiJQ0u/root-review.json` — 2277 B；SHA256 `698ca93404e1f15939ea9b99430215604716095839a6f0f64d8715ff6950f41e`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-A-b10-h11-uiJQ0u/evidence/graph-model-A-3wn7ng/result.json` — 40389 B；SHA256 `8af0d8db5de47bd35d9caf37886f876627488f258830b44a07ab0fec18a4d100`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-A-b10-h11-uiJQ0u/evidence/graph-model-A-C6m1lK/result.json` — 44783 B；SHA256 `b53583ffb0884a338eeb68562dd9eb9f51f6fa711ab5a78fa533a2e9de6a0b13`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-A-b10-h11-uiJQ0u/evidence/graph-model-A-ujY9Bq/result.json` — 40697 B；SHA256 `cb217e7213b318ce05a85d8987373a5abe0cb019cb5d571efb9742bb60a83af4`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-A-b10-h11-uiJQ0u/evidence/graph-model-A-C6m1lK/generated-files/.cursor/skills/verify-owned-ticket-service/SKILL.md` — 4191 B；SHA256 `8fc3ca802130aa3631afe5d5de0502b8e3ae19e66fcbbbfd656cfe2b7c96f175`。

### E85 · H12 成功局部读取观察修正：42 直接、110 组合回归与真实源回放，源码已推送

H12 only changes graph-model plus its direct test file; the other eight runtime files, graph contract and Broker10 product remain unchanged. Exact authored native pagination can be observed as a successful partial read when source lines and installed SDK footer semantics match, without marking it complete or replacing the preceding full-file proof. Genuine native failures, mismatched identities/content and unsupported truncation remain errors. The old 38 direct tests were retained with four added: red 40 pass/2 fail, green 42/42; unified model/contract/project/help tests passed 110/110 with 0 skip/fail and exit 0, and thirteen source/test identities were stable across execution. An offline replay used the exact original authored args/native results and immutable source receipts: original H11 logged an error, H12 retained complete:false with a separately identified partial output and one full body copy. Its provider envelopes are reconstructed solely for offline observer comparison; they do not replace original wire evidence or represent a new SDK/model run. All 67 original B files and original failed status remain unchanged; replay has 0 model/provider/network requests. A retained auxiliary Node24 node_modules TypeScript stripping failure preceded the successful byte-identical source-parser replay; it was not erased. Root committed/pushed a5718e50190d44ec292e105d6449aaa6e6d6d6c4; H12 aggregate is 3252ef8c9a32daed761573b3c595dd8b65ae0ab15dbf20832c46849ef179459b. A remains valid under H11. The single final B10/H12 matrix was launched separately and has no terminal result at this preparation cutoff.

- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/h12-direct-combined-kichbo/result.json` — 5378 B；SHA256 `27ce0e77fa1d59f0e6a2bf4916b7855e751af4463ddee0d91ef8bd0609534e41`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/h12-direct-combined-kichbo/freeze.json` — 3019 B；SHA256 `3c3b4e21f675166e63f91ad6772a92dfaf265dce45540776eaadf4edb1019e1d`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/h12-partial-read-candidate-KttGf7/result.json` — 8963 B；SHA256 `85628cb9054ed2ac674488b9da06807ca36076e687a25d6f53aac507928d63f6`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/h12-partial-read-candidate-KttGf7/actual-replay.json` — 12486 B；SHA256 `22851c2f85514c1f27ac8709ab0eddf8da662dc8db14e28f7d93fe60133f19e3`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/h12-partial-read-candidate-KttGf7/red.json` — 641 B；SHA256 `746fd76073ac5eaebb9a8b0b9a9f950fbb2919b8c0c3030ce0e96ad537945f09`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/h12-partial-read-candidate-KttGf7/green.json` — 644 B；SHA256 `47c65a5ebab961d12ae6b3ece1e51635e594c4288b81cae3b8554e1117a26ebc`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/h12-git-0i85Vy/result.json` — 15475 B；SHA256 `08638868031180a6f139cee32446ba55c1096685ed5d735a1a11a29378692c5f`。

### E86 · 最终产品 CLI9/Broker10 Gate B（H12）：5/5 样本、3/3 runs、真实叶子应用与完整终局

The single final Broker10/H12 worker matrix passed all five frozen samples and all three actual runs at600000ms, with notRun empty and Pro6031 exit0. Every run binds actual CLI9, Broker10 archive41150c.../runtime8b3859... and H12 aggregate3252ef... identities. Thirteen provider requests were HTTP200 with canonical/wire hashes matched. Fifteen complete resource reads and one valid partial retained at most one full resource copy per provider; read errors, blocked calls and member-body reads before selection were zero. The cold final applies verified leaf resources to the project; an independent identity comparison shows the same target/main/README and both example alternatives as successful A without adding a three-resource requirement. Cold and first warm artifacts remain plan-only; third run retains four complete files and one Skill, with no unresolved links/extraction issues. No B procedure was executed or added as a gate. Terminal freeze retains234 raw files and input identities; all166 recorded owned PIDs were absent. Consumer146HTTP=112metadata+34body,0write,29716 requestB/12907814 responseB,unknown0; retained41metadata,38330B/122627B,0body/provider/write. Raw SDK totalTokens659263 with reasoning39245 separately retained; SDK cost0 is not independent billing verification. Original H9/H10/H11 failures stay unchanged. Four current B12 scratch roots were not cleaned at the terminal cutoff; later cleanup is separate.

- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B10-H12-600s-E0yytF/runs/graph-matrix-B-2GU6gv/result.json` — 21520 B；SHA256 `e44eb51c72a4c1b38302dd8e72e071ddfce371d51c6d75f0dfb2c3dd7721ea05`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B10-H12-600s-E0yytF/runs/graph-model-B-4MTkKw/result.json` — 59135 B；SHA256 `1858cc9970217cc60a8d96c7ebc6b19863aeaed0963fa1f82dd02891cbf4bef3`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B10-H12-600s-E0yytF/runs/graph-model-B-wp97sw/result.json` — 52049 B；SHA256 `8300470ddd18e830013a5a74fb501feeb8c0024831ae8da53f4cfbfa95d96fab`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B10-H12-600s-E0yytF/runs/graph-model-B-cFA18n/result.json` — 75764 B；SHA256 `ae3bd038be8a58b2d98fa891bec615a4f1b4e09e04497f9606547c66d2e9e68e`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B10-H12-600s-E0yytF/terminal-FPaOg5/summary.json` — 12823 B；SHA256 `e8971af1faed6ab05154062d6530d5b27f6fe1be2022a4ec42fc8f9bbc584be9`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B10-H12-600s-E0yytF/terminal-FPaOg5/freeze.json` — 68905 B；SHA256 `3d841660666bfa53e6306bd5a62d7af0bc7f6b7b5a05685f29678e29e851d190`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B10-H12-600s-E0yytF/terminal-FPaOg5/closure.json` — 95134 B；SHA256 `8e754b869ebffa83af73276290408d8a9a93e621811c4d08cd1cdcfd47738914`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B10-H12-600s-E0yytF/terminal-FPaOg5/run-cost-and-wire.json` — 51699 B；SHA256 `e52b96c0c3a61520a3fea6fdc04b5a3ba277ac0ac6ef7d0edc300ed559771933`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B10-H12-600s-E0yytF/terminal-FPaOg5/frozen-inputs.json` — 31221 B；SHA256 `509fa70d46a3901581e627e5dcd6018104703aa1492b72e3c76d16fa3608a3ee`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B10-H12-600s-E0yytF/cold-leaf-application-evidence.json` — 7670 B；SHA256 `32afb76ffe72711de5dcf3ac08ffb712ca1f5a542753423ebef164e2a2b222dd`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B10-H12-600s-E0yytF/leaf-identity-comparison.json` — 15888 B；SHA256 `3c5f37bcfaf4814a9348c2833012bc6a7c2e9f7e38a4238c35860c6cc242dfb4`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B10-H12-600s-E0yytF/root-matrix-review.json` — 6657 B；SHA256 `bcd0573b3eb433ad8010223040f2ec65b0939f601f42a0e88c2525b409209357`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B10-H12-600s-E0yytF/runs/graph-model-B-cFA18n/generated-files/.cursor/skills/verify-owned-ticket-service/SKILL.md` — 719 B；SHA256 `37755a071037a765e3cca4394b9496877dc99a5cf452f1bd1f78b75d61a5ca0a`。

### E87 · 续验后精确 owned 清理：A22、较早 B14、最终 B4、selection5 与原证据保全

Four separately authorized cleanup batches removed45 exact owned temporary paths through public cleanup or Trash, never a wildcard sweep: A22 (6 public run roots+16 empty doctors), older B14 (3 public run roots+11 empty doctors), final B12 four (3 public run roots+1 empty doctor), and five selection roots. Each command exited0, target absence and cleanup-child closure were independently recorded. A preserves587 original frozen files plus12 archived originals; older B preserves457 originals plus26 archived originals; final B preserves234 originals plus20 archived session/manifest/ownership files; selection preserves65 originals. These are per-batch verification counts, not an asserted disjoint global sum. Final B cleanup closure records171 absent PIDs including the original166 and cleanup wrapper/four direct children. Public cleanup adds cleanup.json to the appropriate run evidence while original result/freeze bytes stay unchanged. Earlier terminal cleanup:not-performed fields remain historical snapshots. Selection closure retains two numerically reused historical PIDs as such rather than falsely marking them absent; no guard changes or signals to historical/system PIDs were made. No product package, global configuration or unknown operation was changed by these cleanup actions. Existing evidence bytes were preserved while new cleanup receipts were added; no model/provider/Notion request was made.

- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/owned-cleanup-plan-A-mhxwob/execution-eUjI7A/result.json` — 95975 B；SHA256 `dc9992e02aaaa06e11590069cca4ce61ff3fdcdc14145ff3a1ad9c3280414b98`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/owned-cleanup-plan-A-mhxwob/execution-eUjI7A/closure.json` — 27024 B；SHA256 `d4588ec69a4dbf99052dcd02c239fdf026a669b0106b20a330c437b8d933817f`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/owned-cleanup-plan-B-remaining-OZonui/execution-5MyJGq/result.json` — 64740 B；SHA256 `88b34a5e752b1555dacbbb3a36c2185c87982143010f4681dc08e9640d991887`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/owned-cleanup-plan-B-remaining-OZonui/execution-5MyJGq/closure.json` — 17922 B；SHA256 `44156bda72f64d257e0bce9b58a0b2ac01e44cc834edc99f62c2c64235853db6`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B10-H12-600s-E0yytF/cleanup-execution-CY2rIq/result.json` — 6089 B；SHA256 `9304e71930e45736c8da0a14a71c0147cc6be93d118ad07c048a1ce78b9f9dfa`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B10-H12-600s-E0yytF/cleanup-execution-CY2rIq/closure.json` — 12240 B；SHA256 `086da4f08938440552fe7c95721ce4b3535ffcbd4013f2d106dd88a5a911b7c6`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/owned-cleanup-plan-selections-XDSowo/execution-W3Knup/result.json` — 53936 B；SHA256 `b9bf9612e4e557443467a91f8a3f9489a133fb73a92f2abaa6d6e91838a9d025`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/owned-cleanup-plan-selections-XDSowo/execution-W3Knup/closure.json` — 10018 B；SHA256 `b5e29f9be21906f5768cf23e0279e0f185c391e23ae7fa47cccfde17d4c56349`。

### E88 · CLI9/Broker10 日用精确激活与正常新会话：目标范围通过、外部诊断及四次原失败保留

The two authorized daily files were actually switched to CLI9/Broker10 with package index1 and all20 other package entries/source configuration preserved. The final normal Pi session daily-pi-um6pwu passed using real user autoload without injected target extension or source-command override. Qualified pstack@notion exactly matched router/notion/page3fd5636c-236e-817c-ac59-c7ecfced24e7. Independent review matched all62 Broker and30 CLI published members to their archives, and actual Broker src/index.ts SHA1e7f464... plus default bundled CLI SHA86beaec... to installed identities. Default CLI doctor returned direct_http/API2026-03-11/authentication available and skill_read.checked/available true. Final actual HTTP is33 Notion requests, all200:32 metadata+1 explicit doctor current-Skill body probe by PID52110; startup/find body0, RPC provider/tool0, Notion writes0, current_body_reads1. Seven HTTP requests from retained plugins remain separate: six responses and one Remnote terminal response unobserved; this is neither all-network success nor zero global network/body activity. Config diagnostics remain ok while global Namespace remains failed for exactly25 reviewed members in two pre-existing local routers declaring a different old database/source. The verified catalog hash and exact diagnostic multiset are retained, without migration or claiming those members usable; new/changed/duplicate, target/current-source/configuration errors remain fatal. Source CLI ancestry is strictly Notion read-only2xx, host/unattributed requests remain rejected. A body exception applies only to the uniquely observed explicit doctor PID after its actual successful checked/available receipt. Four original normal-session attempts remain failed: s4xiOg/GcDyLU under global namespace rejection, NmLyI0 under unscoped HTTP attribution, qA3yKI under the earlier zero-body assumption. Offline diagnostic/ancestry/doctor replays do not reclassify them or create new live evidence. Final10 direct boundary tests passed; source/test only commit a9fc807e9d28e885f916f15d14dacd53abfe2dec was pushed, with product and graph-runtime identities unchanged. Independent passive review saw Pi51815 exit0 and eight bundled CLI children exit0, and28 recorded/outer-parent PIDs absent. Outer launch sessionID/exit were not observed; messageCount0 sessionFile did not exist and raw RPC frames were not separately saved, so zero-event claims rest on the hash-bound result and reviewed harness, not an invented independent session-file parse. Configuration, source, installed package/shim and reviewed external catalog bytes remain unchanged across validation. Original CLI1615 and Tern protected state remain under the separate Git protection receipt.

- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/daily-b10-v2-preparation-TJpiTk/activation-result.json` — 4285 B；SHA256 `76b84077b92b00ab50cf8e1aed063f0c109c0dd0f21ee7aa924085d47da3f021`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/daily-b10-v2-preparation-TJpiTk/activation-decision.json` — 4448 B；SHA256 `a5b036d41ab89262bd81bd7979ee4c41439da32d8c0967aafcbd688869755b15`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/daily-b10-v2-preparation-TJpiTk/validation/daily-pi-s4xiOg/result.json` — 10983 B；SHA256 `9dad022a789cbcd0ee34e2fb6b6cad33ab341dcc124a9f320503bb8e5ca977d2`。
- `/Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261104/ng14/worker-B10-H12-600s-E0yytF/daily-doctor-readonly-LxNMGW/reviewed-external-catalog-diagnostics.json` — 23587 B；SHA256 `9f7435a279deabd1f8df4de950eb077b2a35355d2904af35930242d6683b2f6e`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/daily-b10-v2-preparation-TJpiTk/daily-scope-review-gJl1xc/preparation-result.json` — 2064 B；SHA256 `93201160c081fc721287c671ad96c9edbf8b102b136d0a2ce1ea0c466753f014`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/daily-b10-v2-preparation-TJpiTk/daily-scope-review-gJl1xc/actual-diagnostic-replay.json` — 829 B；SHA256 `a1fcf63df66f353146104db68308af20c9e58511991f6308887076ba22139407`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/daily-b10-v2-preparation-TJpiTk/validation/daily-pi-GcDyLU/result.json` — 19162 B；SHA256 `f4d38bbe48b3749f5bae960d6bdbf4dc29612f5d19ab2cd6a973504ae61ab42a`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/daily-b10-v2-preparation-TJpiTk/daily-scope-review-gJl1xc/http-attribution-bjpkvj/result.json` — 872 B；SHA256 `a019b457332ae318a1ac4f825b94c73475ffcba0fffb1ca43122fe198f69bf7c`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/daily-b10-v2-preparation-TJpiTk/daily-scope-review-gJl1xc/http-attribution-bjpkvj/actual-ancestry-replay.json` — 1034 B；SHA256 `a8cb7d87645b356217e1cac7c53c4a3c3aef47e8202a8bed2d39cbefdc2d4d61`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/daily-b10-v2-preparation-TJpiTk/daily-scope-review-gJl1xc/validation/daily-pi-NmLyI0/result.json` — 29749 B；SHA256 `e908e2cad4ed14b5739f459f4e72bfe30304b02c66f59ff3742df16f671f920b`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/daily-b10-v2-preparation-TJpiTk/daily-scope-review-gJl1xc/validation/daily-pi-um6pwu/result.json` — 40252 B；SHA256 `edd6426eb6c18794024251271db1aadeaebb0d35296643cfce09f94d5752ddf8`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/daily-b10-v2-preparation-TJpiTk/daily-scope-review-gJl1xc/validation/daily-pi-qA3yKI/result.json` — 36307 B；SHA256 `df5e42ffa746c26b08a42e65a7c220b552ed83a21f6d2a5c771cc986cf16a97f`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/daily-b10-v2-preparation-TJpiTk/daily-scope-review-gJl1xc/doctor-probe-tO1UfO/result.json` — 993 B；SHA256 `9b2e3300cd020d0e5e29b415352630868cfe50455006094e0f7c60ebad438917`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/daily-b10-v2-preparation-TJpiTk/daily-scope-review-gJl1xc/doctor-probe-tO1UfO/actual-doctor-replay.json` — 1156 B；SHA256 `8734be9416e7a6aee88390fc8dd503819a148cf31ee39b086b195a1a80a8f040`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/daily-validator-git-Yq1qvN/result.json` — 17137 B；SHA256 `a49117ebfe021c5f1f722313a1b14e7f72c5f02fabd4184bc30b11c3a71ab445`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/daily-b10-v2-preparation-TJpiTk/daily-scope-review-gJl1xc/independent-daily-review-A-1G2vZ4/root-review.json` — 16685 B；SHA256 `a364bda372d8989ac702d010dc16a5b2c06f5a71db1ef78fb476f3209bbb2a48`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/daily-b10-v2-preparation-TJpiTk/daily-scope-review-gJl1xc/independent-daily-review-A-1G2vZ4/input-inventory.json` — 6805 B；SHA256 `a6d15091fd1a0365bce6ccac3d351a50c778837cdca2224048a44ccca1a1ddb6`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/daily-b10-v2-preparation-TJpiTk/activate.mjs` — 8707 B；SHA256 `652c083176337da4fca44c31b326cf8f64232353b725b14c744895c53bc12765`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/daily-b10-v2-preparation-TJpiTk/plan.json` — 4319 B；SHA256 `f1a2ddd573bfe5d767d401172ae7f884f3386d5fd5f0e8424a793901f2379c9f`。


### E89 · Notion05完整结果新修订、已知成功后的单段落格式纠正与独立CLI9逐字回读

The substantive worker-results revision was dispatched once and returned Success. Its strict byte verifier failed because Notion auto-linked two resource filenames and escaped four table underscores; the original failure and known applied51111-byte body remain immutable. A distinct known-state formatting operation changed only those two filenames to code in one existing paragraph, with one PATCH. Its exact final51092-byte candidate matched both direct HTTP and independent installed CLI9 readbacks (SHA9cf8086675bc3e8f363efaf4d43814d747091d4b6c74a51b6a95c6fc0df4ce92). Parent, properties and all historical sections remained unchanged. Original E63 WRITE_OUTCOME_UNKNOWN was neither replayed nor reclassified; neither was the full revision repeated. Two independent public CLI GETs performed no write/provider, returned52567 bytes, and their owned children exited and were absent. Containing documentation Git delivery and final tracker bookkeeping are recorded externally, not self-referenced.

- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/publication-worker-results-v3-xytaO4/plan.json` — 246129 B；SHA256 `39be0626255ff9c04523aea1bdab2260c147a3517f19ecb58ebf2eb91b52f604`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/publication-worker-results-v3-xytaO4/intent.json` — 1491 B；SHA256 `f7c8063b52ebdbaeb2ca6cd1f9ca7a8cb7d0c76417d209a2cd61cb2b0060426f`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/publication-worker-results-v3-xytaO4/response.json` — 51753 B；SHA256 `08f78310de753c5e66ccc45dc85e358df06b2f8f44594922400fc93343bc6d42`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/publication-worker-results-v3-xytaO4/after.md` — 51111 B；SHA256 `0bb0c0f5c805def141db5ea683bc974406f15e640e798f29b463641ca4f6f8da`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/publication-worker-results-v3-xytaO4/failure-1793736280815-63694.json` — 5352 B；SHA256 `d6febed5f71d2fb0b0b1ed7ce138be7218a96b83a37b7334ebfa0e3769d078fd`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/publication-worker-results-v3-xytaO4/known-applied-readback-review.json` — 1521 B；SHA256 `ac07da4ef9a51c8c74c2a71c88bd3854648c391f254ea38c7c13d425d9981db2`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/publication-resource-code-format-xVKzQG/plan.json` — 160044 B；SHA256 `5d1c957fd6dd3035d1809247b8357f6fe800a53550719d936127b92a257b42cb`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/publication-resource-code-format-xVKzQG/intent.json` — 629 B；SHA256 `74acae80f54c665f5e3f8183543cc1a4594b1323fca72b99b37a3e5e58c73275`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/publication-resource-code-format-xVKzQG/response.json` — 51734 B；SHA256 `b30b57bdf3379973986a35e41d7acfe2398987ca979daf1efce4a1d8fb8481e8`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/publication-resource-code-format-xVKzQG/apply-result.json` — 1751 B；SHA256 `41c62954541acb917d47a8dc1c8be5b3cffaa5be43347e76ce3b412a356febba`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/publication-resource-code-format-xVKzQG/candidate.final.md` — 51092 B；SHA256 `9cf8086675bc3e8f363efaf4d43814d747091d4b6c74a51b6a95c6fc0df4ce92`。
- `/Users/yoyo/Library/Logs/ntn-skills/AH-561-20261104/ng21/publication-resource-code-format-xVKzQG/independent-cli9-readback-AjF3P8/result.json` — 6510 B；SHA256 `e2e983274fb94e36f3ecbbc06f033d38582814ce51629be61aad7ecf30438b4d`。
