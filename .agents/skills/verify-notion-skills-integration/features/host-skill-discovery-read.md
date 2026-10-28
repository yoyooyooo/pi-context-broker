# 宿主 Skill 发现与读取

前置条件：Pi 与 OMP 的实际原生 extension 可加载，harness 提供可定位的 fixture Skill。metadata、host read、原生 Skill 调用分别审阅；尚未实现或未观察到的宿主路径必须记为 failed/未运行，不能用伪正文替代。

真实端到端使用 `node scripts/verify-notion-integration.mjs doctor --mode live-fixture --database UUID` 与 `node scripts/verify-notion-integration.mjs run --mode live-fixture --database UUID`；创建唯一测试页与 `references/guide.md` 后双宿主消费，finally 仅 archive 自建页及 child pages 并 GET 确认，审阅两个 live-fixture 回执。只读 live 不替代此路径。UI fixture 的原生命令为 `/skill:notion-ui-alpha`，不能以伪正文替代。

| ID | 用户入口与动作 | 可观察 assertion |
| --- | --- | --- |
| NS-HOST-01 | 在 Pi/OMP 请求 Notion 与 filesystem source metadata | Filesystem 与已勾选 `Default Context` 的 Notion 记录由原生宿主发现名称、说明与读取入口；未勾选项仍可显式调用；metadata 与预取完成均不等于正文已加载。 |
| NS-HOST-02 | 经双宿主 read 与 resource 读取目标 | 完整正文和关联资源与各自 source 一致，filesystem 与 Notion 分别留证，不能仅直接调用 CLI。 |
| NS-HOST-03 | 两宿主分别通过 native RPC、print 与 Notion cold print 消费目标 | 实际 provider 收到目标正文；cold native 的参数同时含所选 `$` 引用，仍须完整保留参数且正文只有一份。Pi 另以 Tab、换行分隔参数，逐次核对首词和其余参数均保留。Cold print 独立记录，不由暖 RPC 推断。重名场景两个 qualified native 各读取独立 page body，不用占位 body。 |
| NS-HOST-04 | 使用真实模型 prompt 要求读取目标 Skill 与关联资源 | 实际模型产生 read/resources 行为并消费对应内容；只有提示词提及 URI 或助手声称读过均不满足。 |

目录筛选和后台行为按 [默认上下文与后台预取地图](default-context-prefetch.md) 独立取证。Live/model 原生发现路径的目标页必须在所选 View 中；仅为验收不得修改用户已有页。live-fixture 勾选自建页，并在 finally 归档所属页。后台准备不产生 provider 正文或激活展示记录。

OMP 冷启动不等待 Notion `list` 才显示编辑器或注册 `$` provider。默认目录晚于宿主启动快照发布时，首轮系统提示包含可读取的元数据位置；runner 的目录观察须区分 `host-native` 与 `prompt-metadata`，不能把后者宣称为原生菜单已出现。Pi 保留同步发现；实际菜单由 daily/native UI 路径独立取证。

```bash
node scripts/verify-notion-integration.mjs doctor --mode deterministic
node scripts/verify-notion-integration.mjs run --mode deterministic
node scripts/verify-notion-integration.mjs doctor --mode model --database DB --skill-ref skill://PAGE/SKILL.md --model provider/model --model-prompt TEXT
node scripts/verify-notion-integration.mjs run --mode model --database DB --skill-ref skill://PAGE/SKILL.md --model provider/model --model-prompt TEXT
node scripts/verify-notion-integration.mjs run --mode model --host pi --database DB --skill-ref skill://PAGE/SKILL.md --model magpie/group/flash-free --model-prompt TEXT
node scripts/verify-notion-integration.mjs run --mode model --host omp --database DB --skill-ref skill://PAGE/SKILL.md --model magpie/group/flash-free --model-prompt TEXT
```

deterministic 与 installed 执行这些双 source 路径。审阅 `pi-fs-`/`omp-fs-` 系列、`*-cold-print-provider.jsonl`、`*-duplicates-rpc.json` 及实际 manifest。live-fixture 可加 `--model provider/model --model-prompt TEXT`，同页模型消费后 archive；失败恢复使用 `--resume-evidence /absolute/FAILED_EVIDENCE`，必须通过 ownership/input name、catalog exactname 唯一匹配和 read canary 校验，不能重新 create 冒充恢复。

model 使用当前已有授权与模型配置，不索取 token、不改 CLI 配置。默认执行 Pi 与 OMP；仅 model 可传 `--host pi|omp`，Doctor 按选定宿主检查，未执行宿主记入 `manifest.notRun`。NS-HOST-04 必须逐宿主审阅 `HOST-real-model-observer.jsonl` 与 `HOST-real-model-result.json`（HOST 为 pi 或 omp）：metadata 无正文、模型自主 native read、选定正文与关联资源成功读取、内容进入真实 provider、HTTP 响应成功，以及非空且 stopReason 为 stop 或 length 的成功 assistant final 回复。失败也保留 result。observer 保存 selector、计数、脱敏 source read 结果及 `assistant_final` 的 bytes、textSha256、脱敏 text、stopReason 和 success，不保留 raw provider payload 或凭据。普通确定性路径使用 `pi-rpc.json`、`omp-rpc.json` 与对应 provider/decisions；这些不证明真实模型行为，一个宿主不能代替另一个。

运行后执行 `node scripts/verify-notion-integration.mjs evidence --evidence /absolute/evidenceDIR`。审阅后执行同入口的 `cleanup --evidence /absolute/evidenceDIR`，再执行 evidence；只将 manifest 关联的独立 `/tmp` scratch 移到系统 Trash，不删 evidence。每个 ID 与宿主分别记录 pass/failed/未运行；本文未运行验证。
