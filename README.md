# pi-context-broker

`pi-context-broker` is a standalone Pi/OMP package for explicit, lightweight context discovery and injection.

It provides one interaction model:

- `$name` in the user prompt resolves a discoverable record.
- `/context-broker ...` inspects configured roots, catalogs, and namespace health.
- Matched records are injected as `customType: "context-broker"` messages using `<context-broker-record ...>` payloads.

## Install

Pi:

```bash
pi install npm:pi-context-broker
```

OMP:

```bash
omp install npm:pi-context-broker
```

Local development:

```bash
pi -e ./src/index.ts
omp -e ./src/index.ts
```

## Quickstart

Create a config file:

```yaml
# ~/.pi/agent/context-broker/config.yml
skillRoots:
  - ~/context/skills

discoveryCatalogs:
  - ~/context/catalogs/workspace.yaml

requireAutoload: false
pathMode: home-relative
logPaths: false
scan:
  maxDepth: 8
  maxSkillBytes: 65536
  ignore:
    - .git
    - node_modules
    - dist
    - build
```

Create a skill:

```markdown
---
name: design-review
description: Review architecture and API trade-offs.
autoload:
  enabled: true
  aliases:
    - architecture-review
---

Use this context when reviewing design decisions.
```

Use it:

```text
$design-review review this API boundary
```

Inspect health:

```text
/context-broker doctor
/context-broker find design
/context-broker explain design-review
```

## Record kinds

Context Broker treats context as discoverable records, not only skills.

- `skill` — a `SKILL.md` file discovered from configured skill roots. The full file body is injected.
- `bundle` — a lightweight catalog record that injects a member index and routing rules, not member file bodies.

All record names and aliases share one namespace. Collisions fail closed.

## Config resolution

Config is single-track and current-name only:

1. `CONTEXT_BROKER_CONFIG`
2. `<agentDir>/context-broker/config.yml`
3. `<agentDir>/context-broker/config.yaml`
4. `<agentDir>/context-broker/config.json`

`agentDir` is resolved from `PI_CODING_AGENT_DIR` when set. Otherwise Context Broker uses host defaults:

- Pi: `~/.pi/agent`
- OMP: `~/${PI_CONFIG_DIR:-.omp}/agent`

### Config fields

```yaml
skillRoots:
  - ~/context/skills
extraSkillRoots:
  - ./.agents/skills

ruleRoots:
  - ./context-broker/rules

discoveryCatalogs:
  - ~/context/catalogs/workspace.yaml
extraDiscoveryCatalogs:
  - ./context/catalogs/project.yaml

requireAutoload: true
pathMode: home-relative   # absolute | home-relative | basename | hash
logPaths: false
scan:
  maxDepth: 8
  maxSkillBytes: 65536
  ignore:
    - .git
    - node_modules
    - dist
    - build
```

Environment overrides:

- `CONTEXT_BROKER_CONFIG` — explicit config path.
- `CONTEXT_BROKER_ROOTS` — path-list of skill roots that replaces `skillRoots`.
- `CONTEXT_BROKER_EXTRA_ROOTS` — path-list of skill roots appended after configured roots.
- `CONTEXT_BROKER_DISCOVERY_CATALOGS` — path-list of discovery catalogs that replaces `discoveryCatalogs`.
- `CONTEXT_BROKER_EXTRA_DISCOVERY_CATALOGS` — path-list of discovery catalogs appended after configured catalogs.
- `CONTEXT_BROKER_REQUIRE_ENABLED=0` — allow all discovered skills even without `autoload.enabled: true`.
- `CONTEXT_BROKER_REQUIRE_ENABLED=1` — require `autoload.enabled: true`.
- `CONTEXT_BROKER_LOG_FILE` — append JSONL decisions/injections.
- `CONTEXT_BROKER_HOST=pi|omp` — force host default resolution.

Path-list separators follow the platform path delimiter (`:` on macOS/Linux, `;` on Windows).

## Rule files

Rule files live under `context-broker/rules/*.yml` by default. Each file describes one invocation profile:

