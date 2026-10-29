# 随包 Skill 发现与消费

Broker 与 Tern 分发三份完整的本地 Skill，经普通发现、选择与加载链路消费。它们不依赖 Notion 认证、全局 CLI 或中央安装回执。

| ID | 用户动作 | 必须观察的结果 |
| --- | --- | --- |
| NS-BUILTIN-01 | 冷安装并启用 Notion source 后输入 `$`，选择 `$ntn-skills@builtin` | 出现精确内建身份；选择只改草稿；提交加载完整正文 |
| NS-BUILTIN-02 | 启用 Notion source 后选择 `$ntn-skills-maintain@builtin` 或 `$ntn-skills-sync@builtin` | 正文及相对 references 可读取；操作指引对应实际安装 CLI |
| NS-BUILTIN-03 | 配置同名本地/Notion Skill | 每个来源有独立身份；`@builtin` 指向包内内容，精确选择不串源 |
| NS-BUILTIN-04 | 零 Notion source、禁用 Notion source、仅启用 filesystem source，再启用尚未连通的 Notion source，之后配置多个 source | 前三种不出现三条 `@builtin` 补全，普通 local/filesystem 候选保留；已启用 Notion 即使连接不可用也出现 builtin，包内资源可离线读取；多来源保留各自 command/database，不隐式选首项 |
| NS-BUILTIN-05 | 独立 npm 和 Tern 归档 | 三份正文和完整资源相同；不借用 checkout 或旧中央目录；升级包后新会话消费新版本 |

## 执行路线

先构建本次 CLI/Broker。跨仓开发可以使用 `NTN_SKILLS_BUILD_ENTRY`；正式产物固定已发布 CLI 依赖。逻辑回归使用既有 `bundled-builtins.test.ts`、`accepted-selections.test.ts`、smoke 与 completion 检查；独立包使用 `control.mjs run distribution`，宿主消费和 UI 使用现有 source/editor/Pi PTY 或三 surface 路线。

分别检查 Pi terminal、OMP terminal、OMP native GUI 的候选、接受草稿、完整正文和资源。Tern 手动 picker 插入完整身份 token；宿主自动补全在接受事件记录精确身份。正文、资源、CLI 指引、多来源隔离和实际模型使用分别报告，不以候选出现代替正文消费。

维护任务由普通 Agent 加载内建 Skill 后执行 public CLI：当前读取 → pinned apply；首次 connect → 后续 run。真实 Notion 验证使用本次有归属的内容与原操作，核对内容、恢复和冲突；不要求日常用户执行额外证明步骤。

`/ntn-skills` 父子命令、管理/schema palette、专用 save 工作流和中央安装管理 runner 已移除。CLI 的显式 `ctl builtin install/update` 仍用于用户主动管理的本地副本，其验证归 CLI 仓库；不再是 Broker 安装或发现的前置条件。
