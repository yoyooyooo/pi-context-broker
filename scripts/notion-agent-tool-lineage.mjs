import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, resolve } from 'node:path';
import { parseNativeReference, nativeFileRef, hasExactNativeOwner } from '../packages/context-broker/src/native-reference.ts';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const statusOf = diagnostics => diagnostics.some(item => item.status === 'failed') ? 'failed'
  : diagnostics.length ? 'blocked' : 'passed';

// Reviewed Pi 1.6.0 bundled Node entry, argument validator, codemode executor,
// and its separate QuickJS worker. Keep these actual loaded bytes separate
// from the package's unbundled source and from a tool's familiar name.
export const reviewedPiToolRuntimeProfile = Object.freeze({
  id: 'pi:1.6.0:bundled-node:tool-validation-and-quickjs',
  files: Object.freeze({
    'package.json': { bytes: 3969, sha256: 'ea92c5541390fa391ed7157f153a44e931b4aef52f811ebf25cfb0bbafcdb9bb' },
    'dist/bundle/cli.js': { bytes: 160, sha256: 'e79626f2dd6f94aa45d30f3fa63cd84319a6eefcd150b353cfaf274366926774' },
    'dist/bundle/cli-runtime.js': { bytes: 1120, sha256: 'f21d61c909b0398f3b153f68044d7e6125bc9eea73bb26128e16f7b77245667b' },
    'dist/bundle/chunks/chunk-KSDI5FD4.js': { bytes: 2623685, sha256: '5558c943edf1c00ca788788bc6b041d6a70a50ae7e646be2192ad399f1df7e34' },
    'dist/bundle/chunks/chunk-P5VHIEWH.js': { bytes: 1373536, sha256: '26d7d1663219cb5055cb04f70aad06bd876046ecc95a9bf7566d3c9b8e022c50' },
    'dist/bundle/chunks/chunk-36QC74V4.js': { bytes: 30071, sha256: '9d0bfdc1eaca5abb8f1796fdb9b256e981f7d429e99ce3aa3b9492fca7d1b5d0' },
    'dist/bundle/chunks/chunk-XGGZYFNG.js': { bytes: 40908, sha256: 'e79117ae45c426c03f79c5a7495e9b6b09341d50cf8743835d021442491939a8' },
    'dist/bundle/chunks/chunk-NRY4NBZW.js': { bytes: 44464, sha256: '490b194b9ccbe02fe8fedbc542abe24d90f8da124c97a72ef21dd621719d7a32' },
    'dist/bundle/chunks/execute-XDNPBEMU.js': { bytes: 51162, sha256: 'afb817ee9afffab0244b25fdda42e33d920591d589a1d146300bd8c0e300ae3e' },
    'dist/bundle/chunks/codemode-worker.js': { bytes: 78709, sha256: 'e68f1da328891a985d6fbf6db72094688b4d8d0a1ea732e39a84a03e326b357a' },
    'node_modules/quickjs-wasi/quickjs.wasm': { bytes: 637405, sha256: 'd4c9375f2b1ca4dc95f72c8aa2982a7a9951ac8011490d79c6582df732b4bbd9' },
  }),
});

export function inspectedPiToolRuntime(runtime) {
  if (runtime?.version !== 1 || !isAbsolute(runtime.packageRoot ?? '')
    || runtime.entry !== resolve(runtime.packageRoot, 'dist/bundle/cli.js')
    || !Array.isArray(runtime.files)
    || runtime.files.length !== Object.keys(reviewedPiToolRuntimeProfile.files).length) return undefined;
  const seen = new Set();
  for (const file of runtime.files) {
    if (!object(file)) return undefined;
    const expected = reviewedPiToolRuntimeProfile.files[file.relativePath];
    if (!expected || seen.has(file.relativePath) || file.path !== resolve(runtime.packageRoot, file.relativePath)
      || file.artifact?.bytes !== expected.bytes || file.artifact.sha256 !== expected.sha256) return undefined;
    seen.add(file.relativePath);
  }
  return { profile: reviewedPiToolRuntimeProfile.id, packageRoot: runtime.packageRoot, entry: runtime.entry, files: runtime.files };
}

/** Verify sealed implementation and execution-schema bytes before the pure
 * correlator may use them. Missing/unreviewed implementations confer nothing.
 * Artifacts are cached within this read, not trusted because their names match. */
export async function verifyObservedPiToolRuntime(tasks, readArtifact) {
  const evidence = new Map(), checked = new Map();
  const read = async artifact => {
    if (!object(artifact) || !isAbsolute(artifact.path ?? '') || !digest(artifact.sha256)
      || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || typeof readArtifact !== 'function')
      throw Object.assign(new Error('Retain the actual Pi runtime and tool-schema artifacts'), { code: 'PI_TOOL_RUNTIME_ARTIFACT_MISSING' });
    const key = JSON.stringify([artifact.path, artifact.sha256, artifact.bytes]);
    if (!checked.has(key)) checked.set(key, (async () => {
      const bytes = await readArtifact(artifact.path);
      if (!(bytes instanceof Uint8Array) || bytes.length !== artifact.bytes || sha(bytes) !== artifact.sha256)
        throw Object.assign(new Error('A sealed Pi runtime or tool-schema artifact changed'), { code: 'PI_TOOL_RUNTIME_ARTIFACT_CHANGED' });
      return bytes;
    })());
    return checked.get(key);
  };
  for (const event of tasks ?? []) {
    if (event.phase !== 'tool_call') continue;
    const implementation = inspectedPiToolRuntime(event.toolRuntime);
    if (!implementation || !Number.isSafeInteger(event.pid) || event.pid <= 0) continue;
    for (const file of implementation.files) await read(file.artifact);
    const item = { implementation, toolCallId: event.toolCallId, toolName: event.toolName,
      pid: event.pid, inputSha256: event.inputSha256 };
    if (event.toolParametersArtifact) {
      const bytes = await read(event.toolParametersArtifact);
      item.parameters = JSON.parse(Buffer.from(bytes).toString('utf8'));
      item.parametersArtifact = event.toolParametersArtifact;
    }
    if (event.toolName === 'codemode') {
      const result = tasks.find(row => row.phase === 'tool_result' && row.toolCallId === event.toolCallId);
      if (result?.contentArtifact) item.resultContentSha256 = sha(await read(result.contentArtifact));
    }
    evidence.set(event.toolCallId, item);
  }
  return evidence;
}

