import assert from 'node:assert/strict';
import diagnostics from 'node:diagnostics_channel';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path, { dirname, isAbsolute, join, resolve } from 'node:path';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { observeProviderTransport, readProviderTransport } from '../../scripts/skill-consumption-provider.mjs';
import { bindReferences, candidateDifferences, createEpisodeRecorder, exists, fileIdentity, inside, inventory, normalizeCandidate, observeSharedGit, readJson, sha256 } from './episode-evidence.mjs';
import { codemodeExtensionOptions, createEpisodeBudget, createEpisodeToolGuard, EpisodeStop, guardedFetch, providerUsage } from './episode-policy.mjs';
import { observeEpisodeNotion } from './episode-notion.mjs';
import { readResourceProfile, validateResourceProfileRef } from '../../scripts/paired-resource-profile.mjs';
import { assessReportedModel, providerReportedModel, validateRoutingPolicy } from '../reported-model.mjs';
import { nativeFileRef } from '../../packages/context-broker/src/native-reference.ts';
import { assertRunSourceAbsent, assertSourceEnvironmentAbsent, sourceVisibility } from './episode-visibility.mjs';

const selectionPath = value => typeof value === 'string' ? value : value?.path ?? value?.entry;
const stripMessageTime = messages => messages.map(({ timestamp, ...message }) => message);
const selectedModel = model => Object.fromEntries(['id', 'name', 'provider', 'api', 'baseUrl', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens', 'compat', 'samplingParams', 'samplingParamsByThinkingLevel'].filter(key => model?.[key] !== undefined).map(key => [key, model[key]]));
const errorData = error => ({ name: error?.name ?? 'Error', code: error?.code ?? null, message: String(error?.message ?? error), details: error?.details ?? null });
const bounded = async (promise, milliseconds, fallback) => { let timer; try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(fallback), milliseconds); })]); } finally { clearTimeout(timer); } };

/** Preserve a settled business episode while separate management remains
 * unresolved. Startup captures still require idle preparation; ordinary SDK,
 * HTTP and direct-child evidence cannot borrow completeness from management. */
export async function finishEpisodeNotion({ notion, status, record }) {
  const idle = await notion.waitIdle(2000), result = await notion.finish();
  const complete = result.coverage.sdk === 'complete' && result.coverage.owned_http === 'complete';
  const managementPending = result.management?.coverage === 'partial'
    && result.management.operations.some(operation => !operation.results.length || operation.results.at(-1).status === 'pending');
  const retainUnsettledManagement = status === 'completed' && complete
    && result.coverage.child_lifecycle === 'complete' && managementPending;
  record('notion_cleanup', { idle, coverage: result.coverage,
    management_pending: Boolean(managementPending), management_pending_separated: !idle && Boolean(retainUnsettledManagement) });
  return { result, status: ['captured', 'completed'].includes(status)
    && (!complete || !idle && !retainUnsettledManagement) ? 'invalid' : status };
}

/** Status joins the existing catalog owner. The public metadata tool also waits
 * for host publication, which can outlive SDK transport. Its result is evidence
 * of preparation only: never a model message, adopted Skill or business call. */
export async function awaitBrokerAdmission({ session, sources = [], signal, record = () => {}, save = async () => null }) {
  signal?.throwIfAborted();
  await session.prompt('/context-broker status');
  signal?.throwIfAborted();
  if (sources.some(source => source.type === 'notion' && source.enabled !== false)) {
    const tool = session.getToolDefinition('notion_list');
    assert.equal(typeof tool?.execute, 'function', 'BENCHMARK_NOTION_ADMISSION_TOOL_UNAVAILABLE');
    assert.equal(typeof session.extensionRunner?.createToolContext, 'function', 'BENCHMARK_TOOL_CONTEXT_UNAVAILABLE');
    const callId = 'benchmark-admission-notion-directory';
    record('admission_metadata_probe_start', { tool: 'notion_list', input: {}, scope: 'prepare-only; no model delivery or Skill adoption' });
    let result;
    try {
      result = await tool.execute(callId, {}, signal, undefined, session.extensionRunner.createToolContext(callId, signal));
      signal?.throwIfAborted();
    } catch (error) {
      record('admission_metadata_probe_error', { tool: 'notion_list', error: errorData(error) });
      throw error;
    }
    const resultRef = await save('admission-notion-directory', result);
    record('admission_metadata_probe_end', { tool: 'notion_list', result_ref: resultRef, ok: result?.details?.ok === true && result?.isError !== true });
    assert.ok(result?.isError !== true && result?.details?.ok === true, 'BENCHMARK_NOTION_STARTUP_UNAVAILABLE');
  }
  for (const command of ['roots', 'catalogs']) {
    signal?.throwIfAborted();
    await session.prompt('/context-broker ' + command);
  }
  signal?.throwIfAborted();
}

/** A blocked SDK stream call has no request identity and cannot replace the
 * previous assistant receipt. Preserve its local exception before SDK wrapping. */
export function reserveEpisodeRequest({ budget, captureOnly, clearRequest, onStop, priorStop, checkContract = () => {} }) {
  clearRequest();
  try { if (!captureOnly && priorStop) throw priorStop; checkContract(); return captureOnly ? 1 : budget.request(); }
  catch (error) { onStop(error); throw error; }
}

/** Run only after the current response has drained. Account usage before deciding
 * whether a later request is allowed; a wrong variant still consumed resources. */
export function finishEpisodeRequest({ request, budget, routing, captureOnly, record, onStop }) {
  if (!request || captureOnly || request.accounted) return;
  if (request.attempts.length > 0) budget.usage(request.usage ?? null);
  request.accounted = true;
  record('request_usage_accounted', { request_id: request.id, raw_usage_observed: Boolean(request.usage), guarded_fetch_attempts: request.attempts.length, budget: budget.state });
  if (!routing) return;
  for (const attempt of request.attempts) {
    const observations = attempt.reported_model_observations ?? [];
    // The independent transport ledger establishes actual send status in cleanup.
    // A response proves a send here; a fetch failure keeps send status unknown.
    const sent = attempt.sent === true || attempt.response_ref || observations.length ? true : attempt.sent === false ? false : null;
    const report = assessReportedModel({ routing, sent, observations,
      providerError: Boolean(attempt.error_ref) || attempt.status >= 400, refs: [attempt.start_ref].filter(Boolean) });
    attempt.reported_model = report;
    record('reported_model_checked', { request_id: request.id, attempt_id: attempt.id, ...report });
    if (report.reason) onStop(new EpisodeStop('BENCHMARK_' + report.reason.toUpperCase(), { request_id: request.id, attempt_id: attempt.id, reported_model: report }));
  }
}

/** Candidate handles are random per branch. Resolve them with the actual product
 * reducer, then bind them to the independently observed complete catalog. */
export function catalogCandidateReferences({ shortRefs, catalogs, formatReference = nativeFileRef }) {
  assert.ok(shortRefs?.bindings instanceof Map, 'BENCHMARK_CATALOG_REFERENCE_STATE_REQUIRED');
  assert.ok(Array.isArray(catalogs?.catalogs), 'BENCHMARK_CATALOG_REFERENCE_CATALOG_REQUIRED');
  const records = catalogs.catalogs.flatMap(catalog => catalog.facets
    .filter(facet => facet.facet === 'catalog' && facet.ok === true)
    .flatMap(facet => facet.value.records.map(record => ({ scope: facet.value.scope, record }))));
  const references = [];
  for (const [ref, target] of shortRefs.bindings) {
    if (target.kind !== 'candidate') continue;
    assert.ok(/^sr:C[A-Za-z0-9_-]{22}$/.test(ref), 'BENCHMARK_CATALOG_REFERENCE_KIND');
    const identity = target.identity;
    const matches = records.filter(({ scope, record }) => identity.source === 'notion' && identity.scope === scope
      && identity.id === record.id && identity.kind === record.kind && record.enabled === true
      && JSON.stringify(normalizeCandidate(identity.locator, {})) === JSON.stringify(normalizeCandidate(record.locator, {}))
      && record.ref === formatReference(identity.ref, record.entrypoint));
    assert.equal(matches.length, 1, 'BENCHMARK_CATALOG_REFERENCE_IDENTITY_MISMATCH');
    const binding = { identity: structuredClone(identity), record: structuredClone(matches[0].record) };
    references.push({ ref, ...binding, canonical: 'benchmark-candidate:' + sha256(JSON.stringify(normalizeCandidate(binding, {}))) });
  }
  return references;
}

/** Preloaded handles are proven against independently observed SDK consume
 * entries. The product reducer supplies scope and owner; source manifests supply
 * immutable body and file identity. Neither source alone can normalize a handle. */
