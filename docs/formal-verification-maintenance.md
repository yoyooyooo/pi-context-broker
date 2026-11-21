# 形式化验证维护合同

维护仍对应当前实现的有限模型、真实守卫和独立规则清单。模型结果、实现测试、安装包与真实服务各有边界；不建立内容版本管理，也不在仓库累计历史验证成绩。

## 所有权与运行路由

| 当前领域 | 入口 | 套件与边界 |
| --- | --- | --- |
| Broker 资格与交付 | verify-notion-consumer-state | observations 的 Availability/ReadRace；consumer-state 的 FreshnessPublication/SelectionGraph/DeliveryBoundary |
| CLI 请求引擎 | CLI verify-notion-consumption | CLI 原 request-engine runner；预算、取消与请求调度由其 owner 维护 |
| 当前管理、来源与消费 | 各仓既有领域测试和 integration Skill | current operation、SDK、import 失效与实际包检查；不由已退役模型代证 |

完整路由见 [验证交接表](verification-routing.md)。跨域变更执行相交的必要检查，不新增全链路总验证 Skill。当前 SDK v2 消费恒零语义写入；旧隐式 retention、readOnly 开关和独立管理回执接受流程已退出形式化入口。

## 结果合同

每套 coverage 的 `cases.expected_rules` 是独立审阅的完整清单，含安全性、已声明的时序性质和 NoDeadlock。不得从变更后的 config 自动生成期待。正例 broken 为空；故意破坏的负例要求 broken 集合精确一致，多一条或少一条均失败。

既有 runner 先核 protected source bytes、固定 TLC 和完整 statechart 工具字节，再执行当前输入。缺工具、语法错误、工具异常、超时、cut、未检查规则和不完整结果均失败。读取报告和原 TLC 结果，不能只看退出码。

输出使用仓库外新建或预建的空绝对目录；mutation 输出自身须不存在。失败诊断保留在本轮输出，下次用新目录。真实 mutation 在隔离副本内要求 baseline 通过、行为断言失败、精确恢复后通过，并核 active checkout 未变；装配或解析错误不能代替行为检出。

## 变更复验

| 变更 | 审阅和必要检查 |
| --- | --- |
| view/展示 | 不隐藏性质相关状态、退出或最短坏路径；执行该模型全部配置，实际生成并检查所展示的图 |
| 模型/config/性质 | 核原子步骤、有限域、环境、公平性、完整规则和独立负例；执行受影响模型全部配置 |
| 实现/受保护测试 | 追到真实 owner、caller 和 guard；运行相关代码回归、真实守卫破坏/恢复及对应模型 |

源码漂移默认阻断。先读 diff、判断模型映射或产品缺陷，再更新精确 hash。仅刷新 hash 不算审阅。source coverage 只绑定实际状态 owner、守卫和必要测试；包 pin/build、指导文案与安装配置由各自集成检查负责，不伪装成有限模型的证明前提。

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
