import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import xterm from '@xterm/headless';
import { assertSupportedPiVersion, isolatedEnv, resolveHost } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { currentServiceFacts, validateCurrentFixture, resolveInstalledPiSerializer, assertWireSources } from './notion-sdk-pi.mjs';
import { renderHttpWrapper, startLoopbackMock } from './mock-provider-adapter.mjs';
import { verifyBundledRuntime } from './verify-package-closure.mjs';

const usage = `Actual Pi terminal completion and latency over current SDK HTTP.
node scripts/pi-dollar-pty.mjs --package ABS --pi ABS --fixture ABS --source-http-helper ABS --out NEW_ABS [--samples 20]
The package is a standalone candidate; Pi is an explicit maintained CLI entry.
Results separate controlled HTTP/PTY from live Notion and actual model behavior.
No daily package registration, credentials or existing sessions are changed.`;
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const rows = async path => (await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }))
  .split('\n').filter(Boolean).map(JSON.parse);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const bounded = async (promise, name, timeout = 30000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timeout: ' + name)), timeout); })]); }
  finally { clearTimeout(timer); }
};
const ms = (end, start) => Number(BigInt(end) - BigInt(start)) / 1e6;
const summary = samples => {
  const values = [...samples].sort((a, b) => a - b);
  return { samples: values.length, p50_ms: values[Math.ceil(values.length * .5) - 1], p95_ms: values[Math.ceil(values.length * .95) - 1], min_ms: values[0], max_ms: values.at(-1) };
};

