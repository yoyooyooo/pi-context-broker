import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { safeRequestMetrics } from './notion-default-context.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const same = (a, b) => canonical(a) === canonical(b);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const unique = values => [...new Set(values)];
const sum = values => values.every(finite) ? values.reduce((a, b) => a + b, 0) : null;

/** Pi 1.4 observer. This function is deliberately self-contained so an owned Pi
 * process can install its source without a dependency on this repository.
 *
 * The driver supplies Node fs/crypto/path, an existing external output directory,
 * and a clockId shared with its process.hrtime.bigint() submission receipt.
 * No user/provider/tool text, URLs, headers, environment values or credentials are
 * written. Hashes and UTF-8 byte counts refer to the actual unredacted values.
 * A before_provider_request payload is a hook value, NOT HTTP wire evidence.
 * The driver must prove that no later hook transforms it (or supply a transport
 * receipt). This observer neither changes hook ordering nor wraps global fetch.
 */
export function observeConsumptionCost(api, settings) {
  const { fs, crypto, path, output, checkoutRoot, runId, sampleId, clockId } = settings;
  const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(value);
  if (!path.isAbsolute(output ?? '') || !path.isAbsolute(checkoutRoot ?? '') || ![runId, sampleId, clockId].every(identifier))
    throw new Error('COST_OBSERVER_SETTINGS_INVALID');
  const root = fs.realpathSync(checkoutRoot), parent = fs.realpathSync(path.dirname(output));
  const relative = path.relative(root, parent);
  if (relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
    throw new Error('COST_EVIDENCE_MUST_BE_OUTSIDE_CHECKOUT');
  const fd = fs.openSync(output, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  fs.fchmodSync(fd, 0o600);
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  const bytes = value => Buffer.byteLength(value, 'utf8');
  const textMeasure = value => ({ bytes: bytes(value), sha256: sha(value) });
  const jsonMeasure = value => textMeasure(JSON.stringify(value) ?? 'null');
  const clock = settings.clock ?? (() => process.hrtime.bigint());
  const origin = clock();
  let sequence = 0, previous = null, closed = false, errors = 0, workNs = 0n, turn = 0, request = 0;
  const phases = new Set(), firstTextTurns = new Set(), knownBodies = new Map();
  const textContent = content => typeof content === 'string' ? content : (Array.isArray(content) ? content : [])
    .filter(part => part?.type === 'text').map(part => String(part.text ?? '')).join('\n');
  const append = (phase, details = {}) => {
    const now = clock();
    const row = { version: 1, runId, sampleId, clockId, sequence: ++sequence, previousSha256: previous,
      monotonicNs: now.toString(), elapsedMs: Number(now - origin) / 1e6, phase, ...details };
    row.eventSha256 = sha(JSON.stringify(row));
    fs.writeSync(fd, JSON.stringify(row) + '\n');
    previous = row.eventSha256;
    phases.add(phase);
  };
  const usage = value => {
    const fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'];
    const valid = fields.every(key => typeof value?.[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0)
      && fields.some(key => value[key] > 0);
    return { method: valid ? 'pi-assistant-message-reported-usage' : 'unavailable-or-all-zero-pi-usage',
      ...Object.fromEntries(fields.map(key => [key, valid ? value[key] : null])),
      reasoning: valid && Number.isFinite(value.reasoning) ? value.reasoning : null,
      reasoningIsSubsetOfOutput: true,
      reportedCost: valid && value.cost && Object.values(value.cost).every(number => typeof number === 'number' && Number.isFinite(number) && number >= 0)
        ? Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'total'].map(key => [key, value.cost[key] ?? null])) : null };
  };
  const assistant = message => {
    const text = textContent(message?.content);
    return { role: message?.role === 'assistant' ? 'assistant' : 'other', content: jsonMeasure(message?.content),
      text: textMeasure(text), nonWhitespaceText: text.trim().length > 0,
      permissionOnly: text.length < 1200 && /(?:please\s+(?:approve|authorize|confirm)|(?:need|require|await)\w*\s+(?:your\s+)?(?:approval|permission)|(?:请|需要|等待).{0,15}(?:授权|批准|确认))/iu.test(text),
      stopReason: ['stop', 'length', 'toolUse', 'error', 'aborted'].includes(message?.stopReason) ? message.stopReason : null,
      usage: usage(message?.usage) };
  };
  const remember = messages => {
    for (const message of messages ?? []) {
      const details = message?.details;
      if (!details || message.isError === true) continue;
      let text = textContent(message.content);
      if (details.nativePromptSha256) text = textContent(messages.find(item => item.role === 'user'
        && sha(textContent(item.content)) === details.nativePromptSha256)?.content);
      const records = details.contextBrokerPreparation?.records ?? details.records ?? [];
      for (const proof of Array.isArray(records) ? records : []) {
        const span = proof?.delivery;
        if (!span || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > text.length) continue;
        const encoded = text.slice(span.start, span.end);
        let body;
        try { body = span.encoding === 'raw' ? encoded : span.encoding === 'xml' ? encoded.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
          : span.encoding === 'json' ? JSON.parse('"' + encoded + '"') : undefined; } catch { continue; }
        if (typeof body === 'string' && sha(body) === proof.bodySha256 && bytes(body) === proof.bytes)
          knownBodies.set(proof.bodySha256, { body, bytes: proof.bytes, kind: 'skill-body', firstObservedTurn: knownBodies.get(proof.bodySha256)?.firstObservedTurn ?? turn });
      }
      for (const [kind, proof] of [['skill-body', details.contextBrokerRead], ['resource', details.contextBrokerResource]]) {
        if (!proof || proof.toolCallId !== message.toolCallId || kind === 'resource' && proof.delivered_complete_text !== true) continue;
        const expected = proof.bodySha256 ?? proof.sha256;
        if (text && sha(text) === expected && bytes(text) === proof.bytes)
          knownBodies.set(expected, { body: text, bytes: proof.bytes, kind, firstObservedTurn: knownBodies.get(expected)?.firstObservedTurn ?? turn });
      }
    }
  };
  const payload = value => {
    const measured = jsonMeasure(value), strings = [];
    const visit = item => {
      if (typeof item === 'string') strings.push(item);
      else if (Array.isArray(item)) item.forEach(visit);
      else if (item && typeof item === 'object') Object.values(item).forEach(visit);
    };
    visit(value);
    const components = Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {}).map(([key, item]) => ({
      keySha256: sha(key), group: ['tools', 'functions', 'tool_choice', 'function_call'].includes(key) ? 'tools'
        : ['messages', 'input'].includes(key) ? 'messages' : ['system', 'system_instruction', 'instructions'].includes(key) ? 'system' : 'other', ...jsonMeasure(item) }));
    const spans = [];
    for (const [kind, tag] of [['catalog', 'ntn-skills-view-catalog'], ['native-skill-directory', 'available_skills'],
      ['native-router-directory', 'available_routers'], ['guidance', 'ntn-skills-guidance'], ['projected-body', 'body']])
      for (const string of strings) for (const match of string.matchAll(new RegExp('<' + tag + '>[\\s\\S]*?</' + tag + '>', 'g')))
        spans.push({ kind, ...textMeasure(match[0]) });
    const bodies = [...knownBodies].map(([sha256, body]) => {
      const encodings = [...new Set([body.body, body.body.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')])];
      return { sha256, kind: body.kind, bytes: body.bytes, firstObservedTurn: body.firstObservedTurn,
        occurrences: strings.reduce((total, string) => total + Math.max(...encodings.map(encoded => string.split(encoded).length - 1)), 0) };
    });
    return { ...measured, method: 'utf8-json-stringify-of-extension-hook-payload', wireBytes: null,
      wireMethod: 'not-observable-at-extension-hook', components,
      jsonStructureBytes: measured.bytes - components.reduce((total, item) => total + item.bytes, 0),
      diagnosticSpans: spans, verifiedBodyOccurrences: bodies, diagnosticMethod: 'nonadditive-text-spans-and-receipt-verified-exact-matches', tokens: null,
      tokenMethod: 'per-component-tokenization-unavailable-use-reported-request-usage' };
  };
  const on = (phase, handle) => api.on(phase, event => {
    if (closed) return;
    const started = clock();
    try { handle(event); }
    catch {
      errors++;
      try { append('observer_error', { observedPhase: phase }); } catch { /* Evidence is incomplete; the product proceeds unchanged. */ }
    } finally { workNs += clock() - started; }
    // Returning undefined preserves every transforming/cancellable hook's input.
  });
  const finish = () => {
    if (closed) return;
    try { append('observer_end', { complete: errors === 0, errors, priorEventCount: sequence,
      observedPhases: [...phases], observerWorkMs: Number(workNs) / 1e6 }); }
    finally { closed = true; fs.closeSync(fd); }
  };
  append('observer_start', { clockMethod: 'node-process-hrtime-bigint', contentPolicy: 'hash-and-byte-count-only',
    providerMethod: 'extension-hook-payload-not-http-attempt-or-wire', overheadMethod: 'synchronous-observer-work-reported-not-subtracted' });
  on('input', event => { turn++; append('input', { turn, source: ['interactive', 'rpc', 'extension'].includes(event.source) ? event.source : 'unknown',
    text: textMeasure(String(event.text ?? '')), images: jsonMeasure(event.images ?? []), imageCount: Array.isArray(event.images) ? event.images.length : 0,
    method: 'input-at-observer-hook-position-driver-retains-original-submission' }); });
  on('agent_start', () => append('agent_start', { turn }));
  for (const phase of ['context', 'context_with_system']) on(phase, event => {
    remember(event.messages); append(phase, { turn, messages: jsonMeasure(event.messages),
      components: (event.messages ?? []).map(message => ({ role: ['system', 'user', 'assistant', 'toolResult', 'custom'].includes(message.role) ? message.role : 'other',
        content: jsonMeasure(message.content) })), method: phase === 'context_with_system' ? 'post-context-hooks-with-system' : 'at-observer-context-hook-position' });
  });
  on('before_provider_request', event => append('provider_request', { turn, request: ++request, payload: payload(event.payload) }));
  on('after_provider_response', event => append('provider_response', { turn, request, status: Number.isInteger(event.status) ? event.status : null }));
  on('tool_call', event => append('tool_call', { turn, request, toolCallIdSha256: sha(String(event.toolCallId ?? '')),
    toolNameSha256: sha(String(event.toolName ?? '')), input: jsonMeasure(event.input) }));
  on('tool_result', event => {
    remember([event]); append('tool_result', { turn, request, toolCallIdSha256: sha(String(event.toolCallId ?? '')),
      isError: event.isError === true, content: jsonMeasure(event.content), usage: usage(event.usage) });
  });
  on('message_update', event => {
    const stream = event.assistantMessageEvent, delta = stream?.type === 'text_delta' && typeof stream.delta === 'string' ? stream.delta : '';
    const firstEffectiveText = delta.trim().length > 0 && !firstTextTurns.has(turn);
    if (firstEffectiveText) firstTextTurns.add(turn);
    append('message_update', { turn, request, streamType: ['text_delta', 'text_start', 'text_end', 'start', 'done', 'error', 'thinking_start', 'thinking_delta', 'thinking_end', 'toolcall_start', 'toolcall_delta', 'toolcall_end'].includes(stream?.type) ? stream.type : 'other',
      delta: textMeasure(delta), firstEffectiveText });
  });
  on('message_end', event => { remember([event.message]); append('message_end', { turn, request, message: assistant(event.message) }); });
  on('agent_end', event => {
    remember(event.messages); const last = [...(event.messages ?? [])].reverse().find(message => message.role === 'assistant');
    append('agent_end', { turn, request, messages: jsonMeasure(event.messages), final: last ? assistant(last) : null });
  });
  on('session_shutdown', () => { append('session_shutdown'); finish(); });
  return { finish, status: () => ({ closed, errors, events: sequence }) };
}

export function consumptionCostExtensionSource(settings) {
  const allowed = ['output', 'checkoutRoot', 'runId', 'sampleId', 'clockId'];
  if (Object.keys(settings).some(key => !allowed.includes(key))) throw new Error('COST_EXTENSION_SETTINGS_INVALID');
  return `import fs from 'node:fs';\nimport crypto from 'node:crypto';\nimport path from 'node:path';\nexport default api => { (${observeConsumptionCost.toString()})(api, {fs, crypto, path, ...${JSON.stringify(settings)}}); };\n`;
}

export async function readConsumptionCostEvents(file) {
  if (!isAbsolute(file)) throw new Error('COST_EVIDENCE_PATH_MUST_BE_ABSOLUTE');
  const buffer = await readFile(file);
  if (!buffer.length || buffer.at(-1) !== 10) throw new Error('COST_TRACE_TRUNCATED');
  const events = buffer.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  return { events, artifact: { bytes: buffer.length, sha256: hash(buffer) } };
}

const conditionKeys = ['promptSha256', 'modelSha256', 'modelParametersSha256', 'dataSha256', 'packageSha256',
  'freshnessSha256', 'networkSha256', 'toolsSha256', 'observerSha256', 'nodeVersion', 'piVersion'];
const scenarioKeys = ['id', 'cache', 'cacheSha256', 'session', 'entry', 'intent'];

/** Write this plan to external evidence BEFORE starting either run. Cache hashes
 * identify the verified initial state, not a directory name or desired label.
 * A deliberate package change is the only permitted cross-run condition change.
 * Exact prompt and timestamps belong in the driver's private submission receipt;
 * this contract stores its hash so URLs and credentials cannot enter the report.
 */
export function freezeConsumptionPlan({ conditions, samples }) {
  if (!conditions || !same(Object.keys(conditions).sort(), [...conditionKeys].sort())
      || conditionKeys.some(key => key.endsWith('Sha256') ? !digest(conditions[key]) : !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(conditions[key])))
    throw new Error('COST_CONDITIONS_INVALID');
  if (!Array.isArray(samples) || !samples.length || new Set(samples.map(sample => sample.id)).size !== samples.length
      || samples.some(sample => !same(Object.keys(sample).sort(), [...scenarioKeys].sort())
        || !/^[A-Za-z0-9_.-]{1,120}$/.test(sample.id) || !['cold', 'warm', 'expired-unchanged', 'expired-changed', 'partial'].includes(sample.cache) || !digest(sample.cacheSha256)
        || !['new', 'existing', 'restart', 'resume', 'fork', 'rewind', 'compacted'].includes(sample.session) || !/^[A-Za-z0-9_.-]{1,120}$/.test(sample.entry)
        || !/^[A-Za-z0-9_.-]{1,120}$/.test(sample.intent))) throw new Error('COST_SAMPLE_PLAN_INVALID');
  const plan = JSON.parse(JSON.stringify({ version: 1, conditions, samples }));
  return { ...plan, sha256: hash(canonical(plan)) };
}

function traceErrors(events) {
  const errors = [];
  if (!Array.isArray(events) || events[0]?.phase !== 'observer_start' || events.at(-1)?.phase !== 'observer_end') return ['COST_TRACE_INCOMPLETE'];
  let previous = null, time = -1n;
  for (const [index, event] of events.entries()) {
    const { eventSha256, ...body } = event;
    if (event.sequence !== index + 1 || event.previousSha256 !== previous || !digest(eventSha256) || hash(JSON.stringify(body)) !== eventSha256)
      errors.push('COST_TRACE_CHAIN_INVALID');
    if (!/^\d+$/.test(event.monotonicNs) || BigInt(event.monotonicNs) < time) errors.push('COST_TRACE_CLOCK_INVALID');
    else time = BigInt(event.monotonicNs);
    if (event.runId !== events[0].runId || event.sampleId !== events[0].sampleId || event.clockId !== events[0].clockId)
      errors.push('COST_TRACE_IDENTITY_CHANGED');
    previous = eventSha256;
  }
  const end = events.at(-1);
  if (end.complete !== true || end.errors !== 0 || end.priorEventCount !== events.length - 1 || events.some(event => event.phase === 'observer_error'))
    errors.push('COST_OBSERVER_FAILED');
  return unique(errors);
}

const coverageDimensions = ['notion', 'attachments', 'prefetch', 'retries', 'other-http', 'model-http'];

/** source.coverage is an independently saved driver inventory of EVERY operation,
 * including failed, background and retry work. Each receipt contains the original
 * request_metrics object accepted by safeRequestMetrics. Provider requests must
 * be explicitly classified as attachment, model, or other; an absent attachment
 * collector is unknown, never zero. Bytes are decoded/request-body bytes from
 * that method, never compressed/encrypted HTTP wire bytes.
 */
export function summarizeConsumptionSource(source) {
  const errors = [], coverage = source?.coverage ?? {}, receipts = source?.receipts;
  if (!Array.isArray(receipts)) return { valid: false, errors: ['COST_SOURCE_COVERAGE_INCOMPLETE'], costs: null };
  if (coverage.complete !== true || coverage.truncated !== false
      || !digest(coverage.evidenceSha256) || !same([...(coverage.dimensions ?? [])].sort(), [...coverageDimensions].sort())
      || !['real', 'controlled'].includes(coverage.modelMode)) errors.push('COST_SOURCE_COVERAGE_INCOMPLETE');
  const ids = receipts.map(receipt => receipt.id);
  if (new Set(ids).size !== ids.length || !same([...ids].sort(), [...(coverage.receiptIds ?? [])].sort())) errors.push('COST_SOURCE_OPERATION_MISSING');
  if (!Array.isArray(coverage.prefetchReceiptIds) || !same(receipts.filter(receipt => receipt.purpose === 'prefetch').map(receipt => receipt.id).sort(), [...coverage.prefetchReceiptIds].sort()))
    errors.push('COST_PREFETCH_COVERAGE_MISSING');
  const trace = [];
  for (const receipt of receipts) {
    const metrics = safeRequestMetrics(receipt.requestMetrics);
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(receipt.id) || !/^[A-Za-z0-9_.-]{1,120}$/.test(receipt.operationId)
        || !['cli', 'sdk', 'http'].includes(receipt.execution) || !['foreground', 'prefetch', 'model'].includes(receipt.purpose)
        || receipt.started !== true || receipt.closed !== true || !metrics?.complete) {
      errors.push('COST_SOURCE_RECEIPT_INCOMPLETE');
    }
    if (!metrics) continue;
    const safeId = value => /^[A-Za-z0-9_.-]{1,120}$/.test(value) ? value : 'redacted-' + hash(String(value));
    for (const event of metrics.trace) {
      const { target, request_id, rate_limit_reason, ...safe } = event;
      trace.push({ ...safe, receiptId: safeId(receipt.id), operationId: safeId(receipt.operationId),
        execution: ['cli', 'sdk', 'http'].includes(receipt.execution) ? receipt.execution : 'unknown',
        purpose: ['foreground', 'prefetch', 'model'].includes(receipt.purpose) ? receipt.purpose : 'unknown',
        ...(event.event === 'attempt' ? { targetSha256: target ? hash(canonical(target)) : null,
          requestIdSha256: request_id === null ? null : hash(request_id), rateLimitReasonSha256: rate_limit_reason === null ? null : hash(rate_limit_reason) } : {}) });
    }
  }
  const attempts = trace.filter(row => row.event === 'attempt'), waits = trace.filter(row => row.event === 'wait');
  const providerKeys = attempts.filter(row => row.request_kind === 'provider').map(row => row.receiptId + ':' + row.attempt);
  const classifications = ['attachmentAttempts', 'modelAttempts', 'otherProviderAttempts'].flatMap(key => coverage[key] ?? []);
  if (['attachmentAttempts', 'modelAttempts', 'otherProviderAttempts'].some(key => !Array.isArray(coverage[key]))
      || new Set(classifications).size !== classifications.length || !same([...providerKeys].sort(), [...classifications].sort()))
    errors.push('COST_ATTACHMENT_OR_MODEL_COVERAGE_MISSING');
  const selected = keys => attempts.filter(row => keys?.includes(row.receiptId + ':' + row.attempt));
  const attachment = selected(coverage.attachmentAttempts), model = selected(coverage.modelAttempts);
  if (model.some(row => row.purpose !== 'model') || attempts.some(row => row.purpose === 'model' && !coverage.modelAttempts?.includes(row.receiptId + ':' + row.attempt)))
    errors.push('COST_MODEL_ATTEMPT_CLASSIFICATION_INVALID');
  const bytes = rows => ({ requestBodyBytes: sum(rows.map(row => row.request_bytes)), decodedResponseBytes: sum(rows.map(row => row.response_bytes)),
    unknownRequestByteAttempts: rows.filter(row => row.request_bytes === null).length, unknownResponseByteAttempts: rows.filter(row => row.response_bytes === null).length });
  return { valid: errors.length === 0, errors: unique(errors), evidenceSha256: digest(coverage.evidenceSha256) ? coverage.evidenceSha256 : null,
    costs: { method: 'observed-safeRequestMetrics-receipts-coverage-checked-against-independent-operation-inventory', complete: errors.length === 0,
      modelMode: ['real', 'controlled'].includes(coverage.modelMode) ? coverage.modelMode : null,
      logicalOperations: new Set(receipts.map(receipt => receipt.operationId)).size, cliStarts: receipts.filter(receipt => receipt.execution === 'cli').length,
      sdkCalls: receipts.filter(receipt => receipt.execution === 'sdk').length, httpAttempts: attempts.length, failedHttpAttempts: attempts.filter(row => row.outcome !== 'success').length,
      ...bytes(attempts), attachmentHttpAttempts: attachment.length, attachmentDecodedBytes: sum(attachment.map(row => row.response_bytes)),
      modelHttpAttempts: model.length, prefetchHttpAttempts: attempts.filter(row => row.purpose === 'prefetch').length,
      queueWaitMs: sum(waits.filter(row => row.kind === 'queue').map(row => row.milliseconds)), retryWaitMs: sum(waits.filter(row => row.kind === 'retry').map(row => row.milliseconds)),
      httpDurationSumMs: sum(attempts.map(row => row.duration_ms)), wireBytes: null, wireMethod: 'not-measured-by-source-receipts',
      requestKinds: Object.fromEntries(['notion_metadata', 'notion_body', 'notion_write', 'provider'].map(kind => [kind, attempts.filter(row => row.request_kind === kind).length])),
      bodyKinds: Object.fromEntries(['current_body', 'retained_body', 'unclassified_body'].map(kind => [kind, attempts.filter(row => row.body_kind === kind).length])),
      trace } };
}

/** Driver submission: {promptSha256, monotonicNs, clockId, evidenceSha256}.
 * outcome: {status, taskVerified, assertionsSha256, providerCapture}, where the
 * capture is {verified:true, method:'last-hook'|'transport-receipt', evidenceSha256}.
 * Task assertions must check requested content/actions, not an exit code alone.
 */
export function summarizeConsumptionSample({ id, scenario, conditions, events = [], source, submission, outcome }) {
  const errors = [], status = outcome?.status;
  if (!['passed', 'failed', 'blocked', 'not-run'].includes(status)) errors.push('COST_STATUS_INVALID');
  const idle = ['blocked', 'not-run'].includes(status) && events.length === 0;
  if (!idle) errors.push(...traceErrors(events));
  if (!idle && (events[0]?.sampleId !== id || submission?.promptSha256 !== conditions?.promptSha256 || !digest(submission?.evidenceSha256)
      || !/^\d+$/.test(submission?.monotonicNs) || submission?.clockId !== events[0]?.clockId)) errors.push('COST_SUBMISSION_RECEIPT_MISSING');
  const provider = events.filter(event => event.phase === 'provider_request');
  if (!idle && provider.some((event, index) => event.request !== index + 1)) errors.push('COST_PROVIDER_OBSERVATION_MISSING');
  const messages = events.filter(event => event.phase === 'message_end' && event.message?.role === 'assistant');
  const calls = events.filter(event => event.phase === 'tool_call'), results = events.filter(event => event.phase === 'tool_result');
  if (calls.some(call => !results.some(result => result.toolCallIdSha256 === call.toolCallIdSha256))
      || results.some(result => !calls.some(call => call.toolCallIdSha256 === result.toolCallIdSha256))) errors.push('COST_TOOL_OBSERVATION_MISSING');
  const end = events.filter(event => event.phase === 'agent_end').at(-1), final = end?.final;
  if (status === 'passed' && (!final?.nonWhitespaceText || final.permissionOnly || final.stopReason !== 'stop'
      || outcome.taskVerified !== true || !digest(outcome.assertionsSha256))) errors.push('COST_TASK_SUCCESS_UNPROVEN');
  if (status === 'passed' && ['input', 'context_with_system', 'provider_request', 'message_end', 'agent_end'].some(phase => !events.some(event => event.phase === phase)))
    errors.push('COST_REQUIRED_OBSERVATION_MISSING');
  const capture = outcome?.providerCapture;
  if (!idle && (!capture?.verified || !['last-hook', 'transport-receipt'].includes(capture.method) || !digest(capture.evidenceSha256)))
    errors.push('COST_PROVIDER_FINALITY_UNPROVEN');
  const transport = idle ? { valid: true, errors: [], costs: null } : summarizeConsumptionSource(source);
  errors.push(...transport.errors);
  if (transport.costs?.modelMode === 'real' && transport.costs.modelHttpAttempts < provider.length) errors.push('COST_MODEL_HTTP_ATTEMPTS_MISSING');
  const usageByRequest = new Map(messages.map(event => [event.request, event.message.usage]));
  const usages = provider.map(event => usageByRequest.get(event.request));
  const elapsed = event => {
    if (!event || !/^\d+$/.test(submission?.monotonicNs) || !/^\d+$/.test(event.monotonicNs)) return null;
    const difference = BigInt(event.monotonicNs) - BigInt(submission.monotonicNs);
    if (difference < 0n) { errors.push('COST_SUBMISSION_CLOCK_INVALID'); return null; }
    return Number(difference) / 1e6;
  };
  const costs = idle ? null : {
    providerHookRequests: provider.length, toolCalls: calls.length, toolRounds: new Set(calls.map(call => call.request)).size,
    providerPayloadJsonBytes: sum(provider.map(event => event.payload?.bytes)), firstProviderPayloadJsonBytes: provider[0]?.payload?.bytes ?? null,
    ...Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].map(key => [key, usages.length ? sum(usages.map(item => item?.[key])) : null])),
    firstProviderInputTokens: usages[0]?.input ?? null, knownUsageRequests: usages.filter(item => finite(item?.totalTokens)).length,
    unknownUsageRequests: usages.filter(item => !finite(item?.totalTokens)).length,
    tokenMethod: 'pi-assistant-message-reported-usage-no-character-estimates', wireBytes: null, wireMethod: 'unknown-at-extension-hooks',
    timings: { submitToFirstProviderMs: elapsed(provider[0]), submitToFirstEffectiveTextMs: elapsed(events.find(event => event.phase === 'message_update' && event.firstEffectiveText)),
      submitToCompletionMs: elapsed(end) },
    observerWorkMs: events.at(-1)?.observerWorkMs ?? null, transport: transport.costs,
  };
  return { version: 1, id, scenario, conditions, status, valid: errors.length === 0, errors: unique(errors), costs,
    evidence: { eventChainSha256: events.at(-1)?.eventSha256 ?? null, sourceSha256: transport.evidenceSha256 ?? null,
      submissionSha256: digest(submission?.evidenceSha256) ? submission.evidenceSha256 : null,
      assertionSha256: digest(outcome?.assertionsSha256) ? outcome.assertionsSha256 : null,
      providerCaptureMethod: ['last-hook', 'transport-receipt'].includes(capture?.method) ? capture.method : null,
      providerCaptureSha256: digest(capture?.evidenceSha256) ? capture.evidenceSha256 : null } };
}

