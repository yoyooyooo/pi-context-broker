import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const pid = value => Number.isSafeInteger(value) && value > 0;
const ns = value => typeof value === 'string' && /^\d+$/.test(value);
const fileIdentity = value => value && typeof value.path === 'string' && isAbsolute(value.path)
  && typeof value.realpath === 'string' && isAbsolute(value.realpath) && /^[a-f0-9]{64}$/.test(value.sha256)
  && Number.isSafeInteger(value.bytes) && value.bytes >= 0;
const sameEntry = (left, right) => left?.realpath === right?.realpath && left?.sha256 === right?.sha256 && left?.bytes === right?.bytes;

function osAncestry(start) {
  const value = start.osAncestry;
  if (!value || value.complete !== true) return null;
  const require = condition => { if (!condition) throw new Error('CLI_OS_ANCESTRY_INVALID'); };
  require(value.version === 1 && value.method === 'unix-ps-pid-ppid-lstart-v1' && ['darwin', 'linux'].includes(value.platform)
    && pid(value.stopPid) && ns(value.startedNs) && ns(value.finishedNs)
    && BigInt(value.startedNs) <= BigInt(value.finishedNs) && BigInt(value.finishedNs) <= BigInt(start.monotonicNs)
    && Array.isArray(value.samples) && value.samples.length > 0 && value.samples.length <= 32);
  let time = BigInt(value.startedNs);
  const read = sample => {
    require(sample && Array.isArray(sample.pids) && sample.pids.length > 0 && sample.pids.every(pid)
      && new Set(sample.pids).size === sample.pids.length && typeof sample.stdout === 'string'
      && Buffer.byteLength(sample.stdout) <= 4096 && ns(sample.startedNs) && ns(sample.finishedNs)
      && BigInt(sample.startedNs) >= time && BigInt(sample.finishedNs) >= BigInt(sample.startedNs)
      && BigInt(sample.finishedNs) <= BigInt(value.finishedNs));
    time = BigInt(sample.finishedNs);
    const rows = sample.stdout.trim().split('\n').map(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s*$/u.exec(line);
      require(match);
      return { pid: Number(match[1]), parentPid: Number(match[2]), startedAt: match[3].replace(/\s+/gu, ' ') };
    });
    require(rows.length === sample.pids.length && new Set(rows.map(row => row.pid)).size === rows.length
      && rows.every(row => pid(row.pid) && Number.isSafeInteger(row.parentPid) && row.parentPid >= 0 && sample.pids.includes(row.pid)));
    return rows;
  };
  const chain = value.samples.map(sample => { require(sample.pids?.length === 1); return read(sample)[0]; });
  require(chain[0].pid === start.pid && chain[0].parentPid === start.parentPid && chain.at(-1).pid === value.stopPid
    && new Set(chain.map(row => row.pid)).size === chain.length
    && chain.every((row, index) => index === 0 || chain[index - 1].parentPid === row.pid));
  const confirmed = read(value.confirmation);
  require(confirmed.length === chain.length && chain.every(row => confirmed.some(other =>
    row.pid === other.pid && row.parentPid === other.parentPid && row.startedAt === other.startedAt)));
  return { rows: chain, method: value.method, sha256: hash(JSON.stringify(value)),
    startedNs: value.startedNs, finishedNs: value.finishedNs, stopPid: value.stopPid };
}

