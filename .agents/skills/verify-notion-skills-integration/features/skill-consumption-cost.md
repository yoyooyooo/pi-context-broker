# Skill 消费成本：只读观察与冻结基线

归属 [SC02 / AH-619](https://linear.app/yoyooyooo/issue/AH-619)，完整入口地图见 [Skill 消费链](skill-consumption.md)。本规程交付测量与基线，不代表后续性能预算、SDK、压缩恢复或日用安装已经通过。已执行的样本、失败和方法边界见 [2026-11-04 基线报告](../../../../packages/context-broker/docs/skill-consumption-baseline-2026-11-04.md)。

## 观察边界

| 层 | 驱动 / 原件 | 计量含义 |
| --- | --- | --- |
| Pi 用户提交与 provider | `skill-consumption-cost.mjs` / observer JSONL | 同机单调时间、实际 provider hook 的 JSON bytes/hash、tool schema/目录/正文/资源/历史的分项字节与模型报告 usage |
| 模型 HTTP | `skill-consumption-provider.mjs` / transport JSONL | Node Undici diagnostics 的实际 request body hash/bytes、response entity chunks、真实尝试；不替换 fetch、不消费响应、不注入工具参数 |
| Source CLI | `skill-consumption-source-baseline.mjs` / 每个 child 的 receipt、stdout、lifecycle | prepare 后逐节点固定 read，或独立单资源 read；request_metrics 中的 metadata/body/retained-body/write/provider、retry、queue 与响应解码字节 |
| 普通启动顺序 | `skill-consumption-startup.mjs` | 实际 Pi，受控 source/provider；原生 RPC 提交先于目录完成。受控 stream 不等于真实模型 HTTP 或 token |
| 真实普通模型任务 | `skill-consumption-model-baseline.mjs` | 固定 magpie/group/flash-free；正常工具、同一任务；独立 cold 进程和最后一个进程中的 existing-session warm 续接 |

两个被动 observer 的 JSONL 使用私有权限、逐事件 hash 链和同机 monotonic clock。日志不保存认证头、token、签名 URL 或完整 provider 正文。实际 payload 的 hash 必须与 transport 发送 body 对齐；hash/摘要本身不证明 Skill 正文投递，后者仍由消费链的完整 span 断言负责。

未知值用 null。provider hook JSON、CLI 解码 JSON、压缩后的 HTTP entity、ZIP 文件和 TCP/TLS wire 是不同单位。只有 identity content-encoding 才将 entity bytes 作为 decoded response bytes；wire bytes 始终不可从这些 hooks 推得。usage 的 input、output、cacheRead、cacheWrite、totalTokens 分开记录，不用字符数估计 token。SDK 内部重试/队列等待不可见时也为 null。

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

配置为 `{version:1,extension,command:[absoluteNode,absoluteCLI],database,prompt,expectedAnswers,counts:{cold:5,warm:20},packagePath?}`。模型固定为 `magpie/group/flash-free`，不回退；prefetch false，保持正常 read/bash/edit/write/grep/find/ls 和 Broker 工具。observer 不规定模型工具选择。

```bash
node scripts/skill-consumption-model-baseline.mjs doctor --config /absolute/model-config.json
node scripts/skill-consumption-model-baseline.mjs run \
  --config /absolute/model-config.json --evidence-root /absolute/model-evidence
```

前 5 个 cold 为独立进程和缓存；20 个 warm 是最后一进程内的普通续接，保留历史并计入 payload。答案谓词在 plan 中冻结；正常 stop、非空文本、预期答案子串且非许可提示是机器检查，语义正确性仍需审阅。length、aborted、error、空 final 和许可提示都不能算成功。首次失败后保留其余 planned 样本为 not_run，不换模型、任务、工具、TTL 或样本。

真实模型 driver 也在全批结束后重新读 source 与 owned host 账本，另存 reconciliation；没有任何 source 启动证据、EOF 前边界之外的 late start、缺失/重复 close 或缺 metrics 均不能成为完整零成本。sourceComplete 只描述已观察操作至最终复核的闭合；700ms quiet 不证明 metadata producer 已完成，不能用这个字段代替独立后台终态证据。

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

