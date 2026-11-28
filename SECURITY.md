# Security Policy

## Supported versions

Security fixes target the latest patch in the current 0.x minor series. Earlier
patches and previous minor series are not maintained security branches. Runtime
support is Node.js 24.22.3+ in 24.x and 26.13.1+ in 26.x.
Keep a maintained patch within one of these lines. Current real-host verification
uses Pi 1.6.0; the optional peer ranges are not a universal host-support promise.

## Trust boundary

`pi-context-broker` is a local Pi/OMP extension. It runs with the same filesystem permissions as the host agent process.

The Tern companion runs as a Luau window plugin and launches its bundled local query through Node.js. It reads configured Skill/catalog/source metadata and applies native editor events to the selected OMP draft. A configured Notion source invokes the trusted `ntn-skills` CLI and may query Notion using its existing authentication and discovery cache policy. Tern does not submit prompts. Candidate strings are never executed as shell commands; source commands are spawned as executable/argument arrays without a shell. Treat the installed plugin, source executable and configured content as trusted inputs.

Configured `skillRoots`, `ruleRoots`, discovery catalogs, filesystem source roots and Notion databases are trusted inputs. Do not include untrusted repositories, source commands or user-writable shared directories unless you are comfortable sending their selected prompt content to the model. Notion metadata discovery does not preload every remote body.

## Data exposure model

- Matched skill bodies are sent to the configured model provider and persisted in the local session history.
- Router selection loads its own body and member index. Member bodies are read separately when needed.
- Paths are home-relative by default where possible. Use `pathMode: hash` for stronger path redaction.
- JSONL decision logs omit paths unless `logPaths: true` is configured.
- Notion credentials remain in the existing CLI credential store/environment; broker/Tern configuration has no token field. Do not put secrets in command arguments.
- Notion metadata and selected Skill bodies/resources are cached locally. Prefetch defaults to a zero budget; bounded warming requires an explicit budget for nodes, bytes, time and rate. Catalog identity separates credentials and remote selection; selected content stays bound to its credential scope, record and snapshot. Projects, host labels and executable spellings share the same remote cache. Supporting files remain pinned to that snapshot and are fetched individually when read. Preparation alone does not send body content to the provider or add activation records to the session.
- Pi publishes metadata-only Notion entries from its selected View. Session/source configuration selects that View; an unconfigured source uses the first View in API order. `Default Context` is an ordinary checkbox that saved View filters may use; it does not independently select entries or trigger warming. Filesystem scanning reads local files to extract metadata. Pi native `read` inspects a selected record or resource; `notion_use` and explicit `$` selection prepare the selected root and its Requires closure. Main bodies and the complete file manifest are verified before delivery; supporting resources remain available on demand. A failed explicit View is reported without substituting another View or the full library, and failed activation does not mark a body loaded.
- Source diagnostics preserve safe error codes and exit status without raw subprocess stderr, external error messages, signed URLs or credentials. Include only sanitized diagnostics in bug reports.
- Metadata refresh may make a later selection use a new snapshot; it does not remove already injected content from session history or the provider's context.
- Builtin management writes one XDG data store and default `~/.agents/skills` links, plus explicitly selected additional Agent roots. Central receipts and distribution records establish local ownership, not a signature or remote provenance. Foreign targets and modified files are preserved; shared installation does not merge Notion credentials or cache scopes. Central managed metadata is discoverable without opening a general scan of every Agent root.

See the [source configuration and activation contract](./packages/context-broker/docs/reference.md#built-in-sources) ([中文](./packages/context-broker/docs/reference.zh-CN.md#内置-sources)) for scope, freshness, coverage and restart semantics.

## Reporting vulnerabilities

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/yoyooyooo/pi-context-broker/security/advisories/new). Include affected versions, a sanitized reproduction and the impact. Do not include private keys, API tokens, or private Skill contents in public issues.

Reports are handled on a best-effort basis, with no guaranteed response or fix
time. Impact, reproducibility and maintainer availability determine the next step.
Use [GitHub issues](https://github.com/yoyooyooo/pi-context-broker/issues) for ordinary
bugs and usage questions.
