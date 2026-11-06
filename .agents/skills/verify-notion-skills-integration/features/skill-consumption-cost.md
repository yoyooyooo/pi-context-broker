# Skill 消费成本：只读观察与冻结基线

归属 [SC02 / AH-619](https://linear.app/yoyooyooo/issue/AH-619)，完整入口地图见 [Skill 消费链](skill-consumption.md)。本规程交付测量与基线，不代表后续性能预算、SDK、压缩恢复或日用安装已经通过。已执行的样本、失败和方法边界见 [2026-11-04 基线报告](../../../../packages/context-broker/docs/skill-consumption-baseline-2026-11-04.md)。

## 观察边界

| 层 | 驱动 / 原件 | 计量含义 |
| --- | --- | --- |
| Pi 用户提交与 provider | `skill-consumption-cost.mjs` / observer JSONL | 同机单调时间、实际 provider hook 的 JSON bytes/hash、tool schema/目录/正文/资源/历史的分项字节与模型报告 usage |
| 模型 HTTP | `skill-consumption-provider.mjs` / transport JSONL | Node Undici diagnostics 的实际 request body hash/bytes、response entity chunks、真实尝试；不替换 fetch、不消费响应、不注入工具参数 |
| Source CLI | `skill-consumption-source-baseline.mjs` / 每个 child 的 receipt、stdout、lifecycle | prepare 后逐节点固定 read、独立单资源 read，或单 current inspect；request_metrics 中的 metadata/body/retained-body/write/provider、retry、queue 与响应解码字节 |
| Pi 默认 Source SDK / 显式兼容 CLI | `skill-consumption-source-observer.mjs` / safe-source-requests JSONL | 进程内 SDK list/files/consume/read/read-resources 的公开 start/end 与安全 request_metrics；显式兼容 CLI 的真实 spawn/close 和完整 stdout 中的 request_metrics。SDK 操作、CLI 子进程与 HTTP attempt 分别计数 |
| 普通启动顺序 | `skill-consumption-startup.mjs` | 实际 Pi，受控 source/provider；原生 RPC 提交先于目录完成。受控 stream 不等于真实模型 HTTP 或 token |
| 真实模型成本任务 | `skill-consumption-model-baseline.mjs` | 缺省保留 magpie/group/flash-free；显式 daily-route-v1 冻结 magpie/group/flash、high、300000ms 与 owned retry0。正常工具、冻结的普通或 Skill 任务；独立 cold 进程和最后一个进程中的 existing-session warm 续接。原 driver 的 `pi-native-local` 臂不加载 Broker，使用 Pi 原生发现/read；任务类型分组记录，成本 driver 不替代 Skill 完整消费断言 |

被动成本 observer 的 JSONL 使用 0600 权限、逐事件 hash 链和同机 monotonic clock。成本日志不保存认证头、token、签名 URL、原始 CLI stdout 或完整 provider 正文；独立 Source CLI driver 的原件保留规则另按该 driver 执行。metadata selection 另保留无 Skill 正文的实际 provider JSON、受控本地 HTTP payload 和 SDK 目录结果，用于比较完整候选集合。实际 payload 的 hash 必须与 transport 发送 body 对齐；hash/摘要本身不证明 Skill 正文投递，后者仍由消费链的完整 span 断言负责。纯本地臂使用同一成本和 HTTP observer，并以原 driver 内的 native inspection observer 替代 Notion source observer；没有另建总验证入口。

正文观察只扫描实际 message content（包含 JSON 编码的 prepare 正文），排除 details、tool schema 和 assistant tool arguments；raw/XML/JSON 的同一物理片段不重复计数。known body 必须来自 owned receipt 和匹配的非空 toolCallId，v2 compiler/hash/span 也要匹配。该统计仍不替代完整功能投递判断。真实 Pi 的 TranscriptContext 可带内部 details，受控捕获的总 JSON 大小不能当模型 HTTP body；serializer/localhost HTTP 的字节和真实模型 HTTP/token 分开报告。

未知值用 null。provider hook JSON、CLI 解码 JSON、压缩后的 HTTP entity、ZIP 文件和 TCP/TLS wire 是不同单位。模型 HTTP observer 只有 identity content-encoding 才将 entity bytes 作为 decoded response bytes；wire bytes 始终不可从这些 hooks 推得。usage 的 input、output、cacheRead、cacheWrite、totalTokens 分开记录，不用字符数估计 token。Notion SDK / CLI 的重试和队列等待沿用公开 request_metrics；模型 SDK 内部等待或其它未观察字段仍为 null。

## Launch 与 Doctor

从 Broker checkout 根运行；沿用保护清单，按明确文件提交。禁止全目标 build 改写 Tern，已有运行环境足够时不重新安装。

```bash
node scripts/skill-consumption-startup.mjs --help
node scripts/skill-consumption-model-baseline.mjs --help
node scripts/skill-consumption-source-baseline.mjs --help
bun run test:verification
```

Doctor 不调用模型或真实 Notion。配置和证据均放在 checkout 外，具体绝对路径必须由本次输出取得。先记录实际运行的 Node、Pi executable、扩展 source tree、embedded CLI 和可选 archive 的各自 hash；文件夹名称、Git HEAD 或 archive hash 均不能替代实际安装文件的 attestation。Pi 的解析结果可能不同于另一个 Node 安装中的 `volta which pi`。

### Source CLI 配置

配置含 `command`（绝对 executable argv）、`database`、`root`（当前未固定的精确主文 ref）、`evidenceRoot`。默认 `pipeline` 为 `prepare-fixed-main`，`samples` 为：

```json
{"cold":5,"warm":20,"expired-unchanged":20,"partial":5}
```

可选 `resourcePath` 增加一次根固定资源读取。独立单资源基线使用 `pipeline: "resource-only"`、非空 `resourcePath`，以及 `{"cold":5,"warm":0,"expired-unchanged":0,"partial":0}`；它每例仅启动一个当前资源 read，之后只读本例本地缓存，无 prepare/files 或主文读取。

SC11 的单 current inspect 使用 `pipeline: "inspect-current"`、cold-only counts，并拒绝任何 `resourcePath`。每例在全新的 owned state 只执行一次公开 `ctl prepare ROOT --purpose inspect --database DATABASE --metrics`；不追加 read/files/export，也不使用 forced refresh 或 TTL 改写。输出须为唯一 ready root、完整正文 bytes/hash、固定身份和完整目录；Requires/Members 保持 known。首个有效样本冻结这些身份与目录，其后漂移失败。

`elapsedMs` 取实际 CLI child 从启动到 close 的完整时间（包含 startup 与完整 stdout）；`preparation.rootReadyMs` 取同一结果的公开 `preparation_metrics.root_ready_ms`，表示准备开始到根已就绪，不包含此前 CLI startup。保留两者、每对样本和全部 HTTP attempts/bytes、queue/retry；不可只选其中改善的一项。trace 不完整、正文/身份错误或任何调用失败都会停止余下 inspect 样本，标为 not_run；unknown write 保留原 operation，不能重放。失败状态不进自动 Cleanup，留待原操作恢复与审阅。

旧包/候选配对先冻结实际 archive、安装 CLI/SDK/Node、同一 root/database/认证 scope、所有配置和样本顺序，再交错串行运行各自新目录中的样本。比较全部 metadata/body/retained/write/provider 账本，不能仅比较目录字节；current 消费可能 retention/adoption，实际写入不能预先填零或从成本中扣去。N=1 的受控字节回退保留；增加一次完整页 GET 对真实首读延迟的影响须由该窗口判断。有限样本只能形成该窗口的判断，不能外推 p95、Agent 任务成本或日用通过。源漂移、权限变化、未知归属或不等价远端写入使配对不可比较，不替换失败样本。

```bash
node scripts/skill-consumption-source-baseline.mjs doctor --config /absolute/source-config.json
node scripts/skill-consumption-source-baseline.mjs plan --config /absolute/source-config.json
node scripts/skill-consumption-source-baseline.mjs run --run /absolute/reported-frozen-run
```

Plan 在远程读取前冻结 CLI/hash、方法、样本顺序和初态；执行拒绝被修改的 driver 或 CLI，不重复执行同一个 run。首个实际 cold 样本建立源身份锚，之后的 scope/snapshot/version/hash 漂移必须失败；不由 oracle 预热 consumer。独立 oracle 有自己的状态根与成本账本。

Cold 每例为空的自有状态；warm 使用独立 setup 后的共享自有状态，固定 5m 策略。Expired 使用冻结的 `--max-age 1s` 和实际单调计时至少 1001ms 的等待，验证 freshness 回执；不是 `--refresh` 或 `--max-age 0` 的强制全量行为。Partial 仅把已验证的自有主文对象移入系统 Trash，保存原对象和 manifest，随后走原固定 pin；不得回退 current 或补做成功来替换失败。

### SC11 的六样本采用门槛失败

2026-11-05 的 `inspect-current` 实验按冻结的 C6→候选、候选→C6、C6→候选顺序执行，六次均为独立空 consumer state。C6 包 SHA-256 为 `84f79a9d28a7667f0a58b33e3c5a0598c7adc3349e8263c5976ee8143153c1e4`，候选包为 `b647882c074f8e09a9c6600a9408aee1f6778932f2f7abc73c12b214408ce348`。完整安装入口、SDK、Node、driver、输入、scope 和独立 oracle hash 均在原计划中冻结。

| Pair 与顺序 | C6 elapsed / rootReady ms | 候选 elapsed / rootReady ms | 候选减 C6 ms | C6 / 候选总 response B |
| --- | ---: | ---: | ---: | ---: |
| 1，C6→候选 | 9875.752 / 9572 | 9007.326 / 8626 | -868.425 / -946 | 1,971,679 / 1,182,312 |
| 2，候选→C6 | 8302.505 / 7993 | 8683.400 / 8384 | +380.895 / +391 | 1,971,679 / 1,182,292 |
| 3，C6→候选 | 8588.354 / 8280 | 10698.151 / 10401 | +2109.797 / +2121 | 1,971,679 / 1,182,316 |

每对只增加一次选中根 metadata GET，HTTP attempts 为 15→16。三页 Skills inventory 保持完整；四个 body attempts 的目标、归属与 395,627 response B 相等。正文、46 个落盘文件的 bytes/hash、scope/version/pin 和关系目录均与独立原件一致。已有离线 retained-source proof 绑定每个 chunk 和 owner，没有为本实验补发归属查询。原 `unclassified_body` 类别继续保留，来源归属单列；Requires 和未选 Members 的 body attempts 为零。

各臂 elapsed 中位数为 C6 8588.354 ms、候选 9007.326 ms；rootReady 为 8280 ms、8626 ms。paired delta 中位数分别为 +380.895 ms、+391 ms。每对总 decoded response B 约减少 40.035%，但冻结的两项延迟门槛均失败。`functional_acceptance=true` 与 `adoption_gate_passed=false` 分开保存。候选运行时代码和专用断言已撤回，原 scalar read 复用与 graph 完整 inventory 保持原行为；本 driver 的冷 inspect 测量入口独立保留。

六次共 93 HTTP、9,461,957 decoded response B，write/provider 实测为零，无 unknown bytes、缺失归属、失败替换或补跑。原 E→C→E 六次均通过，只把 owned working 移至系统 Trash，原包、失败、计划、stdout、trace 和 source proof 全部保留。日用配置 hash 不变。三对数据不支持 p95 或全 Agent 任务收益；受控 N=1 的 +864 B 反例继续有效。

证据根为 `/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/sc11-single-inspect-iyw1oxit`。`live-pair-plan/paired-plan.json` SHA-256 为 `e313aa2edb966982a18a3f2d3a1119cbf42fd3d47edc8792ef8bc5b75cf887ad`；`real-pair-result.json` 为 `515544b7210df7847f77bbaf05454f50309af5c5936b651dbc435a26008d7700`；同目录 `cleanup-result.json` 为 `407a69beb93eec0ba7a4288e5cc000748a8465d488461d7498d81afbb164c6ad`。后续比较必须有能改变请求与延迟取舍的具体机制，或明确调整后的任务预算，并冻结新计划。不能追加同输入样本、规模阈值或缓存策略把本轮改成通过。

### SC05：同目录就绪状态的受控比较

原 `notion-sdk-pi.mjs` 的 `native`、`native-repeat`、`prepare` 可显式增加 `--warm-directory true`。此选项只用于独立的 warm-directory cell：每臂仍启动新的实际 Pi、使用同一已暖的离线 source fixture、空 Broker cache 和新会话；在原首 prompt 前等待已经启动的 ordinary catalog 与 Default View 请求实际终结，不增加 prompt、工具调用或正文准备。默认值为 false；`all`、`default-view`、`dollar`、live 等场景不接受 true，原普通首轮 pending 及 all14 门禁保持原样。

```bash
node scripts/notion-sdk-pi.mjs doctor \
  --package /absolute/independently-installed/pi-context-broker \
  --fixture /absolute/original-sdk-catalog/fixture.json \
  --scenario native --warm-directory true
node scripts/notion-sdk-pi.mjs run \
  --package /absolute/independently-installed/pi-context-broker \
  --fixture /absolute/original-sdk-catalog/fixture.json \
  --scenario native --warm-directory true --out /absolute/new-warm-directory-evidence
```

Doctor 仅确认输入和计划，不能宣布目录已 ready。Barrier 复用原 source/process finality，最多 10 秒，并计入原单景 180 秒外层预算；RPC 原 60 秒限制不变。空 ledger、只有 ordinary list、缺 terminal、错误 source/database/scope、部分目录、失败 source、正文读取或非零来源 HTTP 都不能通过。当前默认 SDK 必须有同 ID 的真实 list start/result/end；历史比较臂只在 owned helper 副本中接相同等待点，核实际 bundled CLI 的 ordinary/default-view argv、stdout bytes/hash 和子进程终局，不能为旧臂合成 SDK 回执。`warm-directory-startup.json` 保留等待区间、source ledger 前缀 hash 和尚未提交任何 provider 的事实。

等待完成还不等于模型获得目录。`warm-directory.json` 必须逐个验证实际 provider system 与安装版本 serializer 生成的 HTTP payload：首请求起都恰有完整 Default View，候选 ref 绑定真实 discovery 的 owner、scope、source、name、description，并对独立 fixture manifest 核对；首请求正文为零。原完整正文、Requires、资源、历史副本与 source finality 断言继续执行。旧版本显示 namespaced 名称且没有单独 source 标签，当前显示作者名称并列 source；这些呈现和相应字节全部保留，语义候选相同不代表文字相同。任何首次 pending、用户文本伪目录、候选缺失或未绑定 ref 都使新 cell 失败，不自动再试。

2026-11-06 的原六次诊断保留为非同目录状态样本：native 序列化 HTTP 为 41,175→42,715 B，native-repeat 为 67,364→69,978 B，prepare 为 59,438→60,443 B。旧臂四/六次请求仍 pending，而新臂第二次起为 ready；prepare 的第二用户句还不相同。因此这些差值不裁决收益或回归。旧源的真实默认 list 已自然退出，后续同轮系统目录仍 pending，原因是旧版在 `before_agent_start` 固定投影；第二用户轮次确实显示原两项，不能归因为 SDK 请求失败。原 FAILED reports、serializer sidecars 与 unpaired 标记保持。

原账本为 `/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/sc05-public-cost-a4yii0vm/initial-six-comparison.json`，SHA-256 `11f2364f13b8363701ab197c5f119ef22ec6fcae7ad82705464f0490c2792d0c`。新 helper 的红绿证据与冻结计划在同根 `warm-directory-harness-iwh8jg4k`。三场各跑一次旧/新臂，使用同一 Pi 1.4、C7 runtime、fixture 和原用户输入；prepare 两臂第二句精确使用当前原句 `Use the same a, b and c Skills again, keeping their selected versions.`，旧 helper 的其他工具名称/正文断言不改。该受控 cell 不替代真实模型、生产源网络、cold 启动或 SC20 的全任务成本矩阵。

2026-11-06 按冻结计划实际运行六轮，结果为 **5 PASS / 1 FAIL**，零重试。旧 native 的 metadata close 后 0.592 ms，barrier 观察到 source 终局；再过 6.407 ms 首个 provider 仍为 pending，四次请求都没有 ready 目录，原失败保留。它的 41,175 B 不能与新 native 的 43,187 B 作同目录配对，也没有增加 sleep 或重跑。repeat 和 prepare 的两臂从首个实际 provider 起都显示相同两个 owner/scope/name/description，原完整正文、Requires、资源与终局断言通过；实际旧 namespaced 名称及新 source 标签差异照常计入。

| 实际配对与互斥组成项 | repeat 旧 → 新 B | prepare 旧 → 新 B |
| --- | ---: | ---: |
| 全部工具定义数组 | 22,086 → 24,504 | 18,405 → 20,420 |
| guidance 的 JSON 编码文本 | 13,020 → 10,782 | 10,850 → 8,985 |
| Default View 的 JSON 编码文本 | 5,340 → 4,776 | 4,450 → 3,980 |
| 实际工具结果消息 | 12,092 → 12,777 | 13,200 → 13,748 |
| 其余消息与 JSON 结构 | 17,616 → 17,611 | 13,886 → 13,782 |
| **实际完整 HTTP 请求合计** | **70,154 → 70,450，+296** | **60,791 → 60,915，+124** |

repeat 每臂 6 个请求，prepare 每臂 5 个请求。每份实际 HTTP 原始文件的 bytes/hash 都先验证，且与原紧凑 JSON 序列化相同，再把工具数组、tool 消息、非 tool 消息中的 guidance/catalog 编码文本及剩余结构互斥归类；不能再把纯文本长度或 host details 加进合计。每个请求工具数组增加 403 B：read 定义 2,044→2,443 B，其中总 description 增加 125 B、scalar path description 47→184 B 在现有两分支共增加 274 B；discovery 定义增加 105 B、use 定义减少 101 B。工具结果增长均来自每次后续请求保留的 discovery 结果增加 137 B；read/resource/use 正文结果没有因此减少。

两组实际净增作为一行文案收敛的 fail-before。仅将 `pi-host-adapter.ts` 的 `scalarProperties.path.description` 从 184 B 缩为 123 B：`Local file path (relative or absolute), or an issued skill:// or sr: ref. Copy refs verbatim; never guess filesystem paths.` 顶层与 scalar oneOf 使用同一属性，因此离线原 payload 克隆的每请求差值精确为 −122 B。只改该字符串的反事实为 repeat 69,718 B（相对旧臂 −436 B）、prepare 60,305 B（−486 B）；该阶段仅为离线预测。schema 结构、read 总说明、普通本地路径、分页、图片、issued Skill/canonical/sr 引用、read/use 区别、guidance 和其他工具定义保持不变。原 `pi-read-adapter.test.ts` 的五项语义测试继续覆盖这些边界；后续独立安装实测另列，旧 native 样本不追加、不重判。

六个 Pi 均 natural exit 0；整体外层 exit 1 保留旧 native 的功能失败。39 个已知进程均关闭，六次原 E→系统 Trash→E 保持 218 个原件 hash；238 个 frozen inputs 与实际 daily3 before/after 相等。来源 SDK/CLI HTTP 为零，30 个 HTTP 是安装版本 serializer 的 localhost 观察，不能当生产网络或模型账单。`cases-terminal.json` SHA-256 为 `2bd96bdefb97beebc78910f2372d84a56cc68ee79bec19858b0e40c15ae11045`；`window-release.json` 为 `178c23be097dc1a17be686623619ffb9dda3c823e5e0740d52b29dd501d343bf`；`offline-cost-analysis.json` 为 `021ec0bec375ab569ba7faded1288e15dfee7912d9741665e3c7ba8433c550c1`。它们均在上述 warm-directory 证据根，原失败和 startup 等待成本完整保留。

2026-11-06 的后续安装实测使用纯提交 `128b59d776648ab2eca2b8b14c9a09a267958faa` 导出、原 pack/strict closure 与同一 C7 输入。归档 SHA-256 为 `14acc956a1bde32ddde4966b5298266c3b52898c5da92abe1a718c74c822dfba`，86 个安装文件与 tar 的路径、字节、hash、mode 全等；相对 bace，85 个成员不变，仅 `src/pi-host-adapter.ts` 改动。内嵌 CLI `3c4a6284…`、SDK `912a853d…` 和 completion 均不变。构建时首次 owned import 包装误入 closure 的 CLI main guard，及后验一次路径排序错误各自留证；修正调用/比较方式没有重打包、重跑消费者或改旧报告。

继续使用已冻 `5400b774…` helper、Pi 1.4、原 `4a43f63c…` fixture 和相同用户输入，只执行新版 native-repeat、prepare 各 n=1：Doctor 一次，单景原 180 秒、RPC 60 秒、barrier 10 秒，零重试。两景均 PASS，首个及后续 provider/serializer 目录均 ready，owner/scope/name/description 与旧 PASS 相同；完整正文、Requires、固定资源和重复确认仍经原断言核验。

| 同条件实际完整 HTTP 请求 | 旧版已冻 PASS B | 未收敛 bace B | 新 14acc B | 对旧版 / 对 bace B |
| --- | ---: | ---: | ---: | ---: |
| native-repeat，6 请求 / 5 工具回合 | 70,154 | 70,450 | **69,718** | **−436 / −732** |
| prepare，5 请求 / 3 工具回合 | 60,791 | 60,915 | **60,305** | **−486 / −610** |

逐原始 HTTP 重新核对 bytes/hash、完整紧凑序列化及互斥组成项后，实际新工具数组相对 bace 每请求恰少 122 B；完整 schema 深比较仅这两个 path description 出现位置不同。新 repeat 的 tools/guidance/catalog/tool-results/剩余项为 23,772 / 10,782 / 4,776 / 12,777 / 17,611 B；prepare 为 19,810 / 8,985 / 3,980 / 13,748 / 13,782 B。除工具定义外，其他组成项与 bace 的每请求字节完全相等，工具回合没有增加。两组净值已由独立安装后的实际 serializer 确认，不把先前各切片的百分比相加，也不外推真实模型质量、token 或 cold 延迟。

新两场外层及原生 Pi 均自然 exit 0，12 个已知进程已关闭；原 E→系统 Trash→E 保持 77 个原件快照 hash，consumer scratch 已移走，包与原件保留。两场 SDK 分别 5 次（2 list / 1 consume / 2 read）和 4 次（2 list / 2 consume），均无 CLI child、source HTTP、cancelled/failed SDK 或未闭合 EOF；11 次 HTTP 仅是 localhost serializer 观察，真实模型未运行。冻结输入与实际 daily3 不变。证据根 `/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/sc05-path-description-candidate-v2i8bk7v` 的 `actual-cost-comparison.json` SHA-256 为 `157f52aded33f77a633457d2d3731178f151de88c9803fcddb9cf0e8233bc4ce`，`window-release.json` 为 `f7f16cca9b2788ddb66690d082a50a3e74fe0ede53046fcad0782593538bdd21`。

同提交 CI run `42163570180` / job `127715000368` 为 SUCCESS：Check、installed Pi、Pi 1.4 compatibility、OMP/Tern artifact 和 package dry run 均成功；只用于失败留证的条件步骤正常 skipped。该根 `ci-42163570180.json` SHA-256 为 `2b5a029d81fe933a9bd50d42467908c545f34c2f4943543091ba01bd0d7e1e85`。本地不重复全套 CI；原六轮 5 PASS / 1 FAIL、早期不配对数据及真实模型失败保持各自结论。

### 普通启动配置

先用 `doctor --extension ABSOLUTE_ENTRY` 确认实际宿主，再冻结完整批次：

```bash
node scripts/skill-consumption-startup.mjs run \
  --extension /absolute/installed-or-candidate/src/index.ts \
  --evidence-root /absolute/startup-evidence \
  --list-delay-ms 2000 --cold-samples 5 --failure-samples 5 \
  --warm-samples 20 --timeout-ms 30000
```

有 5 cold-delay、5 cold-failure、1 warm-primer、20 warm，共 31 例。Warm 是 Broker catalog 已暖、Pi 新进程，不能和模型 driver 的 existing-session warm 混为一组。原生 RPC 使用 `waitForState:false`，提交时间在 RPC 写入前取得；不能先等 get_state 或目录再开始计时。首次 provider、任务结束及后台 source 终局分别记录。

任务结束不是后台观察完成。复查整批结束后的原始 source 与 owned-process 账本；迟到的 start、缺 close、观察器未结束、timeout 或 trace 截断都使该样本不完整。不能把收尾前的空 calls 写成零后台成本，也不能依据已有 median 宣称完整改善。保留原 timeout、SIGKILL 和所有慢样本。

### 真实模型配置

共同配置为 `{version:1,extension,database,prompt,expectedAnswers,counts:{cold:5,warm:20},packagePath?,toolProfile?}`，路径均为绝对路径。无 `modelContract` 时仍固定 `magpie/group/flash-free` 和 120000ms，不增加项目 retry 设置或状态握手；prefetch false。`toolProfile` 缺省或 `standard` 时保持原 read/bash/edit/write/grep/find/ls 七项；显式 `native-skills` 在这七项上增加 notion_list/notion_use，不移除正常工具，也不规定模型调用顺序；notion_ctl 按需发现，不进入默认 schema。显式 `legacy-skills` 才增加 skill_search/skill_prepare/skill_graph，用于旧包对照。拒绝未知或自定义工具组合。已注册工具不代表已经 active，仍须核对实际 provider 声明；不同 profile 的历史样本不能混成同条件比较。observer 不追加任务指令，也不替换返回值。

#### AH-639：显式日用模型路由合同

本轮使用同一 driver 的 `modelContract: "daily-route-v1"`，必须同时明确 `model: "magpie/group/flash"`、`thinkingLevel: "high"`、`rpcTimeoutMs: 300000`。`counts` 限定 `cold:1` 与 `warm:0|1`：`{cold:1,warm:0}` 是一次 cold 任务；显式 `warm:1` 才增加一次保留历史的续接。不是将 n1 外推为 p95 或正式全矩阵。比较 manifest 必须冻结相同四个字段和 counts；Doctor、plan、report 均保留共享纯 `dailyRouteContract` 生成的 `modelProfile` 及其 SHA，driver 和共享合同源码也进入运行期间的 hash 检查。旧无合同 manifest 及原失败记录不改写。

真实 run 只在新建 owned project 写 `.pi/settings.json`：`{"retry":{"enabled":false,"maxRetries":0,"provider":{"maxRetries":0}}}`。实际安装 Pi 的 `SettingsManager` 重读并核对 project trust、agent retry 与 provider retry 的有效值；模块和设置文件记录 bytes/hash，结束再核没有变化。控制器 retries 为 0、fallback 禁止，不发送会写全局状态的 `set_auto_retry`。这是本次批准的重试策略覆盖，不表示与原日用全部设置相等；用户 settings、models、auth 及旧失败保持原状。task 与 metadata selection 的 `NTN_SKILLS_SCHEDULER_ROOT` 均显式落在各自 owned `request-engine`，不借用日用调度状态。

每次 daily prompt 前先读取真实 `get_state` 并留最小状态原件，严格匹配 provider/model 和 high；不依赖不存在的 RPC retry 字段。初次或续接状态不符时保留失败且不提交 prompt。当前 baseline 仍只提供 cold/new、warm/existing；持久会话 resume 等入口由原 graph/场景 driver 验证，不新增另一套恢复平台。metadata-only `selection` 明确使用它原有的独立 controlled model，仅一个 `--model`，不混入 daily thinking/state 合同；其受控请求不算真实模型验收。

原成本 observer 在每个 `provider_request` 记录实际 hook context 的 provider/model、payload 的 requestModel 和 reasoningEffort；每个 assistant `message_end` 同条保存实际 provider/model/responseModel、thinkingLevel/providerThinkingLevel 与 reported usage。无字段时保留 null，不凭 args 或计划填值；responseModel 缺失时保留 null/unknown 并使 daily 路由合同失败，不用计划模型填值或猜测路由。daily 接受要求实际 wire body.model 精确等于 `group/flash` 或 `magpie/group/flash`，每个请求的 `reasoning_effort` 实际为 high，完整 payload bytes/hash 与唯一实际 HTTP body 对齐，并且实际 responseModel 与 usage 属于同一 turn/request。HTTP 必须完整成功，或具备下述独立 SSE 应用完成证明；原始 HTTP failure 不会改写为成功。缺 effort、身份不符、错配/重复 usage、缺失/重复 HTTP、无完成证明的 HTTP failure 或 body bytes/hash 不符均失败，阻止继续提交后续样本；正确答案不能覆盖模型合同失败。原请求、响应、失败与 not_run 全部保留。

原 `skill-consumption-model-baseline.test.mjs` 和 `skill-consumption-cost.test.mjs` 覆盖上述 config/manifest 正反例、metadata 参数隔离、实际 public run 控制器的受控 RPC 状态门、原 legacy 路径，以及逐请求模型/usage/wire 对齐。受控 RPC 只替换原运行入口的 RPC 边界；Doctor 与安装 Pi 的 SettingsManager 未伪造，测试不启动 Pi RPC、来源或真实模型。RED 与原组 GREEN 证据在 `/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/daily-route-baseline-5golykx8/`；这些结果证明验证接线，不代表真实 wire high、真实任务成功或日用交付已经通过。

初版先保留 6 条定向 RED，再原两文件 57/57 GREEN、0 skip；其中实际 provider 与 model 分字段校验，不能用拼接后相同的字符串消除身份差异。`red-complete.log` SHA-256 `e385417777b5e2b8414d10901cb16956deeed313b0c2d6925f0db452398d8c6d`；`green-full-final.log` SHA-256 `8090164be05ac095842b6820fdb17f2a4bcce332da48718b2ba05220f80c5c23`。错误状态原件、受控停止的 incomplete 报告与原日用失败均保留，未标为真实模型成功。

审阅随后发现：ctx 模型正确但实际 body.model 改成 worker，或 responseModel 缺失，初版 daily gate 仍可能误过。两条独立反例先产生 0 pass / 2 fail，再将实际 requestModel 限为上述两个精确值，并令缺 responseModel 的原始 null 保持 unknown/合同失败。`red-route-review.log` SHA-256 `75d75eab2923489cbef8006fa0257039d51964b02ad0bba1f1f73cd50833f2e3`；修后原两文件 59/59、0 skip，`green-full-v2.log` SHA-256 `f54969f7ececae65ac218743993659df765404dd8d9fdcc73cec634923066e14`。原 57 条结果和 v1 五文件快照保留为审阅前证据；正式交接以 `handoff-v2.json` 为准。

2026-11-06 的公共 full74 source freeze 已独立完成：74 owner、262 文件、2,324,517 原始字节；setup 账本为 449 次 HTTP attempts、105,847 request B、24,248,031 decoded response B、469,863.642417ms，Notion writes 和真实模型请求均为 0，wire bytes 仍未知。这是冻结输入准备费用，后续各臂任务费用须另记，不能用来源冻结成功替代 selected owner 的真实模型任务成功。原件为 `/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/sc20-full74-freeze-plan-qn4de427/execution-handoff.json`，SHA-256 `5082b2a3a5cad95124e8ab465c4e022c2c0fd0c8c8f4e4ca990e7881714d7bbf`。完整 74 库存和作者政策保持原样；实际任务选择另由其新冻结 manifest 明确，未运行方案维持 NOT_RUN。

### SSE 应用完成与 HTTP 取消的区分（AH-638）

用户入口仍是原 daily baseline `run`；驱动仍为安装 Pi RPC、原 cost observer 和原 Undici transport observer。实际 OpenAI SSE SDK 可以在收到完整 `[DONE]` 后取消尚未 HTTP EOF 的 response body。transport 的 `outcome: failure`、`errorCode: 20` 和响应字节必须照实保留，不能凭答案、finish reason、usage、HTTP 200 或 Pi 自然退出直接豁免。

原 `skill-consumption-provider.mjs` 在每次 `before_provider_request` 读取实际 model API；只对 model 请求、`openai-completions`、2xx、identity encoding 与 `text/event-stream` 的实际 body chunks 进行被动扫描。它不读取、替换或消费原 response stream，也不保留响应正文。扫描最多保留 16 B 行前缀和 65,536 B 事件上限的封顶计数，支持跨 chunk 的 LF、CRLF、CR；独立空行结束的事件必须恰有一条 `data:[DONE]` 或 `data: [DONE]`，允许注释，但不接受其他 event 字段、多 data、重复 DONE、截断或正文字符串中的伪标记。过大非终止事件丢弃后可继续识别下一独立事件；过大事件本身不提供完成证明。未知或压缩内容保持无证明。

`request_end` 追加 `modelApi`、内容类型枚举、脱敏 `errorName` 和 `sseCompletion`，原 `outcome/errorCode` 不变。原 provider 文件的纯 helper `providerApplicationCompletion` 只在实际 `AbortError`／数字 `20`、恰一个完整 SSE DONE 与同一请求的正常 `stop/toolUse`、实际 route 和正数 usage 同时成立时返回 `sse-done-before-http-cancel`。baseline 继续先核原 turn/request、唯一 wire body bytes/hash、真实模型身份、高 thinking 和 usage 关联；缺失或重复关联仍失败。旧证据没有新 proof 时维持原判定。

`modelHttp.successful` 继续只计原始 HTTP `completed` + 2xx。daily 另报 `modelApplication.completed/httpComplete/sseDoneBeforeHttpCancel/unproven` 和每请求的 `applicationCompletion`；应用协议完成、模型合同、任务内容验收分别保留，不能把 HTTP 取消描述为无错误传输。

| 协议目标 | 原断言与实际驱动 | 验收边界 |
| --- | --- | --- |
| 完整 SSE 后立即 HTTP EOF | 原 provider 组与已有实际 Pi loopback 对照 | HTTP 完整成功，原计数含义不变 |
| 完整 `[DONE]` 后 HTTP body 保持打开 | 原 provider/baseline 两组；实际安装 Pi 单请求 RED → GREEN | 原始 HTTP 仍 `failure/AbortError/20`，新增 DONE 证明允许单独记录应用完成，HTTP successful 必须为 0 |
| 完整正文、finish reason、usage，但缺 `[DONE]` 后断流 | 原两组包含正常 stop + code20 的强负例；实际 Pi 另用固定缺 DONE SSE 后断开 | 必须拒绝；已有文本、route 与 usage 不能代替协议结束 |
| finish reason 前断流及伪标记／截断／多 data | 原 provider framing/gate 断言 | 无终止证明；API、编码、状态、类别、error 类型或回复不符均不得豁免 |

本切片证据根为 `/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/sse-completion-boundary-dikjdh94/`。原两组 RED 为 51 pass／5 fail／0 skip（`red-two-groups.log` SHA-256 `689e252213cd5ce1943a3033e74aa7733e6295566e661089096452684a818f36`），GREEN 为 56/56、0 skip（`green-two-groups-01.log` SHA-256 `0c892900a04383d581e81fe4c3b01988cabe4094a74a668b9b4a0bd33de96d39`）。真实安装 Pi 的 `pi-red-done-http-open` 保留旧 gate 的唯一 `MODEL_HTTP_ATTEMPT_FAILED`；`pi-green-done-http-open` 保留同样原始 HTTP failure，但新增 doneEvents=1、应用完成 1；`pi-green-finish-usage-without-done` 的实际 route 和合成 usage 仍存在，doneEvents=0、`UND_ERR_SOCKET`、应用完成 0，按预定负例拒绝。三场各 1 次 owned loopback、每场总界限 30 s，0 来源／真实 provider／工具，均自然 EOF 0，owned agentDir 和网络边界独立，逐场 Evidence → system Trash → Evidence。受控 usage 固定为 17+5=22，只证明接线，不计真实成本。

此前真实 native 冷样本 `/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/sc20-daily-cohort-isxq6jpt/native-evidence/skill-model-cost-eDmgmC/` 未保存 DONE／errorName，原 `failed/incomplete` 和 warm `not_run` 永不追认或重写。本修复的受控成功不代表真实路由、后续新 cohort、private 内容 oracle 或日用交付已经通过。

两种 Source 入口独立冻结，已有 CLI 配置与历史结果继续有效：

| 配置 | 实际入口与方法 |
| --- | --- |
| 省略 `transport`，或 `transport: "cli"`；必须有 `command: [absoluteNode, absoluteCLI]` | 保留既有显式 CLI 账本 wrapper，Broker source.command 指向它；按原方法复现旧 CLI 基线 |
| `transport: "sdk"`；必须完全省略 `command` 属性 | Broker source.command 缺省，走实际包的默认入口：目录 listCatalog 与正文/资源消费都通过进程内 SDK。不能传 `null`、空数组或 wrapper 冒充缺省 |

SDK 模式的 Doctor 记录实际扩展树、`ntn-skills.mjs`、`ntn-skills-sdk.mjs`、`ntn-skills-runtime.json`、Pi executable 和可选 archive 的 hash；执行结束再次读取以检查运行期间是否变化。它不调用 SDK 业务方法，也不探测模型或 Notion 认证。配置文件中的 `extension` 应指向本次冻结包的实际入口；checkout source-tree 结果不表示独立安装包通过。

普通任务和 Skill 任务使用各自冻结的配置与证据目录，按下列真实 driver 命令串行执行。示例的 `sc10-model` 路径替换为本次创建的绝对目录；SDK 配置只增加 `"transport":"sdk"`，删除原 `command`，其余冻结条件保持明确记录。

```bash
node scripts/skill-consumption-model-baseline.mjs doctor \
  --config /absolute/sc10-model/ordinary-config.json
node scripts/skill-consumption-model-baseline.mjs run \
  --config /absolute/sc10-model/ordinary-config.json \
  --evidence-root /absolute/sc10-model/ordinary-evidence

node scripts/skill-consumption-model-baseline.mjs doctor \
  --config /absolute/sc10-model/skill-config.json
node scripts/skill-consumption-model-baseline.mjs run \
  --config /absolute/sc10-model/skill-config.json \
  --evidence-root /absolute/sc10-model/skill-evidence
```

前 5 个 cold 为独立进程和缓存；20 个 warm 是最后一进程内的普通续接，保留历史并计入 payload。答案谓词在 plan 中冻结；正常 stop、非空文本、预期答案子串且非许可提示是机器检查，语义正确性仍需审阅。length、aborted、error、空 final 和许可提示都不能算成功。首次失败后保留其余 planned 样本为 not_run，不换模型、任务、工具、TTL 或样本。

SDK 观测由 driver 为自有 Pi 进程安装 Node preload；父 PID、实际入口和主线程共同限定作用范围，CLI 继承 preload 环境时不会重复安装。它订阅公开的 `context-broker.notion-sdk` 与 Node child_process diagnostics，不替换 spawn/fetch/SDK，不改变 CLI argv。现有 `NTN_SKILLS_REQUEST_TRACE_LIMIT=10000` 已让显式兼容 bundled CLI 在 JSON 结果中附加 request_metrics，无须追加 `--metrics`。stdout 只在已有消费者、已经 flowing 且尚未读过数据时旁听；不调用 read/resume/pipe。最多在内存保留 16 MiB 以解析完整 JSON，写出的只有安全 metrics、字节/hash 和生命周期；未观察、溢出、非 JSON、缺 metrics 或缺 end/close 都保留未知。

成本报告按下列字段分别解释，不能相加成一个“调用次数”：

| 字段 / 层 | 口径 |
| --- | --- |
| `sdkStarts` / `sdkCloses` | SDK 桥公开 start/end 的数量；失败、取消和 pending 也保留。`sdkEntered` 只统计 end 明确回报 `sdk_started:true` 的调用，未结束不能据此推断没有执行 |
| SDK `files` | 固定名称解析复用 core manifest-only `listSkill`；独立计一次 SDK 操作，属于文件清单元数据，不能计作主文已读或漏记为零成本。原 graph 的 `sdk_calls` 与日用 HTTP 归因同样记录它，后者仍须独立 response request ID 精确匹配。实际 HTTP/bytes 仍取该操作完整 metrics；未知 operation 保持观察错误，不能降级成完整零请求 |
| `cliStarts` / `cliSpawnEvents` / `cliCloses` | 分别为观察到的 CLI spawn 调用开始、真实 child spawn 事件和 child close。退出码、signal、stdout 完整性单列；一次子进程可包含零次或多次 HTTP |
| `observedHttpAttempts` / `httpAttempts` | 前者为已记录 attempt 数；后者仅在所有相关 metrics、进程边界和最终复核完整时给出总数，否则为 null。缺 child、零 SDK starts 或空账本都不证明零 HTTP |
| Source bytes / waits | 沿用 request_metrics 的 request bytes、decoded response bytes、metadata/body/retained-body/write/provider 分类及 queue/retry 等待；缺字段不估算。TCP/TLS wire 始终为 null |
| Provider payload / usage / 模型 HTTP | hook 的 JSON bytes/hash、真实发送 entity 和模型报告 tokens 分开；首轮与总任务分别报告，包含后续 tool rounds 和 existing-session 历史 |

真实模型 driver 也在全批结束后重新读 source 与 owned host 账本，另存 reconciliation；没有任何 source 启动证据、EOF 前边界之外的 late start、缺失/重复 close 或缺 metrics 均不能成为完整零成本。sourceComplete 只描述已观察操作至最终复核的闭合；700ms quiet 不证明 metadata producer 已完成，不能用这个字段代替独立后台终态证据。

SDK 模式还要求被动 source observer 的真实 exit 终界、完整 hash 链与一一配对的操作/metrics。`sourceObserverComplete` 只证明这份观察器的生命周期闭合，不单独证明 HTTP trace 完整。无法归属到默认 bundled CLI 的子进程保持 unknown；不为使样本通过而屏蔽正常工具。SIGTERM 等未产生 exit 终界的情况照实记 incomplete，不补造结束事件。CLI 显式 command 与 SDK 默认入口必须在 plan 和比较报告中标明，不能只给旧结果改名便视为 SDK 基线。

未识别 child 的生命周期与其网络覆盖分开：记录稳定 child 身份、参数 hash、真实 spawn/error/exit/close，并验证配对；不记录 argv 明文或借 stdout 推断终局。直接 child 退出不证明后代网络为零，也不能把未知 source 费用改成完整。旧版只有 unmatched start 的 run 保持原 incomplete，不用新版观察逻辑回填。详见 [SC05 切片记录](../../../../packages/context-broker/docs/skill-consumption-guidance.md)。

### SC20 首个共同入口：纯 Pi 本地 read 对 Notion read

在同一 `skill-consumption-model-baseline.mjs` 中给新比较配置增加 `role` 与绝对路径 `comparison`。角色必须来自 `previous-broker`、`notion-candidate`、`pi-native-local`；比较 manifest 同时声明三个角色，但两组对照分别评估，未跑角色保留未跑，不能将旧 Broker 的改善百分比与本地对照相加。

首个共同任务限定为一个普通 Skill 的原生 `read` 检视：读取相同固定主文与预先声明的必需 UTF-8 资源，再回答相同普通任务。两臂不能在 prompt 中提前注入正文、资源答案、私有 oracle，或把 `$` / `/skill:` 展开当作原生 read。Notion 的自动 Requires 闭包、显式 use、Router 路由和原生 `/skill:` 展开分别分组；普通本地 Skill 没有自动 Requires 能力时，不能由脚本补读或隐藏注入来制造能力等价。

纯本地配置只含共同任务字段和比较身份，例如：

```json
{
  "version": 1,
  "role": "pi-native-local",
  "comparison": "/absolute/frozen/inspect-comparison.json",
  "prompt": "本次预先冻结的普通检视任务",
  "expectedAnswers": ["本次冻结的验收子串"],
  "counts": {"cold": 1, "warm": 1}
}
```

该角色拒绝 `extension`、`transport`、`command`、`database`、`packagePath` 和任何产品工具 profile；保留 Pi 的 read/bash/edit/write/grep/find/ls。它不加载 Broker、不创建 Broker source 配置、不调用 CLI 或 SDK。driver 使用 Pi 原生 `--skill` 加载冻结来源目录，并用 `--no-skills` 排除环境里未冻结的额外候选；普通认证继续沿用现有宿主环境，不复制 auth、不改用户全局设置。这里验证隔离名单中的 Pi 原生发现/read，日用全局 autoload 仍由安装规程验收。

Notion candidate 配置保留实际独立安装的 `extension`、archive、`database`、`transport:"sdk"` 与产品默认工具 profile，增加同一 `comparison` 和 `role:"notion-candidate"`。必须省略 `command`。比较使用 manifest 已冻结的真实 Default View；模型仍可按实际工具面决策。额外工具定义、guidance 和错误往返都进入累计成本，不能隐藏它们来降低结果。

既有单候选比较 manifest 版本 1 保持兼容，包含这些字段。所有 SHA 必须由原件计算，不能填写期望结果：

| 字段 | 冻结内容 |
| --- | --- |
| `roles` | 按顺序为 `previous-broker`, `notion-candidate`, `pi-native-local` |
| `intent` / `entry` / `model` | `inspect` / `read` / `magpie/group/flash-free` |
| `promptSha256` / `expectedAnswersSha256` / `counts` | 完整 prompt 的 UTF-8 SHA、`JSON.stringify(expectedAnswers)` 的 SHA、同一预先冻结样本数 |
| `notionSelection` | `{path,sha256}`，既有 graph `selection` 的实际 metadata-only `result.json`；必须 default SDK、ready、host closed、零 body/真实模型请求 |
| `notionProviderPayload` | `{path,sha256}`，上述同一 selection 原件中普通续轮实际收到 ready Default View 的完整 provider JSON；不能用 pending 或 assistant 引用替代 |
| `notionCatalogSource` | `{path,sha256}`，同一 selection 下实际 SDK `list` 原始 source receipt；必须完整授权目录、无 failed sources，与 selected record 一致 |
| `manifest` | `{path,sha256}`，独立保留的完整固定 snapshot manifest，包含 scope、record、snapshot/version、全部文件 SHA/bytes；与上述授权 scope/record 对齐 |
| `directory` | 本地冻结来源目录，仅包含该 manifest 的全部原始文件。导出容器元数据另外保留；不改 frontmatter、相对链接、Members 或正文 |
| `requiredResources` | 本任务必须完整交付的 1～16 个非主文路径；主文自动加入检视断言，资源必须是完整非空 UTF-8 文件 |

复用既有 `notion-skill-graph-model.mjs selection --config ABSOLUTE_CONFIG` 取得 metadata 原件；它使用独立 consumer 根，真实 metadata/setup HTTP 与后续任务分账。Source 固定树也必须来自独立冻结输入，不以准备基线为由预热将要测量的 Notion consumer。Doctor 只读这些已存在原件和本地 Pi loader，不再调用 Notion 或模型。

多候选目录使用同一 baseline driver 的版本 2。保留上表中的任务、模型、计数及资源要求，用以下字段替代单个 `manifest`：

| 字段 | 冻结内容 |
| --- | --- |
| `candidates` | 完整数组，每项为 `{recordId,manifest:{path,sha256},directory}`。实际 Notion View 的每个 owner 必须有一份精确 manifest 和完整原始文件树；原生 manual-only 也保留在库存中，不接受重复 owner、额外候选或少列候选 |
| `directory` | 原生目录根，各候选目录为互不重叠的直接子目录。根内只允许上述固定文件，不能生成替代 frontmatter 或目录 wrapper |
| `selectedRecordId` | 本任务选择的一个已授权 View owner。`requiredResources` 仅指向该 owner；其它候选的主文和资源不作为任务输入加载，不为原生 manual-only 目标补造可见入口 |
| `piVersion` / `viewId` | 本次实际 Pi 版本和既有 View ID。候选目录来自完整 View，不为比较创建或修改生产 View |
| `sourceFreezeSetup` | 可选 `{path,sha256}`，独立来源冻结回执；其 `setupCost` 与 metadata selection、后续任务三份账本分别保留 |
| `visibilityPolicy` | 缺省或 `strict` 保持同可见性合同；只有 v2 可显式使用 `native-default-policy` 比较两侧真实默认策略。未知值在 selection/Doctor 调用来源或模型前拒绝 |

Graph A/B 的 `selection` 仍要求单根目录，不改变它的验收条件。多候选预检在原 baseline driver 内使用独立空状态、实际安装 Pi 和默认 SDK：

```bash
node scripts/skill-consumption-model-baseline.mjs selection \
  --config /absolute/notion-selection-config.json --evidence-root /absolute/catalog-evidence
```

selection 配置使用 `role:"notion-candidate"`、安装包和默认 SDK，`comparison` 先指向包含完整候选树及任务 hash 的版本 2 输入文件。它以受控本地 provider 执行一次 `notion_list`，然后提交普通续轮；两个用户轮次的三个实际 provider payload 均与 HTTP serializer 对齐。首轮真实的 `ntn-skills-discovery status="pending"` 只表示发现尚未完成，不能当成空目录，也不能代替续轮 ready。来源只允许 SDK `list` 和 metadata HTTP；CLI 子进程、正文、远端写入、失败或未闭合操作均不满足预检。

成功输出的 `comparisonArtifacts` 给出 `notionSelection`、`notionProviderPayload`、`notionCatalogSource` 的实际路径和 SHA。将它们加入一份新的冻结 comparison 文件，供两个 arm 共用；保留预检原输入文件及失败回执，不覆盖原件。Doctor 独立核对 ready payload、SDK 完整 owner 集合、每份 source manifest 和原生 loader 的同一集合；只靠 receipt 的 `passed` 字段不能满足这些校验。metadata selection 不调用真实模型、不准备正文，也不建立后续任务 consumer 缓存。其成功只证明这份输入可比较。

默认 `strict` Doctor 用实际安装 Pi 的原生 loader 读取未改写的 frontmatter，并与已收到的 Notion provider 目录精确比较名称、描述和候选数量。所有候选都必须原生可见；`disable-model-invocation:true`、名称碰撞、不同描述、不同大小写或替代入口均不能自动归一化。原生与 Notion 的实际目录顺序分别保留，集合比较不改写它们。固定完整源树的 hash 同时约束正文中的 Members；此切片不把其后续路由或 Requires 执行算成双方共有能力。候选扩展/archive、所有 manifest 输入和来源树在执行结束再次核对，变化使该批 incomplete。

2026-11-06 用户在具体修订提案后确认继续，SC20 增加显式 `native-default-policy` 口径：保留完整 74 项授权库存、作者正文/资源和纯原生机制，将两侧真实默认可见性作为实验变量。它衡量两套默认工作流的全任务结果和成本，不能声称隔离了相同曝光条件下的 Broker 净开销；严格同可见性的结果仍单列。3 项 builtin 或受控测试目录不替代这份完整库存。

新口径仅放开已由作者 `disable-model-invocation` 与实际安装 Pi 的 `loadSkills`、`formatSkillsForPrompt` 共同解释的自动可见性差异。Doctor 仍核完整 owner 集合、每份 manifest/文件 hash、权限 scope、固定版本和原始名称/描述；不修改 frontmatter，不启用 `skillsOverride`，不追加隐藏目录或代读正文。全部作者条目都为 manual-only 时，库存仍完整、原生自动可见集合可为空；任务要求和必需正文断言保持原样，任务失败仍是失败。

`comparison.visibility` 保存 policy、`costQuestion`、`sameVisibleCandidates`、原生完整库存及两侧实际可见清单/差集；`nativePrompt` 保存官方 formatter 的文本、bytes/hash，仅用于 setup 证明，不注入模型。原 observer 的 `catalog` 按角色冻结：原生使用官方自动可见集合，Notion 使用完整实际 View。每次实际 provider 继续精确比对自己的集合，不能因为允许策略差异而跳过缺项、额外项、错误描述或正文完整性检查。新口径的 report 明列相同曝光下的 Broker 净开销为 `notClaimed`。

Pi 原生 loader 从实际 executable 所属的 package.json 定位，并核对该包声明的 bin 确实指向实际入口；不能把 `dist/bundle/cli.js` 的父目录误当整个 runtime 根。原生臂冻结完整 `dist`、package.json 与 `dist/core/skills.js`，结束时重新核对；runtime 或比较输入变化均把整批结果判为 incomplete。原 baseline test 中的 public Doctor smoke 使用真实 PATH、实际安装 Pi 和原生 loader，仅 source/selection 输入为受控 fixture，不调用 Notion 或模型，也不替代真实来源预检。

```bash
node scripts/skill-consumption-model-baseline.mjs doctor --config /absolute/native-config.json
node scripts/skill-consumption-model-baseline.mjs run \
  --config /absolute/native-config.json --evidence-root /absolute/native-cost-evidence
node scripts/skill-consumption-model-baseline.mjs doctor --config /absolute/notion-config.json
node scripts/skill-consumption-model-baseline.mjs run \
  --config /absolute/notion-config.json --evidence-root /absolute/notion-cost-evidence
```

inspection observer 的输入只有冻结文件身份与 SHA/bytes，不读正文预置答案。实际 native read 成功返回全部文本后，它才记住该内容，并要求同一 outer toolCallId 的完整 tool output 出现在实际 provider 请求中。details-only、partial、失败 read、另一 owner 的文件路径、换 call ID、assistant 引用或 tool arguments 均不能证明交付。两个路径的正文即使字节相同，也分别核对真实 read 身份，不能用一个文件冒充另一个。

Notion 臂沿实际 read receipt 核对冻结的 scope、owner、snapshot/version、路径与 File ID，并复用候选安装包的 resource projection validator 验证 `read.paths`；批量文件分别记录原外层 call 的完整 provider span，保持一次外层调用计数。原 scalar 和 batch 入口都保留，不能为了对照隐藏合法 schema。每个任务仍要通过冻结答案谓词并把主文和全部必需资源送达 provider，不接受 use/prepare 来冒充本项 inspect。答案谓词不代替独立语义审阅或已有 graph 权限/版本 oracle。

多候选检视只允许选择的 owner 贡献正文。原生 observer 识别未选候选的实际文件路径；Notion observer 同时保留已出现短引用、canonical owner 和实际 read receipt 的归属。成功读取未选正文使该次检视失败，即使所选主文和资源已经完整送达，或两个 owner 的正文恰好字节相同。失败 read 不冒充成功正文读取。每个实际 ready provider 目录仍核对冻结候选集合；初始 pending 可保留，额外候选、缺项和替换描述不能默默通过。

native 的零 CLI/SDK/来源 HTTP 只有在真实 observer 终界、host close、无产品调用、无 child starts、无 non-model Undici attempt、实际目录/schema 不含 Broker 的条件下成立。缺观察或未知 child 保持 null。`nativeFileReadResults` 和 `nativeFileReadBytes` 是实际完整 read 输出，filesystem syscall 数保持 null；文件本已存在、fingerprint/setup 可以暖 OS page cache，因此本地 cold 仅指新进程/新 provider 会话，不能宣称冷磁盘。

所有 provider 请求均计入 payload、tool schema、guidance/目录诊断 span、历史、工具轮次和 reported usage；诊断 span 会重叠，不相加成独立 token 分类。模型 HTTP attempts/发送 body hash 与 hooks 单独对齐。当前原 driver 仍仅驱动 cold/new 和 warm/existing 两种真实模型初态；expired、partial、fork/rewind/compaction 等完整 SC20 组合继续复用既有受控 driver 与各自真实门禁，不能把本切片标成完整矩阵通过。

共同 inspect 模型批次同时在每个 `process-N/provider-payloads/provider-M.json` 保存 `before_provider_request` 的完整实际 payload，并在 `cold-N-answer.json` / `warm-N-answer.json` 保存该 turn 的实际最终答案。它们是私有 Evidence，文件权限为 0600；只保存 payload 和答案，不复制 hook event、HTTP 认证 headers 或凭据。原通用 metrics/transport ledger 继续只含安全的 hash、字节和时序。所有原件的完整 bytes/hash、turn 和顺序须与 cost 事件一致；最终答案须匹配 `agent_end`。只有 owned host 关闭、观察器终界和写盘核验全部完成，成本报告才可完整；缺原件、额外原件、篡改、重复 cost 事件或缺终界均保持 incomplete。setup 旧 receipt 不因此升级为新的模型任务证据。

既定顺序是五个独立进程各一个 cold，最后一个 cold 成功后在同进程、同历史继续二十个 warm。每 turn 的 RPC deadline 为 120 秒，最多二十五次提交；任一功能、可用性或观察失败停止后续样本，不重试、不回退、不补数。`expectedAnswers` 的基础谓词不能代替完整任务语义审阅。审阅发现明确失败时，可在本次 evidence 根原子写入 `semantic-stop-request.json`：`{"version":1,"kind":"semantic-failure","sampleId":"cold-1","answerSha256":"原答案的64位SHA256","reason":"具体未满足的任务要求"}`。请求只能绑定本次已完成答案；runner 在当前自然 turn 终界后停止，保留原自动 outcome，并在 report 中单列语义失败及剩余 `not_run`。该入口不能修改 prompt/model、把失败改为成功或启动替代样本。私有 oracle 不进入模型。运行期间 driver、cost/transport/source observer 和请求账本 helper 的冻结 hash 也必须保持不变。

每个 owned Pi 进程关闭后，runner 在提交下一进程前核对 source、cost observer、model transport 和本次要求的完整 payload/答案原件终界。任一缺失或不完整都停止后续样本；已关闭的未知 child 仍使来源总成本保持 null，不能因 child exit 0 或模型已给答案继续采样。HTTP 200、模型最终答案/usage 与 HTTP 流终界分别记账：已捕获的 `request_end outcome:failure` 是失败终界，不能改成成功；没有 `request_end` 则连终界观察也不完整。真实 Native 首批曾在 cold-2 来源不完整后继续采样，原 report 与语义复核保留，不能用后续修复追溯改写；后续对照需明确绑定驱动版本差异。

本次定向验证保留了旧 driver 拒绝纯本地配置的 fail-before，随后覆盖完整投递、错误路径/partial/details/错误 call、缺失/篡改观察、未知 child、SDK/HTTP 和额外 Broker schema 等反例。实际安装 Pi 的受控 HTTP provider 检查走了两次 native read、三个 provider 请求，未加载 Broker，完整主文和资源到达实际 serializer。该受控结果证明驱动接线，真实 Notion、真实模型成本对照和完整 SC20 矩阵尚未由此成立。

该读取探针没有执行完整 comparison Doctor。安装入口审查随后发现错误的 `dist/bundle/core/skills.js` 路径，新增 public Doctor smoke 先复现失败，再按上述包归属定位修复通过。两份证据分别保留，不把早先的读取探针称为 Doctor 已通过。

`native-default-policy` 接线在原 baseline test 中先保留 RED（1 pass / 2 fail），修后定向 3/3、原文件 32/32。public Doctor 使用实际安装 Pi 的 loader/formatter 和受控三项来源，覆盖 strict 拒绝 manual-only、显式策略允许已证差异、全部 manual-only 时原生目录为空、未知策略、缺 owner、元数据与作者政策字节篡改拒绝；原 observer 另核每臂自己的实际目录。完整正文、未选正文、错误来源和终局负例继续通过。证据在 `/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/sc20-native-policy-uo2u1ket/`；`red-corrected.log` SHA `e909dcef78b0f52aa9dc0ee44afd26ba52bdd7a6b16fcc7f8f0a560255db777d`，`green-full.log` SHA `bab07b6a21daaed8ed33fefaab48a2658b19b8be8ff6f0913cbeb4f87e1ea393`。原件保留；这证明双口径接线，不代表真实 Default74 来源桥接、真实模型或 SC20 完整矩阵已通过。

## C9 冻结实测索引（2026-11-06）

以下原件均位于 `/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/`。产品固定为 C9 runtime `f1a4f872b39d45bff73d91c400fb08b845299006`、tar SHA `b4ed4cf1240db15b47e831096a848b6b6656f0764bca9c3f3bb2fe63ae4602a8`；验证源码为独立归档 `5a8221237319da0675231c0658828c944b8b750f`。不从当前 checkout 的未提交验证改动运行这些已冻结批次。

### 旧 Broker 与 C9 的受控比较

`sc20-c9-previous-interface-n6t4z8kw/plan.json` 冻结实际 Pi 1.4、serializer、39 份 fixture 文件、三份提示和目录语义。旧 Broker 使用原 PASS 原件，旧失败保留；新 C9 各场景运行一次，不重跑旧版本。完整比较、实际 provider HTTP 和清理引用见同目录 `handoff.json`，SHA `bbf1efd08e3338d0133c9dc80b56e36e3f21d914b29bf2105f69bab3c69cb68d`。

| 场景 | 旧请求体 B | C9 请求体 B | 各自差额 | provider / tools / rounds |
| --- | ---: | ---: | ---: | --- |
| native-repeat | 70154 | 64024 | -6130（-8.7379%） | 6 / 5 / 5，均不变 |
| prepare | 60791 | 55575 | -5216（-8.5802%） | 5 / 3 / 3，均不变 |

每景旧两次 metadata CLI 子进程变为零 CLI、两次 SDK list，正文交付次数不变。此处为 warm/offline fixture 和受控 provider，真实来源 HTTP 与远端模型均为零；不推导生产冷源延迟、实际 token、费用或模型质量。两个百分比分别归属原基线，不能相加。

### 完整库存与真实模型默认策略比较

`sc20-daily-v3-cohort-vgut6z_1/cohort-contract.json` 在首个提示前冻结两个 arm、private oracle-v3、模型和预算；`commands.json` 保留原 driver argv，`cohort-result.json` 为最终索引（SHA `fcfc14cb39a6892d986c1cf3f67346a3d9d5fab1d3f23b20c5496667b64b2f27`）。每臂 cold1 + 同会话 warm1，完整 74 owner / 262 文件 / 2324517 B 作者库存保持；共同任务必要三文件共 36900 B。实际 native 默认可见 22、Notion 默认可见 74，按 `native-default-policy` 作为实验变量记录。

| 样本 | 模型 HTTP | 实际请求体 B | tools / rounds | input / cacheRead / output | 提交至完成 ms |
| --- | ---: | ---: | ---: | --- | ---: |
| native cold | 2 | 85146 | 3 / 1 | 16740 / 5376 / 5199 | 10287.775 |
| native warm | 1 | 84586 | 0 / 0 | 524 / 21504 / 4801 | 5695.906 |
| Notion cold | 4 | 210947 | 3 / 3 | 27255 / 27904 / 5121 | 27347.766 |
| Notion warm | 2 | 224315 | 2 / 1 | 755 / 58880 / 3737 | 6774.732 |

九个实际响应均为 `deepseek-ai/DeepSeek-V4.1-Flash-1017`，请求 selector 为 `magpie/group/flash`、thinking high；控制器、宿主与 provider retry 均为零，没有 fallback。每轮原始 body 的 bytes/hash 与实际 wire 对齐。累计 native 169732 请求 B / 54144 total tokens，Notion 435262 请求 B / 123652 total tokens；费用 unknown。每格 n1，不报告稳定 p95。目录诊断 span 可以重叠，不将其加总为互斥 token 分量。

四样本的原 driver 技术与预算检查通过；三份必要正文在实际 provider 中逐字节相符，暖历史仍完整。Notion 暖轮两次资源工具返回 already loaded/available，没有再次交付全文。raw HTTP 与应用完成仍分列：native 一次 raw success、两次严格 SSE 完成；Notion 六次严格 SSE 完成且 raw success 为零。原取消 failure20 不改写。

Notion consumer 为五次 SDK / 零 CLI / 28 HTTP（22 metadata + 6 body），2589 请求 B / 3128175 decoded 响应 B、零写入。独立私有来源归属检查另有三次 metadata HTTP / 300 请求 B / 10282 decoded B；不混入 consumer 成本。`source-attribution/attribution.json`（SHA `3599e0263e3e26e70037b84daeabac3a93940b82e5a2428ce1c3376258384f7c`）用完整 owner 映射和固定 bundle/chunk 证明六次 body 均属所选 notion-api，其他 73 owner 正文读取为零；同 owner 两份未用资源的 18994 raw B / 23349 decoded 当前文件响应 B 单列 overfetch。native Agent 三次 read 为 36900 B，发现过程 syscall/物理读取字节仍 unknown。

独立语义审阅保留 native 两次 C5（formula 值只读表述）与全部四次 C6（results 批次语义及汇集步骤）的 NOT_PROVEN，其余 C1–C4/C7/C8 通过，Notion C5 通过。private oracle 未送入 consumer，也未在看到答案后改写。完整逐项内容、实际交付与原件 hash 见 `native-private-review/review.json` 和 `notion-private-review/review.json`。这些样本支持实际成本与交付观察，不能得出完整任务净收益、相同曝光下 Broker 净开销或 SC20 正式通过的结论；不以再次抽样替换失败。

`observed-cost-ledger.json` SHA `94e3c2692add507cae8914e568013467e2b0b5af392aa91a4ab8fbf0df351d51` 分列来源冻结、metadata selection、consumer 和私有核验。两臂原 Evidence→系统 Trash→Evidence 六步退出零、46 份 retained raw 保持，scratch 与 owned PID 消失；`ece/receipt.json` SHA `4ccda8cafa995347da2ad37d66a4d627e7cb6f4561b0328c557c03b25f24a54d`。可选 Trash 内容回读被 macOS 拒绝，记为 unknown，不尝试替代访问。旧 v2 首批失败及全部旧模型结果保持。

### C9 实际 compaction 的窄验证

`sc20-c9-compaction-x8nq4r2m/handoff.json`（SHA `20f34b246f735d1514a3cffbaff68f1e47eb0de03bd19a394cf86b93c670a7f8`）复用原 installed driver 的单个 `session-compaction` 场景：实际 Pi 1.5、受控 provider、既有 offline fixture；19 serializer 请求 / 179330 请求 B、三次工具、17 SDK（13 list 含三次取消 + 四次 consume），零真实模型/来源 HTTP。保留全文分支的下一 provider 仍有一份正文且零 body SDK；summary/forged 分支各恢复一份正文、各一次 body SDK。三次 compact 事件自身不调用 provider 或 body SDK，三个 Pi 自然退出零且 ECE 完成。这证明实际生命周期与交付恢复，不证明真实模型摘要质量。

这些窄证据不能替代尚待完成的 controlled HTTP 缓存/权限/取消交叉、SC21 正式模型路径或 SC24 日用切换；具体剩余项继续按 AH-638 与原对应 feature map 管理。

## Evidence 与比较

先读 plan，再读每例原件和 report。至少核对：

1. 实际 provider payload 与发送 body hash、所有模型 attempts 与每轮 reported usage。
2. 原生提交→首次 provider→有效文本→任务结束的单调时间；source 工作可延续至模型结束之后。
3. source 的独立操作清单、原始 request_metrics 和最终进程 spawn/close；不能以一份截断 trace 断言没有额外请求。
4. 附件 provider 下载与 retained Records ZIP 分开；provider=0 不等于没有 ZIP。单资源放大需精确 bundle/chunk、N/k、请求输出和本地物化 hash 证明。
5. 所有 passed、failed、blocked、not_run 与各自原因。n、observed、unknown、原值、median 都保留，少于 20 个可观察值不报告 p95。

`compareConsumptionRuns` 拒绝缺观察、换模型/任务/源版本/TTL/方法、遗漏 attempt、成功任务退化及候选未完成的结果。原始统计包含失败；comparable 仅表示证据和条件可比，不代表每例任务通过或成本改善。减少首轮文本但增加工具轮次必须单列，不能据首轮变小宣布总成本下降。旧 Gate B 只能作有 hash 的历史解释。

## Cleanup

Source 与真实模型 driver 有归属检查的可逆 cleanup：

```bash
node scripts/skill-consumption-source-baseline.mjs evidence --run /absolute/frozen-run
node scripts/skill-consumption-source-baseline.mjs cleanup --run /absolute/frozen-run
node scripts/skill-consumption-source-baseline.mjs evidence --run /absolute/frozen-run

node scripts/skill-consumption-model-baseline.mjs evidence --evidence /absolute/model-run
node scripts/skill-consumption-model-baseline.mjs cleanup --evidence /absolute/model-run
node scripts/skill-consumption-model-baseline.mjs evidence --evidence /absolute/model-run
```

在 cleanup 前保存全部既有证据 hash，之后逐份核对。原件、plan、失败 stdout、固定 snapshot 副本和 partial 原对象备份均保留。cleanup 成功不改变 functional status。

Startup driver 的每个 case 混合运行文件和证据，没有整目录 cleanup 命令。只将 plan/原件明确证明属于该 run 的外部 probe、alias 根列入清单，检查真实路径、进程状态后用 `/usr/bin/trash ABSOLUTE_PATH` 回收；不得按目录前缀、mtime 或进程名猜测归属。缺终局必须注明，不补造 exit code，无法证明安全的路径保留。