```yaml
id: architecture-review
inject:
  - design-review
match:
  - exact:
      - review this design
  - regex:
      - '^design review:'
```

If `ruleRoots` is set in config, those roots replace the default rule directory.

## Skill records

A skill is any `SKILL.md` discovered under a configured root.

```markdown
---
name: design-review
description: Review architecture and API trade-offs.
autoload:
  enabled: true
  aliases:
    - architecture-review
---

Use this context when reviewing design decisions.
```

With `requireAutoload: true` or the default autoload gate, only skills with `autoload.enabled: true` are injected through rule matching. `$` discovery includes configured skills so explicit user selection can still find them.

## Discovery catalogs

A discovery catalog is a resolved, standalone YAML or JSON contract. YAML is the recommended default because catalogs are usually reviewed by humans.

```yaml
version: 1
records:
  - kind: bundle
    name: workspace-collab
    description: Collaboration contexts for documents, chat, and tasks.
    aliases:
      - collab
    render:
      type: member-index
      rules:
        - Read the selected member file before using member-specific details.
    policy:
      memberBody: read-before-use
      scope: members-only
    members:
      include:
        - docs
        - chat
```

Relative member paths are resolved against the catalog file.

Catalog member shape is resolved by path. `name` and `description` are optional when the path points at a `SKILL.md`; Context Broker reads frontmatter as fallback:

```yaml
path: ./members/docs/SKILL.md
```

Use `members.include` when the member is a skill name or alias discoverable from `skillRoots`; `*` globs are supported against skill name, directory name, and aliases, for example `docs-*`. Use explicit `path` entries only for catalog members outside the configured skill registry. Use explicit `name` or `description` only when overriding frontmatter or when the target file has no readable frontmatter.

A fuller field-usage example lives at `examples/discovery-catalog.example.yaml`.

## Injection shape

Skill injection:

```xml
<context-broker-record kind="skill" name="design-review" path="~/context/skills/design-review/SKILL.md">
<body>
...
</body>
</context-broker-record>
```

Bundle injection:

```xml
<context-broker-record kind="bundle" name="workspace-collab" path="~/context/catalogs/workspace.yaml">
  <description>Collaboration contexts for documents, chat, and tasks.</description>
  <rules>
    <rule>Read the selected member file before using member-specific details.</rule>
  </rules>
  <policy memberBody="read-before-use" scope="members-only"></policy>
  <members>
    <member name="docs" path="~/context/skills/docs/SKILL.md">Document reading and editing context.</member>
  </members>
</context-broker-record>
```

Bundle injection intentionally sends only the index. The agent reads the specific member file if needed.

## Commands

Use one slash command with subcommands:

```text
/context-broker status
/context-broker doctor
/context-broker roots
/context-broker catalogs
/context-broker find <query>
/context-broker explain <record>
```

Do not use colon-style command names for subcommands; Pi reserves colon suffixes for command conflict disambiguation.

## Security and privacy

This package runs locally with the permissions of the host agent process. Install only from sources you trust.

Context Broker intentionally sends selected context to the model. Treat every configured root and catalog as a trusted boundary:

- A matched `skill` injects the full `SKILL.md` body into the model context and session history.
- A matched `bundle` injects member names, descriptions, policies, and member paths, but not member file bodies.
- Session JSONL files persist injected content.
- `CONTEXT_BROKER_LOG_FILE` writes matched queries and record names; paths are omitted unless `logPaths: true`.
- `pathMode: home-relative` is the default to avoid sending `/Users/<name>/...` paths when possible.

Do not point `skillRoots` at untrusted repositories. A skill is prompt content and can instruct the model.

## Platform support

Tested on macOS with Pi and OMP. Linux should work. Windows uses platform path-list separators but is best-effort until covered by CI.

## Development

```bash
bun install
bun run check
bun run test:host
bun run test:global-config
npm pack --dry-run --json
```

Release flow:

```bash
bun run release:check patch --no-push
bun run release patch
```

The local release script creates a temporary release branch, commits version files, tags that commit, pushes the tag, and lets GitHub Actions publish from the tag.
