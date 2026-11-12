import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { dailyRouteContract } from './verify-skill-graph-contract.mjs';
import { systemTempRoot } from './verification-paths.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

// This project contains ordinary application code and no Skill, oracle, expected
// leaf name, private resource, generated verification procedure or model answer.
export const ownedProjectFiles = Object.freeze({
  'package.json': JSON.stringify({ name: 'owned-ticket-service', version: '1.0.0', private: true, type: 'module', scripts: { start: 'node src/server.mjs', test: 'node --test test/tickets.test.mjs' } }, null, 2) + '\n',
  'README.md': '# Ticket service\n\nA small local HTTP service for recording a support ticket and looking it up by ID. Data lives in memory and is lost when the process exits.\n\n## Source files\n\n- `package.json`: Node commands; no external dependencies.\n- `src/tickets.mjs`: HTTP routes, validation and in-memory storage.\n- `src/server.mjs`: local listener entry.\n- `test/tickets.test.mjs`: existing automated checks.\n\nRun `npm start` to listen on loopback port 43123, or set `PORT` to a different local port. Run `npm test` for the existing checks.\n\n`POST /tickets` accepts a JSON object with a nonempty `subject` up to 80 characters and optional `priority` (`low`, `normal` or `high`). `GET /tickets/:id` retrieves one ticket. `GET /health` reports readiness. Invalid JSON or fields return 400; an unknown route or ticket returns 404. No endpoint writes to another service or the filesystem.\n',
  'src/server.mjs': "import { makeServer } from './tickets.mjs';\nconst server = makeServer();\nserver.listen(Number(process.env.PORT ?? 43123), '127.0.0.1', () => { console.log(JSON.stringify({ ready: true, address: server.address() })); });\nfor (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());\n",
  'src/tickets.mjs': "import { createServer } from 'node:http';\nimport { randomUUID } from 'node:crypto';\n\nexport function makeServer() {\n  const tickets = new Map();\n  return createServer(async (request, response) => {\n    const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };\n    if (request.method === 'GET' && request.url === '/health') return send(200, { ready: true });\n    if (request.method === 'POST' && request.url === '/tickets') {\n      let source = '';\n      for await (const chunk of request) { source += chunk; if (Buffer.byteLength(source) > 8192) return send(413, { error: 'too_large' }); }\n      let input;\n      try { input = JSON.parse(source); } catch { return send(400, { error: 'invalid_json' }); }\n      if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.subject !== 'string' || !input.subject.trim() || input.subject.trim().length > 80 || !['low', 'normal', 'high'].includes(input.priority ?? 'normal')) return send(400, { error: 'invalid_ticket' });\n      const ticket = { id: randomUUID(), subject: input.subject.trim(), priority: input.priority ?? 'normal' };\n      tickets.set(ticket.id, ticket);\n      return send(201, ticket);\n    }\n    const match = /^\\/tickets\\/([a-f0-9-]+)$/.exec(request.url ?? '');\n    if (request.method === 'GET' && match && tickets.has(match[1])) return send(200, tickets.get(match[1]));\n    return send(404, { error: 'not_found' });\n  });\n}\n",
  'test/tickets.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { makeServer } from '../src/tickets.mjs';\n\nasync function localServer(run) {\n  const server = makeServer();\n  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));\n  try { await run('http://127.0.0.1:' + server.address().port); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }\n}\n\ntest('create and retrieve a validated ticket through HTTP', () => localServer(async origin => {\n  assert.deepEqual(await (await fetch(origin + '/health')).json(), { ready: true });\n  const created = await fetch(origin + '/tickets', { method: 'POST', body: JSON.stringify({ subject: '  Printer offline  ', priority: 'high' }) });\n  assert.equal(created.status, 201);\n  const ticket = await created.json();\n  assert.equal(ticket.subject, 'Printer offline');\n  assert.equal(ticket.priority, 'high');\n  assert.deepEqual(await (await fetch(origin + '/tickets/' + ticket.id)).json(), ticket);\n}));\n\ntest('reject malformed input and missing tickets through HTTP', () => localServer(async origin => {\n  for (const body of ['{', JSON.stringify({ subject: ' ' }), JSON.stringify({ subject: 'a'.repeat(81) }), JSON.stringify({ subject: 'valid', priority: 'urgent' })]) {\n    const response = await fetch(origin + '/tickets', { method: 'POST', body });\n    assert.equal(response.status, 400);\n    assert.ok((await response.json()).error);\n  }\n  assert.equal((await fetch(origin + '/tickets/00000000-0000-4000-8000-000000000000')).status, 404);\n}));\n",
});

function dailySettings(modelProfile) {
  if (modelProfile === undefined) return {};
  assert.deepEqual(modelProfile, dailyRouteContract(modelProfile), 'The owned project requires its exact daily policy');
  return { '.pi/settings.json': JSON.stringify(modelProfile.ownedProjectRetry, null, 2) + '\n' };
}

export async function createOwnedGraphProject(directory, { modelProfile } = {}) {
  await mkdir(directory, { recursive: true });
  for (const [path, content] of Object.entries({ ...ownedProjectFiles, ...dailySettings(modelProfile) })) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content, { flag: 'wx', mode: 0o600 });
  }
  return inspectOwnedGraphProject(directory, { modelProfile });
}

