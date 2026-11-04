# Pi Skill 消费运行时：SDK、短引用与有效指令

本记录承接 [AH-617](https://linear.app/yoyooyooo/issue/AH-617)，覆盖 SC04 / AH-621、SC08 / AH-627、SC09 / AH-624、SC10 / AH-625 的本轮实现与证据。历史 [启动检查点](skill-consumption-startup-checkpoint.md) 和 [成本基线](skill-consumption-baseline-2026-11-04.md) 的失败原件保留；本页不把受控 provider、状态层或单元测试升级为真实模型验收。

## 已接通的产品路径

Pi 的默认 Notion Skill / Router 准备通过随 Broker 包交付的 `ntn-skills/sdk` 执行一次 `consume`。返回的完整 manifest、主文范围、scope、物理 owner、snapshot、版本、File 绑定和 hash 通过同一个公开消费内核验证，Broker 再核对宿主选中身份并直接物化主文。它不再为每个准备节点启动一次固定 CLI read。固定资源使用同包 SDK `readSkill`，仍核对完整公开回执与实际文件 bytes / SHA。

SDK 与公开 CLI 共用 Effect 的 Notion / Store / Credential / Clock / 调度服务；每次调用有独立 scope、捕获的 env / cwd 和 AbortSignal，不修改 `process.env` 或 `process.cwd()`，也没有新增 daemon 或缓存权威。共享解析器处理 duration；消费内核只执行一次完整结果解码。SDK 不可用、协议或包版本不兼容时明确失败，不暗中换旧 CLI。

发现目录仍使用公开 CLI，因此“准备零子进程”不能写成“整个 Pi 会话零子进程”。显式 `source.command` 保留 prepare + fixed read 的兼容路径；OMP、Prompt 与预算 prefetch 未在本轮迁为 SDK。SDK 的非空批量 `requestedFiles` 仍属于 SC07，不能从资源单读成功推断已经实现。

## 会话分支短引用

| 类型 | 公开形态 | 内部绑定与使用 |
| --- | --- | --- |
| 候选 | `sr:C` 加 22 个随机字符 | canonical 身份、scope、来源与物理 owner；不代表已选版本或已激活 |
| 固定主文 | `sr:S` 加 22 个随机字符 | 完整身份、snapshot、版本、主 File、入口路径和正文 hash |
| 固定资源 | `sr:R` 加 22 个随机字符 | 固定 owner、精确 File / path、bytes / hash；不替代主文 loaded 回执 |

每个短引用为 26 UTF-8 字节。相同兼容绑定复用已有句柄；刷新生成可区分的新 S / R，旧句柄不漂移。目录与 search 发布 C，prepare 与完整原生主文读取发布 S / R。句柄在当前真实 SessionManager 分支追加并读回后才对外可见；resume / fork / rewind / compaction 按祖先历史恢复，兄弟分支的私有句柄不可用。

短引用不是授权。每次消费继续经过当前来源授权、完整 scope 与物理身份检查；未知或伪造 `sr:` 明确失败，不猜名字或把它当本地路径。固定旧 pin 的关系不能因 canonical ID 相同而改写为当前 S；未固定的非主文关系也不猜测为候选。作者正文、原始 graph lock 和 source directory 保持不变。

`skill_graph({refs:[...]})` 可导出 S / R 的 canonical 精确证明；跨进程或机器的独立消费者仍需自己的认证与验证。C 不能导出成伪造的固定版本。资源读取成功只表示其准确字节已物化；二进制回执可以正确地为 `delivered_complete_text:false`。

## 输入、取消、active 与 visible

Pi input 阶段同步冻结用户已接受的身份、文本、参数和图片，不在尚无运行信号的阶段等待远端准备。实际准备移至建立 agent signal 后的 context 阶段；失败显式 abort 本轮，避免宿主忽略扩展异常后带 partial 指令请求 provider。原生 `/skill:` 的提前展开只由当前 invocation 的受控回执处理，历史标签或用户伪标签不能取得激活权。

以下状态分别保存、分别验证：

- selected：该分支选中的版本与 Required 图。
- ready / cached / materialized：已验证内容或文件，不等于已经送入 provider。
- visible：本次实际 provider 输入中存在完整且精确匹配的正文跨度。
- active：当前会话启用的 Skill / Router 规则；inspect 不产生 active。

`before_provider_request` 只记录 pending。`after_provider_response` 在同一 invocation / session / generation、信号未取消且实际 2xx 时，确认已准备并完整投递的 active 集。这个事件表示响应 headers 已到达，**不代表响应流完成或模型任务成功**。迟到 headers 不能复活被取消的会话。完整正文通过公开 `sendMessage(triggerTurn:false)` 持久化，不引入下一轮 steering。

普通后续消息保留 active。压缩移除必要正文时，从精确已选版本恢复；同一来源的固定 roots 合为一次 SDK inspect，既不改绑 current，也不重新计算 use 图。恢复成功后的下一条普通消息不重复准备。去重依据 scope、身份、snapshot、hash、编译器和实际完整消息跨度；Prompt 继续按每次显式任务处理。

完整原生主文读取保留源文本作为精确前缀，随后可附 body-free 短引用目录。v3 receipt 明确证明 start=0 的完整正文范围；部分 read、摘要和仅有 hash 都不能充当全文。上下文投影只替换已验证的正文跨度，保留资源目录和原始 toolCallId；历史 JSONL / tool result 不重写。

## 可复跑入口

在 Broker checkout 根运行，先读取各入口 help 和本次 Doctor。证据使用新的绝对目录；不重用失败 run，不将路径例子当作实际文件。

```bash
bun run --cwd packages/context-broker test:consumption
bun run test:verification
node scripts/notion-startup-flow.mjs --help
node scripts/notion-sdk-pi.mjs --help
node packages/context-broker/scripts/session-short-ref-session.mjs --help
```

独立构建使用已冻结、具备 `./sdk` 导出的 ntn-skills npm/tar 包，`NTN_SKILLS_BUILD_ENTRY` 指向该包的 CLI。执行 `bun scripts/build-tern.mjs --target broker --package-out /absolute/new-package`，只构建 Pi 包。构建器校验 CLI / SDK 同一个真实 package root，生成 `ntn-skills-runtime.json`。当前注册表旧包不具备新 SDK；本轮没有发布 npm 新版，也没有替换日用安装。

实际 Node 等价入口：

```bash
node scripts/verify-notion-sdk-installed.mjs \
  --package /absolute/independent/node_modules/pi-context-broker \
  --fixture /absolute/frozen/fixture.json \
  --pi-package /absolute/installed/pi/package.json \
  --out /absolute/new-evidence
```

RPC / PTY 生命周期入口为 `node scripts/notion-startup-flow.mjs run --extension /absolute/candidate/src/index.ts --evidence-root /absolute/new-parent`。实际 SessionManager 的 active 与 short-ref drivers 分别位于 `packages/context-broker/scripts/session-active-session.mjs`、`session-short-ref-session.mjs`；其输入与输出以脚本公开参数为准。状态层成功不能替代 provider 正文证明。

## 本轮冻结产物

| 项目 | 身份 |
| --- | --- |
| CLI SDK 提交 | `6e8031b`，`feat(sdk): share scoped Node consumer runtime with CLI` |
| ntn-skills tar | `ntn-skills-0.1.0.tgz`，SHA256 `38a8a58134b3ecfe3c96e1a17a991a2953652b878b8a8c9674a4b4c8dd74af9d` |
| Broker 当前候选 tar | package-03 `pi-context-broker-0.0.2.tgz`，SHA256 `3b4056a55bcee73a53c7da473fac5f09e708e9839c2bdda5b57c7a5ac656410a` |
| 原启动对照 / Node 适配 tar | package-02，SHA256 `f0ce9580b3534b15e0ee13069925bd0b92666cc5b1af09731bf22a99a0844698` |
| 执行环境 | Node 24.20.0、Pi 1.4.0；Bun 仅作构建和单元验证 |

本轮私有证据根为 `/Users/yoyo/Library/Logs/ntn-skills/AH-617-20261104/throughput-zqzp5es9`。凭据、完整 provider 内容与私有源数据不提交仓库。

## 已完成的分层证据

| 证据 | 结果 | 实际证明范围 |
| --- | --- | --- |
| `sc10-cli/consumer-06` | 独立 Node / npm 11/11；严格声明检查通过 | SDK 包闭合、CLI 等价、隔离 env / cwd、取消、类型；不依赖另一 checkout |
| `sc10-broker/verify-02` | 9/9 | 一、二、三根共享 Requires 分别只调用一次 SDK；默认准备 CLI 为 0，公开 CLI 对照分别为 3/4/5；正文、版本、文件和 graph lock 全等 |
| `sc10-pi/run-03` | package-03 真实安装 Pi 3/3 | `$`、原生主文/资源、search→C→三根 prepare；共 3 consume + 1 read、6 个目录 CLI、prepare/read/export CLI 为 0、10 次受控 provider 请求 |
| `sc04/session-short-ref-gsOpGg` | 13 项状态检查 + 5 个独立 Node resume 通过 | 实际 SessionManager 的分支映射、旧 pin、刷新、导出、压缩与续接；不是模型验收 |
| `sc08-sc09/session-active-session-M3D6Um` | 14/14 | 实际分支 active、固定 A/B、失败刷新、fork / rewind / compaction 和独立进程恢复 |
| `sc08-sc09/broker-notion-startup-evidence-bvNX4Q` | package-03 真实 Pi RPC / PTY 10/10 | 延迟目录、精确失败阻断、RPC abort、Stop、new session、EOF、压缩后固定恢复与迟到 2xx；此前 p6rqyI 原件保留 |

实际 SDK-Pi 三场景使用受控离线 snapshots / catalog 和受控 provider；SDK / CLI HTTP 均为 0，不能推广为真实冷网络零请求。默认 View 没有 seed，每场景的默认 View 请求明确保留 `CACHE_MISSING`，因此该 run 不证明 native menu/default View。7 字节二进制资源的真实文件 SHA 与公开 owner / File / snapshot 回执一致，未声称完整文本投递。

正式生命周期 run 中，11 份含 Skill 的 provider 输入各有完整 204 字节正文一次，21 份 system context 均无该正文。实际 RPC abort 的 provider 数已从历史失败的 1 修复为 0；新会话与迟到 response 没有发布旧 active。控制源和控制 provider 的标签始终保留。

首次 SDK-Pi run 的 native 断言曾错误要求 RPC 参数暴露缓存绝对路径；修正验证器，确认真实 `sr:R` 与实际文件后新 run 通过。原失败报告未改判。所有 owned scratch 清理使用系统 Trash，保留原始 JSONL、输出和 hash；既有不相关暂存内容保持原样。

最终组合验证还发现 macOS `/tmp` / `/private/tmp` 的同文件别名问题：旧 hook 用路径字符串寻找 pending main receipt，可能漏记已完整读取的正文。现改为在授权、路径和 signal 检查完成后直接绑定本次主文 snapshot；资源分支不取得主文回执，result 仍验证完整 source bytes。显式目录 symlink 反例和专项 73/73、513 个断言通过。package-03 相比 package-02 的 53 个 src/dist 文件只有 `host-skills.ts` 这一处运行时代码不同，另有文档变动；默认 SDK-Pi 和生命周期均在 package-03 重新执行。startup-Zqt3Gf 的数字仍严格归属 package-02。

## 非阻塞启动的完整对照

新 run `sc09-startup/skill-startup-Zqt3Gf` 与旧完整基线 `startup-baseline/skill-startup-N6Riym` 均为 31 个完整实际 Pi 样本，受控目录每次延迟 2,000ms。warm 是 Broker catalog 已暖但 Pi 新进程，不是同进程暖启动。

| 组 | 样本数 | 旧首请求中位数 ms | 新首请求中位数 ms | 新 p95 ms |
| --- | ---: | ---: | ---: | ---: |
| cold-delay | 5 | 6,948.523 | 359.113 | 不报告，n < 20 |
| cold-failure | 5 | 6,801.322 | 376.728 | 不报告，n < 20 |
| warm-primer | 1 | 单列，不参与 warm 统计 | 371.053 | 不报告 |
| warm-catalog-new-process | 20 | 4,664.270 | 367.338 | 386.147 |

31/31 均在目录完成前进入 provider，正文请求为 0。后台目录工作仍执行并单独计量；新的冷组最后目录完成中位数约 4.71s，暖组约 2.52s。首请求改善不等于目录网络成本归零。p95 使用 nearest-rank；首有效文本取真实 `message_update/text_delta`，不以 `message_end` 代替。

旧基线 120 个 source child 为 78 次 list 加 42 次 `ctl cache identity`，新 run 的 89 个为 47 次 list 加同样 42 次 identity；全部逐 ID/PID 核对 close。新 88/89 次调用在任务结束后才开始，89 次都在 provider 之后才结束。宿主关闭中位数仍为 cold 5.02s、failure 5.01s、warm 2.81s，后台成本没有藏入“零等待”。

新旧 raw 时间和全部 owned host / source-child 终局经过独立核对；代理 wrapper 自身的 exit 没有独立回执，PID 已消失不能补造该回执。新报告中“受控 provider 不调用 onPayload”的旧描述不准确：原始证据存在实际 provider request / response hooks；独立复核给出更正，原文件不覆写。较早不完整候选 `skill-startup-eSQbSH` 的 timeout 和缺失 close 继续保留，未混入本轮完整样本。

## 后续边界

SC05 的模型投影与机器证明分离、SC06 两种目录的真实自主选路比较、SC07 批量资源消费，以及字段 / 缓存 / Records / 附件 / 文件级迁移仍按各自子票验收。26 字节短引用只证明 locator 缩短，不能单独声称整轮 token 或任务总成本下降。完整 canonical graph lock 目前仍在 prepare 输出中。

本轮独立安装与受控证据不替代 pro / mini 跨机历史恢复、四条正式真实 Agent Gate、默认模型摘要、日用新会话和回滚验收。父票及这些未完成范围继续开放。
