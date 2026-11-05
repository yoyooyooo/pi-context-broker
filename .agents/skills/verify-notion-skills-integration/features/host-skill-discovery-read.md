# 宿主 Skill 发现与读取

前置条件：Pi 与 OMP 的实际原生 extension 可加载，harness 提供可定位的 fixture Skill。`SKILL_REF` 从实际 CLI 的完整 `record.ref` 取得，共享逻辑 ref 不替换为物理 page UUID。metadata、host read、原生 Skill 调用分别审阅；尚未实现或未观察到的宿主路径必须记为 failed/未运行，不能用伪正文替代。

真实端到端使用 `node scripts/verify-notion-integration.mjs doctor --mode live-fixture --database UUID` 与 `node scripts/verify-notion-integration.mjs run --mode live-fixture --database UUID`；创建唯一测试页与 `references/guide.md` 后双宿主消费，finally 仅 archive 自建页及 child pages 并 GET 确认，审阅两个 live-fixture 回执。只读 live 不替代此路径。UI fixture 的原生命令为 `/skill:notion-ui-alpha`，不能以伪正文替代。

| ID | 用户入口与动作 | 可观察 assertion |
| --- | --- | --- |
| NS-HOST-01 | 在 Pi/OMP 请求 Notion 与 filesystem source metadata | Filesystem 与当前 View 中的 Notion Skill/Router 由宿主发现名称、说明与读取入口；View 外的可消费记录仍可显式调用；metadata 与预取完成均不等于正文已加载。 |
| NS-HOST-02 | 经双宿主 read 与 resource 读取目标 | 完整正文和关联资源与各自 source 一致，filesystem 与 Notion 分别留证，不能仅直接调用 CLI。 |
| NS-HOST-03 | 两宿主分别通过 native RPC、print 与 Notion cold print 消费目标 | 实际 provider 收到目标正文；cold native 的参数同时含所选 `$` 引用，仍须完整保留参数且正文只有一份。Pi 另以 Tab、换行分隔参数，逐次核对首词和其余参数均保留。Cold print 独立记录，不由暖 RPC 推断。重名场景两个 qualified native 各读取独立 page body，不用占位 body。 |
| NS-HOST-04 | 使用真实模型 prompt 要求读取目标 Skill 与关联资源 | 实际模型产生 read/resources 行为并消费对应内容；只有提示词提及 URI 或助手声称读过均不满足。 |

目录筛选和后台行为按 [默认上下文与后台预取地图](default-context-prefetch.md) 独立取证。Live/model 原生发现路径的目标页必须在所选 View 中；仅为验收不得修改用户已有页。live-fixture 勾选自建页，并在 finally 归档所属页。后台准备不产生 provider 正文或激活展示记录。

OMP 与 Pi 冷启动均不等待 Notion `list` 才显示编辑器。默认目录晚于宿主启动快照发布时，runner 的目录观察须区分 `host-native` 与 `prompt-metadata`，不能把后者宣称为原生菜单已出现。Pi 的普通首轮允许 pending；本 ordinary custom-command driver 通过显式 `/context-broker refresh` 取得零 provider 的完成边界后，才检查 ready 目录。正常非阻塞默认 SDK 路径另由 `notion-sdk-pi.mjs --scenario default-view` 观察首轮 pending 与下一普通 turn，不能用 refresh 结果替代其启动成本。

## SC23：迁移 custom-command 的目录与固定引用

Pi 的 Notion 模型目录按真实作者 `record.name`、明确 `<source>` 和实际返回的 `sr:C` 匹配；内部 `/skill:` 仍使用唯一 namespace/alias 命令 token。解析 XML 时只解码一次实体，同名不同 source 或不同 handle 都保留，不能按显示名称去重。OMP 与 filesystem source 仍按其各自已有入口检验。

普通 read 从当前 provider 目录复制入口；资源读取从选中正文实际投影的 `<resources>` 复制 `sr:R`，不把短引用交给 dirname/join，也不重用已经退出的进程的入口。重名负例必须同时观察真实 ambiguous 边界和零 provider 增量；Pi 将拒绝表现为 assistant aborted 时保留该终局，再继续独立的 qualified native 正例，不把异常直接当成通过。

