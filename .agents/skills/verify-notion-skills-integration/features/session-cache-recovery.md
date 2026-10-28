# 会话缓存与恢复

前置条件：harness 创建独立 session 与 fixture source，双 Pi/OMP 原生会话路径可用。缓存证据必须同时核对 source 调用与 provider 当前有效上下文；不修改用户 session。

真实 Notion fixture 的独立入口为 `node scripts/verify-notion-integration.mjs doctor --mode live-fixture --database UUID` 与 `node scripts/verify-notion-integration.mjs run --mode live-fixture --database UUID`。唯一页与 `references/guide.md` 创建、消费、finally archive 本次页及 child pages 的 GET 回执保存在 `live-fixture-create.json`、`live-fixture-cleanup.json`；它不自动证明本地图的错误/超时与 cold/warm，仍须对应确定性证据。只读 live 不替代远端端到端。

仅 deterministic/installed 主 run 调用 OMP 的 runSourceLifecycle 子 helper，真实 fork/branch/compact-remove+refresh 的 assertion 必须审阅 helper 返回的实际证据文件及 manifest 列出的 `omp-source-lifecycle-cli-calls.jsonl`。fork/branch 后按有效上下文判定正文；compact-remove 后再次消费必须恢复正文。refresh 必须调用 `list --refresh` 并重建 metadata，只等待元数据完成，随后可后台预取所选 View 成员；预取不得发起 provider 请求或写入 loaded/Read 记录。该 helper 只证明实际执行的 OMP，不扩展为 Pi 或 live 结论。双宿主后台与生命周期按 [默认上下文地图](default-context-prefetch.md) 独立取证。Notion native cold print 看 `*-cold-print-provider.jsonl`，不由暖路径推断。

live-fixture 恢复 recipe：`node scripts/verify-notion-integration.mjs run --mode live-fixture --database UUID --resume-evidence /absolute/FAILED_EVIDENCE`。创建 deadline 15 分钟；成功与失败均保存 `live-fixture-create.json`，失败包含 allowlist 投影的 operation/page/receipt/stage，不保存任意 stdout。unknown 不得再次 create；先检查原 operation receipt，需要继续发布时仅用产品 `resume OPERATION_ID`。旧 scratch ownership/input、原 create 回执的精确 pageId、catalog 的该 ID/name/database 与 read canary 均通过后本次不 create，最后 archive。不能只凭同名重建或清理。

只恢复 cleanup 时运行 `node scripts/notion-fixture-cleanup.mjs /absolute/EVIDENCE`（可选第二参数为官方 ntn command JSON）。它读取原 `live-fixture-create.json` 的 owned pageId、枚举 child IDs，先 GET；仅 GET 确认尚未 inTrash 才对该对象一次 PATCH 后 GET，unknown 不 PATCH，不 create、不自动重试；GET 确认 true 才 archived。`live-fixture-cleanup.json` 在请求前及 finally 保存每对象 attempt/result/unknown/failure，未完成为 failed/blocked。再次显式运行按同一组已知 ID reconcile，保留 previousAttempts；原失败 run manifest 不会变 pass。父页 inventory 不完整时阻止父页归档。服务复验只使用已核实 owned 对象，不在线上注入故障。

