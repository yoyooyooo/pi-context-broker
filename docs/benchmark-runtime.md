# Benchmark episode runtime

`benchmark/runtime/episode-runner.mjs` exports `runEpisode(config, hooks?)`.
The shared `scripts/paired-environment.mjs` launcher still owns the private run,
paired CLI/Broker packages, selected maintained tools and process group. The
Benchmark subject wrapper projects the runtime into that run before calling it.
This entry uses the maintained Pi **public SDK**, recorded as `entry_kind: pi-sdk`.
It does not claim to have executed the Pi CLI command in `pi-launch.json`.

## Inputs and isolation

The configuration is a public subject plan. It must not contain an oracle,
expected business answers, private grader decisions or private controller events.
Every natural turn is supplied in advance as `{id, prompt, kind?}` and delivered
in order to one `AgentSession`. A clarification response is another public turn.
The runtime does not choose a follow-up prompt from a grader result.

```js
await runEpisode({
  version: 1,
  runRoot, buildRoot, workspace, agentDir, controlDir,
  visibility: '/absolute/run/subject-visibility.json',
  mode: 'native', // or 'broker'
  runtime: { node: '/selected/node', pi: '/selected/pi/dist/bundle/cli.js', bun: '/selected/bun' },
  model: {
    provider: 'configured-provider', id: 'configured-model',
    api: 'openai-responses', baseUrl: 'https://provider.example/v1',
    apiKeyEnv: 'BENCHMARK_PROVIDER_KEY',
    parameters: { thinkingLevel: 'off', maxTokens: 4096 },
  },
  limits: {
    wallTimeMs: 180000, maxModelRequests: 10, maxHttpAttempts: 10,
    maxToolCalls: 40, maxInputTokens: 300000,
    maxOutputTokens: 16000, maxTotalTokens: 316000,
  },
  codeMode: { policy: 'free', enabled: true, toolSearchEnabled: false, models: false },
  admission: { captureOnly: false, expectedFile: '/absolute/public/candidate-expectation.json' },
  turns: [{ id: 'turn-1', prompt: 'The natural user request.' }],
  correlation: { run_id: 'run-1', episode_id: 'episode-1', candidate_id: 'candidate-a' },
});
```

The shared launcher supplies `models.json`; the SDK resolves the exact physical
provider/model from it. Missing models, model fallback, changed API/base URL,
changed thinking level, auxiliary model access and unsupported parameters fail.
Model catalog network refresh, automatic agent/provider retries, provider cache warmup
and automatic compaction are disabled. The runtime explicitly loads the public
CodeMode and tool-search factories. The shared profile disables MCP. CodeMode
`off` leaves its registered tool inactive and rejects attempts to call it;
`free` and `required` enable it. Whether a required diagnostic actually used it
is an evidence/grading decision, not a fabricated tool invocation.

The subject wrapper moves the shared command run's `source/` outside the subject
run. `projectSubjectRuntime` in [subject.mjs](../benchmark/subject.mjs) selects
the exact public dependency inventory: non-test episode modules, turn bridge,
reported-model binding, maintained observation helpers, native-reference adapters
and the paired reference producer/runtime manifest. Private fixture and grading
code remain outside that projection.
The visibility receipt is:

```json
{
  "version": 1,
  "source_moved_outside_run": true,
  "projection_root": "subject-runtime",
  "files": [{"path": "benchmark/runtime/episode-runner.mjs", "sha256": "...", "bytes": 123}]
}
```

The runtime checks the exact projected inventory, its own module location,
absence of `run/source`, and removal of source-directory environment variables.
This is an auditable declaration of visible materials. It is not an OS sandbox:
processes running as the same user retain the filesystem permissions of that user.

## Candidate admission

