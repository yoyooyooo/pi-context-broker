# pi-context-broker

[English](./README.md) | [中文](./README.zh-CN.md)

`pi-context-broker` lets you pull local agent context into Pi or OMP with a plain `$name` in your prompt.

```text
$design-review review this API boundary
```

The plugin finds `design-review`, injects the matching local `SKILL.md` or bundle index, and skips duplicate injections in the same active session branch.

## The problem

Agent setups collect useful context over time: review checklists, project runbooks, team workflows, provider notes, debugging recipes, and personal skills. Loading all of them at startup makes the prompt noisy. Asking the model to remember the right file is unreliable. Opening files by hand breaks flow.

Context Broker adds a small routing layer between your prompt and your local context library. You name the context you want. The plugin resolves it and injects it once.

It does not run a remote indexer, guess from embeddings, or load everything in the background. The user stays in control.

## What you get

- `$name` lookup for local skills and catalog records.
- Pi interactive autocomplete for `$...` entries.
- Rule-based injection, such as `review this design` loading `design-review`.
- Explicit `bundle:<name>` rule targets for keyword-triggered bundle indexes.
- Bundle records for large context areas where the model should see an index before choosing a member.
- `/context-broker` commands for setup checks and lookup debugging.
- Namespace collision checks for names and aliases.
- Duplicate-injection protection for the active session branch.
- Path privacy controls for model payloads, session metadata, and JSONL logs.
- Bounded scanning defaults so a bad root does not read the world.

## How it works

Context Broker has two record types.

| Record | Comes from | What gets injected |
| --- | --- | --- |
| `skill` | A discovered `SKILL.md` file | The full skill body |
| `bundle` | A YAML or JSON catalog | The bundle description, policy, and member list |

A skill is for concrete operating instructions. A bundle is for routing. Use a bundle when you have a group of related skills and want the model to choose the right member instead of receiving every member body up front.

## Install

Pi:

```bash
pi install npm:pi-context-broker
```

OMP:

```bash
omp install npm:pi-context-broker
```

Try a local checkout without installing:

```bash
pi -e ./src/index.ts
omp -e ./src/index.ts
```

## Quick start

### 1. Add a config file

Pi reads:

```text
~/.pi/agent/context-broker/config.yml
```

OMP reads:

```text
~/.omp/agent/context-broker/config.yml
```

Minimal config:

```yaml
skillRoots:
  - ~/context/skills

requireAutoload: false
pathMode: home-relative
logPaths: false
```

### 2. Add a skill

Create:

```text
~/context/skills/design-review/SKILL.md
```

```markdown
---
name: design-review
description: Review architecture and API trade-offs.
autoload:
  enabled: true
  aliases:
    - architecture-review
---

Review the design for ownership, boundaries, failure modes, and migration cost.
```

### 3. Use it

```text
$design-review review this API boundary
```

The next model turn receives your prompt plus the `design-review` skill body.

### 4. Check what the broker sees

```text
/context-broker doctor
/context-broker find design
/context-broker explain design-review
```

## Skills

Context Broker discovers every `SKILL.md` under `skillRoots`.

```markdown
---
name: design-review
description: Review architecture and API trade-offs.
autoload:
  enabled: true
  aliases:
    - architecture-review
---

Skill body goes here.
```

`autoload.enabled` affects rule-based injection by default. Explicit `$name` lookup can still find configured skills unless you force the autoload gate through config or environment variables.

## Bundles

Bundles live in discovery catalogs. They inject a routing index, not the full member files. Optional authored `routing` metadata keeps materialized entities compact and contrastive instead of copying member descriptions.

```yaml
version: 1
records:
  - kind: bundle
    name: workspace-collab
    description: Collaboration Skill router; load for document or chat work.
    aliases:
      - collab
    routing:
      overview: Choose by resource; add auth only for identity or permission work.
      rules:
        - Select the smallest member set
      groups:
        - id: content
          label: Content
          hint: Documents and conversations
      members:
        docs:
          group: content
          hint: Document body read/write
        chat:
          group: content
          hint: Messages and channels
      combinations:
        - docs + chat: prepare content, then send it
      requireHints: true
      limits:
        descriptionChars: 80
        overviewChars: 120
        groupHintChars: 48
        memberHintChars: 32
    policy:
      memberBody: read-before-use
      scope: members-only
    members:
      include:
        - docs
        - chat
```

