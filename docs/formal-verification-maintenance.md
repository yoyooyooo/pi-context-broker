# 形式化验证维护合同

维护仍对应当前实现的有限模型、真实守卫和独立规则清单。模型结果、实现测试、安装包与真实服务各有边界；不建立内容版本管理，也不在仓库累计历史验证成绩。

## 所有权与运行路由

| 当前领域 | 入口 | 套件与边界 |
| --- | --- | --- |
| Broker 资格、Library、菜单与交付 | verify-notion-consumer-state | observations 的 Availability/ReadRace；consumer-state 的 FreshnessPublication/SelectionGraph/DeliveryBoundary/RecoveryClosure/LibrarySession/MenuPublication |
| CLI 请求引擎 | CLI verify-notion-consumption | CLI 原 request-engine runner；预算、取消与请求调度由其 owner 维护 |
| 当前管理、来源与消费 | 各仓既有领域测试和 integration Skill | current operation、SDK、import 失效与实际包检查；不由已退役模型代证 |

完整路由见 [验证交接表](verification-routing.md)。跨域变更执行相交的必要检查，不新增全链路总验证 Skill。SDK v3 消费恒零语义写入；旧隐式 retention、readOnly 开关和独立管理回执接受流程已退出形式化入口。

## 结果合同

每套 coverage 的 `cases.expected_rules` 是独立审阅的完整清单，含安全性、已声明的时序性质和 NoDeadlock。不得从变更后的 config 自动生成期待。正例 broken 为空；故意破坏的负例要求 broken 集合精确一致，多一条或少一条均失败。

既有 runner 先核 protected source bytes、固定 TLC 和完整 statechart 工具字节，再执行当前输入。缺工具、语法错误、工具异常、超时、cut、未检查规则和不完整结果均失败。读取报告和原 TLC 结果，不能只看退出码。

正式 model runner 接受真实 Git checkout，或官方 paired command 的封存源码。
无 `.git` 时，复用 CLI 的 `formal_source_identity.py` 校验 run/build manifest、原始
commit、源清单及受保护源码、模型、配置和 runner 的实际字节。开发 overlay 不属于
选中 build，仍被拒绝；不能补造 HEAD 或把开发回放当作最终候选证明。

输出使用仓库外新建或预建的空绝对目录；mutation 输出自身须不存在。失败诊断保留在本轮输出，下次用新目录。真实 mutation 在隔离副本内要求 baseline 通过、行为断言失败、精确恢复后通过，并核 active checkout 未变；装配或解析错误不能代替行为检出。

## 变更复验

| 变更 | 审阅和必要检查 |
| --- | --- |
| view/展示 | 不隐藏性质相关状态、退出或最短坏路径；执行该模型全部配置，实际生成并检查所展示的图 |
| 模型/config/性质 | 核原子步骤、有限域、环境、公平性、完整规则和独立负例；执行受影响模型全部配置 |
| 实现/受保护测试 | 追到真实 owner、caller 和 guard；运行相关代码回归、真实守卫破坏/恢复及对应模型 |

源码漂移默认阻断。先读 diff、判断模型映射或产品缺陷，再更新精确 hash。仅刷新 hash 不算审阅。source coverage 只绑定实际状态 owner、守卫和必要测试；包 pin/build、指导文案与安装配置由各自集成检查负责，不伪装成有限模型的证明前提。

### Skill 引用与固定文件

Skill 引用 v2 使用完整 root URI 表达 Library 与稳定 Skill ID；资格模型中的 scope 仍是来源和授权范围，不能被 URI 的 `library` 参数替代。实际入口先用配对 CLI 的纯协议解析，再进入现有资格、选择和交付守卫。Notion 页面地址的当前查询与实际物理权限拒绝保留独立证据，不能把形似 UUID 的 Skill ID 解释成页面。

固定文件按选定 owner、snapshot 和精确 path 查 manifest。原生 File ID 只作为内部 binding，Source 文件可以没有对应 File 行。短引用的同一路径不能换绑另一 File ID，同一原生 File ID 也不能在同一固定 owner 下改路径。`check-consumer-state-mutations.mjs` 的两项 `fixed-resource-*` 检查直接破坏这两个实现守卫；报告以 `concrete_obligations` 标明其边界，`properties` 为空。既有有限 TLA 未建模 File ID 与路径的对应关系，不从模型通过推导这个关系正确。

两套 coverage 的 `current_review.skill_reference_v2` 记录实际 owner、caller 和回放对应。URI 文法、Library 绑定、Source 相对路径及所选包字节分别由 CLI 引用模型、协议和集成测试验证；这里保留原有模型、独立规则清单和负例。

### Library 的 branch 与 turn 绑定