| ID | 用户入口与动作 | 可观察 assertion |
| --- | --- | --- |
| NS-SESSION-01 | 用户冷启动会话，发现并激活目标 | fixture 实际发生首次读取，provider 收到正确正文；不能由仅候选出现推断缓存成功。 |
| NS-SESSION-02 | 用户在暖会话重复发现、读取或激活目标，并从原生 `/skill:` 切到 `$` | fixture 调用记录与 decisions 显示实际缓存复用边界；双宿主跨入口 provider 保留且仅有一份正文，内容不串到重名目标。Pi 的可信 native receipt 必须与仍在有效上下文中的正文 digest 配对；孤立 receipt 或普通用户 XML 不得抑制激活。 |
| NS-SESSION-03 | 用户持久化后通过 continue 续接同一会话，再提交引用 | 两宿主实际恢复 session；按恢复后的有效上下文决定加载，provider 中目标正文完整且不新增重复副本。 |
| NS-SESSION-04 | 用户遇到 fixture 错误或超时后再次走可用读取路径 | 错误/超时有真实失败记录；可用路径读到真实正文，失败值不冒充可用缓存。若恢复路径未执行，明确未运行。 |
| NS-SESSION-05 | 用户在 OMP 对 source 激活后的真实会话 fork/branch | 子会话与分支实际建立，provider 正文与当前有效上下文一致，不以旧 branch 日志冒充新上下文通过。 |
| NS-SESSION-06 | 用户 compact 移除正文后重新激活，再 refresh source | compact-remove 后 provider 恢复真实正文；refresh 实际发生 `list --refresh` 并重建默认目录，后续 View 成员后台准备不向会话注入正文；helper 返回证据对应实际动作。 |
| NS-SESSION-07 | 用户用失败 evidence 恢复真实 Notion fixture | ownership/input unique name、catalog exactname 唯一与 read canary 均验证；本次无 create，最终 archive/GET 回执确认，仅操作所属页。 |
| NS-SESSION-08 | Tern/OMP 新进程首个 `$`、同进程 `/new`、保留 conversation 的 `/restart`、退出后新进程 | 运行既有 daily runner 的 `--mode captured --invocation dollar --lifecycle --lifecycle-selection alias@namespace`，重名时 selection 包含 page ID 并与既有真实候选一致。首个草稿恰好是一个 `$`，先于 gate 后真实 list 成功；放行后不重输即可出现实际候选，再追加目标前缀。无启动前 list/read/query、无 session_start metadata 等待；各项真实菜单/胶囊直到提交前 provider+0，完整固定正文一次。PID/session file 与 user/assistant turn 证明新会话、保留会话、新进程的区别。失败截图和阶段保留，不换 alias、重复输入或先 restart 掩盖；完整证据规程见[日常安装地图](daily-installation-ui.md)。 |
| NS-SESSION-09 | `live-fixture --cache-lifecycle true`，独立空 CLI/Broker 根分别启动实际 Pi 终端、OMP 终端、Tern/OMP 原生窗口 | 未勾选的 owned 页在首次激活前无 read/export；首次 `$` 实际下载 Notion 正文、导出固定 snapshot，provider 中经 XML 转义的完整正文含 frontmatter 恰好一份。终端保留真实 PTY 输入、ANSI 与解析 screen；Tern 另保存实际菜单、Tab 胶囊及提交截图。 |
| NS-SESSION-10 | 首次 `$` 后同会话重复、`/new` 和退出后的新进程 | provider 正文一份；后两者复用完整 immutable export，Notion 正文请求为零，CLI `validated_at` 不前移。CLI 进程调用与实际 Notion HTTP 分开计数。 |
| NS-SESSION-11 | 直接 PATCH 自建 Notion 页和自建 guide 的 authored paragraph，GET 确认 B | 有效旧会话继续 A；新会话在默认五分钟有效期内仍 A。仅修改唯一 owned block，不重发未知写入、不手工修改 publication marker 或既有业务页。 |
| NS-SESSION-12 | 验证直接编辑的发布检查、接受精确 owned 版本，按实际 `validated_at` 等待默认 300000 ms 过期后再次使用 | 未接受的 managed 原生页 `read --refresh` 返回 `PUBLICATION_DIVERGED`；`inspect-edit` 核对 B 正文和 guide，再以其精确 version 执行 `accept-edit`。过期后已加载旧会话仍 A；新会话实际请求 Notion 并导出不同的 B snapshot；真实 read 工具消费同一 B snapshot 的 guide，资源读取不再请求 Notion。使用真实时钟和默认策略。 |
| NS-SESSION-13 | `--mode deterministic --shared-catalog true`：不同 cwd、Pi/OMP、source ID/namespace、命令拼写和等价 database selector | 两个真实宿主首次 `$` 均消费正确完整正文；只建立一份 catalog/index 和一次 immutable export，第二端不新增 list/export，不推进原始 `validated_at`。独立宿主会话与 provider 捕获分别保留。 |
| NS-SESSION-14 | 同一 shared-catalog run 在一端 `/context-broker refresh`，保留两个已加载会话，再分别启动两个新进程 | 共享 catalog 选择新的不可变观察；两端旧会话仍 A，新会话读取 B，另一宿主复用同一 B export，正文各一份。此处 Notion transport/provider 为受控 fixture，不宣称真实远端编辑或真实模型通过。 |
| NS-SESSION-15 | CLI identity 回归与 Broker catalog-cache 回归 | 等价数据库 selector 共用身份；凭据和远端查询范围变化隔离；本地 TTL、创建偏好、namespace、项目路径、命令拼写不分区；按当前策略从原始校验时间重算 TTL，过期/强制刷新在另一端可见，旧格式和损坏目录重建。 |
| NS-SESSION-16 | `storage --case catalog-order`，旧 list 回应完成后挡住 stdout，新 discovery 先完成并发布，再放行旧回应 | 共享 catalog 的 alias、原始 `validated_at`、indexId 均保留新观察；另一个独立进程 lookup 仍见新 alias/时间，两次 discovery 返回的 metadata 路径仍可读。 |
| NS-SESSION-17 | `storage --case snapshot-race`，两个独立 API 进程同时首次 read/export | 两个完整 export 均已写完各自 stage 后，先放行 A 并等其 load 完成，再放行 B；两个 load 都成功且返回同一路径/快照，body 与 read 原件逐字节相同；最终仅一个完整 immutable snapshot，active cache 不留 losing `.stage-*`。允许重复 read/export。 |
| NS-SESSION-18 | `hosts --case host-first-body`，真实 Pi/OMP 各自完成 discovery 后并发首次 `$` | discovery 后无正文 read/export 和 provider；两个实际宿主在 read/export gate 上都就绪后依次放行。两次首次提交均成功，各 provider 含同一完整固定正文及 frontmatter 恰好一次；最终 inventory/resource hash 与 receipt 完整匹配且无 losing stage。只证明受控 source/provider 与实际宿主投递。 |
| NS-SESSION-19 | `storage --case snapshot-mismatch`，同 snapshot 的完整 export 资源字节不同 | winner 先完成，另一份 export 的资源与 inventory/content ID 一致地受控改变，主正文相同；后者明确 `SOURCE_OUTPUT_CONFLICT`，不能静默成功或替换 winner 的正文、receipt、完整资源 inventory。 |
| NS-SESSION-20 | `storage --case catalog-equal-time`，按 NS-SESSION-16 调度，两份 `validated_at` 完全相同 | 后预约且先完成的观察保持选中；延迟旧回应不能更换 alias、index 或独立 lookup 结果。时间相同不能代替请求顺序。 |
| NS-SESSION-21 | `storage --case catalog-clock-rollback`，按 NS-SESSION-16 调度，后预约观察的 `validated_at` 更早 | 后预约观察仍保持选中，原始校验时间不改写；请求顺序与 TTL 分开验证。 |

