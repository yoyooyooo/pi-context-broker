# 工程窗口首次配置停止与同窗口修复（2026-11-25）

本记录保留一次真实的配置失败及其修复边界。首次执行停在无模型启动采集阶段，未进入正式测试；既有结果仍为 **104 个已闭合观测、13 次注册**，剩余 **35** 项没有被消耗。本文及修复代码不代表第二次尝试已经获准或执行。

已发布的 104 项及其范围继续以 [PR72 的原结果记录](benchmark-observer-repair-continuation-2026-11-25.md) 为准。本次没有重新评分、重放或改写这些结果。

## 实际发生了什么

用户批准后，首个工程窗口从 **2026-11-25 13:23:59.727 至 2026-11-26 13:23:59.727（UTC+8）** 生效，即 `2026-11-25T05:23:59.727Z` 至 `2026-11-26T05:23:59.727Z`。协调器完成绑定后执行了一次正常 `configure`，于 `2026-11-25T05:30:30.726823Z` 以退出码 1 停止。

| 项目 | 本次实际数量 |
| --- | ---: |
| Configure 命令 | 1 |
| 留存的 capture 尝试 | 3 |
| 实际启动的 subject 子进程 | 1 |
| 完成的无模型 capture | 1 |
| 模型 HTTP 发送 | 0 |
| 新正式测试预约 / 新注册 / 新闭合观测 | 0 / 0 / 0 |
| 正式 runner / 正常分析命令 | 0 / 0 |

原设计有四组共享启动输入。Broker/free 的 e0 和 Broker/off 的 e2 均在 subject 启动前失败；Native/free 的 e1 完成 capture；Native/off 的 e3 尚未启动。

失败的直接原因是新的私有协调器清理了 `NOTION_API_TOKEN`，而其调用的旧 wrapper 只补入模型密钥。Broker 使用 Notion entry，launcher 明确要求该 Notion 变量；native 不要求它。因此修复点在协调器与凭据 wrapper 的交接，固定产品构建、模型参数与 collector 未发生变化。

## 零发送结论的证据范围

零发送结论没有由“预约数量为 0”反推。

两个 broker capture 的实际错误都为 `Environment variable is not set: NOTION_API_TOKEN`。固定 launcher 先独占创建 run 根目录，再校验传入的环境变量，最后才创建 subject 子进程。这两次实际只留下空根目录，`shared` 和 `episode` 均为 null，错误准确对应 spawn 之前的断言。

Native capture 的实际 runtime 记录了 `provider_send_blocked`，原因是 `BENCHMARK_ADMISSION_CAPTURE_COMPLETE`。Transport reconciliation 与终态均完整，`model_http_requests`、`guarded_fetch_attempts`、`attempts` 为 0，cleanup 完成。已经构造但被阻断的 payload 记录，其 `attempts` 为空、`accounted` 为 false，不能计为模型发送。

独立审查还确认所有本次拥有的子进程已退出、没有活跃 lease，原 104 份 reservation、13 份 registration、两份 ledger 与两份 frozen plan 共 121 个引用字节未变。

失败 capture 原有的 `invalid` 状态及通用的 request/cost `unknown` 文案完整保留。额外的确定性 pre-spawn 证明单独记录，不修改原 receipt，也不把它改判为通过。关键私有证据的文件 SHA-256 为：

| 证据 | SHA-256 |
| --- | --- |
| 首次停止 receipt | `fa59f97267c535544d499e391c52369c7a4b7b068343db639c2de363c33fe420` |
| 独立停止与零发送审查 | `02635cba070fba444d6f6a2d4c7a5d0cc1dbc878fac1c2ff9db6985f73a1214c` |
| 原独占执行 claim | `ba42531a456f93c3212c7daea5aad39d9ee28b7590474fef7f0a19cf4074c433` |

这些 hash 便于关联私有审查，不将私有原件或凭据放入公开仓库。

## 为什么修复需要独立身份

旧协调器只有一次独占 claim，没有 resume、adopt 或自动 retry 路径。更换输出目录不会更换 claim。Capture ID 又由 experiment ID 固定派生，旧失败目录已经占用了对应身份；更换 control root 也不能消除碰撞。

原 v7 authority 将 experiment 与 allocation 身份绑定到已批准 draft。普通 v7 decision 的窗口必须在批准时间之后开始，因而也不能用一个更晚的批准记录回填原窗口起点。修复保持这些既有检查，新增明确的 **v8 `accepted-engineering-preflight-repair`** 类型。

新类型只接受原 v7 作为 parent，并重新验证这次独立零发送证明及其实际命令和 capture 原件。新 decision 必须明确批准本次 repair，记录真实批准时间，且时间仍在原窗口内。它继承原窗口的完整起止，不重新计时。

尚未激活的 CodeMode owner 从 `engineering-codemode-window-17-1` 更换为 `engineering-codemode-window-17-2`，experiment 对应从 `benchmark-codemode-window-17-1` 更换为 `benchmark-codemode-window-17-2`。其余六个未开始的 scope 保持原身份。旧 claim、目录、无效记录和成功 capture 均保留，不被新身份采用或覆盖。

## 修复后的执行边界

模型仍为 `auto/gpt-6.2-sol`，`thinkingLevel: medium`，`maxTokens: 4096`。分配仍为 **17 + 2 + 2 + 2 + 2 + 2 + 8 = 35**，目标 139、硬上限 144、未分配 5。原 CodeMode 7 项的消耗继续扣除；剩余 CodeMode 请求上限为 209，输入 token 上限为 7,079,778，输出 token 上限为 381,132，时长上限为 4,922,651 ms。

新 CodeMode 仍只选择原 24 槽设计的未启动 17 槽，科学分母保持 24。原窗口七项不补入新协议的缺失格，不跨窗口配对。历史六条用量未知保持原状，完整历史费用仍不宣称已知。

凭据修复仅按名称传递所需变量。Notion token 在新 launcher、协调器、付费阶段 recorder 和固定 wrapper 的受控进程环境中交接；模型密钥只由 wrapper 读取。正常分析不接收这两种凭据。凭据不写入命令参数、日志或新文件；缺少 Notion 凭据会在创建新执行 claim 前被拒绝。

私有凭据链的 22 项离线验证已通过，包括实际子进程、实际 recorder 输出检查，以及新协调器实际 `stageEnvironment` 函数的付费阶段与分析阶段隔离。测试使用假凭据和禁止网络的子进程，没有读取真实凭据文件，没有运行 Benchmark controller 或模型。

公开入口的准备、绑定和执行规则见 [Benchmark 运行入口](benchmark-running.md)。新 runner 使用 `run-engineering-preflight-repair`，旧 `run-engineering-window` 仍仅接受 v7。修复后的尝试继续执行失败即停，不自动重试或续窗。

## 当前结果边界

本次零观测停止没有可发布的新成绩包。修复协议、源码测试与离线凭据验证是执行准备，不计作真实模型结果。新的 repair decision、authority、claim 和实际采集均需在具体恢复尝试获准后另行生成。

将来若产生真实、完整结算的闭合观测，发布必须保留本次 preflight repair 来历、正常分析命令、隐私核验及独立公开包重放。公开统计重放不替代私有零发送原件审查，也不增加历史样本。