function processFile({ artifact, contents }) {
  const raw = typeof contents === 'string' || contents instanceof Uint8Array ? Buffer.from(contents) : null;
  if (!raw || !artifact || typeof artifact.path !== 'string' || !isAbsolute(artifact.path)
    || artifact.sha256 !== hash(raw) || artifact.bytes !== raw.length) throw new Error('CLI_PROCESS_ARTIFACT_INVALID');
  const text = raw.toString('utf8');
  if (!text || !text.endsWith('\n')) throw new Error('CLI_PROCESS_ARTIFACT_TRUNCATED');
  let events;
  try { events = text.trimEnd().split('\n').map(line => JSON.parse(line)); } catch { throw new Error('CLI_PROCESS_JSON_INVALID'); }
  let previous = null, time = -1n;
  for (const [index, event] of events.entries()) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('CLI_PROCESS_EVENT_INVALID');
    const { eventSha256, ...body } = event;
    if (event.version !== 1 || event.sequence !== index + 1 || event.previousSha256 !== previous || eventSha256 !== hash(JSON.stringify(body))
      || !ns(event.monotonicNs) || BigInt(event.monotonicNs) < time) throw new Error('CLI_PROCESS_CHAIN_INVALID');
    previous = eventSha256; time = BigInt(event.monotonicNs);
  }
  const start = events[0], end = events[1];
  if (start?.phase !== 'process_start' || events.length > 2 || end && end.phase !== 'process_end'
    || typeof start.clockId !== 'string' || !start.clockId || !pid(start.pid) || !pid(start.parentPid)
    || typeof start.processId !== 'string' || !start.processId.startsWith(start.pid + '-') || typeof start.owner !== 'boolean'
    || typeof start.node !== 'string') throw new Error('CLI_PROCESS_BOUNDARY_INVALID');
  for (const event of events) {
    if (event.clockId !== start.clockId || event.processId !== start.processId || event.pid !== start.pid || !pid(event.parentPid)
      || !['file', 'non-file', 'unknown'].includes(event.entryMode)
      || (event.entryMode === 'file' ? !fileIdentity(event.entry) : event.entry !== null)
      || event.cli !== null && (!event.cli || !['entry-name', 'package-bin'].includes(event.cli.basis)
        || event.entryMode !== 'file' || event.cli.basis === 'package-bin' && !fileIdentity(event.cli.manifest)))
      throw new Error('CLI_PROCESS_ENTRY_INVALID');
  }
  if (end && !Number.isSafeInteger(end.exitCode)) throw new Error('CLI_PROCESS_EXIT_INVALID');
  return { artifact, start, end, complete: Boolean(end), osAncestry: osAncestry(start) };
}

/** Pure identity proof. Inputs are sealed raw artifacts, not controller status.
 * Non-Node descendants, transport, authorization and business success stay outside
 * this result. A successful process exit is not a successful management action. */
