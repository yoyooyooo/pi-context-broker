# Explicit ordinary-derived resources

The Benchmark SDK subject can load an explicit, frozen selection of ordinary Pi
resources. It uses the existing paired launcher, admission capture, provider
serializer, budgets and collector. The profile does not create another runner.
The default bare Broker and native conditions keep their existing resource
selection when `resource_profile` is absent.

This profile is for comparisons that need real native Skills, context files and
ordinary tool competition. It is **ordinary-derived**. Compaction, retries and
cache warming remain disabled, CodeMode keeps `models:false`, and ToolSearch is
inactive. The profile records its other shared differences, including excluded
lifecycle extensions and omitted prompt templates. It does not claim to reproduce
every aspect of an interactive ordinary session.

## Select one profile

Each setup candidate can provide the same exact descriptor:

```json
{
  "build_id": "explicit-product-and-apparatus-build",
  "mode": "broker",
  "resource_profile": {
    "path": "/owned-task/control/ordinary-resources.json",
    "sha256": "LOWERCASE_SHA256_OF_THE_FILE"
  }
}
```

Configure includes this descriptor in its capture grouping, retained-capture
checks and frozen execution conditions. Execution passes it to the existing
subject as `runtime_config.resourceProfile`. The paired launcher accepts the
corresponding `--resource-profile` and `--resource-profile-sha256` only for a
runtime-only command subject in Broker mode. It cannot be combined with extra
`--pi-extension` arguments. The private CLI wrapper retains its isolated flags;
the Benchmark SDK explicitly supplies context and MCP resources from the profile.

Create new apparatus build IDs after changing the implementation. The build gate
compares the selected source snapshot against the controller's subject, runner,
visibility, finite tool policy, resource reader and credential recorder. A changed
reader or recorder cannot be used with an older frozen apparatus build. Product
CLI and Broker bytes remain selected by the normal paired-build checks.

## Manifest inputs

The manifest has `schema_version:1` and
`kind:"benchmark-ordinary-derived-resources"`. Its `owner_root` is a canonical task
directory containing both the manifest and the paired environment. The manifest,
closure inventories, MCP configuration and private agent-configuration snapshots
are task-owned. Ordinary source files may remain at their explicit, canonical,
read-only locations. The reader does not install packages or discover resources
from the user's home at execution time.

| Field | Contract |
| --- | --- |
| `ordinary_source_refs` | Nonempty descriptors for the retained ordinary-source evidence. Each descriptor has `path`, `sha256`, and optional `bytes`. |
| `extension_order` | Ordered frozen file descriptors with `role:"frozen"` and `closure_ref`, plus exactly one `role:"selected-broker"` placeholder. The placeholder resolves to the current build's selected Broker. |
| `builtin_order` | Exactly `codemode`, `tool_search`, `mcp`, using the SDK's public factories after the ordinary extensions. |
| `native_skills` | Every selected native entry, including entries hidden from model invocation. Each has a file descriptor, `closure_ref` and Boolean `visible`. |
| `context_files` | Ordered file descriptors. The actual SDK receives their exact content through `agentsFilesOverride`; ambient context discovery stays disabled. |
| `mcp_config` | An exact descriptor for the task-owned MCP JSON. Each run receives its own copy. |
| `mcp_command_refs` | Exact executable descriptors, keyed by `server`, for reviewed stdio sources. A stdio command without a matching descriptor is rejected. Args and environment belong to the hashed MCP configuration. |
| `mcp_tools` | Exact expected `mcp__…` registry names. Missing or additional MCP tools fail preparation. |
| `agent_files` | Explicit private agent inputs with `relative_path` and a source descriptor. Paths cannot escape the run's agent directory or replace framework settings, model, auth or MCP files. |
| `settings` | Only `enableSkillCommands:true`; packages are resolved before freezing and are not re-resolved by the run. |
| `excluded_extensions` | Exact paths and reasons for known lifecycle exclusions. Excluded paths cannot also be selected. |
| `shared_differences` | The declared differences from the ordinary source profile. |
| `tool_policy` | Finite execution rules described below. These do not remove tool declarations. |

A closure descriptor points to JSON containing `schema_version:1`, a canonical
`root`, a nonempty `files` array and `sha256` equal to the SHA-256 of
`JSON.stringify(files)`. Each member contains a relative `path`, `sha256` and
optional `bytes`. The selected entry must be a member. These are exact declared
closure members, not a claim that every file in a user's home or installation was
frozen. Additional provenance fields may describe how the closure was prepared.