export function preparedSkillReferences({ shortRefs, catalogs, entries, formatReference = nativeFileRef }) {
  const candidates = catalogCandidateReferences({ shortRefs, catalogs, formatReference });
  const references = [...candidates], selected = new Map();
  const catalogRecords = catalogs.catalogs.flatMap(catalog => catalog.facets
    .filter(facet => facet.facet === 'catalog' && facet.ok === true)
    .flatMap(facet => facet.value.records.map(record => ({ scope: facet.value.scope, record }))));
  for (const [ref, target] of shortRefs.bindings) {
    if (target.kind !== 'selected') continue;
    assert.match(ref, /^sr:S[A-Za-z0-9_-]{22}$/, 'BENCHMARK_SELECTED_REFERENCE_KIND');
    const matches = entries.filter(entry => entry.evidence === 'consume.entries'
      && entry.value.scope === target.identity.scope && entry.value.record.id === target.identity.id
      && entry.value.record.kind === target.identity.kind && target.identity.source === 'notion'
      && JSON.stringify(normalizeCandidate(entry.value.record.locator, {})) === JSON.stringify(normalizeCandidate(target.identity.locator, {}))
      && entry.value.snapshot_id === target.snapshot_id && entry.value.version_id === target.version_id
      && entry.value.sha256 === target.body_sha256 && entry.value.path === target.entrypoint && entry.value.ref === target.ref);
    assert.ok(matches.length > 0, 'BENCHMARK_SELECTED_REFERENCE_UNOBSERVED');
    const entry = matches.at(-1);
    assert.ok(matches.every(value => JSON.stringify(normalizeCandidate(value.manifest, {})) === JSON.stringify(normalizeCandidate(entry.manifest, {}))), 'BENCHMARK_SELECTED_REFERENCE_CONFLICT');
    assert.equal(sha256(entry.value.content), target.body_sha256, 'BENCHMARK_SELECTED_BODY_MISMATCH');
    assert.equal(entry.value.has_more, false, 'BENCHMARK_SELECTED_BODY_INCOMPLETE');
    assert.equal(catalogRecords.filter(({ scope, record }) => scope === target.identity.scope
      && record.id === target.identity.id && record.kind === target.identity.kind && record.enabled === true
      && JSON.stringify(normalizeCandidate(record.locator, {})) === JSON.stringify(normalizeCandidate(target.identity.locator, {}))
      && record.ref === formatReference(target.identity.ref, target.entrypoint)).length, 1, 'BENCHMARK_SELECTED_CATALOG_MISMATCH');
    const binding = { selection: structuredClone(target), manifest: structuredClone(entry.manifest) };
    const proven = { ref, ...binding, canonical: 'benchmark-selected:' + sha256(JSON.stringify(normalizeCandidate(binding, {}))) };
    selected.set(ref, proven); references.push(proven);
  }
  for (const [ref, target] of shortRefs.bindings) {
    if (target.kind !== 'resource') continue;
    assert.match(ref, /^sr:R[A-Za-z0-9_-]{22}$/, 'BENCHMARK_RESOURCE_REFERENCE_KIND');
    const owner = selected.get(target.owner);
    assert.ok(owner, 'BENCHMARK_RESOURCE_OWNER_UNOBSERVED');
    const matches = owner.manifest.files.filter(file => file.path === target.path
      && file.sha256 === target.sha256 && file.bytes === target.bytes);
    assert.equal(matches.length, 1, 'BENCHMARK_RESOURCE_REFERENCE_UNOBSERVED');
    // SDK manifests bind file bytes; exact fixed refs are supplied by the paired
    // reference codec, not an optional or invented manifest-file ref field.
    assert.equal(target.ref, formatReference(owner.selection.identity.ref, target.path, owner.selection.snapshot_id),
      'BENCHMARK_RESOURCE_FIXED_REFERENCE_MISMATCH');
    const fileBinding = owner.manifest.file_bindings?.find(file => file.path === target.path);
    assert.equal(fileBinding?.file_id, target.file_id, 'BENCHMARK_RESOURCE_FILE_ID_MISMATCH');
    const { owner: _sessionOwner, ...file } = target;
    const binding = { owner: owner.canonical, file: structuredClone(file) };
    references.push({ ref, ...binding, session_owner: target.owner,
      canonical: 'benchmark-resource:' + sha256(JSON.stringify(normalizeCandidate(binding, {}))) });
  }
  return references;
}

const decodeRecordText = value => value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

function catalogLocations(content, references) {
  const bindings = new Map(references.map(reference => [reference.ref, reference]));
  assert.equal(bindings.size, references.length, 'BENCHMARK_CATALOG_REFERENCE_DUPLICATE');
  const canonicalize = text => {
    let result = text.replace(/<ntn-skills-view-catalog\b[^>]*>[\s\S]*?<\/ntn-skills-view-catalog>/g, catalog =>
      catalog.replace(/(<card\b[^>]*\blocation=")([^"]+)(")/g, (match, before, ref, after) => {
        if (!ref.startsWith('sr:')) return match;
        const binding = bindings.get(ref);
        assert.ok(binding && ref.startsWith('sr:C'), 'BENCHMARK_CATALOG_REFERENCE_UNOBSERVED');
        return before + binding.canonical + after;
      }));
    result = result.replace(/<context-broker-record\b[^>]*>[\s\S]*?<\/context-broker-record>/g, record => {
      const opening = record.match(/^<context-broker-record\b[^>]*\bref="(sr:S[A-Za-z0-9_-]{22})"[^>]*>/);
      if (!opening) return record;
      const ref = opening[1], binding = bindings.get(ref);
      assert.ok(binding?.selection, 'BENCHMARK_SELECTED_REFERENCE_UNOBSERVED');
      const body = record.match(/<body>\n([\s\S]*)\n<\/body>/);
      assert.ok(body, 'BENCHMARK_SELECTED_BODY_MISSING');
      assert.equal(sha256(decodeRecordText(body[1])), binding.selection.body_sha256, 'BENCHMARK_SELECTED_DELIVERY_MISMATCH');
      let projected = record.replace('ref="' + ref + '"', 'ref="' + binding.canonical + '"');
      projected = projected.replace(/<resources>([\s\S]*?)<\/resources>/g, (match, encoded) => {
        const files = JSON.parse(decodeRecordText(encoded)); assert.ok(Array.isArray(files), 'BENCHMARK_RESOURCE_LIST_INVALID');
        let normalized = encoded;
        for (const file of files) {
          if (typeof file.ref !== 'string' || !file.ref.startsWith('sr:')) continue;
          const resource = bindings.get(file.ref);
          assert.ok(resource?.file && resource.session_owner === ref && resource.file.path === file.path, 'BENCHMARK_RESOURCE_OWNER_MISMATCH');
          const literal = '"ref":"' + file.ref + '"';
          assert.equal(normalized.split(literal).length, 2, 'BENCHMARK_RESOURCE_LOCATION_AMBIGUOUS');
          normalized = normalized.replace(literal, '"ref":"' + resource.canonical + '"');
        }
        return '<resources>' + normalized + '</resources>';
      });
      return projected;
    });
    assert.ok(!/sr:[CSR][A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])/.test(result), 'BENCHMARK_CATALOG_REFERENCE_OUTSIDE_LOCATION');
    return result;
  };
  if (typeof content === 'string') return canonicalize(content);
  if (Array.isArray(content)) return content.map(item => ['text', 'input_text'].includes(item.type) && typeof item.text === 'string'
    ? { ...item, text: canonicalize(item.text) } : item);
  return content;
}

/** Initial context contains the same branch-local catalog handles as the final
 * request. Canonicalize only proven card locations in the comparison copy. */
export function initialContextProjection(messages, catalogReferences = []) {
  return stripMessageTime(messages).map(message => Object.hasOwn(message, 'content')
    ? { ...message, content: catalogLocations(message.content, catalogReferences) } : message);
}

export function requestContract(payload, api, prompt, prefixes, catalogReferences = []) {
  assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload), 'BENCHMARK_PROVIDER_PAYLOAD_INVALID');
  const copy = structuredClone(payload), key = api === 'openai-responses' ? 'input' : 'messages';
  const text = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(item => ['text', 'input_text'].includes(item.type)).map(item => item.text).join('') : null;
  assert.ok(Array.isArray(copy[key]), 'BENCHMARK_PROVIDER_MESSAGES_MISSING');
  let removed = 0;
  copy[key] = copy[key].filter(message => {
    if (message.role === 'user' && text(message.content) === prompt) { removed++; return false; }
    return true;
  });
  assert.equal(removed, 1, 'BENCHMARK_PUBLIC_PROMPT_NOT_UNIQUELY_LOCATED');
  // Only the comparison copy changes; the retained and transmitted payload keep
  // the product's actual handles. Other metadata, text and field order remain.
  copy[key] = copy[key].map(message => Object.hasOwn(message, 'content')
    ? { ...message, content: catalogLocations(message.content, catalogReferences) } : message);
  // Cache identity is session-specific. Its presence/type is retained; its random
  // value is not a candidate difference. All prompt, tool and sampling fields stay.
  if (copy.prompt_cache_key !== undefined) copy.prompt_cache_key = { present: true, type: typeof copy.prompt_cache_key };
  return normalizeCandidate(copy, prefixes);
}

/** Retain a machine-readable comparison and bind its pre-redaction canonical bytes. */
export function requestContractEvidence(payload, api, prompt, prefixes, catalogReferences, recorder) {
  const canonical = requestContract(payload, api, prompt, prefixes, catalogReferences);
  return { request_contract: recorder.scrub(canonical), request_contract_sha256: sha256(JSON.stringify(canonical)) };
}

export function requestContractDifferences(expected, actual) {
  assert.match(expected.request_contract_sha256 ?? '', /^[a-f0-9]{64}$/, 'BENCHMARK_REQUEST_CONTRACT_DIGEST_REQUIRED');
  assert.match(actual.request_contract_sha256 ?? '', /^[a-f0-9]{64}$/, 'BENCHMARK_REQUEST_CONTRACT_DIGEST_REQUIRED');
  return [...candidateDifferences(expected.request_contract, actual.request_contract),
    ...candidateDifferences(expected.request_contract_sha256, actual.request_contract_sha256, '/request_contract_sha256')];
}