```bash
node scripts/verify-notion-integration.mjs doctor --mode deterministic
node scripts/verify-notion-integration.mjs run --mode deterministic
```

这组 recipe 包含 metadata、首次 `$`、repeat、continue 与 fixture cold/warm、错误/超时路径。不能以进程重启日志代替实际 continue，也不能把历史 session 中已有正文误判成新注入或当成读取请求已发生。

NS-SESSION-08 是[日常安装地图](daily-installation-ui.md)的受控 metadata 调度分支，使用实际日常 CLI/source 身份、owned 空 Broker cache 与 gate，不能称为正常日常 source 验证或 CLI 内容缓存冷启动。`/restart` 后当前窗口可用不能代替 `/new` 和下一新进程；真实日常 source smoke 与模型效果另取证。该分支不取代本地图已有双宿主 continue/fork/branch/compact 验收。

审阅 `manifest.json`、`source-cli-calls.jsonl`（fixture only）、两个宿主的 provider/decisions jsonl 和 rpc JSON。错误 fixture 被正确断言为预期失败与整个验证命令失败是不同层：只在该 ID 的实际 assertion 满足时记 pass；被跳过、超时未收口或证据缺失不得 pass。

运行后 `node scripts/verify-notion-integration.mjs evidence --evidence /absolute/evidenceDIR`。审阅后 `node scripts/verify-notion-integration.mjs cleanup --evidence /absolute/evidenceDIR`，再执行 evidence；manifest.scratch 指向独立 `/tmp` scratch，ownership.json 用于归属，cleanup.json 记录清理结果。只将 scratch 移入系统 Trash，保留 evidence 与失败记录。本文未执行验证。