live 的固定 canonical ref 可含编码后的稳定 owner、snapshot 和 File ID。metadata 选择匹配精确 stable ID／locator；名称或 alias 必须唯一。原 ref 完整传给 public read，由 CLI 校验固定版本，driver 不改写成 current。原 CLI 请求账本同时识别 `use` 与 `ctl prepare`，为机器测量明确传 `--json --metrics`；raw 输出不被改写。fixture 子进程次数不能冒充真实 HTTP attempts。

先运行 `node --test scripts/notion-integration-hosts.test.mjs scripts/skill-consumption-source-observer.test.mjs scripts/skill-consumption-startup.test.mjs`，再用 `run --mode installed --host pi --package ABSOLUTE_TGZ --evidence-root ABSOLUTE_EVIDENCE_PARENT` 验独立安装；已有逐文件验证的同一安装也可通过 ordinary `run --mode deterministic --host pi --extension ABSOLUTE_INSTALLED_ENTRY` 复跑。按实际 manifest 分别记录宿主版本、archive／entry identity、Notion custom-command 与 filesystem 两分支、metadata／read／native RPC／cold print／continue、资源及拒绝结果。

2026-11-05，`85888eeda4683ba53c79b84640839220a4162d8902a8ed321d30ba9fd4e42d3e` 候选的旧 ordinary driver 在真实 Pi 1.4 独立安装中报 `Default host catalog must advertise the remote alias`；实际 provider 已显示 `UI Alpha`、`source=notion` 与 `sr:C`。原件位于 `~/Library/Logs/pi-context-broker/AH-617-20261105/sc23-custom-z5l5yxy3/broker-notion-evidence-kGmIsU/`。新增 parser 断言的 fail-before SHA256 为 `c83b1e69ac6dac7dc3e070e16d36f105f0a475de3ba4627b828a210be2bed103`；它还揭示旧 parser 合并同名不同入口、未解码 XML 的问题。修复目录后，首轮新 run 实际走到 ambiguous 拒绝，但旧 oracle 未捕获原生 aborted，仍按失败保留于 `after-pi14/`。

修复后的原命令已在 Pi 1.4 独立 fresh install（`after-pi14-v2/broker-notion-evidence-ZY2iDF`）和 Pi 1.5 同一已验独立安装（`after-pi15/broker-notion-evidence-iRx29c`）分别通过 Notion custom-command 与 filesystem 两分支。两版均实际完成 read、资源短引用、cold native RPC／print、美元与 native 双向重复、参数保留、continue、三类 source 拒绝和重名拒绝／精确选择；未以 warm 结果替代 cold print。每个运行清理前的 86 个发布文件与同一 archive 逐字节一致。64 项原定向测试通过，日志 SHA256 `36aeb9f55bd070b3720257bc9addf34bd9ab92f9376ccd3bf9198df6f550a287`。四个成功／失败运行均完成原 Evidence → Cleanup → Evidence；49 个原件 hash 未变，receipt `cleanup.json` SHA256 `30cbe6652539b51eb9bf5fba8a37b1c60ceee3811d7339a133d2b3386a6811f6`。

此 ordinary 兼容路径使用受控 CLI 与 provider，支持 custom command，不证明默认 SDK、真实 Notion或真实模型。旧 `--default-context true` 专用预取分支仍需独立迁移／验收，不能用本路径成功或 SDK all14 给它补记通过。所有 run 均先 evidence、再仅清理 manifest-owned scratch、再 evidence，并核原件 hash。

```bash
node scripts/verify-notion-integration.mjs doctor --mode deterministic
node scripts/verify-notion-integration.mjs run --mode deterministic
node scripts/verify-notion-integration.mjs doctor --mode model --database DB --skill-ref "$SKILL_REF" --model provider/model --model-prompt TEXT
node scripts/verify-notion-integration.mjs run --mode model --database DB --skill-ref "$SKILL_REF" --model provider/model --model-prompt TEXT
node scripts/verify-notion-integration.mjs run --mode model --host pi --database DB --skill-ref "$SKILL_REF" --model magpie/group/flash-free --model-prompt TEXT
node scripts/verify-notion-integration.mjs run --mode model --host omp --database DB --skill-ref "$SKILL_REF" --model magpie/group/flash-free --model-prompt TEXT
```

