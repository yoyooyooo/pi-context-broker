# Changelog

## Unreleased

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
