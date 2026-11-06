#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, writeFile, appendFile, cp, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createGraphFixture } from './notion-skill-graph.mjs';
import { graphObserverModule, GRAPH_GATE_TOOLS, graphHarnessIdentity, createGraphFallbackTraps, sourceObserver, packageIdentity } from './notion-skill-graph-model.mjs';
import { graphSourceAccounting } from './notion-skill-graph-model-evidence.mjs';
import { assertDiscoveryProjection, summarizeDiscoveryCosts } from './verify-pi-notion-model-cache.mjs';
import { consumptionCostExtensionSource, readConsumptionCostEvents } from './skill-consumption-cost.mjs';
import { createOwnedGraphProject } from './notion-skill-graph-project.mjs';
import { frozenPrompt } from './verify-skill-graph-contract.mjs';
import { systemTempRoot } from './verification-paths.mjs';
import { entryIdentity } from './verification-entry.mjs';
import { isolatedEnv, resolveHost } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const rows = async file => { try { return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };

function discoveryStrategy({ sdkFixture, discoveryMode, packagePath, discoveryOnly, matrix, largeBody, hostIndexResource, publicBoundaries }) {
  if (sdkFixture === undefined && discoveryMode === undefined) return undefined;
  assert.ok(isAbsolute(sdkFixture ?? '') && isAbsolute(packagePath ?? ''), 'SDK discovery needs an explicit fixture and frozen archive');
  assert.ok(['full-cards', 'on-demand-cards'].includes(discoveryMode), 'Choose one explicit discovery presentation');
  assert.ok(discoveryOnly && !matrix && !largeBody && !hostIndexResource && !publicBoundaries, 'SDK discovery is the original independent three-request probe');
  return { version: 1, mode: discoveryMode };
}

/** Clone the original offline SDK fixture; never seed a target into the provider. */
export async function copySdkDiscoveryFixture(file, directory) {
  assert.ok(isAbsolute(file) && isAbsolute(directory));
  const bytes = await readFile(file), fixture = JSON.parse(bytes);
  assert.equal(fixture.version, 1); assert.equal(fixture.catalog, true);
  assert.notEqual(fixture.ambiguous_names, true); assert.notEqual(fixture.distinct_names, true);
  assert.equal(fixture.default_view?.source_cache, 'complete-metadata-only');
  assert.ok(fixture.default_view.records.length > 0 && Array.isArray(fixture.snapshots));
  assert.equal(fixture.default_view.database_id, fixture.database);
  const original = await realpath(fixture.cwd), target = resolve(directory);
  const within = (root, path) => { const value = relative(root, path); return value && !value.startsWith('..') && !isAbsolute(value); };
  assert.ok(!within(original, target) && !within(target, original) && original !== target, 'Clone into independent owned source state');
  const environment = JSON.parse(await readFile(fixture.env, 'utf8'));
  assert.equal(new URL(environment.NOTION_API_BASE_URL).hostname, '127.0.0.1', 'Only the original controlled offline origin is accepted');
  const objects = join(resolve(original, environment.NTN_SKILLS_HOME), 'objects');
  for (const key of ['NTN_SKILLS_HOME', 'NTN_SKILLS_CONFIG_HOME', 'NTN_SKILLS_CACHE_HOME']) {
    assert.equal(typeof environment[key], 'string');
    const requested = resolve(original, environment[key]);
    assert.ok(within(original, requested), 'Fixture state must remain inside its owned root');
    let ancestor = requested, path;
    for (;;) {
      try { path = join(await realpath(ancestor), relative(ancestor, requested)); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = dirname(ancestor); }
    }
    assert.ok(within(original, path), 'Fixture state must remain inside its owned root');
    environment[key] = join(target, relative(original, path));
  }
  const nodes = [];
  for (const snapshot of fixture.snapshots) {
    const main = snapshot.files.find(file => file.path === snapshot.entrypoint);
    assert.ok(main && /^[a-f0-9]{64}$/.test(main.sha256));
    const body = await readFile(join(objects, main.sha256));
    assert.equal(body.length, main.bytes); assert.equal(hash(body), main.sha256);
    nodes.push({ ...snapshot, body: new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(body) });
  }
  for (const expected of fixture.default_view.records) {
    const found = nodes.filter(node => node.scope === fixture.scope && node.record.id === expected.id);
    assert.equal(found.length, 1); assert.equal(found[0].record.name, expected.name); assert.equal(found[0].record.ref, expected.ref);
  }
  await cp(original, target, { recursive: true, errorOnExist: true, force: false });
  return { scope: fixture.scope, database: fixture.database, defaultView: fixture.default_view, environment,
    identity: { path: file, sha256: hash(bytes), sourceState: 'cloned warm controlled SDK source; fresh Broker cache and Pi session' },
    graph: { root: nodes.find(node => node.record.id === fixture.default_view.records[0].id), nodes }, close: async () => {} };
}

export function verifyPublicReadBoundary({ authored, admitted, read, preparation, closed, expected }) {
  assert.ok(authored?.discovered && admitted?.allowed && read?.complete);
  assert.equal(admitted.toolCallId, authored.toolCallId); assert.equal(read.toolCallId, authored.toolCallId);
  assert.equal(admitted.authoredSequence, authored.sequence); assert.equal(read.callSequence, admitted.sequence);
  assert.equal(hash(JSON.stringify(authored.input)), authored.argumentsSha256); assert.equal(admitted.argumentsSha256, authored.argumentsSha256);
  assert.equal(admitted.input, authored.input.path);
  const selected = admitted.expected ?? admitted.claim;
  assert.ok(selected, 'Actual metadata or fixed-file selection must precede the source read');
  for (const key of ['scope', 'ownerId', 'path']) assert.equal(selected[key], expected[key]);
  for (const key of ['snapshot', 'fileId', 'sha256', 'bytes']) if (selected[key] !== undefined) assert.equal(selected[key], expected[key]);
  for (const [key, value] of Object.entries(expected)) assert.equal(read[key], value, 'The complete read must match the independent fixture ' + key);
  const resultRef = new URL(read.ref); assert.equal(resultRef.protocol, 'skill:');
  assert.equal(decodeURIComponent(resultRef.hostname), expected.ownerId); assert.equal(decodeURIComponent(resultRef.pathname.slice(1)), expected.path);
  assert.equal(resultRef.searchParams.get('snapshot'), expected.snapshot); assert.equal(resultRef.searchParams.get('file_id'), expected.fileId);
  if (resultRef.searchParams.has('scope')) assert.equal(resultRef.searchParams.get('scope'), expected.scope);
  assert.ok(preparation && closed && preparation.requestId === closed.requestId && closed.code === 0);
  assert.equal(preparation.command, preparation.args[0]);
  const argv = preparation.args[0] === 'ctl' ? preparation.args.slice(1) : preparation.args;
  assert.equal(argv[0], 'prepare'); assert.equal(argv[argv.indexOf('--purpose') + 1], 'inspect');
  const ref = new URL(argv[1]); assert.equal(ref.protocol, 'skill:');
  assert.equal(decodeURIComponent(ref.hostname), expected.ownerId); assert.equal(decodeURIComponent(ref.pathname.slice(1)), expected.path);
  for (const [parameter, key] of [['snapshot', 'snapshot'], ['file_id', 'fileId']]) if (ref.searchParams.has(parameter)) assert.equal(ref.searchParams.get(parameter), expected[key]);
  const [authoredAt, admittedAt, preparedAt, closedAt, readAt] = [authored.at, admitted.at, preparation.at, closed.at, read.at].map(Date.parse);
  assert.ok([authoredAt, admittedAt, preparedAt, closedAt, readAt].every(Number.isFinite));
  assert.ok(authoredAt <= admittedAt && admittedAt <= readAt && authoredAt <= preparedAt && preparedAt <= closedAt && closedAt <= readAt,
    'Actual selection and source preparation must precede the complete read; metadata admission does not imply a prepared body');
  return { toolCallId: authored.toolCallId, authoredAt: authored.at, admittedAt: admitted.at, argumentsSha256: authored.argumentsSha256,
    publicPrepareRequestId: preparation.requestId, prepareStartedAt: preparation.at, prepareClosedAt: closed.at, selected, expected, resultRef: read.ref };
}

export async function probeGraphObserver({ extension, cliCommand, cliSource, evidenceRoot, matrix = false, resourceLocation = 'ref', largeBody = false, hostIndexResource = false, publicBoundaries = false, discoveryOnly = false, sdkFixture, discoveryMode, packagePath }) {
  assert.ok(['ref', 'alias', 'unqualified-ref'].includes(resourceLocation));
  assert.equal(typeof largeBody, 'boolean');
  assert.equal(typeof hostIndexResource, 'boolean');
  assert.equal(typeof publicBoundaries, 'boolean');
  assert.equal(typeof discoveryOnly, 'boolean');
  assert.ok(!discoveryOnly || !matrix && !largeBody && !hostIndexResource && !publicBoundaries, 'Discovery-only is one independent three-request controlled probe');
  assert.ok(!publicBoundaries || !matrix && !largeBody && !hostIndexResource, 'The public-boundary probe uses one cold native command within the existing ten-request limit');
  assert.ok(!hostIndexResource || !largeBody, 'The host-index resource probe requires a complete native main read within the existing page limit');
  const experiment = discoveryStrategy({ sdkFixture, discoveryMode, packagePath, discoveryOnly, matrix, largeBody, hostIndexResource, publicBoundaries });
  const installed = experiment ? await packageIdentity({ extension, packagePath }) : undefined;
  const cliIdentity = experiment ? { ...await entryIdentity(cliCommand[1]), sdk: await entryIdentity(join(dirname(cliCommand[1]), 'sdk.js')) } : undefined;
  let piIdentity;
  if (experiment) {
    const host = await resolveHost('pi'); let directory = dirname(host.identity);
    for (;;) {
      const path = join(directory, 'package.json'); let metadata;
      try { metadata = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (metadata?.name === '@earendil-works/pi-coding-agent') {
        assert.equal(metadata.version, '1.5.0', 'This controlled discovery pair is frozen to installed Pi 1.5.0');
        piIdentity = { host, version: metadata.version, entry: await entryIdentity(host.identity), package: await entryIdentity(path) }; break;
      }
      assert.notEqual(directory, dirname(directory), 'Cannot identify the installed Pi package'); directory = dirname(directory);
    }
  }
  await mkdir(evidenceRoot, { recursive: true });
  const evidence = await mkdtemp(join(evidenceRoot, 'graph-observer-http-'));
  const scratch = await mkdtemp(join(await systemTempRoot(), 'broker-graph-observer-http-'));
  const project = await createOwnedGraphProject(join(scratch, 'project'));
  const projectPaths = '\n\nCurrent owned project files (paths only; read the actual source when needed):\n' + project.files.map(file => '- ' + file.path).join('\n') + '\n';
  const rootBodySuffix = largeBody ? '\nCONTROLLED_LARGE_LITERAL_SECTION\n' + '<b>literal evidence & detail</b> [brackets] (group) "quoted" \\ value.\n'.repeat(800) : '';
  const fixture = experiment ? await copySdkDiscoveryFixture(sdkFixture, join(scratch, 'fixture'))
    : await createGraphFixture({ directory: join(scratch, 'fixture'), evidence: join(evidence, 'source'), cliCommand, cliSource, rootBodySuffix, rootResource: hostIndexResource });
  let nativeSkill;
  if (experiment) {
    const path = join(scratch, 'native-skills', 'catalog-canary', 'SKILL.md');
    nativeSkill = { name: 'catalog-canary', description: 'Owned ordinary native Skill catalog probe.', path, marker: 'SC06_UNSELECTED_NATIVE_BODY_MUST_NOT_LOAD' };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `---\nname: ${nativeSkill.name}\ndescription: ${nativeSkill.description}\n---\n\n${nativeSkill.marker}\n`, { mode: 0o600 });
    nativeSkill.sha256 = hash(await readFile(path));
  }
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
  const result = { version: 1, status: 'running', evidence, scratch, resourceLocation, largeBody, hostIndexResource, publicBoundaries, discoveryOnly, sourceMode: experiment ? 'sdk' : 'command', toolContract: 'agent-cli-ref-20261105', rootMainBytes: Buffer.byteLength(fixture.graph.root.body), nativePathNode: { id: nativePathNode.record.id, bytes: Buffer.byteLength(nativePathNode.body), sha256: hash(nativePathNode.body), role: largeBody ? 'required' : 'root' }, harness: await graphHarnessIdentity(), proofLayer: experiment
    ? 'Controlled actual HTTP provider + installed Pi + cloned warm offline bundled SDK source; public projection/cost wiring only, no real model, production Notion or task-benefit claim'
    : 'controlled actual HTTP provider + installed Pi + explicit custom-command Node/SQLite source; no default SDK, real model or production Notion proof',
    ...(experiment ? { discoveryExperiment: experiment, installed, cliIdentity, piIdentity, fixture: fixture.identity, nativeSkill,
      costObserverSource: await entryIdentity(fileURLToPath(new URL('./skill-consumption-cost.mjs', import.meta.url))) } : {}) };
  await save(join(evidence, 'result.json'), result); console.log(JSON.stringify(result));
  let requests = 0, serverError, negativeStep = 0, initialMainRead = false, helpRead = false, indexMainPath, indexMainCall, indexMainSource, memberReadCall, activeOutput;
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); const number = ++requests;
      await appendFile(providerFile, JSON.stringify({ number, method: request.method, wireBodySha256: hash(raw), body }) + '\n');
      assert.deepEqual(body.tools.map(tool => tool.function?.name ?? tool.name).sort(), [...GRAPH_GATE_TOOLS].sort(), 'The real SDK must advertise all three product tools and no shell');
      const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
      const system = strings(body.messages.filter(message => message.role === 'system').map(message => message.content)).join('\n\n');
      assert.equal(system.split(projectPaths).length - 1, 1, 'The original owned project paths must reach the actual HTTP system prompt exactly once');
      if (nativeSkill) {
        assert.ok(system.includes(nativeSkill.name) && system.includes(nativeSkill.description) && system.includes(nativeSkill.path), 'The native canary remains in the actual model directory');
        assert.equal(JSON.stringify(body).includes(nativeSkill.marker), false, 'The unselected native body must not load');
      }
      const texts = strings(body.messages).map(value => value.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'));
      const source = texts.join('\n');
      assert.equal(source.includes(outsideBody), false, 'Blocked outside bytes must never enter a provider request');
      const parsedResults = texts.flatMap(value => { try { return [JSON.parse(value)]; } catch { return []; } });
      const searches = parsedResults.filter(result => result?.ok === true && result.state === 'known' && Array.isArray(result.records));
      let selected;
      if (discoveryOnly) {
        if (!searches.length) selected = { name: 'notion_list', arguments: { limit: 20 } };
        else if (!initialMainRead) {
          const candidate = searches.at(-1).records.find(record => record.availability === 'available' && record.in_default_view);
          assert.ok(candidate, 'Choose only the actual metadata result, without a private target seed');
          indexMainPath = candidate.ref; indexMainCall = 'observer-call-' + number; initialMainRead = true;
          selected = { name: 'read', arguments: { path: candidate.ref } };
        }
      } else if (!initialMainRead && publicBoundaries) {
        const observations = await rows(activeOutput), actualProvider = observations.filter(event => event.phase === 'provider-request').at(-1), transport = observations.filter(event => event.phase === 'provider-transport-start').at(-1);
        assert.equal(transport?.wireBodySha256, hash(raw));
        assert.equal(actualProvider?.observedPayloadSha256, transport.observedPayloadSha256);
        const mains = actualProvider.contents.filter(file => file.ownerId === nativePathNode.record.id && file.scope === fixture.scope
          && file.snapshot === nativePathNode.snapshot_id && file.sha256 === hash(nativePathNode.body) && file.bytes === Buffer.byteLength(nativePathNode.body));
        assert.equal(mains.length, 1, 'The actual provider must contain exactly one complete immutable selected main');
        const userTexts = (body.messages ?? []).filter(message => message.role === 'user').flatMap(message => strings(message.content));
        const decode = value => value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
        const wrappers = userTexts
          .flatMap(value => [...value.matchAll(/<skill\b([^>]*)>([\s\S]*?)<\/skill>/g)]);
        const root = wrappers.find(match => decode(match[2]).includes(nativePathNode.body));
        const location = /\blocation="([^"]+)"/.exec(root?.[1] ?? '')?.[1];
        const sourceWrappers = userTexts.flatMap(value => [...value.matchAll(/<context-broker-record\b([^>]*)>([\s\S]*?)<\/context-broker-record>/g)]);
        const source = sourceWrappers.find(match => decode(match[2]).includes(nativePathNode.body));
        const reference = decode(/\bref="([^"]+)"/.exec(source?.[1] ?? '')?.[1] ?? '');
        if (location) {
          indexMainPath = decode(location); indexMainSource = 'actual Pi native wrapper';
          assert.ok(observations.some(event => event.phase === 'provided-native-path' && event.path === indexMainPath && event.ref === mains[0].ref && event.source === indexMainSource));
        } else {
          indexMainSource = 'actual Broker source wrapper';
          assert.ok(reference && observations.some(event => event.phase === 'provided-native-reference' && event.reference === reference
            && event.providerPayloadSha256 === actualProvider.observedPayloadSha256 && event.ref === mains[0].ref && event.ownerId === mains[0].ownerId
            && event.scope === mains[0].scope && event.snapshot === mains[0].snapshot && event.sha256 === mains[0].sha256 && event.bytes === mains[0].bytes),
          'Read only the actual source-wrapper ref with its complete immutable owner and provider proof');
          indexMainPath = reference;
        }
        indexMainCall = 'observer-call-' + number;
        initialMainRead = true; selected = { name: 'read', arguments: { path: indexMainPath } };
      } else if (!initialMainRead && hostIndexResource) {
        const system = (body.messages ?? []).filter(message => message.role === 'system').flatMap(message => strings(message.content)).join('\n');
        const locations = [...system.matchAll(/<skill>[\s\S]*?<location>\s*([^<]+)\s*<\/location>[\s\S]*?<\/skill>/g)].map(match => match[1].trim());
        assert.equal(locations.length, 1, 'Use the actual root-only host catalog path, without constructing an index location');
        indexMainPath = locations[0]; indexMainCall = 'observer-call-' + number;
        initialMainRead = true; selected = { name: 'read', arguments: { path: indexMainPath } };
      } else if (!initialMainRead) {
        const wrappers = texts.flatMap(value => [...value.matchAll(/<context-broker-record\b([^>]*)>([\s\S]*?)<\/context-broker-record>/g)]);
        const root = wrappers.find(match => match[2].includes(nativePathNode.body));
        const location = /\bref="([^"]+)"/.exec(root?.[1] ?? '')?.[1] ?? /\bpath="([^"]+)"/.exec(root?.[1] ?? '')?.[1];
        assert.ok(location, 'The initial exact native input must come from the actual complete provider wrapper');
        assert.ok(!/<skill-ref>[^<]*file_id=/.test(root[2]), 'Exercise the public wrapper with omitted File ID against the complete canonical manifest');
        indexMainPath = location; indexMainCall = 'observer-call-' + number;
        initialMainRead = true; selected = { name: 'read', arguments: { path: location } };
      } else if (hostIndexResource && !source.includes(fixture.graph.rootResource.content)) {
        const returnedMain = (await rows(activeOutput)).find(event => event.phase === 'tool-result' && event.toolCallId === indexMainCall && event.complete);
        assert.equal(returnedMain?.content, fixture.graph.root.body, 'The original complete native read must precede its linked resource, including when provider projection deduplicates the repeated main');
        assert.ok(source.includes(fixture.graph.root.body), 'The provider must still contain the complete main instruction');
        const href = /\[the root ledger\]\(([^)]+)\)/.exec(source)?.[1];
        assert.ok(href && !href.startsWith('/') && !href.includes('://'));
        const directories = texts.flatMap(value => [...value.matchAll(/<skill-directory>\s*([\s\S]*?)\s*<\/skill-directory>/g)]).flatMap(match => { try { return [JSON.parse(match[1])]; } catch { return []; } });
        const returnedFile = directories.flatMap(value => value.directory?.files ?? []).find(file => file.path === href);
        const location = indexMainPath.startsWith('sr:') || indexMainPath.startsWith('skill://') ? returnedFile?.ref : join(dirname(indexMainPath), href);
        assert.ok(location, 'The selected directory must supply the exact resource reference');
        selected = { name: 'read', arguments: { path: location } };
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
        selected = { name: 'notion_list', arguments: { query: name, limit: 20 } };
      } else if (!source.includes('GRAPH_MEMBER_OPTIONAL_BODY')) {
        const candidate = searches.at(-1).records.find(record => record.availability === 'available' && !record.in_default_view);
        assert.ok(candidate, 'An exact metadata result must precede explicit preparation');
        if (publicBoundaries) { memberReadCall = 'observer-call-' + number; selected = { name: 'read', arguments: { path: candidate.ref } }; }
        else selected = { name: 'notion_use', arguments: { ref: candidate.ref } };
      } else if (publicBoundaries && !parsedResults.some(value => value?.ok === true && value.status === 'ready' && Array.isArray(value.records))) {
        const candidate = searches.at(-1).records.find(record => record.availability === 'available' && !record.in_default_view);
        const discovered = [...source.slice(source.indexOf('## Members')).matchAll(/\[([^\]]+)\]\((skill:\/\/[^)]+)\)/g)].find(match => match[1] === candidate.name)?.[2];
        assert.ok(discovered, 'Omitting the main path must use an actually visible canonical member ref');
        const reference = new URL(discovered); reference.pathname = ''; reference.search = '';
        selected = { name: 'notion_use', arguments: { ref: reference.href } };
      } else if (!source.includes(fixture.graph.resource.content)) {
        const ref = /\[the ledger evidence\]\((skill:\/\/[^)]+)\)/.exec(source)?.[1];
        assert.ok(ref, 'The resource ref must come from the actual prepared main');
        let target = ref;
        if (resourceLocation === 'alias' || resourceLocation === 'unqualified-ref') {
          const prepared = parsedResults.find(result => result?.ok === true && result.status === 'ready' && Array.isArray(result.records));
          const owner = prepared?.records.find(record => record.content.includes('GRAPH_MEMBER_OPTIONAL_BODY'));
          const fileId = new URL(ref).searchParams.get('file_id');
          const resources = owner?.directory.files.filter(file => file.path !== 'SKILL.md' && file.path !== 'ROUTER.md') ?? [];
          const resource = resources.find(file => file.ref.startsWith('skill://') && new URL(file.ref).searchParams.get('file_id') === fileId)
            ?? (resources.length === 1 ? resources[0] : undefined);
          assert.ok(owner && fileId && resource, 'The discovered canonical resource and actual directory must identify one resource before changing its input form');
          if (resourceLocation === 'unqualified-ref') {
            const input = new URL(ref); input.pathname = resource.path; input.searchParams.delete('snapshot'); input.searchParams.delete('file_id'); target = input.href;
          } else {
            assert.equal(typeof owner.path, 'string', 'The legacy filesystem alias scenario requires an actually advertised physical owner path; a short ref must not be converted into an invented path');
            target = join(dirname(owner.path), resource.path).replace(/^\/private\/tmp\//, '/tmp/');
          }
        }
        selected = { name: 'read', arguments: { path: target } };
      } else if (negativeStep++ === 0) selected = { name: 'read', arguments: { path: outside } };
      else if (negativeStep === 2) selected = { name: 'bash', arguments: { command: 'printf forbidden' } };
      if (number > (experiment ? 3 : matrix ? 30 : 10)) throw new Error('Controlled provider could not complete the discovered native tool chain');
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
  if (!experiment) await save(source, { command: fixture.command, cliPaths: {}, ledger: join(evidence, 'source-processes.jsonl'), responses });
  const config = join(scratch, 'broker.json');
  const modelHelper = fileURLToPath(new URL('./notion-skill-graph-model.mjs', import.meta.url));
  const configuredSource = { type: 'notion', id: 'notion', namespace: 'notion',
    ...(experiment ? { discovery: { offline: true } } : { command: [process.execPath, modelHelper, '--source', source] }),
    database: fixture.graph.root.record.locator.database_id, cacheDir: cache, prefetch: false, activation: { offline: true } };
  await save(config, { skillRoots: [], sources: [configuredSource] });
  if (experiment) { assert.equal(Object.hasOwn(configuredSource, 'command'), false); await save(join(evidence, 'source-config.json'), configuredSource); }
  const prompt = frozenPrompt('B', '$graph-root@notion');
  const submittedPrompt = discoveryOnly ? '请查看默认目录并介绍一个可用工作流。' : publicBoundaries ? prompt.text.replace('$graph-root@notion', '/skill:notion-' + fixture.graph.root.record.alias) : prompt.text;
  const observer = join(scratch, 'observer.mjs');
  const settings = { ...(discoveryOnly ? { entryMode: 'discovery-only' } : { rootRef: fixture.graph.root.record.ref }), model, prompt: submittedPrompt, cache, cwd: project.root, responses, output, project, sourceMode: experiment ? 'sdk' : 'command', piExecutable: (await resolveHost('pi')).identity,
    ...(experiment ? { discoveryExperiment: experiment } : {}) };
  const parserUrl = pathToFileURL(join(dirname(extension), 'native-reference.ts')).href;
  const observerSource = value => graphObserverModule(value, parserUrl);
  await writeFile(observer, observerSource(settings));
  let rpc;
  try {
    const env = { ...isolatedEnv({ base: scratch, agentDir: join(scratch, 'agent'), ...(experiment ? fixture.environment : {}),
      CONTEXT_BROKER_CONFIG: config, CONTEXT_BROKER_HOST: 'pi', BROKER_E2E_PROCESS_LEDGER: join(evidence, 'owned-processes.jsonl'),
      ...(experiment ? { NTN_SKILLS_REQUEST_TRACE_LIMIT: '10000' } : {}) }), ...traps.environment };
    let priorResponseFiles = [];
    result.samples = []; result.sessions = [];
    for (let launch = 0; launch < (matrix ? 3 : 1); launch++) {
      const retained = join(evidence, 'run-' + launch), currentResponses = join(retained, 'source-responses'), currentOutput = join(retained, 'observer.jsonl'), sessionDir = join(scratch, 'sessions', 'run-' + launch);
      activeOutput = currentOutput;
      await mkdir(currentResponses, { recursive: true }); await mkdir(sessionDir); await writeFile(currentOutput, '');
      if (!experiment) await save(source, { command: fixture.command, cliPaths: {}, ledger: join(evidence, 'source-processes.jsonl'), responses: currentResponses });
      const currentSettings = { ...settings, responses: currentResponses, output: currentOutput, priorResponseFiles };
      await writeFile(observer, observerSource(currentSettings));
      let cost;
      const args = ['--no-extensions', '--no-skills', '--no-mcp', '--no-context-files', '--no-prompt-templates', '--tools', GRAPH_GATE_TOOLS.join(','), '--session-dir', sessionDir,
        ...(nativeSkill ? ['--skill', nativeSkill.path] : []), '-e', provider, '-e', extension, '-e', observer, '--model', model];
      if (experiment) {
        const hook = await sourceObserver(join(scratch, 'control'), { ledger: join(evidence, 'source-processes.jsonl'), responses: currentResponses,
          outputRoot: cache, cliEntries: [cliCommand[1], join(installed.packageRoot, 'dist/ntn-skills.mjs')] });
        env.NODE_OPTIONS = '--import=' + hook;
        cost = { path: join(retained, 'consumption-cost.jsonl'), extension: join(scratch, 'consumption-cost.mjs'),
          sampleId: 'discovery-' + experiment.mode, clockId: 'smoke-' + process.pid };
        await writeFile(cost.extension, consumptionCostExtensionSource({ output: cost.path,
          checkoutRoot: fileURLToPath(new URL('..', import.meta.url)), runId: basename(evidence), sampleId: cost.sampleId, clockId: cost.clockId }), { mode: 0o600 });
        args.push('-e', cost.extension);
        await save(join(retained, 'launch.json'), { args, cwd: project.root, sourceMode: 'sdk', sourceCommandConfigured: false,
          sourceHook: { path: hook, sha256: hash(await readFile(hook)) }, graphObserverSha256: hash(await readFile(observer)),
          costObserver: { path: cost.extension, sha256: hash(await readFile(cost.extension)), source: result.costObserverSource, loadedLast: true },
          sourceState: fixture.identity.sourceState, timeoutMs: 90000, controlledProviderRequests: 3, realModelRequests: 0 });
      }
      negativeStep = 0; initialMainRead = false; helpRead = false; indexMainPath = undefined; indexMainCall = undefined; indexMainSource = undefined; memberReadCall = undefined;
      rpc = await startRpc({ host: 'pi', cwd: project.root, env, timeoutMs: 90000, args });
      const firstRequest = requests;
      for (let turn = 0; turn < (matrix && launch === 2 ? 3 : 1); turn++) {
        const before = requests, startedAt = new Date().toISOString();
        if (cost) {
          cost.submission = { sampleId: cost.sampleId, clockId: cost.clockId, monotonicNs: process.hrtime.bigint().toString(), promptSha256: hash(submittedPrompt) };
          await save(join(retained, 'cost-submission.json'), cost.submission);
        }
        await rpc.prompt(submittedPrompt);
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
      if (discoveryOnly) {
        assert.equal(providers.length, 3); assert.equal(providers[0].contents.length, 0);
        const metadata = observed.find(event => event.phase === 'metadata-result' && event.complete);
        const call = observed.find(event => event.phase === 'tool-call' && event.toolCallId === indexMainCall);
        const read = observed.find(event => event.phase === 'tool-result' && event.toolCallId === indexMainCall && event.complete);
        const inspected = experiment ? fixture.graph.nodes.find(node => node.record.id === read?.ownerId && node.scope === read?.scope) : fixture.graph.root;
        assert.ok(metadata && call?.allowed && call.discovered && inspected && read?.ownerId === inspected.record.id);
        if (experiment) assert.ok(fixture.defaultView.records.some(record => record.id === inspected.record.id), 'Inspect only a real default fixture candidate');
        assert.ok(metadata.sequence < call.sequence && call.sequence < read.sequence);
        assert.equal(read.sha256, hash(inspected.body));
        assert.ok(providers.some(event => event.sequence > read.sequence && event.contents.some(file => file.ref === read.ref && file.sha256 === read.sha256)));
        assert.ok(providers.every(event => event.contents.every(file => file.ownerId === inspected.record.id)), 'Inspect must not activate Requires or optional Members');
        assert.equal(observed.filter(event => event.phase === 'preparation-result').length, 0);
        if (experiment) {
          for (const provider of providers.filter(event => event.sequence > read.sequence)) {
            const copies = provider.contents.filter(file => file.ownerId === inspected.record.id && file.scope === inspected.scope
              && file.snapshot === inspected.snapshot_id && file.sha256 === hash(inspected.body) && file.bytes === Buffer.byteLength(inspected.body));
            assert.equal(copies.length, 1, 'The actual inspected body must reach each later provider exactly once');
          }
          const inputCatalogs = assertDiscoveryProjection({ observation: observed, experiment });
          const ready = inputCatalogs.filter(catalog => catalog.state === 'ready');
          assert.ok(ready.length > 0, 'Actual list completion must reach a subsequent ready public projection');
          for (const catalog of ready) {
            assert.equal(catalog.skills.length, fixture.defaultView.records.length);
            assert.deepEqual(catalog.skills.map(skill => [skill.provenance?.scope, skill.provenance?.ownerId, skill.name]).sort(),
              fixture.defaultView.records.map(record => [fixture.scope, record.id, record.name]).sort());
            assert.ok(catalog.skills.every(skill => skill.provenance?.source === 'verified-notion-metadata' && skill.provenance.loaded === false));
          }
          await rpc.closeInput();
          await save(join(retained, 'rpc-lifecycle.json'), rpc.lifecycle);
          const terminalObservation = await rows(currentOutput);
          assert.equal(terminalObservation.filter(event => event.phase === 'provider-request').length, 3);
          assert.equal(terminalObservation.some(event => event.phase === 'observer-error'), false);
          const events = await readConsumptionCostEvents(cost.path);
          result.discoveryCost = summarizeDiscoveryCosts({ events: events.events, observation: terminalObservation, submission: cost.submission });
          assert.equal(result.discoveryCost.providerRequests, 3); assert.equal(result.discoveryCost.modelHttpAttempts, 3);
          assert.equal(result.discoveryCost.toolCalls, 2); assert.equal(result.discoveryCost.toolRounds, 2);
          result.catalogProjection = { readyInputCatalogs: ready.length, inputStates: inputCatalogs.map(catalog => catalog.state),
            defaultRecords: fixture.defaultView.records, actualPublicHookAndHttp: true, nativeCanaryPreserved: true };
          await save(join(retained, 'discovery-cost.json'), result.discoveryCost);
          const ledger = await rows(join(evidence, 'source-processes.jsonl'));
          const receipts = await Promise.all((await readdir(currentResponses)).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(currentResponses, name), 'utf8'))));
          result.sourceAccounting = graphSourceAccounting(ledger, receipts, { sourceMode: 'sdk', requireConsumption: true });
          assert.ok(receipts.every(receipt => receipt.status === 'completed'), 'This completed inspect cannot borrow a cancelled or failed source result');
          for (const receipt of receipts) assert.equal(receipt.metrics.total_requests, receipt.metrics.trace.filter(event => event.event === 'attempt').length);
          assert.equal(result.sourceAccounting.actual_http_attempts, 0); assert.equal(result.sourceAccounting.cli_children, 0);
          await save(join(retained, 'source-accounting.json'), result.sourceAccounting);
        } else await rpc.stop();
        await save(join(retained, 'pi-rpc.json'), rpc.frames); rpc = undefined;
        result.sessions.push({ launch, providerRequests: 3, entryMode: 'discovery-only', privateRootSeed: false, metadataSequence: metadata.sequence,
          read: { ref: read.ref, scope: read.scope, snapshot: read.snapshot, sha256: read.sha256, bytes: read.bytes } });
        continue;
      }
      assert.ok(providers.length >= 4);
      for (const event of providers) for (const node of fixture.graph.nodes.filter(node => fixture.graph.useIds.includes(node.record.id))) {
        const copies = event.contents.filter(file => file.ownerId === node.record.id && file.role === 'entrypoint');
        assert.equal(copies.length, 1); assert.equal(copies[0].sha256, hash(node.body));
      }
      assert.equal(providers[0].contents.some(file => file.ownerId === fixture.graph.member.record.id), false, 'A fresh warm session must not inherit optional member context');
      assert.ok(observed.some(event => event.phase === 'project-read-result' && event.complete));
      const initialCall = observed.find(event => event.phase === 'tool-call' && event.toolCallId === indexMainCall);
      assert.ok(initialCall?.allowed && initialCall.discovered && initialCall.input === indexMainPath, 'The exact initial input must have been discovered in the actual provider request before admission');
      assert.ok(observed.some(event => event.phase === 'tool-result' && event.tool === 'read' && event.ownerId === nativePathNode.record.id
        && event.complete && event.sha256 === hash(nativePathNode.body)), 'The initial advertised main path must reach native read with its exact manifest identity');
      if (publicBoundaries) {
        assert.ok(observed.some(event => event.source === indexMainSource
          && (event.phase === 'provided-native-path' && event.path === indexMainPath || event.phase === 'provided-native-reference' && event.reference === indexMainPath)));
        const main = observed.find(event => event.phase === 'tool-result' && event.toolCallId === indexMainCall && event.complete);
        assert.ok(main?.ownerId === nativePathNode.record.id && main.bytes === Buffer.byteLength(nativePathNode.body));
        assert.equal(main.scope, fixture.scope); assert.equal(main.snapshot, nativePathNode.snapshot_id); assert.equal(main.sha256, hash(nativePathNode.body));
        assert.ok(providers.some(event => event.sequence > main.sequence && event.contents.filter(file => file.ref === main.ref && file.sha256 === main.sha256).length === 1));
        const prepared = observed.find(event => event.phase === 'preparation-result' && event.complete);
        const prepareCall = observed.find(event => event.phase === 'authored-tool-call' && event.toolCallId === prepared.toolCallId);
        assert.equal(new URL(prepareCall.input.ref).pathname, '', 'The actual public use input must omit the optional main path');
        const authored = observed.find(event => event.phase === 'authored-tool-call' && event.toolCallId === memberReadCall);
        const admitted = observed.find(event => event.phase === 'tool-call' && event.toolCallId === memberReadCall);
        const read = observed.find(event => event.phase === 'tool-result' && event.toolCallId === memberReadCall && event.complete);
        const ledger = await rows(join(evidence, 'source-processes.jsonl'));
        const preparation = ledger.find(event => event.phase === 'spawn' && ['prepare', 'ctl'].includes(event.command) && event.args.includes('inspect') && event.args.some(arg => {
          try { return new URL(arg).protocol === 'skill:' && decodeURIComponent(new URL(arg).hostname) === read.ownerId; } catch { return false; }
        }));
        const closed = ledger.find(event => event.phase === 'close' && event.requestId === preparation?.requestId && event.code === 0);
        const authoredRead = verifyPublicReadBoundary({ authored, admitted, read, preparation, closed, expected: { ownerId: fixture.graph.member.record.id,
          scope: fixture.scope, path: 'SKILL.md', snapshot: fixture.graph.member.snapshot_id,
          fileId: fixture.graph.member.file_bindings.find(file => file.path === 'SKILL.md').file_id,
          sha256: hash(fixture.graph.member.body), bytes: Buffer.byteLength(fixture.graph.member.body) } });
        result.publicBoundaryProof = { nativeMain: { toolCallId: main.toolCallId, ref: main.ref, scope: main.scope, snapshot: main.snapshot, sha256: main.sha256, bytes: main.bytes },
          omittedMainPath: { toolCallId: prepared.toolCallId, roots: prepared.roots, sha256: prepared.sha256, bytes: prepared.bytes },
          authoredRead };
      }
      if (hostIndexResource) {
        const binding = observed.find(event => event.phase === 'host-index-binding' && event.ownerId === fixture.graph.root.record.id);
        const resource = observed.find(event => event.phase === 'tool-result' && event.tool === 'read' && event.ownerId === fixture.graph.root.record.id && event.role === 'resource' && event.complete);
        const fileId = fixture.graph.root.file_bindings.find(file => file.path === fixture.graph.rootResource.path).file_id;
        if (indexMainPath.startsWith('/')) {
          assert.ok(binding?.manifestId && binding.receiptSha256 && binding.fileId);
          assert.equal(resource?.requested, join(dirname(indexMainPath), fixture.graph.rootResource.path));
          assert.ok(resource.sequence > binding.sequence);
        } else {
          assert.ok(resource?.requested.startsWith('sr:R'), 'A session catalog ref must lead to its actually returned resource handle');
          const main = observed.find(event => event.phase === 'tool-result' && event.toolCallId === indexMainCall && event.complete);
          assert.ok(main && resource.sequence > main.sequence);
        }
        assert.equal(resource?.logicalId, fileId); assert.equal(resource?.sha256, hash(fixture.graph.rootResource.content));
        assert.equal(resource?.bytes, Buffer.byteLength(fixture.graph.rootResource.content));
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
      assert.ok(observed.some(event => event.phase === 'tool-result' && event.tool === 'notion_use' && event.preparationProof?.explicitRoot && event.complete));
      for (const delivery of observed.filter(event => ['metadata-result', 'preparation-result'].includes(event.phase) && event.complete)) assert.ok(providers.some(event => event.sequence > delivery.sequence && event.toolResults.some(result => result.toolCallId === delivery.toolCallId && result.sha256 === delivery.sha256 && result.bytes === delivery.bytes && result.exactToolOutputCopies === 1)), 'The actual full tool output must reach the SDK provider under the same tool call ID');
      const actualPayloads = (await rows(providerFile)).slice(firstRequest);
      assert.ok(actualPayloads.some(event => JSON.stringify(event.body.messages).includes('Tool bash not found')), 'The actual SDK must reject an unadvertised shell tool');
      const catalogs = observed.filter(event => event.phase === 'catalog');
      assert.equal(catalogs.length, providers.length);
      for (const [index, catalog] of catalogs.entries()) {
        assert.equal(catalog.stage, 'before_provider_request');
        assert.equal(catalog.providerPayloadSha256, providers[index].observedPayloadSha256);
        assert.ok(catalog.skills.every(skill => skill.provenance?.ownerId === fixture.graph.root.record.id));
      }
      await save(join(retained, 'pi-rpc.json'), rpc.frames); await rpc.stop(); rpc = undefined;
      result.sessions.push({ launch, providerRequests: providers.length, catalog: catalogs.at(-1), catalogSnapshots: catalogs, hostHelp: help, reads: observed.filter(event => ['tool-result', 'project-read-result'].includes(event.phase)).map(({ content, ...receipt }) => receipt) });
      for (const name of await readdir(currentResponses)) { const path = join(currentResponses, name); priorResponseFiles.push({ path, sha256: hash(await readFile(path)) }); }
      await save(join(retained, 'cache-reuse-responses.json'), priorResponseFiles);
    }
    if (!experiment) assert.equal((await rows(fixture.httpPath)).length, 0);
    assert.equal((await rows(traps.ledger)).length, 0);
    result.status = 'passed'; result.providerRequests = requests;
    result.projectPaths = { source: 'public-systemPromptOptions.sections', bytes: Buffer.byteLength(projectPaths), sha256: hash(projectPaths), copiesPerProvider: 1 };
    result.toolPolicy = discoveryOnly ? { advertised: GRAPH_GATE_TOOLS, discoveryOnly: true, privateRootSeed: false, actualMetadataBeforeRead: true,
      fullProviderBody: true, unselectedRequiresAndMembers: 0, legacyFallbackCalls: 0 }
      : { advertised: GRAPH_GATE_TOOLS, initialAdvertisedMainInput: true, hostCatalogResource: hostIndexResource, omittedResourceIdentityFields: resourceLocation === 'unqualified-ref', nativeCommandMainPath: publicBoundaries && indexMainSource === 'actual Pi native wrapper',
        ...(publicBoundaries ? { nativeCommandMainReference: true, mainInputSource: indexMainSource } : {}), omittedMainPath: publicBoundaries, authoredSelectionBeforePrepareRead: publicBoundaries, hostHelpRead: true, metadataList: true, exactUsePreparation: true, outsideReadBlocked: true, shellToolRejected: true, fullToolOutputHashes: true, legacyFallbackCalls: 0 };
  } catch (error) { result.status = 'failed'; result.error = { code: error.code ?? 'OBSERVER_PROBE_FAILED', message: error.message }; }
  finally {
    if (rpc) { await save(join(evidence, 'pi-rpc.json'), rpc.frames); try { await rpc.stop(); } catch (error) { result.status = 'failed'; result.error ??= { message: error.message }; } }
    server.closeAllConnections(); await new Promise(accept => server.close(accept)); await fixture.close();
    if (installed) {
      try {
        const checks = await Promise.all(installed.runtimeFiles.map(async file => hash(await readFile(join(installed.packageRoot, file.path))) === file.sha256));
        result.harnessAfter = await graphHarnessIdentity();
        result.frozenInputsUnchanged = checks.every(Boolean) && hash(await readFile(installed.package.path)) === installed.package.sha256
          && hash(await readFile(cliIdentity.path)) === cliIdentity.sha256 && hash(await readFile(cliIdentity.sdk.path)) === cliIdentity.sdk.sha256
          && hash(await readFile(piIdentity.entry.path)) === piIdentity.entry.sha256 && hash(await readFile(piIdentity.package.path)) === piIdentity.package.sha256
          && hash(await readFile(sdkFixture)) === fixture.identity.sha256 && result.harnessAfter.sha256 === result.harness.sha256
          && hash(await readFile(result.costObserverSource.path)) === result.costObserverSource.sha256;
        assert.equal(result.frozenInputsUnchanged, true, 'Frozen runtime, fixture or harness identity changed');
      } catch (error) { result.status = 'failed'; result.error ??= { message: error.message }; }
    }
  }
  result.finishedAt = new Date().toISOString(); await save(join(evidence, 'result.json'), result); return result;
}

