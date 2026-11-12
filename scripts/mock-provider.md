# Mock provider

这是测试辅助，不是生产 provider，也不新开一条验收 Skill。

`scripts/mock-provider-adapter.mjs` 提供两件东西。

- 进程内 `createInProcessStream`。生成的 Pi 插件从稳定导出导入 `selectCall`、`observe` 和 `control`，不再改写 `writeFakeProvider` 的源码。
- `startLoopbackMock`。只监听 `127.0.0.1`。Pi 使用已安装的 `openai-completions` serializer 和 parser。服务端用同一份 `selectCall` 读取已经出现在请求里的工具文本，不补写 Notion 正文，不改去重，不伪造 active 或 receipt，也不直接调用 Broker。

默认 `--provider-backend in-process` 保持原来的快速 provider 和 capture replay。`--provider-backend http` 接受显式 `--scenario context-once` 或 `context-wire-negative`。正常 HTTP 路径的公开工具顺序是 `notion_list`、`notion_use`、固定资源 `read`、再次 `notion_use`、再次 `read`，然后保持响应并 abort。引用只从已经出现在 HTTP 请求里的工具文本复制。进程内的 `native-repeat` 仍是原来的四次 read。启动参数包含 `--no-skills` 和 `--no-mcp`。

HTTP 重建看不到 Pi 的 `isError` 布尔值。失败工具的判定仍以进程内 provider 为准。环回响应不使用生产地址或生产凭据。凭证只接受固定的 `fixture-no-secret`。`observer_finality` 来自现有 `sourceFinality`，不在断言里改成 true。原始 HTTP 实体、RPC 帧和 session 目录在停止进程前写入证据目录。

建议检查：

```bash
node --test scripts/mock-provider-adapter.test.mjs
node --test scripts/notion-sdk-pi.test.mjs
node scripts/notion-sdk-pi.mjs run --package ABSOLUTE_INSTALLED_BROKER --fixture ABSOLUTE_FIXTURE_JSON --scenario context-once --provider-backend http --out ABSOLUTE_EVIDENCE
```

第三条不接入根 `package.json`。它不替代 all14，也不表示全部 CTX 项已经完成。

两个 backend 的 `context-once` 使用相同决策、来源原件、操作序列和取消边界。HTTP backend 另证明实际安装 serializer 的发送内容。每个请求核对完整主文、资源和目录各一份，保留原操作 effects 和 Session。`context-wire-negative` 仅走 HTTP，验证后置重复、删正文、改 schema，以及持久化正文恢复后被改成 assistant 角色的拒绝路径。后置实体不匹配不能签发成功回执；已经发送的事实不清零。

使用既有 `evidence` 和 `cleanup` 核对原件。HTTP 服务器有请求数、并发数、字节数、header/body/hold 时间上限；不记录凭据。流中断测试明确停在已收到部分 SSE、尚无完成标记的控制点，不能用 exit0 冒充模型完成。
