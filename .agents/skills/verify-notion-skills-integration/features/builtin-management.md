# 随包 Skill 发现与消费

Broker 与 Tern 分发三份完整的本地 Skill，经普通发现、选择与加载链路消费。它们不依赖 Notion 认证、全局 CLI 或中央安装回执。

| ID | 用户动作 | 必须观察的结果 |
| --- | --- | --- |
| NS-BUILTIN-01 | 冷安装并启用 Notion source 后输入 `$`，选择 `$ntn-skills@builtin` | 出现精确内建身份；选择只改草稿；提交加载完整正文 |
| NS-BUILTIN-02 | 启用 Notion source 后选择 `$ntn-skills-maintain@builtin` 或 `$ntn-skills-sync@builtin` | 正文及相对 references 可读取；操作指引对应实际安装 CLI |
| NS-BUILTIN-03 | 配置同名本地/Notion Skill | 每个来源有独立身份；`@builtin` 指向包内内容，精确选择不串源 |
| NS-BUILTIN-04 | 零 Notion source、禁用 Notion source、仅启用 filesystem source，再启用尚未连通的 Notion source，之后配置多个 source | 前三种不出现三条 `@builtin` 补全，普通 local/filesystem 候选保留；已启用 Notion 即使连接不可用也出现 builtin，包内资源可离线读取；多来源保留各自 command/database，不隐式选首项 |
| NS-BUILTIN-05 | 独立 npm 和 Tern 归档 | 三份正文和完整资源相同；不借用 checkout 或旧中央目录；升级包后新会话消费新版本 |
| NS-BUILTIN-06 | 已启用 Notion source，库中没有官方副本时自然咨询产品维护或 Source 同步 | 默认读取实际配对包中对应的完整正文，不先搜索 Notion 同名说明；指导来源和写入 source/ENTRY 分开；generic、legacy 与 Pi 的可用工具分支一致 |
| NS-BUILTIN-07 | 明确指定 Notion 团队流程，再遇到目录 pending、partial 或权限失败 | 精确来源与已选版本保留，不静默换 Builtin；inspect 不激活，真正采用仍加载 Requires；同名副本不能冒充 `@builtin` |

## 执行路线

先构建本次 CLI/Broker。跨仓开发可以使用 `NTN_SKILLS_BUILD_ENTRY`；正式产物固定已发布 CLI 依赖。逻辑回归使用既有 `bundled-builtins.test.ts`、`accepted-selections.test.ts`、smoke 与 completion 检查；独立包使用 `control.mjs run distribution`，宿主消费和 UI 使用现有 source/editor/Pi PTY 或三 surface 路线。

分别检查 Pi terminal、OMP terminal、OMP native GUI 的候选、接受草稿、完整正文和资源。Tern 手动 picker 插入完整身份 token；宿主自动补全在接受事件记录精确身份。正文、资源、CLI 指引、多来源隔离和实际模型使用分别报告，不以候选出现代替正文消费。

维护任务由普通 Agent 加载内建 Skill 后执行 public CLI：当前读取 → pinned apply；首次 connect → 后续 run。真实 Notion 验证使用本次有归属的内容与原操作，核对内容、恢复和冲突；不要求日常用户执行额外证明步骤。

产品维护与同步默认使用实际配对包；明确选中的 Notion 团队流程保留独立身份，包升级不替换当前任务的选择。`skill-guidance.test.ts` 核对各工具分支、零来源 gate、两份包内入口及正文未预加载；真实模型使用 `verify-notion-agent-workflows` 的默认咨询、明确远端流程与失败场景，不能以文字断言替代实际正文和来源证据。

CLI 的一级 `skills` 命令读取随包内容：默认列目录，`get NAME` 输出原始 Markdown，`get NAME --path RELATIVE_FILE` 读取参考文件，`get NAME --full` 包含所有支持文件，`path NAME` 返回当前包的实际目录。`--json` 提供结构化结果。内置 Skill 随 CLI/Broker 升级，没有独立的安装、状态、更新或 Notion 导入流程。

独立安装检查沿 `scripts/verify-package-closure.mjs` 核对内嵌 CLI 的目录、原始正文、JSON、完整支持文件和实际包路径。所有内容必须等于本次归档中的字节，读取不得新增 HOME 下的安装状态。旧命令及独立安装管理命令不应有可用 schema。只读维护 candidate 的允许范围同步到新命令，同时保持所选维护 Skill、受保护文件与 Library 范围。
