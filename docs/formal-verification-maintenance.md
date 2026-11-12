# 形式化验证维护合同

AH-1006 把现有有限模型接入持续维护。仓库中的 TLA/config/view、独立规则清单和源码对应是可执行事实；Notion 项目入口解释状态和边界，Linear 跟踪需要实施的变更。三者引用同一提交和运行身份，不相互替代。

## 领域所有权与运行路由

| 领域 | 所有者 | 原运行器套件 | 触发边界 |
| --- | --- | --- | --- |
| CLI 资源生命周期 | verify-notion-resource-lifecycle | lifecycle | 正文归属、导入、原操作选择、只读审计 |
| CLI 原操作恢复与独立接受 | verify-notion-operation-recovery | operation-recovery | ACK/Records 前缀、未知原操作、独立接受、业务反馈 |
| CLI 请求引擎 | verify-ntn-skills 的 request-engine-formal feature | request-engine | producer ownership、取消、共享身份、queue/operation/attempt 预算与重试 |
| Broker 当前资格与交付 | verify-notion-consumer-state | observations、consumer-state | 观察时间与资格、固定图、会话/取消、真实交付证明边界 |
| 跨系统交接与 effects | verify-notion-skills-integration | flows | 完整管理回执、两来源部分失败、累计效果、严格只读、受控报告 |

不新增全链路总验证 Skill。跨域变更由原集成 Skill 核对输入输出合同，并请求具体领域 owner 复核；一个领域通过不自动构成另一领域或真实 E2E 通过。

## 每次结果必须能回答什么

每组 coverage 的 `cases.expected_rules` 是独立审阅过的完整规则名清单，包含安全性、已声明的时序性质和 `NoDeadlock`。配置删掉一条性质也必须失败，不能从变更后的 config 自动生成新清单。正例要求 broken 为空；历史和故意破坏的负例要求 broken 集合精确一致，多一条或少一条都失败。

原运行器先核对 protected source bytes、固定 TLC jar 和 statechart 的 31 个工具文件，再快照本轮模型输入。`summary.json` 保存 checkout/source commit、运行器与合同 hash、coverage/tool-lock/source hash、每项 TLA/config/view hash、完整规则结果与探索状态。缺工具、语法/解析错误、工具异常退出、超时、cut、未检查规则、错误性质和不完整结果均不得视为通过。读取原始 `report.md`、TLC 输出和生成 `chart.mmd`，不能只看 shell exit 0。

模型输出必须是新建或预先创建的空绝对目录。真实 mutation 的输出要求按各入口执行；effects/consumer 入口要求输出目录本身尚不存在。每次失败保留原目录，下次改用新目录；不覆盖 summary，不把旧失败重写成成功。实际 mutation 在独立副本或独立工作树进行，必须记录原件通过、真实行为断言失败、精确恢复后通过及原工作树未变。语法错误或装配失败不算成功捕获守卫。

## 三类变更的复验义务

| 变更 | 必须审阅 | 最小必要复验 |
| --- | --- | --- |
| 仅 view 或展示文字 | 聚合是否保持原可达关系、退出与最短坏路径；未隐藏性质相关状态 | 同一受影响模型全部原正负配置、重新生成 Mermaid/Pele SVG、视觉检查和新图 manifest |
| 模型、配置或性质语义 | 原子步骤、有限域、环境与公平性假设、所有完整规则及独立负例 | 受影响模型全部配置；新增性质必须可由相应坏行为打破；更新源码对应说明 |
| 实现语义或受保护测试 | 实际函数/调用方、原始 authority、回执与代码 guard；属于模型漂移还是产品缺陷 | 当前源码回归、相关真实 guard 破坏/恢复、受影响模型；跨域时加最小组合回归 |

源码漂移默认阻断。哈希不是自动放行开关：先理解差异，再更新模型/映射或明确未建模边界，最后记录已审阅的源码基准和精确 hash。只更新 hash 不满足维护合同。纯测试新增需说明它检查哪个实际行为，不能默认为产品语义改变。

## CI 与证据留存

`.github/workflows/formal.yml` 按仓库的三个领域矩阵执行；相关源文件、模型、配置、view、清单、运行器、Skill、依赖或 workflow 变化均触发。每个 job 固定工具字节并执行完整套件，默认入口与 `--model` 选择性入口共用同一实现。`formal-*` artifact 保留 summary、输入快照、原报告、原 TLC 与 Mermaid。CI artifact 是短期运行原件，最终审阅清单与精选生成图随 git 提交保存；原 Pro 回放目录继续保留。

CI 是否通过以该具体提交的实际 workflow 结果为准，不能由本地执行推断。变更只建模已有实现时，不据此声称发布、安装、生产库存操作、真实 provider 或日用 E2E 再次通过。

## Skill 的成立与退役

新增 guardian 必须有明确代码 owner、独立正负模型、真实守卫回放、可发现的现有入口和一次无作者上下文的冷启动执行。冷启动范围按实际选择记录；只跑一个切片不称为整个领域的新完整回放。模型/工具不能执行时保留 draft/blocked，不以文档完整代替通过。

后续新增 guardian 的理由应是稳定、独立维护的状态边界和不同触发范围；同一 owner 内增加一个模型或 feature 通常足够。替换旧模型时先迁移入口、覆盖与历史引用，再明确退役旧入口；旧反例和旧 operation 的事实继续保留，不删除它们来制造整洁。


## 图形产物定位与复现

模型命令输出 `chart.mmd`、`report.md` 和原 TLC；SVG 是独立的 Pele 渲染步骤。使用 `pele@1.9.0` 的已验证外部安装，`PELE_MODULE` 指向它的 `dist/pele.js`，不用更换模型检查器。当前 Pro 已安装路径为：

```sh
export PELE_MODULE=/Users/yoyo/Documents/code/personal/verification-evidence/notion-skills/formal-planning-20261108-4fx3wnpv/renderer/node_modules/pele/dist/pele.js
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

展示前检查 SVG 的布局与文本，确认它与原 Mermaid 同源；把上述 hash、对应 summary/input hashes 和配置身份记入图册 manifest。图面文字不能误称实际 wire、权限或任意模型的最终回答。TLA tuple 在 view 中是从 1 开始的对象（例如 `v.selected[1]`），不能用数组字符串转换推断 pin 身份。复杂生命周期可在 view 中聚合，仍须保留最短坏路径和退出；图面修订后复跑受影响模型组的全部配置。