When you type `$workspace-collab`, the model sees the compact overview, selection rules, groups, member hints, and policy. It does not receive the original member descriptions or bodies. `description` is reserved for host-level discovery; `routing.overview` explains the decision model after opening the Bundle; each member `hint` should state only how that member differs from its siblings.

`requireHints: true` fails materialization when a discovered member has no authored hint. Limits count Unicode code points and prevent default descriptions or routing prose from growing silently. The compact renderer factors common member path roots, prints only path exceptions, and excludes the generated Bundle entity from its own member set. Catalogs without `routing` keep the compatible member-description rendering.

Bundle discovery remains manual by default. To materialize selected Bundles as lightweight Skill entities, enable:

```yaml
exposeBundlesAsSkills:
  include:
    - workspace-collab
```

Use `exposeBundlesAsSkills: true` only when every configured Bundle should be materialized. The default is `false`. Without output options, the plugin preserves the compatible host-local flat-file indexes and registers them through host resource discovery.

To expose stable Skill directories to another distribution system, configure an explicit entity output:

```yaml
exposeBundlesAsSkills:
  include:
    - workspace-collab
  outputRoot: ~/context/bundles
  layout: skill-dir
  nameTemplate: "{name}-bundle"
  memberPathRoot: ~/context
  registerWithHost: false
```

This deterministically writes `~/context/bundles/workspace-collab-bundle/SKILL.md`. `outputRoot` and `memberPathRoot` expand `~`; relative paths resolve from the config file directory. `memberPathRoot` keeps source-relative member paths in the generated index instead of embedding generator-host absolute paths. `nameTemplate` must contain `{name}`. With `registerWithHost: false`, Context Broker only materializes the files and does not register the same indexes directly with the current Pi/OMP host, which lets another tool distribute them globally.

Context Broker records the active set, source Bundle identity, and content digest in an owner manifest. Reconciliation quarantines only marker-proven stale indexes and preserves unknown, markerless, or truncated files. Public entity directories stay stable; hashes and timestamps remain internal to manifests, temporary files, and quarantine paths.

Rules can inject the same lightweight index without loading member bodies:

```yaml
id: collaboration-keywords
inject:
  - bundle:workspace-collab
match:
  - contains:
      - team workspace
```

The `bundle:` prefix is required for rule targets. Unprefixed rule targets keep the existing Skill-only behavior. Bundle rule lookup uses exact names or aliases from configured discovery catalogs and does not fuzzy-match.

## Configuration

Config resolution order:

1. `CONTEXT_BROKER_CONFIG`
2. `<agentDir>/context-broker/config.yml`
3. `<agentDir>/context-broker/config.yaml`
4. `<agentDir>/context-broker/config.json`

`PI_CODING_AGENT_DIR` sets `agentDir` when present. Otherwise the plugin uses the host default:

- Pi: `~/.pi/agent`
- OMP: `~/${PI_CONFIG_DIR:-.omp}/agent`

Full config example:

```yaml
skillRoots:
  - ~/context/skills
extraSkillRoots:
  - ./.agents/skills

# If omitted, the broker uses context-broker/rules next to the config file.
ruleRoots:
  - ./context-broker/rules

discoveryCatalogs:
  - ~/context/catalogs/workspace.yaml
extraDiscoveryCatalogs:
  - ./context/catalogs/project.yaml

requireAutoload: true

# Off by default. Select Bundles to materialize. This example writes stable
# Skill directories but leaves host registration to an external distributor.
exposeBundlesAsSkills:
  include:
    - workspace-collab
  outputRoot: ~/context/bundles
  layout: skill-dir
  nameTemplate: "{name}-bundle"
  memberPathRoot: ~/context
  registerWithHost: false

# absolute | home-relative | basename | hash
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
    - coverage
```

### Environment variables

| Variable | Effect |
| --- | --- |
| `CONTEXT_BROKER_CONFIG` | Use one explicit config file |
| `CONTEXT_BROKER_ROOTS` | Replace `skillRoots` with a path-list |
| `CONTEXT_BROKER_EXTRA_ROOTS` | Append skill roots |
| `CONTEXT_BROKER_DISCOVERY_CATALOGS` | Replace `discoveryCatalogs` with a path-list |
| `CONTEXT_BROKER_EXTRA_DISCOVERY_CATALOGS` | Append discovery catalogs |
| `CONTEXT_BROKER_REQUIRE_ENABLED=0` | Allow all discovered skills for rule matching |
| `CONTEXT_BROKER_REQUIRE_ENABLED=1` | Require `autoload.enabled: true` |
| `CONTEXT_BROKER_LOG_FILE` | Write JSONL decisions and injections |
| `CONTEXT_BROKER_HOST=pi\|omp` | Force host default resolution |