Run with `admission.captureOnly: true` to produce
`controlDir/candidate-expectation.json`. Capture collects the actual public SDK
resource loader's complete extension census, including extensions with only event
handlers. It records loaded entry identities and handlers, actual native Skills
and their files/resources, tool schemas/guidance/exposure, active/callable tools,
commands, settings, model configuration, source configuration, paired package
identity, explicit SDK/adapter module hashes and the visible runtime inventory.

For Broker it joins initial discovery through status, awaits the public
`notion_list({})` metadata tool's publication boundary, then reads roots and
catalogs. This declared preparation probe is recorded separately and is never
delivered as a model message or business tool call. It does not request a forced
refresh. The run starts with private source caches; preparation and business
costs keep their own stages. This admission procedure alone does not establish
ordinary end-user cold-start performance.
A deny-stream is installed before these operations; an unexpected model dispatch
is a failure. The current initial system prompt and active tool declarations also
pass through Pi's public context transform. This preview is labeled separately
because an initially empty session has no persisted system message yet.

Capture then sends a fixed, nonbusiness admission input through the real Pi
serializer. The outer `StreamOptions.onPayload` callback waits for all normal Pi
extension transformations, records the final payload and throws **before fetch**.
It therefore observes the actual final system/guidance/tool contract with zero
provider transmissions. Throwing inside a `before_provider_request` extension is
insufficient: Pi catches those errors. The guard sits outside that dispatch.

The expectation contains `{version, kind, projection, request_contract}`. The
controller reviews/freezes its hash and passes it as `expectedFile`; capture alone
does not authorize execution. At execution startup, the complete observation
must match. Run/build prefixes are normalized; runtime, schema, guidance and
resource hashes remain significant. Human-readable Broker root notifications
abbreviate paths, so only their status/count/label enter comparison; the actual
configured root paths and complete file inventory are compared independently.
At the first real task's final serialization,
the request contract is compared again after removing only that exact public
user message. Other user-role guidance is retained. Session cache identity values
are normalized while their presence and types remain observable.

Later turns keep the same live session. Each actual model context, final payload,
effective output cap and model selection is recorded. Subsequent task-dependent
history is not compared to an empty admission conversation.

## Requests, attempts and usage

`request_id` identifies one Pi stream invocation. Every call to the public
provider `fetch` hook obtains a distinct `attempt_id`; actual sends are reconciled
against passive Node/Undici request records. The fetch guard checks admission,
the exact endpoint origin/path prefix, cumulative attempt count and budget state
before forwarding. The frozen retry policy is zero: a second fetch in one logical
request is stopped even if an adapter attempts it despite its retry setting.
Redirects are rejected. It returns the original response and
does not consume or replace the response stream.

The existing transport observer records HTTP entity bytes, hashes, status,
duration and incomplete/error boundaries. Those are **not TCP/TLS wire bytes**.
The result retains `sent: null` when transmission cannot be established. Missing
transport records or payload/body hash disagreement reduce evidence coverage.
No later successful request supplies usage to a failed earlier attempt.

Every parsed native provider stream event is retained with its request and
attempt association. The authoritative assistant message and Pi-normalized usage
are retained separately. For the supported OpenAI Completions and Responses
adapters, raw input includes cached tokens and raw output includes reasoning.
Pi 1.6.0 normalizes input by subtracting cache-read and cache-write tokens, while
keeping reasoning inside output. Do not add those subsets twice. Unreported
fields remain null. An all-zero normalized Pi usage object does not establish
that the provider reported usage.

Input, output and total token budgets are cumulative across the episode. The
effective provider output cap is reduced to the remaining output allowance and
verified in the final serialized payload. Before sending, a recorded UTF-8 byte
heuristic checks remaining input/total allowance. It is not a tokenizer or a
mathematically established upper bound. Actual raw usage is checked on receipt;
the last request can exceed the preflight estimate. Missing or inconsistent usage
stops subsequent requests. Output/request/HTTP/tool/wall limits and their stop
events remain separate from product failures.

## Tools, completion and evidence

