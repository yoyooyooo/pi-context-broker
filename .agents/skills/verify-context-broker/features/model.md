# 真实模型指令效果与默认压缩

实际模型应接收 Skill、按其中专属指令回答；重复调用不新增正文，默认摘要器移除正文后再次调用可重新注入。

## Sub-features

- `model-instruction`：请求没有提供输出格式，模型仍按 Skill 的专属格式计算。
- `model-repeat`：重复请求的正文计数保持一份，broker 判断 already-loaded。
- `model-default-compact`：真实默认摘要器运行，`fromExtension: false`，正文 canary 从有效上下文移除。
- `model-reinject`：压缩后再次引用重新注入，模型恢复执行指令。
- `model-selector`：普通与摘要请求实际传输 selector 都属于指定免费模型。
- `model-cli-guidance`：压缩前后每个实际普通模型请求均收到一份默认 CLI XML 指引，正文加载与恢复独立判断。

## How to get to it (user POV)

- 使用 `magpie/group/flash-free` 的 OMP 会话提交 `$model-contract Apply the ledger contract to 17 and 25.`。
- 再提交 6 和 9，添加普通历史，再运行宿主压缩并重新引用处理 30 和 12。

## Driving it with control.mjs

Preconditions:

- 已有该模型的调用授权和可用 OMP 登录，不要求新增/查看/输出 secret。
- Node.js 22.x 中的 22.22.3+，或 24.20.0+、仅用于构建的 Bun、OMP；`control.mjs doctor model` ready。Doctor 不验证认证。
- 本路径继承现有 provider 配置与登录；session/config fixtures 隔离，不更改用户模型。

- **执行。** 运行 `node .agents/skills/verify-context-broker/scripts/control.mjs run model`。脚本真实提交两次 ledger 请求；输出分别应是 `VIOLET-78C4|total=42|checks=boundary,ownership` 与 total=15，格式只存在于注入 Skill。
- **默认压缩。** 添加普通 notes，调用原生 `compact`，观察 `fromExtension: false` 和 `get_messages` 中 canary 为零。之后请求 30 和 12，结果恢复 total=42。
- **传输。** 每个实际普通请求中的正文 canary 与默认 CLI XML 指引都恰好一份；包括摘要的全部 transport selector 仅 `group/flash-free` 或完整 `magpie/group/flash-free`。普通请求与默认摘要器都可能增加调用，不固定历史某次运行的请求次数。
- **证据。** manifest 指向 `broker-real-model-*`：`result.json`、`evidence.jsonl`、`decisions.jsonl`、`sessions`。capture 只含 phase、selector、canary/CLI 指引计数与响应/摘要状态；核对首次 inject、重复 skip、压缩后 inject。RPC teardown 后执行 `control.mjs evidence`。

## Gotchas

- 不改成其他模型来让验收通过；登录/模型不可用要报告当前失败，完成无凭据路径。
- 摘要中保留原指令含义是正常的；此场景只要求全文 canary 不在有效上下文，随后确实重新注入。
- 指令专属输出证明模型在该次请求使用了内容，不证明任意 Skill、任意输入或长期推理正确。
- 本页 `control.mjs model` 仅覆盖 OMP 的通用 Skill 指令与默认摘要器。Pi/OMP 的真实 Notion 读取与资源消费另走[source 地图](source.md)的 integration model；Pi UI 与日常安装也不由本入口推断通过。
- 默认 role 与 compaction 路由可能选择其他模型，现有脚本在 actual fetch boundary 拒绝越界 selector；不要只看启动参数认定调用模型。
- 真实请求不放到无凭据 CI；严禁把 URL、header、token 或个人会话写入 capture。

## Pi print 自主消费与调用链

用户指定 `magpie/group/flash` 等模型时，在该授权范围内独立验证，不改通用 `model` helper 的固定免费模型。使用现有登录、只含本次 Notion source 的自有 broker config、空 cwd、独立 session/cache；保留 `read,bash,grep,find,ls`，观察模型是否自行避免多余调用。

```bash
CONTEXT_BROKER_CONFIG=/absolute/owned/broker.json pi -p --model magpie/group/flash --no-extensions --no-skills --no-context-files --no-mcp --no-prompt-templates --session-dir /absolute/owned/sessions --tools read,bash,grep,find,ls -e /absolute/pi-context-broker/packages/context-broker/src/index.ts '实际消费任务'
```

执行前用当前模型清单确认 selector。需要 Volta/Node 解析时复用 `context-broker-e2e-fixture.mjs` 的 `spawnHost`。重复轮保持同一扩展版本、配置与 session-dir，并加 `--continue`；迭代前后两版 XML 的历史会话不能作为同版去重证据。

