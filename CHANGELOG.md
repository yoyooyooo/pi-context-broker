# Changelog

## Unreleased

Changes since the published [0.1.0 release](https://github.com/yoyooyooo/pi-context-broker/releases/tag/v0.1.0).

### Pi discovery and consumption

- Add `notion_list`, native `read` and `notion_use` as the Pi consumption interface. Branch-scoped `sr:C`, `sr:S` and `sr:R` references distinguish catalog candidates, selected mains and fixed resources; exact returned references can be reused without a mandatory search.
- Use the bundled `ntn-skills` SDK for default Pi discovery and consumption. It shares the CLI's source, authorization and cache contracts without spawning a public CLI read for every graph node. A separate global CLI installation is unnecessary; explicit custom `source.command` configurations retain their compatibility path.
- Prepare selected roots with their complete Requires closure before use, share common dependencies, and keep optional Members/resources on demand. Applying instructions to a plan, review, document or code uses `notion_use`; describing the Skill itself uses `read`.
- Keep ordinary Pi input independent of pending remote discovery. Project the current selected-View metadata at each provider request, preserve it when another extension forces a system prompt, and distinguish pending, failed, partial and complete-empty catalogs.
- Resolve exact Skill names through complete ordinary discovery and return scoped candidates for ambiguity. Reuse compatible full-catalog/default-directory metadata while preserving independent failures and selected-record authorization.
- Expose deferred `notion_ctl` for fixed-reference proof export and scoped CLI lookup. CLI lookup returns the configured command prefix and source/database scope; it does not execute management operations.

### Context, resources and session recovery

- Preserve complete authored instructions and compact usable resource/relationship directories in model content. Keep graph locks, hashes and other machine proofs in structured details, bound to the actual tool call and complete rendered body.
- Reuse a previously delivered main or resource only while the same fixed content remains complete in the current provider input. Repeated reads can return a short confirmation without rewriting the original session transcript; compaction restores the exact retained content when needed.
- Keep selected, ready, visible and active states distinct. Inspection or cached bytes do not activate a workflow; incomplete delivery, cancellation and stale session generations cannot create a loaded receipt.
- Restore exact selected snapshots across resume, fork, rewind and compaction. Refresh can create a new selection without moving older short references to today's content.
- Read fixed scalar resources without preparing the main, and add bounded resource batches through native `read({paths})`. When another extension owns scalar `read`, expose `notion_read_resources` through the same batch handler while preserving that reader's paging, images and result behavior.
- Share verified immutable body/manifest projections across processes while retaining instance-owned aliases and historical pins. Preserve durable operation/recovery state separately from content caches, and record source requests separately from model-provider caching.
- Preserve native/slash delivery receipts, show preparation budgets during cancellable acquisition, and prevent late catalog or preparation callbacks from dispatching into replaced sessions.

### Distribution and compatibility

- Bundle the selected CLI, SDK, workflow Skills, runtime dependencies and license notices in both Broker and standalone Tern artifacts. Build metadata records the selected CLI/SDK inputs.
- Advertise the three bundled Notion workflow Skills when at least one Notion source is enabled. Their packaged bodies and references remain available offline for setup; ordinary local/filesystem discovery is unchanged.
- Keep OMP and explicit command transports on their supported host protocols. Pi's `notion_use` is a top-level model-only tool; arbitrary nested Code mode calls do not establish outer delivery or activation.
- Current source reads may retain newly observed author edits through the core Records contract. Write permissions, original-operation recovery and request costs still apply.
- Run the configured quality checks during `release:check` without creating a release commit, tag or push. Publish the already packed Broker archive, then verify registry bytes plus fresh and upgrade installations before creating the GitHub Release.
- See the [runtime contract](https://github.com/yoyooyooo/pi-context-broker/blob/main/packages/context-broker/docs/skill-consumption-runtime.md), [resource-read contract](https://github.com/yoyooyooo/pi-context-broker/blob/main/packages/context-broker/docs/fixed-resource-batches.md) and [release procedure](CONTRIBUTING.md#release) for supported behavior. Verification fixtures, actual host delivery and real-model task quality remain separate acceptance layers.

## 0.1.0

Published release. Its changes and original release-time documentation are available in the [GitHub release](https://github.com/yoyooyooo/pi-context-broker/releases/tag/v0.1.0) and [tagged changelog](https://github.com/yoyooyooo/pi-context-broker/blob/v0.1.0/CHANGELOG.md). The [release history](https://github.com/yoyooyooo/pi-context-broker/releases) includes intervening published versions; the earlier recorded entries remain below.

## 0.0.2

- Let a catalog bundle intentionally shadow a same-name skill in `$` lookup.
- Rank matching bundles before same-score skills in `$` autocomplete.

## 0.0.1

- Initial standalone Pi/OMP context-broker package.
- Supports explicit `$name` context injection for skills and bundle records.
- Adds `/context-broker` diagnostics commands.
- Adds path privacy controls and bounded skill scanning defaults.
