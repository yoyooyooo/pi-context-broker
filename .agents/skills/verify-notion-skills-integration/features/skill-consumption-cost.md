# Skill 消费成本：只读观察与冻结基线

归属 [SC02 / AH-619](https://linear.app/yoyooyooo/issue/AH-619)，完整入口地图见 [Skill 消费链](skill-consumption.md)。本规程交付测量与基线，不代表后续性能预算、SDK、压缩恢复或日用安装已经通过。已执行的样本、失败和方法边界见 [2026-11-04 基线报告](../../../../packages/context-broker/docs/skill-consumption-baseline-2026-11-04.md)。

## 观察边界

| 层 | 驱动 / 原件 | 计量含义 |
| --- | --- | --- |
| Pi 用户提交与 provider | `skill-consumption-cost.mjs` / observer JSONL | 同机单调时间、实际 provider hook 的 JSON bytes/hash、tool schema/目录/正文/资源/历史的分项字节与模型报告 usage |
| 模型 HTTP | `skill-consumption-provider.mjs` / transport JSONL | Node Undici diagnostics 的实际 request body hash/bytes、response entity chunks、真实尝试；不替换 fetch、不消费响应、不注入工具参数 |
| Source CLI | `skill-consumption-source-baseline.mjs` / 每个 child 的 receipt、stdout、lifecycle | prepare 后逐节点固定 read，或独立单资源 read；request_metrics 中的 metadata/body/retained-body/write/provider、retry、queue 与响应解码字节 |
| Pi 默认 Source SDK / 显式兼容 CLI | `skill-consumption-source-observer.mjs` / safe-source-requests JSONL | 进程内 SDK list/consume/read/read-resources 的公开 start/end 与安全 request_metrics；显式兼容 CLI 的真实 spawn/close 和完整 stdout 中的 request_metrics。SDK 操作、CLI 子进程与 HTTP attempt 分别计数 |
| 普通启动顺序 | `skill-consumption-startup.mjs` | 实际 Pi，受控 source/provider；原生 RPC 提交先于目录完成。受控 stream 不等于真实模型 HTTP 或 token |
| 真实模型成本任务 | `skill-consumption-model-baseline.mjs` | 固定 magpie/group/flash-free；正常工具、冻结的普通或 Skill 任务；独立 cold 进程和最后一个进程中的 existing-session warm 续接。原 driver 的 `pi-native-local` 臂不加载 Broker，使用 Pi 原生发现/read；任务类型分组记录，成本 driver 不替代 Skill 完整消费断言 |

被动成本 observer 的 JSONL 使用 0600 权限、逐事件 hash 链和同机 monotonic clock。成本日志不保存认证头、token、签名 URL、原始 CLI stdout 或完整 provider 正文；独立 Source CLI driver 的原件保留规则另按该 driver 执行。metadata selection 另保留无 Skill 正文的实际 provider JSON、受控本地 HTTP payload 和 SDK 目录结果，用于比较完整候选集合。实际 payload 的 hash 必须与 transport 发送 body 对齐；hash/摘要本身不证明 Skill 正文投递，后者仍由消费链的完整 span 断言负责。纯本地臂使用同一成本和 HTTP observer，并以原 driver 内的 native inspection observer 替代 Notion source observer；没有另建总验证入口。

正文观察只扫描实际 message content（包含 JSON 编码的 prepare 正文），排除 details、tool schema 和 assistant tool arguments；raw/XML/JSON 的同一物理片段不重复计数。known body 必须来自 owned receipt 和匹配的非空 toolCallId，v2 compiler/hash/span 也要匹配。该统计仍不替代完整功能投递判断。真实 Pi 的 TranscriptContext 可带内部 details，受控捕获的总 JSON 大小不能当模型 HTTP body；serializer/localhost HTTP 的字节和真实模型 HTTP/token 分开报告。

未知值用 null。provider hook JSON、CLI 解码 JSON、压缩后的 HTTP entity、ZIP 文件和 TCP/TLS wire 是不同单位。模型 HTTP observer 只有 identity content-encoding 才将 entity bytes 作为 decoded response bytes；wire bytes 始终不可从这些 hooks 推得。usage 的 input、output、cacheRead、cacheWrite、totalTokens 分开记录，不用字符数估计 token。Notion SDK / CLI 的重试和队列等待沿用公开 request_metrics；模型 SDK 内部等待或其它未观察字段仍为 null。

## Launch 与 Doctor

从 Broker checkout 根运行；沿用保护清单，按明确文件提交。禁止全目标 build 改写 Tern，已有运行环境足够时不重新安装。

```bash
node scripts/skill-consumption-startup.mjs --help
node scripts/skill-consumption-model-baseline.mjs --help
node scripts/skill-consumption-source-baseline.mjs --help
bun run test:verification
```

Doctor 不调用模型或真实 Notion。配置和证据均放在 checkout 外，具体绝对路径必须由本次输出取得。先记录实际运行的 Node、Pi executable、扩展 source tree、embedded CLI 和可选 archive 的各自 hash；文件夹名称、Git HEAD 或 archive hash 均不能替代实际安装文件的 attestation。Pi 的解析结果可能不同于另一个 Node 安装中的 `volta which pi`。

### Source CLI 配置

配置含 `command`（绝对 executable argv）、`database`、`root`（当前未固定的精确主文 ref）、`evidenceRoot`。默认 `pipeline` 为 `prepare-fixed-main`，`samples` 为：

```json
{"cold":5,"warm":20,"expired-unchanged":20,"partial":5}
```

可选 `resourcePath` 增加一次根固定资源读取。独立单资源基线使用 `pipeline: "resource-only"`、非空 `resourcePath`，以及 `{"cold":5,"warm":0,"expired-unchanged":0,"partial":0}`；它每例仅启动一个当前资源 read，之后只读本例本地缓存，无 prepare/files 或主文读取。

```bash
node scripts/skill-consumption-source-baseline.mjs doctor --config /absolute/source-config.json
node scripts/skill-consumption-source-baseline.mjs plan --config /absolute/source-config.json
node scripts/skill-consumption-source-baseline.mjs run --run /absolute/reported-frozen-run
```

Plan 在远程读取前冻结 CLI/hash、方法、样本顺序和初态；执行拒绝被修改的 driver 或 CLI，不重复执行同一个 run。首个实际 cold 样本建立源身份锚，之后的 scope/snapshot/version/hash 漂移必须失败；不由 oracle 预热 consumer。独立 oracle 有自己的状态根与成本账本。

Cold 每例为空的自有状态；warm 使用独立 setup 后的共享自有状态，固定 5m 策略。Expired 使用冻结的 `--max-age 1s` 和实际单调计时至少 1001ms 的等待，验证 freshness 回执；不是 `--refresh` 或 `--max-age 0` 的强制全量行为。Partial 仅把已验证的自有主文对象移入系统 Trash，保存原对象和 manifest，随后走原固定 pin；不得回退 current 或补做成功来替换失败。

### 普通启动配置

先用 `doctor --extension ABSOLUTE_ENTRY` 确认实际宿主，再冻结完整批次：

```bash
node scripts/skill-consumption-startup.mjs run \
  --extension /absolute/installed-or-candidate/src/index.ts \
  --evidence-root /absolute/startup-evidence \
  --list-delay-ms 2000 --cold-samples 5 --failure-samples 5 \
  --warm-samples 20 --timeout-ms 30000
```

有 5 cold-delay、5 cold-failure、1 warm-primer、20 warm，共 31 例。Warm 是 Broker catalog 已暖、Pi 新进程，不能和模型 driver 的 existing-session warm 混为一组。原生 RPC 使用 `waitForState:false`，提交时间在 RPC 写入前取得；不能先等 get_state 或目录再开始计时。首次 provider、任务结束及后台 source 终局分别记录。

任务结束不是后台观察完成。复查整批结束后的原始 source 与 owned-process 账本；迟到的 start、缺 close、观察器未结束、timeout 或 trace 截断都使该样本不完整。不能把收尾前的空 calls 写成零后台成本，也不能依据已有 median 宣称完整改善。保留原 timeout、SIGKILL 和所有慢样本。

### 真实模型配置

共同配置为 `{version:1,extension,database,prompt,expectedAnswers,counts:{cold:5,warm:20},packagePath?,toolProfile?}`，路径均为绝对路径。模型固定为 `magpie/group/flash-free`，不回退；prefetch false。`toolProfile` 缺省或 `standard` 时保持原 read/bash/edit/write/grep/find/ls 七项；显式 `native-skills` 在这七项上增加 notion_list/notion_use，不移除正常工具，也不规定模型调用顺序；notion_ctl 按需发现，不进入默认 schema。显式 `legacy-skills` 才增加 skill_search/skill_prepare/skill_graph，用于旧包对照。拒绝未知或自定义工具组合。已注册工具不代表已经 active，仍须核对实际 provider 声明；不同 profile 的历史样本不能混成同条件比较。observer 不追加任务指令，也不替换返回值。

两种 Source 入口独立冻结，已有 CLI 配置与历史结果继续有效：

| 配置 | 实际入口与方法 |
| --- | --- |
| 省略 `transport`，或 `transport: "cli"`；必须有 `command: [absoluteNode, absoluteCLI]` | 保留既有显式 CLI 账本 wrapper，Broker source.command 指向它；按原方法复现旧 CLI 基线 |
| `transport: "sdk"`；必须完全省略 `command` 属性 | Broker source.command 缺省，走实际包的默认入口：目录 listCatalog 与正文/资源消费都通过进程内 SDK。不能传 `null`、空数组或 wrapper 冒充缺省 |

SDK 模式的 Doctor 记录实际扩展树、`ntn-skills.mjs`、`ntn-skills-sdk.mjs`、`ntn-skills-runtime.json`、Pi executable 和可选 archive 的 hash；执行结束再次读取以检查运行期间是否变化。它不调用 SDK 业务方法，也不探测模型或 Notion 认证。配置文件中的 `extension` 应指向本次冻结包的实际入口；checkout source-tree 结果不表示独立安装包通过。

普通任务和 Skill 任务使用各自冻结的配置与证据目录，按下列真实 driver 命令串行执行。示例的 `sc10-model` 路径替换为本次创建的绝对目录；SDK 配置只增加 `"transport":"sdk"`，删除原 `command`，其余冻结条件保持明确记录。

```bash
node scripts/skill-consumption-model-baseline.mjs doctor \
  --config /absolute/sc10-model/ordinary-config.json
node scripts/skill-consumption-model-baseline.mjs run \
  --config /absolute/sc10-model/ordinary-config.json \
  --evidence-root /absolute/sc10-model/ordinary-evidence

node scripts/skill-consumption-model-baseline.mjs doctor \
  --config /absolute/sc10-model/skill-config.json
node scripts/skill-consumption-model-baseline.mjs run \
  --config /absolute/sc10-model/skill-config.json \
  --evidence-root /absolute/sc10-model/skill-evidence
```

前 5 个 cold 为独立进程和缓存；20 个 warm 是最后一进程内的普通续接，保留历史并计入 payload。答案谓词在 plan 中冻结；正常 stop、非空文本、预期答案子串且非许可提示是机器检查，语义正确性仍需审阅。length、aborted、error、空 final 和许可提示都不能算成功。首次失败后保留其余 planned 样本为 not_run，不换模型、任务、工具、TTL 或样本。

SDK 观测由 driver 为自有 Pi 进程安装 Node preload；父 PID、实际入口和主线程共同限定作用范围，CLI 继承 preload 环境时不会重复安装。它订阅公开的 `context-broker.notion-sdk` 与 Node child_process diagnostics，不替换 spawn/fetch/SDK，不改变 CLI argv。现有 `NTN_SKILLS_REQUEST_TRACE_LIMIT=10000` 已让显式兼容 bundled CLI 在 JSON 结果中附加 request_metrics，无须追加 `--metrics`。stdout 只在已有消费者、已经 flowing 且尚未读过数据时旁听；不调用 read/resume/pipe。最多在内存保留 16 MiB 以解析完整 JSON，写出的只有安全 metrics、字节/hash 和生命周期；未观察、溢出、非 JSON、缺 metrics 或缺 end/close 都保留未知。

成本报告按下列字段分别解释，不能相加成一个“调用次数”：

| 字段 / 层 | 口径 |
| --- | --- |
| `sdkStarts` / `sdkCloses` | SDK 桥公开 start/end 的数量；失败、取消和 pending 也保留。`sdkEntered` 只统计 end 明确回报 `sdk_started:true` 的调用，未结束不能据此推断没有执行 |
| `cliStarts` / `cliSpawnEvents` / `cliCloses` | 分别为观察到的 CLI spawn 调用开始、真实 child spawn 事件和 child close。退出码、signal、stdout 完整性单列；一次子进程可包含零次或多次 HTTP |
| `observedHttpAttempts` / `httpAttempts` | 前者为已记录 attempt 数；后者仅在所有相关 metrics、进程边界和最终复核完整时给出总数，否则为 null。缺 child、零 SDK starts 或空账本都不证明零 HTTP |
| Source bytes / waits | 沿用 request_metrics 的 request bytes、decoded response bytes、metadata/body/retained-body/write/provider 分类及 queue/retry 等待；缺字段不估算。TCP/TLS wire 始终为 null |
| Provider payload / usage / 模型 HTTP | hook 的 JSON bytes/hash、真实发送 entity 和模型报告 tokens 分开；首轮与总任务分别报告，包含后续 tool rounds 和 existing-session 历史 |

真实模型 driver 也在全批结束后重新读 source 与 owned host 账本，另存 reconciliation；没有任何 source 启动证据、EOF 前边界之外的 late start、缺失/重复 close 或缺 metrics 均不能成为完整零成本。sourceComplete 只描述已观察操作至最终复核的闭合；700ms quiet 不证明 metadata producer 已完成，不能用这个字段代替独立后台终态证据。

SDK 模式还要求被动 source observer 的真实 exit 终界、完整 hash 链与一一配对的操作/metrics。`sourceObserverComplete` 只证明这份观察器的生命周期闭合，不单独证明 HTTP trace 完整。无法归属到默认 bundled CLI 的子进程保持 unknown；不为使样本通过而屏蔽正常工具。SIGTERM 等未产生 exit 终界的情况照实记 incomplete，不补造结束事件。CLI 显式 command 与 SDK 默认入口必须在 plan 和比较报告中标明，不能只给旧结果改名便视为 SDK 基线。

未识别 child 的生命周期与其网络覆盖分开：记录稳定 child 身份、参数 hash、真实 spawn/error/exit/close，并验证配对；不记录 argv 明文或借 stdout 推断终局。直接 child 退出不证明后代网络为零，也不能把未知 source 费用改成完整。旧版只有 unmatched start 的 run 保持原 incomplete，不用新版观察逻辑回填。详见 [SC05 切片记录](../../../../packages/context-broker/docs/skill-consumption-guidance.md)。

### SC20 首个共同入口：纯 Pi 本地 read 对 Notion read

在同一 `skill-consumption-model-baseline.mjs` 中给新比较配置增加 `role` 与绝对路径 `comparison`。角色必须来自 `previous-broker`、`notion-candidate`、`pi-native-local`；比较 manifest 同时声明三个角色，但两组对照分别评估，未跑角色保留未跑，不能将旧 Broker 的改善百分比与本地对照相加。

首个共同任务限定为一个普通 Skill 的原生 `read` 检视：读取相同固定主文与预先声明的必需 UTF-8 资源，再回答相同普通任务。两臂不能在 prompt 中提前注入正文、资源答案、私有 oracle，或把 `$` / `/skill:` 展开当作原生 read。Notion 的自动 Requires 闭包、显式 use、Router 路由和原生 `/skill:` 展开分别分组；普通本地 Skill 没有自动 Requires 能力时，不能由脚本补读或隐藏注入来制造能力等价。

纯本地配置只含共同任务字段和比较身份，例如：

```json
{
  "version": 1,
  "role": "pi-native-local",
  "comparison": "/absolute/frozen/inspect-comparison.json",
  "prompt": "本次预先冻结的普通检视任务",
  "expectedAnswers": ["本次冻结的验收子串"],
  "counts": {"cold": 1, "warm": 1}
}
```

该角色拒绝 `extension`、`transport`、`command`、`database`、`packagePath` 和任何产品工具 profile；保留 Pi 的 read/bash/edit/write/grep/find/ls。它不加载 Broker、不创建 Broker source 配置、不调用 CLI 或 SDK。driver 使用 Pi 原生 `--skill` 加载冻结来源目录，并用 `--no-skills` 排除环境里未冻结的额外候选；普通认证继续沿用现有宿主环境，不复制 auth、不改用户全局设置。这里验证隔离名单中的 Pi 原生发现/read，日用全局 autoload 仍由安装规程验收。

Notion candidate 配置保留实际独立安装的 `extension`、archive、`database`、`transport:"sdk"` 与产品默认工具 profile，增加同一 `comparison` 和 `role:"notion-candidate"`。必须省略 `command`。比较使用 manifest 已冻结的真实 Default View；模型仍可按实际工具面决策。额外工具定义、guidance 和错误往返都进入累计成本，不能隐藏它们来降低结果。

既有单候选比较 manifest 版本 1 保持兼容，包含这些字段。所有 SHA 必须由原件计算，不能填写期望结果：

| 字段 | 冻结内容 |
| --- | --- |
| `roles` | 按顺序为 `previous-broker`, `notion-candidate`, `pi-native-local` |
| `intent` / `entry` / `model` | `inspect` / `read` / `magpie/group/flash-free` |
| `promptSha256` / `expectedAnswersSha256` / `counts` | 完整 prompt 的 UTF-8 SHA、`JSON.stringify(expectedAnswers)` 的 SHA、同一预先冻结样本数 |
| `notionSelection` | `{path,sha256}`，既有 graph `selection` 的实际 metadata-only `result.json`；必须 default SDK、ready、host closed、零 body/真实模型请求 |
| `notionProviderPayload` | `{path,sha256}`，上述同一 selection 原件中普通续轮实际收到 ready Default View 的完整 provider JSON；不能用 pending 或 assistant 引用替代 |
| `notionCatalogSource` | `{path,sha256}`，同一 selection 下实际 SDK `list` 原始 source receipt；必须完整授权目录、无 failed sources，与 selected record 一致 |
| `manifest` | `{path,sha256}`，独立保留的完整固定 snapshot manifest，包含 scope、record、snapshot/version、全部文件 SHA/bytes；与上述授权 scope/record 对齐 |
| `directory` | 本地冻结来源目录，仅包含该 manifest 的全部原始文件。导出容器元数据另外保留；不改 frontmatter、相对链接、Members 或正文 |
| `requiredResources` | 本任务必须完整交付的 1～16 个非主文路径；主文自动加入检视断言，资源必须是完整非空 UTF-8 文件 |

复用既有 `notion-skill-graph-model.mjs selection --config ABSOLUTE_CONFIG` 取得 metadata 原件；它使用独立 consumer 根，真实 metadata/setup HTTP 与后续任务分账。Source 固定树也必须来自独立冻结输入，不以准备基线为由预热将要测量的 Notion consumer。Doctor 只读这些已存在原件和本地 Pi loader，不再调用 Notion 或模型。

多候选目录使用同一 baseline driver 的版本 2。保留上表中的任务、模型、计数及资源要求，用以下字段替代单个 `manifest`：

| 字段 | 冻结内容 |
| --- | --- |
| `candidates` | 完整数组，每项为 `{recordId,manifest:{path,sha256},directory}`。每个实际可见候选必须有一份精确 manifest 和完整原始文件树，不接受重复 owner、额外候选或少列候选 |
| `directory` | 原生目录根，各候选目录为互不重叠的直接子目录。根内只允许上述固定文件，不能生成替代 frontmatter 或目录 wrapper |
| `selectedRecordId` | 本任务选择的一个真实可见 owner。`requiredResources` 仅指向该 owner；其它候选的主文和资源不作为任务输入加载 |
| `piVersion` / `viewId` | 本次实际 Pi 版本和既有 View ID。候选目录来自完整 View，不为比较创建或修改生产 View |
| `sourceFreezeSetup` | 可选 `{path,sha256}`，独立来源冻结回执；其 `setupCost` 与 metadata selection、后续任务三份账本分别保留 |

Graph A/B 的 `selection` 仍要求单根目录，不改变它的验收条件。多候选预检在原 baseline driver 内使用独立空状态、实际安装 Pi 和默认 SDK：

```bash
node scripts/skill-consumption-model-baseline.mjs selection \
  --config /absolute/notion-selection-config.json --evidence-root /absolute/catalog-evidence
```

selection 配置使用 `role:"notion-candidate"`、安装包和默认 SDK，`comparison` 先指向包含完整候选树及任务 hash 的版本 2 输入文件。它以受控本地 provider 执行一次 `notion_list`，然后提交普通续轮；两个用户轮次的三个实际 provider payload 均与 HTTP serializer 对齐。首轮真实的 `ntn-skills-discovery status="pending"` 只表示发现尚未完成，不能当成空目录，也不能代替续轮 ready。来源只允许 SDK `list` 和 metadata HTTP；CLI 子进程、正文、远端写入、失败或未闭合操作均不满足预检。

成功输出的 `comparisonArtifacts` 给出 `notionSelection`、`notionProviderPayload`、`notionCatalogSource` 的实际路径和 SHA。将它们加入一份新的冻结 comparison 文件，供两个 arm 共用；保留预检原输入文件及失败回执，不覆盖原件。Doctor 独立核对 ready payload、SDK 完整 owner 集合、每份 source manifest 和原生 loader 的同一集合；只靠 receipt 的 `passed` 字段不能满足这些校验。metadata selection 不调用真实模型、不准备正文，也不建立后续任务 consumer 缓存。其成功只证明这份输入可比较。

Doctor 用实际安装 Pi 的原生 loader 读取未改写的 frontmatter，并与已收到的 Notion provider 目录精确比较名称、描述和候选数量。所有候选都必须原生可见；`disable-model-invocation:true`、名称碰撞、不同描述、不同大小写或替代入口均不能自动归一化。原生与 Notion 的实际目录顺序分别保留，集合比较不改写它们。固定完整源树的 hash 同时约束正文中的 Members；此切片不把其后续路由或 Requires 执行算成双方共有能力。候选扩展/archive、所有 manifest 输入和来源树在执行结束再次核对，变化使该批 incomplete。

当前真实日用默认 View 的 74 项与原生目录尚未证明同条件，其中已观察到 manual-only Skill。现有 3 项 builtin View 是独立窄场景；它的通过不能替代 74 项默认目录比较，也不能通过改源 frontmatter、成员或名单消除差异。

Pi 原生 loader 从实际 executable 所属的 package.json 定位，并核对该包声明的 bin 确实指向实际入口；不能把 `dist/bundle/cli.js` 的父目录误当整个 runtime 根。原生臂冻结完整 `dist`、package.json 与 `dist/core/skills.js`，结束时重新核对；runtime 或比较输入变化均把整批结果判为 incomplete。原 baseline test 中的 public Doctor smoke 使用真实 PATH、实际安装 Pi 和原生 loader，仅 source/selection 输入为受控 fixture，不调用 Notion 或模型，也不替代真实来源预检。

```bash
node scripts/skill-consumption-model-baseline.mjs doctor --config /absolute/native-config.json
node scripts/skill-consumption-model-baseline.mjs run \
  --config /absolute/native-config.json --evidence-root /absolute/native-cost-evidence
node scripts/skill-consumption-model-baseline.mjs doctor --config /absolute/notion-config.json
node scripts/skill-consumption-model-baseline.mjs run \
  --config /absolute/notion-config.json --evidence-root /absolute/notion-cost-evidence
```

inspection observer 的输入只有冻结文件身份与 SHA/bytes，不读正文预置答案。实际 native read 成功返回全部文本后，它才记住该内容，并要求同一 outer toolCallId 的完整 tool output 出现在实际 provider 请求中。details-only、partial、失败 read、另一 owner 的文件路径、换 call ID、assistant 引用或 tool arguments 均不能证明交付。两个路径的正文即使字节相同，也分别核对真实 read 身份，不能用一个文件冒充另一个。

Notion 臂沿实际 read receipt 核对冻结的 scope、owner、snapshot/version、路径与 File ID，并复用候选安装包的 resource projection validator 验证 `read.paths`；批量文件分别记录原外层 call 的完整 provider span，保持一次外层调用计数。原 scalar 和 batch 入口都保留，不能为了对照隐藏合法 schema。每个任务仍要通过冻结答案谓词并把主文和全部必需资源送达 provider，不接受 use/prepare 来冒充本项 inspect。答案谓词不代替独立语义审阅或已有 graph 权限/版本 oracle。

多候选检视只允许选择的 owner 贡献正文。原生 observer 识别未选候选的实际文件路径；Notion observer 同时保留已出现短引用、canonical owner 和实际 read receipt 的归属。成功读取未选正文使该次检视失败，即使所选主文和资源已经完整送达，或两个 owner 的正文恰好字节相同。失败 read 不冒充成功正文读取。每个实际 ready provider 目录仍核对冻结候选集合；初始 pending 可保留，额外候选、缺项和替换描述不能默默通过。

native 的零 CLI/SDK/来源 HTTP 只有在真实 observer 终界、host close、无产品调用、无 child starts、无 non-model Undici attempt、实际目录/schema 不含 Broker 的条件下成立。缺观察或未知 child 保持 null。`nativeFileReadResults` 和 `nativeFileReadBytes` 是实际完整 read 输出，filesystem syscall 数保持 null；文件本已存在、fingerprint/setup 可以暖 OS page cache，因此本地 cold 仅指新进程/新 provider 会话，不能宣称冷磁盘。

所有 provider 请求均计入 payload、tool schema、guidance/目录诊断 span、历史、工具轮次和 reported usage；诊断 span 会重叠，不相加成独立 token 分类。模型 HTTP attempts/发送 body hash 与 hooks 单独对齐。当前原 driver 仍仅驱动 cold/new 和 warm/existing 两种真实模型初态；expired、partial、fork/rewind/compaction 等完整 SC20 组合继续复用既有受控 driver 与各自真实门禁，不能把本切片标成完整矩阵通过。

本次定向验证保留了旧 driver 拒绝纯本地配置的 fail-before，随后覆盖完整投递、错误路径/partial/details/错误 call、缺失/篡改观察、未知 child、SDK/HTTP 和额外 Broker schema 等反例。实际安装 Pi 的受控 HTTP provider 检查走了两次 native read、三个 provider 请求，未加载 Broker，完整主文和资源到达实际 serializer。该受控结果证明驱动接线，真实 Notion、真实模型成本对照和完整 SC20 矩阵尚未由此成立。

该读取探针没有执行完整 comparison Doctor。安装入口审查随后发现错误的 `dist/bundle/core/skills.js` 路径，新增 public Doctor smoke 先复现失败，再按上述包归属定位修复通过。两份证据分别保留，不把早先的读取探针称为 Doctor 已通过。

## Evidence 与比较

先读 plan，再读每例原件和 report。至少核对：

1. 实际 provider payload 与发送 body hash、所有模型 attempts 与每轮 reported usage。
2. 原生提交→首次 provider→有效文本→任务结束的单调时间；source 工作可延续至模型结束之后。
3. source 的独立操作清单、原始 request_metrics 和最终进程 spawn/close；不能以一份截断 trace 断言没有额外请求。
4. 附件 provider 下载与 retained Records ZIP 分开；provider=0 不等于没有 ZIP。单资源放大需精确 bundle/chunk、N/k、请求输出和本地物化 hash 证明。
5. 所有 passed、failed、blocked、not_run 与各自原因。n、observed、unknown、原值、median 都保留，少于 20 个可观察值不报告 p95。

`compareConsumptionRuns` 拒绝缺观察、换模型/任务/源版本/TTL/方法、遗漏 attempt、成功任务退化及候选未完成的结果。原始统计包含失败；comparable 仅表示证据和条件可比，不代表每例任务通过或成本改善。减少首轮文本但增加工具轮次必须单列，不能据首轮变小宣布总成本下降。旧 Gate B 只能作有 hash 的历史解释。

## Cleanup

Source 与真实模型 driver 有归属检查的可逆 cleanup：

```bash
node scripts/skill-consumption-source-baseline.mjs evidence --run /absolute/frozen-run
node scripts/skill-consumption-source-baseline.mjs cleanup --run /absolute/frozen-run
node scripts/skill-consumption-source-baseline.mjs evidence --run /absolute/frozen-run

node scripts/skill-consumption-model-baseline.mjs evidence --evidence /absolute/model-run
node scripts/skill-consumption-model-baseline.mjs cleanup --evidence /absolute/model-run
node scripts/skill-consumption-model-baseline.mjs evidence --evidence /absolute/model-run
```

在 cleanup 前保存全部既有证据 hash，之后逐份核对。原件、plan、失败 stdout、固定 snapshot 副本和 partial 原对象备份均保留。cleanup 成功不改变 functional status。

Startup driver 的每个 case 混合运行文件和证据，没有整目录 cleanup 命令。只将 plan/原件明确证明属于该 run 的外部 probe、alias 根列入清单，检查真实路径、进程状态后用 `/usr/bin/trash ABSOLUTE_PATH` 回收；不得按目录前缀、mtime 或进程名猜测归属。缺终局必须注明，不补造 exit code，无法证明安全的路径保留。

