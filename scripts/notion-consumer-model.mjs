import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveHost } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { safeDiagnostic } from './verification-command.mjs';

const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const hash = value => createHash('sha256').update(value).digest('hex');

// Observation only: normal host tools remain available; attempted probes fail
// acceptance after the turn rather than being blocked to manufacture a pass.
export function observeConsumerModel(api, settings) {
  const { appendFileSync } = settings.fs;
  const { createHash } = settings.crypto;
  const { model, provider, id, sourceRoots, cacheRoots, output, marker, bodySha256, resourceSha256 } = settings;
  const values = Object.entries(process.env).filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL/i.test(key) && typeof value === 'string' && value.length >= 4).map(([, value]) => value);
  const sanitize = text => values.reduce((text, value) => text.split(value).join('[redacted]'), String(text)).replace(/\b(?:Bearer|Basic)\s+[a-z0-9+/._=-]+/gi, '[authorization withheld]').replace(/https?:\/\/[^\s"'<>]+/gi, '[url withheld]');
  const record = value => appendFileSync(output, JSON.stringify(value) + '\n', { mode: 0o600 });
  const texts = value => typeof value === 'string' ? value : Array.isArray(value) ? value.filter(part => part.type === 'text').map(part => part.text).join('\n') : '';
  const check = value => {
    const text = JSON.stringify(value);
    return { sourcePathExposed: sourceRoots.some(root => text.includes(root)), cachePathExposed: cacheRoots.some(root => text.includes(root)) };
  };
  const digest = text => createHash('sha256').update(text).digest('hex');
  const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  const cliCalls = new Set();
  const cliArtifacts = new Set();
  let resourceBody;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function(input, init) {
    const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    let payload;
    try { if (typeof raw === 'string') payload = JSON.parse(raw); } catch {}
    if (typeof payload?.model === 'string') {
      if (![id, model].includes(payload.model)) throw new Error('Consumer model rejected unauthorized transport selector');
      const text = JSON.stringify(payload);
      const parts = strings(payload);
      const bodies = parts.flatMap(text => [...text.matchAll(/<body>([\s\S]*?)<\/body>/g)].map(match => match[1].replace(/^\n|\n$/g, '')));
      const resourceBodyPresent = Boolean(resourceBody && parts.some(text => text.includes(resourceBody) || text.includes(JSON.stringify(resourceBody).slice(1, -1))));
      record({ phase: 'request', model, wireModel: payload.model, ...check(payload), cliGuidance: text.split('<ntn-skills-guidance>').length - 1, bodyPresent: text.includes(marker), completeBodies: bodies.filter(body => digest(body) === bodySha256).length, resourceBodyPresent, publicCommandPresent: text.includes('ntn-skills') });
    }
    const response = await originalFetch.call(this, input, init);
    if (typeof payload?.model === 'string') record({ phase: 'response', status: response.status });
    return response;
  };
  api.on('session_start', (_event, ctx) => {
    if (ctx.model?.provider !== provider || ctx.model?.id !== id) throw new Error('Consumer model rejected unauthorized selector');
    record({ phase: 'selected', model, tools: api.getActiveTools() });
  });
  api.on('tool_call', event => {
    if (event.toolName === 'bash' && /\bntn-skills\b/.test(event.input?.command ?? '')) cliCalls.add(event.toolCallId);
    const artifact = event.input?.path?.match(/^artifact:\/\/[a-z0-9_-]+/i)?.[0];
    if (event.toolName === 'read' && artifact && cliArtifacts.has(artifact)) cliCalls.add(event.toolCallId);
    record({ phase: 'tool_call', id: event.toolCallId, tool: event.toolName, input: JSON.parse(sanitize(JSON.stringify(event.input))), ...check(event.input) });
  });
  api.on('tool_result', event => {
    const body = texts(event.content);
    const viaPublicCli = cliCalls.has(event.toolCallId);
    if (viaPublicCli) for (const match of body.matchAll(/artifact:\/\/[a-z0-9_-]+/gi)) cliArtifacts.add(match[0]);
    let result;
    try { result = JSON.parse(body); } catch {
      try { result = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)); } catch {}
    }
    if (viaPublicCli && result?.ok === true && typeof result.content === 'string' && digest(result.content) === resourceSha256) resourceBody = result.content;
    record({ phase: 'tool_result', id: event.toolCallId, tool: event.toolName, isError: Boolean(event.isError), viaPublicCli, ...check(body), ...(result ? {
      ok: result.ok, errorCode: result.error?.code, source: result.source, path: result.path, ref: result.ref, snapshotId: result.snapshot_id,
      operation: typeof result.operation === 'string' ? result.operation : undefined, operationId: result.operation_id,
      action: result.action, verified: result.verified, reused: result.reused, dryRun: result.dry_run,
      changedFiles: result.changes?.files, removedFiles: result.changes?.removed,
      recordId: result.record?.id, databaseId: result.record?.locator?.database_id ?? result.database_id,
      contentSha256: typeof result.content === 'string' ? digest(result.content) : undefined,
    } : {}) });
  });
  api.on('message_end', event => {
    const message = event.message;
    if (message?.role !== 'assistant' || !['stop', 'length'].includes(message.stopReason)) return;
    const text = texts(message.content);
    record({ phase: 'assistant_final', success: Boolean(text.trim()), stopReason: message.stopReason, text: sanitize(text), ...check(text) });
  });
}