export function brokerDiagnosticsProjection(notifications) {
  return notifications.map(notification => {
    if (!notification.message.startsWith('context-broker roots:')) return notification;
    const [summary, ...lines] = notification.message.split('\n');
    return { type: notification.type, summary, roots: lines.map(line => {
      const match = line.match(/^(ok|missing)\s+(\d+)\s+(.{20})\s+(.+)$/);
      return match ? { status: match[1], skill_count: Number(match[2]), label: match[3].trim(), path_source: 'exact broker_config plus local_skill_roots inventory; human formatter abbreviates paths' } : { diagnostic: line };
    }) };
  });
}

/** Keep profile credential echoes out of the report without rewriting SDK originals. */
export async function writeEpisodeResult(result, recorder, { redact = false } = {}) {
  const retained = redact ? recorder.scrub(result) : result;
  await writeFile(retained.paths.result, JSON.stringify(retained, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return retained;
}

export function validateEpisodeConfig(config) {
  assert.equal(config?.version ?? 1, 1);
  for (const name of ['runRoot', 'buildRoot', 'workspace', 'agentDir', 'controlDir']) assert.ok(isAbsolute(config[name]), 'BENCHMARK_ABSOLUTE_PATH_REQUIRED: ' + name);
  for (const name of ['workspace', 'agentDir', 'controlDir']) assert.ok(inside(config.runRoot, config[name]) && config[name] !== config.runRoot, 'BENCHMARK_RUN_PATH_ESCAPE: ' + name);
  assert.ok(!inside(config.workspace, config.controlDir), 'BENCHMARK_CONTROL_IN_WORKSPACE');
  assert.ok(['native', 'broker'].includes(config.mode), 'BENCHMARK_MODE_INVALID');
  assert.ok(['openai-completions', 'openai-responses'].includes(config.model?.api), 'BENCHMARK_UNVERIFIED_PROVIDER_API');
  if (config.model.routing !== undefined) validateRoutingPolicy(config.model.routing);
  for (const name of ['provider', 'id', 'baseUrl']) assert.ok(typeof config.model[name] === 'string' && config.model[name], 'BENCHMARK_MODEL_FIELD_REQUIRED: ' + name);
  const url = new URL(config.model.baseUrl);
  assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'BENCHMARK_PROVIDER_URL_INVALID');
  assert.ok(Array.isArray(config.turns) && config.turns.length > 0, 'BENCHMARK_TURNS_REQUIRED');
  for (const turn of config.turns) assert.ok(typeof turn.id === 'string' && turn.id && typeof turn.prompt === 'string' && turn.prompt.trim(), 'BENCHMARK_TURN_INVALID');
  assert.equal(new Set(config.turns.map(turn => turn.id)).size, config.turns.length, 'BENCHMARK_DUPLICATE_TURN');
  assert.ok(config.correlation?.run_id && config.correlation?.episode_id, 'BENCHMARK_CORRELATION_REQUIRED');
  assert.ok(['free', 'off', 'required'].includes(config.codeMode?.policy ?? (config.codeMode?.enabled ? 'free' : 'off')), 'BENCHMARK_CODEMODE_POLICY_INVALID');
  assert.equal(config.codeMode?.models ?? false, false, 'BENCHMARK_AUXILIARY_MODELS_FORBIDDEN');
  if (config.resourceProfile !== undefined) { validateResourceProfileRef(config.resourceProfile); assert.equal(config.mode, 'broker'); assert.equal(config.codeMode.toolSearchEnabled, false, 'BENCHMARK_PROFILE_TOOL_SEARCH_POLICY'); }
  assert.ok(isAbsolute(config.visibility), 'BENCHMARK_VISIBILITY_RECEIPT_REQUIRED');
  assert.ok(config.admission?.captureOnly || isAbsolute(config.admission?.expectedFile), 'BENCHMARK_EXPECTATION_REQUIRED');
  const parameters = config.model.parameters ?? {};
  for (const key of Object.keys(parameters)) assert.ok(['thinkingLevel', 'maxTokens', 'temperature'].includes(key), 'BENCHMARK_UNSUPPORTED_MODEL_PARAMETER: ' + key);
  assert.ok(Number.isSafeInteger(parameters.maxTokens) && parameters.maxTokens >= 16 && (config.limits.mode === 'unbounded' || parameters.maxTokens <= config.limits.maxOutputTokens), 'BENCHMARK_OUTPUT_PARAMETER_REQUIRED');
  assert.ok(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(parameters.thinkingLevel), 'BENCHMARK_THINKING_LEVEL_REQUIRED');
  return config;
}

async function verifyVisibility(config) {
  await assertRunSourceAbsent(config.runRoot);
  assertSourceEnvironmentAbsent();
  const receipt = await readJson(config.visibility);
  assert.equal(receipt.version, 1); const source = sourceVisibility(receipt);
  assert.equal(receipt.projection_root, 'subject-runtime');
  const root = join(config.runRoot, receipt.projection_root);
  assert.ok(inside(root, fileURLToPath(import.meta.url)), 'BENCHMARK_RUNTIME_NOT_PROJECTED');
  const actual = await inventory(root);
  assert.deepEqual(actual.files, receipt.files, 'BENCHMARK_VISIBLE_SOURCE_INVENTORY_MISMATCH');
  for (const file of actual.files) assert.ok(!/(?:^|\/)(?:corpus|grader|oracle)(?:\/|[-_.])|\.test\./i.test(file.path), 'BENCHMARK_PRIVATE_MATERIAL_IN_PROJECTION');
  return { receipt: await fileIdentity(config.visibility), projection: actual, source };
}

/** Resolve only the maintained MCP package's two reviewed import exports.
 * Package discovery is SDK-relative; no require-condition or filesystem-layout fallback. */
export async function sdkMcpImportEntry(sdkModule, specifier) {
  const subpath = new Map([['@earendil-works/pi-mcp', '.'], ['@earendil-works/pi-mcp/oauth', './oauth']]).get(specifier);
  assert.ok(subpath, 'BENCHMARK_PI_MCP_IMPORT_UNREVIEWED');
  const { findPackageJSON } = await import('node:module');
  assert.equal(typeof findPackageJSON, 'function', 'BENCHMARK_PI_MCP_PACKAGE_DISCOVERY_UNAVAILABLE');
  const packageFile = findPackageJSON('@earendil-works/pi-mcp', pathToFileURL(sdkModule));
  assert.ok(packageFile, 'BENCHMARK_PI_MCP_PACKAGE_NOT_FOUND');
  const manifest = await readJson(packageFile), selected = manifest.exports?.[subpath];
  assert.equal(manifest.name, '@earendil-works/pi-mcp', 'BENCHMARK_PI_MCP_PACKAGE_IDENTITY');
  assert.equal(manifest.type, 'module', 'BENCHMARK_PI_MCP_MODULE_TYPE');
  assert.ok(selected && typeof selected === 'object' && !Array.isArray(selected) &&
    Object.entries(selected).every(([key, value]) => ['source', 'types', 'import'].includes(key) && typeof value === 'string') &&
    typeof selected.import === 'string' && selected.import.startsWith('./'), 'BENCHMARK_PI_MCP_IMPORT_EXPORT_REQUIRED');
  assert.ok(selected.import.slice(2).split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && !['.', '..', 'node_modules'].includes(part.toLowerCase())), 'BENCHMARK_PI_MCP_IMPORT_TARGET');
  const target = new URL(selected.import, pathToFileURL(packageFile)), root = await realpath(dirname(packageFile));
  assert.ok(target.protocol === 'file:' && !target.search && !target.hash, 'BENCHMARK_PI_MCP_IMPORT_TARGET');
  const entry = await realpath(fileURLToPath(target));
  assert.ok(inside(root, entry) && entry !== root, 'BENCHMARK_PI_MCP_IMPORT_TARGET');
  return { package_file: packageFile, entry };
}

export async function sdkInstallation(piSelection, resourceProfile = false) {
  const cli = await realpath(selectionPath(piSelection));
  let directory = dirname(cli), manifest;
  for (let depth = 0; depth < 6; depth++, directory = dirname(directory)) {
    if (await exists(join(directory, 'package.json'))) {
      const candidate = await readJson(join(directory, 'package.json'));
      if (candidate.name === '@earendil-works/pi-coding-agent') { manifest = candidate; break; }
    }
  }
  assert.ok(manifest, 'BENCHMARK_MAINTAINED_PI_PACKAGE_NOT_FOUND');
  const module = join(directory, 'dist/index.js');
  const files = [cli, join(directory, 'package.json'), module, ...['core/sdk.js', 'core/agent-session.js', 'core/session-manager.js', 'core/settings-manager.js', 'core/resource-loader.js', 'core/extensions/loader.js', 'core/extensions/runner.js', 'core/system-prompt.js', 'extensions/codemode/index.js', 'extensions/codemode/tool.js', 'extensions/codemode/execute.js', 'extensions/tool-search/index.js'].map(name => join(directory, 'dist', name)),
    ...['agent.js', 'agent-loop.js'].map(name => join(directory, 'node_modules/@earendil-works/pi-agent-core/dist', name)),
    ...['api/openai-completions.js', 'api/openai-responses.js', 'api/openai-responses-shared.js'].map(name => join(directory, 'node_modules/@earendil-works/pi-ai/dist', name))];
  if (resourceProfile) {
    files.push(...['core/mcp-servers.js', 'core/auth-storage.js', 'core/resolve-config-value.js',
      'extensions/mcp/index.js', 'extensions/mcp/config.js', 'extensions/mcp/runtime.js', 'extensions/mcp/runtime.lazy.js',
      'extensions/mcp/oauth.js', 'extensions/mcp/resources.js', 'extensions/mcp/log.js'].map(name => join(directory, 'dist', name)));
    for (const name of ['@earendil-works/pi-mcp', '@earendil-works/pi-mcp/oauth']) {
      const imported = await sdkMcpImportEntry(module, name); files.push(imported.package_file, imported.entry);
    }
  }
  const identities = await Promise.all([...new Set(files)].map(file => fileIdentity(file)));
  return { root: directory, module, entry: identities.find(file => file.path === module), version: manifest.version, files: identities };
}

