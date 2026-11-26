# Mock provider

这是测试辅助，不是生产 provider，也不另建验收 Skill。

`scripts/mock-provider-adapter.mjs` 保留两个可独立测试的适配器：
`createInProcessStream` 用于进程内 serializer/parser 控制；
`startLoopbackMock` 只监听 `127.0.0.1`，由实际安装的 Pi
`openai-completions` serializer 发送请求。辅助函数的存在不代表当前
Pi driver 同时维护两套运行链路。

当前 `scripts/notion-sdk-pi.mjs` 只使用 HTTP provider、当前 SDK v3 和实际
Notion HTTP 服务夹具。它只接受 `default-view`、`http-cache-recovery`、
`http-warm-restart`、`http-interruption`、`working-set` 五个场景；旧 provider-backend 参数、
旧快照夹具和旧场景直接拒绝。完整复现命令见
[当前验收入口](../docs/current-context-candidate.md)。

受控 provider 只决定下一次公开工具调用。引用必须来自已在请求中出现的
目录或工具结果；不补写 Notion 正文，不修改产品去重，不伪造 active 或
delivery receipt，不直接调用 Broker 内部。当前 driver 启动参数包含
`--no-skills` 和 `--no-mcp`，因此不能用它证明本地 Skill 的自然选路。

建议分别执行：

```sh
node --test scripts/notion-sdk-pi.test.mjs scripts/notion-sdk-observers.test.mjs
BROKER_TEST_PI="$PI" node --test scripts/mock-provider-adapter.test.mjs
node scripts/notion-sdk-pi.mjs run --package "$BROKER" --fixture "$FIXTURE" --source-http-helper "$CLI_ROOT/scripts/sdk-source-fixture.mjs" --pi "$PI" --scenario all --out "$OUT"
node scripts/notion-sdk-pi.mjs evidence --evidence "$OUT"
```

前两项检查解析、oracle、观察器和实际安装的适配器；第三项才启动完整
Pi 场景。普通 CI 的轻量测试不冒充实际 Pi 或自然模型验收。

HTTP 重建没有 Pi 原生的 `isError` 布尔值，最终工具成功与失败以保存的
原生 RPC 帧为准。每项场景保存原始 HTTP entity、RPC、Session、SDK start/end、
服务请求和进程退出。只有实际拥有的服务夹具凭据进入隔离进程；不使用
生产 provider 地址或凭据。取消测试必须观测真实 source hold、abort、
终局与随后同会话输入；exit 0 本身不证明任务完成。

重复正文、正文缺失、schema 改写与恢复后的角色义务由
`final-request.test.ts` 和 `final-request-undici.test.ts` 等明确测试维护。
它们是源码/实际 Node 传输层负控制，不标成已删除的 Pi 场景。实际发送的
请求不能因校验失败被记成未发送；未知 effects 也不能改写成 none。