Path-list separators follow the platform delimiter: `:` on macOS/Linux, `;` on Windows.

## Rule files

Rule files live under `context-broker/rules/*.yml` by default. Each file describes one trigger profile.

```yaml
id: architecture-review
inject:
  - design-review
  - bundle:workspace-collab
match:
  - exact:
      - review this design
  - regex:
      - '^design review:'
  - contains:
      - architecture
    not:
      - contains:
          - no context
```

A generated file can declare multiple profiles through a top-level `rules` array. This is useful when one scene configuration projects keyword rules for several Bundle indexes:

```yaml
version: 1
rules:
  - id: scene-coding
    inject:
      - bundle:scene-coding
    match:
      - contains:
          - coding context
  - id: scene-research
    inject:
      - bundle:scene-research
    match:
      - contains:
          - deep research
```

The legacy single-profile file remains supported. When a non-empty top-level `rules` array is present, its valid entries are used.

Set `ruleRoots` if you want a different rule directory.

## Discovery catalogs

Catalogs are standalone YAML or JSON files. YAML is easier to review and is the recommended format.

A member can reference a discovered skill by name:

```yaml
members:
  include:
    - docs
    - chat
```

A member can also point to a file relative to the catalog:

```yaml
members:
  - path: ./members/docs/SKILL.md
```

When the file is a `SKILL.md`, Context Broker can read `name` and `description` from frontmatter. Set them manually only when you want to override that metadata.

See [`examples/discovery-catalog.example.yaml`](./examples/discovery-catalog.example.yaml) for a fuller example.

## Injected payloads

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

## Commands

```text
/context-broker status
/context-broker doctor
/context-broker roots
/context-broker catalogs
/context-broker materialize
/context-broker find <query>
/context-broker explain <record>
```

Use subcommands, not colon-style command names. Pi uses colon suffixes for command conflict disambiguation.

## Security and privacy

This package runs inside the host agent process and has the same local permissions. Install it only from sources you trust.

Context Broker sends selected context to the model by design:

- A matched `skill` sends the full `SKILL.md` body to the model and stores it in local session history.
- A matched `bundle` sends member names, descriptions, policies, and member paths, but not member bodies.
- With `exposeBundlesAsSkills.include`, selected Bundles are materialized as lightweight indexes; names, descriptions, and locations are registered with the current host only when `registerWithHost` is enabled.
- `outputRoot`, `layout: skill-dir`, and `nameTemplate` can produce stable `<name>/SKILL.md` entities for an external distribution system. Relative output roots resolve from the config file directory.
- Generated-index reconciliation is owner-scoped. Stale owned indexes and invalid owner manifests are quarantined rather than permanently deleted; unowned files are not modified.
- Session JSONL files store injected content.
- `CONTEXT_BROKER_LOG_FILE` records matched queries and record names. It omits paths unless `logPaths: true` is set.
- `pathMode: home-relative` avoids full home-directory paths when possible.
- `pathMode: hash` gives stronger path redaction.

Do not point `skillRoots` at untrusted repositories. A skill is prompt content and can instruct the model.

## Platform support

The package is tested on macOS with Pi and OMP. Linux should work. Windows path-list separators are supported, but Windows is best-effort until CI covers it.

## Maintainers and contributors

### Local development

```bash
bun install
bun run check
bun run test:host
bun run test:global-config
npm pack --dry-run --json
```

### Release flow

After npm Trusted Publishing is configured, create releases through the tag script:

```bash
bun run release:check patch --no-push
bun run release patch
```

The script creates a temporary local release branch, updates version files, commits, creates a tag, pushes the tag, and lets GitHub Actions publish from that tag.

### First manual publish

Before Trusted Publishing exists, publish from a real TTY so npm can complete 2FA or web authentication:

```bash
npm login --auth-type=web --registry https://registry.npmjs.org
npm publish --access public --registry https://registry.npmjs.org --auth-type=web
```

Agent shell tools are usually not a TTY and may fail with `EOTP`.
