# Isolated CLI and Broker development

Use a task-owned pair of repositories when changing Notion Skills or its Pi
adapter. `next` is the integration line. A developer or Agent works on task
branches in two independent clones, builds a private CLI/Broker pair, and chooses
that exact build for each run. A checkout used by the normal CLI or Pi
installation must not double as a scratch build directory.

- [Create the pair](#create-the-pair)
- [Build and select a generation](#build-and-select-a-generation)
- [Run with separate state](#run-with-separate-state)
- [Choose remote and model inputs](#choose-remote-and-model-inputs)
- [Verify the isolation](#verify-the-isolation)
- [Return changes to next](#return-changes-to-next)

## Create the pair

The environment entry is `scripts/paired-environment.mjs` in this repository.
Use the machine's maintained Node, Pi, Bun and Git installations. Update that
shared toolchain through its normal maintenance workflow; task environments do
not install a separate Pi version. Run the entry from a checkout containing the
script; its destination must be a new absolute directory owned by this task.
Each build and run uses the launcher's current Node `process.execPath` to invoke
target JavaScript and records its actual tool identities. Runs observe Node,
Pi and Bun before and after the command, using the run's environment. This avoids silently selecting an older
runtime through a shell shim. Node, Pi and Bun remain shared maintained
prerequisites; upgrading them does not require recreating task clones or a
per-task runtime manager. Results record the runtime used for that invocation.

Check the versions in the shell or Agent process that will launch the command:

```sh
node --version
pi --version
bun --version
```

The selected Node must satisfy the repositories' `engines.node` requirement.
A long-running Agent can retain an older PATH after the machine was upgraded.
Use a fresh shell or invoke the maintained Node by its absolute path when those
versions differ; updating the machine does not replace an existing process's environment.

```sh
node scripts/paired-environment.mjs create --root /absolute/owned/feature-env
```

By default, creation clones `yoyooyooo/notion-skills-cli` and
`yoyooyooo/pi-context-broker` from their `next` refs. To select other explicit
repository inputs or refs, use:

```sh
node scripts/paired-environment.mjs create --root /absolute/owned/feature-env \
  --cli-repository https://github.com/yoyooyooo/notion-skills-cli.git \
  --broker-repository https://github.com/yoyooyooo/pi-context-broker.git \
  --cli-ref next --broker-ref next \
  --pi-entry /absolute/pi/dist/bundle/cli.js
```

The default locates the installed Pi package. `--pi-entry` optionally selects
an explicit Pi JavaScript entry instead; do not pass a shell or Volta shim.
There is no per-task Pi version setting. The returned paths and resolved commits
identify the source pair. Retain them with the task. A later
remote update does not silently replace either selected revision. Continue work
in those clones; do not borrow another task's branch, index, `node_modules`,
build directory or run directory.

Creation only clones the repositories; it does not install dependencies. It does
not move the normal CLI command, install a global Pi package or rewrite the
user's Pi settings. Each repository has its own Git metadata and task branch;
the branch includes a unique environment suffix to avoid cross-machine collisions,
so an index lock or branch change in one task does not affect another. Ordinary
edits remain available in the task's source trees.

## Build and select a generation

```sh
node scripts/paired-environment.mjs build --root /absolute/owned/feature-env
```

If dependency installation requires the machine's configured network proxy,
name those existing variables explicitly, for example `--pass-env HTTPS_PROXY`.
If that proxy requires an existing CA bundle, also pass
`--pass-env NODE_EXTRA_CA_CERTS`; its value must be an absolute certificate path.
This does not permit `NODE_OPTIONS` or disabling TLS verification.
Builds use the same environment allowlist as runs and record only the passed
variable names. They do not inherit credentials or proxy settings implicitly.

Each build gets a new ID. It copies the current tracked files and nonignored
untracked files from both task clones into private source snapshots, using the
Git file lists. It installs each snapshot's dependencies in that build, then
produces complete CLI/SDK and Broker packages with their runtime dependencies.
Concurrent builds do not install into the editable clones or share a source
`node_modules` directory.

Broker binds to that generation's CLI, SDK and bundled Skills. A build never
rebuilds an earlier generation in place. Editing either task clone affects a
later build, while existing runs keep their selected generation. The build
record includes the original repository HEADs, copied-source fingerprints,
paired package identity and complete runtime file inventory. Its `source_tree`
inventory also covers the finished source snapshots and all installed build
dependencies. Treat those build directories as frozen; command runs receive
separate writable copies.

A successful build returns `build_id` and its `root`. Copy that `build_id` into
the following commands:

```sh
node scripts/paired-environment.mjs check --root /absolute/owned/feature-env --build BUILD_ID
```

`check` verifies the selected build's recorded identities, runtime packages and
entire `source_tree`, including its installed dependencies. A build ID is required; there is no implicit `latest` selection. A checked build does not
claim to contain source edits made after that build. Build again to test those
edits, then explicitly select the new ID.

Builds and runs generate random IDs by default. `--id NAME` chooses a specific
new ID when reproducible naming is useful. Reusing an occupied ID must fail;
it is not a request to overwrite or resume that directory.

The environment has one explicit layout:

| Path below the environment root | Purpose |
| --- | --- |
| `environment.json` | Repository inputs, tool identities, Pi entry selection and environment identity |
| `logs/` | Repository clone and branch output |
| `cli/`, `broker/` | Editable task clones |
| `builds/BUILD_ID/source/cli/`, `builds/BUILD_ID/source/broker/` | Frozen source snapshots and their installed build dependencies |
| `builds/BUILD_ID/cli/`, `builds/BUILD_ID/broker/` | Private complete installations and runtime dependencies for one generation |
| `builds/BUILD_ID/build.json` | Original HEADs, copied-source fingerprints, complete `source_tree` inventory and runtime package identities |
| `builds/BUILD_ID/logs/`, `builds/BUILD_ID/cache/` | Build output and source dependency caches |
| `builds/BUILD_ID/build-state/` | Private build configuration, application roots and runtime dependency cache |
| `runs/RUN_ID/run.json`, `runs/RUN_ID/result.json` | Invocation metadata, scope and target result |
| `runs/RUN_ID/source/cli/`, `runs/RUN_ID/source/broker/` | Command runs' private writable copies of both source snapshots and dependencies |
| Other paths inside `runs/RUN_ID/` | Private configuration, application state, sessions, Skills and temporary files |

## Run with separate state

Start with an offline command that needs no Notion or model credentials:

```sh
node scripts/paired-environment.mjs run --root /absolute/owned/feature-env \
  --build BUILD_ID --target cli -- --help
```

`--target cli` runs the selected generation's CLI. `--target pi` runs the resolved
machine Pi using the declared mode and run-owned settings. The default mode is
`broker`, which loads the selected generation's Broker and disables automatic
native Skill discovery. Both the direct target and the private `pi` wrapper use
the same recorded launch definition.
`--target command` executes an explicit command in the same run environment:

```sh
node scripts/paired-environment.mjs run --root /absolute/owned/feature-env \
  --build BUILD_ID --target command -- node --version
```

Each `--target command` run first copies both frozen source snapshots and their
installed dependencies into its own `runs/RUN_ID/source/` directory.
`--cwd workspace|cli|broker` selects its working directory. The default
`workspace` is a run-owned workspace; `cli` and `broker` select that run's source
copies. For command runs, `PAIRED_CLI_SOURCE` and `PAIRED_BROKER_SOURCE` also point
to these copies. Checks can change their own source or dependencies without
changing the selected build or another run. CLI and Pi targets use the selected
runtime packages without copying source trees.

Command runs also bind the existing `CONTEXT_BROKER_GRAPH_CORE` to the private
CLI source and `NTN_SKILLS_BUILD_ENTRY` to the selected private CLI package.
For example, run the existing verification suite without borrowing another
checkout's dependencies or skipping its cross-repository route:

```sh
node scripts/paired-environment.mjs run --root /absolute/owned/feature-env \
  --build BUILD_ID --target command --cwd broker -- bun run test:verification
```

Arguments after `--` belong to the target. The CLI path and any command wrapper
added to `PATH` apply only to this process tree. They do not replace a global
`ntn-skills` executable, rewrite shell startup files or change another session.
Both Pi entries reject resource and session overrides after `--`, including
`-e`, `--skill`, session-directory, session-file and resume flags. Declare common
extensions and native Skill inputs through the launcher instead. The launcher
owns session selection. CLI arguments pass through unchanged, including
those supplied to the process-local `ntn-skills` wrapper. Select the remote object
in the actual CLI command with its documented flags or positional arguments.
The launcher's remote declaration does not add or validate CLI arguments.

The launcher prints a JSON result with `run_id`, its `root` and `exit_code`.
Target stdout and stderr are retained as `command.stdout.log` and
`command.stderr.log` inside that run. Inspect them alongside `run.json` and
`result.json` before calling it successful.

Stdin defaults to `--stdin ignore`, so headless commands do not wait for the
launcher's input stream to close. For RPC or explicit piped input, set
`--stdin inherit` and close the input stream when the interaction is complete.
For an RPC harness that exchanges messages interactively, launch the harness with
`--target command` and let it spawn the private `pi` command with its own pipes.
The launcher's stdout is a result receipt, not a transparent RPC stream.

`--timeout-ms` controls the run deadline. The default is 10 minutes and the
maximum is 1 hour. A timeout stops only that run's owned process group and leaves
its evidence available. Every invocation allocates its own run ID and paths:

| State | Selection |
| --- | --- |
| CLI configuration | Private `NTN_SKILLS_CONFIG_HOME` |
| CLI operation state | Private `NTN_SKILLS_HOME` |
| CLI cache and builtin data | Private `NTN_SKILLS_CACHE_HOME` and `NTN_SKILLS_DATA_HOME` |
| Request scheduler | Private `NTN_SKILLS_SCHEDULER_ROOT` |
| Node, Pi and Bun executables | Shared maintained toolchain; actual versions and entries recorded per run |
| Pi configuration and sessions | Private agent directory and session paths |
| Broker configuration | Run-specific `CONTEXT_BROKER_CONFIG` |
| Local Skills | A run-owned copy of the explicitly selected directory |
| Temporary files | Run-specific `TMPDIR` |
| Command output and identities | The returned evidence directory |

`HOME` stays unchanged. The application roots above provide the separation;
changing only the working directory is insufficient. The scheduler needs its
own explicit root because its default uses the operating-system user's home,
independently of the CLI state root.

This is process configuration, not a filesystem sandbox. A program can still
address other paths explicitly. Keep commands within task-owned paths, and use
an explicit shell template such as `mktemp -d "${TMPDIR%/}/work.XXXXXX"` when
creating temporary directories. Do not infer ownership from a filename or from
another process having exited.

### Declare the Pi consumption mode

| Input | Broker mode, the default | Native mode |
| --- | --- | --- |
| Mode | `--pi-mode broker` | `--pi-mode native` |
| Skill input | Optional `--skills ABSOLUTE_DIRECTORY` for Broker discovery | Required `--native-skills ABSOLUTE_DIRECTORY`, copied and loaded with Pi's `--skill` |
| Broker extension | Selected build's entry | Not loaded |
| Native Skill commands | Disabled | Enabled |
| Common observers | Repeatable `--pi-extension ABSOLUTE_ENTRY` | Same option |

For example, start a native fixture using Pi's own command and reader:

```sh
node scripts/paired-environment.mjs run --root /absolute/owned/feature-env \
  --build BUILD_ID --target pi --pi-mode native \
  --native-skills /absolute/owned/fixture-skills \
  --pi-extension /absolute/owned/observer.mjs -- \
  --provider PROVIDER --model MODEL -p '/skill:fixture-name Perform the task.'
```

Provide the model configuration and credential variable names separately when
the selected provider needs them. The fixture example does not supply a model.
Native mode rejects `--skills`; Broker mode rejects `--native-skills`.
The common extension option accepts an absolute file or directory, keeps its
declared path for relative imports, and records its bounded file identity.
Do not modify a shared observer during a run. Native mode rejects the selected
Broker package as a common extension. Arbitrary extension code can still import
other code, so the benchmark must verify actual loaded resources with its own
observer before submitting a task.

Both modes use `-ns` to disable discovered/configured Skills; explicit native
roots still load. Both disable automatic extension, context, MCP and prompt
template discovery, and reject project trust overrides. The private settings
contain no packages. `pi-launch.json` and `run.json.pi_launch` record the same
mode, entry, fixed argv, settings, extension identities and copied native root.
Arguments for provider, model, tools, print/RPC and the user task remain Pi
arguments after the launcher's `--`.

Inside `--target command`, invoking `pi` uses that same profile. One multi-turn
episode can keep its state in one command run while a harness owns Pi pipes.
The launcher does not implement a benchmark handshake, a task oracle or a
comparison scheduler.

### Interpret runtime and command results separately

`run.json.runtime` is the initial endpoint observation. After the target ends,
`result.json.runtime_check` contains `before`, `after`, `changes`, `unknown`,
and one of these statuses:

| Status | Meaning |
| --- | --- |
| `unchanged` | Every declared identity was observed at both endpoints and matched |
| `drifted` | At least one observed entry, version or file identity changed; additional unknown observations remain listed |
| `unknown` | No known difference, but at least one required observation was unavailable |

The scope covers selected Node/Bun entry files and versions, Pi's selected
entry/version, package manifest, optional `cli-runtime.js`, and the run-owned
Pi/CLI wrappers. Version probes use the target's cwd/environment and have a
five-second limit. Probe output is not retained. Usage states describe what the
launcher requested or made available; a version probe does not prove a tool was
used by the task. An arbitrary command's child processes require their own
observers. These endpoint checks do not inventory every installed dependency or
prove that no file changed and changed back between observations.

`command_status`, `exit_code`, `signal`, `spawned`, and `timed_out` retain the
target process result. `frozen_artifacts` separately describes the selected
CLI/Broker build. The overall run `status` passes only when the command succeeds,
the frozen artifacts match, and `runtime_check.status` is `unchanged`. A command
can therefore exit zero while the overall run fails because its runtime drifted
or could not be checked. Original stdout/stderr and both observations stay
available; do not rewrite the business result to explain a measurement failure.
Benchmark owns comparisons across runs, re-pairing and invalid-result policies.

## Choose remote and model inputs

By default, credential environment variables are not inherited. With no
explicit remote or credential inputs, Broker has an empty `sources` list and
no Notion token. The run does not inherit a default library from the user's
normal config. This is the default for help, package and local behavior checks.

Use repeated `--pass-env NAME` to pass only the approved credential variables
needed for a selected scenario. The option names an existing variable; it does
not accept a secret value. Selecting an entry or parent alone does not pass a
Notion credential.

To read an authorized test library, provide its canonical Skills database UUID
as the launcher's `--entry`. This records the intended scope, sets
`PAIRED_NOTION_ENTRY`, and adds the matching Broker source. Also select that
database in the public CLI command. Consumption commands use `--database`:

```sh
node scripts/paired-environment.mjs run --root /absolute/owned/feature-env \
  --build BUILD_ID --target cli --entry TEST_ENTRY_UUID \
  --pass-env NOTION_API_TOKEN -- list --database TEST_ENTRY_UUID --json
```

For management, follow the selected command's help. For example, validate an
existing library with `ctl library init --entry`:

```sh
node scripts/paired-environment.mjs run --root /absolute/owned/feature-env \
  --build BUILD_ID --target cli --entry TEST_ENTRY_UUID \
  --pass-env NOTION_API_TOKEN -- ctl library init --entry TEST_ENTRY_UUID
```

The same rule applies inside a command run. For example, a harness can invoke
`ntn-skills list --database "$PAIRED_NOTION_ENTRY" --json`. The wrapper only
selects the private executable; it does not choose command flags. A bare `list`
does not become database-scoped because the launcher received `--entry`.

For a new-library scenario, select an authorized test parent explicitly.
`--parent` records the scope and sets `PAIRED_NOTION_PARENT`; it leaves Broker
sources empty and does not initialize anything. Invoke the public CLI command:

```sh
node scripts/paired-environment.mjs run --root /absolute/owned/feature-env \
  --build BUILD_ID --target cli --parent TEST_PARENT_UUID \
  --pass-env NOTION_API_TOKEN -- ctl library init --parent TEST_PARENT_UUID
```

Use the actual ID returned by initialization in subsequent runs. Selecting a
scope does not create a library, import Skills or authorize additional writes
by itself. Supply credentials through the approved process environment; do not
put them in command arguments, examples or committed files. Do not copy the
user's saved configuration, SQLite Store or cache into a new run.

`--entry` and `--parent` express the intended object scope. They do not narrow a
Notion integration's API permissions. A caller with broader credentials could
still issue other requests. Use task-owned remote objects, preserve unknown
write outcomes, and avoid concurrent writers to one Skill or Source. Runs using
the same token still share the remote service's rate limits even with separate
local schedulers.

`--skills /absolute/owned/skills` copies that explicitly selected directory into
the run for Broker discovery. It leaves the local originals intact and does not
enable native Pi Skill loading. `--models /absolute/owned/models.json` selects
an explicit model configuration file. Each `apiKey` value must name an
environment variable; literal credentials, shell expressions and credential
headers are not accepted. Pass that variable by its name using `--pass-env NAME`
for a model run.

Use only inputs approved for the scenario. Neither option copies normal Pi
settings, authentication files or all global Skills. Keep private model
configuration and run evidence outside Git. A missing model or credential is a
setup failure, not a successful model test.

## Verify the isolation

The existing [integration verification Skill](../.agents/skills/verify-notion-skills-integration/SKILL.md)
owns this boundary. The environment entry prepares and runs a selected pair; it
does not replace product tests, the natural scenario corpus or daily delivery.

Run the environment unit tests first:

```sh
node --test scripts/paired-environment.test.mjs scripts/paired-runtime-identity.test.mjs
```

To include the real CLI argument contract, set `NTN_SKILLS_BUILD_ENTRY` to the
chosen installed CLI's absolute `dist/ntn-skills.js` path for that test command.
CI already supplies its built pinned CLI. This checks both the direct CLI target
and command wrapper against consumption and management help, without Notion
credentials or requests. Without that input, the real CLI subtest reports skipped;
the sealed fixture tests alone do not prove compatibility with the product parser.

Then run the smoke check with two independently created environments and their
explicit build IDs:

```sh
node scripts/paired-environment.smoke.mjs \
  --root /absolute/owned/environment-a --build BUILD_A \
  --other-root /absolute/owned/environment-b --other-build BUILD_B
```

The smoke check runs two private CLIs and eight actual Pi processes: two
environments, Broker/native modes, and direct/private-wrapper entries. Each
condition runs both environments concurrently. Captured provider context must
contain the complete selected Skill body and exclude the other environment and
unselected discovery canaries. It observes real commands, tools, argv, settings,
private state, unchanged runtime endpoints and frozen artifacts. Native mode
must use the native Skill command and built-in reader with no Broker registered.
The canaries are task-owned stand-ins for inherited configuration and actual
ancestor discovery; the check does not edit global Skills or replace HOME.
It makes no Notion request and does not call a real model.

Each invocation preserves its fixtures and summary under the first environment's
`proofs/UNIQUE_ID/`. Logs and run receipts remain in each environment's `runs/`.
Inspect `smoke.json` and the referenced evidence;
a failed attempt preserves `failure.json` and returns nonzero. Unit-test results
and this smoke result are separate evidence. Neither establishes live Notion,
real-model onboarding or normal daily acceptance.

For a change to the environment mechanism, also verify the concrete risks:

1. Create two environments from explicit inputs. Confirm distinct Git metadata
   and task branches, with no dependency installation during creation.
2. Build both pairs. Confirm each generation owns its source snapshots,
   dependencies and package outputs. Edit one task source and build another
   generation. Confirm the old generation and the other environment retain
   their recorded bytes; concurrent builds must not share build dependencies.
3. Launch separate runs from explicit build IDs. For two command runs sharing
   one build, change one run's source or dependencies and confirm the build and
   other run remain unchanged. Inspect actual CLI/SDK/Broker paths, state roots,
   scheduler, Pi configuration, session paths and exit results. A successful
   `check` alone does not prove target execution.
4. Confirm an offline run has no inherited Notion token or configured source.
   Record presence and scope without printing secrets. Confirm unrelated global
   configuration and daily executable targets are unchanged.
5. Repeat an occupied build or run ID and verify refusal. Keep the first result
   intact. Verify failures and cancellation retain enough information to locate
   the owned process and unfinished state.

Read the returned evidence and actual target output. Preserve failures and mark
unexecuted layers `not_run`. `--target pi` proves only the Pi behavior actually
observed; it does not by itself prove real model delivery, natural onboarding or
the normal user's installation. Controlled services should request an available
loopback port rather than overwrite an existing listener. End only the child
processes owned by the run.

## Return changes to next

Commit and review changes from the task branches, then integrate through the
normal repository workflow. Do not force-push `next` or change a daily package
pointer merely to test a feature branch. Pair CLI and Broker revisions explicitly
when the shared contract changes.

The [next delivery gate](next-worktree-delivery.md) still requires clean `next`
checkouts, exact current remote commits, matching builds and actual normal Pi
processes. Its branch and freshness checks must not be weakened for task
branches or dirty development sources. The existing natural workflow
`candidate-plan` / `candidate-run` path retains its normal-environment contract;
an isolated run cannot be relabelled as a daily or natural acceptance result.

Retain run state needed by unfinished operations. Once the task no longer needs
its owned directories, follow the existing system-Trash cleanup policy. Do not
delete another environment, reset a shared cache or kill processes by name.
