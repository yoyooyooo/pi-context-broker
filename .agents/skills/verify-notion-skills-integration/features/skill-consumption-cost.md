# Skill 消费成本：只读观察与冻结基线

归属 [SC02 / AH-619](https://linear.app/yoyooyooo/issue/AH-619)，完整入口地图见 [Skill 消费链](skill-consumption.md)。本规程交付测量与基线，不代表后续性能预算、SDK、压缩恢复或日用安装已经通过。已执行的样本、失败和方法边界见 [2026-11-04 基线报告](../../../../packages/context-broker/docs/skill-consumption-baseline-2026-11-04.md)。

## 观察边界

| 层 | 驱动 / 原件 | 计量含义 |
| --- | --- | --- |
| Pi 用户提交与 provider | `skill-consumption-cost.mjs` / observer JSONL | 同机单调时间、实际 provider hook 的 JSON bytes/hash、tool schema/目录/正文/资源/历史的分项字节与模型报告 usage |
| 模型 HTTP | `skill-consumption-provider.mjs` / transport JSONL | Node Undici diagnostics 的实际 request body hash/bytes、response entity chunks、真实尝试；不替换 fetch、不消费响应、不注入工具参数 |
| Source CLI | `skill-consumption-source-baseline.mjs` / 每个 child 的 receipt、stdout、lifecycle | prepare 后逐节点固定 read，或独立单资源 read；request_metrics 中的 metadata/body/retained-body/write/provider、retry、queue 与响应解码字节 |
| Pi 默认 Source SDK / bundled CLI | `skill-consumption-source-observer.mjs` / safe-source-requests JSONL | 进程内 SDK 的公开 start/end 与安全 request_metrics；默认 bundled CLI 的真实 spawn/close 和完整 stdout 中的 request_metrics。SDK 操作、CLI 子进程与 HTTP attempt 分别计数 |
| 普通启动顺序 | `skill-consumption-startup.mjs` | 实际 Pi，受控 source/provider；原生 RPC 提交先于目录完成。受控 stream 不等于真实模型 HTTP 或 token |
| 真实模型成本任务 | `skill-consumption-model-baseline.mjs` | 固定 magpie/group/flash-free；正常工具、冻结的普通或 Skill 任务；独立 cold 进程和最后一个进程中的 existing-session warm 续接。任务类型分组记录，成本 driver 不替代 Skill 完整消费断言 |

三个被动 observer 的 JSONL 使用 0600 权限、逐事件 hash 链和同机 monotonic clock。日志不保存认证头、token、签名 URL、原始 CLI stdout 或完整 provider 正文；独立 Source CLI driver 的原件保留规则另按该 driver 执行。实际 payload 的 hash 必须与 transport 发送 body 对齐；hash/摘要本身不证明 Skill 正文投递，后者仍由消费链的完整 span 断言负责。

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

共同配置为 `{version:1,extension,database,prompt,expectedAnswers,counts:{cold:5,warm:20},packagePath?}`，路径均为绝对路径。模型固定为 `magpie/group/flash-free`，不回退；prefetch false，driver 的 `--tools` 固定为 read/bash/edit/write/grep/find/ls 七项。Broker 扩展照常加载，但已注册工具不代表已经 active；以实际 provider 工具声明核对能力，不能把此路线称为原生 Broker 工具全部启用。observer 不规定模型工具选择，不追加任务指令，也不替换返回值。

两种 Source 入口独立冻结，已有 CLI 配置与历史结果继续有效：

| 配置 | 实际入口与方法 |
| --- | --- |
| 省略 `transport`，或 `transport: "cli"`；必须有 `command: [absoluteNode, absoluteCLI]` | 保留既有显式 CLI 账本 wrapper，Broker source.command 指向它；按原方法复现旧 CLI 基线 |
| `transport: "sdk"`；必须完全省略 `command` 属性 | Broker source.command 缺省，走实际包的默认入口：目录通过 bundled CLI，支持的正文/资源消费通过进程内 SDK。不能传 `null`、空数组或 wrapper 冒充缺省 |

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

SDK 观测由 driver 为自有 Pi 进程安装 Node preload；父 PID、实际入口和主线程共同限定作用范围，CLI 继承 preload 环境时不会重复安装。它订阅公开的 `context-broker.notion-sdk` 与 Node child_process diagnostics，不替换 spawn/fetch/SDK，不改变 CLI argv。现有 `NTN_SKILLS_REQUEST_TRACE_LIMIT=10000` 已让默认 bundled CLI 在 JSON 结果中附加 request_metrics，无须追加 `--metrics`。stdout 只在已有消费者、已经 flowing 且尚未读过数据时旁听；不调用 read/resume/pipe。最多在内存保留 16 MiB 以解析完整 JSON，写出的只有安全 metrics、字节/hash 和生命周期；未观察、溢出、非 JSON、缺 metrics 或缺 end/close 都保留未知。

成本报告按下列字段分别解释，不能相加成一个“调用次数”：

| 字段 / 层 | 口径 |
| --- | --- |
| `sdkStarts` / `sdkCloses` | SDK 桥公开 start/end 的数量；失败、取消和 pending 也保留。`sdkEntered` 只统计 end 明确回报 `sdk_started:true` 的调用，未结束不能据此推断没有执行 |
| `cliStarts` / `cliSpawnEvents` / `cliCloses` | 分别为默认 CLI spawn 调用开始、真实 child spawn 事件和 child close。退出码、signal、stdout 完整性单列；一次子进程可包含零次或多次 HTTP |
| `observedHttpAttempts` / `httpAttempts` | 前者为已记录 attempt 数；后者仅在所有相关 metrics、进程边界和最终复核完整时给出总数，否则为 null。缺 child、零 SDK starts 或空账本都不证明零 HTTP |
| Source bytes / waits | 沿用 request_metrics 的 request bytes、decoded response bytes、metadata/body/retained-body/write/provider 分类及 queue/retry 等待；缺字段不估算。TCP/TLS wire 始终为 null |
| Provider payload / usage / 模型 HTTP | hook 的 JSON bytes/hash、真实发送 entity 和模型报告 tokens 分开；首轮与总任务分别报告，包含后续 tool rounds 和 existing-session 历史 |

真实模型 driver 也在全批结束后重新读 source 与 owned host 账本，另存 reconciliation；没有任何 source 启动证据、EOF 前边界之外的 late start、缺失/重复 close 或缺 metrics 均不能成为完整零成本。sourceComplete 只描述已观察操作至最终复核的闭合；700ms quiet 不证明 metadata producer 已完成，不能用这个字段代替独立后台终态证据。

SDK 模式还要求被动 source observer 的真实 exit 终界、完整 hash 链与一一配对的操作/metrics。`sourceObserverComplete` 只证明这份观察器的生命周期闭合，不单独证明 HTTP trace 完整。无法归属到默认 bundled CLI 的子进程保持 unknown；不为使样本通过而屏蔽正常工具。SIGTERM 等未产生 exit 终界的情况照实记 incomplete，不补造结束事件。CLI 显式 command 与 SDK 默认入口必须在 plan 和比较报告中标明，不能只给旧结果改名便视为 SDK 基线。

未识别 child 的生命周期与其网络覆盖分开：记录稳定 child 身份、参数 hash、真实 spawn/error/exit/close，并验证配对；不记录 argv 明文或借 stdout 推断终局。直接 child 退出不证明后代网络为零，也不能把未知 source 费用改成完整。旧版只有 unmatched start 的 run 保持原 incomplete，不用新版观察逻辑回填。详见 [SC05 切片记录](../../../../packages/context-broker/docs/skill-consumption-guidance.md)。

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