/** Bind known SDK factories before evidence redaction makes their display names opaque. */
export async function captureExtensionEntry(resolvedPath, installation) {
  if (resolvedPath.startsWith('<')) return null;
  if (!resolvedPath.startsWith('builtin:')) return fileIdentity(resolvedPath);
  const implementation = new Map([
    ['builtin:codemode', 'extensions/codemode/index.js'],
    ['builtin:tool_search', 'extensions/tool-search/index.js'],
    ['builtin:mcp', 'extensions/mcp/index.js'],
  ]).get(resolvedPath);
  assert.ok(implementation, 'BENCHMARK_BUILTIN_IMPLEMENTATION_UNREVIEWED');
  const matches = installation.files.filter(file => file.path === join(installation.root, 'dist', implementation));
  assert.equal(matches.length, 1, 'BENCHMARK_BUILTIN_IMPLEMENTATION_UNOBSERVED');
  return matches[0];
}

async function catalogReferenceReader({ config, profile, installation }) {
  if (config.mode !== 'broker') return null;
  const brokers = profile.extensions.filter(extension => extension.role === 'broker');
  assert.equal(brokers.length, 1, 'BENCHMARK_CATALOG_REFERENCE_BROKER_REQUIRED');
  const entry = join(dirname(brokers[0].path), 'session-short-ref.ts');
  assert.ok(inside(config.buildRoot, await realpath(entry)), 'BENCHMARK_CATALOG_REFERENCE_REDUCER_NOT_PAIRED');
  const require = createRequire(installation.module), { createJiti } = require('jiti');
  assert.equal(typeof createJiti, 'function', 'BENCHMARK_CATALOG_REFERENCE_LOADER_REQUIRED');
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
  const { reduceSessionShortRefs } = await jiti.import(entry);
  assert.equal(typeof reduceSessionShortRefs, 'function', 'BENCHMARK_CATALOG_REFERENCE_REDUCER_REQUIRED');
  return { reduce: reduceSessionShortRefs, identity: { reducer: await fileIdentity(entry), loader: await fileIdentity(require.resolve('jiti')) } };
}

function assertModel(config, model, thinkingLevel) {
  for (const name of ['provider', 'id', 'api', 'baseUrl']) assert.equal(model?.[name], config.model[name], 'BENCHMARK_MODEL_DRIFT: ' + name);
  if (thinkingLevel !== undefined) assert.equal(thinkingLevel, config.model.parameters.thinkingLevel, 'BENCHMARK_THINKING_LEVEL_DRIFT');
}

export function assertProfileToolRegistry(expected, current, active) {
  const differences = candidateDifferences(expected, current);
  if (differences.length) throw new EpisodeStop('BENCHMARK_RESOURCE_TOOL_REGISTRY_DRIFT', { differences: differences.map(item => item.path) });
  if (active.includes('tool_search')) throw new EpisodeStop('BENCHMARK_RESOURCE_TOOL_SEARCH_DRIFT');
}

/** Place the existing guard before third-party tool_call hooks. Other extension order stays exact. */
export function observerFirst(loaded) {
  const observers = loaded.extensions.filter(extension => extension.path === '<inline:benchmark-observer>');
  assert.equal(observers.length, 1, 'BENCHMARK_PROFILE_OBSERVER_REQUIRED');
  return { ...loaded, extensions: [observers[0], ...loaded.extensions.filter(extension => extension !== observers[0])] };
}

/** The public RPC status command waits for all configured MCP startup connections.
 * This is a prepare-only registry read, never a model tool call or Skill adoption. */
export async function awaitProfileMcpAdmission({ session, resources, signal, codeEnabled, record = () => {} }) {
  signal?.throwIfAborted();
  record('admission_mcp_registry_start', { scope: 'prepare-only; no model or remote tool invocation' });
  await session.prompt('/mcp'); signal?.throwIfAborted();
  const names = session.getAllTools().map(tool => tool.name), actual = names.filter(name => name.startsWith('mcp__')).sort();
  assert.deepEqual(actual, [...resources.manifest.mcp_tools].sort(), 'BENCHMARK_MCP_REGISTRY_DRIFT');
  const policy = resources.manifest.tool_policy, declared = new Set([...policy.allowed_tools, ...policy.blocked_tools]);
  assert.deepEqual([...names].sort(), [...declared].sort(), 'BENCHMARK_PROFILE_TOOL_REGISTRY_DRIFT');
  // Deferred MCP discovery may activate tool_search. Apply the explicitly shared
  // loadout after startup, while preserving every other ordinary active tool.
  const before = session.getActiveToolNames();
  const active = before.filter(name => name !== 'tool_search' && (codeEnabled || name !== 'codemode'));
  if (codeEnabled && !active.includes('codemode')) active.push('codemode');
  session.setActiveToolsByName(active);
  assert.equal(session.getActiveToolNames().includes('tool_search'), false, 'BENCHMARK_PROFILE_TOOL_SEARCH_DRIFT');
  assert.equal(session.getActiveToolNames().includes('codemode'), codeEnabled, 'BENCHMARK_PROFILE_CODEMODE_DRIFT');
  record('admission_mcp_registry_end', { tools: actual, active_before_shared_policy: before, active: session.getActiveToolNames(), scope: 'actual registry; no remote tool executed' });
}

export function assertProfileResources({ resources, profile, extensions, skills, contextFiles }) {
  if (!resources) return;
  const expected = resources.manifest;
  const paths = extensions.filter(extension => !extension.path.startsWith('builtin:') && extension.path !== '<inline:benchmark-observer>').map(extension => extension.path);
  assert.deepEqual(paths, profile.extensions.map(extension => extension.path), 'BENCHMARK_PROFILE_EXTENSION_ORDER_DRIFT');
  assert.equal(skills.length, expected.native_skills.length, 'BENCHMARK_PROFILE_NATIVE_COUNT_DRIFT');
  for (const item of expected.native_skills) {
    const found = skills.filter(skill => skill.file.realpath === item.path);
    assert.equal(found.length, 1, 'BENCHMARK_PROFILE_NATIVE_ENTRY_DRIFT');
    assert.equal(found[0].file.sha256, item.sha256, 'BENCHMARK_PROFILE_NATIVE_BYTES_DRIFT');
    assert.equal(!found[0].disableModelInvocation, item.visible, 'BENCHMARK_PROFILE_NATIVE_VISIBILITY_DRIFT');
  }
  assert.deepEqual(contextFiles, { agentsFiles: resources.contextFiles }, 'BENCHMARK_PROFILE_CONTEXT_DRIFT');
}

