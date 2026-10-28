# Source 配置与发现

前置条件：仓库依赖与宿主入口可用；fixture source 由 harness 创建，用户配置保持原样。live 必须有现有授权配置、实际 DB 与 Skill URI。Doctor 只证明工具存在与版本。

deterministic/installed 也通过双宿主发现 filesystem source，覆盖 metadata/read/native RPC+print/`$`/resource；证据为实际输出的 `pi-fs-`/`omp-fs-` 系列。真实 fixture 创建 deadline 15 分钟，`intent.json` 留存 create-started/unknown。恢复 recipe：`node scripts/verify-notion-integration.mjs run --mode live-fixture --database UUID --resume-evidence /absolute/FAILED_EVIDENCE`；校验旧 scratch ownership/input 唯一 name，catalog exactname 唯一且 read canary 一致后不 create，最终 archive。校验失败/unknown 不得 pass。

| ID | 用户入口与动作 | 可观察 assertion |
| --- | --- | --- |
| NS-CFG-01 | 启动带 Notion source 配置的 Pi/OMP 会话，首次请求 metadata | 两个真实宿主均发现配置中的 source；默认原生目录公布当前 View 的 Skill/Router 成员，不额外按 Default Context 过滤，显式选择保留完整目录；后台预取不将正文当成已激活内容。 |
| NS-CFG-02 | 对 fixture 的重名 Skill 请求发现与选择 | 候选仍可区分并指向正确 source/URI；选择一个不得读取或注入另一个正文。 |
| NS-CFG-03 | 使用 fixture 错误与超时 source 进行发现 | 捕获实际失败或超时；不能生成虚假成功候选或把失败记为 pass。 |
| NS-CFG-04 | 使用 database UUID 进入 live-fixture，创建独立测试页并消费与归档 | 唯一动态 name 的真实页及 `references/guide.md` 有 create/read/list/export 与双宿主捕获；finally 仅 archive 本次页及 child pages，GET 确认并记录 `live-fixture-create.json`、`live-fixture-cleanup.json`。只读 live 不足以通过。 |
| NS-CFG-05 | `bun run test:source-dependencies` 启动双宿主，依次缺 command、缺 `ntn`、旧版本、缺 API capability、未认证；修复 command 并 refresh | 启动/doctor 返回对应脱敏错误；普通聊天、本地与正常 source 可用；已选中的已知记录在 source 不可用时阻断 provider，未知引用保持 literal（含失败 source 命名空间），不误当成选择失败；同进程 refresh 后恢复。 |
| NS-CFG-06 | `node scripts/verify-native-ui.mjs --source-dependencies` 启动自建 Tern/OMP，配置缺失 executable 与另一条正常 source | 启动错误可见，普通聊天、本地自动补全和手动 picker 可用；失败 namespace 中未知引用原样派发且无 source read/export。Tab 接受正常 source 的已知候选后注入 read 失败，显示 `ACCESS_DENIED` 且 provider 不增加；保留动作、截图与 cleanup 回执。 |
| NS-CFG-07 | `--mode deterministic --shared-catalog true` 启动不同项目的实际 Pi/OMP | 同一凭据/远端选择共用目录，命令与 namespace 变化仅影响调用/显示；另一端复用刷新后的目录和 immutable export，原始校验时间不续期。完整步骤与证明边界见[共享缓存地图](session-cache-recovery.md#共享-notion-缓存)。 |

默认目录筛选、后台预取与未勾选项显式调用使用 [View 默认目录专项](default-context-prefetch.md)。`Default Context` 缺失或未勾选均为 false。普通 live/model 的原生目录规程要求目标页属于当前 View，不能修改用户已有页以满足验收。live-fixture 只勾选所属测试页。

日常 `SOURCE_RESPONSE_INVALID` 先对照当前 source CLI 的 JSON 与该宿主实际安装的 Broker schema；合法 `upstream` 元数据也会被尚未支持该字段的旧安装严格拒绝。记录 package 路径及源码 hash，使用匹配构建更新安装与宿主 package 引用，再启动新的 Pi 或重启 OMP。验收保留日常 source 配置与认证，在自有终端/session 中等待扩展资源完整就绪后输入候选前缀；核对菜单、Tab 草稿和 provider 中正文 digest/次数。只有空编辑框的早期帧不算就绪。CLI 成功、checkout 通过和真实安装可用分别取证。


Recipes（从仓库根目录执行）：

```bash
node scripts/verify-notion-integration.mjs doctor --mode deterministic
node scripts/verify-notion-integration.mjs run --mode deterministic
node scripts/verify-notion-integration.mjs doctor --mode live --database DB --skill-ref skill://PAGE/SKILL.md
node scripts/verify-notion-integration.mjs run --mode live --database DB --skill-ref skill://PAGE/SKILL.md --command-json '["/path/ntn-skills"]'
node scripts/verify-notion-integration.mjs doctor --mode live-fixture --database UUID
node scripts/verify-notion-integration.mjs run --mode live-fixture --database UUID --command-json '["/path/ntn-skills"]'
```

`--command-json` 可省略，使用现有 CLI 入口。替换示例值后执行，记录实际 argv 和宿主版本，不记录 token。审阅发现结果、命令 transcript 与 provider 捕获；fixture 只覆盖确定性配置行为，不能替代 NS-CFG-04 的 live 证据。

证据与清理统一使用本次实际 evidence 绝对目录：`node scripts/verify-notion-integration.mjs evidence --evidence /absolute/evidenceDIR`；审阅后 `node scripts/verify-notion-integration.mjs cleanup --evidence /absolute/evidenceDIR`，再执行 evidence。cleanup 仅将独立 `/tmp` scratch 移到系统 Trash，保留 evidence。每个 ID 分别记录 pass/failed/未运行；此地图未执行任何 recipe。
