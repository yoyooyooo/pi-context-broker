# 资源读取重分析：原工程34条，零新增执行

本发布复用同一批原始观察，collector 1.2.2 将完整合同清点从21P/2F/11U修正为29P/0F/5U。六个scope各自保留原固定分母与统计边界，合计不是跨scope质量率。原34条业务结果、226次模型请求、1,275,266 input /20,583 output与实际duration均不变。新增真实模型请求、观察和科学注册为0。

[阶段报告与产品决定](../../../docs/benchmark-relative-source-reanalysis-2026-11-26.md) · [逐条差分](comparison.json) · [实际资源](observed-resources.json) · [成本诊断](cost-diagnosis.md) · [公开定位](cost-diagnosis.json) · [验证摘要](verification.json)

原发布和第一次重分析都保留身份。两条原grant-chain-read依次为fail→unknown→pass；中间1.2.1只覆盖26条，另8条没有伪造中间版本。原件与私有grader在受控离线重分析中重读；本公开replay仅验证脱敏文件/定位器和normalized统计，不运行私有grader、不还原私有raw链、不调用provider。

## 按scope读取与复算

| Scope | 报告 | 复算 |
|---|---|---|
| CodeMode 四条件 | [report](packages/codemode-24/report.md) | [replay](packages/codemode-24/replay.mjs) |
| Implicit · 64 候选 · 1 轮 | [report](packages/scale-implicit-n64-r1/report.md) | [replay](packages/scale-implicit-n64-r1/replay.mjs) |
| Implicit · 256 候选 · 1 轮 | [report](packages/scale-implicit-n256-r1/report.md) | [replay](packages/scale-implicit-n256-r1/replay.mjs) |
| References · 16 候选 · 2 轮 | [report](packages/scale-references-n16-r2/report.md) | [replay](packages/scale-references-n16-r2/replay.mjs) |
| References · 16 候选 · 4 轮 | [report](packages/scale-references-n16-r4/report.md) | [replay](packages/scale-references-n16-r4/replay.mjs) |
| Tariff · 16 候选 · 8 轮 | [report](packages/scale-tariff-n16-r8/report.md) | [replay](packages/scale-tariff-n16-r8/replay.mjs) |

使用Node26，每次选择新的输出目录；不需要包安装或凭据：

```sh
node benchmark/results/2026-11-26-relative-source-reanalysis/packages/codemode-24/replay.mjs \
  --out /absolute/new-codemode-reanalysis-report
```

其余五包使用各自的replay.mjs。查看每包public-manifest.json确认公开文件与原件映射；身份脱敏可以改变哈希和模型标签，不改变验收与资源含义。cost-diagnosis.json中的事件行号相对packages/codemode-24下已核验的公开JSONL。

原Store invalid、未运行槽位、Own20 inconclusive和Native160暂缓均没有被本次分析改写。公开原观察边界保持219/25，现场仍为220/26。