export function consumptionMetricStats(values) {
  const known = values.filter(finite).sort((a, b) => a - b), n = known.length;
  return { n: values.length, observed: n, unknown: values.length - n, values,
    median: n ? n % 2 ? known[(n - 1) / 2] : (known[n / 2 - 1] + known[n / 2]) / 2 : null,
    p95: n >= 20 ? known[Math.ceil(n * 0.95) - 1] : null,
    p95Method: n >= 20 ? 'nearest-rank' : 'unavailable-fewer-than-20-observations' };
}

function runErrors(run) {
  const errors = [];
  try {
    const { sha256, ...body } = run.plan;
    if (hash(canonical(body)) !== sha256 || freezeConsumptionPlan(run.plan).sha256 !== sha256) errors.push('COST_PLAN_CHANGED');
  }
  catch { return ['COST_PLAN_INVALID']; }
  if (!Array.isArray(run.samples) || !same(run.samples.map(sample => sample.id), run.plan.samples.map(sample => sample.id))) return [...errors, 'COST_PLANNED_SAMPLE_MISSING_OR_REORDERED'];
  for (const sample of run.samples) {
    if (!same(sample.conditions, run.plan.conditions) || !same(sample.scenario, run.plan.samples.find(item => item.id === sample.id))) errors.push('COST_SAMPLE_CONDITIONS_CHANGED');
    if (!sample.valid) errors.push(...sample.errors, 'COST_SAMPLE_EVIDENCE_INVALID');
  }
  return unique(errors);
}

