# Pi 消费指引：按工具能力呈现与显式 CLI 范围

归属 [AH-617](https://linear.app/yoyooyooo/issue/AH-617) 的 [SC05 / AH-622](https://linear.app/yoyooyooo/issue/AH-622)。本切片承接 [SDK、短引用与会话运行时记录](skill-consumption-runtime.md)，处理模型指引与实际工具能力不一致的问题。它不宣称完整 context compiler、批量资源读取或 SC21 四条正式 Agent 路线已经完成。

后续 `skill_prepare` 的正文、模型投影与机器证明分离见 [prepare 投影记录](skill-consumption-projection.md)；本文保留本轮原包和原样本的历史结论。

## 已有失败揭示的输入问题

原 `sc10-model/skill-model-cost-7gd44M` 使用真实 Notion、默认 SDK 与 `magpie/group/flash-free`，原句为：

> 请介绍 $ntn-skills-maintain@notion 的用途和健康检查入口，只解释，不执行。

三个实际 provider 请求均包含同一份完整 16,288 B 源正文一次。原指引已经要求介绍时不执行工作流，但同时无条件给出本机 Node 路径、随包 CLI 路径及整套 shell 参数数组。模型实际第一条 `ls` 探测使用了其中的 Node 路径。这是可核对的输入关联，不能据此断言它是全部回答错误的唯一原因。

所选源正文自身保留了旧 `ntn` / `ntn login` 前提，并把 `ntn-skills ctl doctor` 用于连接诊断。介绍源版本和介绍当前安装能力必须分开判断：不能将作者原文中的旧前提一概称为模型幻觉，也不能由 context compiler 静默替换正文。原 run 的额外环境探测、健康入口概念混淆及不完整费用账本继续保留。

## 本切片的合同

Pi 从公开 active-tool API 得到当前能力，为可用的发现、检查、启用、原生读取和证明导出分别提供简短说明。完整原生消费路径不附带 shell argv 模板。只有对应原生操作缺失且 `bash` 实际启用时，才显示该操作的带来源 CLI 后备入口；不会因指引需要某个工具而启用它。

CLI 后备不接受会话 `sr:` 句柄。仅有 `skill_search` 和 `bash`、没有原生 read/prepare 的组合，也提供带来源 CLI list，先按确切 record 身份取得同一候选的 canonical 引用；已有固定 snapshot/path 可直接沿公开 CLI 合同使用。该边界在 package-05 审阅后补齐，旧包和其首轮验收失败保留。

真实维护任务通过已有 `skill_graph` 的显式参数取得调用信息：

```json
{"cli_source":"SOURCE_ID"}
```

响应为：

```text
{kind: "host_cli_scope", sourceId, command: string[], database?, executed: false}
```

该请求与 `refs` 互斥，要求 `bash` 与 `skill_graph` 均启用，并只接受当前配置中一个确切、未禁用的 Notion source ID。它复用实际宿主 CLI resolver，不猜全局安装或第一个 source，不访问网络、不执行命令，也不证明执行权限或连通性。默认 graph / `refs` 仍是没有机器路径的可移植证明；显式返回的 invocation metadata 标明属于当前宿主。

能力变化时只替换 provider 投影中的 owned guidance，不改历史 JSONL、用户示例或源正文。Pi 1.4 的公开 `context_with_system` handler 在 conversation context handlers 完成后再次核对当时工具列表，并保留原 leading system；它不控制其他扩展在其后执行的同类 handler。已加载正文的近端提示明确区分“内容可用”和“用户授权执行”；路径隐藏时仍能通过原生固定引用读取资源。美元入口原有 `use` 与 active 语义不靠自然语言关键词改写。

OMP 与没有公开工具能力 API 的宿主保留原有兼容指引。作者正文、raw/export、SDK 校验与固定版本合同保持各自原语义；本切片不进行摘要或删除作者内容。

## 未识别子进程的观测边界

旧观察器遇到非 bundled-CLI 子进程时只写 `unmatched_child_start`，随后不再订阅其生命周期。因此 `7gd44M` 的两条 bash 只有启动线索，不能从 tool result 或 PID 消失补造 close。旧 run 与 incomplete 状态不回填、不改判。

新观察将未识别子进程与 source CLI/SDK 分开记录，并保留直接 child 的稳定身份及实际生命周期。直接 child 的退出不证明其后代网络已完整观察，也不能产生 HTTP=0 或完整费用结论。验证须分别覆盖自然完成、启动失败、取消和缺终局，保持费用未知字段为 null。

## 冻结与验证方法

本切片私有证据根：`/Users/yoyo/Library/Logs/ntn-skills/AH-617-20261104/throughput-zqzp5es9/sc05-guidance-aAjLOK`。

先验证能力与来源反例，再对独立 npm/tar 产物运行实际 Pi 的美元、主文/资源、search→prepare 以及显式 source command metadata 场景。受控 provider 只证明工具与投递合同，不证明真实模型语义；实际结果分别记录如下。

唯一一次真实模型有限回归保持原句、原模型、原工具集及 1 cold + 1 warm。原始正文已完整投递时，介绍不需要环境探测；答案需准确说明所选源版本的用途与 doctor 连接诊断入口。机器子串谓词与独立语义审阅分别记录；所有模型请求、工具、费用及失败保留，不重跑以替换不准确的答案。

## 独立安装与受控 Pi 结果

| 冻结项 | 身份与范围 |
| --- | --- |
| package-05 | SHA256 `4ebb2bb6d6ba9a1e47aab1187ecb0c556aed89bc35ea983964823c5e130988be`；首轮验证器失败保留，真实模型未运行 |
| package-06 | SHA256 `0c839d2f93ac69bbe328e3ce607a9b4f8599232be5e49a337d2712c5197cf713`；独立 npm 安装的 72 个文件逐字匹配打包源，53 个 src/dist 文件受控运行前后不变 |
| SDK / CLI | 沿用前轮冻结 `ntn-skills-0.1.0.tgz`；06 与 04/05 的 CLI、SDK 和 runtime manifest 字节一致 |
| Pi driver | SHA256 `821bf35bffe3af7158d9cce38e5cef98262d2644213694742b8ae4fd96cf3af6` |
| 环境 | Node 24.20.0、Pi 1.4.0；Bun 1.4.3 仅用于构建和单元验证 |

最终消费专项 **89/89，667 条断言**、类型检查和验证规程 **140/140** 通过。新增能力指引测试覆盖原生能力缺失、已知空工具集、OMP/未知能力兼容、动态投影、来源歧义/禁用、`refs` 互斥与正文 Unicode/BOM/CRLF 保真。未知 child 观察器的目标测试 **43/43** 通过，包含真实 Node/bash、未处理 error、AbortSignal、exit 后后代仍持有 stdio、缺失/重复/错 PID 终局和旧账本兼容。

`pi-installed-06` 的真实 Pi + 受控离线 source/provider 四场景 **4/4** 通过：

| 场景 | provider 请求 | 实际消费 | 关键结果 |
| --- | ---: | --- | --- |
| `$` | 3 | 1 SDK consume | 所选根与 Required 完整正文各一份 |
| 原生主文/资源 | 4 | 1 consume + 1 read | 主文检查不激活 Required；二进制字节、owner、File、snapshot 匹配 |
| search→prepare | 3 | 1 consume | 三根与共享 Required 一次准备、每份完整正文一次 |
| 显式 CLI scope | 2 | 0 SDK | 第一请求无 CLI path/模板，唯一 `skill_graph` 查询后完整回执到达 provider，bash 调用为 0 |

全部 12 个实际 provider transcript 均核对真实工具声明及当前 guidance；scope 场景保留完整原生工具加 bash/graph，没有靠关闭工具实现介绍/查询边界。目录后台仍有 **8 个 CLI 子进程**；它们与 4 个 Pi 宿主均有实际 close，12 个 observer 均有真实 exit 终界。SDK/CLI HTTP 都为 0，因为此处明确使用离线夹具；不推广为生产冷网络零请求。默认 View 仍未验证，夹具的 `CACHE_MISSING` 原样保留。

### 首轮失败与封存修复

package-05 首次 doctor 误用了没有 catalog 的 Node SDK fixture，在启动 Pi 前被拒；改用既有公开目录夹具后，四个场景因新验收器读取不存在的 `context.tools` 而失败。Pi 1.4 实际采用 TranscriptContext，工具声明来自 system 消息的 `toolsAdded` / `toolsRemoved`。修复后的验收器按捕获的真实系统声明回放，保留移除/替换和用户伪声明反例，不根据启动参数补造 provider 工具。

05 的 scope 断言失败后宿主被停止，子 observer 在 report 后追加了 308 B exit 记录。原 ledger 的 1,484 B 前缀 hash 可验证，但父级 child close 缺失；原 45 个 retained 文件中 44 个不变，该次 run 保持失败、未封存，scratch 和四个归档 session 保留。没有改原 retained 或补造 close。

新 driver 在 EOF/Stop 前有界等待已观察 child 的实际 close 与子 observer end，随后核对宿主和全部 source 的最终终界；主 observer 只在退出后检查，避免等待顺序死锁。超时保存 pending 与独立 deadline snapshot，只有每个场景明确 `observer_finality:true` 才写正常 retained。截止时间使用进程单调时钟，不以 quiet、PID 消失或工具 wall time 替代终局。

## 唯一一次真实模型回归

`model-06/skill-model-cost-9W6HlD` 使用独立安装的 package-06、真实 Notion 与固定请求入口 `magpie/group/flash-free`，没有客户端 fallback。新旧响应记录的实际 `responseModel` 均为 `upstage/solar-mini4`，请求模型与服务端返回身份分别保留。配置 SHA256 为 `814e244027481e1d838be5344e48067ef68e859f1fe2eac0602b4ecfb241be6a`；相对旧 `7gd44M`，配置只改变扩展与包路径。冻结的原句、数据库、默认 SDK 入口、预期子串和 cold/warm 数量均未更改；package-05 仅准备和 doctor，没有运行模型。

两次真实 run 均固定 `read/bash/edit/write/grep/find/ls` 七项工具，实际 tool schema 都是 4,971 B。Broker 扩展加载不等于其注册工具已 active：本场 `skill_search`、`skill_prepare`、`skill_graph` 未启用，因此运行的是原生 `read` 加 CLI list 后备分支。新指引仍含准确 Node 与 bundled CLI 路径，仅保留 `list-args`，不再包含 read/files/resource 模板或 `cli_source` 提示。这里证明的是在相同工具面下精简指引后的实际行为；完整原生工具场景不再注入 CLI argv，则由上面的受控 Pi 场景证明。

新旧实际请求各自包含同一份完整 **16,288 B** 源正文一次，SHA256 为 `715eeee5d9572e8809d94a18ca49d3b96a0e8de6a4d6751a45719ad7cbed82ed`。版本、snapshot 与正文均保持一致，payload hash 与实际发送 entity hash 相符。没有摘要、改写作者正文或隐藏正常工具。

### 行为与逐段语义判断

新 run 两个样本合计 **2 个 provider 请求、0 次工具调用、0 个工具轮次**。两个回答均准确介绍维护 Skill 的用途，正确把 `ntn-skills ctl doctor` 解释为连接诊断，也说明它可能读取并缓存一个 Skill。模型未发起本机环境探测，也没有继续把 create/write/replace/update 等写入操作列为健康检查。

原有 `expectedAnswers:["doctor"]` 弱谓词两次均通过，harness 状态为 `observed`。独立审阅仍保留两个语义缺陷，因此本轮**不能记为严格语义验收全部通过**：

| 样本 | 与源内容不符或不够精确的表述 |
| --- | --- |
| cold-1 | 将源文要求的 Node 22.x 内 `22.22.3+` 简写为 `22.x`，扩大了源文声明的支持范围 |
| warm-1 | 把 `operation resume` 泛化为恢复“失败或冻结的操作”，遗漏 unknown/partial 的条件及 `WRITE_CONFLICT`、`PUBLICATION_UNRESOLVED` 等例外 |

这些是对已选源版本的忠实性问题，不通过修改原始答案、追加任务专用提示或反复抽样消除。作者源文中的旧 `ntn` 前提仍按原文判断，不能和模型擅自添加的要求混为一谈。

### 单调时间与完整请求成本

| 单样本指标 | cold-1 | existing-session warm-1 |
| --- | ---: | ---: |
| 提交至首次 provider，ms | 17,947.364 | 693.696 |
| 提交至首次模型 HTTP，ms | 17,949.650 | 695.019 |
| 提交至首有效文本，ms | 26,641.187 | 3,116.009 |
| 提交至任务结束，ms | 38,826.188 | 15,701.391 |
| Provider JSON bytes | 64,135 | 95,472 |
| 回答 bytes | 1,756 | 4,301 |
| Reported input tokens | 16,452 | 25,146 |
| Reported output tokens | 502 | 1,205 |
| Reported cacheRead tokens | 0 | 0 |
| Reported total tokens | 16,954 | 26,351 |
| 模型 response entity bytes | 129,569 | 290,246 |

每组只有 **n=1，p95 为 null**，不能据此承诺真实冷消费延迟预算，也不能与普通无 Skill 消息的首 provider 延迟混用。Warm 保留真实会话历史，所有后续输入均纳入统计。

| 同原句的观察项 | 旧 `7gd44M` | 新 `9W6HlD` |
| --- | ---: | ---: |
| Provider 请求 | 3 | 2 |
| 模型工具调用 | 2 次 bash | 0 |
| Guidance bytes | 4,274 | 2,463 |
| 首请求 JSON bytes | 65,771 | 64,135 |
| 全部请求 JSON bytes | 234,555 | 159,607 |
| Reported total tokens | 63,977 | 43,305 |
| Reported cacheRead tokens | 14,400 | 0 |
| 已观察 source HTTP | 33 | 33 |
| 可证明的 source HTTP 总数 | null | 33 |

指引减少 1,811 B，首请求净减少 1,636 B；两者不能混为一项。总 payload 减少 74,948 B，同时少了一轮请求且回答历史不同，不能把总差值全部归因于模板压缩。Reported tokens 与 cacheRead 同时变化，也不能直接换算成费用下降。原有 33,148 B 原生目录保持一致，warm 中的 29,695 B Broker 目录仍在。

新 source 账本有 **4 个 CLI 操作、2 个 SDK consume，33 次 HTTP（30 metadata + 3 body）、0 写入**；全部闭合，未匹配与迟到启动均为 0。父进程 transport 另外观察到其中 14 次 SDK HTTP，它们已经包含在 source 的 33 次中，不再累加。旧 run 虽也观察到 33 次，但两条未知 bash 的网络仍未覆盖，总数继续为 null，不能宣称本轮减少了 source HTTP。

两个模型 HTTP 均返回 **200**，两个响应流的实际终局仍为 **failure / code 20**；应用层分别正常 stop 并产出回答。这两个层次分别记录，不把 HTTP 状态或应用答案覆盖为流成功，也不推测 code 20 的原因。未观察的 wire bytes、模型内部等待和货币成本保持未知。

## 独立审阅、归档与清理

真实模型审阅另存于 `model-06/independent-review/review-xWl2ZO/`，核对的 **142 个原始证据、归档及运行时文件 hash 均未改变**，机械证据核对无错误；语义缺陷仍按上一节保留。审阅 JSON 的 SHA256 为 `a201cc3fec2704e1c560b68c0a69b56ea53bdc29f20dc5cc55dad4f66373f8d0`。准备提交的四个产品源码文件与实际运行的 package-06 字节一致；包冻结后的最终结果只补入当前报告和验证地图，不把新文档冒充已打包内容。

| 清理对象 | 实际终局与归档 | 清理后核对 |
| --- | --- | --- |
| `pi-installed-06` | 4 宿主、8 child 均实际 close，4 会话和原生资源归档 | 仅自有 scratch 移至 Trash；原 55 个 raw 文件 hash 不变，只新增 cleanup 记录，53 个安装 src/dist 文件不变 |
| `skill-model-cost-9W6HlD` | Pi 44209 正常 EOF、code 0；4 CLI 与 2 SDK 操作闭合 | 既有 evidence→cleanup→evidence 均 exit 0；仅自有 scratch 移至 Trash，原 15 个 run 文件及归档目录 3 个文件 hash 不变，只新增 `cleanup.json` |
| 旧 `7gd44M` / `pi-installed-05` | 原失败与不完整终局继续保留 | 不清理其 scratch，不更新原 retained，不以新结果覆盖旧报告 |

真实模型 session 归档为 0600 的 **158,597 B JSONL**，SHA256 `2e9acdc9edfb878a7d1a431fdc96e321efc1fca9e7164f6cab1e34e11571e9cb`，复制前、归档副本及清理前原件一致。清理没有改变功能或语义状态，也没有执行新的模型或 Notion 请求。

## 仍开放的范围

源内容与 model projection 的完整版本化映射、机器证明从正常 prepare 输出分离、SC07 批读与一次名称检查、正式 SC21 A/B/C/D、跨机和日用安装仍按各自任务验收。额外维护 Skill 介绍句不能替代正式 C 的 `$poteto-mode@notion 介绍下 create-verification-skill`。小样本回归不报告 p95，也不从字符串缩短推断全任务 token 或总成本必然降低。