function runtimeForCall(event, evidence) {
  const implementation = inspectedPiToolRuntime(event.toolRuntime);
  if (!implementation || !evidence || !isDeepStrictEqual(evidence.implementation, implementation)
    || evidence.toolCallId !== event.toolCallId || evidence.toolName !== event.toolName
    || evidence.pid !== event.pid || evidence.inputSha256 !== event.inputSha256) return undefined;
  return evidence;
}

// This is deliberately only the observed optional-null rule, not a second
// implementation of Pi's full coercer. Nullable/required/ref properties,
// undeclared keys, nested conversions and every non-null change stay exact.
function optionalNullInput(input, parameters) {
  if (!object(input) || !object(parameters) || parameters.type !== 'object' || !object(parameters.properties)
    || parameters.$ref !== undefined || parameters.patternProperties !== undefined
    || ['allOf', 'anyOf', 'oneOf'].some(key => parameters[key] !== undefined)
    || parameters.required !== undefined && (!Array.isArray(parameters.required)
      || parameters.required.some(key => typeof key !== 'string'))
    || Object.keys(input).some(key => !Object.hasOwn(parameters.properties, key))) return undefined;
  const required = new Set(parameters.required ?? []), omitted = [], next = { ...input };
  const rejectsNull = schema => {
    if (schema === false) return true;
    if (!object(schema) || schema.$ref !== undefined) return false;
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    return types.length > 0 && types.every(type => ['string', 'number', 'integer', 'boolean', 'array', 'object'].includes(type))
      || Object.hasOwn(schema, 'const') && schema.const !== null
      || Array.isArray(schema.enum) && !schema.enum.includes(null);
  };
  for (const [key, value] of Object.entries(input)) {
    if (value === null && !required.has(key) && rejectsNull(parameters.properties[key])) {
      delete next[key]; omitted.push(key);
    }
  }
  return omitted.length ? { input: next, omitted } : undefined;
}

// Reviewed 0.1.3 read execution: the registered delegate forwards the unchanged
// arguments to the running Pi API's createReadTool(cwd). This says nothing about
// this package's other tools, UI hooks or background traffic.
const compactReadProfile = Object.freeze({ id: 'pi-compact-ui:0.1.3:native-read-delegate', files: {
  'package.json': { bytes: 567, sha256: 'a5f319f04fcc0ddeb47c0da5bdd08240598404f96b38dc1fe1baaaab14428f98' },
  'index.ts': { bytes: 66369, sha256: 'bac76ae9ed99a3790d8a728cc6e9b5463927ac427a1462ffe59c6adf9e4d4509' },
} });
export function inspectedCompactReadImplementation(event) {
  const source = event?.toolSource, implementation = event?.toolImplementation;
  if (event?.toolName !== 'read' || source?.origin !== 'package' || source.scope !== 'user'
    || source.source !== 'npm:pi-compact-ui' || !isAbsolute(source.baseDir ?? '')
    || source.path !== resolve(source.baseDir, 'index.ts') || implementation?.version !== 1
    || !Array.isArray(implementation.files) || implementation.files.length !== 2) return undefined;
  const seen = new Set();
  for (const file of implementation.files) {
    const expected = compactReadProfile.files[file.relativePath];
    if (!expected || seen.has(file.relativePath) || file.path !== resolve(source.baseDir, file.relativePath)
      || file.artifact?.sha256 !== expected.sha256 || file.artifact.bytes !== expected.bytes) return undefined;
    seen.add(file.relativePath);
  }
  return { profile: compactReadProfile.id, files: implementation.files, source };
}