function runStats(run) {
  const samples = run?.samples ?? [], metric = path => consumptionMetricStats(samples.map(sample => path.reduce((value, key) => value?.[key], sample.costs) ?? null));
  return { n: samples.length, planned: run?.plan?.samples?.length ?? 0, ids: samples.map(sample => sample.id),
    validSamples: samples.filter(sample => sample.valid).length, incompleteSamples: samples.filter(sample => !sample.valid).length,
    outcomes: Object.fromEntries(['passed', 'failed', 'blocked', 'not-run'].map(status => [status, samples.filter(sample => sample.status === status).length])),
    aggregation: 'all-observed-values-including-failures-and-partial-traces-unknown-values-remain-null-comparison-requires-valid-evidence',
    costs: Object.fromEntries(['providerHookRequests', 'toolCalls', 'toolRounds', 'providerPayloadJsonBytes', 'firstProviderPayloadJsonBytes', 'input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'firstProviderInputTokens', 'observerWorkMs'].map(key => [key, metric([key])])),
    timings: Object.fromEntries(['submitToFirstProviderMs', 'submitToFirstEffectiveTextMs', 'submitToCompletionMs'].map(key => [key, metric(['timings', key])])),
    transport: Object.fromEntries(['logicalOperations', 'cliStarts', 'sdkCalls', 'httpAttempts', 'failedHttpAttempts', 'requestBodyBytes', 'decodedResponseBytes', 'attachmentHttpAttempts', 'attachmentDecodedBytes', 'modelHttpAttempts', 'prefetchHttpAttempts', 'queueWaitMs', 'retryWaitMs', 'httpDurationSumMs', 'wireBytes'].map(key => [key, metric(['transport', key])])) };
}

/** Comparability is not acceptance of AH-617. Retain failed/blocked samples and
 * all costs; separately judge task assertions and the complete ticket matrix.
 */
export function compareConsumptionRuns({ baseline, candidate, packageChange }) {
  const errors = [...runErrors(baseline), ...runErrors(candidate)], regressions = [];
  const before = baseline?.plan?.conditions, after = candidate?.plan?.conditions;
  if (before && after) for (const key of conditionKeys) {
    if (same(before[key], after[key])) continue;
    if (key === 'packageSha256' && packageChange?.baseline === before[key] && packageChange?.candidate === after[key]) continue;
    errors.push('COST_NON_EQUIVALENT_' + key);
  }
  if (!same(baseline?.plan?.samples, candidate?.plan?.samples)) errors.push('COST_NON_EQUIVALENT_SCENARIOS');
  const pairs = (baseline?.samples ?? []).map(sample => [sample, candidate?.samples?.find(item => item.id === sample.id)]);
  for (const [a, b] of pairs) {
    if (!b) continue;
    if (a.status === 'passed' && b.status !== 'passed') regressions.push({ id: a.id, code: 'COST_TASK_SUCCESS_REGRESSION' });
    if (['blocked', 'not-run'].includes(b.status)) errors.push('COST_CANDIDATE_NOT_COMPLETED');
    if (a.status === 'passed' && b.status === 'passed' && a.costs && b.costs) {
      if (b.costs.firstProviderPayloadJsonBytes < a.costs.firstProviderPayloadJsonBytes
          && (b.costs.providerPayloadJsonBytes > a.costs.providerPayloadJsonBytes || b.costs.toolRounds > a.costs.toolRounds))
        regressions.push({ id: a.id, code: 'COST_FIRST_REQUEST_ONLY_IMPROVEMENT' });
      if (a.evidence?.providerCaptureMethod !== b.evidence?.providerCaptureMethod) errors.push('COST_NON_EQUIVALENT_PROVIDER_CAPTURE');
      if (a.costs.transport?.modelMode !== b.costs.transport?.modelMode) errors.push('COST_NON_EQUIVALENT_MODEL_MODE');
    }
  }
  const successfulPairs = pairs.filter(([a, b]) => a.valid && b?.valid && a.status === 'passed' && b.status === 'passed').length;
  if (!successfulPairs) errors.push('COST_NO_SUCCESSFUL_EQUIVALENT_PAIR');
  return { version: 1, status: errors.length || regressions.length ? 'rejected' : 'comparable', errors: unique(errors), regressions, successfulPairs,
    baseline: runStats(baseline), candidate: runStats(candidate),
    interpretation: 'Hook JSON bytes and reported usage are separate measures. HTTP attempts come only from transport receipts. Unknown wire/token measurements stay null; no per-component token estimates.' };
}
