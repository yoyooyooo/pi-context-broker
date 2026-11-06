#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemTempRoot, verificationCliEnvironment } from './verification-paths.mjs';

export const CONTRACT_VERSION = 1;
export const PROMPT_VERSION = 2;
export const TASK_V1 = '请为这个项目建立一套可重复执行的验收流程，覆盖用户入口、正常路径、失败反例、证据保存与清理边界。先读取已选择能力提供的目录和所需参考，再说明怎样证明功能真的完成；只输出方案，不执行项目或远端写入。';
export const TASK = '请为这个项目建立一套可重复执行的验收流程，覆盖用户入口、正常路径、失败反例、证据保存与清理边界。先读取已选择能力提供的目录和所需参考，再说明怎样证明功能真的完成。方案包含可直接保存的完整验收规程文件内容，用文件路径标注代码块；只输出方案，不执行项目或远端写入。';
export const EVIDENCE_COLUMNS = ['controlled', 'real_service', 'real_model', 'real_ui', 'installed_package'];
const brokerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const within = (base, target) => { const part = relative(resolve(base), resolve(target)); return part === '' || (!part.startsWith('..' + '/') && part !== '..' && !isAbsolute(part)); };
const disjoint = (a, b) => !within(a, b) && !within(b, a);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const check = (condition, code, message) => { if (!condition) fail(code, message); };

// A new explicitly frozen AH-639 route, never an interpretation of an old
// flash-free failure or worker authorization. Legacy callers keep their policy.
export function dailyRouteContract(config) {
  if (config.modelContract === undefined) {
    check(config.thinkingLevel === undefined && config.rpcTimeoutMs === undefined, 'MODEL_CONTRACT',
      'Thinking and RPC policy require an explicit daily-route-v1 contract');
    return undefined;
  }
  const profile = { modelContract: 'daily-route-v1', model: 'magpie/group/flash', thinkingLevel: 'high', rpcTimeoutMs: 300000,
    controllerRetries: 0, fallback: 'forbidden', ownedProjectRetry: { retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } } };
  for (const key of ['modelContract', 'model', 'thinkingLevel', 'rpcTimeoutMs'])
    check(config[key] === profile[key], 'MODEL_CONTRACT', 'Daily model policy differs at ' + key);
  check(config.workerAuthorization === undefined && (config.previousFailures === undefined
    || Array.isArray(config.previousFailures) && config.previousFailures.length === 0), 'MODEL_CONTRACT',
  'Daily routing cannot reuse legacy fallback authorization');
  for (const key of ['controllerRetries', 'fallback'])
    check(config[key] === undefined || config[key] === profile[key], 'MODEL_CONTRACT', 'Daily model policy differs at ' + key);
  if (config.ownedProjectRetry !== undefined) assert.deepEqual(config.ownedProjectRetry, profile.ownedProjectRetry,
    'Daily retry policy must remain explicit and isolated to the owned project');
  return profile;
}

export function verifyDailyRouteState(profile, state) {
  assert.deepEqual(profile, dailyRouteContract(profile), 'The normalized daily profile changed');
  const separator = profile.model.indexOf('/');
  check(state?.model?.provider === profile.model.slice(0, separator) && state?.model?.id === profile.model.slice(separator + 1)
    && state?.thinkingLevel === profile.thinkingLevel, 'MODEL_STATE', 'Actual Pi model/thinking differs from the frozen daily route');
  return { provider: state.model.provider, model: state.model.id, thinkingLevel: state.thinkingLevel };
}

export function verifyDailyRouteEvidence(profile, { states, requests, transports, responses }) {
  assert.deepEqual(profile, dailyRouteContract(profile), 'The normalized daily profile changed');
  const separator = profile.model.indexOf('/');
  check(Array.isArray(states) && states.length > 0, 'MODEL_STATE', 'Retain actual Pi state before the daily submission');
  states.forEach(state => verifyDailyRouteState(profile, state));
  check(Array.isArray(requests) && requests.length > 0 && Array.isArray(transports) && Array.isArray(responses)
    && transports.length === requests.length && responses.length === requests.length,
  'MODEL_ROUTE_EVIDENCE', 'Every daily request needs one actual wire and one response; retries and missing evidence remain failures');
  check(new Set(requests.map(request => request.sequence)).size === requests.length,
    'MODEL_ROUTE_EVIDENCE', 'Daily provider request identities must be unique');
  for (const request of requests) {
    check(Number.isSafeInteger(request.sequence) && request.model === profile.model && request.reasoningEffort === profile.thinkingLevel
      && /^[a-f0-9]{64}$/.test(request.observedPayloadSha256 ?? ''), 'MODEL_ROUTE_EVIDENCE', 'Actual provider input must bind the frozen model and high thinking');
    const wires = transports.filter(wire => wire.providerSequence === request.sequence);
    check(wires.length === 1 && wires[0].observedPayloadSha256 === request.observedPayloadSha256
      && [profile.model, profile.model.slice(profile.model.indexOf('/') + 1)].includes(wires[0].wireModel)
      && wires[0].reasoningEffort === profile.thinkingLevel, 'MODEL_ROUTE_EVIDENCE', 'Actual wire model/thinking must match the observed request');
    const results = responses.filter(response => response.providerSequence === request.sequence), response = results[0];
    check(results.length === 1 && response.providerPayloadSha256 === request.observedPayloadSha256
      && response.provider === profile.model.slice(0, separator) && response.model === profile.model.slice(separator + 1) && nonempty(response.responseModel)
      && ['stop', 'length', 'toolUse'].includes(response.stopReason), 'MODEL_ROUTE_EVIDENCE', 'Retain the actual routed response for this request');
    check(['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every(key => Number.isFinite(response.usage?.[key])
      && response.usage[key] >= 0) && response.usage.totalTokens > 0, 'MODEL_ROUTE_EVIDENCE', 'Missing actual response usage remains unknown');
  }
  return { modelContract: profile.modelContract, requests: requests.length,
    responseModels: [...new Set(responses.map(response => response.responseModel))] };
}