// The analyzer verifies the two implementation artifacts and these content
// bytes before calling this pure lineage guard. A local read never borrows a
// Notion owner, and cannot authorize an unproved short-ref/input rewrite.
export function inspectedLocalReadEvidence(call, content) {
  const event = call?.event, result = call?.result, input = call?.arguments;
  const reader = inspectedCompactReadImplementation(event);
  if (!reader || call.name !== 'read' || call.preparedRead
    || !['native-tool-call', 'native-nested-summary'].includes(call.provenance?.kind)
    || call.native?.name !== 'read' || call.native.isError !== false
    || !object(input) || typeof input.path !== 'string' || !isAbsolute(input.path) || input.path.includes('\0')
    || !Object.keys(input).every(key => ['path', 'offset', 'limit'].includes(key))
    || ['offset', 'limit'].some(key => input[key] !== undefined
      && (!Number.isSafeInteger(input[key]) || input[key] <= 0))
    || event.toolCallId !== call.id || result?.toolCallId !== call.id || result.toolName !== 'read'
    || result.isError !== false || event.inputSha256 !== sha(JSON.stringify(input))
    || result.inputSha256 !== event.inputSha256
    || !Number.isSafeInteger(event.pid) || event.pid <= 0 || result.pid !== event.pid
    || !Number.isSafeInteger(event.turn) || event.turn <= 0 || result.turn !== event.turn
    || !Number.isSafeInteger(event.sequence) || event.sequence <= 0
    || !Number.isSafeInteger(result.sequence) || result.sequence <= event.sequence
    || event.parentToolCallId !== result.parentToolCallId
    || event.parentToolCallId !== call.parentToolCallId
    || !(content instanceof Uint8Array) || result.content?.bytes !== content.length
    || result.content.sha256 !== sha(content)
    || result.contentArtifact?.bytes !== content.length || result.contentArtifact.sha256 !== sha(content)) return undefined;
  return { profile: reader.profile, path: input.path, inputSha256: event.inputSha256,
    ...(input.offset === undefined ? {} : { offset: input.offset }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    content: { bytes: content.length, sha256: sha(content) } };
}

function preparedReadTransition(call, tasks, session, evidence) {
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  const observations = tasks.filter(row => row.phase === 'prepared_read' && row.toolCallId === call.id);
  const observation = observations[0], event = call.event, result = call.result;
  require(evidence && observations.length === 1 && evidence.observation === observation && observation.version === 1,
    'Missing unique verified prepared-read observation');
  const original = call.arguments, short = /^sr:[CSR][A-Za-z0-9_-]{22}$/u.test(original?.path ?? '');
  const canonical = !short && typeof original?.path === 'string' ? parseNativeReference(original.path) : undefined;
  const resource = short ? original.path.startsWith('sr:R') : canonical?.path !== 'SKILL.md';
  require(call.provenance.kind === 'native-tool-call' && call.name === 'read' && result.isError === false
    && object(original) && Object.keys(original).every(key => ['path', 'refresh'].includes(key))
    && (short || canonical?.path && /^s_[a-f0-9]{64}$/u.test(canonical.snapshot ?? ''))
    && (original.refresh === undefined || typeof original.refresh === 'boolean') && !(resource && original.refresh === true),
  'Only a completed top-level whole-file registered short or fixed File read has a reviewed rewrite');
  const reader = inspectedCompactReadImplementation(event);
  require(reader && evidence.brokerOwner?.source && observation.brokerSource
    && ['path', 'source', 'scope', 'origin', 'baseDir'].every(key => observation.brokerSource[key] === evidence.brokerOwner.source[key]),
  'The actual read delegate and current frozen Broker owner are required');
  const receipt = tasks.find(row => row.phase === 'receipt' && row.sequence === observation.receiptSequence);
  const native = session.branchEntries.find(entry => entry.id === call.native.resultEntryId)?.message;
  const proofKey = resource ? 'contextBrokerResource' : 'contextBrokerRead', proof = native?.details?.[proofKey];
  require(receipt?.toolCallId === call.id && receipt.toolName === 'read' && proof?.version === (resource ? 2 : 3)
    && proof.toolCallId === call.id && isDeepStrictEqual(receipt.proofs?.[proofKey], proof),
  'The receipt must be the same actual native result');
  const at = row => tasks.indexOf(row), nextPayload = tasks.find((row, index) => index > at(result) && row.phase === 'provider_payload');
  require(Number.isSafeInteger(event.turn) && event.turn > 0 && Number.isSafeInteger(event.pid) && event.pid > 0
    && Number.isSafeInteger(observation.receiptSequence) && observation.receiptSequence > 0
    && event.turn === result.turn && result.turn === receipt.turn && receipt.turn === observation.turn
    && event.pid === result.pid && result.pid === receipt.pid && receipt.pid === observation.pid
    && at(result) < at(receipt) && at(receipt) < at(observation) && nextPayload && at(observation) < at(nextPayload),
  'A late, cross-turn, cross-process or cross-call receipt cannot justify a rewrite');
  const callIndex = session.branchEntries.findIndex(entry => entry.id === call.native.assistantEntryId);
  require(callIndex >= 0, 'The call needs its actual native branch position');
  const prior = session.branchEntries.slice(0, callIndex);
  const targetFor = ref => {
    const refs = prior.filter(entry => entry.type === 'custom' && entry.customType === 'context-broker-short-ref' && entry.data?.ref === ref);
    require(refs.length === 1 && refs[0].data.version === 1, 'The exact short reference must be unique and precede this native call');
    return refs[0].data.target;
  };
  const registered = short ? original.path : (() => {
    const refs = prior.filter(entry => entry.type === 'custom' && entry.customType === 'context-broker-short-ref'
      && entry.data?.target?.ref === original.path);
    require(refs.length === 1 && refs[0].data.version === 1,
      'The complete fixed File reference must have one exact prior native registration');
    return refs[0].data.ref;
  })();
  require(new RegExp('^sr:' + (resource ? 'R' : canonical ? 'S' : '[CS]') + '[A-Za-z0-9_-]{22}$', 'u').test(registered ?? ''),
    'The prior registration must retain its selected or resource short-reference kind');
  const target = targetFor(registered);
  require(target?.kind === (resource ? 'resource' : registered.startsWith('sr:S') ? 'selected' : 'candidate')
    && (!canonical || target.ref === original.path), 'The original reference must retain its registered kind and exact fixed target');
  if (resource) require(/^sr:S[A-Za-z0-9_-]{22}$/u.test(target.owner ?? ''), 'A resource needs its selected owner reference');
  const ownerTarget = resource ? targetFor(target.owner) : target, identity = ownerTarget?.identity;
  require(identity?.source === 'notion' && digest(identity.scope) && nonempty(identity.id) && identity.kind === 'skill'
    && object(identity.locator) && identity.ref === identity.id && hasExactNativeOwner(parseNativeReference(identity.id)),
  'The prior native branch must bind the exact Notion owner and scope');
  const fixed = (ref, path, snapshot) => {
    const parsed = parseNativeReference(ref);
    return parsed.selector === identity.id && parsed.path === path && parsed.snapshot === snapshot;
  };
  if (ownerTarget.kind === 'selected') require(/^s_[a-f0-9]{64}$/u.test(ownerTarget.snapshot_id ?? '')
    && digest(ownerTarget.version_id) && digest(ownerTarget.body_sha256) && ownerTarget.entrypoint === 'SKILL.md'
    && fixed(ownerTarget.ref, 'SKILL.md', ownerTarget.snapshot_id),
  'The selected owner must retain its complete fixed main-File binding');
  if (canonical) require(fixed(original.path, resource ? target.path : 'SKILL.md', ownerTarget.snapshot_id), 'The original complete reference must bind the prior fixed File before any explicit inspection');
  const binding = resource ? undefined : proof.binding, record = binding?.record;
  const scope = resource ? proof.scope : binding?.scope, owner = resource ? proof.id : record?.id;
  const snapshot = resource ? proof.snapshot_id : binding?.snapshot_id, version = resource ? proof.version_id : binding?.version_id;
  const bodyHash = resource ? proof.sha256 : proof.bodySha256, relative = resource ? proof.path : 'SKILL.md';
  const fileId = resource ? proof.file_id : undefined;
  require(scope === identity.scope && owner === identity.id && /^s_[a-f0-9]{64}$/u.test(snapshot ?? '') && digest(version)
    && digest(bodyHash) && (fileId === undefined || nonempty(fileId)) && Number.isSafeInteger(proof.bytes) && proof.bytes >= (resource ? 0 : 1),
  'The receipt needs the complete immutable owner and File identity');
  if (resource) {
    require(ownerTarget.kind === 'selected' && snapshot === ownerTarget.snapshot_id && version === ownerTarget.version_id
      && target.path === relative && relative !== 'SKILL.md' && target.ref === proof.ref && target.file_id === fileId
      && target.bytes === proof.bytes && target.sha256 === bodyHash && fixed(proof.ref, relative, snapshot)
      && proof.loaded === false && proof.delivered_complete_text === true && !('files' in proof)
      && (proof.purpose === undefined || proof.purpose === 'inspect'),
    'The scalar receipt must match the prior resource-to-selected-owner binding, not a batch or another version');
  } else {
    require(record.kind === identity.kind && isDeepStrictEqual(record.locator, identity.locator) && record.entrypoint === 'SKILL.md'
      && record.ref === nativeFileRef(identity.ref, 'SKILL.md') && binding.body_sha256 === bodyHash && binding.snapshot_id === proof.snapshotId
      && fixed(binding.ref, 'SKILL.md', snapshot)
      && proof.identity === JSON.stringify(['notion', scope, 'skill', record.locator.type, owner])
      && proof.contentIdentity === JSON.stringify([scope, owner]), 'The main receipt must retain the original exact Notion owner');
    if (original.refresh === true) require(proof.purpose === 'inspect' && proof.readStatus?.purpose === 'inspect'
      && proof.readStatus.activation_effect === 'unchanged' && proof.readStatus.requires_acquisition === 'not_performed'
      && proof.readStatus.use_selection?.status === 'inspection_only', 'Explicit refresh must remain an inspection, without adopting a new task');
    else if (ownerTarget.kind === 'selected') require(snapshot === ownerTarget.snapshot_id && version === ownerTarget.version_id
      && bodyHash === ownerTarget.body_sha256 && binding.ref === ownerTarget.ref,
    'A fixed selected read cannot silently advance to another version');
  }
  const { input, manifest, body, content } = evidence, path = input?.path;
  const tail = projection => '/scopes/' + scope + '/records/' + sha(owner) + '/' + projection + '/' + snapshot + '/tree/' + relative;
  const resourceStorage = resource && typeof path === 'string' && path.endsWith(tail('resources'));
  require(object(input) && isDeepStrictEqual(input, { ...original, path }) && isAbsolute(path ?? '') && resolve(path) === path
    && (path.endsWith(tail('entries')) || resourceStorage)
    && observation.originalInputSha256 === event.inputSha256 && observation.preparedInputSha256 === result.inputSha256
    && sha(JSON.stringify(input)) === result.inputSha256 && observation.file?.path === path && observation.file.realpath === path,
  'The executed parameters must preserve every original flag and change only the exact immutable file path');
  if (resourceStorage) require(observation.projection === 'resource' && observation.manifest === undefined && manifest === undefined,
    'Independent resource storage must not invent an entry manifest');
  else {
    const manifestPath = path.slice(0, -('/tree/' + relative).length) + '/.broker-entry.json';
    require(object(manifest) && manifest.version === 1 && manifest.projection === 'entry' && manifest.manifest_complete === true
      && manifest.scope === scope && manifest.id === owner && manifest.snapshot_id === snapshot && manifest.version_id === version
      && manifest.entrypoint === 'SKILL.md' && manifest.ref === (resource ? ownerTarget.ref : binding.ref)
      && observation.manifest?.path === manifestPath && observation.manifest.realpath === manifestPath
      && Array.isArray(manifest.files) && manifest.files.length > 0 && Array.isArray(manifest.file_bindings)
      && manifest.files.length >= manifest.file_bindings.length, 'The complete entry manifest must retain this owner and snapshot');
    const paths = new Set(), ids = new Set(), pages = new Set();
    for (const file of manifest.files) {
      const bindings = manifest.file_bindings.filter(value => value.path === file.path), fileBinding = bindings[0];
      require(bindings.length <= 1 && nonempty(file.path) && !paths.has(file.path) && digest(file.sha256)
        && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && fixed(file.ref, file.path, snapshot),
      'Every manifest member needs its unique fixed path and content evidence');
      paths.add(file.path);
      if (fileBinding) {
        require(nonempty(fileBinding.file_id) && nonempty(fileBinding.page_id)
          && !ids.has(fileBinding.file_id) && !pages.has(fileBinding.page_id), 'Native File bindings must be unique');
        ids.add(fileBinding.file_id); pages.add(fileBinding.page_id);
      }
    }
    require(manifest.file_bindings.every(binding => paths.has(binding.path)), 'Native bindings cannot name an undeclared file');
    const mainBinding = manifest.file_bindings.find(value => value.path === 'SKILL.md');
    const file = manifest.files.find(value => value.path === relative), fileBinding = manifest.file_bindings.find(value => value.path === relative);
    require((mainBinding === undefined || mainBinding.page_id === identity.locator.page_id) && file?.bytes === proof.bytes && file.sha256 === bodyHash
      && file.ref === (resource ? proof.ref : binding.ref) && (!resource || fileBinding?.file_id === fileId),
    'The materialized file must retain its complete bytes and any native File binding');
    if (!resource && proof.directory !== undefined) require(isDeepStrictEqual(proof.directory.files, manifest.files),
      'The inspected complete directory cannot be replaced by a smaller materialization manifest');
  }
  const text = value => typeof value === 'string' ? value : Array.isArray(value) && value.every(part => part?.type === 'text')
    ? value.map(part => part.text).join('\n') : undefined;
  const bodyText = body.toString('utf8'), rendered = text(native.content), delivered = text(content);
  require(body.length === proof.bytes && sha(body) === bodyHash && Buffer.from(bodyText).equals(body)
    && typeof rendered === 'string' && rendered.startsWith(bodyText) && [bodyText, rendered].includes(delivered)
    && proof.delivery?.start === 0 && proof.delivery.end === bodyText.length && proof.delivery.encoding === 'raw'
    && (resource || proof.rendered?.sha256 === sha(rendered) && proof.rendered.bytes === Buffer.byteLength(rendered))
    && receipt.content?.sha256 === sha(rendered) && receipt.content.bytes === Buffer.byteLength(rendered),
  'The actual callback, immutable file and native receipt must deliver identical complete text');
  return { profile: reader.profile, originalRef: original.path, path, bodySha256: bodyHash,
    snapshotId: snapshot, owner, scope, receiptSequence: receipt.sequence,
    ...(resource ? { resourcePath: relative } : {}), ...(proof.purpose ? { purpose: proof.purpose } : {}),
    brokerCommit: evidence.brokerOwner.commit };
}

/**
 * Correlate actual tool callbacks with Pi's persisted native records.
 *
 * Pi 1.6's runtime-owned toolResult.nestedCalls is a complete root-call census,
 * including descendants. It is not the codemode UI's truncated args preview.
 * Immediate ancestry comes from actual parentToolCallId callbacks, or from the
 * codemode result's structured direct-call census. IDs are always opaque.
 *
 * The caller must validate the native session tree and callback stream first.
 * preparedReads contains only artifact bytes verified by the analyzer, plus
 * its independently verified current Broker owner. runtimeEvidence comes from
 * verifyObservedPiToolRuntime, with the actual registered execution schemas.
 * Raw receipt claims alone
 * cannot populate it or bypass the original argument and identity checks.
 * This function does not infer execution from proposals or from script text.
 */
export function correlateNotionAgentToolAttempts({ tasks, session, currentUserId = session?.currentUserId,
  preparedReads = new Map(), runtimeEvidence = new Map() }) {
  const diagnostics = [], attempts = [], containers = [], retractedProposals = [];
  const note = (code, message, details, status = 'blocked') => diagnostics.push({ status, code, message, ...(details ? { details } : {}) });
  if (!Array.isArray(tasks) || session?.supported !== true || !Array.isArray(session.attempts)
    || !Array.isArray(session.branchEntries) || !nonempty(currentUserId)) {
    note('NATIVE_TOOL_EVIDENCE_MISSING', 'Use the verified native branch and the actual current-turn callback stream');
    return { version: 1, status: 'blocked', complete: false, attempts, containers, retractedProposals, diagnostics, counts: null };
  }
  const native = session.attempts.filter(call => call.active && call.userEntryId === currentUserId);
  const nativeById = new Map(), roots = new Map(), declared = new Map(), directParents = new Map();
  const callEvents = new Map(), resultEvents = new Map(), positions = new Map();
  for (const [index, event] of tasks.entries()) {
    if (!['tool_call', 'tool_result'].includes(event.phase)) continue;
    if (!nonempty(event.toolCallId) || !nonempty(event.toolName)) {
      note('TOOL_IDENTITY_MISSING', 'An actual callback has no exact tool identity', { index }); continue;
    }
    const collection = event.phase === 'tool_call' ? callEvents : resultEvents;
    if (collection.has(event.toolCallId)) note('TOOL_CALLBACK_DUPLICATED', 'An actual callback was recorded twice',
      { toolCallId: event.toolCallId, phase: event.phase }, 'failed');
    else collection.set(event.toolCallId, event);
    positions.set(event, index);
  }
  for (const call of native) {
    if (!nonempty(call.id) || nativeById.has(call.id)) {
      note('NATIVE_TOOL_IDENTITY_DUPLICATED', 'The native turn repeats a tool identity', { toolCallId: call.id }, 'failed'); continue;
    }
    nativeById.set(call.id, call);
    const entry = session.branchEntries.find(entry => entry.id === call.resultEntryId);
    const message = entry?.type === 'message' ? entry.message : undefined;
    if (call.resultLine === undefined) {
      if (call.retractedLine !== undefined && !callEvents.has(call.id)) retractedProposals.push({
        ...call, dispatched: false, phase: 'proposed_retracted', deliveryToolCallId: null,
      });
      else note('NATIVE_TOOL_RESULT_MISSING', 'A non-retracted native proposal has no terminal result', { toolCallId: call.id });
      continue;
    }
    if (!message || message.role !== 'toolResult' || message.toolCallId !== call.id || message.toolName !== call.name) {
      note('NATIVE_TOOL_RESULT_MISSING', 'The native terminal result does not belong to its exact call', { toolCallId: call.id }); continue;
    }
    const root = { native: call, entry, message, members: [], direct: [], containerDiagnostics: [] };
    roots.set(call.id, root);
    const summary = message.nestedCalls;
    if (summary !== undefined) {
      if (!object(summary) || !Array.isArray(summary.calls) || summary.complete !== true) {
        note('NESTED_TOOL_SUMMARY_INCOMPLETE', 'Pi did not retain a complete nested-call census', { toolCallId: call.id });
      }
      if (Array.isArray(summary?.calls)) {
        for (const [index, child] of summary.calls.entries()) {
          const details = { toolCallId: child?.id, rootToolCallId: call.id, summaryIndex: index };
          if (!object(child) || !nonempty(child.id) || !nonempty(child.name)) {
            note('NESTED_TOOL_IDENTITY_MISSING', 'A nested native record has no exact identity', details); continue;
          }
          if (declared.has(child.id) || nativeById.has(child.id) || child.id === call.id) {
            note('NESTED_TOOL_IDENTITY_DUPLICATED', 'One nested identity belongs to multiple native records', details, 'failed'); continue;
          }
          if (!object(child.arguments) || child.argumentsBytes !== undefined)
            note('NESTED_TOOL_ARGUMENTS_MISSING', 'A nested record omitted its complete arguments', details);
          if (!['ok', 'error'].includes(child.status))
            note('NESTED_TOOL_RESULT_UNFINISHED', 'A nested call has no terminal native status', details);
          const declaration = { child, root, index, summarySha256: sha(JSON.stringify(summary)) };
          declared.set(child.id, declaration); root.members.push(child.id);
        }
      }
    }
    if (call.name === 'codemode') {
      const census = message.details?.calls;
      const problem = (code, text, details) => root.containerDiagnostics.push({ status: 'blocked', code, message: text, ...(details ? { details } : {}) });
      if (!Array.isArray(census)) problem('CODEMODE_DIRECT_CENSUS_MISSING', 'The codemode result omitted its structured direct-call census');
      else {
        const seen = new Set();
        for (const direct of census) {
          if (!object(direct) || !nonempty(direct.id) || !nonempty(direct.name) || seen.has(direct.id)) {
            problem('CODEMODE_DIRECT_CENSUS_INVALID', 'A codemode direct-call identity is invalid or duplicated'); continue;
          }
          seen.add(direct.id);
          const declaredChild = declared.get(direct.id);
          if (!declaredChild || declaredChild.root !== root || declaredChild.child.name !== direct.name) {
            problem('CODEMODE_UNOBSERVED_DIRECT_EFFECT', 'A codemode direct operation is outside the complete tool census',
              { toolCallId: direct.id, tool: direct.name }); continue;
          }
          if (!['ok', 'error', 'cancelled'].includes(direct.status)
            || (direct.status === 'ok') !== (declaredChild.child.status === 'ok'))
            problem('CODEMODE_DIRECT_STATUS_MISMATCH', 'The codemode direct call is not terminal or contradicts its native record', { toolCallId: direct.id });
          if (directParents.has(direct.id) && directParents.get(direct.id) !== call.id)
            note('NESTED_TOOL_PARENT_CONFLICT', 'Native results disagree about an immediate caller', { toolCallId: direct.id }, 'failed');
          directParents.set(direct.id, call.id); root.direct.push(direct.id);
        }
        root.directCensusSha256 = sha(JSON.stringify(census));
      }
    }
  }
  // Detect collisions with model-issued calls that occur after the root record.
  for (const [id] of declared) if (nativeById.has(id))
    note('NESTED_TOOL_IDENTITY_DUPLICATED', 'A nested identity also appears as a model-issued call', { toolCallId: id }, 'failed');

  for (const [id, event] of callEvents) {
    const nativeCall = nativeById.get(id), declaration = declared.get(id), result = resultEvents.get(id);
    const call = { id, name: event.toolName, selectors: event.selectors ?? {}, event, result, dispatched: true };
    attempts.push(call);
    if (nativeCall && roots.has(id)) {
      const root = roots.get(id);
      call.arguments = nativeCall.arguments; call.native = nativeCall;
      call.rootToolCallId = id; call.deliveryToolCallId = id;
      call.provenance = { kind: 'native-tool-call', callEntryId: nativeCall.assistantEntryId, resultEntryId: nativeCall.resultEntryId };
      if (event.parentToolCallId !== undefined || result?.parentToolCallId !== undefined)
        note('TOP_LEVEL_TOOL_PARENT_CONFLICT', 'A model-issued native call was observed as a nested call', { toolCallId: id }, 'failed');
      if ((root.message.isError === true) !== (nativeCall.isError === true))
        note('NATIVE_TOOL_STATUS_MISMATCH', 'The parsed native status differs from the retained result', { toolCallId: id }, 'failed');
    } else if (declaration) {
      const { child, root, index, summarySha256 } = declaration;
      call.arguments = child.arguments; call.rootToolCallId = root.native.id; call.deliveryToolCallId = root.native.id;
      call.provenance = { kind: 'native-nested-summary', rootToolCallId: root.native.id,
        resultEntryId: root.entry.id, resultLine: root.native.resultLine, summaryIndex: index, summarySha256 };
      call.native = { id: child.id, name: child.name, arguments: child.arguments, isError: child.status === 'error',
        userEntryId: currentUserId, active: true, assistantEntryId: root.native.assistantEntryId,
        resultEntryId: root.entry.id, resultLine: root.native.resultLine,
        syntheticFrom: 'native-nested-summary', rootToolCallId: root.native.id, summaryIndex: index };
      const callbackParent = event.parentToolCallId ?? result?.parentToolCallId, censusParent = directParents.get(id);
      if (event.parentToolCallId !== undefined || result?.parentToolCallId !== undefined) {
        if (!nonempty(event.parentToolCallId) || result?.parentToolCallId !== event.parentToolCallId)
          note('NESTED_TOOL_PARENT_CALLBACK_MISMATCH', 'Nested start and result do not retain the same explicit caller', { toolCallId: id }, 'failed');
      }
      if (callbackParent !== undefined && censusParent !== undefined && callbackParent !== censusParent)
        note('NESTED_TOOL_PARENT_CONFLICT', 'The callback caller contradicts the native direct-call census', { toolCallId: id }, 'failed');
      call.parentToolCallId = callbackParent ?? censusParent;
      if (!nonempty(call.parentToolCallId)) note('NESTED_TOOL_PARENT_UNOBSERVED',
        'The complete root census does not establish this immediate parent; retain parentToolCallId callbacks', { toolCallId: id });
      call.provenance.parentEvidence = callbackParent !== undefined ? 'actual-callbacks' : censusParent !== undefined ? 'native-codemode-direct-census' : 'unobserved';
    } else {
      note('NATIVE_TOOL_CORRELATION_MISSING', 'An actual callback has no record in the active native turn', { toolCallId: id }); continue;
    }
    if (call.native.name !== call.name)
      note('NATIVE_TOOL_NAME_MISMATCH', 'The actual and native tool names differ', { toolCallId: id }, 'failed');
    if (!object(call.arguments) || !digest(event.inputSha256)) note('TOOL_INPUT_HASH_MISSING', 'Complete native arguments and actual input hash are required', { toolCallId: id });
    else if (sha(JSON.stringify(call.arguments)) !== event.inputSha256) {
      const runtime = runtimeForCall(event, runtimeEvidence.get(id));
      const normalized = runtime && isDeepStrictEqual(runtime.parametersArtifact, event.toolParametersArtifact)
        ? optionalNullInput(call.arguments, runtime.parameters) : undefined;
      if (normalized && sha(JSON.stringify(normalized.input)) === event.inputSha256) {
        call.nativeArguments = call.arguments;
        call.arguments = normalized.input;
        call.inputNormalization = { profile: runtime.implementation.profile, rule: 'declared-optional-nonnullable-null',
          nativeInputSha256: sha(JSON.stringify(call.nativeArguments)), observedInputSha256: event.inputSha256,
          omittedProperties: normalized.omitted, parametersArtifact: runtime.parametersArtifact };
      } else note('TOOL_INPUT_HASH_MISMATCH', 'The observed input differs from the native arguments', { toolCallId: id }, 'failed');
    }
    for (const [key, value] of Object.entries(call.selectors)) if (!isDeepStrictEqual(value, call.arguments?.[key]))
      note('TOOL_SELECTOR_MISMATCH', 'The observed selector differs from the hash-bound arguments', { toolCallId: id, key }, 'failed');
    if (!result) note('TOOL_RESULT_UNOBSERVED', 'An actual tool start has no terminal callback', { toolCallId: id });
    else {
      if (result.toolName !== call.name || typeof result.isError !== 'boolean' || result.isError !== call.native.isError)
        note('TOOL_RESULT_STATUS_MISMATCH', 'The terminal callback contradicts its native result', { toolCallId: id }, 'failed');
      if (positions.get(result) <= positions.get(event))
        note('TOOL_RESULT_ORDER_INVALID', 'A result precedes its actual start', { toolCallId: id }, 'failed');
      if (result.inputSha256 !== undefined && result.inputSha256 !== event.inputSha256) {
        try { call.preparedRead = preparedReadTransition(call, tasks, session, preparedReads.get(id)); }
        catch (error) { note('TOOL_RESULT_INPUT_MISMATCH', 'The executed result input differs without a proven Broker preparation',
          { toolCallId: id, reason: error.message }, 'failed'); }
      }
    }
  }
  const byId = new Map(attempts.map(call => [call.id, call]));
  for (const [id, result] of resultEvents) if (!callEvents.has(id))
    note('TOOL_START_UNOBSERVED', 'A terminal callback has no actual start observation', { toolCallId: id, tool: result.toolName });
  for (const [id, root] of roots) if (!byId.has(id))
    note('TASK_TOOL_OBSERVATION_MISSING', 'A native model-issued call has no actual callback', { toolCallId: id, resultEntryId: root.entry.id });
  for (const [id] of declared) if (!byId.has(id))
    note('NESTED_TOOL_CHILD_UNOBSERVED', 'A child in the native complete census lacks actual callbacks', { toolCallId: id });
  for (const call of attempts.filter(call => declared.has(call.id))) {
    const parent = byId.get(call.parentToolCallId), root = byId.get(call.rootToolCallId);
    if (!parent || !root) { note('NESTED_TOOL_PARENT_UNOBSERVED', 'A nested call has no observed parent or root', { toolCallId: call.id }); continue; }
    if (parent.id === call.id || parent.rootToolCallId !== call.rootToolCallId)
      note('NESTED_TOOL_PARENT_SCOPE_MISMATCH', 'A nested call points outside its native root', { toolCallId: call.id }, 'failed');
    const seen = new Set([call.id]); let ancestor = parent;
    while (ancestor && ancestor.id !== root.id) {
      if (seen.has(ancestor.id)) { note('NESTED_TOOL_PARENT_CYCLE', 'Nested ancestry contains a cycle', { toolCallId: call.id }, 'failed'); break; }
      seen.add(ancestor.id); ancestor = byId.get(ancestor.parentToolCallId);
    }
    if (!ancestor) note('NESTED_TOOL_PARENT_UNOBSERVED', 'Nested ancestry does not reach the native root', { toolCallId: call.id });
    if (positions.get(parent.event) >= positions.get(call.event)
      || !parent.result || !call.result || positions.get(call.result) >= positions.get(parent.result))
      note('NESTED_TOOL_LIFETIME_UNPROVEN', 'The child must start and finish within its actual parent lifetime', { toolCallId: call.id });
  }
  const status = statusOf(diagnostics), complete = status === 'passed';
  for (const [id, root] of roots) {
    if (root.native.name !== 'codemode') continue;
    const call = byId.get(id), problems = [...root.containerDiagnostics];
    const source = call?.event.toolSource, runtime = call && runtimeForCall(call.event, runtimeEvidence.get(id));
    if (!object(source) || source.path !== 'builtin:codemode' || source.source !== 'builtin'
      || source.scope !== 'temporary' || source.origin !== 'top-level' || !runtime)
      problems.push({ status: 'blocked', code: source === undefined ? 'CODEMODE_IMPLEMENTATION_UNOBSERVED' : 'CODEMODE_IMPLEMENTATION_UNREVIEWED',
        message: 'The actual builtin needs its sealed reviewed Pi entry, executor and QuickJS worker' });
    const first = session.branchEntries.findIndex(entry => entry.id === root.native.assistantEntryId);
    const last = session.branchEntries.findIndex(entry => entry.id === root.native.resultEntryId);
    if (first < 0 || last <= first)
      problems.push({ status: 'blocked', code: 'CODEMODE_NATIVE_LIFETIME_UNPROVEN', message: 'Retain the native call-to-result branch interval' });
    else if (session.branchEntries.slice(first + 1, last).some(entry => entry.type === 'custom' && entry.customType === 'codemode-store'))
      problems.push({ status: 'blocked', code: 'CODEMODE_PERSISTENT_STORE_WRITE', message: 'The sandbox persisted a store mutation during this call' });
    if (root.native.isError !== false || root.message.isError === true || call?.result?.isError !== false)
      problems.push({ status: 'blocked', code: 'CODEMODE_EXECUTION_UNFINISHED', message: 'Only a successfully settled sandbox has complete effect coverage' });
    const contentJson = JSON.stringify(root.message.content), contentSha256 = typeof contentJson === 'string' ? sha(contentJson) : undefined;
    if (!Array.isArray(root.message.content) || root.message.content.some(part => part?.type !== 'text')
      || !object(root.message.details) || Object.keys(root.message.details).some(key => key !== 'calls'))
      problems.push({ status: 'blocked', code: 'CODEMODE_OUTPUT_EFFECT_UNREVIEWED', message: 'Image output, spilled files and unknown result fields need independent effect evidence' });
    if (!runtime || !digest(contentSha256) || runtime.resultContentSha256 !== contentSha256
      || call?.result?.content?.sha256 !== contentSha256 || call.result.content.bytes !== Buffer.byteLength(contentJson)
      || call.result.contentArtifact?.sha256 !== contentSha256 || call.result.contentArtifact.bytes !== Buffer.byteLength(contentJson))
      problems.push({ status: 'blocked', code: 'CODEMODE_RESULT_CONTENT_UNPROVEN', message: 'The complete native output must match the sealed actual result bytes' });
    const declaredComplete = root.message.nestedCalls?.complete === true
      || root.message.nestedCalls === undefined && Array.isArray(root.message.details?.calls) && root.message.details.calls.length === 0;
    const container = { id, name: 'codemode', complete: complete && declaredComplete && problems.length === 0,
      directChildIds: root.direct, descendantIds: root.members, diagnostics: problems,
      coverage: 'native-complete-census-and-actual-terminal-callbacks',
      provenance: { resultEntryId: root.entry.id, resultLine: root.native.resultLine,
        ...(root.message.nestedCalls ? { summarySha256: sha(JSON.stringify(root.message.nestedCalls)) } : { noNestedCalls: true }),
        directCensusSha256: root.directCensusSha256, ...(source ? { toolSource: source } : {}),
        ...(runtime ? { implementation: runtime.implementation, resultContentSha256: contentSha256 } : {}) },
      semantics: 'QuickJS has no ambient filesystem/network; evaluate every tool descendant independently; model execution needs its direct census; store/output mutations remain blocked',
      notClaimed: 'zero host/plugin traffic or credential reads; model catalog/auth availability is metadata, not Notion mutation evidence' };
    containers.push(container); if (call) call.container = container;
  }
  return { version: 1, status, complete, attempts, containers, retractedProposals, diagnostics,
    counts: { actual: attempts.length, topLevel: attempts.filter(call => call.provenance?.kind === 'native-tool-call').length,
      nested: attempts.filter(call => call.provenance?.kind === 'native-nested-summary').length,
      errors: attempts.filter(call => call.result?.isError === true).length, retractedProposals: retractedProposals.length } };
}

/** Only a proven container whose complete descendant set passes the caller's
 * normal effects classifier can be treated as a read-only composition. */
export function inspectNotionAgentReadOnlyContainer(attempt, correlation, isReadOnlyTool) {
  const container = attempt?.container;
  if (correlation?.complete !== true || container?.complete !== true || typeof isReadOnlyTool !== 'function')
    return { status: 'blocked', readOnly: false, code: 'TOOL_CONTAINER_COVERAGE_MISSING' };
  const byId = new Map(correlation.attempts.map(call => [call.id, call])), unreviewed = [];
  for (const id of container.descendantIds) {
    const child = byId.get(id);
    if (!child || !child.result || isReadOnlyTool(child) !== true) unreviewed.push(id);
  }
  return unreviewed.length ? { status: 'blocked', readOnly: false, code: 'TOOL_CONTAINER_EFFECTS_UNKNOWN', unreviewed }
    : { status: 'passed', readOnly: true, descendantIds: container.descendantIds, provenance: container.provenance };
}