export async function inspectOwnedGraphProject(directory, { modelProfile } = {}) {
  const runtime = dailySettings(modelProfile);
  const root = await realpath(directory);
  const actualPaths = [];
  const walk = async (directory, prefix = '') => { for (const entry of await readdir(directory, { withFileTypes: true })) { const name = prefix + entry.name; if (entry.isDirectory()) await walk(join(directory, entry.name), name + '/'); else { assert.ok(entry.isFile(), 'Owned project cannot contain symlinks or special files'); actualPaths.push(name); } } };
  await walk(root);
  assert.deepEqual(actualPaths.sort(), [...Object.keys(ownedProjectFiles), ...Object.keys(runtime)].sort(), 'The owned application inventory must remain complete and unchanged');
  const files = [];
  for (const [path, expected] of Object.entries(ownedProjectFiles)) {
    assert.equal(await realpath(join(root, path)), join(root, path), 'Owned project source cannot be a symlink');
    const bytes = await readFile(join(root, path));
    assert.equal(hash(bytes), hash(expected), 'Owned project source changed during the read-only model gate');
    files.push({ path, sha256: hash(bytes), bytes: bytes.length });
  }
  let runtimeSettings;
  for (const [path, expected] of Object.entries(runtime)) {
    assert.equal(await realpath(join(root, path)), join(root, path), 'Owned runtime settings cannot be a symlink');
    const bytes = await readFile(join(root, path));
    assert.equal(hash(bytes), hash(expected), 'Owned runtime settings changed during the model gate');
    runtimeSettings = { path, bytes: bytes.length, sha256: hash(bytes), modelContract: modelProfile.modelContract };
  }
  return { version: 1, root, files, sha256: hash(JSON.stringify(files)), ...(runtimeSettings ? { runtimeSettings } : {}), source: 'fixed owned local application; no Skill or private oracle material' };
}

