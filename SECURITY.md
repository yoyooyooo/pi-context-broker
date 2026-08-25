# Security Policy

## Supported versions

Security fixes target the latest released version.

## Trust boundary

`pi-context-broker` is a local Pi/OMP extension. It runs with the same filesystem permissions as the host agent process.

Configured `skillRoots`, `ruleRoots`, and discovery catalogs are trusted inputs. Do not include untrusted repositories or user-writable shared directories unless you are comfortable sending their matched prompt content to the model.

## Data exposure model

- Matched skill bodies are sent to the configured model provider and persisted in the local session history.
- Bundle records send only index metadata and member paths, not member bodies.
- With `exposeBundlesAsSkills.include` (or the all-Bundle shorthand `true`), selected Bundle names, descriptions, and generated index locations are advertised in the system prompt. Generated `SKILL.md` indexes are stored under the host agent directory and contain Bundle metadata, policies, member descriptions, and path representations, but not member bodies.
- Generated indexes carry an explicit owner marker and are tracked by an owner manifest. Reconciliation only moves marker-proven stale indexes inside the controlled generated root into a sibling quarantine directory; unknown or truncated files are preserved and nothing is permanently deleted.
- Paths are home-relative by default where possible. Use `pathMode: hash` for stronger path redaction.
- JSONL decision logs omit paths unless `logPaths: true` is configured.

## Reporting vulnerabilities

Open a private security advisory or contact the maintainer through the repository security channel. Do not include private keys, API tokens, or private skill contents in public issues.
