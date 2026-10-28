# 激活快照与资源

前置条件：目标 Skill 有可核对正文与关联资源，双宿主原生 extension/provider 捕获可用。live/model 须提供真实 DB/URI 与现有授权；model 另须指定模型与 prompt。

deterministic/installed 的双宿主覆盖 Notion 与 filesystem metadata/read/native RPC+print/`$`/resource，并为 Notion native 单独捕获 cold print。live-fixture 同页真实模型 recipe：`node scripts/verify-notion-integration.mjs run --mode live-fixture --database UUID --model provider/model --model-prompt TEXT`，模型结束后仍 archive。创建超时/unknown 按 SKILL 的 `--resume-evidence` 归属、exactname、read canary 校验恢复；不能重复 create 或以占位资源冒充成功。

| ID | 用户入口与动作 | 可观察 assertion |
| --- | --- | --- |
| NS-ACT-01 | 用户先发现 metadata，再首次提交目标 `$` 引用 | metadata 不提前加载正文；激活后 provider 捕获包含目标完整正文与可定位来源。 |
| NS-ACT-02 | 用户在同一有效上下文重复激活目标 | 激活决策与 provider 当前上下文显示同一快照只消费一次，不能仅用日志中的 inject 字样判定。 |
| NS-ACT-03 | 用户经宿主读取 Skill 声明的关联资源 | 实际资源 URI、读取结果与正文中的关联一致；不能把资源名称列出当成读取成功，也不能用占位资源充数。 |
| NS-ACT-04 | 用户用实际模型 prompt 要求按 Skill 读取并使用资源 | 真实模型调用记录显示 read/resources，返回目标内容并被实际响应使用；确定性捕获与模型自述不足以证明。 |

```bash
node scripts/verify-notion-integration.mjs doctor --mode deterministic
node scripts/verify-notion-integration.mjs run --mode deterministic
node scripts/verify-notion-integration.mjs run --mode live --database DB --skill-ref skill://PAGE/SKILL.md
node scripts/verify-notion-integration.mjs doctor --mode live-fixture --database UUID
node scripts/verify-notion-integration.mjs run --mode live-fixture --database UUID
node scripts/verify-notion-integration.mjs doctor --mode model --database DB --skill-ref skill://PAGE/SKILL.md --model provider/model --model-prompt TEXT
node scripts/verify-notion-integration.mjs run --mode model --database DB --skill-ref skill://PAGE/SKILL.md --model provider/model --model-prompt TEXT
node scripts/verify-notion-integration.mjs run --mode model --host pi --database DB --skill-ref skill://PAGE/SKILL.md --model magpie/group/flash-free --model-prompt TEXT
node scripts/verify-notion-integration.mjs run --mode model --host omp --database DB --skill-ref skill://PAGE/SKILL.md --model magpie/group/flash-free --model-prompt TEXT
```