async function captureCandidate({ config, profile, session, installation, visibility, notifications, prefixes, scrub, project, notion, referenceReader, signal, resources }) {
  const loaded = session.resourceLoader.getExtensions();
  assert.equal(loaded.errors.length, 0, 'BENCHMARK_EXTENSION_LOAD_ERROR');
  const extensions = await Promise.all(loaded.extensions.map(async extension => ({
    path: extension.path, resolved_path: extension.resolvedPath, source: extension.sourceInfo, hidden: extension.hidden ?? false,
    handlers: [...extension.handlers.entries()].map(([event, handlers]) => ({ event, count: handlers.length })).sort((a, b) => a.event.localeCompare(b.event)),
    tools: [...extension.tools.keys()].sort(), commands: [...extension.commands.keys()].sort(), flags: [...extension.flags.keys()].sort(),
    entry: await captureExtensionEntry(extension.resolvedPath, installation),
  })));
  const native = session.resourceLoader.getSkills();
  const skills = await Promise.all(native.skills.map(async skill => ({ ...skill, file: await fileIdentity(skill.filePath) })));
  const roots = await Promise.all(profile.native_skill_roots.map(async root => ({ root, ...await inventory(root) })));
  assertProfileResources({ resources, profile, extensions, skills, contextFiles: session.resourceLoader.getAgentsFiles() });
  const brokerConfig = process.env.CONTEXT_BROKER_CONFIG;
  assert.ok(brokerConfig && inside(config.runRoot, brokerConfig), 'BENCHMARK_BROKER_CONFIG_NOT_RUN_OWNED');
  const brokerConfiguration = await readJson(brokerConfig);
  assert.ok(await notion.waitIdle(null, { signal }), 'BENCHMARK_NOTION_STARTUP_PENDING');
  const notionCatalogs = notion.candidate(brokerConfiguration.sources ?? []);
  const initial = [{ role: 'system', content: session.systemPrompt, toolsAdded: session.agent.state.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })), timestamp: 0 }];
  const projected = session.agent.transformContext ? await session.agent.transformContext(initial) : initial;
  const branch = session.sessionManager.getBranch();
  const catalogReferences = catalogCandidateReferences({ shortRefs: referenceReader ? referenceReader.reduce(branch) : { bindings: new Map() },
    catalogs: notionCatalogs.projection });
  const localSkillRoots = await Promise.all([...new Set([...(brokerConfiguration.skillRoots ?? []), ...(brokerConfiguration.extraSkillRoots ?? [])])].map(async root => {
    assert.ok(inside(config.runRoot, root), 'BENCHMARK_LOCAL_SKILL_ROOT_NOT_RUN_OWNED');
    return { root, ...await inventory(root) };
  }));
  const cliEntry = process.env.PAIRED_CLI_ENTRY;
  assert.ok(cliEntry && inside(config.buildRoot, cliEntry), 'BENCHMARK_CLI_NOT_PAIRED');
  const selectedGit = await observeSharedGit(config.runRoot);
  const snapshot = {
    version: 1, entry_kind: 'pi-sdk', pi: { version: installation.version, entry: installation.entry, files: installation.files, identity_scope: 'explicit-sdk-and-adapter-modules-not-entire-installation' },
    node: await fileIdentity(process.execPath), node_version: process.versions.node,
    bun: await fileIdentity(await realpath(selectionPath(config.runtime.bun))),
    ...(selectedGit ? { git: selectedGit } : {}),
    build: await fileIdentity(join(config.buildRoot, 'build.json')), cli: await fileIdentity(cliEntry),
    mode: config.mode, launch_profile: profile, ...(resources ? { resource_profile: { ...resources.evidence, shared_differences: resources.manifest.shared_differences, excluded_extensions: resources.manifest.excluded_extensions, tool_policy: resources.manifest.tool_policy } } : {}), model: selectedModel(session.model), thinking_level: session.thinkingLevel,
    catalog_reference_reader: referenceReader?.identity ?? null,
    model_parameters: config.model.parameters, ...(config.model.routing ? { model_routing: config.model.routing } : {}), model_configuration: { file: await fileIdentity(join(config.agentDir, 'models.json')), definition: await readJson(join(config.agentDir, 'models.json')) },
    settings: session.settingsManager.getSettings(), code_mode: config.codeMode,
    factories: { codemode: 'public createCodemodeExtension, models:false', tool_search: 'public createToolSearchExtension', mcp: resources ? 'public createMcpExtension with frozen private config; shared ToolSearch false after startup' : 'disabled by the shared --no-mcp profile' },
    extensions, extension_warnings: loaded.warnings ?? [],
    native_skills: skills, native_diagnostics: native.diagnostics, native_roots: roots,
    tools: { all: session.getAllTools(), active: session.getActiveToolNames(), callable: session.getCallableToolNames() },
    commands: session.extensionRunner.getRegisteredCommands().map(command => ({ name: command.name, invocation_name: command.invocationName, description: command.description, source: command.sourceInfo })),
    prompts: session.resourceLoader.getPrompts(), context_files: session.resourceLoader.getAgentsFiles(),
    system_prompt: session.systemPrompt, initial_context: stripMessageTime(projected),
    initial_context_scope: 'public-initial-system-and-active-tools-through-the-real-context-transform; final-serializer-contract-is-separate',
    broker_config: brokerConfiguration, local_skill_roots: localSkillRoots, broker_diagnostics: notifications,
    notion_catalogs: notionCatalogs.projection, notion_catalog_evidence: notionCatalogs.evidence, notion_catalog_scope: notionCatalogs.scope,
    visibility: { projection: visibility.projection, ...visibility.source },
  };
  const publicSnapshot = scrub(snapshot);
  const { notion_catalog_evidence, ...stableSnapshot } = snapshot;
  return { snapshot: publicSnapshot,
    initial_context_catalog_evidence: scrub({ version: 1,
      scope: 'current product branch bindings matched to independently observed catalog; initial-context comparison-only canonical locations',
      session_id: session.sessionId, leaf_id: session.sessionManager.getLeafId(), branch,
      reducer: referenceReader?.identity ?? null, bindings: catalogReferences }),
    projection: project({ ...stableSnapshot, initial_context: initialContextProjection(projected, catalogReferences),
      broker_diagnostics: brokerDiagnosticsProjection(snapshot.broker_diagnostics) }, prefixes) };
}

/** One SDK session owns every natural turn. Shared paired-environment owns the process group. */
export function createEpisodeUIContext({ session, resources, notifications, recorder }) {
  return {
    ...(resources ? session.extensionRunner.getUIContext() : {}),
    notify(message, type) { const item = { message, type: type ?? 'info' }; notifications.push(item); recorder.record('extension_notification', item); },
    setStatus() {}, setWidget() {}, setTitle() {}, setWorkingMessage() {}, setEditorText() {},
    select() { throw new EpisodeStop('BENCHMARK_INTERACTIVE_UI_REQUEST'); }, confirm() { throw new EpisodeStop('BENCHMARK_INTERACTIVE_UI_REQUEST'); }, input() { throw new EpisodeStop('BENCHMARK_INTERACTIVE_UI_REQUEST'); },
  };
}

