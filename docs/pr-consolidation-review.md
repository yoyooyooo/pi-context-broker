# 历史分叉的有限差异审阅

对应 AH-1048。唯一交付 PR 为 #12；旧 #6 的 `74954ee49e4dc3d1a66e3dfdf886e1b4c1511e44` 和 #7 的 `7ea63c869a1e06b91267f7ef3b04d886863a27a4` 不是当前交付历史的祖先。以下决定只说明当前实现与验证选择，不把旧提交记成已合并。

## 决定与当前验证入口

| 旧提交 | 当前处置 | 对照与理由 |
| --- | --- | --- |
| `4061f5a` | 由当前协议替代，不回灌旧整体实现 | authoring、原操作恢复归 CLI；Broker 的写后精确失效、固定版本与操作 effects 由 `cli-write-invalidation.test.ts`、`shared-notion-adapter.test.ts` 和当前 SDK/实际 Pi 检验。保留较新的作用域及只读边界。 |
| `2e0f248`、`01d57e3` | 保留当前投影所有权，不移植旧共享 host-index 实现 | 当前 source catalog/SDK 可复用共享缓存；host alias/index 则按宿主投影隔离，`refresh` 不直接复用 source 的 `metadataIndexPath`。旧分支的共享投影、别名修复与 deterministic index/schema 是另一套实现，不能只挑其中的复用路径。这里选当前隔离边界，不声称旧方案本身必然错误，也不声称已实现它的跨进程 host-index 优化。 |
| `e74bb77` | 已由当前实现覆盖 | `host-prepare.test.ts` 验证 exact forced safety prompt 保持不变、默认目录仍可用且不读取正文。 |
| `f3f1c53` | 保留当前工具所有权，不增加第二套读取工具 | `pi-read-adapter.test.ts` 明确保留第三方 read，`resource-read-host.test.ts` 覆盖受支持 native read 的同 owner 固定版本资源批量读取；缺失能力按已有授权 CLI 路线或明确不可用处理。不用重名覆盖或新工具悄悄绕过宿主权限。 |
| `69af774` | 使用现有按用户任务激活的说明 | Pi 的 `notion_use` 已描述将指令应用到用户任务；检查、介绍用 read，加载不授予执行权限。`skill-guidance.test.ts` 保持精简选路、意图和权限边界；不复制旧长提示。 |
| `e2d06ed` | 拒绝旧大规模文档删除 | 当前源码已形成更新的消费、效果与恢复契约。保留现有文档，必要正文在其当前归属处更新，不以历史清理补丁删除新协议。 |
| `5e261e8` | 不改变 Tern 生成文件的跟踪策略 | 本批交付对象是 CLI 与 Pi 的 Notion 链路。另一个主工作树有用户已有 Tern 改动，不借历史 PR 整理覆盖它；当前打包隔离由 `pack-target.test.mjs` 验证。 |
| `34f1972`、`74954ee`、`842512d` | 用当前 receipt/资源验证替代旧目录形状断言 | 当前 `source-runtime.test.ts`、`notion-entry.test.ts`、`notion-sdk-pi.test.mjs` 与独立安装测试验证固定字节、来源身份及恢复。旧 readdir 顺序和旧 native-stub/Trash 假设不作为当前数据模型；保留当前平台能力检测，不宣称所有平台都无需回收能力。 |
| `d382ded` | 保留当前打包身份检查，不移植另一版本发布链 | `build-tern.mjs` 要求显式 CLI/SDK 来自同一包、匹配 Effect 版本与 SDK capability；`pack-target.test.mjs`、`release.test.mjs` 验证当前契约。当前交付不执行发布，也不把旧 release 架构作为空库验收前置。 |
| `6d9763b` | 替换为本批明确 producer commit | CI 的 CLI 输入固定到本批已推送提交；不复制旧 0.4.0 fixture。CLI 的 Pi gate 保留其稳定 kernel pin，并用当前 CLI 构建消费包，避免互相追逐 head 的循环依赖。 |
| `5d9e6e5` | 从当前 CLI 包取得 builtin，并使用其新正文检查 | 配对构建同步真实包内说明，CLI 的 `builtin-guidance.test.ts` 检查当前管理入口及完整 reference；不从旧分支复制旧文档覆盖新 public setup。 |
| `f818b0a`、`7ea63c8` | 保留较新 Pi gate 与 stale-guidance 清理 | `notion-consumption-tools.test.ts` 验证没有启用 Notion source 时无 Notion 工具、保留本地 native read；`skill-guidance.test.ts` 验证删除旧注入说明。旧直接 return 会留下旧指引，旧 generic fallback 会扩大本地会话工具面，均不回灌。未扩展宣称所有 OMP/Tern 场景。 |

## 交付记录

上述条目已作保留、替代或不采用的明确决定，不再留一个等待决定的历史补丁队列。原来源分支与 PR 历史均保留。代码提交相同与功能被更新实现覆盖是不同结论；测试结果应绑定实际运行的候选，不从本表推导“全环境通过”。

实际 Pi 的原生 Session、真实工具调用、serializer HTTP payload 与受控 provider 分开审计。provider 失败不会确认新的会话选择；重复 `notion_use` 的精简输出可以引用此前可见且固定 ref 完全相同的目录，不能因没有重复目录就猜资源身份。该运行记录由 AH-1047 的真实原件持有。

两仓的独立 Promptfoo 提案不纳入本批，未启用第三方扫描，也不把 PR 关闭解释为已实现扫描。