The Notion observer starts before Broker factory loading. It reuses the maintained
passive source transport observer and graph SDK receipt collector through public
`context-broker.notion-sdk` and `context-broker.notion-sdk-result` diagnostics.
No SDK method, global fetch implementation or response stream is replaced. Actual
SDK operations and their metrics remain separate from provider requests and Pi
tools. The public metrics contain actual HTTP attempt kinds, targets, status,
byte counts and timing; they do not claim TCP/TLS byte counts.

The current SDK v3 observer includes `library-selection`, `library`, `list`,
`files`, `consume`, `read`, `read-resources`, `resolve`, and `content-search`.
It records the Library identity and marks the terminal source contract explicitly.
Its public dependency projection includes the exact paired Skill-ref-v2 parser;
private corpus, oracle and grading code remain outside the subject projection.
The collector verifies those captured bytes against the frozen paired build.

The retained SDK v2 operation set is `list`, `files`, `consume`, `read`,
`read-resources`, and `resolve`. Its historical interpretation stays separate.
Resolve observation was backported from
[next commit b2c441b](https://github.com/yoyooyooo/pi-context-broker/commit/b2c441ba8fe8ed695ff2cf6e6a6579b3895cf31a)
without changing the frozen experiment's input or attribution schema.
A completed resolution with a paired start, result and end plus complete
zero-request metrics is observable without inventing HTTP traffic. Resolution
alone does not prove body or resource delivery. Unknown operations, invalid IDs,
duplicate or unpaired events, and missing successful results or terminal events
remain incomplete evidence. Changes to these observers change runtime and
collector source identities; they do not repair previously retained episodes.

`notion-source.jsonl` retains the maintained source observer's hash chain.
`notion-sdk.jsonl` indexes actual SDK lifecycles, and
`notion-responses/<operation UUID>.json` retains each actual SDK result. For a
successful `read` that writes a file, the collector reads that completed owned
file, verifies its bytes and hash against the SDK return value, and retains UTF-8
content when available. This readback makes no additional source request.
Consumption and resource receipts retain their actual manifests and source bytes.
The regular event stream also records `notion_sdk_event` and `notion_sdk_result`.
Known model and Notion credential values pass through the same redaction boundary.

Each operation records its start stage (`prepare`, `admission`, `user_task`,
`controller_pause` or `cleanup`), current turn/model request and active tool IDs.
Active tools are temporal context, not proof that one specific tool caused the
SDK request. The runtime leaves `tool_call_id` null. Analysis must correlate the
returned source identity/hash with actual tool/session delivery. Background
directory loading or prefetch alone never establishes model consumption.

Configured enabled Notion sources require an actual successful catalog result
before admission. Catalog identity, description, policy, versions and content
hashes enter the candidate projection; only documented observation clocks and
request metrics are excluded. Within the combined directory facet, the service's
per-request `view_query.id` and `view_query.expires_at` are excluded as well;
the selected view ID, query semantics, counts, pagination and all record/source
identities remain significant. Raw observations retain all these fields. The complete
catalog is checked again at the first final payload. Actual final system/tool
contracts separately establish which directory and deferred tools were delivered.

`session_event` stores actual Pi events, including tool start/update/end events
and their `parentToolCallId`. `tool_call` and `tool_result` preserve the boundary
arguments, results, errors and nested calls. A failed CodeMode parent can therefore
coexist with a successful child and an observed remote effect. The runtime does
not convert a tool result into a business-success judgment.

Collector 1.2.0 can treat a CodeMode call as a transparent container only when
the retained native `nestedCalls.complete` census matches every actual child
callback: IDs, names, full arguments, terminal status, ancestry, turn and lifetime.
The direct-call census must also match. The parent and all executed descendants
must succeed; every descendant is still classified separately. Shell calls and
unknown tools remain opaque, including calls whose failure was caught by a script.
Neither script source nor a correct business output proves an unobserved read.

The container exemption additionally requires matching frozen admission and
before/after runtime evidence for the reviewed Pi builtin wrapper modules
(`codemode/index.js`, `tool.js` and `execute.js`), with `models:false` and builtin
tool ownership. Unknown module bytes retain the opaque classification. The
collector pins the reviewed wrapper contract; this is not an attestation of the
entire Pi installation, worker/Wasm dependency closure or operating-system isolation.
The readback retains the admission and census references behind the exemption.

A resource short reference without its own child receipt can be recovered from
an earlier complete, verified preparation projection in the same user turn.
Its public token must map unambiguously to the canonical owner, scope, snapshot,
version, path, hash and byte count. The actual child result must contain the full
matching text, and both the independent material version and observed SDK source
identity must agree. Conflicting tokens, partial text, unverified preparations
and cross-turn reuse do not qualify. These are matching bytes and identities;
they do not establish a causal association between a tool call and an SDK operation.

Corrections are saved by the existing offline `reanalysis` command in a new
directory. The collector version, actual source hash, retained import closure
and `reanalysis_of` identity distinguish the new view without changing the old
admission, usage, stop or grade artifacts. The normalizer and success criteria
remain unchanged.

Each user turn records start/end monotonic times, the same session ID, final text,
`agent_settled`, and a measured workspace file inventory. The optional
`hooks.afterTurn({turn_id, ref})` lets the controller pause for its own independent
readback. The hook supplies no additional prompt. Business success and its first
observed completion time belong to the independent grader/readback; the runtime
leaves `time_to_success_ms` null.

The runtime returns and writes `controlDir/episode-result.json`. Status is one of
`captured`, `completed`, `admission_rejected`, `budget_stopped`, `invalid`,
`failed`, or `cancelled`. `completed` means the supplied natural turns settled;
it does not mean the independent business oracle passed. Abort/shutdown/disposal
are bounded and recorded. Only the enclosing shared launcher can prove process
exit; the child explicitly requires that parent receipt.

Artifacts use `{id, path, sha256, bytes, kind}`. References point to an artifact's
final hash and either a one-based JSONL `line` or a JSON `pointer`; a JSONL usage
reference also gives the pointer within that line. `events.jsonl` is append-only,
with sequence, UTC wall time and process monotonic nanoseconds. The final artifact
hash is attached after closing the writer. Known credential values are redacted;
authorization headers are not collected. The private raw observations are not a
ready-to-publish report.

Coverage for attempts, tools and interventions is explicit: `complete`, `partial`
or `unavailable`. `result.notion.coverage` separately reports SDK operations,
owned HTTP metrics and direct child lifecycle. Descendant transport remains
`unobserved`. Missing metrics remain unknown and invalidate an otherwise successful
episode's complete observation claim. Notion operation `receipt_ref` identifies
its hash-bound JSON artifact; `source_request_id` joins that operation to its HTTP
metrics without conflating it with a model request.
Runtime instrumentation records synchronous event-write time,
JSON artifact-write time and output volume. Those measurements do not claim to
measure total observer CPU or network overhead.

## Verification

Run pure policy/contract checks with:

```sh
node --test benchmark/runtime/episode-policy.test.mjs benchmark/runtime/episode-notion.test.mjs
```

Run `episode-sdk.test.mjs` through the shared command launcher, using the selected
maintained Node/Pi. It starts only owned loopback HTTP fixtures and writes
`run/sdk-apparatus-proof/adapter-evidence.json`. The proof traverses the installed
Completions and Responses serializers/stream parsers, verifies actual cache and
reasoning semantics, proves silent-extension census and the outer pre-send guard,
and exercises a CodeMode parent failure with a successful nested read. Its JSON
retains actual adapter module hashes and raw requests/events. It is apparatus
validation, not a real-provider pilot or a natural business Benchmark result.
The Notion observer tests use controlled public diagnostic events and owned local
files to verify the apparatus, incomplete-evidence behavior and credential
redaction. They do not claim that those fixtures contacted Notion.
