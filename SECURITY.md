# Security Policy

## Supported versions

Security fixes target the latest released version.

## Trust boundary

`pi-context-broker` is a local Pi/OMP extension. It runs with the same filesystem permissions as the host agent process.

The Tern companion runs as a Luau window plugin and launches its bundled local query through Node.js. It reads configured Skill/catalog/source metadata and applies native editor events to the selected OMP draft. A configured Notion source invokes the trusted `ntn-skills` CLI and may query Notion using its existing authentication and discovery cache policy. Tern does not submit prompts. Candidate strings are never executed as shell commands; source commands are spawned as executable/argument arrays without a shell. Treat the installed plugin, source executable and configured content as trusted inputs.

Configured `skillRoots`, `ruleRoots`, discovery catalogs, filesystem source roots and Notion databases are trusted inputs. Do not include untrusted repositories, source commands or user-writable shared directories unless you are comfortable sending their selected prompt content to the model. Notion metadata discovery does not preload every remote body.

## Data exposure model

- Matched skill bodies are sent to the configured model provider and persisted in the local session history.
- Bundle records send only index metadata and member paths, not member bodies.
- Paths are home-relative by default where possible. Use `pathMode: hash` for stronger path redaction.
- JSONL decision logs omit paths unless `logPaths: true` is configured.
- Notion credentials remain in the existing CLI credential store/environment; broker/Tern configuration has no token field. Do not put secrets in command arguments.
- Notion metadata and prepared Skill bodies/resources are cached locally. `Default Context` opts a Notion Skill into background preparation of its complete snapshot. Catalog identity separates credentials and remote selection; immutable exports separate credential scope, record and snapshot. Projects, host labels and executable spellings share the same remote cache. Resources stay pinned to the entry's snapshot. Preparation alone does not send body content to the provider or add activation records to the session.
- Native host discovery publishes metadata-only entries for filesystem sources and Notion records whose `default_context` is true. Missing or unchecked flags are false; other Notion records remain explicitly selectable. Filesystem scanning reads local files to extract metadata. Native `read`, `/skill:` and `$` activation must finish preparing the selected body and complete resources before exposing them; failures block activation and do not mark the record loaded.
- Source diagnostics preserve safe error codes and exit status without raw subprocess stderr, external error messages, signed URLs or credentials. Include only sanitized diagnostics in bug reports.
- Metadata refresh may make a later selection use a new snapshot; it does not remove already injected content from session history or the provider's context.
- Builtin management writes one XDG data store and default `~/.agents/skills` links, plus explicitly selected additional Agent roots. Central receipts and distribution records establish local ownership, not a signature or remote provenance. Foreign targets and modified files are preserved; shared installation does not merge Notion credentials or cache scopes. Central managed metadata is discoverable without opening a general scan of every Agent root.

See the [source configuration and activation contract](./packages/context-broker/docs/reference.md#built-in-sources) ([中文](./packages/context-broker/docs/reference.zh-CN.md#内置-sources)) for scope, freshness, coverage and restart semantics.

## Reporting vulnerabilities

Open a private security advisory or contact the maintainer through the repository security channel. Do not include private keys, API tokens, or private skill contents in public issues.
