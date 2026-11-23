# 已执行主分析结果核对

范围仅为 followup11 与 Own 已执行三条。结论沿用 collector、normalizer、analysis、scoring 1.1.0，全部 reanalysis_of 为 null。本次读取已有判定和证据状态，没有重评分或重读私有 oracle。

## 可公开摘要

模型以原报告逻辑 ID `m0`、`m1` 表示；环境使用 `broker-current`、`native-current`、`own-candidate`、`own-reference`。下列摘要不包含 Provider 路由、主机、凭据、机器路径或任务答案。

Followup 的 11 条全部 admission valid。业务输出 9 pass、2 fail；整体结果为 1 pass、2 fail、8 unknown。Own 三条中，两条 admission valid、业务 pass、整体 unknown；第三条 admission invalid、整体 not_applicable。Own 第三条不计为一次有效业务失败。

## Followup 两个业务失败

`008` 与 `009` 是同一个 `task-switch-01-a-n16-r2` 配对案例，family 为 `task-switch`，模型逻辑 ID 为 `m1`。`008` 使用 `broker-current`，`009` 使用 `native-current`。

两条都通过 `business-replenishment` 和 `inventory-policy-read`，都在关键合同 `business-expense-groups` 失败。原始理由仅确认已观察到的业务值不满足声明的输出合同，证据 ID 为 `artifact-2`。这不是交付物缺失；主分析没有给出字段级差异。本次未读取答案或重新评分，不能进一步归因为某个金额、分组键、舍入规则或脚本错误。两条还保留 `legal-selection=unknown`，但已确认的关键业务失败决定了原始 overall fail。

它们是一个配对案例在两个环境中的观测，不能作为两个独立案例，也不能据此认定某一环境独有的缺陷。

## Followup 八个 overall unknown

以下八条的业务合同都 pass，关键失败列表均为空。表格中的 unknown 表示原 1.1 证据尚不能确认相应合同，不能直接解释为操作没有发生或产品行为错误。

| Run 后缀 | Case ID | 模型 | 环境 | 保留的 unknown 合同与理由 |
| --- | --- | --- | --- | --- |
| 001 | scripts-assets-01-a-n16-r1 | m0 | native-current | manifest-data-read：未观察到完整合法资源路径；legal-selection：选择证据不完整 |
| 002 | implicit-01-a-n16-r1 | m1 | native-current | legal-selection：选择证据不完整；routing-policy-read 已 pass |
| 004 | ambiguity-01-a-n16-r1 | m0 | broker-current | clarify-delivery-mode：澄清证据不完整，无法确认声明的次数上限；资源读取和选择均 pass |
| 005 | ambiguity-01-a-n16-r1 | m0 | native-current | clarify-delivery-mode：无法确认澄清次数上限；legal-selection：选择证据不完整；资源读取已 pass |
| 006 | implicit-01-a-n16-r1 | m0 | native-current | legal-selection：选择证据不完整；routing-policy-read 已 pass |
| 007 | implicit-01-a-n16-r1 | m0 | broker-current | routing-policy-read：未观察到完整合法资源路径；legal-selection：选择证据不完整 |
| 010 | equivalent-01-a-n16-r1 | m0 | native-current | legal-selection：选择证据不完整；tax-source-read 已 pass |
| 011 | equivalent-01-a-n16-r1 | m0 | broker-current | tax-source-read：未观察到完整合法资源路径；legal-selection：选择证据不完整 |

这些原因相互重叠：八条中七条存在 selection unknown，三条存在 resources unknown，两条存在 clarification unknown。`legal-selection` 在原记录中标为非关键合同；002、006、010 的唯一 unknown 合同就是它，整体结果仍记录为 unknown。这里原样保留该结果，不自行改为 pass。

唯一整体 pass 是 `003`：`implicit-01-a-n16-r1`、m1、broker-current，业务、资源读取和选择合同全部 pass。

## Own 前两条

`001` 与 `002` 是同一个 `continuation-01-a-n16-r2` 配对案例，family 为 `continuation`，模型逻辑 ID 为 `m0`。`001` 为 own-candidate，`002` 为 own-reference。

两条的 `business-routes-1` 与 `business-routes-2` 均 pass，表示主分析确认两轮业务输出满足已声明合同。两条的 `routing-policy-read` 均 unknown，理由为未观察到完整合法资源路径；`legal-selection` 也均 unknown，理由为选择证据不完整。故原始 overall 都保持 unknown、verified_success=false，没有确认的关键合同失败。这只能说明当前 1.1 证据不足以确认完整过程，不能据此认定业务失败，也不能认定两种产品整体通过或等价。

`003` 是 `explicit-01-a-n16-r1`、m0、own-reference，admission 原因明确为 runtime_not_a_business_episode:admission_rejected 与 task_admission_not_accepted。归一化记录中的缺失交付物等失败项仍保留，但它不是有效业务执行；overall 为 not_applicable，不加入业务失败率。

## 解释边界

这 13 条有效执行的 attempts、tools、interventions 核心完整性均为 complete。核心记录完整与资源、选择、澄清合同的可验证性是不同层次，不能互相替代。全部 14 条已执行记录的 input_total、output_total 和 actual_attempts 都标为 known，因此这里的 overall unknown 不是 token 用量未知。第三条 Own 的零值不用于本收据单独推断实际发送情况。

Followup 保留原科学分母 32，本报告只含这 11 条，原 21 条仍由原 owning report 独立保存。Own 保留科学分母 20，仅执行三条，2 valid + 1 invalid，另 17 条未执行；分析中的 18 unresolved 是 17 未执行加 1 无有效结果的位置。不能把这些未执行位置记成业务失败，也不将两份报告合并重评分。

collector 1.2 的可选分析未在本次读取或使用。此摘要不建立产品优劣、等价或非劣结论，不改变任何停止状态或执行权限。

## 来源绑定

| 来源 | SHA-256 |
| --- | --- |
| Followup analysis-input.json | 66ba210476eb0cb359834758a8419589bcd196b3dd84d0f41d4e83f873e404d7 |
| Followup analysis.json | eab7367d80561b2f72ad3156b863f04d3122b72b3044bd2d490b236ffb18bd96 |
| Own analysis-input.json | fee4af52c540f220aae288db875ec1f85ea2ec84b6ee1856d2ec83420e8ac670 |
| Own analysis.json | c4f47ee018e48b3402d7dac8fcabee1c41a292d350ef3d065d0c0ccc8dc15825 |

上表绑定原始主分析文件的字节 SHA；公开脱敏副本使用自己的文件与语义 SHA。逐条合同理由可在[补齐公开输入](../benchmark/results/2026-11-23-accepted-continuation-stop/unstarted-followup-11/analysis-input.json)与[自有产品公开输入](../benchmark/results/2026-11-23-accepted-continuation-stop/own-confirmation-stopped/analysis-input.json)中按 run ID 核对。私有只读核对收据 SHA 为 `126ac7588594574a059a4c59e4474817767c417ebe4149323b1ba71f00beefdd`，它没有重新评分。
