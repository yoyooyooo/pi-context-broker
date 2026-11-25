import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { validateRoutingPolicy } from './reported-model.mjs';
import { validModelWindow } from './model-window.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const APIS = new Set(['openai-completions', 'openai-responses']);
const cleanModel = (value, providerApi) => {
  const api = value.api ?? providerApi;
  assert.ok(APIS.has(api), 'Model API needs a verified adapter before it can be selected: ' + api);
  assert.ok(typeof value.id === 'string' && value.id.length > 0);
  assert.ok(Number.isSafeInteger(value.contextWindow) && value.contextWindow > 0);
  assert.ok(Number.isSafeInteger(value.maxTokens) && value.maxTokens > 0);
  return { id: value.id, name: value.name ?? value.id, api, reasoning: value.reasoning === true,
    input: value.input ?? ['text'], contextWindow: value.contextWindow, maxTokens: value.maxTokens,
    ...(value.compat ? { compat: value.compat } : {}),
    // Pi requires numeric cost metadata. These zeros are explicitly unpriced, never monetary evidence.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
};

/** Reads only explicitly selected routes; never writes credentials or global Pi settings. */
export async function snapshotModels({ sourceFile, provider, modelIds, outputFile, apiKeyEnv = 'BENCHMARK_MAGPIE_KEY' }) {
  assert.ok(isAbsolute(sourceFile) && isAbsolute(outputFile));
  assert.ok(Array.isArray(modelIds) && modelIds.length > 0 && new Set(modelIds).size === modelIds.length);
  assert.match(apiKeyEnv, /^[A-Z][A-Z0-9_]{2,79}$/);
  const source = JSON.parse(await readFile(sourceFile, 'utf8'));
  const selected = source.providers?.[provider];
  assert.ok(selected, 'Selected provider is absent');
  assert.ok(typeof selected.baseUrl === 'string');
  const url = new URL(selected.baseUrl);
  assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password);
  assert.ok(!selected.headers || Object.keys(selected.headers).length === 0, 'Custom authentication headers require an explicit credential adapter');
  const models = modelIds.map(id => {
    const matches = selected.models.filter(model => model.id === id);
    assert.equal(matches.length, 1, 'Selected model is missing or ambiguous: ' + id);
    return cleanModel(matches[0], selected.api);
  });
  const value = { providers: { [provider]: { api: selected.api, baseUrl: selected.baseUrl, apiKey: apiKeyEnv, models } } };
  const bytes = JSON.stringify(value, null, 2) + '\n';
  try { await writeFile(outputFile, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(await readFile(outputFile, 'utf8'), bytes, 'Previously selected model registry changed'); }
  return { version: 1, path: outputFile, sha256: hash(bytes), provider, base_url: selected.baseUrl, api_key_env: apiKeyEnv,
    pricing: 'unknown', fallback: 'forbidden', models: models.map(({ cost, ...model }) => model) };
}

/** Call only in the controller process. Do not serialize or log the returned value. */
export async function resolveModelCredential({ sourceFile, provider, apiKeyEnv = 'BENCHMARK_MAGPIE_KEY', inherited = process.env }) {
  assert.ok(isAbsolute(sourceFile));
  assert.match(apiKeyEnv, /^[A-Z][A-Z0-9_]{2,79}$/);
  const source = JSON.parse(await readFile(sourceFile, 'utf8'));
  const declared = source.providers?.[provider]?.apiKey;
  assert.ok(typeof declared === 'string' && declared.length > 0, 'Selected provider credential is unavailable');
  assert.ok(!declared.startsWith('!'), 'Shell credential commands need a separately declared credential adapter');
  const value = inherited[declared] ?? declared;
  return { [apiKeyEnv]: value };
}

export function verifiedModelConditions({ registry, adapterReceipts, parameters, window, routing }) {
  assert.ok(validModelWindow(window), 'Model condition window is invalid');
  if (routing !== undefined) {
    assert.ok(routing && typeof routing === 'object' && !Array.isArray(routing), 'Routing policies must be keyed by selected route');
    assert.deepEqual(Object.keys(routing).sort(), registry.models.map(model => model.id).sort(), 'Every selected route needs exactly one frozen routing policy');
    for (const policy of Object.values(routing)) validateRoutingPolicy(policy);
  }
  return registry.models.map(model => {
    const adapter = adapterReceipts.find(value => value.api === model.api);
    assert.ok(adapter?.status === 'passed' && /^[a-f0-9]{64}$/.test(adapter.sha256), 'No verified API/usage receipt for ' + model.api);
    assert.ok(Number.isSafeInteger(parameters.maxTokens) && parameters.maxTokens > 0 && parameters.maxTokens <= model.maxTokens);
    return { id: registry.provider + '/' + model.id, family: model.id, provider: registry.provider, route: model.id, api: model.api,
      ...(routing === undefined ? {} : { routing: structuredClone(routing[model.id]) }),
      adapter: { id: adapter.id, version: adapter.version, verification: 'verified', evidence_sha256: adapter.sha256 },
      parameters, backend: { identity: null, observability: 'opaque_alias', window },
      adoption: { mode: 'as_is', development_budget_id: null, development_material_ids: [], confirmation_material_ids: [] } };
  });
}