LibrarySession 复用 consumer-state runner，增加一个正例和十个故意缺陷配置。
先验证选择，再保存当前 branch 的默认 root；已接纳的 turn、完整 ref 的单次目标、
目录 ticket 与原固定 pin 保持各自所有权。选择 B 不等于取消 A。
独立 oracle 保存原 A turn、A producer payload、parent branch 的 A 和旧 A pin，
不从可变默认值反推预期结果。

`library-selection.ts` 的 active branch、每次 input 本地选择、失败 blocked、
publication ticket 与 command session 守卫，以及 `host-skills.ts` 的 running turn
优先上下文，共对应六项 `library-*` 真实 mutation。coverage 只记录审阅过的字节与
对应关系；模型和 mutation 是否通过，以同一候选实际保留的运行结果为准。

有限模型只包含默认主 Library 与一个显式跨库调用。同轮多个 `$name@source`
选择各自已配置的 Source，不改变默认；无 `@source` 名称只查当前默认 Library。
这些组合、UUID/URL 入口、同名实际字节和 Pi 序列化由消费/集成层核验。
CLI 根身份、四表物理 parent、root CREATE 与原 pending 寻址沿其 LibraryLifecycle，
不在 Broker 复制一个初始化协议。

## CI 和 Skill

`.github/workflows/formal.yml` 运行 observations 与 consumer-state 两个 suite，沿同一 runner 和独立规则清单。短期 artifact 保存本次报告、输入、原 TLC 和 Mermaid；不维护多份旧图或历史成绩。远端结果以具体提交的实际 workflow 为准，本地通过不能代替远端 CI。

优先扩已有 owner 的模型或测试。新增独立 guardian 必须有独立维护边界和实际反例需求；不能只为聚合结果新建平台。模型退役时同时删除专属 runner 路由、Skill、图册和悬挂引用，将仍有效的实现检查放回其真实 owner。Git 保留代码演进，不用产品内版本层或旧证明账本维持过渡设计。

Skill 指令评估与作者测试分开：新 agent 按任务和入口执行所选切片；未做时写 `instruction_evaluation:not_run`。模型或工具未完成则明确 blocked/failed，不把文档完整当作通过。

## 图形产物定位与复现

模型命令输出 `chart.mmd`、`report.md` 和原 TLC；SVG 是独立的 Pele 渲染步骤。使用 `pele@1.9.0` 的已验证外部安装，`PELE_MODULE` 指向它的 `dist/pele.js`，不用更换模型检查器。当前 Pro 已安装路径为：

```sh
export PELE_MODULE=/absolute/renderer/node_modules/pele/dist/pele.js
export FORMAL_CHART=/absolute/current-run/Model-config/chart.mmd
export FORMAL_SVG=/absolute/new/chart.svg
```

`PSTACK_STATECHART_ROOT` 继续指向 tool-lock 验过的安装。下面直接使用 Pele 的公开 render API；样式读取该安装的 `references/render.md`，不手工重画 Mermaid：

```sh
node --input-type=module <<'RENDER'
import fs from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const sha = value => createHash("sha256").update(value).digest("hex");
const modulePath = process.env.PELE_MODULE;
if (sha(fs.readFileSync(modulePath)) !== "7c40a25eeaf4370fb56c03d9d8f6780051c9c39b6c6ca36d53239075117097f5")
  throw new Error("Use the reviewed Pele 1.9.0 bytes");
const { render } = await import(pathToFileURL(modulePath));
const mmd = fs.readFileSync(process.env.FORMAL_CHART, "utf8");
const reference = fs.readFileSync(process.env.PSTACK_STATECHART_ROOT + "/references/render.md", "utf8");
const css = reference.match(/```css\n([\s\S]+?)\n```/)[1];
const result = render(mmd, { limit: 1000000, outputLimit: 8000000, maxEdges: 10000 });
const svg = result.svg.replace(/(<svg\b[^>]*>)/, "$1<style>\n" + css + "\n</style>");
fs.writeFileSync(process.env.FORMAL_SVG, svg, { flag: "wx" });
console.log(JSON.stringify({ mermaid_sha256: sha(mmd), svg_sha256: sha(svg),
  stylesheet_sha256: sha(css), width: result.width, height: result.height }));
RENDER
```

展示前检查 SVG 的布局与文本，确认它与原 Mermaid 同源；在本次输出中保留对应 summary、输入和配置身份。图面文字不能误称实际 wire、权限或任意模型的最终回答。DeliveryBoundary 保持原有阶段区分：logical-only 的 2xx 或进程内 mock 不是最终传输证明，不为此新增 TLA。TLA tuple 在 view 中是从 1 开始的对象（例如 `v.selected[1]`），不能用数组字符串转换推断 pin 身份。复杂生命周期可在 view 中聚合，仍须保留最短坏路径和退出；图面修订后复跑受影响模型组的全部配置。