function scanGeneratedFiles(text, { projectRoot } = {}) {
  const lines = [...text.matchAll(/[^\r\n]*(?:\r\n|\n|$)/g)].filter(match => match[0].length).map(match => ({ text: match[0].replace(/\r?\n$/, ''), start: match.index, end: match.index + match[0].length }));
  const cleanPath = value => {
    let path = value.trim().replace(/^#{1,6}\s+/, '').replace(/^\d+(?:\.\d+)*[.)]?\s+/, '');
    if (/^\*\*.*\*\*$/.test(path)) path = path.slice(2, -2);
    path = path.replace(/^(?:\*\*)?(?:save\s+(?:the\s+)?file|file(?:\s+path)?|path|文件路径|文件|路径)\s*[:：](?:\*\*)?\s*/i, '').trim();
    if (/^\*\*.*\*\*$/.test(path)) path = path.slice(2, -2);
    const quoted = /^`([^`]+)`(?:\s+\(([^()\r\n]*)\)[.!]?)?$/.exec(path);
    // A location note may name directories, but cannot offer a second file.
    const noteHasFilePath = /(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+(?=$|[\s`"'.,;:!?])/.test(quoted?.[2] ?? '');
    if (quoted && !noteHasFilePath) path = quoted[1];
    if (path.includes('//') || path.split('/').some(part => ['.', '..'].includes(part))) return undefined;
    if (path.startsWith('/')) {
      if (typeof projectRoot !== 'string' || !projectRoot.startsWith('/')) return undefined;
      path = relative(projectRoot, path);
    }
    return /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(path) && !path.split('/').some(part => ['.', '..'].includes(part)) ? path : undefined;
  };
  const files = new Map();
  const issues = [];
  const fenceLine = line => /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
  for (let index = 0; index < lines.length; index++) {
    const opening = fenceLine(lines[index].text); if (!opening) continue;
    const fence = opening[1], info = opening[2].trim();
    let file = cleanPath(info)
      ?? cleanPath(/(?:file|path|title)\s*=\s*["']?([^\s"']+)/i.exec(info)?.[1] ?? '')
      ?? cleanPath(/^\S+\s+path\s*:\s*["']?([^\s"']+)/i.exec(info)?.[1] ?? '');
    if (!file) for (let previous = index - 1; previous >= Math.max(0, index - 4); previous--) { if (!lines[previous].text.trim()) continue; file = cleanPath(lines[previous].text); break; }
    let bodyStart = lines[index].end;
    if (!file) {
      file = cleanPath(lines[index + 1]?.text ?? '');
      if (file) bodyStart = lines[index + 1].end;
    }
    let end = index + 1;
    for (; end < lines.length; end++) {
      const boundary = fenceLine(lines[end].text);
      if (!boundary || boundary[1][0] !== fence[0] || boundary[1].length < fence.length) continue;
      if (!boundary[2].trim()) break;
      if (file) {
        issues.push({ code: 'AMBIGUOUS_FILE_FENCE', path: file, openingLine: index + 1, line: end + 1 });
        // A same-length nested opening makes the later closing boundary
        // ambiguous. Preserve the raw plan instead of extracting a prefix or
        // guessing where another top-level file begins.
        return { files: [...files.values()], issues };
      }
    }
    if (end === lines.length) {
      if (file) issues.push({ code: 'UNCLOSED_FILE_FENCE', path: file, openingLine: index + 1 });
      break;
    }
    if (file && bodyStart !== lines[index].end) {
      const bodyLines = lines.slice(index + 1, end).map(line => line.text).filter(line => line.trim());
      // Without an explicit filename, multiple bare paths describe an inventory.
      // A named file or a first-line path label still retains path-only content.
      if (bodyLines.length > 1 && bodyLines.every(line => cleanPath(line) === line)) {
        index = end;
        continue;
      }
    }
    if (file) {
      const content = text.slice(bodyStart, lines[end].start);
      assert.ok(content.trim(), 'A named generated file cannot be empty');
      assert.ok(!files.has(file) || files.get(file).content === content, 'A generated file has conflicting complete definitions');
      files.set(file, { path: file, content, sha256: hash(content), bytes: Buffer.byteLength(content), sourceSpan: { start: bodyStart, end: lines[end].start } });
    }
    index = end;
  }
  return { files: [...files.values()], issues };
}

export function extractGeneratedFiles(text, options) {
  return scanGeneratedFiles(text, options).files;
}

export async function retainGeneratedPlan({ evidence, final, prompt, project }) {
  if (!final?.success || !final.text?.trim()) return { status: 'missing', executed: false };
  const path = join(evidence, 'generated-acceptance-plan.md');
  await writeFile(path, final.text, { mode: 0o600 });
  const { files, issues: fileExtractionIssues } = scanGeneratedFiles(final.text, { projectRoot: project.root });
  const skillFiles = files.filter(file => {
    if (!file.path.endsWith('/SKILL.md')) return false;
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(file.content);
    return Boolean(frontmatter && /^name:\s*["']?[a-z0-9][a-z0-9-]*["']?\s*$/m.test(frontmatter[1]) && /^description:\s*\S.+$/m.test(frontmatter[1]) && file.content.slice(frontmatter[0].length).trim());
  });
  const available = new Set([...files.map(file => file.path), ...project.files.map(file => file.path)]), unresolvedReferences = [];
  for (const file of files) for (const match of file.content.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
    const href = match[1]; if (/^(?:https?:|skill:|#)/i.test(href)) continue;
    const target = relative('/owned-generated-project', resolve('/owned-generated-project', dirname(file.path), href.split('#')[0]));
    if (target.startsWith('../') || !available.has(target)) unresolvedReferences.push({ from: file.path, href });
  }
  for (const file of files) { const output = join(evidence, 'generated-files', file.path); await mkdir(dirname(output), { recursive: true }); await writeFile(output, file.content, { mode: 0o600 }); }
  const artifactStatus = skillFiles.length > 0 && unresolvedReferences.length === 0 && fileExtractionIssues.length === 0 ? 'complete-skill-files-retained' : files.length ? 'incomplete-generated-files' : 'plan-only';
  const receipt = { version: 1, status: 'plan-retained', artifactStatus, path, sha256: hash(final.text), bytes: Buffer.byteLength(final.text), promptSha256: prompt.sha256, projectSha256: project.sha256, files: files.map(({ content, ...file }) => ({ ...file, evidencePath: 'generated-files/' + file.path })), skillFiles: skillFiles.map(file => file.path), unresolvedReferences, fileExtractionIssues, executed: false, proof: 'Exact model final and explicitly named complete file blocks only; prose alone is not accepted as a generated Skill, and no execution is inferred' };
  await save(join(evidence, 'generated-plan.json'), receipt);
  return receipt;
}

export async function exerciseExistingProjectCommand(evidence, command) {
  const result = JSON.parse(await readFile(join(evidence, 'result.json'), 'utf8'));
  assert.equal(await realpath(evidence), result.evidence);
  assert.equal(result.status, 'passed', 'Complete the real graph/model gate before driving its generated procedure');
  const receipt = JSON.parse(await readFile(join(evidence, 'generated-plan.json'), 'utf8'));
  const plan = await readFile(receipt.path, 'utf8');
  assert.equal(hash(plan), receipt.sha256, 'The generated plan must retain the actual model bytes');
  const project = await inspectOwnedGraphProject(result.project.root, { modelProfile: result.modelProfile });
  assert.equal(project.sha256, receipt.projectSha256);
  assert.equal(receipt.artifactStatus, 'complete-skill-files-retained', 'A prose-only summary cannot stand in for a complete generated Skill file');
  const generatedFiles = await Promise.all(receipt.files.map(async file => { const content = await readFile(join(evidence, file.evidencePath), 'utf8'); assert.equal(hash(content), file.sha256); return { ...file, content }; }));
  const permitted = [ ['npm', 'test'], ['npm', 'run', 'test'], ['node', '--test'], ['node', '--test', 'test/tickets.test.mjs'] ];
  assert.ok(permitted.some(args => JSON.stringify(args) === JSON.stringify(command)), 'Choose one exact generated local test command; no shell or arbitrary program is admitted');
  const spelling = command.join(' ');
  const inline = generatedFiles.flatMap(file => [...file.content.matchAll(/`([^`\n]+)`/g)].map(match => ({ file: file.path, fileSha256: file.sha256, text: match[1], start: match.index + 1 })));
  const lines = generatedFiles.flatMap(file => [...file.content.matchAll(/^\s*(?:\$ )?([^\n]+)\s*$/gm)].map(match => ({ file: file.path, fileSha256: file.sha256, text: match[1].trim(), start: match.index })));
  const selected = [...inline, ...lines].find(item => item.text === spelling);
  assert.ok(selected, 'The selected command must occur verbatim inside an actual complete generated file');
  const home = join(dirname(project.root), 'procedure-home');
  await mkdir(home, { recursive: true });
  const file = process.execPath;
  const args = command[0] === 'node' ? command.slice(1) : [await realpath(join(dirname(process.execPath), 'npm')), ...command.slice(1)];
  const startedAt = new Date().toISOString();
  const child = spawn(file, args, { cwd: project.root, env: { PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter), HOME: home, TMPDIR: home, npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [], stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk));
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 20000);
  const escalation = setTimeout(() => child.kill('SIGKILL'), 22000);
  const closed = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal })); }).finally(() => { clearTimeout(timer); clearTimeout(escalation); });
  const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
  await writeFile(join(evidence, 'existing-project-check.stdout.log'), out, { mode: 0o600 });
  await writeFile(join(evidence, 'existing-project-check.stderr.log'), err, { mode: 0o600 });
  const execution = { version: 1, kind: 'existing-project-check', status: closed.code === 0 && !timedOut ? 'passed' : 'failed', command, executable: file, executableArgs: args, cwd: project.root, pid: child.pid, owned: true, startedAt, finishedAt: new Date().toISOString(), spawnObserved: Boolean(child.pid), closeObserved: true, ...closed, timedOut, planSha256: receipt.sha256, generatedCommandSpan: selected, projectSha256: project.sha256, stdoutSha256: hash(out), stderrSha256: hash(err), scope: 'One allowlisted existing application test command; generated helper files were neither installed nor executed, and the text match does not establish an instruction to run it' };
  await inspectOwnedGraphProject(project.root, { modelProfile: result.modelProfile });
  await save(join(evidence, 'existing-project-check.json'), execution);
  result.existingProjectCheck = execution;
  result.productAcceptance = { ...result.productAcceptance, existingProjectCheckStatus: execution.status, generatedProcedureExecuted: false, scope: execution.scope };
  result.files = [...new Set([...result.files, 'existing-project-check.stdout.log', 'existing-project-check.stderr.log', 'existing-project-check.json'])];
  await save(join(evidence, 'result.json'), result);
  return execution;
}

function generatedPath(path) {
  assert.ok(typeof path === 'string' && /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(path)
    && !path.split('/').some(part => ['.', '..'].includes(part)), 'Generated files require a safe relative path');
  assert.ok(!['.pi', '.git', 'node_modules'].includes(path.split('/')[0]), 'Generated files cannot install runtime settings, repository state or dependencies');
  assert.ok(!Object.hasOwn(ownedProjectFiles, path), 'Generated files cannot overwrite the fixed application');
  return path;
}

const within = (root, path) => path === root || path.startsWith(root + '/');
async function ordinaryFile(path) {
  assert.ok((await lstat(path)).isFile(), 'Exercise evidence must be an ordinary file');
  assert.equal(await realpath(path), path, 'Exercise evidence cannot traverse a symlink');
  return readFile(path);
}

function retainedFailedFinal(original, result, retention, native) {
  assert.equal(result.scope, 'project-scoped-candidate-print'); assert.equal(result.status, 'failed');
  assert.ok(['normal', 'notion-only'].includes(result.arm)); assert.equal(result.generatedPlan, undefined);
  assert.equal(result.process?.timedOut, true); assert.equal(result.process.signal, 'SIGTERM'); assert.notEqual(result.process.code, 0);
  assert.ok(Number.isSafeInteger(result.process.pid) && result.process.pid > 0);
  assert.ok(/^[0-9]+$/u.test(result.process.startedNs) && /^[0-9]+$/u.test(result.process.endedNs)
    && BigInt(result.process.endedNs) > BigInt(result.process.startedNs), 'The failed source process must be terminal');
  assert.equal(result.error?.code, 'ERR_ASSERTION'); assert.ok(result.error.message.startsWith('Native print process failed'));
  assert.ok(!result.validationError && !result.sharedTechnicalFailure);
  for (const field of ['normalConfigurationUnchanged', 'baselineFilesUnchanged', 'projectFilesUnchanged', 'originalSessionUnchanged']) assert.equal(result[field], true);
  assert.equal(retention.version, 1); assert.equal(retention.kind, 'retained-complete-native-final');
  assert.equal(retention.status, 'retained-not-executed'); assert.equal(retention.originalOutcomeUnchanged, true);
  assert.deepEqual(retention.originalGeneration, { path: join(result.evidence, 'result.json'), bytes: original.length, sha256: hash(original),
    status: result.status, process: result.process, error: result.error });
  assert.deepEqual(retention.session, result.session);
  assert.equal(native.length, result.session.bytes); assert.equal(hash(native), result.session.sha256);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(native); assert.ok(text.endsWith('\n'));
  const rows = text.trimEnd().split('\n').map(JSON.parse), last = rows.at(-1), users = rows.filter(row => row.type === 'message' && row.message?.role === 'user');
  assert.equal(users.length, result.expectedUserMessages); assert.ok(users.length > 0);
  assert.equal(last?.type, 'message'); assert.equal(last.message?.role, 'assistant'); assert.equal(last.message.stopReason, 'stop', 'Only the real last complete stop final may supply artifacts');
  const body = message => typeof message.content === 'string' ? message.content : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  const final = Buffer.from(body(last.message)); assert.ok(final.length > 0);
  assert.deepEqual(retention.final, { entryId: last.id, stopReason: 'stop', bytes: final.length, sha256: hash(final) });
  const prompt = Buffer.from(body(users.at(-1).message));
  assert.deepEqual(retention.prompt, { bytes: prompt.length, sha256: hash(prompt) });
  assert.equal(retention.generatedPlan.promptSha256, hash(prompt));
  assert.equal(retention.generatedPlan.sha256, hash(final)); assert.equal(retention.generatedPlan.bytes, final.length);
  return final;
}

/** Read-only admission; no execution directory or process is created here. */
export async function reviewedHelperInputs(evidence, reviewPath) {
  assert.ok(isAbsolute(evidence) && isAbsolute(reviewPath), 'Use absolute evidence and independent review paths');
  assert.equal(await realpath(evidence), evidence);
  const original = await ordinaryFile(join(evidence, 'result.json')), result = JSON.parse(original);
  assert.equal(result.evidence, evidence);
  assert.ok(!within(evidence, reviewPath) && !within(result.scratch ?? result.project.root, reviewPath)
    && !within(result.project.root, reviewPath), 'Independent review must stay outside consumer and generated evidence roots');
  const reviewBytes = await ordinaryFile(reviewPath), review = JSON.parse(reviewBytes);
  assert.equal(review.version, 1); assert.equal(review.purpose, 'generated-helper-exercise');
  assert.ok(typeof review.reviewer === 'string' && review.reviewer.trim());
  assert.equal(review.approvedForOwnedExercise, true, 'The controller must review the complete helper before exercise');
  let artifactEvidence = evidence, artifactAdmission, retention, retentionBytes, nativeBytes, sourceFinal;
  if (review.artifactAdmission === undefined) {
    assert.equal(result.status, 'passed', 'A failed graph/model prerequisite cannot authorize helper execution');
    assert.ok(!result.error && !result.validationError && !result.sharedTechnicalFailure, 'A retained technical failure blocks helper execution');
    assert.ok(!result.turns || result.turns.every(turn => turn.status === 'passed'), 'Every original turn must pass its technical prerequisite');
  } else {
    const admission = review.artifactAdmission;
    assert.deepEqual(Object.keys(admission).sort(), ['mode', 'retention']);
    assert.equal(admission.mode, 'reviewed-complete-failed-final');
    assert.deepEqual(Object.keys(admission.retention).sort(), ['path', 'sha256']);
    assert.ok(isAbsolute(admission.retention.path) && /^[a-f0-9]{64}$/u.test(admission.retention.sha256));
    artifactEvidence = dirname(admission.retention.path);
    assert.ok(!within(evidence, artifactEvidence) && !within(artifactEvidence, evidence)
      && !within(result.scratch ?? result.project.root, artifactEvidence) && !within(artifactEvidence, reviewPath), 'Retained artifacts and independent review need separate evidence roots');
    retentionBytes = await ordinaryFile(admission.retention.path); assert.equal(hash(retentionBytes), admission.retention.sha256);
    retention = JSON.parse(retentionBytes);
    assert.ok(within(evidence, result.session.path)); nativeBytes = await ordinaryFile(result.session.path);
    sourceFinal = retainedFailedFinal(original, result, retention, nativeBytes);
    let present = true;
    try { process.kill(result.process.pid, 0); } catch (error) { if (error.code !== 'ESRCH') throw error; present = false; }
    assert.equal(present, false, 'The original failed process must be absent before artifact exercise');
    artifactAdmission = { mode: admission.mode, retention: { ...admission.retention, bytes: retentionBytes.length },
      originalModelStatus: 'failed', arm: result.arm, sourceSession: result.session, final: retention.final };
  }
  const receiptBytes = await ordinaryFile(join(artifactEvidence, 'generated-plan.json')), receipt = JSON.parse(receiptBytes);
  assert.deepEqual(receipt, retention?.generatedPlan ?? result.generatedPlan, 'Generated-file metadata must match its explicitly bound source');
  assert.equal(receipt.artifactStatus, 'complete-skill-files-retained', 'Incomplete generated files cannot be exercised');
  assert.equal(receipt.path, join(artifactEvidence, 'generated-acceptance-plan.md'));
  const plan = await ordinaryFile(receipt.path);
  assert.equal(hash(plan), receipt.sha256, 'The actual final bytes changed');
  assert.equal(plan.length, receipt.bytes);
  if (sourceFinal) assert.ok(plan.equals(sourceFinal), 'Retained final must exactly equal the last native stop response');
  const expectedProject = Object.entries(ownedProjectFiles).map(([path, content]) => ({ path, sha256: hash(content), bytes: Buffer.byteLength(content) }));
  assert.deepEqual(result.project.files, expectedProject, 'Exercise must copy the original fixed application');
  assert.equal(result.project.sha256, hash(JSON.stringify(expectedProject)));
  assert.equal(receipt.projectSha256, result.project.sha256);
  const extracted = scanGeneratedFiles(plan.toString('utf8'), { projectRoot: result.project.root });
  assert.deepEqual(extracted.issues, []);
  assert.deepEqual(extracted.files.map(({ content, ...file }) => ({ ...file, evidencePath: 'generated-files/' + file.path })), receipt.files, 'Bind every complete extracted file, not a selected prefix');
  const files = [];
  for (const file of receipt.files) {
    generatedPath(file.path);
    const bytes = await ordinaryFile(join(artifactEvidence, file.evidencePath));
    assert.equal(hash(bytes), file.sha256, 'A retained generated file changed'); assert.equal(bytes.length, file.bytes);
    files.push({ ...file, content: bytes });
  }
  const allPaths = [...Object.keys(ownedProjectFiles), ...files.map(file => file.path)];
  assert.ok(allPaths.every(path => !allPaths.some(other => other !== path && path.startsWith(other + '/'))), 'Generated files cannot replace an existing file with a directory');
  assert.ok(files.length && receipt.skillFiles.length, 'A complete generated Skill is required');
  const parent = { evidence, resultSha256: hash(original), planSha256: receipt.sha256, projectSha256: result.project.sha256,
    files: files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })) };
  assert.deepEqual(review.parent, parent, 'Independent review must bind the original result, final and every file');
  const entry = files.find(file => file.path === review.entry?.path);
  assert.ok(entry && /\.(?:mjs|cjs|js)$/.test(entry.path), 'Review must select one complete generated Node helper');
  assert.equal(review.entry.sha256, entry.sha256);
  assert.equal(review.command?.executable, await realpath(process.execPath), 'Only the current explicit Node executable is admitted');
  assert.ok(Array.isArray(review.command.args) && review.command.args.length >= 1
    && review.command.args.every(value => typeof value === 'string' && !value.includes('\0')));
  assert.equal(review.command.args[0], entry.path, 'Node must execute the exact reviewed entry, without interpreter flags');
  assert.ok(Number.isSafeInteger(review.budget?.timeoutMs) && review.budget.timeoutMs > 0 && review.budget.timeoutMs <= 20000);
  assert.ok(Number.isSafeInteger(review.budget.killGraceMs) && review.budget.killGraceMs > 0 && review.budget.killGraceMs <= 2000);
  return { result, original, receipt, receiptBytes, plan, files, parent, review, reviewBytes, entry,
    ...(artifactAdmission ? { artifactAdmission, retentionBytes, nativeBytes } : {}) };
}

function processGroupPresent(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(-pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function runReviewedNode({ executable, args, cwd, home, budget }) {
  const events = [], stdout = [], stderr = [], startedAt = new Date().toISOString();
  // This is an explicit reviewed-program runner, not an OS sandbox. The controller
  // reviews all bytes/arguments and owns the loopback resources the helper uses.
  const child = spawn(executable, args, { cwd, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: [dirname(executable), '/usr/bin', '/bin'].join(delimiter), HOME: home, TMPDIR: home,
      XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home,
      npm_config_userconfig: join(home, 'empty-npmrc'), npm_config_globalconfig: join(home, 'empty-npmrc'),
      npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' } });
  child.stdout.on('data', bytes => stdout.push(bytes)); child.stderr.on('data', bytes => stderr.push(bytes));
  child.once('spawn', () => events.push({ event: 'spawn', pid: child.pid, time: new Date().toISOString() }));
  let timedOut = false, spawnError, processExit, stdoutComplete = false, stderrComplete = false, forcedPipeClosure = false;
  child.stdout.once('end', () => { stdoutComplete = true; }); child.stderr.once('end', () => { stderrComplete = true; });
  child.once('exit', (code, signal) => { processExit = { code, signal }; events.push({ event: 'exit', pid: child.pid, code, signal, time: new Date().toISOString() }); });
  const signal = value => {
    if (!processGroupPresent(child.pid)) return;
    try { process.kill(-child.pid, value); events.push({ event: 'signal', signal: value, processGroup: child.pid, time: new Date().toISOString() }); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const timer = setTimeout(() => { timedOut = true; signal('SIGTERM'); }, budget.timeoutMs);
  const escalation = setTimeout(() => signal('SIGKILL'), budget.timeoutMs + budget.killGraceMs);
  let hardDeadline;
  const closed = await new Promise(accept => {
    child.once('error', error => { spawnError = { code: error.code, message: error.message }; });
    child.once('close', (code, signal) => { events.push({ event: 'close', pid: child.pid, code, signal, afterForcedPipeClosure: forcedPipeClosure, time: new Date().toISOString() }); accept({ code, signal, closeObserved: !forcedPipeClosure }); });
    hardDeadline = setTimeout(() => {
      forcedPipeClosure = true;
      events.push({ event: 'hard-deadline', time: new Date().toISOString(), stdoutComplete, stderrComplete,
        action: 'Destroy only runner-owned pipes; their closure is not natural EOF or child-process finality' });
      // A detached child can retain inherited output descriptors after the known
      // group exits. Do not wait forever or signal an unobserved PID to force EOF.
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      accept({ code: processExit?.code ?? null, signal: processExit?.signal ?? null, closeObserved: false });
    }, budget.timeoutMs + 2 * budget.killGraceMs);
  }).finally(() => { clearTimeout(timer); clearTimeout(escalation); clearTimeout(hardDeadline); });
  // A reviewed helper may spawn its own owned service. Reap only this new group,
  // including children that survived an otherwise successful helper exit.
  if (processGroupPresent(child.pid)) {
    signal('SIGTERM');
    const deadline = Date.now() + budget.killGraceMs;
    while (processGroupPresent(child.pid) && Date.now() < deadline) await new Promise(accept => setTimeout(accept, 20));
    if (processGroupPresent(child.pid)) signal('SIGKILL');
    const killDeadline = Date.now() + budget.killGraceMs;
    while (processGroupPresent(child.pid) && Date.now() < killDeadline) await new Promise(accept => setTimeout(accept, 20));
  }
  return { version: 1, kind: 'reviewed-generated-helper', status: closed.code === 0 && closed.closeObserved && stdoutComplete && stderrComplete && !timedOut && !spawnError && !processGroupPresent(child.pid) ? 'completed' : 'failed',
    executable, args, cwd, pid: child.pid ?? null, processGroup: child.pid ?? null, startedAt, finishedAt: new Date().toISOString(),
    spawnObserved: events.some(event => event.event === 'spawn'), processExitObserved: Boolean(processExit), processExit,
    ...closed, timedOut, forcedPipeClosure, stdoutComplete, stderrComplete,
    processScope: forcedPipeClosure ? 'incomplete-finality-unknown-pipe-holder' : 'reviewed-owned-group',
    processGroupAbsent: !processGroupPresent(child.pid), ...(spawnError ? { spawnError } : {}), events: [...events],
    stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

async function retainExerciseFile(evidence, artifacts, path, bytes) {
  await mkdir(dirname(join(evidence, path)), { recursive: true });
  await writeFile(join(evidence, path), bytes, { flag: 'wx', mode: 0o600 });
  artifacts.push({ path, bytes: bytes.length, sha256: hash(bytes) });
}

export async function exerciseReviewedGeneratedHelper(evidence, reviewPath) {
  const input = await reviewedHelperInputs(evidence, reviewPath); // Nothing is spawned or installed before this boundary.
  const output = await mkdtemp(join(dirname(evidence), 'graph-generated-exercise-'));
  const artifacts = [];
  const result = { version: 1, kind: 'generated-helper-exercise', status: 'running', stage: 'allocate-scratch', evidence: output, scratch: null,
    parent: input.parent, review: { path: reviewPath, sha256: hash(input.reviewBytes), reviewer: input.review.reviewer },
    ...(input.artifactAdmission ? { artifactAdmission: input.artifactAdmission } : {}),
    project: null, installedFiles: [], entry: input.review.entry, command: input.review.command, budget: input.review.budget,
    productAcceptance: { status: 'independent-review-required', scope: 'Execution records one reviewed helper invocation; HTTP, feature behavior, omissions and side effects still require independent review' }, artifacts };
  await save(join(output, 'result.json'), result);
  let spawnAttempted = false;
  try {
    const scratch = result.scratch = await mkdtemp(join(await systemTempRoot(), 'graph-generated-exercise-'));
    const owner = result.owner = { purpose: 'generated-helper-exercise', runId: randomUUID(), evidence: output, scratch };
    result.stage = 'write-ownership'; await save(join(output, 'result.json'), result);
    await save(join(scratch, 'ownership.json'), owner);
    for (const [path, bytes] of [
      ['ownership.json', Buffer.from(JSON.stringify(owner, null, 2) + '\n')], ['independent-review.json', input.reviewBytes],
      ['parent-result.json', input.original], ['parent-generated-plan.json', input.receiptBytes], ['generated-acceptance-plan.md', input.plan],
      ...(input.artifactAdmission ? [['artifact-retention.json', input.retentionBytes], ['parent-native.jsonl', input.nativeBytes]] : []),
    ]) await retainExerciseFile(output, artifacts, path, bytes);
    result.stage = 'create-project';
    const project = result.project = await createOwnedGraphProject(join(scratch, 'project'));
    assert.equal(project.sha256, input.parent.projectSha256);
    result.stage = 'install-generated-files';
    for (const file of input.files) {
      const target = join(project.root, file.path); await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, { flag: 'wx', mode: 0o600 });
      assert.equal(hash(await ordinaryFile(target)), file.sha256, 'Installed helper bytes differ from the reviewed file');
      await retainExerciseFile(output, artifacts, 'reviewed-files/' + file.path, file.content);
      result.installedFiles.push({ path: file.path, sha256: file.sha256, bytes: file.bytes });
    }
    result.stage = 'create-home';
    const home = join(scratch, 'home'); await mkdir(home); await writeFile(join(home, 'empty-npmrc'), '', { flag: 'wx', mode: 0o600 });
    result.stage = 'execute-helper'; await save(join(output, 'result.json'), result); spawnAttempted = true;
    const { stdout, stderr, ...execution } = await runReviewedNode({ ...input.review.command, cwd: project.root, home, budget: input.review.budget });
    result.execution = { ...execution, entrySha256: input.entry.sha256, planSha256: input.parent.planSha256 };
    result.stage = 'retain-output';
    await retainExerciseFile(output, artifacts, 'helper.stdout.log', stdout);
    await retainExerciseFile(output, artifacts, 'helper.stderr.log', stderr);
    result.status = execution.status;
    const archive = async (directory, prefix = '') => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = prefix + entry.name, absolute = join(directory, entry.name);
        if (entry.isDirectory()) await archive(absolute, path + '/');
        else { assert.ok(entry.isFile(), 'Owned output cannot contain symlinks or special files'); await retainExerciseFile(output, artifacts, 'owned-output/' + path, await ordinaryFile(absolute)); }
      }
    };
    await archive(project.root);
    for (const file of [...project.files, ...input.parent.files]) {
      assert.equal(hash(await ordinaryFile(join(project.root, file.path))), file.sha256, 'The helper changed reviewed or fixed source bytes');
    }
    result.stage = 'finished';
  } catch (error) {
    result.status = 'failed'; result.error = { code: error.code ?? 'GENERATED_HELPER_EXERCISE_FAILED', message: error.message, stage: result.stage };
    result.execution ??= { kind: 'reviewed-generated-helper', status: spawnAttempted ? 'unknown' : 'not_run',
      spawnObserved: spawnAttempted ? null : false, closeObserved: false, processGroupAbsent: !spawnAttempted, reason: 'setup_or_execution_failed' };
  }
  result.finishedAt = new Date().toISOString();
  await save(join(output, 'result.json'), result);
  return result;
}

export async function inspectGeneratedExercise(evidence) {
  assert.equal(await realpath(evidence), evidence);
  const result = JSON.parse(await ordinaryFile(join(evidence, 'result.json')));
  assert.equal(result.kind, 'generated-helper-exercise'); assert.equal(result.evidence, evidence);
  for (const file of result.artifacts) {
    assert.ok(!isAbsolute(file.path) && !file.path.split('/').some(part => ['.', '..', ''].includes(part)));
    const bytes = await ordinaryFile(join(evidence, file.path)); assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256);
  }
  const notRun = result.execution?.status === 'not_run' && result.execution.spawnObserved === false;
  const retained = path => result.artifacts.some(file => file.path === path);
  for (const [path, expected] of [['parent-result.json', result.parent.resultSha256], ['independent-review.json', result.review.sha256], ['generated-acceptance-plan.md', result.parent.planSha256]]) {
    if (retained(path)) assert.equal(hash(await ordinaryFile(join(evidence, path))), expected);
    else assert.ok(notRun, 'An invoked helper must retain all reviewed inputs');
  }
  if (retained('independent-review.json')) {
    const review = JSON.parse(await ordinaryFile(join(evidence, 'independent-review.json')));
    assert.deepEqual(result.parent, review.parent); assert.deepEqual(result.command, review.command);
    assert.deepEqual(result.entry, review.entry); assert.deepEqual(result.budget, review.budget);
  }
  if (result.artifactAdmission) {
    const required = ['parent-result.json', 'artifact-retention.json', 'parent-native.jsonl', 'generated-acceptance-plan.md', 'parent-generated-plan.json', 'independent-review.json'];
    if (!required.every(retained)) assert.ok(notRun, 'An artifact-only invocation must retain its original failed source and full native');
    else {
      const original = await ordinaryFile(join(evidence, 'parent-result.json')), parent = JSON.parse(original);
      const retentionBytes = await ordinaryFile(join(evidence, 'artifact-retention.json')), retention = JSON.parse(retentionBytes);
      const review = JSON.parse(await ordinaryFile(join(evidence, 'independent-review.json')));
      assert.equal(result.artifactAdmission.mode, 'reviewed-complete-failed-final');
      assert.deepEqual(review.artifactAdmission, { mode: result.artifactAdmission.mode,
        retention: { path: result.artifactAdmission.retention.path, sha256: hash(retentionBytes) } });
      assert.equal(result.artifactAdmission.retention.sha256, hash(retentionBytes)); assert.equal(result.artifactAdmission.retention.bytes, retentionBytes.length);
      assert.equal(result.artifactAdmission.originalModelStatus, 'failed'); assert.equal(result.artifactAdmission.arm, parent.arm);
      assert.deepEqual(result.artifactAdmission.sourceSession, parent.session); assert.deepEqual(result.artifactAdmission.final, retention.final);
      const final = retainedFailedFinal(original, parent, retention, await ordinaryFile(join(evidence, 'parent-native.jsonl')));
      assert.ok(final.equals(await ordinaryFile(join(evidence, 'generated-acceptance-plan.md'))));
      assert.deepEqual(retention.generatedPlan, JSON.parse(await ordinaryFile(join(evidence, 'parent-generated-plan.json'))));
    }
  }
  if (!notRun) assert.deepEqual(result.installedFiles, result.parent.files);
  for (const file of result.installedFiles) assert.equal(hash(await ordinaryFile(join(evidence, 'reviewed-files', generatedPath(file.path)))), file.sha256);
  assert.notEqual(result.status, 'running', 'Wait for the owned helper to finish before inspecting or cleaning its evidence');
  if (result.execution?.spawnObserved === true) {
    assert.deepEqual(result.execution.args, result.command.args); assert.equal(result.execution.executable, result.command.executable);
    assert.equal(result.execution.entrySha256, result.entry.sha256); assert.equal(result.execution.planSha256, result.parent.planSha256);
  }
  if (result.status === 'completed') {
    assert.equal(result.execution.status, 'completed'); assert.equal(result.execution.spawnObserved, true);
    assert.equal(result.execution.code, 0); assert.equal(result.execution.timedOut, false);
    assert.ok(result.execution.closeObserved && result.execution.processExitObserved && result.execution.processGroupAbsent);
    assert.ok(result.execution.stdoutComplete && result.execution.stderrComplete && !result.execution.forcedPipeClosure);
  }
  if (result.scratch === null) assert.ok(notRun);
  else {
    let present = true;
    try { assert.ok((await lstat(result.scratch)).isDirectory()); } catch (error) { if (error.code !== 'ENOENT') throw error; present = false; }
    if (present) await inspectExerciseOwnership(result);
    else assert.deepEqual(JSON.parse(await ordinaryFile(join(evidence, 'cleanup.json'))), { status: 'trashed', scratch: result.scratch, evidencePreserved: true,
      resultSha256: hash(await ordinaryFile(join(evidence, 'result.json'))) }, 'Cleanup must bind the immutable exercise result');
  }
  return { status: 'preserved', kind: result.kind, functionalStatus: result.status, evidence, files: result.artifacts.length,
    productAcceptance: result.productAcceptance, result };
}

async function inspectExerciseOwnership(result) {
  assert.equal(result.owner.purpose, 'generated-helper-exercise'); assert.equal(result.owner.evidence, result.evidence);
  assert.equal(result.owner.scratch, result.scratch);
  assert.equal(dirname(await realpath(result.scratch)), await systemTempRoot());
  try { assert.deepEqual(JSON.parse(await ordinaryFile(join(result.scratch, 'ownership.json'))), result.owner); }
  catch (error) {
    if (error.code !== 'ENOENT' || result.stage !== 'write-ownership' || result.execution?.status !== 'not_run') throw error;
    assert.deepEqual(await readdir(result.scratch), [], 'Only an empty, just-allocated owned directory can lack its ownership file');
  }
}

export async function cleanupGeneratedExercise(evidence) {
  const retained = await inspectGeneratedExercise(evidence), result = retained.result;
  assert.ok(result.execution?.status === 'not_run' && result.execution.spawnObserved === false
    || result.execution?.closeObserved && result.execution.processExitObserved && result.execution.processGroupAbsent && !result.execution.forcedPipeClosure,
  'Observed helper/process finality is required before cleanup; forced pipe destruction cannot establish it');
  if (result.scratch === null) {
    await save(join(evidence, 'cleanup.json'), { status: 'not-created', scratch: null, evidencePreserved: true, resultSha256: hash(await ordinaryFile(join(evidence, 'result.json'))) });
    return { ...retained, cleanup: 'not-created' };
  }
  try { await lstat(result.scratch); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    assert.deepEqual(JSON.parse(await ordinaryFile(join(evidence, 'cleanup.json'))), { status: 'trashed', scratch: result.scratch, evidencePreserved: true, resultSha256: hash(await ordinaryFile(join(evidence, 'result.json'))) });
    return { ...retained, cleanup: 'trashed' };
  }
  await inspectExerciseOwnership(result);
  assert.equal(processGroupPresent(result.execution.processGroup), false, 'Do not trash a live owned helper group');
  const child = spawn('/usr/bin/trash', [result.scratch], { shell: false, stdio: 'ignore' });
  const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept); });
  assert.equal(code, 0, 'System Trash failed');
  await assert.rejects(lstat(result.scratch), error => error.code === 'ENOENT');
  await save(join(evidence, 'cleanup.json'), { status: 'trashed', scratch: result.scratch, evidencePreserved: true, resultSha256: hash(await ordinaryFile(join(evidence, 'result.json'))) });
  return { ...retained, cleanup: 'trashed' };
}

export async function verifyGeneratedExerciseAcceptance(parentResult, reference) {
  assert.ok(reference && isAbsolute(reference.evidence) && /^[a-f0-9]{64}$/.test(reference.resultSha256), 'Generated artifact acceptance requires an independent helper execution receipt');
  assert.equal(hash(await ordinaryFile(join(reference.evidence, 'result.json'))), reference.resultSha256);
  const { result } = await inspectGeneratedExercise(reference.evidence);
  assert.equal(result.status, 'completed', 'A failed helper invocation cannot complete artifact exercise');
  await assert.rejects(lstat(result.scratch), error => error.code === 'ENOENT', 'Final acceptance requires owned exercise cleanup');
  assert.deepEqual(JSON.parse(await ordinaryFile(join(reference.evidence, 'cleanup.json'))), { status: 'trashed', scratch: result.scratch,
    evidencePreserved: true, resultSha256: reference.resultSha256 }, 'Final acceptance requires hash-bound Evidence → Trash → Evidence');
  assert.equal(result.parent.evidence, parentResult.evidence);
  assert.equal(result.parent.resultSha256, hash(await ordinaryFile(join(parentResult.evidence, 'result.json'))));
  if (result.artifactAdmission) {
    assert.equal(parentResult.status, 'failed'); assert.equal(parentResult.generatedPlan, undefined);
    assert.deepEqual(parentResult.session, result.artifactAdmission.sourceSession); assert.equal(parentResult.arm, result.artifactAdmission.arm);
    assert.equal(hash(await ordinaryFile(parentResult.session.path)), parentResult.session.sha256);
    assert.equal(result.parent.planSha256, result.artifactAdmission.final.sha256);
  } else assert.equal(result.parent.planSha256, parentResult.generatedPlan.sha256);
  return { evidence: reference.evidence, resultSha256: reference.resultSha256, execution: 'completed',
    ...(result.artifactAdmission ? { scope: 'artifact-only', originalModelStatus: 'failed' } : {}), acceptance: 'requires-independent-semantic-and-feature-review' };
}