export function parseGraphObserverOptions(argv) {
  const options = {}; const args = [...argv]; while (args.length) { const key = args.shift(); assert.ok(['--extension', '--cli-entry', '--cli-source', '--evidence-root', '--matrix', '--resource-location', '--large-body', '--host-index-resource', '--public-boundaries', '--discovery-only', '--sdk-fixture', '--discovery-mode', '--package-path'].includes(key) && args.length);
    assert.equal(Object.hasOwn(options, key.slice(2)), false, 'Duplicate probe options are not a frozen input'); options[key.slice(2)] = args.shift(); }
  discoveryStrategy({ sdkFixture: options['sdk-fixture'], discoveryMode: options['discovery-mode'], packagePath: options['package-path'],
    discoveryOnly: options['discovery-only'] === 'true', matrix: options.matrix === 'true', largeBody: options['large-body'] === 'true',
    hostIndexResource: options['host-index-resource'] === 'true', publicBoundaries: options['public-boundaries'] === 'true' });
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseGraphObserverOptions(process.argv.slice(2));
  const result = await probeGraphObserver({ extension: options.extension, cliCommand: [process.execPath, options['cli-entry']], cliSource: options['cli-source'], evidenceRoot: options['evidence-root'], matrix: options.matrix === 'true', resourceLocation: options['resource-location'] ?? 'ref', largeBody: options['large-body'] === 'true', hostIndexResource: options['host-index-resource'] === 'true', publicBoundaries: options['public-boundaries'] === 'true', discoveryOnly: options['discovery-only'] === 'true',
    sdkFixture: options['sdk-fixture'], discoveryMode: options['discovery-mode'], packagePath: options['package-path'] });
  console.log(JSON.stringify(result, null, 2)); if (result.status !== 'passed') process.exitCode = 1;
}
