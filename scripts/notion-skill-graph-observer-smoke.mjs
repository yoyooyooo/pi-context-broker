#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createGraphFixture } from './notion-skill-graph.mjs';
import { observeGraphGate, GRAPH_GATE_TOOLS, graphHarnessIdentity, createGraphFallbackTraps } from './notion-skill-graph-model.mjs';
import { createOwnedGraphProject } from './notion-skill-graph-project.mjs';
import { createPiHelpBoundary } from './notion-pi-help.mjs';
import { frozenPrompt } from './verify-skill-graph-contract.mjs';
import { systemTempRoot } from './verification-paths.mjs';
import { isolatedEnv, resolveHost } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const rows = async file => { try { return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };

export async function probeGraphObserver({ extension, cliCommand, cliSource, evidenceRoot, matrix = false, resourceLocation = 'ref', largeBody = false, hostIndexResource = false, publicBoundaries = false }) {
  assert.ok(['ref', 'alias', 'unqualified-ref'].includes(resourceLocation));
  assert.equal(typeof largeBody, 'boolean');
  assert.equal(typeof hostIndexResource, 'boolean');
  assert.equal(typeof publicBoundaries, 'boolean');
  assert.ok(!publicBoundaries || !matrix && !largeBody && !hostIndexResource, 'The public-boundary probe uses one cold native command within the existing ten-request limit');
  assert.ok(!hostIndexResource || !largeBody, 'The host-index resource probe requires a complete native main read within the existing page limit');
  await mkdir(evidenceRoot, { recursive: true });
  const evidence = await mkdtemp(join(evidenceRoot, 'graph-observer-http-'));
  const scratch = await mkdtemp(join(await systemTempRoot(), 'broker-graph-observer-http-'));
  const project = await createOwnedGraphProject(join(scratch, 'project'));
  const rootBodySuffix = largeBody ? '\nCONTROLLED_LARGE_LITERAL_SECTION\n' + '<b>literal evidence & detail</b> [brackets] (group) "quoted" \\ value.\n'.repeat(800) : '';
  const fixture = await createGraphFixture({ directory: join(scratch, 'fixture'), evidence: join(evidence, 'source'), cliCommand, cliSource, rootBodySuffix, rootResource: hostIndexResource });
  // The large root exercises complete preparation/provider delivery. Native
  // filesystem read has a 50 KiB page limit, so use an already-provided short
  // Required main to independently verify its advertised path and full bytes.
  const nativePathNode = largeBody ? fixture.graph.base : fixture.graph.root;
  const responses = join(evidence, 'source-responses'), cache = join(scratch, 'broker-cache'), output = join(evidence, 'observer.jsonl');
  await Promise.all([responses, cache, join(scratch, 'sessions'), join(scratch, 'agent')].map(path => mkdir(path)));
  await writeFile(output, '');
  const providerFile = join(evidence, 'provider-http.jsonl'); await writeFile(providerFile, '');
  const outside = join(scratch, 'unadvertised.txt'), outsideBody = 'UNADVERTISED_CONTROLLED_BYTES_MUST_NOT_REACH_PROVIDER';
  await writeFile(outside, outsideBody);
  const traps = await createGraphFallbackTraps(join(scratch, 'control'), evidence);
  const result = { version: 1, status: 'running', evidence, scratch, resourceLocation, largeBody, hostIndexResource, publicBoundaries, rootMainBytes: Buffer.byteLength(fixture.graph.root.body), nativePathNode: { id: nativePathNode.record.id, bytes: Buffer.byteLength(nativePathNode.body), sha256: hash(nativePathNode.body), role: largeBody ? 'required' : 'root' }, harness: await graphHarnessIdentity(), proofLayer: 'controlled actual HTTP provider + installed Pi + real installed Node/SQLite CLI; no real model or production Notion proof' };
  await save(join(evidence, 'result.json'), result); console.log(JSON.stringify(result));
  let requests = 0, serverError, negativeStep = 0, initialMainRead = false, helpRead = false, indexMainPath, indexMainCall, memberReadCall, activeOutput;
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); const number = ++requests;
      await appendFile(providerFile, JSON.stringify({ number, method: request.method, wireBodySha256: hash(raw), body }) + '\n');
      assert.deepEqual(body.tools.map(tool => tool.function?.name ?? tool.name).sort(), [...GRAPH_GATE_TOOLS].sort(), 'The real SDK must advertise all three product tools and no shell');
      const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
      const texts = strings(body.messages).map(value => value.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'));
      const source = texts.join('\n');
      assert.equal(source.includes(outsideBody), false, 'Blocked outside bytes must never enter a provider request');
      const parsedResults = texts.flatMap(value => { try { return [JSON.parse(value)]; } catch { return []; } });
      const searches = parsedResults.filter(result => result?.ok === true && result.state === 'known' && Array.isArray(result.records));
      let selected;
      if (!initialMainRead && publicBoundaries) {
        const wrappers = (body.messages ?? []).filter(message => message.role === 'user').flatMap(message => strings(message.content))
          .flatMap(value => [...value.matchAll(/<skill\b([^>]*)>([\s\S]*?)<\/skill>/g)]);
        const root = wrappers.find(match => match[2].includes(nativePathNode.body));
        const location = /\blocation="([^"]+)"/.exec(root?.[1] ?? '')?.[1];
        assert.ok(location, 'Read the actual Pi native command location from its complete user wrapper');
        indexMainPath = location; indexMainCall = 'observer-call-' + number;
        initialMainRead = true; selected = { name: 'read', arguments: { path: location } };
      } else if (!initialMainRead && hostIndexResource) {
        const system = (body.messages ?? []).filter(message => message.role === 'system').flatMap(message => strings(message.content)).join('\n');
        const locations = [...system.matchAll(/<skill>[\s\S]*?<location>\s*([^<]+)\s*<\/location>[\s\S]*?<\/skill>/g)].map(match => match[1].trim());
        assert.equal(locations.length, 1, 'Use the actual root-only host catalog path, without constructing an index location');
        indexMainPath = locations[0]; indexMainCall = 'observer-call-' + number;
        initialMainRead = true; selected = { name: 'read', arguments: { path: indexMainPath } };
      } else if (!initialMainRead) {
        const wrappers = texts.flatMap(value => [...value.matchAll(/<context-broker-record\b([^>]*)>([\s\S]*?)<\/context-broker-record>/g)]);
        const root = wrappers.find(match => match[2].includes(nativePathNode.body));
        const location = /\bpath="([^"]+)"/.exec(root?.[1] ?? '')?.[1];
        assert.ok(location, 'The initial exact native path must come from the actual complete provider wrapper');
        assert.ok(!/<skill-ref>[^<]*file_id=/.test(root[2]), 'Exercise the public wrapper with omitted File ID against the complete canonical manifest');
        initialMainRead = true; selected = { name: 'read', arguments: { path: location } };
      } else if (hostIndexResource && !source.includes(fixture.graph.rootResource.content)) {
        const returnedMain = (await rows(activeOutput)).find(event => event.phase === 'tool-result' && event.toolCallId === indexMainCall && event.complete);
        assert.equal(returnedMain?.content, fixture.graph.root.body, 'The original complete native read must precede its linked resource, including when provider projection deduplicates the repeated main');
        assert.ok(source.includes(fixture.graph.root.body), 'The provider must still contain the complete main instruction');
        const href = /\[the root ledger\]\(([^)]+)\)/.exec(source)?.[1];
        assert.ok(href && !href.startsWith('/') && !href.includes('://'));
        selected = { name: 'read', arguments: { path: join(dirname(indexMainPath), href) } };
      } else if (!helpRead) {
        const system = (body.messages ?? []).filter(message => message.role === 'system').flatMap(message => strings(message.content)).join('\n');
        const docs = /<docs>([\s\S]*?)<\/docs>/.exec(system)?.[1];
        const location = /^- Main documentation:\s*([^\r\n]+)$/m.exec(docs ?? '')?.[1]?.trim();
        assert.ok(location, 'The generic host help read must use its actual provider system advertisement');
        helpRead = true; selected = { name: 'read', arguments: { path: location } };
      } else if (!source.includes('export function makeServer()')) selected = { name: 'read', arguments: { path: join(project.root.replace(/^\/private\/tmp\//, '/tmp/'), 'src/tickets.mjs') } };
      else if (!searches.length) {
        const name = /\[([^\]]+)\]\((skill:\/\/[^)]+)\)/.exec(source.slice(source.indexOf('## Members')))?.[1];
        assert.ok(name, 'The controlled metadata query must come from the actual member directory');
        selected = { name: 'skill_search', arguments: { query: name, limit: 20 } };
      } else if (!source.includes('GRAPH_MEMBER_OPTIONAL_BODY')) {
        const candidate = searches.at(-1).records.find(record => record.availability === 'available' && !record.in_default_view);
        assert.ok(candidate, 'An exact metadata result must precede explicit preparation');
        if (publicBoundaries) { memberReadCall = 'observer-call-' + number; selected = { name: 'read', arguments: { path: candidate.ref } }; }
        else selected = { name: 'skill_prepare', arguments: { roots: [candidate.ref], purpose: 'use' } };
      } else if (publicBoundaries && !parsedResults.some(value => value?.ok === true && value.status === 'ready' && Array.isArray(value.records))) {
        const candidate = searches.at(-1).records.find(record => record.availability === 'available' && !record.in_default_view);
        const reference = new URL(candidate.ref); reference.pathname = ''; reference.search = '';
        selected = { name: 'skill_prepare', arguments: { roots: [reference.href], purpose: 'use' } };
      } else if (!source.includes(fixture.graph.resource.content)) {
        const ref = /\[the ledger evidence\]\((skill:\/\/[^)]+)\)/.exec(source)?.[1];
        assert.ok(ref, 'The resource ref must come from the actual prepared main');
        let target = ref;
        if (resourceLocation === 'alias' || resourceLocation === 'unqualified-ref') {
          const prepared = parsedResults.find(result => result?.ok === true && result.status === 'ready' && Array.isArray(result.records));
          const owner = prepared?.records.find(record => record.content.includes('GRAPH_MEMBER_OPTIONAL_BODY'));
          const fileId = new URL(ref).searchParams.get('file_id');
          const resource = owner?.directory.files.find(file => new URL(file.ref).searchParams.get('file_id') === fileId);
          assert.ok(owner && fileId && resource, 'The actual manifest must map the discovered resource File ID before using its current path');
          if (resourceLocation === 'unqualified-ref') {
            const input = new URL(resource.ref); input.searchParams.delete('snapshot'); input.searchParams.delete('file_id'); target = input.href;
          } else target = join(dirname(owner.path), resource.path).replace(/^\/private\/tmp\//, '/tmp/');
        }
        selected = { name: 'read', arguments: { path: target } };
      } else if (negativeStep++ === 0) selected = { name: 'read', arguments: { path: outside } };
      else if (negativeStep === 2) selected = { name: 'bash', arguments: { command: 'printf forbidden' } };
      if (number > (matrix ? 30 : 10)) throw new Error('Controlled provider could not complete the discovered native tool chain');
      const content = selected ? { tool_calls: [{ index: 0, id: 'observer-call-' + number, type: 'function', function: { name: selected.name, arguments: JSON.stringify(selected.arguments) } }] } : { content: 'Controlled observer probe completed. Run `npm test`.' };
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const chunk = (delta, finish_reason = null) => 'data: ' + JSON.stringify({ id: 'observer-' + number, object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
      response.end(chunk({ role: 'assistant' }) + chunk(content) + chunk({}, selected ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
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
  const submittedPrompt = publicBoundaries ? prompt.text.replace('$graph-root@notion', '/skill:notion-' + fixture.graph.root.record.alias) : prompt.text;
  const observer = join(scratch, 'observer.mjs');
  const settings = { rootRef: fixture.graph.root.record.ref, model, prompt: submittedPrompt, cache, cwd: project.root, responses, output, project, piExecutable: (await resolveHost('pi')).identity };
  const parserUrl = pathToFileURL(join(dirname(extension), 'native-reference.ts')).href;
  const observerSource = value => "import * as fs from 'node:fs'; import * as crypto from 'node:crypto'; import * as path from 'node:path'; import { parseNativeReference } from " + JSON.stringify(parserUrl) + "; export default function(api) { const settings=" + JSON.stringify(value) + '; const piHelpBoundary=(' + createPiHelpBoundary.toString() + ')({fs,crypto,path,executable:settings.piExecutable}); (' + observeGraphGate.toString() + ')(api,{...settings,fs,crypto,path,piHelpBoundary,parseNativeReference}); }\n';
  await writeFile(observer, observerSource(settings));
  let rpc;
  try {
    const env = { ...isolatedEnv({ base: scratch, agentDir: join(scratch, 'agent'), CONTEXT_BROKER_CONFIG: config, CONTEXT_BROKER_HOST: 'pi', BROKER_E2E_PROCESS_LEDGER: join(evidence, 'owned-processes.jsonl') }), ...traps.environment };
    let priorResponseFiles = [];
    result.samples = []; result.sessions = [];
    for (let launch = 0; launch < (matrix ? 3 : 1); launch++) {
      const retained = join(evidence, 'run-' + launch), currentResponses = join(retained, 'source-responses'), currentOutput = join(retained, 'observer.jsonl'), sessionDir = join(scratch, 'sessions', 'run-' + launch);
      activeOutput = currentOutput;
      await mkdir(currentResponses, { recursive: true }); await mkdir(sessionDir); await writeFile(currentOutput, '');
      await save(source, { command: fixture.command, cliPaths: {}, ledger: join(evidence, 'source-processes.jsonl'), responses: currentResponses });
      const currentSettings = { ...settings, responses: currentResponses, output: currentOutput, priorResponseFiles };
      await writeFile(observer, observerSource(currentSettings));
      negativeStep = 0; initialMainRead = false; helpRead = false; indexMainPath = undefined; indexMainCall = undefined; memberReadCall = undefined;
      rpc = await startRpc({ host: 'pi', cwd: project.root, env, timeoutMs: 90000, args: ['--no-extensions', '--no-skills', '--no-mcp', '--no-context-files', '--no-prompt-templates', '--tools', GRAPH_GATE_TOOLS.join(','), '--session-dir', sessionDir, '-e', provider, '-e', extension, '-e', observer, '--model', model] });
      const firstRequest = requests;
      for (let turn = 0; turn < (matrix && launch === 2 ? 3 : 1); turn++) {
        const before = requests, startedAt = new Date().toISOString(); await rpc.prompt(submittedPrompt);
        result.samples.push({ launch, turn, mode: turn ? 'continued-session' : launch ? 'warm-new-process' : 'cold-controlled-seed', provider_requests: requests - before, startedAt, finishedAt: new Date().toISOString() });
      }
      if (serverError) throw serverError;
      const observed = await rows(currentOutput), providers = observed.filter(event => event.phase === 'provider-request');
      assert.equal(observed.some(event => event.phase === 'observer-error'), false, 'Observer failures cannot disappear behind Pi hook error handling');
      assert.equal(providers.length, requests - firstRequest, 'The real SDK provider hook must observe every actual HTTP payload');
      const transports = observed.filter(event => event.phase === 'provider-transport-start'), transmitted = (await rows(providerFile)).slice(firstRequest);
      assert.equal(transports.length, providers.length);
      for (let index = 0; index < providers.length; index++) {
        assert.equal(providers[index].observedPayloadSha256, transports[index].observedPayloadSha256, 'Only the verified semantic payload may reach transport');
        assert.equal(transports[index].wireBodySha256, transmitted[index].wireBodySha256, 'The observer wire hash must match the actual HTTP body');
      }
      assert.ok(providers.length >= 4);
      for (const event of providers) for (const node of fixture.graph.nodes.filter(node => fixture.graph.useIds.includes(node.record.id))) {
        const copies = event.contents.filter(file => file.ownerId === node.record.id && file.role === 'entrypoint');
        assert.equal(copies.length, 1); assert.equal(copies[0].sha256, hash(node.body));
      }
      assert.equal(providers[0].contents.some(file => file.ownerId === fixture.graph.member.record.id), false, 'A fresh warm session must not inherit optional member context');
      assert.ok(observed.some(event => event.phase === 'project-read-result' && event.complete));
      assert.ok(observed.some(event => event.phase === 'provided-native-path' && event.ref.includes('file_id=')));
      assert.ok(observed.some(event => event.phase === 'tool-result' && event.tool === 'read' && event.ownerId === nativePathNode.record.id
        && event.complete && event.sha256 === hash(nativePathNode.body)), 'The initial advertised main path must reach native read with its exact manifest identity');
      if (publicBoundaries) {
        assert.ok(observed.some(event => event.phase === 'provided-native-path' && event.path === indexMainPath && event.source === 'actual Pi native wrapper'));
        const main = observed.find(event => event.phase === 'tool-result' && event.toolCallId === indexMainCall && event.complete);
        assert.ok(main?.ownerId === nativePathNode.record.id && main.bytes === Buffer.byteLength(nativePathNode.body));
        assert.ok(providers.some(event => event.sequence > main.sequence && event.contents.filter(file => file.ref === main.ref && file.sha256 === main.sha256).length === 1));
        const prepared = observed.find(event => event.phase === 'preparation-result' && event.complete);
        assert.equal(new URL(prepared.roots[0]).pathname, '', 'The actual public prepare input must omit the optional main path');
        const authored = observed.find(event => event.phase === 'authored-tool-call' && event.toolCallId === memberReadCall);
        const admitted = observed.find(event => event.phase === 'tool-call' && event.toolCallId === memberReadCall);
        const read = observed.find(event => event.phase === 'tool-result' && event.toolCallId === memberReadCall && event.complete);
        assert.ok(authored?.discovered && admitted?.allowed && read?.ownerId === fixture.graph.member.record.id);
        assert.equal(admitted.authoredSequence, authored.sequence); assert.equal(read.callSequence, admitted.sequence);
        assert.equal(hash(JSON.stringify(authored.input)), authored.argumentsSha256); assert.equal(admitted.argumentsSha256, authored.argumentsSha256);
        assert.equal(admitted.input, authored.input.path); assert.equal(admitted.expected.scope, read.scope); assert.equal(admitted.expected.sha256, read.sha256);
        const ledger = await rows(join(evidence, 'source-processes.jsonl'));
        const preparation = ledger.find(event => event.phase === 'spawn' && event.command === 'prepare' && event.args.some(arg => {
          try { return new URL(arg).protocol === 'skill:' && decodeURIComponent(new URL(arg).hostname) === read.ownerId; } catch { return false; }
        }));
        const closed = ledger.find(event => event.phase === 'close' && event.requestId === preparation?.requestId && event.code === 0);
        assert.ok(preparation && closed && Date.parse(authored.at) <= Date.parse(preparation.at) && Date.parse(closed.at) <= Date.parse(admitted.at), 'The actual Broker prepareRead must occur after authored selection and before observer admission');
        result.publicBoundaryProof = { nativeMain: { toolCallId: main.toolCallId, ref: main.ref, scope: main.scope, snapshot: main.snapshot, sha256: main.sha256, bytes: main.bytes },
          omittedMainPath: { toolCallId: prepared.toolCallId, roots: prepared.roots, sha256: prepared.sha256, bytes: prepared.bytes },
          authoredRead: { toolCallId: memberReadCall, authoredAt: authored.at, admittedAt: admitted.at, argumentsSha256: authored.argumentsSha256,
            publicPrepareRequestId: preparation.requestId, prepareStartedAt: preparation.at, prepareClosedAt: closed.at, expected: admitted.expected, resultRef: read.ref } };
      }
      if (hostIndexResource) {
        const binding = observed.find(event => event.phase === 'host-index-binding' && event.ownerId === fixture.graph.root.record.id);
        const resource = observed.find(event => event.phase === 'tool-result' && event.tool === 'read' && event.ownerId === fixture.graph.root.record.id && event.role === 'resource' && event.complete);
        const fileId = fixture.graph.root.file_bindings.find(file => file.path === fixture.graph.rootResource.path).file_id;
        assert.ok(binding?.manifestId && binding.receiptSha256 && binding.fileId);
        assert.equal(resource?.requested, join(dirname(indexMainPath), fixture.graph.rootResource.path));
        assert.equal(resource?.logicalId, fileId); assert.equal(resource?.sha256, hash(fixture.graph.rootResource.content));
        assert.equal(resource?.bytes, Buffer.byteLength(fixture.graph.rootResource.content));
        assert.ok(resource.sequence > binding.sequence);
        assert.ok(providers.some(event => event.sequence > resource.sequence && event.contents.some(file => file.ref === resource.ref && file.sha256 === resource.sha256 && file.bytes === resource.bytes)));
      }
      const help = observed.find(event => event.phase === 'host-help-read-result' && event.complete);
      assert.ok(help?.role === 'host-help', 'Installed system help has its own complete read receipt');
      assert.ok(providers.some(event => event.hostHelp.some(file => file.path === help.path && file.sha256 === help.sha256 && file.bytes === help.bytes && file.copies >= 1)), 'Actual generic help bytes reach the provider separately from Notion content');
      assert.ok(providers.every(event => event.contents.every(file => file.role !== 'host-help')));
      const resourceId = fixture.graph.member.file_bindings.find(file => file.path === fixture.graph.resource.path).file_id;
      for (const logicalId of [fixture.graph.member.record.id, resourceId]) assert.ok(observed.some(event => event.phase === 'tool-result' && event.logicalId === logicalId && event.complete));
      if (resourceLocation === 'unqualified-ref') {
        const resource = observed.find(event => event.phase === 'tool-result' && event.logicalId === resourceId && event.complete);
        const call = observed.find(event => event.phase === 'tool-call' && event.toolCallId === resource.toolCallId);
        assert.equal(new URL(call.input).search, '', 'The actual resource tool input must omit both optional identity fields');
        const receipts = await Promise.all((await readdir(currentResponses)).map(async name => JSON.parse(await readFile(join(currentResponses, name), 'utf8'))));
        const source = receipts.find(item => item.command === 'read' && item.code === 0 && item.response?.ok
          && item.response.record.id === fixture.graph.member.record.id && item.response.path === fixture.graph.resource.path)?.response;
        assert.ok(source, 'The resource needs its actual successful public read receipt');
        assert.equal(resource.ownerId, source.record.id); assert.equal(resource.scope, source.scope);
        assert.equal(resource.snapshot, source.snapshot_id); assert.equal(resource.ref, source.ref);
        assert.equal(resource.path, fixture.graph.resource.path); assert.equal(resource.sha256, hash(fixture.graph.resource.content));
        assert.equal(resource.bytes, Buffer.byteLength(fixture.graph.resource.content));
        assert.deepEqual(call.expected, { scope: source.scope, ownerId: source.record.id, path: source.path, snapshot: source.snapshot_id,
          fileId: resourceId, sha256: resource.sha256, bytes: resource.bytes });
        assert.ok(providers.some(event => event.sequence > resource.sequence && event.contents.some(file => file.ref === resource.ref
          && file.scope === resource.scope && file.snapshot === resource.snapshot && file.sha256 === resource.sha256 && file.bytes === resource.bytes)));
      }
      const blocked = observed.filter(event => event.phase === 'tool-call' && !event.allowed);
      assert.ok(blocked.some(event => event.tool === 'read' && event.input === outside));
      assert.ok(blocked.every(event => event.tool === 'read' && event.input === outside || event.tool === 'bash'));
      assert.ok(observed.filter(event => event.phase === 'tool-call').every(event => event.origin === 'model'));
      assert.ok(observed.some(event => event.phase === 'metadata-result' && event.complete));
      assert.ok(observed.some(event => event.phase === 'preparation-result' && event.complete));
      assert.ok(observed.some(event => event.phase === 'tool-result' && event.tool === 'skill_prepare' && event.preparationProof?.explicitRoot && event.complete));
      for (const delivery of observed.filter(event => ['metadata-result', 'preparation-result'].includes(event.phase) && event.complete)) assert.ok(providers.some(event => event.sequence > delivery.sequence && event.toolResults.some(result => result.toolCallId === delivery.toolCallId && result.sha256 === delivery.sha256 && result.bytes === delivery.bytes && result.exactToolOutputCopies === 1)), 'The actual full tool output must reach the SDK provider under the same tool call ID');
      const actualPayloads = (await rows(providerFile)).slice(firstRequest);
      assert.ok(actualPayloads.some(event => JSON.stringify(event.body.messages).includes('Tool bash not found')), 'The actual SDK must reject an unadvertised shell tool');
      assert.ok(observed.find(event => event.phase === 'catalog').skills.every(skill => skill.provenance?.ownerId === fixture.graph.root.record.id));
      await save(join(retained, 'pi-rpc.json'), rpc.frames); await rpc.stop(); rpc = undefined;
      result.sessions.push({ launch, providerRequests: providers.length, catalog: observed.find(event => event.phase === 'catalog'), hostHelp: help, reads: observed.filter(event => ['tool-result', 'project-read-result'].includes(event.phase)).map(({ content, ...receipt }) => receipt) });
      for (const name of await readdir(currentResponses)) { const path = join(currentResponses, name); priorResponseFiles.push({ path, sha256: hash(await readFile(path)) }); }
      await save(join(retained, 'cache-reuse-responses.json'), priorResponseFiles);
    }
    assert.equal((await rows(fixture.httpPath)).length, 0);
    assert.equal((await rows(traps.ledger)).length, 0);
    result.status = 'passed'; result.providerRequests = requests;
    result.toolPolicy = { advertised: GRAPH_GATE_TOOLS, initialAdvertisedMainPath: true, hostIndexRelativeResource: hostIndexResource, omittedResourceIdentityFields: resourceLocation === 'unqualified-ref', nativeCommandMainPath: publicBoundaries, omittedMainPath: publicBoundaries, authoredSelectionBeforePrepareRead: publicBoundaries, hostHelpRead: true, metadataSearch: true, exactPreparation: true, outsideReadBlocked: true, shellToolRejected: true, fullToolOutputHashes: true, legacyFallbackCalls: 0 };
  } catch (error) { result.status = 'failed'; result.error = { code: error.code ?? 'OBSERVER_PROBE_FAILED', message: error.message }; }
  finally {
    if (rpc) { await save(join(evidence, 'pi-rpc.json'), rpc.frames); try { await rpc.stop(); } catch (error) { result.status = 'failed'; result.error ??= { message: error.message }; } }
    server.closeAllConnections(); await new Promise(accept => server.close(accept)); await fixture.close();
  }
  result.finishedAt = new Date().toISOString(); await save(join(evidence, 'result.json'), result); return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {}; const args = process.argv.slice(2); while (args.length) { const key = args.shift(); assert.ok(['--extension', '--cli-entry', '--cli-source', '--evidence-root', '--matrix', '--resource-location', '--large-body', '--host-index-resource', '--public-boundaries'].includes(key) && args.length); options[key.slice(2)] = args.shift(); }
  const result = await probeGraphObserver({ extension: options.extension, cliCommand: [process.execPath, options['cli-entry']], cliSource: options['cli-source'], evidenceRoot: options['evidence-root'], matrix: options.matrix === 'true', resourceLocation: options['resource-location'] ?? 'ref', largeBody: options['large-body'] === 'true', hostIndexResource: options['host-index-resource'] === 'true', publicBoundaries: options['public-boundaries'] === 'true' });
  console.log(JSON.stringify(result, null, 2)); if (result.status !== 'passed') process.exitCode = 1;
}