export function frozenPrompt(gate, selection, version = PROMPT_VERSION) {
  check(version === 1 || version === PROMPT_VERSION, 'PROMPT_VERSION', 'Unknown frozen prompt version');
  check(gate === 'A' || gate === 'B', 'GATE', 'Gate must be A or B');
  check(/^\$[A-Za-z0-9][A-Za-z0-9_@.:-]*$/.test(selection ?? ''), 'ROOT_SELECTION', 'Pass exactly one native root selection');
  check(gate !== 'A' || !/poteto/i.test(selection), 'ROOT_SELECTION', 'Gate A cannot select the ordinary Skill');
  check(gate !== 'B' || !/pstack/i.test(selection), 'ROOT_SELECTION', 'Gate B cannot select the Router');
  const text = selection + ' ' + (version === 1 ? TASK_V1 : TASK);
  return { version, gate, selection, text, sha256: sha(text) };
}

// This records an authorization already supplied by the user; a receipt is not
// a substitute for that approval and must never become model prompt content.
export function verifyWorkerAuthorization(evidence, scope) {
  const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
  check(exactKeys(evidence, ['path', 'sha256', 'raw']) && nonempty(evidence.path) && isAbsolute(evidence.path),
    'MODEL_AUTHORIZATION', 'Worker authorization needs an absolute retained receipt and its exact source bytes');
  check(typeof evidence.raw === 'string' && /^[a-f0-9]{64}$/.test(evidence.sha256 ?? '') && sha(evidence.raw) === evidence.sha256,
    'MODEL_AUTHORIZATION', 'Worker authorization receipt bytes do not match their frozen SHA-256');
  let receipt;
  try { receipt = JSON.parse(evidence.raw); } catch { fail('MODEL_AUTHORIZATION', 'Worker authorization receipt must be JSON'); }
  check(exactKeys(receipt, ['version', 'kind', 'model', 'scope', 'authorizationQuestion', 'userReply'])
    && receipt.version === 1 && receipt.kind === 'explicit-user-worker-authorization' && receipt.model === 'magpie/group/worker',
  'MODEL_AUTHORIZATION', 'Worker authorization must explicitly name the allowed model and known receipt fields');
  check(exactKeys(receipt.scope, ['gate', 'rootRef', 'promptSha256'])
    && receipt.scope.gate === scope.gate && receipt.scope.rootRef === scope.rootRef && receipt.scope.promptSha256 === scope.promptSha256,
  'MODEL_AUTHORIZATION', 'Worker authorization must bind this exact gate, selected root and frozen prompt');
  check(nonempty(receipt.authorizationQuestion) && nonempty(receipt.userReply),
    'MODEL_AUTHORIZATION', 'Retain the actual authorization question and user reply');
  return receipt;
}