export async function runEpisode(input, hooks = {}) {
  const config = validateEpisodeConfig(input), budget = createEpisodeBudget(config.limits);
  const started = performance.now(), startedNs = process.hrtime.bigint().toString();
  const recorder = await createEpisodeRecorder(config.controlDir, config.correlation, [config.model.apiKeyEnv && process.env[config.model.apiKeyEnv], process.env.NOTION_API_TOKEN]);
  const prefixes = { RUN: config.runRoot, BUILD: config.buildRoot };
  const requests = [], turns = [], interventions = [], notifications = [], extensionErrors = [];
  let session, installation, resources, referenceReader, transport, notion, notionResult, timer, onSigTerm, onSigInt, terminalError, captureContract, currentRequest, currentTurn, admitted = false, expected, capture, unsubscribe, originalStream;
  let stage = 'prepare';
  const activeTools = new Set();
  const enterStage = next => { stage = next; recorder.bind({ stage }); recorder.record('runtime_stage', { stage }); };
  let status = 'invalid', settled = false, cancelled = false, preflightModelAttempt = false, cleanup = { abort_settled: false, shutdown_emitted: false, dispose_called: false };
  const admission = { status: 'pending', refs: [] }, coverage = { attempts: 'unavailable', tools: 'unavailable', interventions: 'unavailable' };
  const transportPath = join(config.controlDir, 'transport.jsonl');
  const runtimeController = new AbortController();
  let rejectStop;
  const stopping = new Promise((_, reject) => { rejectStop = reject; });
  stopping.catch(() => {});
  const stop = (code, details = {}) => {
    terminalError ??= new EpisodeStop(code, details);
    interventions.push({ kind: code, ref: recorder.record('runtime_intervention', { code, details }) });
    runtimeController.abort(terminalError);
    rejectStop(terminalError); if (session) void session.abort().catch(() => {});
  };
  const checkProfileRegistry = () => {
    if (resources && capture) assertProfileToolRegistry(capture.projection.tools.all,
      recorder.project(session.getAllTools(), prefixes), session.getActiveToolNames());
  };
  recorder.record('runtime_start', { entry_kind: 'pi-sdk', pid: process.pid, ppid: process.ppid, cwd: process.cwd(), runtime_module: fileURLToPath(import.meta.url), started_monotonic_ns: startedNs, no_automatic_model_retry: true });
  try {
    if (config.limits.mode !== 'unbounded') timer = setTimeout(() => stop('BENCHMARK_WALL_LIMIT'), config.limits.wallTimeMs);
    onSigTerm = () => { cancelled = true; stop('BENCHMARK_SIGNAL', { signal: 'SIGTERM' }); };
    onSigInt = () => { cancelled = true; stop('BENCHMARK_SIGNAL', { signal: 'SIGINT' }); };
    process.on('SIGTERM', onSigTerm); process.on('SIGINT', onSigInt);
    assert.equal(await realpath(process.execPath), await realpath(selectionPath(config.runtime.node)), 'BENCHMARK_NODE_SELECTION_DRIFT');
    assert.equal(await realpath(process.cwd()), await realpath(config.workspace), 'BENCHMARK_WORKSPACE_DRIFT');
    const visibility = await verifyVisibility(config), profile = await readJson(join(config.runRoot, 'pi-launch.json'));
    enterStage('prepare');
    notion = observeEpisodeNotion({ config, recorder, context: () => ({ stage, turn_id: currentTurn?.id ?? null,
      model_request_id: currentRequest?.id ?? null, active_tool_call_ids: [...activeTools].sort() }) });
    assert.equal(profile.mode, config.mode, 'BENCHMARK_MODE_PROFILE_DRIFT');
    for (const flag of ['--offline', '-ne', '-ns', '-nc', '--no-mcp', '--no-prompt-templates', '--no-approve']) assert.ok(profile.argv.includes(flag), 'BENCHMARK_SHARED_PROFILE_FLAG_MISSING: ' + flag);
    if (profile.resource_profile !== undefined) validateResourceProfileRef(profile.resource_profile);
    assert.deepEqual(profile.resource_profile ?? null, config.resourceProfile ?? null, 'BENCHMARK_RESOURCE_PROFILE_SELECTION_DRIFT');
    if (config.resourceProfile !== undefined) {
      resources = await readResourceProfile(config.resourceProfile, { environmentRoot: dirname(dirname(config.runRoot)) });
      recorder.addCredentials(resources.credentials);
      assert.deepEqual(resources.evidence, profile.resource_profile_evidence, 'BENCHMARK_RESOURCE_PROFILE_LAUNCH_DRIFT');
      for (const item of resources.agentFiles) assert.equal(sha256(await readFile(join(config.agentDir, item.relative_path))), item.source.sha256, 'BENCHMARK_PRIVATE_AGENT_FILE_DRIFT');
      assert.equal(sha256(await readFile(join(config.agentDir, 'mcp.json'))), resources.manifest.mcp_config.sha256, 'BENCHMARK_MCP_PRIVATE_CONFIG_DRIFT');
    }
    installation = await sdkInstallation(config.runtime.pi, Boolean(resources));
    assert.equal(await realpath(profile.entry), await realpath(selectionPath(config.runtime.pi)), 'BENCHMARK_PI_SELECTION_DRIFT');
    const sdk = await import(pathToFileURL(installation.module).href);
    referenceReader = await catalogReferenceReader({ config, profile, installation });
    const settingsManager = sdk.SettingsManager.create(config.workspace, config.agentDir);
    const sessionOverrides = { compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }, cacheWarming: 'off', transport: 'sse', sessionDir: join(config.runRoot, 'sessions') };
    settingsManager.applyOverrides(sessionOverrides);
    const checkSessionPolicy = () => {
      const actual = session.settingsManager.getSettings();
      assert.deepEqual({ compaction: { enabled: actual.compaction?.enabled },
        retry: { enabled: actual.retry?.enabled, maxRetries: actual.retry?.maxRetries, provider: { maxRetries: actual.retry?.provider?.maxRetries } },
        cacheWarming: actual.cacheWarming, transport: actual.transport, sessionDir: actual.sessionDir },
      sessionOverrides, 'BENCHMARK_SESSION_POLICY_DRIFT');
    };
    const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(config.agentDir, 'auth.json'), modelsPath: join(config.agentDir, 'models.json'), modelsStorePath: join(config.agentDir, 'model-store.json'), allowModelNetwork: false, refreshOnCreate: false });
    const model = modelRuntime.getPhysicalModel(config.model.provider, config.model.id);
    assertModel(config, model);
    assert.ok(!config.model.apiKeyEnv || typeof process.env[config.model.apiKeyEnv] === 'string' && process.env[config.model.apiKeyEnv].length, 'BENCHMARK_CREDENTIAL_ENV_MISSING');
    const codePolicy = config.codeMode.policy ?? (config.codeMode.enabled ? 'free' : 'off');
    const codeEnabled = codePolicy !== 'off';
    const observerFactory = api => {
      transport = observeProviderTransport(api, { diagnostics, fs, crypto, path, output: transportPath, checkoutRoot: resolve(fileURLToPath(new URL('../..', import.meta.url))), clockId: config.correlation.episode_id });
      api.on('tool_call', createEpisodeToolGuard({ budget, codeEnabled, toolPolicy: resources?.manifest.tool_policy,
        record: recorder.record, stop, checkContract: checkProfileRegistry }));
      api.on('tool_result', event => { recorder.record('tool_result', event); });
    };
    let mcpFactory;
    if (resources) {
      const { loadMcpConfig } = await import(pathToFileURL(join(installation.root, 'dist/extensions/mcp/config.js')).href);
      const { McpOAuthCredentialStore } = await import(pathToFileURL(join(installation.root, 'dist/extensions/mcp/oauth.js')).href);
      const { FileAuthStorageBackend } = await import(pathToFileURL(join(installation.root, 'dist/core/auth-storage.js')).href);
      const mcpConfig = loadMcpConfig({ agentDir: config.agentDir, cwd: config.workspace, projectTrusted: false });
      assert.deepEqual(mcpConfig.errors, [], 'BENCHMARK_MCP_CONFIG_INVALID');
      mcpFactory = sdk.createMcpExtension({ loadConfig: () => mcpConfig,
        credentials: new McpOAuthCredentialStore(new FileAuthStorageBackend(join(config.agentDir, 'mcp-auth.json')), config.agentDir),
        logPath: join(config.agentDir, 'mcp.log'),
        updateConfig() { stop('BENCHMARK_OUT_OF_SCOPE_MCP_CONFIG_WRITE'); throw new EpisodeStop('BENCHMARK_OUT_OF_SCOPE_MCP_CONFIG_WRITE'); },
        openUrl() { stop('BENCHMARK_OUT_OF_SCOPE_MCP_AUTH'); throw new EpisodeStop('BENCHMARK_OUT_OF_SCOPE_MCP_AUTH'); } });
    }
    const loader = new sdk.DefaultResourceLoader({ cwd: config.workspace, agentDir: config.agentDir, settingsManager,
      noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: [...profile.extensions.map(extension => extension.path), 'builtin:codemode', 'builtin:tool_search', ...(resources ? ['builtin:mcp'] : [])], additionalSkillPaths: profile.native_skill_paths ?? profile.native_skill_roots,
      ...(resources ? { extensionsOverride: observerFirst, agentsFilesOverride: () => ({ agentsFiles: resources.contextFiles }) } : {}),
      extensionFactories: [
        { name: 'codemode', builtin: true, replaceable: true, factory: sdk.createCodemodeExtension(codemodeExtensionOptions(codePolicy)) },
        { name: 'tool_search', builtin: true, replaceable: true, factory: sdk.createToolSearchExtension() },
        ...(mcpFactory ? [{ name: 'mcp', builtin: true, replaceable: true, factory: mcpFactory }] : []),
        { name: 'benchmark-observer', factory: observerFactory },
      ],
    });
    await Promise.race([loader.reload(), stopping]);
    // Resource reload replaces in-memory settings. Restore the shared episode policy before session construction.
    settingsManager.applyOverrides(sessionOverrides);
    const created = await Promise.race([sdk.createAgentSession({ cwd: config.workspace, agentDir: config.agentDir, settingsManager, modelRuntime, model, thinkingLevel: config.model.parameters.thinkingLevel,
      resourceLoader: loader, sessionManager: sdk.SessionManager.create(config.workspace, join(config.runRoot, 'sessions')),
      tools: [codeEnabled ? '+codemode' : '-codemode', config.codeMode.toolSearchEnabled ? '+tool_search' : '-tool_search'] }), stopping]);
    session = created.session;
    checkSessionPolicy();
    originalStream = session.agent.streamFunction;
    session.agent.streamFunction = () => { preflightModelAttempt = true; throw new EpisodeStop('BENCHMARK_PREFLIGHT_MODEL_FORBIDDEN'); };
    assert.equal(created.modelFallbackMessage, undefined, 'BENCHMARK_MODEL_FALLBACK');
    assertModel(config, session.model, session.thinkingLevel);
    const ui = createEpisodeUIContext({ session, resources, notifications, recorder });
    unsubscribe = session.subscribe(event => {
      if (event.type === 'tool_execution_start') activeTools.add(event.toolCallId);
      const ref = recorder.record('session_event', event);
      if (event.type === 'tool_execution_end') activeTools.delete(event.toolCallId);
      if (event.type === 'agent_settled') { settled = true; if (currentTurn) currentTurn.settled_ref = ref; }
      if (event.type === 'message_end' && event.message.role === 'assistant' && currentRequest) {
        currentRequest.assistant = { stop_reason: event.message.stopReason, error: event.message.errorMessage ?? null, normalized_usage: event.message.usage ?? null, ref };
        finishEpisodeRequest({ request: currentRequest, budget, routing: config.model.routing, captureOnly: config.admission.captureOnly,
          record: recorder.record, onStop: error => { terminalError ??= error; } });
      }
    });
    await Promise.race([session.bindExtensions({ uiContext: ui, mode: 'rpc', onError: error => { extensionErrors.push(error); recorder.record('extension_error', error); }, shutdownHandler: () => stop('BENCHMARK_EXTENSION_SHUTDOWN') }), stopping]);
    if (config.mode === 'broker') {
      const brokerConfig = process.env.CONTEXT_BROKER_CONFIG;
      assert.ok(brokerConfig && inside(config.runRoot, brokerConfig), 'BENCHMARK_BROKER_CONFIG_NOT_RUN_OWNED');
      const brokerConfiguration = await readJson(brokerConfig);
      await Promise.race([awaitBrokerAdmission({ session, sources: brokerConfiguration.sources ?? [], signal: runtimeController.signal,
        record: recorder.record, save: recorder.save }), stopping]);
      assert.equal(preflightModelAttempt, false, 'BENCHMARK_DIAGNOSTIC_STARTED_MODEL');
    }
    if (resources) await Promise.race([awaitProfileMcpAdmission({ session, resources, signal: runtimeController.signal, codeEnabled, record: recorder.record }), stopping]);
    assert.equal(preflightModelAttempt, false, 'BENCHMARK_DIAGNOSTIC_STARTED_MODEL');
    assert.equal(extensionErrors.length, 0, 'BENCHMARK_EXTENSION_STARTUP_ERROR');
    checkSessionPolicy();
    capture = await captureCandidate({ config, profile, session, installation, visibility, notifications: [...notifications], prefixes, scrub: recorder.scrub, project: recorder.project, notion, referenceReader, signal: runtimeController.signal, resources });
    admission.refs.push(await recorder.save('candidate-observed', capture));
    admission.refs.push(await recorder.save('workspace-before-task', await inventory(config.workspace)));
    if (!config.admission.captureOnly) {
      enterStage('admission');
      expected = await readJson(config.admission.expectedFile);
      assert.equal(expected.version, 1); assert.equal(expected.kind, 'benchmark-pi-sdk-expectation');
      assert.match(expected.request_contract_sha256 ?? '', /^[a-f0-9]{64}$/, 'BENCHMARK_REQUEST_CONTRACT_DIGEST_REQUIRED');
      const differences = candidateDifferences(expected.projection, capture.projection);
      admission.refs.push(await recorder.save('admission-comparison', { differences, expected_file: await fileIdentity(config.admission.expectedFile) }));
      if (differences.length) throw new EpisodeStop('BENCHMARK_ADMISSION_MISMATCH', { differences: differences.map(item => item.path) });
      admitted = true; admission.status = 'accepted_before_task';
    }
    session.agent.streamFunction = async (requestModel, context, options = {}) => {
      checkSessionPolicy();
      assertModel(config, requestModel, session.thinkingLevel);
      finishEpisodeRequest({ request: currentRequest, budget, routing: config.model.routing, captureOnly: config.admission.captureOnly,
        record: recorder.record, onStop: error => { terminalError ??= error; } });
      const sequence = reserveEpisodeRequest({ budget, captureOnly: config.admission.captureOnly, priorStop: terminalError, checkContract: checkProfileRegistry,
        clearRequest: () => { currentRequest = undefined; recorder.bind({ request_id: null }); },
        onStop: error => {
          terminalError ??= error;
          recorder.record('model_request_blocked', { error: errorData(error), budget: budget.state });
        } });
      const request = { id: config.correlation.episode_id + '/request-' + sequence, sequence, turn_id: currentTurn?.id ?? null, attempts: [], usage: null, accounted: false };
      requests.push(request); currentRequest = request; recorder.bind({ request_id: request.id });
      request.context_ref = await recorder.save('request-' + sequence + '-context', context);
      request.start_ref = recorder.record('model_request_start', { request_id: request.id, model: selectedModel(requestModel), context_ref: request.context_ref, reasoning: options.reasoning ?? null, capture_only: config.admission.captureOnly === true });
      const effectiveOutputCap = config.admission.captureOnly ? config.model.parameters.maxTokens : budget.outputCap(config.model.parameters.maxTokens);
      recorder.record('request_effective_parameters', { request_id: request.id, requested: config.model.parameters, effective_max_tokens: effectiveOutputCap, remaining_output_tokens: budget.limits.mode === 'unbounded' ? null : budget.limits.maxOutputTokens - budget.state.output_tokens });
      const guarded = {
        ...options, maxTokens: effectiveOutputCap, ...(config.model.parameters.temperature !== undefined ? { temperature: config.model.parameters.temperature } : {}), maxRetries: 0, transport: 'sse',
        fetch: guardedFetch({ request, model: requestModel, budget, admitted: () => admitted && !config.admission.captureOnly, record: recorder.record }),
        onPayload: async payload => {
          try {
            const transformed = await options.onPayload?.(payload, requestModel), final = transformed === undefined ? payload : transformed;
            request.payload_sha256 = sha256(JSON.stringify(final));
            request.payload_ref = await recorder.save('request-' + sequence + '-payload', final);
            request.final_payload_ref = recorder.record('provider_payload_final', { request_id: request.id, payload_ref: request.payload_ref, serialized_sha256: request.payload_sha256 });
            const prompt = config.admission.captureOnly ? config.turns[0].prompt : currentTurn.prompt;
            if (sequence === 1) {
              assert.ok(await notion.waitIdle(null, { signal: runtimeController.signal }), 'BENCHMARK_NOTION_STARTUP_PENDING');
              const operativeSources = (await readJson(process.env.CONTEXT_BROKER_CONFIG)).sources ?? [];
              const actualCatalogs = notion.candidate(operativeSources);
              const catalogDifferences = candidateDifferences(capture.projection.notion_catalogs, recorder.project(actualCatalogs.projection, prefixes));
              request.catalog_contract_ref = await recorder.save('first-request-catalog-comparison', { actual: actualCatalogs, differences: catalogDifferences });
              if (catalogDifferences.length) throw new EpisodeStop('BENCHMARK_FINAL_CATALOG_CONTRACT_DRIFT', { differences: catalogDifferences.map(item => item.path) });
              const branch = session.sessionManager.getBranch();
              const catalogReferences = preparedSkillReferences({ shortRefs: referenceReader ? referenceReader.reduce(branch) : { bindings: new Map() },
                catalogs: actualCatalogs.projection, entries: notion.preparedEntries() });
              request.catalog_reference_ref = await recorder.save('first-request-catalog-references', { version: 1,
                scope: 'current product branch bindings matched to independently observed catalog and complete consume manifests; comparison-only canonical locations',
                session_id: session.sessionId, leaf_id: session.sessionManager.getLeafId(), branch,
                reducer: referenceReader?.identity ?? null, bindings: catalogReferences });
              const contract = requestContractEvidence(final, requestModel.api, prompt, prefixes, catalogReferences, recorder);
              if (config.admission.captureOnly) { request.input_preflight = budget.payload(requestModel.api, final); captureContract = contract; throw new EpisodeStop('BENCHMARK_ADMISSION_CAPTURE_COMPLETE'); }
              const differences = requestContractDifferences(expected, contract);
              request.contract_ref = await recorder.save('first-request-contract-comparison', { contract: contract.request_contract,
                request_contract_sha256: contract.request_contract_sha256, expected_request_contract_sha256: expected.request_contract_sha256, differences });
              if (differences.length) throw new EpisodeStop('BENCHMARK_FINAL_REQUEST_CONTRACT_DRIFT', { differences: differences.map(item => item.path) });
            }
            assert.equal(extensionErrors.length, 0, 'BENCHMARK_EXTENSION_RUNTIME_ERROR');
            assertModel(config, session.model, session.thinkingLevel);
            request.input_preflight = budget.payload(requestModel.api, final);
            recorder.record('provider_send_admitted', { request_id: request.id, input_preflight: request.input_preflight, budget: budget.state });
            return final;
          } catch (error) {
            if (error.code !== 'BENCHMARK_ADMISSION_CAPTURE_COMPLETE') terminalError ??= error;
            recorder.record('provider_send_blocked', { request_id: request.id, error: errorData(error) }); throw error;
          }
        },
        onResponse: async (response, responseModel) => { recorder.record('provider_response', { request_id: request.id, attempt_id: request.current_attempt_id ?? null, status: response.status }); await options.onResponse?.(response, responseModel); },
        onProviderStreamEvent: async (event, eventModel) => {
          const ref = recorder.record('provider_stream_event', { request_id: request.id, attempt_id: request.current_attempt_id ?? null, provider: eventModel.provider, api: eventModel.api, model: eventModel.id, event }, { request_id: request.id });
          if (config.model.routing) {
            const reported = providerReportedModel(eventModel.api, event), attempt = request.attempts.find(item => item.id === request.current_attempt_id);
            if (reported && attempt) (attempt.reported_model_observations ??= []).push({ ...reported,
              bound: eventModel.api === config.model.api && eventModel.provider === config.model.provider && eventModel.id === config.model.id, ref });
          }
          const usage = providerUsage(eventModel.api, event);
          if (usage) { request.usage = usage; request.usage_ref = { ...ref, pointer: '/data/event' + usage.pointer }; request.usage_attempt_id = request.current_attempt_id ?? null; }
          await options.onProviderStreamEvent?.(event, eventModel);
        },
      };
      return originalStream(requestModel, context, guarded);
    };
    // Capture the actual first prompt through normal product preloading. The
    // payload guard stops before transport; paid runs first match startup state.
    if (config.admission.captureOnly) {
      enterStage('admission');
      await Promise.race([session.prompt(config.turns[0].prompt), stopping]);
      assert.ok(captureContract, 'BENCHMARK_FINAL_CONTRACT_NOT_CAPTURED');
      assert.equal(budget.state.attempts, 0, 'BENCHMARK_CAPTURE_SENT_HTTP');
      assert.equal(budget.state.tools, 0, 'BENCHMARK_CAPTURE_EXECUTED_TOOL');
      assert.equal(extensionErrors.length, 0, 'BENCHMARK_CAPTURE_EXTENSION_ERROR');
      const expectation = { version: 1, kind: 'benchmark-pi-sdk-expectation', projection: capture.projection, ...captureContract };
      admission.refs.push(await recorder.save('candidate-expectation', expectation));
      admission.status = 'captured_not_authorized'; status = 'captured';
    } else {
      for (const turn of config.turns) {
        enterStage('user_task');
        budget.available(); settled = false; currentRequest = undefined;
        currentTurn = { id: turn.id, prompt: turn.prompt, kind: turn.kind ?? 'user', started_monotonic_ns: process.hrtime.bigint().toString() };
        turns.push(currentTurn); recorder.bind({ turn_id: turn.id, request_id: null });
        currentTurn.start_ref = recorder.record('user_turn_start', { id: turn.id, prompt: turn.prompt, kind: turn.kind ?? 'user', session_id: session.sessionId });
        await Promise.race([session.prompt(turn.prompt), stopping]);
        await Promise.race([session.waitForIdle(), stopping]);
        currentTurn.ended_monotonic_ns = process.hrtime.bigint().toString();
        currentTurn.final_text = session.getLastAssistantText() ?? null;
        currentTurn.workspace_manifest_ref = await recorder.save('turn-' + turns.length + '-workspace', await inventory(config.workspace));
        currentTurn.end_ref = recorder.record('user_turn_end', { id: turn.id, settled, is_idle: session.isIdle, session_id: session.sessionId, final_text: currentTurn.final_text, budget: budget.state });
        if (terminalError) throw terminalError;
        if (!settled || !session.isIdle) throw new EpisodeStop('BENCHMARK_TURN_NOT_SETTLED');
        budget.available();
        if (currentRequest?.assistant?.stop_reason === 'error' || currentRequest?.assistant?.stop_reason === 'aborted') throw new EpisodeStop('BENCHMARK_PROVIDER_TERMINAL_ERROR', { assistant: currentRequest.assistant });
        if (hooks.afterTurn) {
          enterStage('controller_pause');
          const ref = recorder.record('controller_pause_start', { turn_id: turn.id });
          await Promise.race([hooks.afterTurn({ turn_id: turn.id, ref }), stopping]);
          recorder.record('controller_pause_end', { turn_id: turn.id });
        }
      }
      budget.available(); status = 'completed';
    }
  } catch (error) {
    terminalError ??= error;
    const code = terminalError.code ?? terminalError.message;
    if (cancelled) status = 'cancelled';
    else if (/ADMISSION|CONTRACT_DRIFT|MODEL_DRIFT|SELECTION_DRIFT/.test(code)) { status = 'admission_rejected'; admission.status = 'rejected'; }
    else if (/LIMIT|CAP_UNENFORCED/.test(code)) status = 'budget_stopped';
    else if (code === 'BENCHMARK_PROVIDER_TERMINAL_ERROR') status = 'failed';
    else status = 'invalid';
    recorder.record('runtime_error', errorData(terminalError));
  } finally {
    enterStage('cleanup');
    runtimeController.abort(terminalError ?? new EpisodeStop('BENCHMARK_RUNTIME_CLOSED'));
    clearTimeout(timer);
    if (onSigTerm) process.off('SIGTERM', onSigTerm);
    if (onSigInt) process.off('SIGINT', onSigInt);
    if (session) {
      try { cleanup.abort_settled = await bounded(session.abort().then(() => true), 4000, false); } catch (error) { recorder.record('cleanup_error', errorData(error)); }
      try { await bounded(session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }).then(() => { cleanup.shutdown_emitted = true; }), 2000, undefined); } catch (error) { recorder.record('cleanup_error', errorData(error)); }
      unsubscribe?.(); session.dispose(); cleanup.dispose_called = true;
      try {
        await recorder.save('session-entries', { session_id: session.sessionId, entries: session.sessionManager.getEntries() });
        if (session.sessionFile && await exists(session.sessionFile)) {
          if (resources) {
            assert.ok(inside(config.runRoot, session.sessionFile), 'BENCHMARK_PRIVATE_SESSION_PATH');
            await recorder.addRedactedJsonlArtifact('session', session.sessionFile, 'pi-session-jsonl');
          } else await recorder.addArtifact('session', session.sessionFile, 'pi-session-jsonl');
        }
      } catch (error) { recorder.record('session_capture_error', errorData(error)); status = 'invalid'; }
    }
    try {
      if (notion) {
        const settled = await finishEpisodeNotion({ notion, status, record: (type, data) => recorder.record(type, data) });
        notionResult = settled.result; status = settled.status;
        coverage.notion_sdk = notionResult.coverage.sdk;
        coverage.notion_owned_http = notionResult.coverage.owned_http;
      }
    } catch (error) { recorder.record('notion_validation_error', errorData(error)); coverage.notion_sdk = 'partial'; coverage.notion_owned_http = 'partial'; status = 'invalid'; }
    try {
      transport?.finish();
      if (await exists(transportPath)) {
        const transportResult = await readProviderTransport(transportPath);
        await recorder.addArtifact('transport', transportPath, 'jsonl');
        const raw = (await readFile(transportPath, 'utf8')).trimEnd().split('\n').map(JSON.parse);
        const modelStarts = raw.filter(row => row.phase === 'request_start' && row.category === 'model');
        const sent = new Map(raw.filter(row => row.phase === 'request_sent').map(row => [row.id, row]));
        const ends = new Map(raw.filter(row => row.phase === 'request_end').map(row => [row.id, row]));
        const attempts = requests.flatMap(request => request.attempts);
        let complete = modelStarts.length === attempts.length && transportResult.at(-1)?.complete === true;
        for (let index = 0; index < attempts.length; index++) {
          const attempt = attempts[index], start = modelStarts[index], sentRow = start && sent.get(start.id), endRow = start && ends.get(start.id);
          const request = requests.find(item => item.id === attempt.request_id);
          if (!start) { complete = false; continue; }
          attempt.transport_id = start.id; attempt.sent = sentRow ? true : null; attempt.transport_start_ref = { artifact_id: 'transport', line: start.sequence };
          if (sentRow) attempt.sent_ref = { artifact_id: 'transport', line: sentRow.sequence }; else complete = false;
          if (endRow) { attempt.transport_end = endRow; attempt.transport_end_ref = { artifact_id: 'transport', line: endRow.sequence }; } else complete = false;
          if (sentRow && sentRow.requestBodySha256 !== request.payload_sha256) complete = false;
        }
        coverage.attempts = complete ? 'complete' : 'partial';
        recorder.record('transport_reconciliation', { model_http_requests: modelStarts.length, guarded_fetch_attempts: attempts.length, complete, transport_validation: transportResult });
      }
    } catch (error) { recorder.record('transport_validation_error', errorData(error)); coverage.attempts = 'partial'; }
    coverage.tools = session && cleanup.dispose_called && cleanup.abort_settled ? 'complete' : 'partial';
    coverage.interventions = cleanup.abort_settled || !session ? 'complete' : 'partial';
    if (resources) {
      try {
        const after = await readResourceProfile(resources.ref, { environmentRoot: dirname(dirname(config.runRoot)) });
        assert.deepEqual(after.evidence, resources.evidence, 'BENCHMARK_RESOURCE_PROFILE_DRIFT');
        for (const item of resources.agentFiles) assert.equal(sha256(await readFile(join(config.agentDir, item.relative_path))), item.source.sha256, 'BENCHMARK_PRIVATE_AGENT_FILE_DRIFT');
        assert.equal(sha256(await readFile(join(config.agentDir, 'mcp.json'))), resources.manifest.mcp_config.sha256, 'BENCHMARK_MCP_PRIVATE_CONFIG_DRIFT');
        recorder.record('resource_profile_after', { status: 'unchanged', evidence: after.evidence });
      } catch (error) {
        recorder.record('resource_profile_after', { status: 'changed_or_unavailable', error: errorData(error) });
        status = 'invalid'; terminalError ??= new EpisodeStop('BENCHMARK_RESOURCE_PROFILE_DRIFT', { reason: error.message });
      }
    }
    if (installation) {
      const after = await Promise.all(installation.files.map(item => fileIdentity(item.path)));
      const differences = candidateDifferences(installation.files, after);
      recorder.record('sdk_runtime_after', { files: after, differences });
      if (differences.length) { status = 'invalid'; terminalError ??= new EpisodeStop('BENCHMARK_SDK_RUNTIME_DRIFT'); }
    }
    if (['captured', 'completed'].includes(status) && (coverage.attempts !== 'complete' || !cleanup.abort_settled)) status = 'invalid';
    recorder.record('runtime_end', { status, cleanup, coverage, budget: budget.state, elapsed_ms: performance.now() - started, process_exit_requires_parent_receipt: true });
  }
  await recorder.close();
  const result = bindReferences({ version: 1, entry_kind: 'pi-sdk', status, correlation: config.correlation, admission, turns, requests, interventions,
    error: terminalError ? errorData(terminalError) : null, budget: budget.state, coverage, notion: notionResult ?? null,
    instrumentation: { ...recorder.overhead, scope: 'event synchronous writes and JSON artifact writes; not total observer CPU or network overhead', symmetric_configuration: true },
    completion: { agent_settled: settled, cleanup, process_exit: 'requires_parent_launcher_receipt' },
    timing: { started_monotonic_ns: startedNs, ended_monotonic_ns: process.hrtime.bigint().toString(), duration_ms: performance.now() - started, time_to_success_ms: null, time_to_success_basis: 'independent_business_readback_required' },
    artifacts: recorder.artifacts,
    paths: { result: join(config.controlDir, 'episode-result.json'), expectation: config.admission.captureOnly ? join(config.controlDir, 'candidate-expectation.json') : null, events: recorder.eventPath, transport: await exists(transportPath) ? transportPath : null },
  }, recorder.artifacts);
  return writeEpisodeResult(result, recorder, { redact: Boolean(resources) });
}