真实 CLI 内容缓存与 Notion 编辑使用独立入口：

```bash
node scripts/verify-notion-integration.mjs doctor --mode live-fixture --cache-lifecycle true --database UUID --command-json '["/absolute/ntn-skills"]'
node scripts/verify-notion-integration.mjs run --mode live-fixture --cache-lifecycle true --database UUID --command-json '["/absolute/ntn-skills"]'
```

该专项要求实际 Tern/OMP 与 Pi，使用现有认证和三组独立 CLI config/state/cache/data、Broker cache 与 sessions。默认有效期来自实际 CLI freshness。`cache-lifecycle-result.json` 逐宿主记录 A/B snapshot、完整正文 digest/bytes、验证时间、每阶段正文请求/export/provider 增量；`cache-HOST/safe-source-requests.jsonl` 记录实际 CLI 和官方 ntn method/path，排除 header、payload 与凭据。终端 `uiEvidence` 保留 PTY 原始字节、解析 screen、自然退出 PID 回执；解析器不支持的终端控制序列明确记录，不将其称为截图。Tern 的独立 `uiEvidence` 包含原生截图及 cleanup 回执；deterministic provider 捕获不证明真实模型效果。OMP RPC 的 25 秒保护早于宿主 30 秒事件限时，该专项使用实际交互终端，不修改保护或用预热掩盖首次下载。创建与 finally archive 沿用 owned fixture 回执；失败保留阶段，部分宿主通过不能计为全量通过。专项不替代既有超时、continue/fork/branch 或正常日常安装验收。

本 fixture 由 CLI 发布，直接修改原生段落后须沿产品已有的 `operation inspect-edit` → `operation accept-edit --expected-version` 接受精确版本。`remoteEdit.inspection` 保存接受前 `PUBLICATION_DIVERGED`、检查的 version/snapshot/content hash；`remoteEdit.acceptance` 保存接受与验证回执。检查和接受仅使用父控的独立 CLI 根，不预热三端内容缓存；不手工清空或替换 Publication 字段。未接受的修改不能写成“过期后自动可读”，人工维护页和 editable-file 不由此 fixture 推断。

## 共享 Notion 缓存

Notion 的 `Default Context` 只控制默认目录和后台准备，不表示项目归属。默认全局 cache 按凭据与实际远端目录复用；namespace/source ID 属于调用和宿主注册。显式 `cacheDir` 仍控制存储位置。不要为验收给 Notion 增加项目字段，也不要把会话固定版本当作可变远端内容的项目分叉。

从 Broker checkout 根目录运行：

```bash
node scripts/verify-notion-integration.mjs doctor --mode deterministic --shared-catalog true
node scripts/verify-notion-integration.mjs run --mode deterministic --shared-catalog true
bun packages/context-broker/scripts/catalog-cache.test.ts
```

