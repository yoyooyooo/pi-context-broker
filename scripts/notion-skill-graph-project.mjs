import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, relative, resolve } from 'node:path';

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

export async function createOwnedGraphProject(directory) {
  await mkdir(directory, { recursive: true });
  for (const [path, content] of Object.entries(ownedProjectFiles)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content, { flag: 'wx', mode: 0o600 });
  }
  return inspectOwnedGraphProject(directory);
}

export async function inspectOwnedGraphProject(directory) {
  const root = await realpath(directory);
  const actualPaths = [];
  const walk = async (directory, prefix = '') => { for (const entry of await readdir(directory, { withFileTypes: true })) { const name = prefix + entry.name; if (entry.isDirectory()) await walk(join(directory, entry.name), name + '/'); else { assert.ok(entry.isFile(), 'Owned project cannot contain symlinks or special files'); actualPaths.push(name); } } };
  await walk(root);
  assert.deepEqual(actualPaths.sort(), Object.keys(ownedProjectFiles).sort(), 'The owned application inventory must remain complete and unchanged');
  const files = [];
  for (const [path, expected] of Object.entries(ownedProjectFiles)) {
    assert.equal(await realpath(join(root, path)), join(root, path), 'Owned project source cannot be a symlink');
    const bytes = await readFile(join(root, path));
    assert.equal(hash(bytes), hash(expected), 'Owned project source changed during the read-only model gate');
    files.push({ path, sha256: hash(bytes), bytes: bytes.length });
  }
  return { version: 1, root, files, sha256: hash(JSON.stringify(files)), source: 'fixed owned local application; no Skill or private oracle material' };
}

export function extractGeneratedFiles(text) {
  const lines = [...text.matchAll(/[^\r\n]*(?:\r\n|\n|$)/g)].filter(match => match[0].length).map(match => ({ text: match[0].replace(/\r?\n$/, ''), start: match.index, end: match.index + match[0].length }));
  const cleanPath = value => {
    let path = value.trim().replace(/^#{1,6}\s+/, '').replace(/^\d+[.)]\s+/, '').replace(/^(?:file|path|文件|路径)\s*[:：]\s*/i, '').trim();
    if (/^\*\*.*\*\*$/.test(path)) path = path.slice(2, -2);
    if (/^`[^`]+`$/.test(path)) path = path.slice(1, -1);
    return /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(path) && !path.split('/').some(part => ['.', '..'].includes(part)) ? path : undefined;
  };
  const files = new Map();
  for (let index = 0; index < lines.length; index++) {
    const opening = /^\s*(`{3,}|~{3,})(.*)$/.exec(lines[index].text); if (!opening) continue;
    const fence = opening[1], info = opening[2].trim();
    let file = cleanPath(info) ?? cleanPath(/(?:file|path|title)\s*=\s*["']?([^\s"']+)/i.exec(info)?.[1] ?? '');
    if (!file) for (let previous = index - 1; previous >= Math.max(0, index - 4); previous--) { if (!lines[previous].text.trim()) continue; file = cleanPath(lines[previous].text); break; }
    const close = new RegExp('^\\s*' + fence[0] + '{' + fence.length + ',}\\s*$');
    let end = index + 1; while (end < lines.length && !close.test(lines[end].text)) end++;
    if (end === lines.length) continue;
    if (file) {
      const content = text.slice(lines[index].end, lines[end].start);
      assert.ok(content.trim(), 'A named generated file cannot be empty');
      assert.ok(!files.has(file) || files.get(file).content === content, 'A generated file has conflicting complete definitions');
      files.set(file, { path: file, content, sha256: hash(content), bytes: Buffer.byteLength(content), sourceSpan: { start: lines[index].end, end: lines[end].start } });
    }
    index = end;
  }
  return [...files.values()];
}

export async function retainGeneratedPlan({ evidence, final, prompt, project }) {
  if (!final?.success || !final.text?.trim()) return { status: 'missing', executed: false };
  const path = join(evidence, 'generated-acceptance-plan.md');
  await writeFile(path, final.text, { mode: 0o600 });
  const files = extractGeneratedFiles(final.text);
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
  const artifactStatus = skillFiles.length > 0 && unresolvedReferences.length === 0 ? 'complete-skill-files-retained' : files.length ? 'incomplete-generated-files' : 'plan-only';
  const receipt = { version: 1, status: 'plan-retained', artifactStatus, path, sha256: hash(final.text), bytes: Buffer.byteLength(final.text), promptSha256: prompt.sha256, projectSha256: project.sha256, files: files.map(({ content, ...file }) => ({ ...file, evidencePath: 'generated-files/' + file.path })), skillFiles: skillFiles.map(file => file.path), unresolvedReferences, executed: false, proof: 'Exact model final and explicitly named complete file blocks only; prose alone is not accepted as a generated Skill, and no execution is inferred' };
  await save(join(evidence, 'generated-plan.json'), receipt);
  return receipt;
}

export async function exerciseGeneratedProcedure(evidence, command) {
  const result = JSON.parse(await readFile(join(evidence, 'result.json'), 'utf8'));
  assert.equal(await realpath(evidence), result.evidence);
  assert.equal(result.status, 'passed', 'Complete the real graph/model gate before driving its generated procedure');
  const receipt = JSON.parse(await readFile(join(evidence, 'generated-plan.json'), 'utf8'));
  const plan = await readFile(receipt.path, 'utf8');
  assert.equal(hash(plan), receipt.sha256, 'The generated plan must retain the actual model bytes');
  const project = await inspectOwnedGraphProject(result.project.root);
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
  await writeFile(join(evidence, 'generated-procedure.stdout.log'), out, { mode: 0o600 });
  await writeFile(join(evidence, 'generated-procedure.stderr.log'), err, { mode: 0o600 });
  const execution = { version: 1, status: closed.code === 0 && !timedOut ? 'passed' : 'failed', command, executable: file, executableArgs: args, cwd: project.root, pid: child.pid, owned: true, startedAt, finishedAt: new Date().toISOString(), spawnObserved: Boolean(child.pid), closeObserved: true, ...closed, timedOut, planSha256: receipt.sha256, generatedCommandSpan: selected, projectSha256: project.sha256, stdoutSha256: hash(out), stderrSha256: hash(err), scope: 'One verbatim generated procedure executed against the unchanged owned project; no other plan step is inferred' };
  await inspectOwnedGraphProject(project.root);
  await save(join(evidence, 'generated-procedure-execution.json'), execution);
  result.generatedProcedure = execution;
  result.productAcceptance = { ...result.productAcceptance, generatedProcedureExecuted: execution.status === 'passed', generatedProcedureStatus: execution.status, scope: execution.scope };
  result.files = [...new Set([...result.files, 'generated-procedure.stdout.log', 'generated-procedure.stderr.log', 'generated-procedure-execution.json'])];
  await save(join(evidence, 'result.json'), result);
  return execution;
}