deterministic 与 installed 执行这些双 source 路径。审阅 `pi-fs-`/`omp-fs-` 系列、`*-cold-print-provider.jsonl`、`*-duplicates-rpc.json` 及实际 manifest。live-fixture 可加 `--model provider/model --model-prompt TEXT`，同页模型消费后 archive；失败恢复使用 `--resume-evidence /absolute/FAILED_EVIDENCE`，必须通过 ownership/input name、catalog exactname 唯一匹配和 read canary 校验，不能重新 create 冒充恢复。

model 使用当前已有授权与模型配置，不索取 token、不改 CLI 配置。默认执行 Pi 与 OMP；仅 model 可传 `--host pi|omp`，Doctor 按选定宿主检查，未执行宿主记入 `manifest.notRun`。NS-HOST-04 必须逐宿主审阅 `HOST-real-model-observer.jsonl` 与 `HOST-real-model-result.json`（HOST 为 pi 或 omp）：metadata 无正文、模型自主 native read、选定正文与关联资源成功读取、内容进入真实 provider、HTTP 响应成功，以及非空且 stopReason 为 stop 或 length 的成功 assistant final 回复。失败也保留 result。observer 保存 selector、计数、脱敏 source read 结果及 `assistant_final` 的 bytes、textSha256、脱敏 text、stopReason 和 success，不保留 raw provider payload 或凭据。普通确定性路径使用 `pi-rpc.json`、`omp-rpc.json` 与对应 provider/decisions；这些不证明真实模型行为，一个宿主不能代替另一个。

## OMP 冷读取与命令预算

OMP 18.14.2 的 `tool_call` active-work 默认预算为 30 秒，合同来源为[该版本 runner](https://github.com/can1357/oh-my-pi/blob/7efd77219374ca4e8767979809835e4aa90666ba/packages/coding-agent/src/extensibility/extensions/runner.ts)。Broker 的 25 秒短 hook 保护不能承担完整冷读取。适配器通过同名 `read` 的公开注册入口，在 execute 阶段准备并校验固定快照，再用 `ctx.invokeTool` 调用原生 read；注册命令也在命令执行阶段等待队列与正文。fallback hook 仍保留有限预算，source 自身超时、取消与会话代际边界继续生效。不得提高用户全局设置、提前预热或放宽正文断言来通过冷读取。

先在现有入口核对受控回归，再以实际安装的候选执行标准 live 与 [native-kinds](session-cache-recovery.md#native-kinds-rpc)：

```bash
bun packages/context-broker/scripts/input-guard.test.ts
bun run --cwd packages/context-broker typecheck
node scripts/verify-notion-integration.mjs run --mode live --database DB --skill-ref "$SKILL_REF" --extension /absolute/installed/broker/index.ts --command-json '["/absolute/node","/absolute/installed/ntn-skills.js"]' --evidence-root /absolute/evidence
```

`input-guard.test.ts` 用较短的受控 hook 预算验证长 prepare 成功后只委托一次原生 read、注册命令只派发一次、abort/切会话后迟到完成不能委托，以及 fallback hook 超时仍取消 source。另核对原生动态说明、依目标变化的 approval、当前 cwd 的 approval cache targets、禁用/第三方 read 的边界；普通 read 的参数、图片、progress 与结果继续由原生工具提供。这些受控图片结果不表示已运行真实 RPC 附件提交。

AH-498 旧候选在 Pi 1.4.0 的标准 live 冷读完成约 34.5 秒；OMP 18.14.2 同路径在约 25 秒返回 `SOURCE_ACTIVATION_TIMEOUT`，完整正文断言失败。该失败和原始 source/RPC/provider/进程退出证据保留。execute/command 预算修复后的候选必须另存新的标准 live 与 native-kinds 结果；旧 Pi 通过、代码检查通过及本文更新均不证明新候选 OMP 通过。

运行后执行 `node scripts/verify-notion-integration.mjs evidence --evidence /absolute/evidenceDIR`。审阅后执行同入口的 `cleanup --evidence /absolute/evidenceDIR`，再执行 evidence；只将 manifest 关联的独立 `/tmp` scratch 移到系统 Trash，不删 evidence。每个 ID 与宿主分别记录 pass/failed/未运行；本文未运行验证。
