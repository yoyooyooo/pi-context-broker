# Skill 消费链：验证地图与证据合同

归属 [AH-617](https://linear.app/yoyooyooo/issue/AH-617)。本页维护 SC01–24 的执行导航，机器索引在 [skill-consumption-scenarios.json](../../../../scripts/skill-consumption-scenarios.json)。规程状态与产品结果分开：未执行的路线为 draft，样本为 not_run；不能从本文存在推断产品已通过。

## Sub-features

- SC-VERIFY-01：24 项任务、21 条必跑用户旅程及缓存×会话×入口×intent 的完整组合索引。
- SC-VERIFY-02：复用原图验收反例，补观察缺失、投影/源混淆、假投递和失败证据丢失反例。
- SC-VERIFY-03：从真实 Pi 入口运行、核对原始记录、清理自有 scratch 后再次验证证据；独立新会话按同一规程重跑。

相关材料：[原图合同](skill-dependency-graph.md)、[请求账本](request-engine.md)、[会话恢复](session-cache-recovery.md)、[正常安装](installed-consumption.md)。CLI 的对应入口为 notion-skills-cli 仓库中的 `.cursor/skills/verify-ntn-skills/features/skill-consumption.md`。

## How to get to it (user POV)

普通消息、`$name@notion`、原生 `/skill:`、模型自主 search、inspect/use、read 资源与直接 CLI 是不同入口。检查目标内容不激活工作流；use 必须准备 Requires，Members 仅是候选。以下每一行都需保留自己的结果，不能用方便的入口替代。

| 任务 | Issue | 用户入口 | 已有驱动及尚需补齐的证明 |
| --- | --- | --- | --- |
| SC01 | AH-618 | 验证规程 | 本页完整流程；反例及清理后证据 |
| SC02 | AH-619 | 全部消费入口 | [只观察的成本规程](skill-consumption-cost.md)；真实模型、source 初态与单资源基线，旧 graph observer 不作为纯观察器 |
| SC03 | AH-620 | CLI、SDK、Pi | CLI core 的 version 1 consume 合同与等价证明已提交；独立 SDK 打包和 Broker 迁移继续归 SC10 |
| SC04 | AH-621 | 短引用、原生 read | integration / graph；另补分支固定短引用与错 scope |
| SC05 | AH-622 | provider 输入 | graph observer；另补已冻结编译器和源/投影双 hash |
| SC06 | AH-623 | 目录、search、自然任务 | view-discovery / model；另补两种目录的真实选路比较 |
| SC07 | AH-626 | inspect、use、资源 | installed --skill-graph true；另补一次目标消费和批读 |
| SC08 | AH-627 | 重复、resume、压缩 | integration / lifecycle；另补 active 与当前 visible 的区分 |
| SC09 | AH-624 | 普通消息、显式选择 | integration / Pi PTY；另补目录未完成时的首次 provider 顺序 |
| SC10 | AH-625 | SDK、公开 CLI | installed 图入口；另补独立 SDK 与单次返回 |
| SC11 | AH-628 | 目录、依赖选择 | CLI control / request-engine；另补需求范围与字段字节 |
| SC12 | AH-629 | 暖、过期、clear | session-cache-recovery；另补五层缓存和权限期限 |
| SC13 | AH-630 | 单资源、export | CLI control / integration；另补先归属后物化 |
| SC14 | AH-631 | 过期 Records | CLI request_metrics；另补事实计划复用与Payload归因 |
| SC15 | AH-632 | 并发、取消、崩溃 | request-engine / cache-concurrency；另补跨进程只读 owner 终局 |
| SC16 | AH-633 | 历史重算 | shared SSOT CLI；另补 checkpoint 与冲突/unknown |
| SC17 | AH-634 | 附件存取 | CLI真实服务；另补附件账本、过期与unknown上传 |
| SC18 | AH-635 | 固定来源、旧pin | CLI / installed / mini；另补文件级迁移与回滚 |
| SC19 | AH-636 | poteto任务 | graph model A/B；内容规则去向需独立审阅 |
| SC20 | AH-638 | 完整矩阵 | 本页机器矩阵及各功能harness；全样本保留 |
| SC21 | AH-639 | A/B/C/D真实Agent | graph model / integration model；新投影合同冻结后执行 |
| SC22 | AH-637 | 独立npm、pro/mini | installed / Pi PTY；双机各自新包证据 |
| SC23 | AH-640 | 所有受影响调用者 | CLI / package / integration；迁移清单与回滚实驱 |
| SC24 | AH-641 | 正常日用Pi | verify-pi-daily-installation；实际安装与新会话证据 |

上述未来功能的完整规程仍为 draft。SC01 只验证地图、证据反例与下方既有 Pi 路径；后续任务补齐对应驱动后更新状态。不得把矩阵项标 passed 来消除 blocker。

### 必跑用户旅程

| ID | 动作 | 主要断言 |
| --- | --- | --- |
| J01 | 全冷普通消息，目录延迟/失败 | provider先于目录完成；正文读取0 |
| J02 | 暖目录普通消息 | 仅轻量发现；后台成本独立计 |
| J03 | 暖缓存新会话显式激活 | 策略允许时远端0；根/Requires各一份 |
| J04 | 全冷根与共享Requires | 只读所选闭包；Members正文0 |
| J05 | 用户原句介绍目标 | 准确介绍；不执行工作流、不写仓库 |
| J06 | 无美元但明确名字 | 一次检查；歧义返回候选 |
| J07 | 无美元且无叶子名 | 自主选能力并完成任务 |
| J08 | 仅Router根 | 自主选择叶子和必要资源 |
| J09 | 仅poteto根 | Requires准备；Members由模型选择 |
| J10 | 重复美元与随后普通消息 | 版本不变；当前provider正文一份 |
| J11 | 远端A→B与refresh失败/成功 | 失败保留旧绑定；成功不混版本 |
| J12 | resume/fork/rewind/压缩 | 固定引用不漂移；丢失正文后恢复 |
| J13 | 过期未变 | 元数据复验；正文重下0、写回0 |
| J14 | N文件中k变化或仅属性/关系变化 | 只补受影响内容和证明 |
| J15 | 单资源缺失及custom覆盖大来源 | 完整清单下按需字节；export单独完整 |
| J16 | 空pro/mini恢复旧pin | 自身认证；固定文件准确，无当前回退 |
| J17 | 并发、取消、崩溃、clear | 有界只读合并；不串scope、不迟到发布 |
| J18 | 坏hash、错File/scope、权限及分页错 | 显式失败；无partial成功投递 |
| J19 | 附件轮换、过期、断流、unknown | 稳定内容身份；原操作核对 |
| J20 | 旧检查点、同mtime、冲突、未决操作 | 不能遮蔽事实；完整重算计成本 |
| J21 | 正常日用新Pi与资源续读 | 自动加载新包；非目标配置保持 |

### 完整组合与合法不适用项

`coverage` 实际输出 5 种缓存 × 7 种会话 × 8 种入口 × 4 种 intent，共 1,120 个元组。缓存为 cold、warm、expired-unchanged、expired-changed、partial；会话为 new、existing、restart、resume、fork、rewind、compacted；入口为 ordinary、dollar、native、search、prepare、read、cli、sdk；intent 为 none、discover、inspect、use。

每个元组默认 not_run。只允许以下不适用理由：none 没有显式 Skill 入口；search 只发现候选；普通自然任务的 inspect/use 记在后续实际工具入口；显式美元/native 为 use；直接 CLI/SDK 没有 Pi 会话生命周期，绑定由宿主调用路径验证。所有不适用元组均附理由。

激活/刷新/权限/压缩/取消的高风险组合逐项运行，其他组合可在 SC02 开跑前冻结覆盖策略。未执行元组不得被 pairwise 覆盖自动提升为 passed。缓存五层分别记录初态，不能只清 Broker 目录便称全冷；保持真实机器级调度，不能清空用户缓存。

## Driving it with existing harnesses

### Launch

从 Broker checkout 根目录运行。已有依赖与构建可用时不重复安装。只有缺构建时才按主 Skill 的 Pi 单宿主方法，先构建 CLI，再设置 `NTN_SKILLS_BUILD_ENTRY` 运行 `bun run build:broker`。不要使用全目标 build 改写既有 Tern 产物。

先建立工作树保护基线。保留别人已暂存的文件，按明确文件提交本次改动；不 reset、clean 或批量 restore。私有证据放在 checkout 外。

### Doctor

以下命令全部离线，不创建生产数据、不调用模型：

```bash
node scripts/skill-consumption-contract.mjs --help
node scripts/skill-consumption-contract.mjs check-map
node scripts/skill-consumption-contract.mjs self-test
node scripts/verify-notion-integration.mjs --help
node scripts/verify-notion-integration.mjs doctor --mode deterministic --host pi
```

最后一条会保留 owned probe scratch，输出真实 Node/Pi 版本、扩展路径/hash。它不认证、不访问 Notion；status=ready 只证明前置可用。缺前置记 blocked，不能换另一宿主或跳过后写 pass。审阅完该次 Doctor 后只把输出的 probe scratch 移到系统回收站。

### Drive：SC01 的完整既有用户路径

以下路径无需生产 Notion 或真实模型授权。它实际启动 Pi 和 Broker，驱动原生 read、显式选择、资源、失败与持久会话；source 与 provider 明确为受控 fixture。它不证明真实模型能力或新的低延迟目标。

```bash
SC_PARENT="$(mktemp -d /private/tmp/skill-consumption-evidence-XXXXXX)"
node scripts/verify-notion-integration.mjs run --mode deterministic --host pi --evidence-root "$SC_PARENT"
SC_EVIDENCE="$(python3 - "$SC_PARENT" <<'PY'
from pathlib import Path
import sys
runs = list(Path(sys.argv[1]).glob('broker-notion-evidence-*'))
assert len(runs) == 1, 'Use exactly the directory reported by this run'
print(runs[0])
PY
)"
node scripts/verify-notion-integration.mjs evidence --evidence "$SC_EVIDENCE"
```

失败也保留 `SC_PARENT` 与本次输出路径，先检查 manifest 和 stderr；不能重试覆盖旧样本。driver 失败可能早于后续命令，恢复时从本次真实路径开始，不能重造 pass 回执。输出有 functionalStatus、missing 及执行分支；只检查目录存在不够。

### Evidence

审阅 `manifest.json` 中实际 selectedHosts、branches、notRun、scratch、extension、doctor、失败阶段。然后核对本次真实文件清单中的 Pi provider/RPC、source CLI 调用与 owned-processes spawn/close。OMP 未选即 not_run。不要要求未执行宿主产生证据。

先保存所有既有证据文件的 SHA-256 清单，随后 cleanup，再逐文件复查。清单放在 SC_PARENT，避免把它自身纳入：

```bash
python3 - "$SC_EVIDENCE" "$SC_PARENT/retained-before.json" <<'PY'
from pathlib import Path
import hashlib, json, sys
root = Path(sys.argv[1])
rows = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in root.rglob('*') if p.is_file()}
assert rows and 'manifest.json' in rows
Path(sys.argv[2]).write_text(json.dumps(rows, indent=2) + '\n')
PY
```

真实服务、真实模型、PTY、独立安装和双机分别使用原地图入口。不能给 controlled provider 的结果贴 real_model 标签。新版最小投影合同尚未冻结时，原 A/B 完整正文规则保持；`evaluate` 只接受 `source-identity/v1`，不把任意摘要当作合法投影。

### Cleanup

先确认 run 已结束、所有本次宿主都有 close 证据、没有待核对的 unknown mutation。以下 helper 仅回收本次关联 scratch，不删除证据：

```bash
node scripts/verify-notion-integration.mjs cleanup --evidence "$SC_EVIDENCE"
node scripts/verify-notion-integration.mjs evidence --evidence "$SC_EVIDENCE"
python3 - "$SC_EVIDENCE" "$SC_PARENT/retained-before.json" <<'PY'
from pathlib import Path
import hashlib, json, sys
root = Path(sys.argv[1])
for name, expected in json.loads(Path(sys.argv[2]).read_text()).items():
    path = root / name
    assert path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == expected, name
print('All original evidence bytes retained after cleanup.')
PY
```

cleanup 新增自己的回执不影响原文件比对。若原文件改变，保留失败现场并修复规程，不能排除该文件掩盖错误。禁止按进程名称 kill、永久删除或触碰他人会话。真实网络、真实模型是否运行要单列；此次完整路径的两者均为 not_run。

## Gotchas

宿主目录中的临时 location 只属于当前进程。多次 stop/start 后，资源相对路径必须从当前实际 provider 目录重新取得，不能沿用第一个进程的位置。当前按需消费可以使用 prepare、固定主文 read 和所选资源 read，无需整包 export；验收必须核对实际固定内容与资源回执，不能把发生过 export 当成成功的必要条件。失败分支的 source CLI 账本也必须在 scratch 回收前保留。

### 各种状态需要不同证据

- CatalogEntry/known：观察到候选的身份与目录元数据，不证明正文缓存或使用。
- SelectedBinding：明确 scope、身份和版本；短引用本身不授权。
- cached：验证过的源字节；materialized：实际路径和字节；两者都不证明投递。
- SourceBody：源 bytes/hash。ModelProjection：绑定源 hash、关系摘要、编译器版本及投影 bytes/hash；raw/export 保持源语义。
- delivered：本次实际 provider 输入的完整 span，而非 loaded 日志、hash、摘要或历史回执。当前输入同身份/版本完整正文至多一份。
- active：会话已启用的规则；压缩后正文不在输入中时需从固定版本恢复。inspect 不自动产生 active。

### 证据反例

`self-test` 复用旧 graph 反例并加入截断/丢失 HTTP、漏附件账本、观察器异常、未见进程 close、错 scope/hash、只缓存未投递、只剩摘要、完整正文重复、oracle 预暖、隐藏副本、强制工具参数和失败样本/cleanup 证据丢失。它返回 evidence-contract-valid 或自检 passed，产品通过字段永远是 not-inferred。

该合同验证器只检查规范化观察，不能证明输入是未经伪造的原件。真实结论还需实际 driver、原始 artifacts、哈希及人审。新编译器和 SDK 的生产协议由 SC03 定义，不把此脚本当成运行时接口。

### 成本与证明层

Notion metadata/current-body/retained-body/write、附件与模型 HTTP 分开；attempt、重试、队列、预取、SDK/CLI启动均计入。无观察器、trace 截断、scope 未知不能写0。解码 JSON bytes 不等于压缩后 wire bytes；未知保留 null/unknown。只减少首轮文本但增加工具轮次不能称总成本降低。

原图 observer 会约束工具和任务文件，不能直接冒充 SC02 的纯成本 observer。[成本规程](skill-consumption-cost.md) 使用被动 provider hooks、Undici diagnostics 与 source request_metrics，保持工具和输入不变；失败与未知值不参与有效改善结论。

每次报告 passed、failed、blocked、not_run、not_applicable；后者必须有理由。失败不会因 cleanup 成功变为 passed，历史 Gate 也不能代替新包。规程本身由独立新会话读取后执行同一路径，提交该会话的真实命令与清理后证据，才完成 SC-VERIFY-03。