export async function runConsumerModel(host, { root, scratch, evidence, fixture, options, extension }) {
  assert.ok(['pi', 'omp'].includes(host));
  assert.match(options.model ?? '', /^[^/\s]+\/[^\s]+$/);
  assert.ok(options['model-prompt']?.trim());
  assert.deepEqual(fixture.command, ['ntn-skills'], 'Consumer isolation requires the public ntn-skills command, not an implementation argv');
  const resource = options['consumer-resource'];
  if (resource) assert.ok(!isAbsolute(resource) && !resource.includes('\\') && !resource.includes('\0') && !/^[A-Za-z]:/.test(resource) && resource.split('/').every(part => part && part !== '.' && part !== '..'), 'Consumer resource must be an exact portable relative file');
  const resourceSha256 = resource ? hash(await readFile(join(fixture.exportDirectory, resource))) : undefined;
  const base = join(scratch, `${host}-consumer-model`);
  const cwd = join(base, 'workspace');
  const bin = join(base, 'bin');
  const cache = join(base, 'source-cache');
  const sessions = join(base, 'sessions');
  for (const directory of [cwd, bin, cache, sessions]) await mkdir(directory, { recursive: true, mode: 0o700 });
  const cli = await resolveHost('ntn-skills');
  const wrapper = await readFile(cli.path, 'utf8');
  const implementationRoot = wrapper.match(/(\/[^\n"']+?)\/scripts\/dev\.ts\b/)?.[1];
  const sourceRoots = [...new Set([root, implementationRoot].filter(Boolean))];
  assert.ok(sourceRoots.every(source => { const path = relative(source, cwd); return path === '..' || path.startsWith('..' + sep) || isAbsolute(path); }), 'Consumer cwd must be outside implementation repositories');
  const shim = join(bin, 'ntn-skills');
  await writeFile(shim, '#!/bin/sh\nexec ' + [cli.file, ...cli.prefix].map(quote).join(' ') + ' "$@"\n', { mode: 0o700 });
  await chmod(shim, 0o700);
  const config = join(base, 'broker.json');
  await save(config, { pathMode: 'hash', logPaths: false, sources: [{ id: 'notion', type: 'notion', command: ['ntn-skills'], database: options.database, cacheDir: cache }] });
  const files = [`${host}-consumer-model-observer.jsonl`, `${host}-consumer-model-result.json`];
  const capture = join(evidence, files[0]);
  await writeFile(capture, '', { mode: 0o600 });
  const slash = options.model.indexOf('/');
  const escapedBody = fixture.entryContent.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const settings = { model: options.model, provider: options.model.slice(0, slash), id: options.model.slice(slash + 1), sourceRoots, cacheRoots: [cache, '~/.cache/context-broker', join(process.env.HOME ?? '', '.cache/context-broker')], marker: fixture.marker, bodySha256: hash(escapedBody), resourceSha256, output: capture };
  const observer = join(base, 'observe-consumer.mjs');
  await writeFile(observer, `import * as fs from 'node:fs';\nimport * as crypto from 'node:crypto';\nexport default function(api) { (${observeConsumerModel.toString()})(api, {...${JSON.stringify(settings)}, fs, crypto}); }\n`, { mode: 0o600 });
  const env = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (key !== 'PATH' && key !== 'HOME' && typeof value === 'string' && sourceRoots.some(root => value.includes(root))) delete env[key];
  }
  env.PATH = [bin, ...(env.PATH ?? '').split(delimiter).filter(path => !sourceRoots.some(root => path.startsWith(root + sep)))].join(delimiter);
  env.PWD = cwd;
  delete env.OLDPWD;
  delete env.INIT_CWD;
  delete env.NODE_OPTIONS;
  delete env.CONTEXT_BROKER_ROOTS;
  Object.assign(env, { CONTEXT_BROKER_CONFIG: config, CONTEXT_BROKER_HOST: host, CONTEXT_BROKER_LOG_FILE: join(base, 'decisions.jsonl') });
  const args = ['--no-extensions', '--no-skills', '--session-dir', sessions, '--tools', host === 'pi' ? 'read,bash,grep,find,ls' : 'read,bash,grep,glob', '-e', extension, '-e', observer, '--model', options.model];
  args.push('--append-system-prompt', 'Never permanently delete files or directories. Move owned disposable files to verified system Trash instead; on macOS use /usr/bin/trash with absolute paths. Do not remove unrelated files.');
  if (host === 'omp') {
    const overlay = join(base, 'host-overlay.yml');
    await writeFile(overlay, 'startup:\n  setupWizard: false\n  checkUpdate: false\ncompaction:\n  enabled: false\n', { mode: 0o600 });
    args.push('--no-ui', '--no-rules', '--no-title', '--config', overlay, '--smol', options.model, '--slow', options.model, '--plan', options.model);
  } else args.push('--no-mcp', '--no-context-files', '--no-prompt-templates');
  const result = { host, mode: 'model', recipe: 'consumer-isolation', model: options.model, status: 'running', files, workspace: cwd, publicCommand: 'ntn-skills', boundary: 'Neutral workspace, hidden local paths and sanitized inherited environment; real authentication is reused. This is observation and context isolation, not a filesystem sandbox.' };
  let rpc;
  try {
    rpc = await startRpc({ host, cwd, env, args });
    await rpc.prompt(`$${fixture.selectionToken ?? fixture.alias+'@notion'} ${options['model-prompt']}`);
    const rows = (await readFile(capture, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    const requests = rows.filter(row => row.phase === 'request');
    const calls = rows.filter(row => row.phase === 'tool_call');
    assert.ok(rows.some(row => row.phase === 'selected' && row.model === options.model), 'The explicitly authorized model must be selected');
    assert.ok(requests.length && rows.some(row => row.phase === 'response' && row.status >= 200 && row.status < 300), 'A real successful provider request is required');
    assert.ok(requests.every(row => row.cliGuidance === 1 && row.completeBodies === 1 && row.publicCommandPresent), 'Each request must receive one CLI guide and exactly one complete selected Skill body');
    assert.ok(rows.every(row => !row.sourcePathExposed && !row.cachePathExposed), 'Implementation or cache path exposed in provider data, tool interaction or answer');
    assert.ok(rows.some(row => row.phase === 'assistant_final' && row.success), 'A nonempty successful final answer is required');
    if (resource) {
      const loaded = rows.filter(row => row.phase === 'tool_result' && row.viaPublicCli && row.ok === true && row.source === 'local_snapshot' && row.path === resource && row.contentSha256 === resourceSha256 && row.snapshotId === fixture.live.snapshotId);
      assert.ok(loaded.length, 'The model must successfully read the requested resource through the public CLI on the selected snapshot');
      assert.ok(requests.some(row => row.resourceBodyPresent), 'The successful CLI resource body must reach a subsequent real provider request');
      result.resourceReads = loaded.length;
    } else assert.equal(calls.length, 0, 'Skill introduction must use the supplied body without tool probes');
    Object.assign(result, { status: 'passed', providerRequests: requests.length, toolCalls: calls.length, tools: rows.find(row => row.phase === 'selected').tools, observations: ['real authorized model', 'public CLI only in guidance', 'no implementation or cache paths in actual requests or tool interactions', options['consumer-resource'] ? 'pinned CLI resource read matched original bytes' : 'introduction without workflow adoption or tool probes'] });
  } catch (error) {
    result.status = 'failed';
    result.error = safeDiagnostic(Buffer.from(error?.message ?? 'Consumer model run did not complete'));
  } finally {
    if (rpc) try { await rpc.stop(); } catch { result.status = 'failed'; result.error ??= 'Owned consumer host teardown failed'; }
    await save(join(evidence, files[1]), result);
  }
  return result;
}
