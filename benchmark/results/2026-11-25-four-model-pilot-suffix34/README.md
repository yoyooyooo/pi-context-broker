# Standing Benchmark continuation

This release retains 34 newly closed original observations from 4 observed scope(s). Its current work plan declares 4 work item(s) and 34 planned observations. Its historical boundary is 185; its resulting physical boundary is 219.

## Current work plan

| Work item | Phase / purpose | Models and parameters | Consumers and product builds | Case selections | Repeats | Planned | Closed |
|---|---|---|---|---:|---:|---:|---:|
| suffix-gpt62-12 | pilot / native_calibration | auto/gpt-6.2-sol; {"thinkingLevel":"medium","maxTokens":4096} | broker/free (benchmark-own-candidate-standing-1), native/free (benchmark-own-candidate-standing-1) | 6 | 1 | 12 | 12 |
| suffix-grok46-8 | pilot / native_calibration | auto/grok-4.6; {"thinkingLevel":"medium","maxTokens":4096} | broker/free (benchmark-own-candidate-standing-1), native/free (benchmark-own-candidate-standing-1) | 4 | 1 | 8 | 8 |
| suffix-grok47-6 | pilot / native_calibration | auto/grok-4.7; {"thinkingLevel":"medium","maxTokens":4096} | broker/free (benchmark-own-candidate-standing-1), native/free (benchmark-own-candidate-standing-1) | 3 | 1 | 6 | 6 |
| suffix-terra61-8 | pilot / native_calibration | auto/gpt-6.1-terra; {"thinkingLevel":"medium","maxTokens":4096} | broker/free (benchmark-own-candidate-standing-1), native/free (benchmark-own-candidate-standing-1) | 4 | 1 | 8 | 8 |

All planned items remain listed, including unstarted items and incomplete scopes. Each package retains its own scientific denominator. Completion is not scientific acceptance. Actual reported models and request timing remain in each observation.

The finite work plan describes scientific coverage. The standing authorization imposes no cumulative request, token, tool, duration, episode or rerun quota and has no expiry. Model parameters remain the declared values shown above. Descriptive time and input checkpoints are analysis cutoffs and cannot stop execution.

## Historical context

The initial engineering plan declared 42 observations across seven designs: CodeMode24, five scale pairs and eight store-fault observations. That is a separate design record, not a claim that this release ran or completed those 42 observations. Its actual outcomes retain their own packages and condition epochs. Historical CodeMode7 also remains a separate condition. Neither historical design is added to the current denominator.

Valid business-negative outcomes remain completed observations. Infrastructure failures, incomplete evidence, unknown usage and unstarted cells remain visible. A stopped owned attempt can be diagnosed and followed by a newly owned attempt under the same standing grant; this release does not reinterpret or remove its original failures.

Resource accounting includes failed and invalid observations. Known subtotals and unknown totals are separate; no complete historical usage or monetary total is claimed.

Prior published evidence: https://github.com/yoyooyooo/pi-context-broker/tree/aa3b222bc7a489e168ab89d30df4b0b2c6aecb77/benchmark/results/2026-11-25-observer-repair-continuation

Each package provides report.md and a Node26 replay.mjs requiring a fresh --out directory. Public replay verifies transformed file identities and recomputes statistics from normalized observations. It does not rerun private graders, reconstruct private raw chains, call a provider or create new subject executions. release-accounting.mjs separately checks original-slot lineage and resource accounting.