- **介绍。** 显式选择真实 `$alias@namespace`，只介绍用途与主要约束。已加载完整正文时直接回答，不重读入口或检查目录、清单、代理元数据。
- **续接。** 沿用同一会话要求压缩为五条步骤，不重新引用。正文继续有效，不新增工具调用；每个实际 provider 请求仍只有一份 CLI XML。
- **资源。** 要求读取已知存在的相对文件，并核对原文字段。应从注入的 `skill-directory` 直接读取目标；不先列目录或搜索 cwd。目录受 pathMode 隐去时走提供的 CLI scope。资源读取与介绍的零工具调用分别验收。
- **自然发现。** 用户给实际用途，不提供 Skill 名或工具步骤。模型使用配置数据库范围检索，空查询可缩短关键词，选中后使用 top-level `content`；需要资源时使用返回的 pinned `ref`/`snapshot_id`，不从 `record` 取正文，不在介绍任务执行仓库准备。
- **普通对话。** 用简单计算等无需 Skill 的任务确认默认指引没有触发目录发现或资源读取。

证据记录实际 provider/model selector、成功响应、每轮工具名/参数/结果与 `ok`/`error`、完整正文身份、CLI XML 计数、最终回答、退出状态和耗时。检查调用链而非只看最终答案；省略 header、URL、secret 与个人会话。真实 source/model 证明与 `injection`/`lifecycle` 的受控 provider 回归分别报告。

### 隐藏实现路径的消费回归

沿用 integration 入口，显式选择已有真实页，不要求勾选 Default Context，也不修改远端页：

```bash
node scripts/verify-notion-integration.mjs run --mode model --consumer-isolation true --database DB --skill-ref skill://PAGE/SKILL.md --model AUTHORIZED_PROVIDER/MODEL --model-prompt '介绍这个 skill 的用途和主要约束。'
node scripts/verify-notion-integration.mjs run --mode model --consumer-isolation true --consumer-resource references/guide.md --database DB --skill-ref skill://PAGE/SKILL.md --model AUTHORIZED_PROVIDER/MODEL --model-prompt '读取附带的 references/guide.md，摘录核心步骤。'
```

默认执行 Pi 与 OMP，可用 `--host pi|omp` 限定。CLI 必须是 PATH 上的 `ntn-skills`，使用当前安装或开发 shim；命令参数不含源码入口。父控按完整目录生成含去歧义 ID 的精确 `$` 选择器。宿主 cwd 是仓库外空目录，session、Broker 和 CLI 各根独立；保留 `read`、`bash` 和搜索工具，清理指向实现仓库的继承环境变量，采用 `pathMode: hash`。仍原位复用 HOME 登录，因此只证明上下文隔离，不是文件系统沙箱。controller 的 CLI preflight 每步最多 180 秒；CLI 自身仍按每次网络尝试计时。

上游托管页还须显式传 `--upstream-database UUID`。runner 仅在 owned CLI 配置中登记这个已知订阅库 ID，再由正常读取路径验证；不执行远端 init、不复制用户配置或凭据。遗漏绑定导致的 `UPSTREAM_NOT_CONFIGURED` 是启动前失败，不算模型行为失败。

资源路径必须实际存在于该页导出的固定快照；runner 在启动宿主前验证相对路径并读取预期 hash。保留用户的禁止永久删除规则，通过追加 system prompt 传给隔离宿主。OMP 的长行 CLI JSON 可能需要由模型继续 `read artifact://…:raw`；observer 只将本次 CLI 输出产生的 artifact 归入该调用链，既核对返回的逻辑路径、快照和原件 hash，也要求完整资源内容进入后续实际 provider 请求。

逐宿主检查 `HOST-consumer-model-observer.jsonl`、`HOST-consumer-model-result.json`：实际指定模型与成功响应、每次请求的一份 CLI XML、完整正文 hash 恰好一份，以及 provider 数据、工具交互和回答中未暴露实现或缓存路径。介绍必须零工具调用；资源任务必须由模型通过 `bash` 调用公共 CLI，成功结果为 `source: local_snapshot`，快照身份及内容 hash 与父控预读原件一致。工具探查会在事后使验收失败，不通过拦截工具制造通过。保留脱敏参数、结构化结果字段与最终回答，不保存 raw provider payload、header 或凭据。该分支不替代自然发现、续接、原生 UI 或独立安装验收。

## AH258–260 shared content acceptance

Run real magpie/group/e2e separately in Pi and OMP: repeat one Prompt with different materials and verify both task results. Provider capture must prove each current user task contains full Prompt requirements. Cold Router selection must omit all member bodies until explicit exact-ref read. Record controlled provider separately from real-model/UI/service proof.

No execution is claimed by this map update; final owner runs and retains the evidence.

