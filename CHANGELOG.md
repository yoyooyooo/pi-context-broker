# Changelog

## Unreleased

- Add `memberPathAnchor` for consumer-visible Bundle roots, with strict-majority default path inference and full root-relative paths only for exceptions.
- Add authored Bundle routing maps with compact overview/rules/groups/member hints/combinations, strict Unicode character budgets, required-hint validation, common-path compression, and generated-self exclusion; routing-enabled entities and `$bundle` injection no longer copy member descriptions.

- Add configurable Bundle Skill entity output with stable `skill-dir` names, config-relative `outputRoot`, `{name}` templates, portable `memberPathRoot`, materialize-only operation, and `/context-broker materialize` while preserving the existing host-local flat-file default.
- Fail Bundle materialization closed when selected records contain empty member descriptions, missing member paths, or discovery collisions.
- Make generated Bundle index identity independent of caller cwd, atomically update stable paths, record owner/digest state in a manifest, and quarantine only marker-proven stale indexes while preserving unknown or truncated files.
- Add opt-in, allowlisted `exposeBundlesAsSkills` host discovery while preserving manual `$name` Bundle loading as the default; `true` remains the explicit all-Bundle shorthand.
- Support multiple keyword trigger profiles in one rule file through a top-level `rules` array, enabling generated scene-to-Bundle rule projections while preserving legacy single-profile files.
- Allow keyword rules to inject catalog bundle indexes with explicit `bundle:<name>` targets.
- Keep unprefixed rule targets Skill-only and make Bundle rule lookup exact and fail-closed.

## 0.0.2

- Let a catalog bundle intentionally shadow a same-name skill in `$` lookup.
- Rank matching bundles before same-score skills in `$` autocomplete.

## 0.0.1

- Initial standalone Pi/OMP context-broker package.
- Supports explicit `$name` context injection for skills and bundle records.
- Adds `/context-broker` diagnostics commands.
- Adds path privacy controls and bounded skill scanning defaults.
