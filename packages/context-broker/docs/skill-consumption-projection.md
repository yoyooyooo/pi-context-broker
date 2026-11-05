# Pi prepare：完整正文与模型投影分离

归属 [SC05 / AH-622](https://linear.app/yoyooyooo/issue/AH-622)，承接 [能力化消费指引](skill-consumption-guidance.md) 与 [AH-617](https://linear.app/yoyooyooo/issue/AH-617)。本切片处理公开 `skill_prepare` 返回值中重复机器证明进入模型的问题，沿用已经打包的 CLI/SDK 一次消费内核。

## 呈现合同

Pi 的模型可见结果保留 `ok/status/purpose`、明确根引用及每个已准备节点的 `name/kind/ref/content/directory`。正文是完整源字符串；编译器不解析或删改作者 frontmatter、Members 标题、XML、代码示例或其他指令。

| 内容 | 模型可见 | 机器回执 |
| --- | --- | --- |
| 所选根、Requires 完整正文 | 完整保留，当前有效上下文去重 | 绑定源 hash、字节数、身份、版本与实际正文位置 |
| 主文和资源引用 | 当前分支短引用；无短引用能力时保留规范固定引用 | 完整 canonical binding、scope、owner、snapshot 和 File 身份 |
| 文件目录 | 每行 `path/ref/bytes`，不裁剪行 | 完整文件 hash 和物化证明 |
| Required、Members 与普通 references | 每行 `ref/kind/name/description/availability`，不裁剪行 | 完整关系身份与依赖锁 |
| graph lock、预算、usage、机器路径、存储与版本字段 | 不再重复放入正常 prepare 的模型结果 | `details.contextBrokerPreparation` 保留；显式 `skill_graph` 仍可导出证明 |

`inspect` 与 `use` 的准备语义沿用原合同。目录并不加载 Member 正文，短引用也不授予权限。OMP 保持旧版 v1 返回形状。后续 [Pi 搜索、注入与原生读取投影](skill-model-surfaces-verification-2026-11-05.md) 复用本节目录投影，保留各入口的完整源正文及原投递证明。

## 确定性编译与投递证明

Broker 编译器标识为 `context-broker/skill-prepare/v1`。它与 CLI 的 `source-identity/v1` 分开，绝不把 Broker 渲染后的 hash 写回 CLI 源证明。

新的 preparation details 使用外层 version 2：`records` 保留源投递与 canonical binding，`graphs` 保留完整锁和预算，`projection` 保存编译器、整份模型文本的 hash/bytes，以及每个源正文到 JSON 字符串内部片段的位置映射。位置是 JavaScript UTF-16 offset；source、rendered 的字节数和 SHA256 均以 UTF-8 计算。编译器边拼接边记录位置，不搜索作者正文中的标签或字段名来猜正文范围。

加载判定核对实际工具 content、toolCallId、已知编译器、完整投影 hash、每条源 hash、片段 hash、canonical graph、purpose、roots、scope、owner 和 pin。只有完整实际正文可以形成 loaded；未知 compiler、坏 hash、移位 span、截断、错误工具结果或独立 details 都不能替代内容。

重复 prepare 与显式新版本选择只改 provider 投影。派生回执须从通过完整验证的父投影计算，保留所有非正文结构，重算整份文本与各条位置；被替换正文的条目标为未加载。其余完整正文继续可验证。原始会话结果保持完整，压缩移除较早副本后，保留下来的原结果仍可提供全文。历史 v1 回执按原合同读取，不虚构其编译器证明。

新版重复 prepare 的正文替换为 `Already loaded.`；同一记录的名称、引用和目录仍在。只有当前 provider 消息集合内确有通过校验的同版本完整正文时才做替换，不能凭过去加载过的标记省略正文。这条短确认只用于 v2 prepare 去重，原生 read、历史 v1 与显式版本替换沿用各自语义。

输出预算施加于实际生成的模型文本，超预算在提交选择前失败。已有 SDK 权限、freshness、图预算和源完整性检查不降低。

## 验证方法

本轮私有证据根：`/Users/yoyo/Library/Logs/ntn-skills/AH-617-20261104/projection-batch-j8i8hdxg`。

消费专项覆盖作者内容保真、相同正文出现在名称或多个记录中、映射与源码双 hash、未知编译器、坏 source/rendered hash、跨 owner/scope/pin、重复和显式替换后的派生证明、v1 与 OMP 兼容以及失败不提交选择。

实际 Pi 验收继续使用独立 npm 包及已有 SDK fixture。只统计真实 `message.content` 中的正文；details、tool schema 和 assistant arguments 不算正文投递。prepare 场景增加同会话重复调用，检查 provider 去重后的派生证明与会话原件。宿主的 TranscriptContext 可含内部 details，其捕获总 JSON bytes 不等于模型 HTTP body。

同一实际上下文另交给已安装 Pi 的公开 provider serializer，通过自有 localhost HTTP 接收请求，核对 hook payload 与实际 POST body，以及机器 details 未进入请求。它证明当前 serializer 和真实 HTTP 路径，不代表真实模型回答或生产网络成本。

真实模型使用已有成本 driver 的显式 `native-skills` 工具组合：保留原七项正常工具，加 `skill_search/skill_prepare/skill_graph`。旧缺省仍为原七工具，不回填历史样本。固定原句为：

> 请在 notion 来源中用 skill_search 找到唯一的 ntn-skills-maintain，再用 skill_prepare 的 inspect 读取它。介绍这个 Skill 的用途和健康检查入口，只解释，不执行。

这是明确公开入口的补充验收，区别于自主选路和正式 SC21-C。模型入口固定 `magpie/group/flash-free`、无 fallback；基线和候选各计划一次 cold + 一次 existing-session warm。所有实际请求、工具、失败、未运行项和语义问题保留；不重跑替换答案。弱答案子串、应用 stop、HTTP 状态与流终局分别判断。每组 n=1，不报告 p95。

这里的 cold 是每臂独立新建的 Pi 进程、会话、工作目录和 CLI/Broker 可变缓存根上的第一轮；warm 在同一进程和会话再次提交相同原句，保留第一轮上下文及缓存。它不代表 Notion 服务端、模型服务端或网络全冷，也不清空日用缓存。两臂除安装包和扩展路径外配置相同，CLI/SDK/manifest、工具列表、原句和语义 oracle 均在运行前冻结。

生产模型观察保存真实 HTTP 请求体的 bytes/hash，以及 hook payload 的 bytes/hash；不保存生产请求全文。独立复核以二者匹配、归档原始会话、源正文和各层终局为依据，与受控 localhost 保留实际 POST 全文的证据范围区分。

## 冻结产物与受控 Pi 结果

投影候选 `pack-02/pi-context-broker-0.0.2.tgz` 的 SHA256 为 `386020ef647aa892eabec80d2b1de303ae17eb751bdab313f850a15200030ad4`。独立 npm 安装后，75 个文件与 tar 和打包目录逐字一致；其中 55 个为 `src/dist`。CLI、SDK 和 runtime manifest 与第一候选及既有消费内核保持相同。运行环境为 Node 24.20.0、Bun 1.4.3、Pi 1.4.0。

消费专项在后续指引修复后一并复跑，为 **104/104、861 assertions**，类型检查通过；未改动的验证 helper 套件为 **167/167**。这些集合内的定向测试不另行相加。新增反例包括空或缺失 toolCallId、v2 降级伪装为 v1、坏父投影、未声明正文改写和小正文重复确认。

两次实际 Pi 运行均在四条入口通过：`dollar/native/prepare/scoped-command` 的 provider 请求数分别为 `3/4/5/2`，包含重复 prepare。每轮 65 个证据原件、四份原始会话归档、14 个冻结输入和全部安装文件均核对哈希。Pi、source child 和 SDK 观察链的终局闭合。候选 02 实际有八个 catalog 子进程：四个普通离线查询 exit 0，四个 Default View 离线查询因 fixture 缓存缺失返回 `CACHE_MISSING`、exit 1；所有进程终局与原始通知均保留，不把它们写成全部退出成功，也不宣称验证了真实 Default View 发现。

第一候选已使用新 compiler，但实测发现：fixture 每条正文仅 24–30 bytes，旧重复说明反而更长。因此保留第一轮结果，只在候选 02 把 v2 重复确认压短。两轮 13 个公共输入完全相同，55 个运行文件仅 `session-source-snapshot.ts` 改变。

| 同 fixture 指标 | 第一候选 | 短确认候选 02 | 差值 |
| --- | ---: | ---: | ---: |
| 首次 prepare 的模型文本 | 1,599 B | 1,599 B | 0 |
| 重复 prepare 的模型文本 | 2,582 B | 1,546 B | −1,036 B（−40.12%） |
| 实际 localhost HTTP POST | 14,129 B | 13,093 B | −1,036 B（−7.33%） |

来源正文 hash 不变，两份原始 prepare 结果都保留完整正文；只有 provider 中的第二份替换为四条短确认。实际安装的 serializer 发送的 POST 已逐字归档并独立检查，机器 details 没有进入工具正文。上述结果衡量受控同 fixture 请求，不等同于生产模型 token 或费用；短于 15 bytes 的极小正文也不保证替换后严格更小。

对照明细见私有证据中的 `route-driver-02/comparison-01-02.json`，两轮原件分别在 `pi-installed-01/` 和 `pi-installed-02/`，包清单在 `pack-build-01/frozen.json` 和 `pack-build-02/frozen.json`。两轮均经独立审阅后执行 `evidence → cleanup → evidence`，仅回收各自临时目录，所有原件、会话归档和冻结安装包继续保留且哈希不变。回收回执分别在 `route-cleanup-01-r2/`、`route-cleanup-02/`；第一次外层回收前置检查的错误假设亦原样保留在 `route-cleanup-01/`。第一候选及未运行的 `model-compare-01` 计划完整保留。

## 真实模型对照 02：结构收益与未通过项分别记账

`model-compare-02` 先运行旧包基线 `skill-model-cost-OjN3QR`，完整关闭后再运行候选 02 `skill-model-cost-622BtU`。两臂各一次 cold 和同会话 warm，无 fallback、无补样；冻结 manifest SHA256 为 `7c7b11e7302e2ee8610db50e69fd28e8e9818c5bd5799191fe8bba6b7ce2b98a`。

真实首次 `skill_prepare.inspect` 的工具文本从 **21,385 B 降至 18,049 B，减少 3,336 B（15.60%）**。两臂主文均为 16,288 B，SHA256 均为 `715eeee5d9572e8809d94a18ca49d3b96a0e8de6a4d6751a45719ad7cbed82ed`，owner/scope/snapshot 相同。两行文件目录及两行普通 references 全部保留；其中两条文件引用和一条关系引用为短引用，另一条关系继续保留原 canonical ref。这是同一源内容下可确定的呈现变化。

两版模型文本中的 JSON 正文字串内部均为 16,464 B；除去这一相同片段，生成结构从 4,921 B 降至 1,585 B（减少 67.79%）。源字节与 JSON 转义后的投影字节分别度量，未把源正文删改算进收益。

全任务结果不支持宣称本次对照普遍降本：候选 cold 多读了按需资源 `operations.md`，warm 则只搜索后直接回答，**没有完成本轮明确要求的 `skill_prepare.inspect`**。后者违反运行前冻结的语义 oracle，即使 driver 的弱答案检查标为 passed，也必须保留为语义失败。

| 场次 | 模型请求 / 工具调用 | 上报 input / cacheRead | 提示 token 合计 | 实际请求体合计 | 提交到完成 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 基线 cold | 3 / 2 | 44,299 / 0 | 44,299 | 169,373 B | 50.87 s |
| 基线 warm | 3 / 2 | 76,404 / 11,200 | 87,604 | 323,109 B | 24.11 s |
| 候选 02 cold | 4 / 3 | 36,632 / 24,128 | 60,760 | 251,520 B | 53.06 s |
| 候选 02 warm | 2 / 1 | 28,869 / 28,372 | 57,241 | 244,610 B | 14.90 s |

提示 token 合计按上报 `input + cacheRead + cacheWrite` 计算；本批 cacheWrite 均为 0。output 分别为 864、868、1,572、1,908。两轮请求体合计为基线 492,482 B、候选 496,130 B（增加约 0.74%）。候选 warm 少执行一步，不能把其较少 token 或较短时间算作同任务优化成功。

模型选择器始终为 `magpie/group/flash-free`，但实际 responseModel 有变化：基线六次均为 `upstage/solar-mini4`，候选前两次同上、后四次为 `MiniMax-M3`。因此模型行为、分词、缓存与时延也存在后端路由混杂；以上保留为本批观察数据，不作 compiler 因果收益或统计稳定性结论。

两臂六次请求各自均得到 HTTP 200，hook payload 与实际 HTTP 请求体的 bytes/hash 一一匹配；基线五次、候选两次随后记录 Undici `errorCode: 20` / transport failure。四轮应用均正常 stop，两个 Pi 实际 close code 0。应用完成、HTTP 状态、流终局分别报告，未把它们合并成“所有网络流成功”。来源账本完整：基线 33 次 Notion HTTP（30 metadata、3 body），候选 32 次（29 metadata、3 body），均无写入；各自 CLI 4/4、SDK 2/2 开始与关闭配对。候选第二次 SDK 是资源读取，不能将相同 SDK 总数解释为相同工具行为。

独立语义审阅结果为基线 cold/warm 通过、候选 02 cold 通过、warm 不通过。两臂分别归档 391/393 个原件，包含原会话和实际来源缓存；独审后各自执行 `evidence → cleanup → evidence`，只回收对应 scratch。共 822 项归档、原账本、配置、oracle、冻结输入和 helper 的哈希保持不变，原失败报告未修改。完整观察及 SDK 操作归属见 `model-compare-02/comparison-observation.json`、`source-operation-attribution.json`、`cleanup-02.json`；独审在 `projection-implementation/model-{baseline,candidate}-02-review.json`。

### 显式请求与正文复用的冲突

候选 02 的实际会话注入了两条过强指引：使用已有正文而不重读，以及已有 host preparation 已满足 prepare 这一步。warm 用户仍明确要求 inspect，最终回答却以已加载正文为由跳过操作。运行时支持重复 prepare，`Already loaded.` 也发生在成功调用之后；问题是指导没有清楚区分普通续问的复用与当前明确要求的操作。

该失败和全部原件保留。后续候选只修正这条通用边界：普通续问复用完整正文；当前用户明确要求的 discovery/read/inspect/use 操作通过可用且已授权的入口执行，既有 preparation 不代替明确要求的 `skill_prepare`。这不改变 source、权限、snapshot、refresh、workflow 执行授权或 legacy/OMP 行为，也不要求用户使用 again 等特定词。

修复候选 `pack-03/pi-context-broker-0.0.2.tgz` SHA256 为 `4a866fd31eab8f97d6481f37edfcaae61fd951bc8775e7a1d2daeee429df7c1a`。75 个文件独立安装并核对；相对候选 02，55 个 `src/dist` 中只改变 `src/index.ts` 的两条 native guidance。原句、工具、oracle、CLI/SDK 与 verifier helpers 保持冻结，按计划仅执行一次 candidate cold + warm 功能复验，不重跑基线、不替换 02 失败，也不把复验包装成新的同条件成本胜出。

候选 03 的实际受控 Pi 四路再次通过，provider 请求仍为 `3/4/5/2`。首次与重复 prepare 文本仍为 1,599 / 1,546 B；指导的解码文本从 1,861 增至 2,038 B，对应 API message（含结构与转义）从 1,921 增至 2,098 B，实际 localhost POST 因此从候选 02 的 13,093 增至 **13,270 B**。增加的 177 B 完整计入，没有为了压低数值省略显式用户意图规则。相对第一候选的 14,129 B，整条请求仍减少 859 B（6.08%）。实际 message 大小变化仅发生在 guidance，正文和目录没有变化。

`pi-installed-03/` 保留 65 个原件和四份会话归档；14 项冻结输入、75 个包文件均通过运行前后哈希核对。该轮实际启动七个 catalog child：四个 exit 0、三个 Default View 缓存缺失 exit 1；scoped-command 只启动一个 catalog child。所有实际启动的进程终局闭合、受控来源 HTTP 为 0，未将不同轮次的 catalog 数量强行补齐。对照见 `route-driver-03/comparison-01-02-03.json`，完整包文档变化与仅 index 改动的运行文件范围分别记录。

Pi03 经独立审阅后已完成 `evidence → cleanup → evidence`，只回收自有临时目录，65 原件、四份会话、14 输入、75 包文件和既有外层失败记录哈希不变；回执在 `route-cleanup-03/execution.json`。实际 POST 原文 SHA256 为 `8547f4401e4a5e0f96aaa202611b2205b87bfa4055e06fa6847fdd84cd5529dc`。

### 候选 03 的真实功能复验

`model-followup-03/skill-model-cost-sSRYDJ` 按单独冻结的功能计划执行一次 cold + warm，manifest SHA256 为 `8efe55d4ea3850b51eb3b96625ff29ff7d512464891b03af906e14832840ef58`。它只变更候选包与扩展路径，复用 02 的同一原句、十项工具、语义 oracle 和 helper。两轮独立语义审阅均通过：每轮实际 `skill_search(source: notion) → skill_prepare(purpose: inspect)`，引用来自该轮唯一准确结果，两次中文回答说明用途与 doctor 入口，没有执行健康检查、工作流或写入。

两份持久 prepare 结果均为 18,049 B，text hash 相同，仍含完整 16,288 B 原主文与完整目录。暖轮调用成功后，第二份 provider 工具文本为 1,600 B：独立重建短确认后的容器 hash 与实际 context component 匹配。前两次模型请求尚未加载主文；首次投递后的第 3–6 次实际 hook payload 中，该固定正文均恰好一份。这里的 provider 确认依据是组件/hash/正文计数和实际 HTTP 请求体 hash 的对应，生产请求全文仍未保存。

| 03 功能样本 | Cold | Warm |
| --- | ---: | ---: |
| 模型请求 / 工具调用 | 3 / 2 | 3 / 2 |
| 上报 input / cacheRead | 31,122 / 11,200 | 70,441 / 8,000 |
| 提示 token 合计 | 42,322 | 78,441 |
| Output tokens | 495 | 471 |
| 实际 HTTP 请求体累计 | 166,247 B | 305,001 B |
| 提交到完成 | 46.61 s | 14.12 s |

六次响应的 responseModel 均为 `upstage/solar-mini4`，selector 始终为 `magpie/group/flash-free`，无 fallback。所有 HTTP 均为 200，实际请求体 bytes/hash 与 hook 逐请求匹配；六次 Undici 终局均记录 failure/errorCode 20，两个应用回合正常 stop。Pi 实际 close code 0；来源 CLI 4/4、SDK 2/2，33 次 Notion HTTP（30 metadata、3 body），0 写入，观察链有完整终局。这证明本批明确操作与去重的功能路径，不意味着源请求已经优化到零，也不把正常应用结束冒充成功流终局。

独审原件与结论在 `projection-implementation/model-followup-03-review.json`，391 个原会话和来源文件归档在 `model-followup-03/candidate-archive/`，provider 组件测量在 `model-followup-03/provider-content-observation.json`。02 的 warm 失败和后端标识变化继续独立保留；03 不替代原对照，也不用于声称一般性延迟、p95 或 compiler 的因果总成本收益。

03 独审后执行了 `evidence → cleanup → evidence`，只回收本次自有 scratch，391 个归档和原账本、包、冻结输入、helper、oracle、02 失败等共 429 项文件哈希不变。回执为 `model-followup-03/cleanup-03.json`，功能汇总为 `functional-observation.json`；无后续补样或待运行模型计划。

## 尚未覆盖的范围

上述 prepare 编译切片没有实现 requestedFiles 批读。后续 SC07 通过独立 [固定资源批读合同](fixed-resource-batches.md) 增加 SDK `readResources` 与 Pi `read(paths)`；consumer v1 的非空 requestedFiles 继续明确拒绝。两个版本的证据和覆盖范围分别保留。

作者内容或旧生成 Members 目录的进一步精简，须先建立可靠来源标记；本轮保留完整正文。其他投递入口的统一编译、正式 A/B/C/D、跨机恢复与日用安装继续按对应任务验收。旧真实 graph gate 还需完成短引用、SDK 来源与新模型形状的整体迁移，不能把它的旧成功记录称为新 compiler 通过。