// This validates an observer contract. A valid document is never by itself a
// live feature pass; the owning runner must retain its native action artifacts.
export function evaluateGraphTrace(trace, oracle) {
  check(trace?.version === CONTRACT_VERSION && oracle?.version === CONTRACT_VERSION, 'VERSION', 'Unknown trace or oracle version');
  check(trace.evidenceKind === 'real_model', 'PROOF_LAYER', 'Controlled evidence cannot claim the real-model gate');
  check(trace.host === 'pi' && trace.nativeEntry === true, 'NATIVE_ENTRY', 'A real Pi native entry receipt is required');
  const root = oracle.roots?.[trace.gate];
  check(root && root.kind === (trace.gate === 'A' ? 'router' : 'skill'), 'ROOT_KIND', 'The selected root kind must match the gate');
  check(trace.prompt?.version === 1 || trace.prompt?.version === PROMPT_VERSION, 'PROMPT_VERSION', 'The trace must name its independently frozen prompt version');
  const prompt = frozenPrompt(trace.gate, root.selection, trace.prompt?.version);
  check(trace.prompt?.text === prompt.text && trace.prompt?.sha256 === prompt.sha256, 'PROMPT_CHANGED', 'The root-only task must remain frozen');
  check(trace.selectedRoots?.length === 1 && trace.selectedRoots[0] === root.ref, 'ROOT_SELECTION', 'Only the intended root may be selected');
  const target = oracle.target;
  check(target && nonempty(target.ref) && nonempty(target.logicalId) && nonempty(target.scope) && nonempty(target.snapshot), 'ORACLE_INCOMPLETE', 'The private oracle needs stable target identity');
  for (const forbidden of [target.name, target.ref, target.logicalId, target.bodySha256, ...(target.answerTokens ?? [])].filter(nonempty)) {
    check(!trace.prompt.text.includes(forbidden), 'ORACLE_LEAK', 'Private target identity or answer leaked into the user prompt');
  }
  check(trace.gate !== 'A' || !/poteto-mode/i.test(trace.prompt.text), 'GATE_BRIDGE', 'Gate A cannot name or use the ordinary Skill as a bridge');
  check(trace.gate !== 'A' || !trace.reads?.some(row => row.ref === oracle.roots?.B?.ref), 'GATE_BRIDGE', 'Gate A read the ordinary Skill as a bridge');
  check(!trace.requiredRefs?.includes(target.ref), 'FORCED_LEAF', 'An optional member cannot be changed into a required leaf');
  check(trace.toolChoice === 'auto' && trace.forcedToolArguments === false, 'FORCED_LEAF', 'The model must choose its own native read');

  const isolation = trace.isolation;
  check(isolation?.oracleRoots?.length > 0 && isolation.consumerRoots?.length === 3, 'ISOLATION_MISSING', 'Record separate oracle and CLI/Broker/session roots');
  const roots = [...isolation.oracleRoots, ...isolation.consumerRoots];
  check(roots.every(isAbsolute), 'ISOLATION_MISSING', 'Isolation roots must be absolute resolved paths');
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
    check(disjoint(roots[i], roots[j]), 'ORACLE_WARMING', 'Oracle and every consumer cache layer must be disjoint');
  }
  check(isolation.resolved === true && isolation.oracleObserverOnly === true, 'ORACLE_WARMING', 'Resolve paths and keep the oracle outside model inputs');
  check(isolation.inventoryComplete === true && Array.isArray(isolation.localSkillInventory), 'LOCAL_INVENTORY', 'Retain the actual local Skill/plugin inventory');
  check(!isolation.localSkillInventory.some(item => /(?:pstack|matt-skills)/i.test([item.path, item.packageId, item.suite, item.source].filter(nonempty).join(' ')) || [target.bodySha256, ...(oracle.resources ?? []).map(row => row.sha256)].includes(item.sha256)), 'LOCAL_COPY', 'A hidden or renamed local Pstack/Matt copy invalidates the gate');
  check(isolation.shellEnabled === false && isolation.contextFiles === false && isolation.promptTemplates === false && isolation.autoExtensions === false, 'LOCAL_FALLBACK', 'Disable unobserved shell, context and plugin fallbacks');
  check(['cold', 'warm'].includes(trace.cacheMode), 'CACHE_MODE', 'Record the actual cache mode');
  check(isolation.prelaunch?.length === 3 && isolation.prelaunch.every(row => isolation.consumerRoots.includes(row.root) && Number.isInteger(row.entries) && row.entries >= 0), 'CACHE_BASELINE', 'Each consumer root needs its prelaunch inventory');
  check(new Set(isolation.prelaunch.map(row => row.root)).size === 3, 'CACHE_BASELINE', 'Prelaunch evidence must cover all three distinct roots');
  if (trace.cacheMode === 'cold') check(isolation.prelaunch.every(row => row.entries === 0), 'ORACLE_WARMING', 'A cold run must start with three empty consumer layers');

  check(Array.isArray(trace.candidates) && trace.candidates.length > 0, 'CATALOG_MISSING', 'The actual root member directory must be observed');
  const entryIdentity = value => {
    const match = typeof value === 'string' && /^skill:\/\/([^/?#]+)\/([^?#]+)(?:\?([^#]*))?$/.exec(value);
    if (!match) return undefined;
    try {
      const query = new URLSearchParams(match[3]);
      if ([...query.keys()].some(key => !['snapshot', 'file_id'].includes(key)) || query.getAll('snapshot').length > 1 || query.getAll('file_id').length > 1) return undefined;
      const parts = match[2].split('/').map(decodeURIComponent);
      if (parts.some(part => !part || part === '.' || part === '..' || part.includes('/'))) return undefined;
      return { owner: decodeURIComponent(match[1]), path: parts.join('/') };
    } catch { return undefined; }
  };
  const targetEntry = entryIdentity(target.ref);
  check(targetEntry && trace.candidates.some(row => {
    const entry = entryIdentity(row.observedRef ?? row.ref);
    return entry?.owner === target.logicalId && entry.path === targetEntry.path
      && row.logicalId === target.logicalId && row.scope === target.scope && row.available === true;
  }), 'CANDIDATE_IDENTITY', 'The target directory entry must expose its stable owner, scope and entrypoint');
  check(Number.isSafeInteger(trace.memberBodyReadsBeforeSelection) && trace.memberBodyReadsBeforeSelection >= 0, 'OBSERVATION_INCOMPLETE', 'Body ownership attribution is incomplete; unknown requests cannot prove eager members or zero reads');
  check(trace.memberBodyReadsBeforeSelection === 0, 'EAGER_MEMBERS', 'Unselected member bodies must remain unread');
  check(Array.isArray(trace.reads) && trace.reads.length > 0, 'READ_MISSING', 'Retain native tool calls and full read receipts');
  const alternatives = oracle.resourceAlternatives ?? [];
  check(Array.isArray(alternatives) && alternatives.every(group => Array.isArray(group) && group.length > 0), 'ORACLE_INCOMPLETE', 'Each optional resource choice group must contain exact candidate identities');
  const selectedAlternatives = alternatives.map((group, index) => {
    check(new Set(group.map(item => item.logicalId)).size === group.length, 'ORACLE_INCOMPLETE', 'A resource choice group must use distinct stable identities');
    const selected = group.filter(item => trace.reads.some(row => row.ref === item.ref || row.logicalId === item.logicalId));
    check(selected.length > 0, 'READ_MISSING', 'The model must actually read at least one full resource from every choice group');
    return { group: index, resources: selected };
  });
  const required = [{ ref: target.ref, logicalId: target.logicalId, scope: target.scope, snapshot: target.snapshot, sha256: target.bodySha256, bytes: target.bodyBytes }, ...(oracle.resources ?? [])];
  const allCandidates = [...required, ...alternatives.flat()];
  for (const item of allCandidates) check(nonempty(item.ref) && nonempty(item.logicalId) && nonempty(item.scope) && nonempty(item.snapshot) && nonempty(item.sha256) && Number.isInteger(item.bytes) && item.bytes > 0, 'ORACLE_INCOMPLETE', 'Every fixed or alternative resource needs an exact identity and bytes/hash');
  const expected = [...new Map([...required, ...selectedAlternatives.flatMap(group => group.resources)].map(item => [item.ref, item])).values()];
  check(expected.length > 1, 'ORACLE_INCOMPLETE', 'The oracle must include a feature-map resource');
  for (const item of expected) {
    check(nonempty(item.ref) && nonempty(item.sha256) && Number.isInteger(item.bytes) && item.bytes > 0, 'ORACLE_INCOMPLETE', 'Every expected node needs exact bytes/hash');
    const read = trace.reads.find(row => row.ref === item.ref);
    check(read, 'READ_MISSING', 'The model must actually read every expected node');
    const proof = read.preparationProof;
    const currentUse = read.tool === 'notion_use';
    const historicalPrepare = trace.toolContract === undefined && read.tool === 'skill_prepare';
    const preparedMain = (currentUse || historicalPrepare) && item.logicalId === target.logicalId && read.role === 'entrypoint'
      && proof?.explicitRoot === true && (currentUse ? proof.purpose === 'use' : ['use', 'inspect'].includes(proof.purpose)) && proof.deliveryVerified === true
      && Array.isArray(proof.roots) && proof.roots.some(ref => {
        try { return decodeURIComponent(/^skill:\/\/([^/?#]+)\//.exec(ref)?.[1] ?? '') === item.logicalId; } catch { return false; }
      }) && nonempty(proof.publicRequestId) && /^[a-f0-9]{64}$/.test(proof.graphLockSha256 ?? '')
      && /^[a-f0-9]{64}$/.test(proof.manifestSha256 ?? '') && proof.publicRef === item.ref
      && proof.scope === item.scope && proof.ownerId === item.logicalId && proof.snapshot === item.snapshot
      && proof.sha256 === item.sha256 && proof.bytes === item.bytes && /^[a-f0-9]{64}$/.test(proof.toolResultSha256 ?? '')
      && Number.isSafeInteger(proof.toolResultBytes) && proof.toolResultBytes > item.bytes
      && trace.providerRequests?.some(request => request.toolResults?.some(result => result.toolCallId === read.toolCallId
        && result.tool === read.tool && result.sha256 === proof.toolResultSha256 && result.bytes === proof.toolResultBytes
        && result.records?.some(record => record.ref === item.ref && record.scope === item.scope && record.snapshot === item.snapshot
          && record.sha256 === item.sha256 && record.bytes === item.bytes && record.providerCopies === 1)));
    check(read.origin === 'model' && (read.tool === 'read' || preparedMain) && read.discovered === true && read.sequence > trace.directorySequence, 'NAME_GUESSING', 'Main instructions must come from an exact native read or fully verified explicit preparation; resources require native read');
    check(read.scope === item.scope && read.logicalId === item.logicalId && read.snapshot === item.snapshot, 'IDENTITY_MISMATCH', 'Scope, stable ID and snapshot must match the private oracle');
    check(read.complete === true && typeof read.content === 'string' && !read.error, 'INCOMPLETE_CONTENT', 'A complete successful body receipt is required');
    check(Buffer.byteLength(read.content) === item.bytes && sha(read.content) === item.sha256 && read.sha256 === item.sha256, 'CONTENT_MISMATCH', 'Observed bytes must match both the receipt and independent oracle');
    if (read.resourceBatchProof) {
      const batch = read.resourceBatchProof;
      check(read.tool === 'read' && read.role === 'resource' && batch.deliveryVerified === true
        && Number.isSafeInteger(batch.index) && batch.index >= 0 && nonempty(batch.publicRequestId)
        && batch.selection?.scope === item.scope && batch.selection?.snapshot_id === item.snapshot
        && batch.selection?.owner === entryIdentity(item.ref)?.owner
        && batch.delivery?.encoding === 'json' && Number.isSafeInteger(batch.delivery.start) && batch.delivery.start >= 0
        && Number.isSafeInteger(batch.delivery.end) && batch.delivery.end >= batch.delivery.start
        && trace.providerRequests?.some(request => request.toolResults?.some(result => result.toolCallId === read.toolCallId
          && result.tool === 'read' && result.exactToolOutputCopies === 1
          && result.sha256 === batch.toolResultSha256 && result.bytes === batch.toolResultBytes
          && result.records?.some(record => record.ref === item.ref && record.scope === item.scope && record.snapshot === item.snapshot
            && record.sha256 === item.sha256 && record.bytes === item.bytes && record.providerCopies === 1))),
      'PROVIDER_CONTENT', 'Every complete batch resource must reach the provider inside the same verified outer tool result');
    }
  }
  check(!trace.reads.some(row => row.error), 'HIDDEN_FAILURE', 'Selected read failures cannot disappear from the trace');
  check(Array.isArray(trace.providerRequests) && trace.providerRequests.length >= 2, 'PROVIDER_MISSING', 'Retain provider inputs before and after model reads');
  const first = trace.providerRequests[0];
  check(!first.contents?.some(row => allCandidates.some(item => item.ref === row.ref || sha(row.content ?? '') === item.sha256)), 'FORCED_LEAF', 'The target/resource, including an unchosen alternative, cannot be preloaded into the first model request');
  for (const item of expected) {
    check(trace.providerRequests.some(request => request.contents?.some(row => row.ref === item.ref && sha(row.content ?? '') === item.sha256 && Buffer.byteLength(row.content ?? '') === item.bytes)), 'PROVIDER_CONTENT', 'Actual provider input must contain the verified read bytes');
    check(trace.providerRequests.every(request => (request.contents ?? []).filter(row => row.ref === item.ref).length <= 1), 'DUPLICATE_BODY', 'Do not inject the same body twice in one provider request');
  }
  check(trace.httpLedgerObserved === true && Array.isArray(trace.httpAttempts), 'HTTP_LEDGER', 'Retain the actual HTTP ledger even when a warm run makes zero requests');
  check(trace.httpAttempts.every(row => row.transport === 'direct_http'), 'LEGACY_TRANSPORT', 'Every attempt must use the direct request engine');
  check(trace.httpAttempts.every(row => (Number.isInteger(row.status) || (row.status === null && nonempty(row.networkError))) && typeof row.requestIdAvailable === 'boolean' && (row.requestIdAvailable ? nonempty(row.requestId) : row.requestId === null)), 'HTTP_METADATA', 'Preserve actual response/network metadata and never invent a missing request ID');
  check(!trace.httpAttempts.some(row => row.kind === 'write'), 'UNAUTHORIZED_WRITE', 'This read-only gate cannot mutate remote data');
  if (trace.cacheMode === 'cold') check(trace.httpAttempts.some(row => row.kind === 'body'), 'FALSE_COLD', 'An empty consumer must observe a real body request');
  if (trace.modelProfile !== undefined) {
    const profile = dailyRouteContract({ ...trace.modelProfile, previousFailures: trace.model?.previousFailures,
      workerAuthorization: trace.model?.workerAuthorization });
    assert.deepEqual(trace.modelProfile, profile, 'Daily trace profile must match its frozen policy');
    check(trace.model?.selector === profile.model, 'MODEL_SELECTOR', 'Daily trace selector differs from its explicit contract');
    verifyDailyRouteEvidence(profile, { states: trace.model.stateReadbacks, requests: trace.providerRequests,
      transports: trace.model.transports, responses: trace.model.responses });
  } else check(['magpie/group/flash-free', 'magpie/group/worker'].includes(trace.model?.selector), 'MODEL_SELECTOR', 'Only the authorized model sequence is valid');
  if (trace.model.workerAuthorization !== undefined) {
    check(trace.model.selector === 'magpie/group/worker', 'MODEL_AUTHORIZATION', 'Worker authorization cannot authorize another model');
    verifyWorkerAuthorization(trace.model.workerAuthorization, { gate: trace.gate, rootRef: trace.selectedRoots[0], promptSha256: trace.prompt.sha256 });
  }
  if (trace.model.selector.endsWith('/worker')) check(trace.model.previousFailures?.some(row => row.selector === 'magpie/group/flash-free' && row.status === 'failed' && nonempty(row.evidenceSha256)) || trace.model.workerAuthorization !== undefined, 'MODEL_FALLBACK', 'Worker requires retained flash-free failure evidence or explicit user authorization');
  check(trace.model.responseStatus >= 200 && trace.model.responseStatus < 300, 'MODEL_HTTP', 'The provider must return a successful HTTP response');
  const final = trace.model.final;
  check(final?.success === true && ['stop', 'length'].includes(final.stopReason) && nonempty(final.text), 'MODEL_FINAL', 'HTTP success alone does not prove a successful model final');
  check(!/(?:insufficient (?:permission|quota)|not authorized|api key.*(?:invalid|denied)|please upgrade|无权限使用|额度不足|账户.*(?:无权|欠费))/i.test(final.text), 'MODEL_PERMISSION', 'HTTP 200 permission or quota messages do not prove model consumption');
  check(trace.processes?.length > 0 && trace.processes.every(row => row.owned === true && row.closed === true && row.spawnObserved === true && row.closeObserved === true), 'PROCESS_EVIDENCE', 'Owned host processes need observed spawn and close receipts');
  check(trace.unknownWrites?.length === 0 && trace.replayedUnknownWrites === false, 'UNKNOWN_WRITE', 'Preserve unknown write receipts and never replay them');
  return { status: 'contract-valid', version: CONTRACT_VERSION, gate: trace.gate, evidenceKind: trace.evidenceKind, observedNodes: expected.length, selectedResourceAlternatives: selectedAlternatives.map(group => ({ group: group.group, resources: group.resources.map(item => ({ ref: item.ref, logicalId: item.logicalId, scope: item.scope, snapshot: item.snapshot, sha256: item.sha256, bytes: item.bytes })) })), productAcceptance: 'not-inferred', proofBoundary: 'Validate this trace against the originating native runner artifacts before claiming a live gate pass.' };
}

export function contractFixture(gate = 'A') {
  const body = 'Verification workflow: launch, drive, observe, retain.';
  const resource = 'Feature map: positive, negative, recovery, ownership.';
  const scope = 'fixture-connection/library';
  const target = { name: 'create-verification-skill', logicalId: 'fixture-leaf', ref: 'skill://fixture-leaf/SKILL.md?snapshot=fixture-v1', scope, snapshot: 'fixture-v1', bodySha256: sha(body), bodyBytes: Buffer.byteLength(body), answerTokens: ['PRIVATE_ORACLE_42'] };
  const file = { logicalId: 'fixture-feature-map', ref: 'skill://fixture-leaf/references/feature-map.md?snapshot=fixture-v1', scope, snapshot: 'fixture-v1', sha256: sha(resource), bytes: Buffer.byteLength(resource) };
  const oracle = { version: CONTRACT_VERSION, roots: { A: { kind: 'router', selection: '$pstack@notion', ref: 'skill://fixture-router/SKILL.md' }, B: { kind: 'skill', selection: '$poteto-mode@notion', ref: 'skill://fixture-ordinary/SKILL.md' } }, target, resources: [file] };
  const consumerRoots = ['/private/tmp/ng-contract-cli', '/private/tmp/ng-contract-broker', '/private/tmp/ng-contract-session'];
  const reads = [{ ...target, sha256: target.bodySha256, content: body }, { ...file, content: resource }].map((row, i) => ({ ...row, tool: 'read', origin: 'model', discovered: true, sequence: i + 2, complete: true }));
  const trace = { version: CONTRACT_VERSION, evidenceKind: 'real_model', host: 'pi', nativeEntry: true, gate, prompt: frozenPrompt(gate, oracle.roots[gate].selection), selectedRoots: [oracle.roots[gate].ref], requiredRefs: [], toolChoice: 'auto', forcedToolArguments: false, cacheMode: 'cold', isolation: { oracleRoots: ['/private/tmp/ng-contract-oracle'], consumerRoots, resolved: true, oracleObserverOnly: true, inventoryComplete: true, localSkillInventory: [], shellEnabled: false, contextFiles: false, promptTemplates: false, autoExtensions: false, prelaunch: consumerRoots.map(root => ({ root, entries: 0 })) }, candidates: [{ ref: target.ref, logicalId: target.logicalId, scope, available: true }], memberBodyReadsBeforeSelection: 0, directorySequence: 1, reads, providerRequests: [{ contents: [] }, { contents: reads.map(row => ({ ref: row.ref, content: row.content })) }], httpLedgerObserved: true, httpAttempts: [{ transport: 'direct_http', kind: 'body', requestIdAvailable: true, requestId: 'controlled-http-fixture', status: 200 }], model: { selector: 'magpie/group/flash-free', responseStatus: 200, final: { text: '验收流程已按读取的步骤与功能地图整理。', success: true, stopReason: 'stop' } }, processes: [{ owned: true, closed: true, spawnObserved: true, closeObserved: true }], unknownWrites: [], replayedUnknownWrites: false };
  return { trace, oracle };
}

export const NEGATIVE_CASES = [
  ['oracle-warms-cli', 'ORACLE_WARMING', value => { value.trace.isolation.oracleRoots = [value.trace.isolation.consumerRoots[0]]; }],
  ['nested-oracle-root', 'ORACLE_WARMING', value => { value.trace.isolation.oracleRoots = [value.trace.isolation.consumerRoots[0] + '/oracle']; }],
  ['hidden-plugin-copy', 'LOCAL_COPY', value => { value.trace.isolation.localSkillInventory.push({ path: '/tmp/.agents/plugins/.cache/pstack/skills' }); }],
  ['hidden-matt-copy', 'LOCAL_COPY', value => { value.trace.isolation.localSkillInventory.push({ path: '/tmp/.codex/plugins/matt-skills-curated' }); }],
  ['renamed-plugin-copy', 'LOCAL_COPY', value => { value.trace.isolation.localSkillInventory.push({ path: '/tmp/renamed/skills', packageId: 'pstack-plugin' }); }],
  ['renamed-body-copy', 'LOCAL_COPY', value => { value.trace.isolation.localSkillInventory.push({ path: '/tmp/renamed/skills', sha256: value.oracle.target.bodySha256 }); }],
  ['name-guessed-read', 'NAME_GUESSING', value => { value.trace.reads[0].discovered = false; }],
  ['wrong-reference', 'READ_MISSING', value => { value.trace.reads[0].ref += '-wrong'; }],
  ['wrong-content-hash', 'CONTENT_MISMATCH', value => { value.trace.reads[0].content += ' changed'; }],
  ['wrong-scope', 'IDENTITY_MISMATCH', value => { value.trace.reads[0].scope = 'other-account'; }],
  ['wrong-snapshot', 'IDENTITY_MISMATCH', value => { value.trace.reads[0].snapshot = 'current'; }],
  ['forced-tool-arguments', 'FORCED_LEAF', value => { value.trace.forcedToolArguments = true; }],
  ['leaf-changed-to-required', 'FORCED_LEAF', value => { value.trace.requiredRefs.push(value.oracle.target.ref); }],
  ['http200-permission-message', 'MODEL_PERMISSION', value => { value.trace.model.final.text = 'Insufficient permissions. Please upgrade.'; }],
  ['http200-without-final', 'MODEL_FINAL', value => { value.trace.model.final = null; }],
  ['partial-body', 'INCOMPLETE_CONTENT', value => { value.trace.reads[0].complete = false; }],
  ['missing-resource', 'READ_MISSING', value => { value.trace.reads.pop(); }],
  ['oracle-in-provider', 'FORCED_LEAF', value => { value.trace.providerRequests[0].contents = value.trace.providerRequests[1].contents; }],
  ['oracle-under-wrong-provider-label', 'FORCED_LEAF', value => { value.trace.providerRequests[0].contents = [{ ref: 'root-label', content: value.trace.reads[0].content }]; }],
  ['missing-provider-bytes', 'PROVIDER_CONTENT', value => { value.trace.providerRequests[1].contents = []; }],
  ['duplicate-provider-body', 'DUPLICATE_BODY', value => { value.trace.providerRequests[1].contents.push(value.trace.providerRequests[1].contents[0]); }],
  ['false-cold-cache', 'ORACLE_WARMING', value => { value.trace.isolation.prelaunch[0].entries = 1; }],
  ['false-cold-network', 'FALSE_COLD', value => { value.trace.httpAttempts[0].kind = 'metadata'; }],
  ['official-cli-transport', 'LEGACY_TRANSPORT', value => { value.trace.httpAttempts[0].transport = 'subprocess'; }],
  ['missing-http-ledger', 'HTTP_LEDGER', value => { value.trace.httpLedgerObserved = false; }],
  ['invented-request-id', 'HTTP_METADATA', value => { value.trace.httpAttempts[0].requestIdAvailable = false; }],
  ['missing-process-close', 'PROCESS_EVIDENCE', value => { value.trace.processes[0].closeObserved = false; }],
  ['replayed-unknown-write', 'UNKNOWN_WRITE', value => { value.trace.replayedUnknownWrites = true; }],
  ['unapproved-model', 'MODEL_SELECTOR', value => { value.trace.model.selector = 'another/model'; }],
  ['fallback-without-failure', 'MODEL_FALLBACK', value => { value.trace.model.selector = 'magpie/group/worker'; }],
  ['controlled-as-real', 'PROOF_LAYER', value => { value.trace.evidenceKind = 'controlled'; }],
  ['empty-trace', 'CATALOG_MISSING', value => { value.trace.candidates = []; value.trace.reads = []; }],
  ['gate-a-via-ordinary-skill', 'GATE_BRIDGE', value => { value.trace.reads.push({ ref: value.oracle.roots.B.ref }); }],
  ['ordinary-root-becomes-router', 'ROOT_KIND', value => { value.trace.gate = 'B'; value.oracle.roots.B.kind = 'router'; }],
  ['prompt-leaks-target', 'PROMPT_CHANGED', value => { value.trace.prompt.text += ' create-verification-skill'; }],
];

export function selfTest() {
  const cases = [];
  for (const gate of ['A', 'B']) {
    const fixture = contractFixture(gate);
    assert.equal(evaluateGraphTrace(fixture.trace, fixture.oracle).status, 'contract-valid');
    cases.push({ id: 'valid-controlled-contract-' + gate, status: 'passed', evidenceKind: 'controlled', productAcceptance: 'not-inferred' });
  }
  for (const [id, expectedCode, mutate] of NEGATIVE_CASES) {
    const fixture = contractFixture(); mutate(fixture);
    let actualCode;
    try { evaluateGraphTrace(fixture.trace, fixture.oracle); } catch (error) { actualCode = error.code; }
    assert.equal(actualCode, expectedCode, id + ' must reject the intended false positive');
    cases.push({ id, status: 'passed', rejectedWith: actualCode, evidenceKind: 'controlled' });
  }
  assert.ok(cases.length > 0);
  return { version: CONTRACT_VERSION, status: 'passed', tests: cases.length, cases, proofBoundary: 'Only the offline evidence contract was tested. No Notion, Pi, model, UI or installed product acceptance ran.' };
}

async function command(file, args, cwd, env) {
  const startedAt = new Date().toISOString();
  return await new Promise((done, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 15000);
    child.stdout.on('data', value => out.push(value)); child.stderr.on('data', value => err.push(value));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer); const stdout = Buffer.concat(out), stderr = Buffer.concat(err);
      done({ file, args, cwd, pid: child.pid, startedAt, endedAt: new Date().toISOString(), exitCode, signal, timedOut, stdout: stdout.toString('utf8'), stdoutBytes: stdout.length, stdoutSha256: sha(stdout), stderr: { bytes: stderr.length, sha256: sha(stderr), rawRetained: false }, spawnObserved: true, closeObserved: true });
    });
  });
}

export async function baseline(options) {
  for (const key of ['cli', 'cli-root', 'evidence-root']) check(isAbsolute(options[key] ?? ''), 'ARGUMENT', key + ' must be absolute');
  const cli = await realpath(options.cli), cliRoot = await realpath(options['cli-root']);
  await mkdir(options['evidence-root'], { recursive: true, mode: 0o700 });
  const evidenceRoot = await realpath(options['evidence-root']);
  check(disjoint(evidenceRoot, cliRoot) && disjoint(evidenceRoot, brokerRoot), 'EVIDENCE_LOCATION', 'Keep evidence outside both checkouts');
  const evidence = await mkdtemp(join(evidenceRoot, 'skill-graph-ng01-'));
  const scratch = await mkdtemp(join(await systemTempRoot(), 'skill-graph-ng01-'));
  const runId = randomUUID();
  await save(join(scratch, 'ownership.json'), { runId, evidence, purpose: 'offline-skill-graph-baseline' });
  const run = { version: CONTRACT_VERSION, runId, createdAt: new Date().toISOString(), evidence, scratch, cli, cliRoot, brokerRoot, nodeVersion: process.version, cliSha256: sha(await readFile(cli)), runnerSha256: sha(await readFile(fileURLToPath(import.meta.url))), boundary: 'Offline public CLI schema only. No network, model, production write, credential copy or official ntn subprocess.' };
  await save(join(evidence, 'run.json'), run);
  const artifacts = [];
  const record = async (name, value) => { await save(join(evidence, name), value); artifacts.push({ path: name, sha256: sha(await readFile(join(evidence, name))) }); };
  const env = verificationCliEnvironment(join(scratch, 'cli'), { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(scratch, 'home'), TMPDIR: scratch });
  await mkdir(env.HOME, { recursive: true, mode: 0o700 });
  await record('environment.json', { inheritedCredentials: false, environmentKeys: Object.keys(env).sort(), roots: Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'PATH')), scratchPurpose: 'offline-schema-only', persistentSchedulerTouched: false });
  await record('prompts.json', { boundary: 'Frozen task and root-only invocation. The real runner must bind these selections to observed native root identities; this baseline does not claim discovery.', A: frozenPrompt('A', options['router-selection'] ?? '$pstack@notion'), B: frozenPrompt('B', options['ordinary-selection'] ?? '$poteto-mode@notion') });
  let result;
  try {
    await record('contract-tests.json', selfTest());
    const version = await command(process.execPath, [cli, '--version'], scratch, env); await record('cli-version.json', version);
    const prepare = await command(process.execPath, [cli, 'schema', 'prepare'], scratch, env); await record('cli-prepare-schema.json', prepare);
    const update = await command(process.execPath, [cli, 'schema', 'update'], scratch, env); await record('cli-update-schema.json', update);
    const head = await command('git', ['-C', cliRoot, 'rev-parse', 'HEAD'], scratch, env); await record('cli-head.json', head);
    const committed = await command('git', ['-C', cliRoot, 'show', 'HEAD:packages/core/src/notion.ts'], scratch, env);
    await record('request-engine-committed-baseline.json', { commit: head.stdout.trim(), source: 'HEAD:packages/core/src/notion.ts', exitCode: committed.exitCode, sourceSha256: committed.stdoutSha256, legacyMarkers: committed.stdout.split('\n').flatMap((line, index) => /NTN_SKILLS_NTN_BIN|ntn-keychain/.test(line) ? [{ line: index + 1, marker: line.match(/NTN_SKILLS_NTN_BIN|ntn-keychain/)?.[0] }] : []), interpretation: 'Historical committed source only. Concurrent working-tree implementation is recorded separately.' });
    const transportPath = join(cliRoot, 'packages/core/src/notion.ts');
    const transport = await readFile(transportPath, 'utf8');
    const residuals = transport.split('\n').flatMap((line, index) => /NTN_SKILLS_NTN_BIN|ntn-keychain|parseNtn|Command\.make\(.*ntn/.test(line) ? [{ line: index + 1, marker: line.match(/NTN_SKILLS_NTN_BIN|ntn-keychain|parseNtn|Command\.make/)?.[0] }] : []);
    await record('request-engine-baseline.json', { source: transportPath, sha256: sha(transport), legacyMarkers: residuals, interpretation: residuals.length ? 'legacy-transport-present' : 'no-known-marker-observed; source scanning does not prove direct transport' });
    let updateSchema;
    try { updateSchema = JSON.parse(update.stdout); } catch { updateSchema = null; }
    check(version.exitCode === 0 && !version.timedOut && nonempty(version.stdout), 'CLI_BASELINE_FAILED', 'The actual CLI must report its version before interpreting feature absence');
    check(update.exitCode === 0 && updateSchema?.ok === true && Array.isArray(updateSchema.schema?.parameters), 'CLI_BASELINE_FAILED', 'The actual update schema must be usable before interpreting missing Requires');
    let prepareSchema;
    try { prepareSchema = JSON.parse(prepare.stdout); } catch { prepareSchema = null; }
    const prepareAbsent = prepare.exitCode === 2 && prepareSchema?.error?.code === 'INVALID_ARGUMENT' && JSON.stringify(prepareSchema.error.details?.command) === '["prepare"]';
    check(prepareAbsent || (prepare.exitCode === 0 && prepareSchema?.ok === true), 'CLI_BASELINE_FAILED', 'Unexpected CLI failure is not evidence of an unimplemented prepare command');
    const requires = updateSchema?.schema?.parameters?.some(row => ['require', 'requires', 'clear-requires'].includes(row.name)) ?? false;
    result = { version: CONTRACT_VERSION, runId, status: 'baseline-recorded', productAcceptance: 'not-inferred', checks: [{ feature: 'NG-RE-02', status: residuals.length ? 'fail-before' : 'unverified', evidence: 'request-engine-baseline.json' }, { feature: 'NG-SG-06', status: requires ? 'schema-present-unverified' : 'fail-before', evidence: 'cli-update-schema.json' }, { feature: 'NG-SG-12', status: prepareAbsent ? 'fail-before' : 'schema-present-unverified', evidence: 'cli-prepare-schema.json' }, { feature: 'NG-SG-11', status: 'not-run', reason: 'No real Router model trace was executed.' }, { feature: 'NG-SG-14', status: 'not-run', reason: 'No real ordinary-Skill model trace was executed.' }], columns: Object.fromEntries(EVIDENCE_COLUMNS.map(column => [column, column === 'controlled' ? 'offline-contract-only' : 'not-run'])), artifacts };
  } catch (error) {
    result = { version: CONTRACT_VERSION, runId, status: 'failed', productAcceptance: 'not-inferred', error: { code: error.code ?? 'RUN_FAILED', message: error.message }, artifacts };
  }
  await save(join(evidence, 'result.json'), result);
  return { ...result, evidence, scratch };
}

