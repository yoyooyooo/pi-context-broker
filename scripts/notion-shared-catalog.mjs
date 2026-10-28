import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isolatedEnv } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { database } from './notion-integration-fixture.mjs';

export async function runSharedCatalog({ scratch, evidence, fixture, extension, scriptedProvider }) {
  const cache = join(scratch, 'shared-notion-cache');
  const alternate = join(scratch, 'shared-node-alias');
  await symlink(fixture.command[0], alternate);
  const peers = [];
  const revision = 'SHARED_NOTION_REVISION_B_8CA2';
  const result = { host: 'pi+omp', mode: 'shared-catalog', status: 'running', cases: [], files: ['shared-catalog-result.json'] };
  const rows = async path => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const calls = () => rows(fixture.callsPath);
  const counts = async () => {
    const entries = await calls();
    return { list: entries.filter(row => row.command === 'list').length, export: entries.filter(row => row.command === 'export' && row.phase === 'completed').length };
  };
  const catalogs = async () => {
    const keys = await readdir(join(cache, 'catalogs-v4'));
    assert.equal(keys.length, 1, 'Both hosts must use one remote catalog identity');
    const directory = join(cache, 'catalogs-v4', keys[0], 'published');
    const order = (await readdir(directory)).filter(name => /^[0-9]{20}$/.test(name)).sort().at(-1);
    return JSON.parse(await readFile(join(directory, order, 'receipt.json'), 'utf8'));
  };
  const snapshots = async () => {
    const files = await readdir(cache, { recursive: true });
    return Promise.all(files.filter(path => /[/\\]snapshots[/\\]s_[0-9a-f]{64}[/\\]\.broker-snapshot\.json$/.test(path)).map(async path => {
      const receipt = JSON.parse(await readFile(join(cache, path), 'utf8'));
      const entry = join(cache, path.slice(0, -'.broker-snapshot.json'.length), receipt.entry);
      return { snapshot: receipt.snapshot, entry, body: await readFile(entry, 'utf8') };
    }));
  };
  const open = async (host, label) => {
    const base = join(scratch, 'shared-' + label), agentDir = join(base, 'agent');
    await mkdir(join(agentDir, 'context-broker'), { recursive: true });
    const source = { type: 'notion', id: host + '-source', namespace: host,
      command: host === 'pi' ? fixture.command : [alternate, ...fixture.command.slice(1)],
      database: host === 'pi' ? database : 'fixture', cacheDir: cache };
    const config = join(agentDir, 'context-broker', 'config.yml');
    await writeFile(config, JSON.stringify({ sources: [source] }));
    const provider = await scriptedProvider(base), output = join(evidence, label + '-provider.jsonl');
    const env = isolatedEnv({ base, agentDir, CONTEXT_BROKER_HOST: host, CONTEXT_BROKER_CONFIG: config,
      CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: output, CONTEXT_BROKER_LOG_FILE: join(evidence, label + '-decisions.jsonl') });
    const args = ['--no-extensions', '--session-dir', join(base, 'sessions'), '--tools', 'read', '-e', provider, '-e', extension,
      '--model', 'context-broker-e2e/fake', ...(host === 'omp' ? ['--no-title', '--no-rules'] : [])];
    const rpc = await startRpc({ host, cwd: base, env, args });
    const peer = { host, label, base, rpc, output };
    peers.push(peer);
    result.files.push(label + '-provider.jsonl', label + '-decisions.jsonl', label + '-rpc.json');
    return peer;
  };
  const consume = async (peer, updated) => {
    await peer.rpc.prompt(`$${fixture.alias}@${peer.host} Apply these instructions to this task.`);
    const capture = (await rows(peer.output)).at(-1);
    const context = JSON.stringify(capture.context.messages);
    assert.equal(context.split(fixture.marker).length - 1, 1, 'Each effective context contains the selected body once');
    assert.equal(context.includes(revision), updated, 'An active session retains its version; a fresh session obtains the updated version');
  };
  try {
    await fixture.setScenario('normal', { cacheIdentity: true, defaultContext: false });
    const pi = await open('pi', 'shared-pi-a');
    await consume(pi, false);
    const first = await counts(), catalogA = await catalogs(), exportsA = await snapshots();
    assert.equal(first.list, 1);
    assert.equal(first.export, 1);
    assert.equal(exportsA.length, 1);
    const omp = await open('omp', 'shared-omp-a');
    await consume(omp, false);
    assert.deepEqual(await counts(), first, 'A different cwd, host, namespace, command and database spelling reuse the catalog and immutable export');
    const catalogWarm = await catalogs();
    assert.equal(catalogWarm.indexId, catalogA.indexId);
    assert.equal(catalogWarm.result.freshness.validated_at, catalogA.result.freshness.validated_at);
    result.cases.push({ name: 'cross-project-host-reuse', status: 'passed', cwd: [pi.base, omp.base], indexId: catalogA.indexId,
      validatedAt: catalogA.result.freshness.validated_at, snapshot: exportsA[0].snapshot, calls: first });

    await fixture.setScenario('normal', { cacheIdentity: true, defaultContext: false, revision });
    await omp.rpc.prompt('/context-broker refresh');
    const catalogB = await catalogs();
    assert.notEqual(catalogB.indexId, catalogA.indexId, 'Explicit refresh replaces the same catalog pointer');
    assert.equal((await counts()).list, first.list + 1);
    await consume(omp, false);
    await consume(pi, false);
    result.cases.push({ name: 'shared-refresh-keeps-active-sessions', status: 'passed', indexId: catalogB.indexId });

    const ompNew = await open('omp', 'shared-omp-b');
    await consume(ompNew, true);
    const afterUpdate = await counts(), exportsB = await snapshots();
    assert.equal(afterUpdate.export, first.export + 1);
    assert.equal(exportsB.length, 2);
    assert.equal(exportsB.filter(snapshot => snapshot.body.includes(revision)).length, 1);
    assert.equal((await catalogs()).indexId, catalogB.indexId);
    const piNew = await open('pi', 'shared-pi-b');
    await consume(piNew, true);
    assert.deepEqual(await counts(), afterUpdate, 'The other host reuses the newly exported revision without another list/export');
    result.cases.push({ name: 'fresh-sessions-share-new-revision', status: 'passed', snapshots: exportsB.map(snapshot => snapshot.snapshot), calls: afterUpdate });
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed'; result.error = error.message;
    error.results = [result];
    throw error;
  } finally {
    for (const peer of peers) {
      await writeFile(join(evidence, peer.label + '-rpc.json'), JSON.stringify(peer.rpc.frames, null, 2));
      await peer.rpc.stop();
    }
    await writeFile(join(evidence, 'shared-catalog-result.json'), JSON.stringify(result, null, 2) + '\n');
  }
  return result;
}