export function verifyNotionAgentCliProcesses({ sourceObservation, processFiles, expectedEntries, window, min = 0 }) {
  const diagnostics = [], processes = [], artifacts = [], unknownProcesses = [];
  let countable = false;
  const report = (code, severity = 'blocked', extra = {}) => diagnostics.push({ code, severity, ...extra });
  const result = () => {
    const cli = processes.filter(item => item.cli);
    const distinct = new Map(cli.filter(item => item.entry).map(item => [JSON.stringify([item.entry.realpath, item.entry.sha256, item.entry.bytes]), item.entry]));
    return { version: 1, status: diagnostics.some(item => item.severity === 'failed') ? 'failed'
      : diagnostics.some(item => item.severity === 'blocked') ? 'blocked' : 'passed', diagnostics,
    cliCount: countable ? cli.length : null, matchedCliCount: countable ? cli.filter(item => item.status === 'passed').length : null,
    distinctEntries: [...distinct.values()], processes, unknownProcesses, artifacts,
    coverage: 'Observed inherited Node entries only; other descendants and all shell effects/network remain unknown.' };
  };
  if (!Number.isSafeInteger(min) || min < 0 || !Array.isArray(expectedEntries) || expectedEntries.length === 0
    || expectedEntries.some(entry => !fileIdentity({ ...entry, path: entry.path ?? entry.realpath }))
    || window !== undefined && (!ns(window.startNs) || !ns(window.endNs) || BigInt(window.endNs) < BigInt(window.startNs))) {
    report('CLI_PROCESS_INPUT_INVALID'); return result();
  }
  const source = sourceObservation?.events, owner = source?.[0];
  if (!Array.isArray(source) || owner?.phase !== 'source_observer_start' || !pid(owner.pid)
    || typeof owner.clockId !== 'string' || !ns(owner.monotonicNs)
    || !Array.isArray(sourceObservation.errors) || sourceObservation.errors.length) {
    report('CLI_PARENT_SOURCE_UNVERIFIED'); return result();
  }
  if (!Array.isArray(processFiles) || processFiles.length === 0) {
    report('CLI_PROCESS_OBSERVATION_MISSING'); return result();
  }
  const parsed = [];
  for (const file of processFiles) {
    if (file?.artifact) artifacts.push(file.artifact);
    try { parsed.push(processFile(file)); } catch (error) { report(error.message, 'blocked', { artifact: file?.artifact?.path ?? null }); }
  }
  const ownerRecords = parsed.filter(item => item.start.owner && item.start.pid === owner.pid && item.start.clockId === owner.clockId);
  if (ownerRecords.length !== 1) report('CLI_OWNER_PROCESS_MISSING');
  if (new Set(parsed.map(item => item.start.processId)).size !== parsed.length) report('CLI_PROCESS_DUPLICATE');
  countable = diagnostics.length === 0;
  const starts = new Map(source.filter(row => row.phase === 'unmatched_child_start').map(row => [row.childId, row]));
  const cliStarts = new Map(source.filter(row => row.phase === 'started' && row.kind === 'cli').map(row => [row.requestId, row]));
  const edges = source.filter(row => ['unmatched_child_spawn', 'child-started'].includes(row.phase)).flatMap(row => {
    const begin = row.phase === 'child-started' ? cliStarts.get(row.requestId) : starts.get(row.childId);
    const end = source.find(item => row.phase === 'child-started' ? item.phase === 'completed' && item.requestId === row.requestId
      : item.phase === 'unmatched_child_close' && item.childId === row.childId);
    const exit = row.phase === 'unmatched_child_spawn'
      ? source.find(item => item.phase === 'unmatched_child_exit' && item.childId === row.childId) : undefined;
    return begin && pid(row.childPid) ? [{ pid: row.childPid, begin: begin.monotonicNs, end: end?.monotonicNs,
      spawned: row.monotonicNs, aliveUntil: exit?.monotonicNs ?? end?.monotonicNs,
      childId: row.childId ?? row.requestId }] : [];
  });
  const within = (time, begin, end) => ns(time) && ns(begin) && BigInt(time) >= BigInt(begin) && (end === undefined || ns(end) && BigInt(time) <= BigInt(end));
  const direct = (childPid, time) => edges.filter(edge => edge.pid === childPid && within(time, edge.begin, edge.end));
  const osLineage = item => {
    const captured = item.osAncestry, ownerRecord = ownerRecords.length === 1 ? ownerRecords[0] : undefined;
    const ownerIdentity = ownerRecord?.osAncestry?.rows[0];
    if (!captured || !ownerIdentity || captured.stopPid !== ownerRecord.start.parentPid) return null;
    const ownerIndex = captured.rows.findIndex(row => row.pid === owner.pid), observedOwner = captured.rows[ownerIndex];
    if (ownerIndex < 2 || observedOwner.parentPid !== ownerIdentity.parentPid || observedOwner.startedAt !== ownerIdentity.startedAt) return null;
    const ancestor = captured.rows[ownerIndex - 1];
    const matches = edges.filter(edge => edge.pid === ancestor.pid && ns(edge.aliveUntil) && ns(edge.end)
      && within(captured.startedNs, edge.spawned, edge.aliveUntil) && within(captured.finishedNs, edge.spawned, edge.aliveUntil));
    if (matches.length !== 1) return null;
    return [...captured.rows.slice(0, ownerIndex - 1).map(row => ({ pid: row.pid, basis: 'os-ppid', parentPid: row.parentPid, osStartedAt: row.startedAt })),
      { pid: ancestor.pid, basis: 'source-child', childId: matches[0].childId, osStartedAt: ancestor.startedAt },
      { pid: owner.pid, basis: 'source-owner', osStartedAt: observedOwner.startedAt }];
  };
  const lineage = (item, visited = new Set()) => {
    const start = item.start;
    if (visited.has(start.processId) || start.clockId !== owner.clockId || !within(start.monotonicNs, owner.monotonicNs)) return null;
    if (start.owner) return start.pid === owner.pid && ownerRecords.length === 1 ? [{ pid: owner.pid, basis: 'source-owner' }] : null;
    visited.add(start.processId);
    const selfEdges = direct(start.pid, start.monotonicNs);
    if (selfEdges.length === 1) return [{ pid: start.pid, basis: 'source-child', childId: selfEdges[0].childId }, { pid: owner.pid, basis: 'source-owner' }];
    if (start.parentPid === owner.pid && ownerRecords.length === 1)
      return [{ pid: start.pid, basis: 'observed-ppid' }, { pid: owner.pid, basis: 'source-owner' }];
    const parentEdges = direct(start.parentPid, start.monotonicNs);
    if (parentEdges.length === 1) return [{ pid: start.pid, basis: 'observed-ppid' },
      { pid: start.parentPid, basis: 'source-child', childId: parentEdges[0].childId }, { pid: owner.pid, basis: 'source-owner' }];
    const parents = parsed.filter(parent => parent.start.pid === start.parentPid && within(start.monotonicNs, parent.start.monotonicNs, parent.end?.monotonicNs));
    if (parents.length !== 1) return osLineage(item);
    const chain = lineage(parents[0], visited);
    return chain ? [{ pid: start.pid, basis: 'observed-ppid' }, ...chain] : osLineage(item);
  };
  for (const item of parsed) {
    const { start, end } = item;
    if (start.owner || window && !within(start.monotonicNs, window.startNs, window.endNs)) continue;
    const exactPath = expectedEntries.some(entry => entry.realpath === start.entry?.realpath);
    const exactBytes = expectedEntries.some(entry => entry.sha256 === start.entry?.sha256 && entry.bytes === start.entry?.bytes);
    const cli = start.cli !== null || exactPath || exactBytes;
    const ancestry = lineage(item);
    const observed = { processId: start.processId, pid: start.pid, parentPid: start.parentPid,
      startedNs: start.monotonicNs, endedNs: end?.monotonicNs ?? null, entryMode: start.entryMode, entry: start.entry,
      cli, classification: start.cli?.basis ?? (exactPath || exactBytes ? 'expected-entry' : 'other-node'),
      exitCode: end?.exitCode ?? null, ancestry,
      osAncestry: item.osAncestry ? { method: item.osAncestry.method, sha256: item.osAncestry.sha256,
        startedNs: item.osAncestry.startedNs, finishedNs: item.osAncestry.finishedNs }
        : { complete: false, reason: start.osAncestry?.reason ?? 'unobserved' },
      status: cli ? 'passed' : 'unknown', artifact: item.artifact };
    processes.push(observed);
    if (!cli) { unknownProcesses.push(observed); continue; }
    if (!ancestry) { observed.status = 'blocked'; report('CLI_PROCESS_ANCESTRY_UNKNOWN', 'blocked', { processId: start.processId }); }
    if (!end) { observed.status = 'blocked'; report('CLI_PROCESS_TERMINAL_MISSING', 'blocked', { processId: start.processId }); }
    else if (end.entryMode !== 'file' || !sameEntry(start.entry, end.entry)) {
      observed.status = 'blocked'; report('CLI_PROCESS_ENTRY_CHANGED', 'blocked', { processId: start.processId });
    }
    if (ancestry && !expectedEntries.some(entry => sameEntry(entry, start.entry))) {
      observed.status = 'failed'; report('CLI_CANDIDATE_MISMATCH', 'failed', { processId: start.processId, entry: start.entry });
    }
    if (observed.status === 'blocked') unknownProcesses.push(observed);
  }
  const matched = processes.filter(item => item.cli && item.status === 'passed').length;
  if (matched < min) report('CLI_CANDIDATE_EXECUTION_MISSING', 'blocked', { expectedMin: min, observed: matched });
  return result();
}

/** I/O adapter for the runtime. Save artifacts in observed; the analyzer reads
 * those sealed bytes and calls the pure verifier again with candidate identities. */
export async function readNotionAgentCliProcesses({ directory, ...input }) {
  let names;
  try { names = await readdir(directory); }
  catch { return verifyNotionAgentCliProcesses({ ...input, processFiles: [] }); }
  const processFiles = [];
  for (const name of names.sort()) {
    const path = join(directory, name);
    if (!/^process-\d+-[a-f0-9-]{36}\.jsonl$/i.test(name)) {
      processFiles.push({ artifact: { path }, contents: null }); continue;
    }
    try {
      if (!(await lstat(path)).isFile()) throw new Error('Not a regular process artifact');
      const contents = await readFile(path);
      processFiles.push({ artifact: { path, realpath: await realpath(path), sha256: hash(contents), bytes: contents.length }, contents });
    } catch { processFiles.push({ artifact: { path }, contents: null }); }
  }
  return verifyNotionAgentCliProcesses({ ...input, processFiles });
}
