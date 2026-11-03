#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createGraphFixture } from './notion-skill-graph.mjs';
import { observeGraphGate } from './notion-skill-graph-model.mjs';
import { createOwnedGraphProject } from './notion-skill-graph-project.mjs';
import { frozenPrompt } from './verify-skill-graph-contract.mjs';
import { systemTempRoot } from './verification-paths.mjs';
import { isolatedEnv } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const rows = async file => { try { return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };

export async function probeGraphObserver({ extension, cliCommand, cliSource, evidenceRoot, matrix = false }) {
  await mkdir(evidenceRoot, { recursive: true });
  const evidence = await mkdtemp(join(evidenceRoot, 'graph-observer-http-'));
  const scratch = await mkdtemp(join(await systemTempRoot(), 'broker-graph-observer-http-'));
  const project = await createOwnedGraphProject(join(scratch, 'project'));
  const fixture = await createGraphFixture({ directory: join(scratch, 'fixture'), evidence: join(evidence, 'source'), cliCommand, cliSource });
  const responses = join(evidence, 'source-responses'), cache = join(scratch, 'broker-cache'), output = join(evidence, 'observer.jsonl');
  await Promise.all([responses, cache, join(scratch, 'sessions'), join(scratch, 'agent')].map(path => mkdir(path)));
  await writeFile(output, '');
  const providerFile = join(evidence, 'provider-http.jsonl'); await writeFile(providerFile, '');
  const result = { version: 1, status: 'running', evidence, scratch, proofLayer: 'controlled actual HTTP provider + installed Pi + real installed Node/SQLite CLI; no real model or production Notion proof' };
  await save(join(evidence, 'result.json'), result); console.log(JSON.stringify(result));
  let requests = 0, serverError;
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); const number = ++requests;
      await appendFile(providerFile, JSON.stringify({ number, method: request.method, body }) + '\n');
      const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
      const texts = strings(body.messages).map(value => value.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'));
      const source = texts.join('\n');
      let target;
      if (!source.includes('export function makeServer()')) target = 'src/tickets.mjs';
      else if (!source.includes('GRAPH_MEMBER_OPTIONAL_BODY')) target = /\[graph-member\]\((skill:\/\/[^)]+)\)/.exec(source)?.[1];
      else if (!source.includes(fixture.graph.resource.content)) target = /\[the ledger evidence\]\((skill:\/\/[^)]+)\)/.exec(source)?.[1];
      if (number > (matrix ? 18 : 6)) throw new Error('Controlled provider could not complete the discovered native read chain');
      if (number < 4) assert.ok(target, 'The controlled provider must derive a target from actual context');
      const content = target ? { tool_calls: [{ index: 0, id: 'observer-call-' + number, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: target }) } }] } : { content: 'Controlled observer probe completed. Run `npm test`.' };
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const chunk = (delta, finish_reason = null) => 'data: ' + JSON.stringify({ id: 'observer-' + number, object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
      response.end(chunk({ role: 'assistant' }) + chunk(content) + chunk({}, target ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
    } catch (error) { serverError = error; response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  const model = 'context-broker-graph-observer/fake';
  const provider = join(scratch, 'provider.mjs');
  await writeFile(provider, "export default function(api) { api.registerProvider('context-broker-graph-observer', { name:'Controlled actual HTTP observer probe', baseUrl:" + JSON.stringify('http://127.0.0.1:' + server.address().port + '/v1') + ",api:'openai-completions',apiKey:'controlled-no-secret',models:[{id:'fake',name:'Controlled probe',input:['text'],contextWindow:1000000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}); }\n");
  const source = join(scratch, 'source.json');
  await save(source, { command: fixture.command, cliPaths: {}, ledger: join(evidence, 'source-processes.jsonl'), responses });
  const config = join(scratch, 'broker.json');
  const modelHelper = fileURLToPath(new URL('./notion-skill-graph-model.mjs', import.meta.url));
  await save(config, { skillRoots: [], sources: [{ type: 'notion', id: 'notion', namespace: 'notion', command: [process.execPath, modelHelper, '--source', source], database: fixture.graph.root.record.locator.database_id, cacheDir: cache, prefetch: false, activation: { offline: true } }] });
  const prompt = frozenPrompt('B', '$graph-root@notion');
  const observer = join(scratch, 'observer.mjs');
  const settings = { rootRef: fixture.graph.root.record.ref, model, prompt: prompt.text, cache, cwd: project.root, responses, output, project };
  await writeFile(observer, "import * as fs from 'node:fs'; import * as crypto from 'node:crypto'; import * as path from 'node:path'; export default function(api) { (" + observeGraphGate.toString() + ')(api, { ...' + JSON.stringify(settings) + ', fs,crypto,path }); }\n');
  let rpc;
  try {
    const env = isolatedEnv({ base: scratch, agentDir: join(scratch, 'agent'), CONTEXT_BROKER_CONFIG: config, CONTEXT_BROKER_HOST: 'pi', BROKER_E2E_PROCESS_LEDGER: join(evidence, 'owned-processes.jsonl') });
    let priorResponseFiles = [];
    result.samples = []; result.sessions = [];
    for (let launch = 0; launch < (matrix ? 3 : 1); launch++) {
      const retained = join(evidence, 'run-' + launch), currentResponses = join(retained, 'source-responses'), currentOutput = join(retained, 'observer.jsonl'), sessionDir = join(scratch, 'sessions', 'run-' + launch);
      await mkdir(currentResponses, { recursive: true }); await mkdir(sessionDir); await writeFile(currentOutput, '');
      await save(source, { command: fixture.command, cliPaths: {}, ledger: join(evidence, 'source-processes.jsonl'), responses: currentResponses });
      const currentSettings = { ...settings, responses: currentResponses, output: currentOutput, priorResponseFiles };
      await writeFile(observer, "import * as fs from 'node:fs'; import * as crypto from 'node:crypto'; import * as path from 'node:path'; export default function(api) { (" + observeGraphGate.toString() + ')(api, { ...' + JSON.stringify(currentSettings) + ', fs,crypto,path }); }\n');
      rpc = await startRpc({ host: 'pi', cwd: project.root, env, timeoutMs: 90000, args: ['--no-extensions', '--no-skills', '--no-mcp', '--no-context-files', '--no-prompt-templates', '--tools', 'read', '--session-dir', sessionDir, '-e', provider, '-e', extension, '-e', observer, '--model', model] });
      const firstRequest = requests;
      for (let turn = 0; turn < (matrix && launch === 2 ? 3 : 1); turn++) {
        const before = requests, startedAt = new Date().toISOString(); await rpc.prompt(prompt.text);
        result.samples.push({ launch, turn, mode: turn ? 'continued-session' : launch ? 'warm-new-process' : 'cold-controlled-seed', provider_requests: requests - before, startedAt, finishedAt: new Date().toISOString() });
      }
      if (serverError) throw serverError;
      const observed = await rows(currentOutput), providers = observed.filter(event => event.phase === 'provider-request');
      assert.equal(providers.length, requests - firstRequest, 'The real SDK provider hook must observe every actual HTTP payload');
      assert.ok(providers.length >= 4);
      for (const event of providers) for (const node of fixture.graph.nodes.filter(node => fixture.graph.useIds.includes(node.record.id))) {
        const copies = event.contents.filter(file => file.ownerId === node.record.id && file.role === 'entrypoint');
        assert.equal(copies.length, 1); assert.equal(copies[0].sha256, hash(node.body));
      }
      assert.equal(providers[0].contents.some(file => file.ownerId === fixture.graph.member.record.id), false, 'A fresh warm session must not inherit optional member context');
      assert.ok(observed.some(event => event.phase === 'project-read-result' && event.complete));
      const resourceId = fixture.graph.member.file_bindings.find(file => file.path === fixture.graph.resource.path).file_id;
      for (const logicalId of [fixture.graph.member.record.id, resourceId]) assert.ok(observed.some(event => event.phase === 'tool-result' && event.logicalId === logicalId && event.complete));
      assert.ok(observed.filter(event => event.phase === 'tool-call').every(event => event.allowed && event.origin === 'model'));
      assert.ok(observed.find(event => event.phase === 'catalog').skills.every(skill => skill.provenance?.ownerId === fixture.graph.root.record.id));
      await save(join(retained, 'pi-rpc.json'), rpc.frames); await rpc.stop(); rpc = undefined;
      result.sessions.push({ launch, providerRequests: providers.length, catalog: observed.find(event => event.phase === 'catalog'), reads: observed.filter(event => ['tool-result', 'project-read-result'].includes(event.phase)).map(({ content, ...receipt }) => receipt) });
      for (const name of await readdir(currentResponses)) { const path = join(currentResponses, name); priorResponseFiles.push({ path, sha256: hash(await readFile(path)) }); }
      await save(join(retained, 'cache-reuse-responses.json'), priorResponseFiles);
    }
    assert.equal((await rows(fixture.httpPath)).length, 0);
    result.status = 'passed'; result.providerRequests = requests;
  } catch (error) { result.status = 'failed'; result.error = { code: error.code ?? 'OBSERVER_PROBE_FAILED', message: error.message }; }
  finally {
    if (rpc) { await save(join(evidence, 'pi-rpc.json'), rpc.frames); try { await rpc.stop(); } catch (error) { result.status = 'failed'; result.error ??= { message: error.message }; } }
    server.closeAllConnections(); await new Promise(accept => server.close(accept)); await fixture.close();
  }
  result.finishedAt = new Date().toISOString(); await save(join(evidence, 'result.json'), result); return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {}; const args = process.argv.slice(2); while (args.length) { const key = args.shift(); assert.ok(['--extension', '--cli-entry', '--cli-source', '--evidence-root', '--matrix'].includes(key) && args.length); options[key.slice(2)] = args.shift(); }
  const result = await probeGraphObserver({ extension: options.extension, cliCommand: [process.execPath, options['cli-entry']], cliSource: options['cli-source'], evidenceRoot: options['evidence-root'], matrix: options.matrix === 'true' });
  console.log(JSON.stringify(result, null, 2)); if (result.status !== 'passed') process.exitCode = 1;
}