// A transport-failure boundary only: no catalog, authorization or consumer
// state is fabricated. The real SDK retains its own attempts and backoff.
async function unavailableSource(path) {
  const requests = [];
  const server = createServer((request, response) => {
    const record = { method: request.method, path: request.url, status: 503, started_monotonic_ns: process.hrtime.bigint().toString() };
    requests.push(record); request.resume();
    response.on('finish', () => {
      record.ended_monotonic_ns = process.hrtime.bigint().toString();
      appendFileSync(path, JSON.stringify(record) + '\n');
    });
    response.writeHead(503, { 'content-type': 'application/json', connection: 'close' });
    response.end(JSON.stringify({ object: 'error', status: 503, code: 'service_unavailable', message: 'Controlled source outage' }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { origin: 'http://127.0.0.1:' + server.address().port, requests,
    close: async () => { const stopped = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); server.closeAllConnections(); await stopped; } };
}

// Python only provides the operating system PTY and timestamps. xterm parses
// the actual output, including cursor moves, erasure, wrap and alternate screen.
const bridge = String.raw`import os,sys,json,pty,selectors,base64,time,signal,fcntl,termios,struct
cfg=json.loads(sys.stdin.readline())
pid,fd=pty.fork()
if pid==0:
 fcntl.ioctl(0,termios.TIOCSWINSZ,struct.pack('HHHH',cfg['rows'],cfg['cols'],0,0))
 os.chdir(cfg['cwd'])
 os.execve(cfg['file'],[cfg['file']]+cfg['args'],cfg['env'])
def emit(value):
 print(json.dumps(value),flush=True)
emit({'kind':'spawn','pid':pid,'ns':str(time.monotonic_ns())})
sel=selectors.DefaultSelector();sel.register(fd,selectors.EVENT_READ,'terminal');sel.register(sys.stdin,selectors.EVENT_READ,'input')
buffer=b'';exited=False
while not exited:
 for key,_ in sel.select(.1):
  if key.data=='terminal':
   try: data=os.read(fd,65536)
   except OSError: data=b''
   if data: emit({'kind':'output','ns':str(time.monotonic_ns()),'data':base64.b64encode(data).decode()})
   else:
    try: sel.unregister(fd)
    except KeyError: pass
  else:
   data=os.read(sys.stdin.fileno(),65536)
   if not data:
    try: os.killpg(pid,signal.SIGTERM)
    except ProcessLookupError: pass
    sel.unregister(sys.stdin)
   buffer+=data
   while b'\n' in buffer:
    line,buffer=buffer.split(b'\n',1)
    value=json.loads(line)
    if value['op']=='write':
     at=time.monotonic_ns()
     try:
      os.write(fd,base64.b64decode(value['data']))
      emit({'kind':'write','id':value['id'],'ns':str(at)})
     except OSError as error: emit({'kind':'write-error','id':value['id'],'message':str(error),'ns':str(at)})
    elif value['op']=='signal':
     try: os.killpg(pid,value['signal'])
     except ProcessLookupError: pass
     emit({'kind':'signal','signal':value['signal'],'ns':str(time.monotonic_ns())})
 done,status=os.waitpid(pid,os.WNOHANG)
 if done:
  emit({'kind':'exit','status':status,'returncode':os.waitstatus_to_exitcode(status),'ns':str(time.monotonic_ns())});exited=True
os.close(fd)
`;

export class PiTerminal {
  constructor({ command, args, env, cwd, directory, cols = 140, rows = 42 }) {
    this.directory = directory; this.sequence = 0; this.frames = new EventEmitter(); this.writes = new Map(); this.latest = '0'; this.started = '0'; this.closed = undefined; this.tail = Promise.resolve();
    this.matches = new Map(); this.received = '0'; this.parsed = '0';
    this.screen = new xterm.Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
    this.process = spawn('/usr/bin/python3', ['-u', '-c', bridge], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    this.process.stdout.on('data', chunk => {
      buffer += chunk.toString();
      for (;;) {
        const boundary = buffer.indexOf('\n'); if (boundary < 0) break;
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        const event = JSON.parse(line);
        if (event.kind === 'output') {
          const received = process.hrtime.bigint().toString();
          const bytes = Buffer.from(event.data, 'base64'); appendFileSync(join(directory, 'terminal.ansi'), bytes);
          this.tail = this.tail.then(() => new Promise(resolve => this.screen.write(bytes, resolve))).then(() => {
            this.latest = event.ns; this.received = received; this.parsed = process.hrtime.bigint().toString(); this.frames.emit('frame');
          });
        } else {
          appendFileSync(join(directory, 'pty-events.jsonl'), JSON.stringify(event) + '\n');
          if (event.kind === 'spawn') this.started = event.ns;
          if (event.kind === 'write') { this.writes.get(event.id)?.resolve(event.ns); this.writes.delete(event.id); }
          if (event.kind === 'write-error') { this.writes.get(event.id)?.reject(new Error(event.message)); this.writes.delete(event.id); }
          if (event.kind === 'exit') {
            this.closed = event; this.frames.emit('frame');
            for (const pending of this.writes.values()) pending.reject(new Error('Owned Pi exited'));
            this.writes.clear();
          }
        }
      }
    });
    this.process.stderr.on('data', bytes => appendFileSync(join(directory, 'bridge.stderr'), bytes));
    this.process.stdin.on('error', error => {
      for (const pending of this.writes.values()) pending.reject(error);
      this.writes.clear();
    });
    this.screen.onData(data => { void this.key(data, 'terminal-response').catch(error => appendFileSync(join(directory, 'bridge.stderr'), error.message + '\n')); });
    this.process.stdin.write(JSON.stringify({ file: command.file, args: [...command.prefix, ...args], cwd, env, cols, rows }) + '\n');
  }
  text() {
    const buffer = this.screen.buffer.active;
    return Array.from({ length: this.screen.rows }, (_, index) => buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? '').join('\n');
  }
  async capture(name) {
    await this.tail;
    await writeFile(join(this.directory, name + '.screen.txt'), this.text() + '\n');
  }
  async key(data, name) {
    assert.ok(!this.closed, 'The owned Pi exited before key ' + name);
    const id = ++this.sequence, encoded = Buffer.from(data).toString('base64');
    const written = new Promise((resolve, reject) => this.writes.set(id, { resolve, reject }));
    this.process.stdin.write(JSON.stringify({ op: 'write', id, data: encoded }) + '\n');
    let at;
    try { at = await bounded(written, 'PTY write ' + name, 5000); }
    finally { this.writes.delete(id); }
    appendFileSync(join(this.directory, 'actions.jsonl'), JSON.stringify({ id, name, data: encoded, encoding: 'base64', pty_write_monotonic_ns: at }) + '\n');
    return at;
  }
  async wait(predicate, name, timeout = 30000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      await this.tail;
      const text = this.text();
      if (predicate(text)) {
        const matched = { name, python_read_ns: this.latest, parent_received_ns: this.received, parent_parsed_ns: this.parsed };
        this.matches.set(name, matched);
        appendFileSync(join(this.directory, 'frame-observations.jsonl'), JSON.stringify(matched) + '\n');
        await writeFile(join(this.directory, name + '.screen.txt'), text + '\n');
        return matched.python_read_ns;
      }
      assert.ok(!this.closed, `Pi exited during ${name}: ${JSON.stringify(this.closed)}\n${this.text()}`);
      if (Date.now() >= deadline) { await this.capture('failed-' + name); throw new Error(`Terminal timeout: ${name}\n${this.text()}`); }
      await new Promise(resolve => { const onFrame = () => { clearTimeout(timer); this.frames.off('frame', onFrame); resolve(); }; const timer = setTimeout(onFrame, 30); this.frames.once('frame', onFrame); });
    }
  }
  async close() {
    if (!this.closed) {
      try { await this.key('\x1b', 'cleanup-escape'); await this.key('\x15', 'cleanup-clear'); await this.key('\x04', 'cleanup-exit'); }
      catch (error) { appendFileSync(join(this.directory, 'bridge.stderr'), 'Graceful cleanup: ' + error.message + '\n'); }
      for (let i = 0; i < 40 && !this.closed; i++) await delay(50);
    }
    if (!this.closed) { this.process.stdin.write(JSON.stringify({ op: 'signal', signal: 15 }) + '\n'); for (let i = 0; i < 40 && !this.closed; i++) await delay(50); }
    if (!this.closed) { this.process.stdin.write(JSON.stringify({ op: 'signal', signal: 9 }) + '\n'); for (let i = 0; i < 40 && !this.closed; i++) await delay(50); }
    assert.ok(this.closed, 'Owned Pi process exit was not observed');
    this.process.stdin.end(); await this.tail; this.screen.dispose();
    await save(join(this.directory, 'cleanup.json'), this.closed);
  }
}

function observer(api) {
  const emit = (type, data = {}) => appendFileSync(process.env.PTY_OBSERVER, JSON.stringify({ type, monotonic_ns: process.hrtime.bigint().toString(), ...data }) + '\n');
  for (const name of ['session_start', 'agent_start', 'agent_end', 'session_shutdown']) api.on(name, (_event, ctx) => {
    emit(name); if (name === 'session_start') ctx.ui.setStatus('pty-ready', 'PTY_READY');
  });
  api.on('input', event => { emit('input', { text: event.text, images: event.images?.length ?? 0, streamingBehavior: event.streamingBehavior }); });
}
const menu = text => /→ \$[^\n]+\[skill\]/u.test(text);
const remote = text => /\$acceptance-c@pty \[skill\]/u.test(text);
const selectedRemote = text => /→ \$acceptance-c@pty \[skill\]/u.test(text);

async function measureProvider(packageRoot, piRoot, context, localRoot, service, out) {
  const { readCandidateSnapshot } = await import(pathToFileURL(join(packageRoot, 'dist/ntn-skills-sdk.mjs')).href);
  const requestsBefore = service.requests.length;
  const snapshot = await readCandidateSnapshot({ library: context.source.library, cwd: context.base, env: context.env });
  assert.equal(service.requests.length, requestsBefore, 'Provider corpus must come from the same local cache without HTTP');
  assert.equal(snapshot.kind, 'snapshot'); assert.equal(snapshot.records.length, 103);
  const jitiPath = createRequire(join(piRoot, 'package.json')).resolve('jiti');
  const { createJiti } = await import(pathToFileURL(jitiPath).href);
  const load = createJiti(import.meta.url, { fsCache: false, moduleCache: true, tryNative: false });
  const providerPath = join(packageRoot, 'src/dollar.ts');
  const { createDollarSkillAutocompleteProvider } = await load.import(providerPath);
  const { localCompletionCandidate, notionCompletionCandidates } = await load.import(join(packageRoot, 'src/completion-candidates.ts'));
  const { configuredBundledBuiltinRecords } = await load.import(join(packageRoot, 'src/bundled-builtins.ts'));
  const { skillRecordFromFile } = await load.import(join(packageRoot, 'src/skill-records.ts'));
  const local = skillRecordFromFile(join(localRoot, 'aa-pty-local/SKILL.md'), false); assert.ok(local);
  const candidates = [local, ...configuredBundledBuiltinRecords({ sources: [context.source] })].map(localCompletionCandidate)
    .concat(notionCompletionCandidates(snapshot.records, context.source, snapshot.scope, snapshot.coverage === 'complete'));
  assert.equal(candidates.length, 107);
  await save(join(out, 'provider-corpus.json'), { source: context.source, snapshot, candidates });
  const owner = {}, provider = createDollarSkillAutocompleteProvider({ async getSuggestions() { return null; }, applyCompletion(lines, cursorLine, cursorCol) { return { lines, cursorLine, cursorCol }; } },
    { read: () => ({ candidates, revision: 1 }), scope: () => owner, subscribe: () => () => {} });
  const options = { signal: new AbortController().signal, force: false }, queries = ['$', '$a', '$acceptance-', '$acceptance-c', '$ntn', '$missing'];
  const measure = async prefix => {
    const start = process.hrtime.bigint(), value = await provider.getSuggestions([prefix], 0, prefix.length, options);
    return { prefix, elapsed_ms: Number(process.hrtime.bigint() - start) / 1e6, results: value?.items.length ?? 0 };
  };
  const first = await measure('$'); assert.equal(first.results, 50);
  for (let i = 0; i < 30; i++) await measure(queries[i % queries.length]);
  const samples = []; for (let i = 0; i < 300; i++) samples.push(await measure(queries[i % queries.length]));
  assert.ok(samples.filter(row => row.prefix === '$acceptance-c').every(row => row.results === 1));
  const measured = { kind: 'packed-provider-memory-microbenchmark', node: { path: process.execPath, version: process.version },
    provider: { path: providerPath, sha256: hash(await readFile(providerPath)) }, jiti: { path: jitiPath, sha256: hash(await readFile(jitiPath)) },
    candidate_count: candidates.length, corpus_sha256: hash(await readFile(join(out, 'provider-corpus.json'))), first_call: first, warmup_calls: 30,
    summary: summary(samples.map(row => row.elapsed_ms)), by_prefix: Object.fromEntries(queries.map(prefix => [prefix, summary(samples.filter(row => row.prefix === prefix).map(row => row.elapsed_ms))])), samples,
    method: 'Actual packed getSuggestions loaded with the installed Pi Jiti in Node; same observed cache corpus plus actual local/builtin records. SDK read, corpus construction and module load occur before timing. One Node clock includes async resolution. Independent memory microbenchmark, not Editor/PTY latency.' };
  await save(join(out, 'provider-microbenchmark.json'), measured);
  return { ...measured.summary, first_call_ms: first.elapsed_ms, candidate_count: candidates.length, evidence: join(out, 'provider-microbenchmark.json'), method: measured.method };
}

export async function run(options) {
  const out = resolve(options.out); await mkdir(out, { mode: 0o700 });
  const result = { kind: 'pi-dollar-pty', status: 'running', evidence_level: 'actual-PTY-controlled-source-provider', live_notion: false, natural_model: false, cases: [], samples: [] };
  let service, provider, outage, active;
  try {
    const packageRoot = await realpath(options.package), command = await resolveHost(options.pi);
    let piRoot = dirname(command.identity), pi;
    for (;;) { try { pi = JSON.parse(await readFile(join(piRoot, 'package.json'), 'utf8')); if (pi.name === '@earendil-works/pi-coding-agent') break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert.notEqual(piRoot, dirname(piRoot)); piRoot = dirname(piRoot); }
    assertSupportedPiVersion(pi.version);
    const runtime = JSON.parse(await readFile(join(packageRoot, 'dist/ntn-skills-runtime.json'), 'utf8'));
    const hashes = verifyBundledRuntime({ manifest: runtime, expectedVersion: runtime.package_version, cliBytes: await readFile(join(packageRoot, 'dist/ntn-skills.mjs')), managementBytes: await readFile(join(packageRoot, 'dist/ntn-skills-management.mjs')), sdkBytes: await readFile(join(packageRoot, 'dist/ntn-skills-sdk.mjs')), refBytes: await readFile(join(packageRoot, 'dist/ntn-skills-ref.cjs')) });
    const original = validateCurrentFixture(JSON.parse(await readFile(options.fixture, 'utf8'))), { sample, owners } = currentServiceFacts(original);
    // Metadata names are deliberate fixture facts. Keep them and the namespace
    // short enough for Pi's actual fixed-width label column to show the token.
    for (const key of ['b', 'c']) {
      const row = sample.notion.skills.find(row => row.id === owners[key]);
      Object.values(row.properties).find(value => value.id === 'title').title = [{ type: 'text', plain_text: 'acceptance-' + key, text: { content: 'acceptance-' + key } }];
    }
    await save(join(out, 'source-facts.json'), sample);
    result.dataset = { notion_skills: sample.notion.skills.length, local_skills: 1, bundled_skills: 3, first_menu_limit: 50,
      controlled_metadata: 'B/C titles acceptance-b/c; namespace pty. Original complete bodies and Requires unchanged.' };
    const fixtureEnv = JSON.parse(await readFile(original.env, 'utf8')); assert.equal(fixtureEnv.NOTION_API_TOKEN, 'current-sdk-controlled-token');
    const { startSdkSourceFixture } = await import(pathToFileURL(options['source-http-helper']).href);
    service = await startSdkSourceFixture(sample, join(out, 'source-http.jsonl'));
    const wire = [], serializer = await resolveInstalledPiSerializer(piRoot, pi.version);
    provider = await startLoopbackMock({ selectCall: () => null, limits: { maxRequests: 30 }, onBody: async (record, bytes) => {
      const path = join(out, `provider-${wire.length + 1}.json`); await writeFile(path, bytes, { mode: 0o600 }); wire.push({ record, body: JSON.parse(bytes), path });
    } });
    result.identity = { pi: { ...command, package_root: piRoot, version: pi.version }, node: { path: process.execPath, version: process.version },
      broker: { root: packageRoot, adapter_sha256: hash(await readFile(join(packageRoot, 'src/pi-dollar-editor.ts'))), hashes, runtime },
      fixture_sha256: hash(await readFile(options.fixture)), helper_sha256: hash(await readFile(options['source-http-helper'])), driver_sha256: hash(await readFile(fileURLToPath(import.meta.url))) };
    const state = join(out, 'state'), localRoot = join(state, 'skills'), localSkill = join(localRoot, 'aa-pty-local');
    await mkdir(localSkill, { recursive: true });
    await writeFile(join(localSkill, 'SKILL.md'), '---\nname: aa-pty-local\ndescription: Controlled local terminal fixture\n---\n\nLocal fixture instructions.\n');
    const providerExtension = join(state, 'provider.mjs'), observerExtension = join(state, 'observer.mjs'), preload = join(state, 'preload.mjs');
    await writeFile(providerExtension, renderHttpWrapper({ helperUrl: new URL('./mock-provider-adapter.mjs', import.meta.url).href, serializerUrl: pathToFileURL(serializer.serializer.path).href }));
    await writeFile(observerExtension, "import { appendFileSync } from 'node:fs';\nexport default " + observer.toString() + '\n');
    await writeFile(preload, "import { channel } from 'node:diagnostics_channel';\nimport { appendFileSync } from 'node:fs';\nfor(const topic of ['context-broker.notion-sdk','context-broker.notion-sdk-result'])channel(topic).subscribe(event=>appendFileSync(process.env.PTY_SDK_EVENTS,JSON.stringify({topic,...(topic.endsWith('-result')?{id:event.id,operation:event.operation,kind:event.value?.kind,count:event.value?.records?.length}:{...event})})+'\\n'));\n");
    let serial = 0;
    const start = async (name, { cold = false, maxAge = '1h', sourceOrigin = service.origin } = {}) => {
      const directory = join(out, String(++serial).padStart(2, '0') + '-' + name); await mkdir(directory);
      const base = join(directory, 'home'), agentDir = join(base, 'agent'), sessions = join(base, 'sessions');
      await mkdir(join(agentDir, 'context-broker'), { recursive: true }); await mkdir(sessions);
      const config = join(agentDir, 'context-broker/config.json');
      const source = { type: 'notion', id: 'pty-source', namespace: 'pty', library: sample.notion.library.library_id, discovery: { maxAge }, activation: { maxAge: '0' }, prefetch: false, cacheDir: join(cold ? base : state, 'broker-cache') };
      await save(config, { skillRoots: [localRoot], sources: [source] });
      await save(join(agentDir, 'settings.json'), { compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } });
      const env = isolatedEnv({ base, agentDir, PATH: dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin', TERM: 'xterm-256color', COLORTERM: 'truecolor',
        NOTION_API_TOKEN: fixtureEnv.NOTION_API_TOKEN, NOTION_API_BASE_URL: sourceOrigin, NTN_SKILLS_NOTION_INTERVAL_MS: '100',
        CONTEXT_BROKER_HOST: 'pi', CONTEXT_BROKER_CONFIG: config, CONTEXT_BROKER_LOG_FILE: join(directory, 'decisions.jsonl'),
        PTY_OBSERVER: join(directory, 'observer.jsonl'), PTY_SDK_EVENTS: join(directory, 'sdk.jsonl'), NODE_OPTIONS: '--import=' + preload, CTX_MOCK_PROVIDER_BASE_URL: provider.baseUrl });
      for (const [key, suffix] of [['NTN_SKILLS_CONFIG_HOME', 'config'], ['NTN_SKILLS_HOME', 'store'], ['NTN_SKILLS_CACHE_HOME', 'cache'], ['NTN_SKILLS_DATA_HOME', 'data'], ['NTN_SKILLS_SCHEDULER_ROOT', 'scheduler']]) env[key] = join(cold ? base : state, 'ntn', suffix);
      await mkdir(env.NTN_SKILLS_CONFIG_HOME, { recursive: true }); await save(join(env.NTN_SKILLS_CONFIG_HOME, 'config.json'), { default_library: sample.notion.library.library_id });
      const args = ['--offline', '--no-extensions', '--no-skills', '--no-mcp', '--session-dir', sessions, '-e', providerExtension, '-e', join(packageRoot, 'src/index.ts'), '-e', observerExtension, '--model', 'context-broker-e2e/fake'];
      await save(join(directory, 'launch.json'), { command, args, cwd: base, runtime: result.identity.node, source, source_origin: sourceOrigin, shared_owned_state: cold ? null : state,
        host_startup_network: 'Pi --offline disables only package/catalog/tool/version startup network; SDK and provider use actual controlled loopback HTTP.' });
      active = new PiTerminal({ command, args, env, cwd: base, directory });
      // A PTY read can end after the dialog title, before its choice rows.
      await active.wait(text => text.includes('PTY_READY') || text.includes('Trust project folder?') && text.includes('Trust (this session only)'), 'startup', 60000);
      if (active.text().includes('Trust project folder?')) {
        assert.ok(active.text().includes('Trust (this session only)'), 'Unexpected Pi project trust choices');
        await active.key('\x1b[B\x1b[B\r', 'trust-owned-project-session-only');
      }
      const ready = await active.wait(text => text.includes('PTY_READY'), 'ready', 60000);
      return { terminal: active, directory, ready, startup_ms: ms(ready, active.started), base, source, env };
    };
    const finish = async () => { const old = active; await old?.close(); if (active === old) active = undefined; };
    const caseResult = async value => { result.cases.push(value); await save(join(out, 'result.json'), result); };
    // Cold local-first and background same-screen publication. The source gate
    // controls the external HTTP boundary, never the consumer snapshot.
    const hold = service.holdNext({ method: 'GET', path: '/v1/pages/' + sample.notion.root.id });
    let current = await start('cold-local-first');
    let written = await active.key('$', 'first-dollar');
    let shown = await active.wait(menu, 'first-dollar-menu');
    const localFirstMs = ms(shown, written);
    await active.wait(text => /\$aa-pty-local/u.test(text), 'local-scan-joined-first-menu');
    assert.match(active.text(), /\$ntn-skills@builtin \[skill\]/u, 'Offline maintenance must be discoverable while the source is held');
    assert.equal(remote(active.text()), false, 'Cold remote cannot appear before its HTTP boundary');
    await active.key('ntn-skills', 'offline-builtin-filter');
    await active.wait(text => /→ \$ntn-skills@builtin \[skill\]/u.test(text), 'offline-builtin-menu');
    await active.key('\x15', 'restore-bare-prefix-clear');
    await active.wait(text => !menu(text), 'cleared-editor');
    await active.key('$', 'restore-bare-prefix'); await active.wait(menu, 'bare-prefix-before-release');
    await bounded(hold.reached, 'cold HTTP gate');
    const viewHold = service.holdNext({ method: 'GET', path: '/v1/views' });
    const released = process.hrtime.bigint().toString(); hold.release();
    const [heldView] = await Promise.all([bounded(viewHold.reached, 'Default View HTTP gate', 60000), active.wait(remote, 'background-remote-while-view-held', 60000)]);
    assert.equal(service.requests.find(row => row.sequence === heldView.sequence).terminal, 'pending');
    const duringView = await rows(join(current.directory, 'sdk.jsonl'));
    const inFlightList = duringView.find(row => row.operation === 'list' && row.event === 'start');
    assert.ok(inFlightList); assert.equal(duringView.some(row => row.id === inFlightList.id && row.event === 'end'), false);
    const metadataEnd = (await rows(service.eventsPath)).filter(row => row.event === 'end' && row.sequence < heldView.sequence && row.terminal === 'finished'
      && row.method === 'POST' && row.path === '/v1/data_sources/' + sample.notion.library.skills.data_source_id + '/query').at(-1);
    assert.ok(metadataEnd);
    const publicationFrame = active.matches.get('background-remote-while-view-held');
    const backgroundUpdate = { catalog_query_end_to_frame_observed_ms: ms(publicationFrame.parent_parsed_ns, metadataEnd.monotonic_ns),
      metadata_http_end: metadataEnd, frame: publicationFrame,
      method: 'Same parent Node clock: last full-catalog Skills data-source page response finished to parsing the target ANSI frame before Default View completion; the remote menu remains visible when the View request is held. Later View initialization metadata is excluded. Includes client decode/cache publication, Pi scheduling, PTY bridge IPC and xterm observer overhead; no Python/Node clock subtraction.' };
    assert.ok(backgroundUpdate.catalog_query_end_to_frame_observed_ms >= 0);
    await save(join(current.directory, 'held-view-publication.json'), { http: heldView, sdk_operation: inFlightList, terminal_frame: 'background-remote-while-view-held.screen.txt' });
    viewHold.release(); await bounded(viewHold.closed, 'released View HTTP close');
    const listDeadline = Date.now() + 60000;
    while (!(await rows(join(current.directory, 'sdk.jsonl'))).some(row => row.id === inFlightList.id && row.event === 'end' && row.status === 'completed')) {
      if (Date.now() > listDeadline) throw new Error('Catalog/View operation did not finish after release'); await delay(30);
    }
    const sourceEvents = await rows(service.eventsPath), finalCatalog = sourceEvents.filter(row => row.event === 'end').at(-1);
    await caseResult({ case: 'cold-local-first-background-update', status: 'passed', evidence: current.directory, first_dollar_ms: localFirstMs, background_release_ns: released,
      default_view_held_during_remote_publication: true, held_view_http_sequence: heldView.sequence, background_update: backgroundUpdate, last_source_event: finalCatalog ?? null });
    await finish();
    // Every sample starts a fresh actual Pi process. Cache/store bytes are only
    // those populated by the preceding current HTTP consumer, not preseeded data.
    for (let index = 0; index < options.samples; index++) {
      current = await start('warm-' + (index + 1));
      written = await active.key('$', 'first-dollar'); shown = await active.wait(menu, 'first-dollar-menu');
      const first = ms(shown, written), remoteShown = await active.wait(remote, 'cached-remote-menu', 10000);
      await active.key('acceptance-', 'filter-prefix'); await active.wait(text => /\$acceptance-\s*$/mu.test(text) && /\$acceptance-b@pty/u.test(text), 'filter-prefix-menu');
      const filteredAt = await active.key('c', 'filter-character'), filtered = await active.wait(selectedRemote, 'filtered-menu');
      const sdk = await rows(join(current.directory, 'sdk.jsonl')), cache = sdk.find(row => row.event === 'end' && row.operation === 'candidates');
      const sessionStart = (await rows(join(current.directory, 'observer.jsonl'))).find(row => row.type === 'session_start');
      result.samples.push({ sample: index + 1, evidence: current.directory, startup_to_editor_ms: current.startup_ms, first_dollar_ms: first,
        first_dollar_remote_ms: ms(remoteShown, written), filter_ms: ms(filtered, filteredAt), cache_ready: cache ?? null,
        cache_ready_from_session_start_ms: cache && sessionStart ? ms(cache.monotonic_ns, sessionStart.monotonic_ns) : null });
      await save(join(out, 'result.json'), result); await finish();
    }
    result.metrics = { first_dollar: summary(result.samples.map(row => row.first_dollar_ms)), first_dollar_remote: summary(result.samples.map(row => row.first_dollar_remote_ms)),
      filter: summary(result.samples.map(row => row.filter_ms)), startup_to_editor: summary(result.samples.map(row => row.startup_to_editor_ms)),
      cache_read: summary(result.samples.map(row => row.cache_ready.elapsed_ms)), cache_ready_from_session_start: summary(result.samples.map(row => row.cache_ready_from_session_start_ms)),
      background_update: backgroundUpdate, provider_compute: await measureProvider(packageRoot, piRoot, current, localRoot, service, out),
      method: 'One Python bridge clock per process: immediately before PTY key write to PTY read of the ANSI bytes producing the asserted current xterm frame. Includes all Pi scheduling/debounce and output delay; excludes controller/terminal-emulator parsing. SDK/observer/provider use a separate Node clock; raw clock domains are never subtracted.' };
    await save(join(out, 'result.json'), result);
    // Esc before the first remote result and after an open local menu must keep
    // the user's close intent even when the actual service later completes.
    for (const stage of ['waiting', 'open']) {
      const gate = service.holdNext({ method: 'GET', path: '/v1/pages/' + sample.notion.root.id });
      current = await start('escape-' + stage, { cold: true });
      await active.key(stage === 'waiting' ? '$acceptance-c' : '$', 'completion-intent');
      if (stage === 'open') await active.wait(menu, 'open-menu');
      await active.key('\x1b', 'escape'); await bounded(gate.reached, 'Esc HTTP gate'); gate.release();
      const deadline = Date.now() + 60000;
      while (!(await rows(join(current.directory, 'sdk.jsonl'))).some(row => row.event === 'end' && row.operation === 'list' && row.status === 'completed')) {
        if (Date.now() > deadline) throw new Error('Remote catalog did not complete after Esc'); await delay(30);
      }
      await delay(100); await active.capture('after-late-catalog'); assert.equal(menu(active.text()), false);
      await caseResult({ case: 'escape-' + stage, status: 'passed', evidence: current.directory }); await finish();
    }
    outage = await unavailableSource(join(out, 'source-unavailable-http.jsonl'));
    current = await start('cold-source-unavailable', { cold: true, sourceOrigin: outage.origin });
    written = await active.key('$', 'offline-first-dollar'); shown = await active.wait(menu, 'offline-local-menu');
    const unavailableFirstMs = ms(shown, written);
    await active.wait(text => /\$aa-pty-local/u.test(text), 'offline-local-scan-joined-menu');
    assert.match(active.text(), /\$ntn-skills@builtin \[skill\]/u);
    const failedDeadline = Date.now() + 30000;
    let failed;
    while (!(failed = (await rows(join(current.directory, 'sdk.jsonl'))).find(row => row.event === 'end' && row.status === 'failed' && row.operation === 'library'))) {
      if (Date.now() > failedDeadline) throw new Error('Real SDK did not terminate the unavailable source'); await delay(25);
    }
    assert.ok(outage.requests.length >= 4, 'Actual SDK retry attempts must reach the 503 boundary');
    await active.capture('after-source-failure');
    assert.match(active.text(), /\$aa-pty-local/u);
    await active.key('\x1b', 'offline-menu-escape'); await active.wait(text => !menu(text), 'offline-escaped');
    await active.key('\x15', 'offline-clear-draft');
    const ordinary = 'Continue ordinary conversation after the source outage.';
    const beforeFailureInput = wire.length, submitted = await active.key(ordinary + '\r', 'ordinary-after-outage');
    const responded = await active.wait(text => text.includes(ordinary) && /\bOK\b/u.test(text), 'ordinary-response-after-outage');
    assert.equal(wire.length, beforeFailureInput + 1);
    assert.ok(JSON.stringify(wire.at(-1).body.messages).includes(ordinary));
    const accepted = (await rows(join(current.directory, 'observer.jsonl'))).find(row => row.type === 'input' && row.text === ordinary);
    assert.ok(accepted);
    await caseResult({ case: 'cold-503-local-menu-escape-and-ordinary-input', status: 'passed', evidence: current.directory,
      first_dollar_ms: unavailableFirstMs, sdk_failure: failed, attempts: outage.requests.length,
      key_to_response_frame_ms: ms(responded, submitted), accepted_input_to_provider_ms: ms(wire.at(-1).record.started, accepted.monotonic_ns),
      provider_file: wire.at(-1).path });
    await finish(); await outage.close(); outage = undefined;
    // Real Tab/Enter reaches the installed SDK and actual Pi serializer. A held
    // ordinary response creates a real queued input; editing the next draft
    // must not replace the queued selection.
    current = await start('selection-and-queue');
    provider.control.hold(); const before = wire.length;
    await active.key('Hold the response while I queue a Skill request.\r', 'begin-streaming');
    const deadline = Date.now() + 30000;
    while (!provider.requests.some(row => row.phase === 'held')) { if (Date.now() > deadline) throw new Error('Provider did not enter held streaming turn'); await delay(20); }
    await active.key('$acceptance-c', 'queued-selection-prefix'); await active.wait(selectedRemote, 'queued-selection-menu');
    await active.key('\t', 'queued-selection-tab'); await active.wait(text => text.includes('$acceptance-c@pty ') && !menu(text), 'queued-selection-draft');
    await active.key(' Describe only.\r', 'queue-input');
    await active.key('$acceptance-b', 'next-draft-prefix'); await active.wait(text => /→ \$acceptance-b@pty \[skill\]/u.test(text), 'next-draft-menu');
    await active.key('\t', 'next-draft-tab'); provider.control.release();
    const queueDeadline = Date.now() + 60000;
    while (wire.length < before + 2) { if (Date.now() > queueDeadline) throw new Error('Queued input did not reach actual provider'); await delay(25); }
    const body = owner => { const row = service.notion.skills.find(row => row.id === owner), content = Object.values(row.properties).find(value => value.id === 'content');
      return JSON.parse(content.rich_text.map(value => value.plain_text ?? value.text?.content ?? '').join('')).frontmatter + service.notion.bodies[owner]; };
    assertWireSources(wire.at(-1).body, [body(owners.c), body(owners.b)]);
    await active.capture('queue-provider-complete');
    const loaded = text => /\[skill@notion\] acceptance-c · loaded\b/u.test(text);
    await active.wait(loaded, 'queue-loaded');
    await active.key('\x1b', 'escape-after-loaded');
    await delay(100); await active.capture('loaded-after-escape');
    assert.ok(loaded(active.text()), 'Esc must preserve actual loaded transcript status');
    assert.doesNotMatch(active.text(), /\[skill@notion\] acceptance-c · cancelled\b/u);
    await caseResult({ case: 'real-tab-queued-input-complete-root-and-requires', status: 'passed', evidence: current.directory,
      provider_file: wire.at(-1).path, loaded_esc_retained: true });
    await finish();
    assert.ok(result.metrics.first_dollar.p95_ms < 100, 'Warm first dollar p95 exceeds 100 ms');
    assert.ok(result.metrics.filter.p95_ms < 50, 'Filtering p95 exceeds 50 ms');
    assert.equal(service.unexpected.length, 0); assert.equal(service.requests.some(row => row.semantic_write), false);
    result.status = 'passed';
  } catch (error) { result.status = 'failed'; result.error = { message: error.message, stack: error.stack }; throw error; }
  finally {
    const cleanup = [];
    for (const [name, close] of [['terminal', () => active?.close()], ['provider', () => provider?.close()], ['source', () => service?.close()], ['outage', () => outage?.close()]]) {
      try { await close(); cleanup.push({ name, status: 'closed' }); } catch (error) { cleanup.push({ name, status: 'failed', message: error.message }); result.status = 'failed'; }
    }
    result.cleanup = cleanup; await save(join(out, 'result.json'), result);
  }
  assert.equal(result.status, 'passed', 'Owned resource cleanup failed');
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) console.log(usage);
  else {
    const args = process.argv.slice(2), options = { samples: 20 };
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index]?.slice(2), value = args[index + 1];
      assert.ok(['package', 'pi', 'fixture', 'source-http-helper', 'out', 'samples'].includes(key) && value, usage);
      options[key] = key === 'samples' ? Number(value) : value;
    }
    for (const key of ['package', 'pi', 'fixture', 'source-http-helper', 'out']) assert.ok(isAbsolute(options[key] ?? ''), usage);
    assert.ok(Number.isInteger(options.samples) && options.samples >= 1 && options.samples <= 100, usage);
    try { const result = await run(options); console.log(JSON.stringify({ status: result.status, out: options.out, metrics: result.metrics })); }
    catch (error) { console.error(JSON.stringify({ status: 'failed', out: options.out, error: error.message })); process.exitCode = 1; }
  }
}