export async function evidenceStatus(evidence) {
  check(isAbsolute(evidence ?? ''), 'ARGUMENT', 'Evidence directory must be absolute');
  const run = await json(join(evidence, 'run.json')), result = await json(join(evidence, 'result.json'));
  check(run.evidence === await realpath(evidence) && result.runId === run.runId, 'OWNERSHIP', 'Evidence identity mismatch');
  for (const item of result.artifacts) {
    check(!isAbsolute(item.path) && !item.path.split('/').includes('..'), 'ARTIFACT_PATH', 'Artifact paths must remain within this run');
    check(sha(await readFile(join(evidence, item.path))) === item.sha256, 'ARTIFACT_CHANGED', 'An original artifact was changed');
  }
  return { status: 'preserved', functionalStatus: result.status, productAcceptance: result.productAcceptance, runId: run.runId, artifacts: result.artifacts.length, evidence };
}

async function cleanup(evidence) {
  const retained = await evidenceStatus(evidence), run = await json(join(evidence, 'run.json'));
  const previous = join(evidence, 'cleanup.json');
  if (await access(previous).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) return { ...(await json(previous)), evidence: retained };
  const owner = await json(join(run.scratch, 'ownership.json'));
  check(owner.runId === run.runId && owner.evidence === evidence && owner.purpose === 'offline-skill-graph-baseline', 'OWNERSHIP', 'Only the owned offline scratch can be cleaned');
  check(disjoint(run.scratch, evidence), 'OWNERSHIP', 'Scratch cannot contain evidence');
  check(process.platform === 'darwin', 'TRASH_UNAVAILABLE', 'Retain scratch until a verified system Trash is available');
  const receipt = await command('/usr/bin/trash', [run.scratch], brokerRoot, process.env);
  check(receipt.exitCode === 0 && !receipt.timedOut, 'CLEANUP_FAILED', 'System Trash did not complete; keep the evidence');
  const value = { status: 'scratch-retired', runId: run.runId, scratch: run.scratch, receipt, remoteWrites: 0, evidenceRetained: true };
  await save(previous, value);
  return { ...value, evidence: await evidenceStatus(evidence) };
}