The reader checks every declared file before loading and after cleanup. Loaded
extension order, native entry bytes and visibility, and context-file order/content
are checked against the profile. Actual source metadata comes from the SDK's
explicit-path loading. Retained ordinary package/source metadata is provenance;
it does not replace the actual runtime owner.

## Private credentials

`agent_files` can name an existing private JSON snapshot that contains credentials.
The source file must be owner-only readable/writable and its parent directory must
be private. Each run copies the original bytes to its own agent directory with
mode `0600`. The manifest, launch receipt and resource evidence retain only file
identity, never the JSON contents.

A credential-bearing descriptor also lists `credential_paths`, an array of exact
JSON key paths. Before extensions load, those values are added to the existing
recorder's redaction set. This protects the known inputs if an extension or tool
error echoes them. It is not a generic classifier for unknown secrets. The
framework's main model/auth/settings files cannot be overridden through this
mechanism. HTTP MCP headers, when used, must refer to explicitly passed environment
variables; literal header credentials and provider-auth selection are rejected.

Profile events, `session-entries.json`, and `episode-result.json` use that same
redaction set, including final-answer and error text. The SDK's original session
JSONL remains in the private run directory with file mode `0600` and parent
directory mode `0700`. Both modes are re-observed in its source descriptor. The registered
session artifact is a separately labelled redacted JSONL copy. It records the
original file identity and hash; it is not described as the original bytes.


## MCP preparation and shared tool policy

The SDK uses `createMcpExtension` with the private configuration, private log and
private credential store. The prepare-only `/mcp` RPC command waits for startup
connections. It reads registry status and does not execute a remote tool. The
runner checks the complete tool registry against the reviewed policy and checks
MCP names against `mcp_tools`.

Deferred MCP startup may activate ToolSearch. After startup, the runner uses the
public SDK loadout API to apply the shared `tool_search:false` condition, preserving
the other active tools. The actual loadout, registry, schemas and source metadata
are captured. Later registry/schema changes or unexpected ToolSearch activation
stop the episode before a tool implementation or another model request.

`tool_policy` contains disjoint `allowed_tools` and `blocked_tools` arrays. Their
union is the expected registry. Unknown tools are outside the frozen contract.
`blocked_parameters` contains only reviewed exact rules:

```json
{
  "tool": "example_tool",
  "path": ["answerModel"],
  "when": "present",
  "reason": "This option starts an unmetered derived model."
}
```

`when` is `present`, `truthy`, or `not_equal`. The last requires one literal
string `value` and rejects a missing or different value. It allows a reviewed
explicit provider/mode without authorizing the tool's automatic defaults. The
guard does not infer actions from arbitrary parameter names, descriptions or shell text. Ordinary Bash can remain available
for authorized read-only investigation. Its arbitrary contents are not an OS
sandbox or a general command-permission boundary.

The observer's `tool_call` handler runs before other extension handlers. Pi's
ordinary direct calls, deferred MCP calls and CodeMode child calls use this same
SDK boundary. A blocked call retains its original call and parent IDs, records
`tool_call_blocked` with `executed:false`, and stops with
`BENCHMARK_OUT_OF_SCOPE_TOOL`. The episode is invalid because the attempted action
is outside the apparatus authorization. It is not a fabricated successful tool
result, a business failure attributed to a baseline, or a candidate improvement.
Already sent requests, fallback attempts and reported usage remain accounted.

Module initialization, extension lifecycle hooks and arbitrary subprocess work do
not all pass through `tool_call`. Known automatic remote-write extensions must be
excluded explicitly. The profile and documentation must state the remaining
boundary; loading more ordinary resources does not make the entire process a
sandbox.

## Verification

The targeted tests cover source/closure drift, hidden native entries, exact
context, private copies, credential redaction, selected-Broker ownership,
registry drift, build identity and preserved usage after a rejected child call.
The maintained SDK proof can run without a model request:

```sh
BENCHMARK_PI_SDK_ENTRY=/absolute/maintained-pi/dist/index.js \
  node --test benchmark/runtime/episode-resource-profile.test.mjs
```

That proof constructs a synthetic parent message and invokes the actual CodeMode
executor. Its deferred child goes through the SDK tool pipeline; the blocked
implementation and later third-party hook execute zero times. This is an apparatus
proof, not a natural-language or business benchmark result. Actual ordinary-derived
admission must still be captured through the new frozen builds before paid runs.
