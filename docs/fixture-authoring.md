# Fixture file authority

`scripts/notion-agent-scenarios.mjs` validates the fixture recipe before any
ownership directory, CLI command or remote object is created. Keep the recipe
with the preparation evidence. A later recovery must use the same recipe and
must account for every earlier write before deciding that an object was never
created.

## Native main with exact supporting files

For a synthetic fixture whose auxiliary files must retain their original
bytes, select this policy on the Notion object:

```json
{
  "id": "grant",
  "name": "grant-rules",
  "description": "Rules for grant applications",
  "placement": "notion",
  "authoring": "native-main-exact-resources",
  "initial": "v1",
  "versions": {
    "v1": {
      "files": [
        { "path": "SKILL.md", "content": "# Grant rules\n" },
        { "path": "references/rules.md", "content": "grant_cents is exact.\n" }
      ]
    }
  }
}
```

Preparation calls the public `ctl library import` command on the complete
prepared input directory, selecting only `--native SKILL.md`. Every other path,
including auxiliary Markdown, has resource authority. Public readback compares
those files by their full byte hashes. The main file still uses the selected
CLI package's Native Markdown comparator. The policy does not change any
author content, oracle, model prompt or grading rule.

The policy currently accepts one present, immutable Notion version. It rejects
`requires`, `members`, `enabled` and `defaultContext` recipe fields, including
explicit empty relation arrays. The import command does not have the create
command's corresponding flags, so preparation must not silently discard them.
Absent, unmanaged, local, Source, Builtin and multiple-version objects are also
outside this policy. Recipes without `authoring` keep the existing creation,
relation, metadata and version-publication behavior.

## Creation and recovery

Import can replace an existing owner. Before initial fixture import, preparation
runs the same public command with `--dry-run` and requires an absent owner,
no current state, no removed paths, and a complete matching file tree. Every
planned file must have action `create`, its original hash and byte count, and
the selected native or resource authority. An existing owner or incomplete
observation stops preparation before the write. This check is scoped to the
task-owned library; it is not an API permission sandbox.

`scripts/notion-agent-authoring.mjs` exports `agentFixtureCreateArgs` and
`assertAgentFixtureImportCreation` for an existing controller's guarded
absent-object continuation. Such a controller must retain its independent
absence, operation and dispatch-history checks; calling the argument builder
does not authorize another write. `isAgentFixtureCreationArgs` recognizes both
`skill create` and `import` for the exact stable owner. Pass only CLI arguments,
after the Node and executable entries. Read-only `--dry-run` commands are
excluded from write history. An import with an unknown outcome is still a
dispatched write and must not become a never-dispatched object.

Do not reinterpret an old recipe or replace an unfinished operation merely to
adopt this policy. A retained owner whose file authority needs correction uses
the public current-operation recovery procedure, with its original material
and separately retained intervention evidence.

## Verification

Run the authoring and fixture regressions with the actual selected built
CLI/SDK supplied through `NTN_SKILLS_BUILD_ENTRY`:

```sh
node --test scripts/notion-agent-authoring.test.mjs \
  scripts/notion-agent-scenarios.test.mjs scripts/notion-agent-fixtures.test.mjs
```

The fixture tests use controlled CLI/API processes and the selected real SDK
comparator. They verify orchestration, exact auxiliary readback, owner-collision
refusal and validation before I/O. They do not represent live Notion or model
acceptance. Keep later live material preparation and model results separate.
