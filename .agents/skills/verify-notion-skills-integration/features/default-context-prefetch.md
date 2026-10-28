# 默认 View、首发注入与后台准备

## 入口

```bash
node scripts/verify-notion-integration.mjs doctor --mode deterministic --view-discovery true
node scripts/verify-notion-integration.mjs run --mode deterministic --view-discovery true --evidence-root /absolute/evidence
node scripts/verify-notion-integration.mjs evidence --evidence /absolute/run
node scripts/verify-notion-integration.mjs cleanup --evidence /absolute/run
```

使用实际安装的 Pi / OMP、公开扩展/RPC 入口和 provider payload 捕获。Notion CLI 与 LLM 是受控 fixture，不代表真实 Notion 或真实 LLM。传入 `--extension /absolute/installed/src/index.ts` 可验证冻结安装产物。

## 必须检查的行为

| 场景 | 可观察结果 |
| --- | --- |
| 新建会话、列举 Views、查询当前 View | provider 请求数为 0，未向会话写入默认目录正文或完整 Skill |
| 第一条普通消息 | 一个当前目录，只有名称/描述/位置；未预载 Skill 正文 |
| 首发前选另一个 View | 第一条模型请求直接使用该 View，无旧目录残留 |
| 从 A 切换 B | 下一轮目录替换；B 内未勾选 checkbox 的 Skill 可见，A 外条目不再默认公布 |
| 显式调用 View 外的 Skill | 完整 `$` 选择有效，正文只加载一次 |
| 再次切换 View | 已读正文和固定资源版本保留，不复制、不声称撤回 |
| 无配置 / 显式配置 / default reset | 首项兜底 / 配置 ID 优先 / 恢复默认解析分别可见 |
| 错误 ID / 零 Views | 前者报告错误而不改选，后者为空目录；普通任务和精确显式调用仍可用 |
| 进程重开续接 / fork 到旧分支 | 根据有效分支恢复选择，不拿进程内状态充当持久化 |
| 同 profile 两个活跃会话 | 切换互不串选，未配置时各自解析首项 |
| 本地 Skill | 不是 Broker 所有的 metadata 仍保留 |

证据为 `*-view-provider.jsonl`、`*-view-rpc.json`、`*-view-result.json`、manifest 与自有进程退出回执。检查实际 provider 中的目录，不只检查配置对象或 UI 提示。

## 真实内容与模型

使用已有只读授权的库和 View。模型模式需明确 `--model provider/model`、自然任务和 `--view VIEW_ID`。要求模型选择入口、成功读取正文及同快照支持文件，实际网络成功并把两份内容送入后续请求。当前任务可用 `magpie/group/flash`；不修改全局模型选择。记录失败，不把受控 provider 或 HTTP 200 单独算作完成。原生目录 stub 可能位于宿主临时索引；允许该真实广告入口后，仍须核验完整导出回执、文件 SHA 和返回字节。

## 预取与压缩

View 成员可后台准备完整快照，准备不激活。Prompt 排除默认发现和预取。旧 `--default-context true` 专项的 fixture 通过 View 的 checkbox 筛选模拟成员变化，字段本身不再是第二道门禁。本专项通过真实宿主 compact 命令与受控 summary hook 检查选择保留、正文移除及后续重读；它不证明远端 summarizer 质量。共享消费者取消、失效重验沿 session-cache-recovery 与 activation-snapshot-resources 地图单独取证；没有对应执行记录就明确未测。