共享专项复用现有 integration 的 Doctor、RPC、provider 捕获、进程 ledger、evidence/cleanup。`scripts/notion-shared-catalog.mjs` 在独立项目目录启动真实 Pi 和 OMP，以同一受控 source/cache 验证 NS-SESSION-13～14；保留 `shared-catalog-result.json` 和四个 `shared-*-provider.jsonl`/`-rpc.json`/`-decisions.jsonl`，核对 index、原始校验时间、A/B snapshot 和 list/export 增量。RPC 收口后主动 teardown 不冒充自然退出。该 route 不执行原生菜单、真实 Notion 或真实模型；原生菜单刷新/失败仍跑 `node scripts/verify-native-ui.mjs --catalog-cache` 和 `--catalog-cache-failure`。

NS-SESSION-15 的 CLI 边界从 CLI checkout 执行 `bun test packages/cli/test/cli.test.ts --test-name-pattern 'consumer catalog identity'`，对应 [C20](https://github.com/yoyooyooo/notion-skills-cli/blob/main/.cursor/skills/verify-ntn-skills/features/sync-cache-verification-plan.md#cache-time-and-identity-matrix)。CLI 的 `ctl cache identity --database SELECTOR` 必须与实际 list 选择一致；不加入 cwd、命令字节/mtime、PATH、cache roots 或整份本地 config。Broker 回归使用独立 CLI 子进程，并验证身份隔离、共享刷新、策略 TTL 和损坏恢复；实际宿主投递只由上述 shared-catalog run 证明。

用本次真实 evidence 路径执行 `evidence`、`cleanup`、再次 `evidence`，保留失败记录。修改 Skill 只维护规程；只有具体运行回执才能记录通过。

## 并发发布与首次正文

复用本 Skill 的可执行 [concurrency harness](../scripts/verify-cache-concurrency.mjs)，不运行旧 `/private/tmp/broker-concurrent-vpvgU2/investigate.mjs`。入口位于本 Skill，工作目录仍为 Broker checkout 根目录。`storage` 不启动宿主，不继承凭据，不访问真实 Notion。Node 编排两个 Bun 子进程，直接导入当前 checkout 的 `notion-source.ts`，复用现有 `createNotionFixture()`。`hosts` 使用现有 RPC、隔离环境、fake provider 和 process ledger helper，实际启动 Pi/OMP 及当前 checkout extension，不从 API 结果推断宿主通过。

`--case` 可用名称或完整 ID，也可逗号分隔或重复传入。省略时 `storage` 执行 `catalog-order`、`snapshot-race`、`snapshot-mismatch`、`catalog-equal-time`、`catalog-clock-rollback`；`hosts` 执行 `host-first-body`。跨 mode case、未知参数、未知 case 均拒绝，不静默跳过。每个选中 case 独立运行，独立 assertion 逐条保留；一个 case 失败继续其余 case。Pi/OMP 启动、提交与 teardown 的独立错误也保留。只有全部选中 case 通过才是 run pass，Doctor 就绪和 evidence preserved 均不覆盖失败状态。

先执行 Doctor。Doctor 只在 owned scratch 用 `--version` 探测 storage 的 Bun，或 hosts 的真实 Pi/OMP，并记录 Node 和当前入口 SHA-256。Doctor 不导入运行产品、不发现 Notion、不调用 provider。每次 Doctor 也输出自己的 evidence/scratch，应按下文清理。

```bash
node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs doctor --mode storage --case catalog-order,snapshot-race
node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs doctor --mode hosts --case host-first-body
```

修复前必须保留失败证据，再允许产品修改。以下两个命令是可直接运行的 fail-before recipe。第一个足以挡住修复阶段；第二个单独证明实际 Pi/OMP 首次正文路径。旧代码预期失败项为 NS-SESSION-16 的 catalog alias/validated_at/index 回退，以及 NS-SESSION-17/18 的 active losing stage。已知旧路径两个 load 本来都会成功，不能把重复 read/export 或本来成功的正文加载误报为修复目标。

```bash
node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs run --mode storage --case catalog-order,snapshot-race
node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs run --mode hosts --case host-first-body
```

修复后在同一 checkout 重新执行完全相同命令，分别保存新的 pass-after evidence，再运行 mismatch 负例。各次独立 scratch 保证不复用上次已发布内容。

```bash
node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs run --mode storage --case catalog-order,snapshot-race
node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs run --mode hosts --case host-first-body
node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs run --mode storage --case snapshot-mismatch
node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs run --mode storage --case catalog-equal-time,catalog-clock-rollback
```

调度用 `concurrency-transport.mjs` 的 ready receipt 与逐 consumer release 文件，`fs.watch` 加初次存在检查等待显式 gate，不用 sleep 安排并发。catalog case 先捕获已完成的旧 list，再等新 discovery 真正发布；最后才放旧回应并启动新 lookup。NS-SESSION-16 使用递增校验时间，20 使用相同时间，21 使用后请求校验时间更早的情况。catalog 存储检查读取最高已发布序号的 receipt，alias、时间、index 和独立 lookup 断言不随布局改变。snapshot case 将两个 read 与两个已完成的 export 同时挡住，确保两个 stage 都存在，再让一个 load 完成后放另一个。host case 先等待两个 `/context-broker refresh` 原生命令完成，未勾选 Default Context，防止预取消除首次正文竞争。它没有 UI/menu、真实 Notion、真实模型或取消/崩溃覆盖声明。

review 本次打印的 evidence 绝对目录，不能复用历史路径。`manifest.json` 含精确命令、case/ID、全部 failures、未运行项、Doctor 与 scratch 归属；`CASE-result.json` 逐条记录 assertions。每个 case 子目录含 `gates.jsonl`、原子写入的 `gates/OPERATION.CONSUMER.ready.json`、release 文件与 `source-cli-calls.jsonl`。catalog 另留 `newer-published.json`、`observations.json`、`workers.json`；snapshot 留完整 export receipt、`workers.json`、`cache-state.json` 中最终正文 bytes/SHA-256、receipt、全资源 inventory 和 active stages。mismatch 负例在 `cache-state.json` 分别保存 before/after winner；该负例保留拒绝的 stage 诊断，不把拒绝路径的保留误计为 identical-publication 清理通过。

实际 host case 另保存 `discovery.json`、`completions.json`，以及 `pi-`/`omp-` 的 provider、decisions、RPC 文件。provider 校验当前首次请求中的完整 XML 转义正文和 frontmatter，不只匹配 canary；宿主既有尾部换行呈现归一化与底层 snapshot 的精确字节验证分开。`owned-processes.jsonl` 的真实 spawn/close 回执覆盖 worker、Doctor 与宿主。RPC 完成后的主动 teardown 不声称自然退出。失败与缺失证据均保留，不重试掩盖首次结果。

每次 Doctor/run 的 evidence 分开执行审阅、cleanup、再次审阅。把 `/absolute/EVIDENCE` 替换为该次命令输出的真实路径。`evidence` 报告 `functionalStatus` 和文件完整性，失败证据可正常 preserved；它不把 failed 改成 passed。cleanup 先核对每个 owned 进程的 close，以及 scratch 的系统临时根、prefix、`ownership.json` 的 runId/evidence，再调用系统 `/usr/bin/trash`。只回收 scratch，保留全部 evidence；Trash 不可用或归属/退出回执不足时明确失败，不永久删除或批量 kill。cleanup 后再次执行 evidence 仍可审阅原始失败状态。可用 `--evidence-root ABSOLUTE_DIRECTORY` 只改变证据父目录。

```bash
node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs evidence --evidence /absolute/EVIDENCE
node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs cleanup --evidence /absolute/EVIDENCE
node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs evidence --evidence /absolute/EVIDENCE
```

本文只定义可重跑规程，未执行任何检查，也不声称通过。



## AH258–260 shared content acceptance

Run two explicit Prompt submissions with different materials in one session for Pi and OMP separately. Each provider request must include the current full task requirements; retain real-model results independently. Stop, timeout and session/branch changes must fence old generations, and a subsequent submission must work. Do not count total historical body copies as per-turn proof.

No execution is claimed by this map update; final owner runs and retains the evidence.

