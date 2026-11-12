# CTX 当前有效上下文中的唯一内容

归属 AH-1014。此地图维护本批合同，不替代 [injection](injection.md) 和 integration 的真实宿主、安装及服务证据。

## Sub-features

| 对象 | 身份 | 本请求合同 |
| --- | --- | --- |
| 默认目录和候选卡片 | 来源、作用域、对象、元数据版本 | 当前完整目录一份；描述可复用同请求内的可信完整对象 |
| Skill 与 Requires | scope、owner、snapshot、正文 hash | 每份必要全文一份；未选 Members 正文为零 |
| 资源 | scope、owner、snapshot、File ID 或精确路径、hash | 按需完整读取；同一来源版本只保留一份 |
| 生成目录与关系 | owner、snapshot、完整目录内容 | 对象描述一份，关系保留引用，不重复整张卡片 |
| 操作结果 | toolCallId、原 operation | 每次结果独立保留，unknown 不变 none |
| 指引 | 本次实际可用工具集合 | 一份当前指引；不预载运维说明 |

重复 ref 字符串和真实工具调用不算重复正文。用户明确要求再 read 或 use 时仍执行。作者正文、用户原话、每次 Prompt 任务内容和原始 Session 不做文本相似性去重。

同一请求内的重复与连续请求携带必要历史分开计量。未发生上下文变化时不追加相同全文。压缩后全文仍在则复用；全文消失或只剩摘要、loaded 标记时按需恢复原固定版本。fork、切分支、明确刷新和权限变化均以当前有效上下文为准。

## How to get to it (user POV)

在新 `-ns` 会话发现一个 Skill，使用后读取其参考文件。普通续问复用已有内容。再次明确 read/use 仍执行，但只增加必要回执。随后从管理端修改自有对象，核对普通续问的旧 pin 与明确刷新后的新选择。

## Driving it with the existing harness

先执行独立验收器的正负控制：

```sh
node --test scripts/context-once-evidence.test.mjs
```

`scripts/context-once-evidence.mjs` 只从实际 message content 的明确位置读取值。调用者将位置和身份绑定到独立冻结的来源原件；不能调用产品投影器来生成预期答案。原始 session details 不能冒充模型正文。输出中的未测 wire、source 与模型成本保持 unknown。

源码回归继续使用 native-read-session、resource-read-projection、skill-context-session、host-prepare。真实 Pi 沿 `scripts/notion-sdk-pi.mjs` 现有入口运行。Mock Provider 仅替换模型决策，工具、Broker、SDK、Pi 会话与 serializer 保持真实。受控引用必须来自实际可见目录或工具结果，不能从私有 oracle 注入。

测量固定内容、View、权限、工具集合、cache age、模型路由与预算。分别记录 source 请求、源正文 bytes、生成结构 bytes、实际 HTTP bytes 和真实模型 usage。1、2、10 次重复访问应为一份完整内容与目录，加各次必要回执，不要求新操作后总字节完全不变。

## Gotchas

新增断言必须先在原缺陷上失败。当前基线已知重复目录随读取次数增长，以及 scalar 资源退役误删 effects。历史 112 项源码测试和 167 项 driver 测试通过不代表本批合同通过。

source/owner/pin/文件身份不同不能因同名字或同字节而合并。省略依据必须仍在同一最终请求中；不能引用另一个省略标记或已被压缩的内容。字节与结构断言不证明模型自然选路质量。

纯表示变化更新实现回归与本地图。状态语义变化同时审阅 consumer-state、组合模型、正负配置和源码映射；不能只更新 hash。每个切片通过 Pro `ntn` 同步受影响的 Notion 长期页并完整读回，保留所有失败和未执行范围。

CTX06 的 DeliveryBoundary 不新增 TLA 状态。进程内 mock payload 和 `after_provider_response` 的 2xx 仍是 logical-only，不是最终传输证明。普通 `openai-completions` 只有 Node Undici 实际发送实体与绑定摘要一致才是 wire 回执。摘要不一致时请求保持 dispatched，但不确认 active、selected 或 persisted。`contextBrokerResource` 的标量/批量结果和 effects 与主文、preparation 一样核对。`/context-broker request` 只保留哈希身份、固定 snapshot pin、copied/reused/retired、`remote_writes`/`author_content`，不保存正文或 locator。

## Current installed gates

冻结独立安装包、CLI/SDK、Pi 和 fixture 身份后，使用同一个入口：

```sh
node scripts/notion-sdk-pi.mjs run --package "$BROKER" --fixture "$FIXTURE" --scenario context-once --provider-backend in-process --out "$OUT/fast"
node scripts/notion-sdk-pi.mjs run --package "$BROKER" --fixture "$FIXTURE" --scenario context-once --provider-backend http --out "$OUT/http"
node scripts/notion-sdk-pi.mjs run --package "$BROKER" --fixture "$FIXTURE" --scenario context-wire-negative --provider-backend http --out "$OUT/negative"
node scripts/notion-sdk-pi.mjs run --package "$BROKER" --fixture "$FIXTURE" --scenario session-compaction --out "$OUT/compaction"
```

`context-once` 的两个 backend 共用 `list → use → read → use → read → held/abort` 决策与独立来源断言。HTTP arm 捕获实际请求实体，核对每次主文、资源、目录各一份及各次 effects；fast arm 不冒称发送 HTTP。两者都保留原始 Session、SDK 终局和工具 callId。原 `all` 仍是 14 场景，未把新门槛塞入旧分母。

`context-wire-negative` 实驱四种反例：投影后重复正文、丢失正文、修改 schema，以及先成功持久化后把恢复正文的 user 角色改成 assistant。前三者已发送但拒绝签发 wire 成功；最后一个在发送前拒绝第二次请求，保留首轮真实接受事实。所有反例都必须保留原件，且不能新增 active/selected 回执。

恢复后的正文由独立的 `nativePromptSha256` 机器回执绑定，user 消息本身没有内联详情。验收必须使用真实 `deferredSourceEntries` 和原生续问，不能只用手造 `details.records`。回执留在私有检查上下文，预期输入在后续可变 hook 前固定，不发给模型。普通用户引用或同文 assistant 回答不充当该 user 角色义务。

相关 CI 同时运行根 oracle、普通消费专项、安装 all14、controlled HTTP 三景及以上门槛；`check-gates` 的负例拒绝遗漏场景、吞掉失败和缺证据上传。取消 SDK 结果可保留独立 effects，但不能带成功 preparation/delivery 字段。`none/retained/unknown` 不因取消被改写。

实际服务和真实模型仍独立执行。管理编辑只能针对已有归属证明的自有对象，并通过 Pro 正式 `ntn`，保存编辑前后完整读回。普通续问保留旧 pin，显式 refresh 后完整新图才替换。真实模型用冻结短任务检查自然选路、完整内容、只读效果和原生 Session；不得把 Mock 的 OK、合成 usage 或一次改正后的答案算冷首答成功。

完成后沿原 `evidence → cleanup → evidence`。cleanup 只回收该次 owned scratch，不删证据。HTTP 反例使用自己的子目录，失败原件也进入 inventory。长期不同 Skill 工作集积累归 AH-1023，不阻塞本批同内容唯一性。
