import assert from 'node:assert/strict';

/** Host selection belongs to verification orchestration, not the source adapter.
 * A Pi-only run must neither probe nor launch an unrelated installed host.
 * Cross-host cache and native-editor scenarios remain explicitly multi-host.
 */
export function selectIntegrationHosts({ host, sharedCatalog = false, cacheLifecycle = false }) {
  if (host !== undefined && !['pi', 'omp'].includes(host)) {
    throw new Error('--host must be pi or omp; omit it to run both hosts');
  }
  if (host !== undefined && (sharedCatalog || cacheLifecycle)) {
    throw new Error('--host cannot narrow shared-catalog or cache-lifecycle: those scenarios require multiple hosts');
  }
  return host === undefined ? ['pi', 'omp'] : [host];
}

/** Preserve the default policy unless a run explicitly selects the daily mode. */
export function selectIntegrationPrefetch(value) {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('--prefetch must be true or false');
}

export function decodeCatalogText(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_match, name) => entities[name]);
}

/** Select the owner of the supplied ref; the public read still validates its pin. */
export function selectLiveCatalogRecord(records, ref) {
  const owner = value => {
    const match = /^skill:\/\/([^/]+)\//u.exec(value ?? '');
    assert.ok(match, 'A public Skill ref with an owner and path is required');
    return decodeURIComponent(match[1]);
  };
  const target = owner(ref);
  const uuid = value => typeof value === 'string' && /^(?:[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/iu.test(value) ? value.replaceAll('-', '').toLowerCase() : undefined;
  const exact = records.filter(record => record.id === target || record.ref === ref || owner(record.ref) === target
    || uuid(target) !== undefined && [record.locator?.page_id, record.locator?.subscription_id].some(id => uuid(id) === uuid(target)));
  const matches = exact.length ? exact : records.filter(record => record.name === target || record.alias === target);
  assert.equal(matches.length, 1, 'Requested real Skill owner must match exactly one selected catalog record');
  return matches[0];
}

/** Copy a resource issued with the selected body, never append a path to sr:. */
export function projectedResourceRef(context, name, path) {
  const texts = context.messages.map(message => typeof message.content === 'string' ? message.content
    : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n'));
  const records = texts.flatMap(text => [...text.matchAll(/<context-broker-record\b([^>]*)>([\s\S]*?)<\/context-broker-record>/gu)])
    .filter(record => decodeCatalogText(/\bname="([^"]*)"/u.exec(record[1])?.[1] ?? '') === name);
  assert.equal(records.length, 1, 'Selected body owner must have one actual provider projection');
  const blocks = [...records[0][2].matchAll(/<resources>([\s\S]*?)<\/resources>/gu)];
  assert.equal(blocks.length, 1, 'Selected body must advertise its resource directory');
  const files = JSON.parse(decodeCatalogText(blocks[0][1])).filter(file => file.path === path);
  assert.equal(files.length, 1, 'Requested resource must belong to the selected body');
  assert.match(files[0].ref, /^sr:R[A-Za-z0-9_-]{22}$/u);
  return files[0].ref;
}

export function measuredConsumptionArgs(args) {
  const measured = ['list', 'prepare', 'read', 'files', 'use'].includes(args[0]) || args[0] === 'ctl' && args[1] === 'prepare';
  if (!measured || args.includes('--raw')) return args;
  return [...args, ...(args.includes('--json') ? [] : ['--json']), ...(args.includes('--metrics') ? [] : ['--metrics'])];
}
