# SC09 / AH-624：普通 Pi 非阻塞检查点

> 历史检查点：下文保留当时的 input-preflight RPC abort 失败和不完整候选，原证据未改判。后续 context 准备/运行信号修复、真实 RPC/PTY 10/10 与完整 31 样本启动对照见 [Pi 消费运行时记录](skill-consumption-runtime.md)。本页中的“当前”指该历史检查点。

[AH-624](https://linear.app/yoyooyooo/issue/AH-624) 保持 **In Progress**。当前源码已验证普通输入可先于 metadata discovery 进入 provider；精确选择仍保持固定身份与完整正文门控。实际 Pi RPC 的输入预检取消仍失败，本检查点不关闭该验收项，也没有切换日用安装。

## 实现与功能证据

Pi adapter 声明 deferred metadata discovery。普通 input、before_agent_start 和无关 native file read 不等待目录；pending/unavailable 状态保留准确提示及 skill_search 入口。显式美元、精确 native、search/prepare/read 继续检查目录、权限、固定 snapshot 和选择身份。接受的 native identity 在首个 await 前冻结；代际检查阻止旧会话发布晚到结果。原生模型 read 合并实际 agent signal 与 Broker 生命周期信号。OMP 路径保持原 ready 行为。

实际 Pi 1.4.0，source/provider 为受控 fixture。证据根：

```text
/private/tmp/broker-sc09-source-qm63jm59
```

| 原件目录 | 结论 |
| --- | --- |
| broker-notion-startup-evidence-DCHlnb | RPC 普通输入先于 held list 完成进入 provider，正文读取 0；同会话晚到 native/$ 完整消费 |
| broker-notion-startup-evidence-27xV7X | 真实 PTY 普通 Enter、精确 native、$ Tab/Enter、双 Enter、Escape 取消正文准备及重试、EOF 通过 |
| broker-notion-startup-evidence-7ar6uk | metadata 429/offline/permission 不阻断普通消息、准备权限失败阻断、新会话、EOF 通过；RPC input-abort 真失败；另保留最初 native-read Stop fixture 未触发的超时 |
| broker-notion-startup-evidence-fyKsY9 | 仅修正 provider 触发规则后，实际模型 native-read 等待 metadata 的 RPC Stop 通过 |

唯一场景为 10 passed / 1 failed。失败组仍为 failed。22 份实际 provider context 经逐项复核：凡出现 fixture 正文，都包含唯一完整的 204 B 原文，hash `8228b4e0ea4464a6d6694cf12dee13711a51e2296ae2be01f42a6c6b5299923b`；system-role 与 legacy systemPrompt 均无该正文。此核对包括不应该发生的 abort 后请求，正文完整不能抵消取消失败。

4 个 run 经 evidence→hash→cleanup→hash→evidence，244 个既有文件原字节保留，隔离 scratch 已回收。input-guard、accepted-selections、native-read-session、host-prepare 和 typecheck 已通过。完整目录/消费回归另见下节。

## 未通过：RPC input-preflight abort

复现顺序：hold metadata → 提交精确 `/skill:notion-ui-alpha SC09_CANCELLED_INPUT` → 观察实际 input → RPC abort 返回 success → 放行 metadata。实际继续 prepare/read 并请求 provider 1 次，要求为 0。

实际 Pi 安装根为 `/Users/yoyo/.local/lib/node_modules/@earendil-works/pi-coding-agent`，不是 Volta 下另一份 1.1.0。公开调用顺序是：

1. AgentSession.prompt 先 await input handlers，再调用 _startRun。
2. input 阶段尚无 activeRun，ctx.signal 因而不可用。
3. abort 只在 active run 存在时留下取消标记；本次等待期间返回 success 后，后续 _startRun 仍可启动。
4. before_agent_start 也早于 agent-core 建立 activeRun，单独移动等待不能保证立即终止 acquisition。
5. agent_start/context 阶段有 signal，但移动正文注入点会影响首轮、持久化与恢复合同。

仅在 agent_start 中发送一条 steer 消息不能保证首轮正文：默认 one-at-a-time 队列可能已有其他扩展的 custom message，公开 hasPendingMessages 不覆盖该完整队列。运行中 triggerTurn:false 会把 custom message 延迟至轮次边界。临时 context 投影也不等于持久正文；appendEntry 保存状态而不直接进入模型 context。

因此后续实现需与 [SC08 / AH-627](https://linear.app/yoyooyooo/issue/AH-627) 的固定版本恢复、native receipt 配对、去重和 active/visible 状态一起明确，不能用排队消息、旧 receipt 或摘要掩盖。尚未实施新的持久化路径，没有修改 Pi 私有接口或全局 steering 行为。

完整审阅保存在证据根的 `rpc-input-abort-review.md` 与 `rpc-input-abort-review.json`；MD SHA-256 为 `3a324dcfabfa1b196043e1ca505a271b672135f555f9dffde4c4187c3cc3af16`。JSON 包含实际 Pi 7 份源码的完整 hash、精确摘录和实际 abort 成功帧。**旧安装包未跑此反例；是否既有问题仍为 unknown/not_compared。**

## 保持旧目录回归的断言

旧 integration 的两个场景要求目录已经完成，却直接用首次普通输入断言完整 alias。现在这两个 Pi 场景先调用公开 `/context-broker refresh`，要求 metadata refreshed 成功通知及 provider 增量 0；随后原目录、路径、重名、正文 0、失败阻断与 prepare/fixed-read 断言全部保留。这是显式 metadata refresh，单独计量，不伪称无额外调用的被动等待。Cold native/$/print/continue 没有增加这一步。

完整实驱：

```text
/private/tmp/broker-sc09-integration-catalog-2fms_2yw/broker-notion-evidence-t7qnkJ
```

Pi Notion + filesystem 均 passed：denied/malformed/timeout 的 provider 均为 0，cold native、参数、重复/双向去重、当前进程资源位置、persisted continue 和两页同名身份通过。Notion 实际 prepare 15、固定主文 read 11、export 0。17 个既有证据文件 cleanup 前后不变，missing=[]。

## 复跑与性能边界

```bash
node scripts/notion-startup-flow.mjs --help
node scripts/notion-startup-flow.mjs run --evidence-root /absolute/new-evidence-parent
node scripts/notion-startup-flow.mjs evidence --evidence /absolute/reported-run
node scripts/notion-startup-flow.mjs cleanup --evidence /absolute/reported-run
node scripts/notion-startup-flow.mjs evidence --evidence /absolute/reported-run
```

默认全场景包括上述 rpc-abort 真失败，应返回失败并完整保留，不删除或排除它来得到绿色结果。单场景使用 help 中的 `--case`；每个新 run 在独立目录，不覆盖旧原件。这里只驱动 Pi，未执行的 OMP/真实 Notion/真实模型/独立安装均不是通过。

最终启动性能批次 `skill-startup-eSQbSH` 因 warm timeout、observer 启动迟延及两个 source 终局缺失而不完整。功能实驱证明了普通输入与目录的顺序，但本次不报告完整候选加速比。成本原始统计与旧安装基线见 [SC02 报告](skill-consumption-baseline-2026-11-04.md)。

Pi 1.4 仅在启动/reload 收集 resources_discover；没有晚到目录刷新原生菜单的扩展 API。本次精确 native 与美元补全通过，不等于原生菜单动态刷新已经完成，也没有自动 reload 用户会话。

