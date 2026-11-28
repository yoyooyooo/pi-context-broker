# CTX 当前有效上下文中的唯一内容

当前归属 AH-1188 的验收整顿；AH-1014 保留为历史依据。本地图维护内容、
身份与最终请求合同，真实安装、服务、自然模型和普通日用入口沿各自验证层报告。

## 合同

| 对象 | 身份 | 本请求合同 |
| --- | --- | --- |
| 默认目录和候选卡片 | 来源、作用域、对象、元数据版本 | 当前完整目录一份；Default Context 不自动消费正文 |
| Skill 与 Requires | scope、owner、snapshot、正文 hash | 每份必要全文一份；未选 Members 正文为零 |
| 资源 | scope、owner、snapshot、File ID 或精确路径、hash | 按需完整读取；同一来源版本只保留一份 |
| 明确检查最新版 | 完整主文证明及其精确目录 | 可以与旧 pin 共存；不成为 active 指令，也不绕过真实权限 |
| 生成目录与关系 | owner、snapshot、完整目录内容 | 对象描述一份，关系保留引用 |
| 操作结果 | toolCallId、原 operation | 各次 effects 与 read status 独立保留；未知 effects 不改成 none |
| 指引 | 本次实际可用工具集合 | 一份当前指引；本地 Skill 走原生入口，不诱导额外 notion_use |

重复 ref 字符串和真实工具调用不算重复正文。用户明确要求再 read 或 use 时
仍执行。作者正文、用户原话、每次 Prompt 任务内容和原始 Session 不做文本
相似性去重。同一请求去重与连续请求携带必要历史分开计量。

Notion 内容变动、metadata TTL 到期和 Default Context 变动不替换旧会话选择。
`read refresh:true` 只检查当前内容；`notion_use refresh:true` 在完整成功后
替换指定 roots。共享 Requires 冲突必须给出相关 roots，失败保留旧图。
Enabled=false 不抹掉已有完整固定正文；真实认证或权限拒绝仍移除对应投影。

完整 main read 的公开状态须说明本次为 inspect、未改变 activation、未由本次
read 取得 Requires。use membership 从本次有效 use 图和完整 binding 派生，
区分仅查看、root、Required 与双角色；pending use 不宣称已获 provider 确认。
这是当次操作事实，后续不能用历史 footer 重建 selection。目录/描述去重保留
该事实；公开状态与私有证明不一致时不得获得完整目录的复用资格。

压缩后全文仍在则复用；只剩摘要或 loaded 标记时尝试恢复原固定版本。恢复
缺失按完整 Required 闭包降级，保留独立 roots。总恢复预算限制一次请求的等待，
warning 不成为永久 abort；fork、切分支、取消和晚到结果遵守当前 generation。

## 验证入口

先执行独立字节 oracle 和实际请求边界：

```sh
node --test scripts/context-once-evidence.test.mjs packages/context-broker/scripts/final-request-undici.test.ts
bun run --cwd packages/context-broker test:consumption
```

`context-once-evidence.mjs` 只从实际 message content 的明确位置读取值，
调用者把位置和身份绑定到独立冻结的来源原件。不能调用产品投影器制造预期，
也不能把原始 Session details 算成模型收到的正文。

native-read-session、resource-read-projection、skill-context-session、
host-prepare、host-refresh、session-refresh、session-recovery 和 read-intent-status 负责相关
源码回归。final-request 的源码与真实 Node transport 负控制分别检查
重复/缺失正文、schema、原始角色义务和实体摘要。不把这些源码测试标成
实际 Pi 已经运行过的反例。

当前实际 Pi 使用唯一 SDK v3 driver：

```sh
node scripts/notion-sdk-pi.mjs doctor --package "$BROKER" --fixture "$FIXTURE" --source-http-helper "$CLI_ROOT/scripts/sdk-source-fixture.mjs" --pi "$PI"
node scripts/notion-sdk-pi.mjs run --package "$BROKER" --fixture "$FIXTURE" --source-http-helper "$CLI_ROOT/scripts/sdk-source-fixture.mjs" --pi "$PI" --scenario all --out "$OUT"
node scripts/notion-sdk-pi.mjs evidence --evidence "$OUT"
```

`BROKER` 是独立 npm consumer 里的实际安装包；`FIXTURE` 只含当前服务事实；
HTTP helper 与嵌入 SDK 来自同一 CLI revision。Pi entry、Node、包和源码指纹
必须冻结。完整准备命令见 [当前候选](../../../../docs/current-context-candidate.md)。

| 当前场景 | 真实控制点 |
| --- | --- |
| default-view | 激活前 Default Context off/on 零正文；激活后 Default/Enabled 变化、刷新拒绝与 ordinary/compact 保留原闭包 |
| http-cache-recovery | 来源编辑、过期 metadata、同会话旧 pin、明确 inspect/adopt、cache clear、固定对象丢失及 compaction 后连续输入 |
| http-warm-restart | 两个新 Pi 进程共享磁盘缓存，保持 5m TTL；重复 `$` 加载完整 root/Requires，原验证时间不变，含后台操作在内零 Notion HTTP |
| http-interruption | 实际 Notion body hold、取消、同会话继续、明确重试 |
| working-set | 共享 Requires、释放一个 root、compaction、完整工作集预算拒绝且不驱逐旧选择 |

`all` 仅指这五项。SDK v1 快照预置、旧场景和旧 backend flags 已移除，
没有兼容入口。受控 provider 只替换决策；工具、Broker、SDK、Pi Session 和
serializer 真实执行。引用只从模型实际可见目录或结果取得。证据和失败原件
全部保留；本 driver 没有 cleanup action。

## 结果与限制

分别记录 source 请求、源正文 bytes、生成结构 bytes、HTTP entity 与模型
usage。未测指标保持 unknown，未执行场景保持 not_run。普通 CI 不启动
实际 Pi；受控 Pi 不证明自然选路、live Notion 或普通 `pi -ns` 入口。

同 owner、scope、pin 或文件身份不一致时不能因同名或同字节合并。省略依据
必须仍在同一最终请求中，不能引用另一省略标记或被压缩掉的内容。真实
deferredSourceEntries 和原生续问绑定恢复正文；相同文字的 assistant 回答
不能充当应由 user 角色承载的源正文。

`after_provider_response` 的 2xx 只证明逻辑接受。普通 openai-completions
还需 Node Undici 的实际实体与绑定摘要一致才能签发 wire 回执。实体不一致
保留已发送事实，不新增 active、selected 或 persisted 确认。
`/context-broker request` 不保存正文和 locator。

状态语义变化必须同时审阅 observations/consumer-state、独立规则清单、
正负配置、实际 guard mutations 和源码映射，不能只刷新 hash。
RecoveryClosure 的有限活性以前置外部操作终止及用户继续输入为假设；
它不证明任意 provider 必然完成或原生终端输入一定可用。

真实服务修改只用归属明确的自有对象，保存前后完整读回。自然模型独立检查
本地 Skill 负例、额外 Notion 需求正例、inspect/adopt 和失败恢复；不能把
受控 OK、合成 usage 或纠正后的回答当冷首答通过。Pro/Mini 的 next 入口
与实际新进程按 [交付合同](../../../../docs/next-worktree-delivery.md) 验收。