交互等待回归运行 `node scripts/verify-native-ui.mjs --notion-loading`，按以下步骤审阅本次证据，不将 procedure 视为已通过结果。产品合同以 [broker 参考](../../../../packages/context-broker/docs/reference.zh-CN.md#内置-sources)为准。

1. 将隔离测试页保持 `default_context: false`，从原生 `$` 补全接受 cold Skill，提交原 prompt，让隔离 source 等待 65 秒，验证超过旧 60 秒命令总时限仍能成功。此受控 CLI 场景不代表单次 HTTP 耗时；每个网络尝试独立计时由 CLI transport 回归验证。确认 Enter 立即开始 preparation，原生 running 与 Stop 可见，会话和编辑器保持挂载，无 modal 或重复文字 Loading。未勾选项仍支持显式调用；测试 View 明确排除该页，以防后台预取把等待场景提前准备完成。
2. 确认 provider 前出现唯一 `Read ntn-skills://<alias>` 会话记录，目标没有 namespace 前缀，含来源、耗时与 running 状态。实际展开再收起详情。编辑 draft 并按 Enter，确认无第二次提交且 draft 保留。首个 provider 请求必须包含原 prompt 和所选 pinned export 的完整正文各一份；`$` 保留完整 frontmatter，原生 `/skill:` 按宿主规则可移除 frontmatter。不要手工重拼 fixture 正文。完成后另提交 draft，核对顺序。
3. 检查记录转为 done 后持续保留，暖读取复用快照。每个后续 cold 场景先从不含已加载正文的新会话开始，再 refresh；refresh 只刷新目录与准备状态，不移除仍在有效上下文中的指令。覆盖受控 4 秒 cold `/skill:`，以及 refresh 后 36 秒单请求预算耗尽的 `NTN_UNAVAILABLE`。error 记录也须保留，请求失败不新增 provider 请求；恢复后正文仅一份。当前 Tern 的错误行可能隐藏 target，只显示 `Read`、错误 note 和耗时；从 `sf-main` 中按 Read 与 broker 错误码识别，等待标题进入可见范围后点击 `Read` 标题并展开来源详情，不能只用 `ntn-skills://` 文字筛选。
4. 分别以 Escape 和实际点击原生 **Stop** 控件取消 preparation，确认取消及迟到完成均不发 provider。Stop 使用 32 秒受控读取，确保截图、树查询及草稿编辑完成后仍在 preparation。通过完整 UI tree 中的 `Stop` 文字、`sf-act` 与真实 bounds 定位并点击控件；`tree <selector>` 只返回浅节点，不能据此读取子树。重试必须成功。随后为真实工具 read 选择独立空缓存，退出并重新启动本次自有宿主；只新建会话或 refresh 仍可能复用先前准备的 native 路径。由受控 provider 对 fixture 返回的 canonical `skill://<page-id>/SKILL.md` 发起真实 read，在 source 等待时取证首个 provider 请求、source read 与原生 Stop；完成后核对 pinned snapshot 路径、正文工具结果及原生 done 行。不得以宿主目录名充当 canonical page ref，也不得把已准备快照的即时读取当成 cold preparation 通过。宿主可能在创建工具行前改写 URI，不能依赖 `skill://` 或瞬时工具 running 行。真实工具 read 不增加 synthetic 展示记录。
5. 在 timeout 恢复场景记录本次新建会话的精确 JSONL 及 error/done 状态；后续 cold 场景各自新建会话，不按“只有一个 JSONL”推断目标。执行 `/quit` 后以 `--resume` 打开记录的原文件。确认 done/error 终态恢复，旧 running 标为中断，普通 prompt 可以续接。检查展示记录的 `content` 为空，展示详情仅在 `details`，未进入 provider 消息、context、compact 或 branch summary。终态不得因计时器被删除。
6. 另用选定 View 内的所属页和独立空缓存启动宿主，先确认默认目录的首个 provider 请求不含正文。共享后台准备期间提交 `$`，实际点击原生 Stop。被取消的提交不得调用 provider，后台仍须以一次 read 与一次 export 完成正文和资源。显式重试后核对完整正文一份，再通过真实工具 read 消费同快照资源，不能产生第二次 export。此步骤记录在 `loading-result.json` 的 `defaultContextNativeStop`，与未勾选页的冷读取等待场景分别取证。
7. 审阅本次实际生成的 `loading-result.json`、fixture 调用记录、状态文件、provider 捕获、精确 session JSONL 及截图。图片附件与 preparation 期间 session switch 另取 RPC 证据；UI 脚本没有图片 helper，也不覆盖 session switch。记录失败、未运行及证据缺失，不推定 pass。

live 只读既有页 list/read/export。live-fixture 在当前授权下创建唯一动态 name 的独立真实页与 `references/guide.md`，完成 list/read/export 及双宿主捕获，finally 仅 archive 本次页与 child pages 并 GET 确认；审阅 `live-fixture-create.json`、`live-fixture-cleanup.json`。禁止永久删除或触碰无关页；只读 live 不能替代端到端。model 使用已有授权配置，不索取 token、不改用户配置。某宿主未实际调用资源时记 failed/未运行，不由另一宿主推断通过。
model 默认分别执行 Pi 与 OMP；只有 model mode 可用 `--host pi|omp` 选择单宿主，Doctor 同步限定检查范围，live-fixture 附加 model 仍执行两宿主。逐宿主审阅 `HOST-real-model-observer.jsonl` 与 `HOST-real-model-result.json`（HOST 为 pi 或 omp），确认 metadata-only catalog、模型自主 native read 入口、同快照关联资源读取、两种正文进入真实 provider、成功 HTTP 响应，以及非空且 stopReason 为 stop 或 length 的成功 assistant final 回复。每个宿主独立临时 broker/cache/session；保存 selector、计数、脱敏 source read 结果及 `assistant_final` 的 bytes、textSha256、脱敏 text、stopReason 和 success，失败也保留 result，不保存 raw provider payload 或凭据。manifest branches 的 host/status 与实际证据对应；未执行宿主在 notRun 中标明，单宿主通过不能证明另一宿主通过。

当用户要求隐藏本地缓存或实现路径，同时保留公共 CLI 读取能力时，使用 `--mode model --consumer-isolation true`，介绍与 `--consumer-resource RELATIVE_FILE` 分别运行。该分支显式 `$` 选择已有页，不要求 Default Context；每次请求核对完整正文 hash 及一份 CLI XML，工具权限保持开放。资源读取必须成功返回同快照的 `local_snapshot` 内容，hash 与父控预读原件相同；查看 `HOST-consumer-model-observer.jsonl` 和 `HOST-consumer-model-result.json`。详见[真实模型地图](../../verify-context-broker/features/model.md#隐藏实现路径的消费回归)。它不覆盖本页默认 model 的自主发现和 native read，不把路径隐藏解释为文件系统权限隔离。

审阅 manifest、`pi-provider.jsonl`、`omp-provider.jsonl`、对应 rpc 与 decisions；fixture 的 CLI 调用可核对 `source-cli-calls.jsonl`，该文件不作 live 网络证据。执行 `node scripts/verify-notion-integration.mjs evidence --evidence /absolute/evidenceDIR`，审阅后执行 `cleanup --evidence /absolute/evidenceDIR` 并再次 evidence。cleanup 仅将独立 `/tmp` scratch 移到系统 Trash，保留 evidence。各 ID 分别记录 pass/failed/未运行；本文未跑命令。

## AH258–260 shared content acceptance

For a mixed Skill/Router/Prompt submission preserve text/images and retain one prepared snapshot per identity across preflight/task/dispatch. Negative fixtures must reject mismatched scope, full record identity/kind/locator, snapshot/version and entrypoint, unsafe main_path, incomplete inventory and unequal read/export entry bytes. No stale-cache or same-name fallback. Router exports include only their own assets and member metadata; no member-body preparation.

No execution is claimed by this map update; final owner runs and retains the evidence.

