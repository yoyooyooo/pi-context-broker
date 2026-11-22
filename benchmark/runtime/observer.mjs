import { appendFileSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const noncePattern = /^[a-f0-9]{32}$/;
const rootNames = [
  'PAIRED_RUN_ROOT', 'PAIRED_BUILD_ROOT', 'PAIRED_CLI_SOURCE', 'PAIRED_BROKER_SOURCE',
  'PAIRED_CLI_ENTRY', 'PAIRED_BROKER_ENTRY', 'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR', 'CONTEXT_BROKER_CONFIG', 'NTN_SKILLS_CONFIG_HOME',
  'NTN_SKILLS_HOME', 'NTN_SKILLS_CACHE_HOME', 'NTN_SKILLS_DATA_HOME',
  'NTN_SKILLS_SCHEDULER_ROOT', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME',
  'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'TMPDIR',
];
const settingNames = [
  'defaultProvider', 'defaultModel', 'defaultThinkingLevel', 'modelThinkingLevels',
  'transport', 'steeringMode', 'followUpMode', 'compaction', 'branchSummary', 'retry',
  'packages', 'extensions', 'skills', 'prompts', 'enableSkillCommands', 'enabledModels',
  'defaultTools', 'thinkingBudgets', 'codemode', 'sessionDir', 'cacheWarming',
  'httpIdleTimeoutMs', 'websocketConnectTimeoutMs',
];
const promptOptionNames = [
  'customPrompt', 'forceSystemPrompt', 'selectedTools', 'hiddenTools', 'toolSnippets',
  'toolGuidelines', 'promptGuidelines', 'appendSystemPrompt', 'sections', 'cwd',
  'contextFiles', 'skills',
];
const select = (value, names) => Object.fromEntries(
  names.filter(name => value?.[name] !== undefined).map(name => [name, value[name]]),
);
const modelSelection = model => model == null ? null : select(model, [
  'provider', 'id', 'name', 'api', 'baseUrl', 'type', 'reasoning', 'input',
  'contextWindow', 'maxTokens', 'cost',
]);
const sourceInfo = source => select(source, ['path', 'source', 'scope', 'origin', 'baseDir']);

export default function benchmarkObserver(pi) {
  const nonce = process.env.BENCHMARK_PHASE_ZERO_NONCE;
  const runRoot = process.env.PAIRED_RUN_ROOT;
  if (!noncePattern.test(nonce ?? '') || !runRoot || !isAbsolute(runRoot)) {
    throw new Error('BENCHMARK_OBSERVER_REQUIRES_OWNED_PHASE_ZERO_RUN');
  }
  const evidenceRoot = join(runRoot, 'benchmark');
  for (const directory of [runRoot, evidenceRoot]) {
    if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) {
      throw new Error('BENCHMARK_OBSERVER_ROOT_NOT_CANONICAL');
    }
  }
  const eventsPath = join(evidenceRoot, 'observer-events.jsonl');
  if (!lstatSync(eventsPath).isFile() || lstatSync(eventsPath).isSymbolicLink()) {
    throw new Error('BENCHMARK_OBSERVER_EVENT_FILE_NOT_RESERVED');
  }
  const entryPath = realpathSync(fileURLToPath(import.meta.url));
  const entryHash = createHash('sha256').update(readFileSync(entryPath)).digest('hex');
  const record = (event, details = {}) => appendFileSync(eventsPath, JSON.stringify({
    schema_version: 1, event, nonce, pid: process.pid,
    monotonic_ns: process.hrtime.bigint().toString(), ...details,
  }) + '\n', { mode: 0o600 });

  // This provider has no transport. An accidental Agent request is a failed
  // probe, never a paid request or a simulated successful model response.
  pi.registerProvider('benchmark-phase0', {
    name: 'Benchmark Phase 0',
    api: 'benchmark-phase0-no-request',
    apiKey: 'benchmark-phase0-no-network',
    baseUrl: 'http://127.0.0.1:9',
    streamSimple() {
      record('unexpected_provider_invocation');
      throw new Error('BENCHMARK_PHASE_ZERO_MODEL_INVOCATION_FORBIDDEN');
    },
    models: [{
      id: 'no-request', name: 'No model request', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768, maxTokens: 1,
    }],
  });

  pi.on('session_start', event => record('session_start', { reason: event.reason }));
  pi.on('before_agent_start', () => { record('before_agent_start'); });
  pi.on('agent_start', () => { record('agent_start'); });
  // This hook only observes. Pi catches hook exceptions, so it is not a gate.
  pi.on('before_provider_request', () => { record('before_provider_request'); });
  pi.on('after_provider_response', () => { record('after_provider_response'); });
  pi.on('session_shutdown', () => { record('session_shutdown'); });

  pi.registerCommand('benchmark-inspect', {
    description: 'Capture the Phase 0 runtime before any business task.',
    handler: async (args, ctx) => {
      if (!noncePattern.test(args) || args !== nonce) {
        record('inspection_rejected', { reason: 'nonce_mismatch' });
        throw new Error('BENCHMARK_INSPECTION_NONCE_MISMATCH');
      }
      const snapshot = {
        schema_version: 1,
        kind: 'benchmark-pi-observation',
        nonce,
        observer: { path: entryPath, sha256: entryHash },
        process: {
          pid: process.pid, node: process.execPath, version: process.version,
          argv: [...process.argv], cwd: process.cwd(),
        },
        roots: select(process.env, rootNames),
        settings: select(pi.getSettings(), settingNames),
        model_selection: modelSelection(ctx.model),
        thinking_level: pi.getThinkingLevel(),
        commands: pi.getCommands().map(command => ({
          ...select(command, ['name', 'description', 'source']),
          sourceInfo: sourceInfo(command.sourceInfo),
        })),
        tools: pi.getAllTools().map(tool => ({
          ...select(tool, [
            'name', 'description', 'parameters', 'promptGuidelines', 'exposure',
            'namespace', 'annotations',
          ]),
          sourceInfo: sourceInfo(tool.sourceInfo),
          has_reaches_tools: typeof tool.reachesTools === 'function',
        })),
        active_tools: pi.getActiveTools(),
        prompt_options: select(ctx.getSystemPromptOptions(), promptOptionNames),
        system_prompt: ctx.getSystemPrompt(),
        collection: {
          point: 'handled_command_after_rpc_startup',
          tools: 'public_registered_definitions_and_active_names',
          extensions: 'registered_resource_sources_only',
          model: 'selected_phase_zero_model_not_a_paid_backend',
          prompt: 'effective_initial_prompt_not_a_provider_request',
        },
      };
      const snapshotPath = join(evidenceRoot, `observation-${nonce}.json`);
      writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + '\n', {
        flag: 'wx', mode: 0o600,
      });
      record('snapshot_written', {
        path: snapshotPath,
        sha256: createHash('sha256').update(readFileSync(snapshotPath)).digest('hex'),
      });
    },
  });
  record('observer_ready', { path: entryPath, sha256: entryHash });
}