async function main(args) {
  if (!args.length || args.includes('--help')) return { usage: ['node scripts/verify-skill-graph-contract.mjs self-test', 'node scripts/verify-skill-graph-contract.mjs doctor --cli ABSOLUTE_CLI', 'node scripts/verify-skill-graph-contract.mjs baseline --cli ABSOLUTE_CLI --cli-root ABSOLUTE_CHECKOUT --evidence-root ABSOLUTE_OUTSIDE_CHECKOUT [--router-selection $ROOT --ordinary-selection $ROOT]', 'node scripts/verify-skill-graph-contract.mjs evaluate --trace ABSOLUTE_TRACE --oracle ABSOLUTE_PRIVATE_ORACLE', 'node scripts/verify-skill-graph-contract.mjs evidence|cleanup --evidence ABSOLUTE_RUN'], boundary: 'No live model or production mutations. contract-valid is not product acceptance.' };
  const action = args.shift(), options = {};
  while (args.length) { const flag = args.shift(); check(/^--[a-z-]+$/.test(flag) && args.length && options[flag.slice(2)] === undefined, 'ARGUMENT', 'Invalid or duplicate option'); options[flag.slice(2)] = args.shift(); }
  const allowed = { 'self-test': [], doctor: ['cli'], baseline: ['cli', 'cli-root', 'evidence-root', 'router-selection', 'ordinary-selection'], evaluate: ['trace', 'oracle'], evidence: ['evidence'], cleanup: ['evidence'] };
  check(allowed[action] && Object.keys(options).every(key => allowed[action].includes(key)), 'ARGUMENT', 'Unknown action or option');
  if (action === 'self-test') return selfTest();
  if (action === 'doctor') {
    check(isAbsolute(options.cli ?? ''), 'ARGUMENT', 'CLI path must be absolute');
    const cli = await realpath(options.cli);
    return { status: 'ready', version: CONTRACT_VERSION, nodeVersion: process.version, cli, cliSha256: sha(await readFile(cli)), source: 'offline-artifact-read', credentialsProbed: false, networkCalls: 0, productAcceptance: 'not-inferred' };
  }
  if (action === 'baseline') return baseline(options);
  if (action === 'evaluate') {
    check(isAbsolute(options.trace ?? '') && isAbsolute(options.oracle ?? ''), 'ARGUMENT', 'Trace and oracle must be absolute');
    check(await realpath(options.trace) !== await realpath(options.oracle), 'ORACLE_WARMING', 'Trace and private oracle must be separate files');
    return evaluateGraphTrace(await json(options.trace), await json(options.oracle));
  }
  if (action === 'evidence') return evidenceStatus(options.evidence);
  return cleanup(options.evidence);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await main(process.argv.slice(2)); console.log(JSON.stringify(result, null, 2)); if (result.status === 'failed') process.exitCode = 1; }
  catch (error) { console.error(JSON.stringify({ status: 'failed', code: error.code ?? 'RUN_FAILED', message: error.message })); process.exitCode = 1; }
}
