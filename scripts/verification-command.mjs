import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function safeDiagnostic(bytes) {
  let text = bytes.toString('utf8').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  for (const [key, value] of Object.entries(process.env)) {
    if (/(TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTH)/i.test(key) && value?.length >= 4) text = text.split(value).join('[REDACTED]');
  }
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:secret_|ntn_|sk-)[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/((?:token|secret|password|credential|cookie|authorization|api[-_]?key)["']?\s*[:=]\s*)[^\s,}]+/gi, '$1[REDACTED]').slice(0, 2000);
}

// A strict projection keeps recovery identity without retaining arbitrary stdout.
export function recoveryProjection(value) {
  const allowed = new Set(['ok', 'error', 'code', 'details', 'skill', 'id', 'page_id', 'pageId', 'database_id', 'data_source_id', 'operation_id', 'receipt_path', 'stage', 'completed', 'cause_code', 'cause_details', 'path', 'exit_code', 'reason', 'snapshot_id', 'version_id']);
  const project = item => {
    if (Array.isArray(item)) return item.map(project);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).filter(([key]) => allowed.has(key)).map(([key, entry]) => [key, project(entry)]));
    return typeof item === 'string' ? safeDiagnostic(Buffer.from(item)) : item;
  };
  return project(value);
}

export async function invokeJson(command, args, { input, evidence, cwd, deadline = 120000, category = 'cli' } = {}) {
  const receipt = { category, operation: args[0], startedAt: new Date().toISOString(), stage: 'started' };
  const record = async value => { if (evidence) await appendFile(evidence, JSON.stringify(value) + '\n', { mode: 0o600 }); };
  await record(receipt);
  const stdout = [], stderr = [];
  let expired = false;
  const child = spawn(command[0], [...command.slice(1), ...args], { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  child.stdin.on('error', () => {}); // EPIPE is diagnosed by the observed process exit below.
  const result = await new Promise(accept => {
    let spawnError;
    const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); }, deadline);
    const escalation = setTimeout(() => child.kill('SIGKILL'), deadline + 2000);
    child.once('error', error => { spawnError = error.code ?? 'SPAWN_FAILED'; });
    child.once('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(escalation);
      accept({ code, signal, expired, spawnError });
    });
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
  const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
  let value, jsonError = false;
  try { value = JSON.parse(out.toString('utf8')); } catch { jsonError = true; }
  const failure = result.spawnError ? 'SPAWN_FAILED' : expired ? 'TIMEOUT' : result.code !== 0 ? 'PROCESS_FAILED' : jsonError ? 'INVALID_JSON' : value?.ok === false ? 'CLI_REJECTED' : null;
  const recovery = jsonError ? undefined : recoveryProjection(value);
  await record({ ...receipt, stage: 'finished', finishedAt: new Date().toISOString(), pid: child.pid, ...result,
    stdout: { bytes: out.length, sha256: hash(out), recovery, diagnostic: failure && jsonError ? 'Non-JSON stdout omitted; inspect byte count and hash' : undefined },
    stderr: { bytes: err.length, sha256: hash(err), diagnostic: safeDiagnostic(err) },
    validJson: !jsonError, failure, errorCode: /^[A-Z][A-Z0-9_]{0,79}$/.test(value?.error?.code ?? '') ? value.error.code : undefined });
  if (failure) {
    const error = new Error(`Verification CLI ${failure} (exit=${result.code}, signal=${result.signal}, stderrBytes=${err.length}); inspect command-receipts.jsonl`);
    error.recovery = recovery;
    error.failure = failure;
    throw error;
  }
  return value;
}
