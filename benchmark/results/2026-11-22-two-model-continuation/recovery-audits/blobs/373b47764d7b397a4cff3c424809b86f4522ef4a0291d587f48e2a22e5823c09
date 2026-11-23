/** Endpoint observations of the selected runtime files, not an installation inventory. */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_BYTES = 4_096;
const VERSION = /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
const GIT_VERSION = /^git version \d+\.\d+(?:\.\d+)?(?:[.+-][A-Za-z0-9.-]+)?(?: \(Apple Git-\d+\))?$/;
const USAGES = new Set(['requested', 'launched', 'available', 'potential', 'not_requested', 'unknown']);

function problem(error) {
  // Error messages and probe output can contain environment values. Retain codes only.
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code)
    ? error.code : 'OBSERVATION_FAILED';
}

async function fileIdentity(invocationPath, cwd, { optional = false } = {}) {
  const item = { invocation_path: typeof invocationPath === 'string' ? invocationPath : null,
    path: null, sha256: null, status: 'unknown' };
  if (!item.invocation_path) return { ...item, reason: 'NO_SELECTED_PATH' };
  try {
    const selected = isAbsolute(invocationPath) ? invocationPath : resolve(cwd, invocationPath);
    item.path = await realpath(selected);
    const before = await stat(item.path);
    if (!before.isFile()) return { ...item, reason: 'NOT_A_REGULAR_FILE' };
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(item.path)) hash.update(bytes);
    const after = await stat(item.path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        await realpath(selected) !== item.path) {
      return { ...item, reason: 'CHANGED_DURING_OBSERVATION' };
    }
    return { ...item, sha256: hash.digest('hex'), status: 'observed' };
  } catch (error) {
    if (optional && error.code === 'ENOENT') return { ...item, status: 'absent' };
    return { ...item, reason: problem(error) };
  }
}

function probeVersion(command, args, { env, cwd, versionPattern = VERSION }) {
  if (typeof command !== 'string' || !command) {
    return Promise.resolve({ status: 'unknown', reason: 'NO_SELECTED_PATH', version: null });
  }
  if (process.platform === 'win32') {
    return Promise.resolve({ status: 'unknown', reason: 'PROBE_PROCESS_GROUP_UNAVAILABLE', version: null });
  }
  return new Promise(resolveProbe => {
    let proc;
    try {
      proc = spawn(command, args, { env, cwd, detached: true, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolveProbe({ status: 'unknown', reason: problem(error), version: null });
      return;
    }
    let failure, cleanupError, timer, cleanupTimer, finished = false, stopped = false, outputBytes = 0;
    const stdout = [];
    const unknown = (reason, extra = {}) => ({ status: 'unknown', reason, version: null, ...extra });
    const stopGroup = () => {
      if (stopped || !proc.pid) return;
      stopped = true;
      // detached:true gives this probe its own POSIX group. Never scan or kill by name.
      try { process.kill(-proc.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') cleanupError = problem(error); }
    };
    const finish = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(cleanupTimer);
      // Also discard background descendants of an otherwise completed version probe.
      stopGroup();
      proc.stdout?.destroy(); proc.stderr?.destroy(); proc.unref();
      resolveProbe(cleanupError
        ? { ...unknown(result.reason ?? 'PROBE_CLEANUP_FAILED'), cleanup_error: cleanupError }
        : result);
    };
    const abort = reason => {
      if (failure || finished) return;
      failure = reason;
      stopGroup();
      // SIGKILL normally produces close immediately. A failed OS cleanup must still
      // return an unknown observation instead of swallowing the product's receipt.
      cleanupTimer = setTimeout(() => finish(unknown(failure, { cleanup: 'unconfirmed' })), 1000);
    };
    const collect = (chunk, keep) => {
      if (failure || finished) return;
      outputBytes += chunk.length;
      if (outputBytes > PROBE_MAX_BYTES) abort('PROBE_OUTPUT_LIMIT');
      else if (keep) stdout.push(chunk);
    };
    proc.stdout?.on('data', chunk => collect(chunk, true));
    proc.stderr?.on('data', chunk => collect(chunk, false));
    proc.stdout?.on('error', error => abort(problem(error)));
    proc.stderr?.on('error', error => abort(problem(error)));
    proc.once('error', error => abort(problem(error)));
    proc.once('close', (code, signal) => {
      if (failure) return finish(unknown(failure));
      if (code !== 0) return finish(unknown('PROBE_EXIT_NONZERO', {
        ...(typeof code === 'number' ? { exit_code: code } : {}), ...(signal ? { signal } : {}),
      }));
      const version = Buffer.concat(stdout).toString('utf8').trim();
      finish(versionPattern.test(version)
        ? { status: 'observed', version }
        : unknown('INVALID_VERSION_OUTPUT'));
    });
    timer = setTimeout(() => abort('PROBE_TIMEOUT'), PROBE_TIMEOUT_MS);
  });
}

function usageOf(usage, tool) {
  return USAGES.has(usage?.[tool]) ? usage[tool] : 'unknown';
}

async function executableIdentity(path, tool, options) {
  const [file, probe] = await Promise.all([
    fileIdentity(path, options.cwd), probeVersion(path, ['--version'], {
      ...options, versionPattern: tool === 'git' ? GIT_VERSION : VERSION,
    }),
  ]);
  return { ...file, version: probe.version, version_source: 'subprocess --version',
    version_probe: probe, usage: usageOf(options.usage, tool), scope: 'selected-entry-file',
    status: file.status === 'observed' && probe.status === 'observed' ? 'observed' : 'unknown' };
}

async function manifestIdentity(packageRoot, cwd) {
  const path = typeof packageRoot === 'string' ? join(packageRoot, 'package.json') : null;
  const file = await fileIdentity(path, cwd);
  const identity = { ...file, name: null, version: null };
  if (file.status !== 'observed') return identity;
  try {
    const bytes = await readFile(file.path);
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      return { ...identity, status: 'unknown', reason: 'CHANGED_DURING_OBSERVATION' };
    }
    const manifest = JSON.parse(bytes.toString('utf8'));
    if (manifest.name !== '@earendil-works/pi-coding-agent' ||
        typeof manifest.version !== 'string' || !VERSION.test(manifest.version)) {
      return { ...identity, status: 'unknown', reason: 'INVALID_PI_MANIFEST' };
    }
    return { ...identity, name: manifest.name, version: manifest.version };
  } catch (error) {
    return { ...identity, status: 'unknown', reason: problem(error) };
  }
}

async function piIdentity(pi, node, options) {
  const [file, manifest, probe] = await Promise.all([
    fileIdentity(pi?.path, options.cwd), manifestIdentity(pi?.package_root, options.cwd),
    typeof pi?.path === 'string'
      ? probeVersion(node, [pi.path, '--version'], options)
      : Promise.resolve({ status: 'unknown', reason: 'NO_SELECTED_PATH', version: null }),
  ]);
  const runtime = file.path
    ? await fileIdentity(join(dirname(file.path), 'cli-runtime.js'), options.cwd, { optional: true })
    : { invocation_path: null, path: null, sha256: null, status: 'unknown', reason: 'NO_RESOLVED_PI_ENTRY' };
  const versionMatches = probe.status === 'observed' && manifest.status === 'observed' &&
    probe.version.replace(/^v/, '') === manifest.version.replace(/^v/, '');
  const status = file.status === 'observed' && versionMatches &&
    ['observed', 'absent'].includes(runtime.status) ? 'observed' : 'unknown';
  return { ...file, status, version: probe.version, version_source: 'subprocess --version + package manifest',
    version_probe: probe, package_version: manifest.version, package_manifest: manifest, runtime_module: runtime,
    usage: usageOf(options.usage, 'pi'),
    scope: 'selected-entry-file, package-manifest, optional-cli-runtime-file; not-full-installation',
    ...(probe.status === 'observed' && manifest.status === 'observed' && !versionMatches
      ? { reason: 'PI_VERSION_MISMATCH' } : {}) };
}

/** Observe the exact caller-selected paths under the actual target environment.
 * Usage is a caller assertion. Executing a version probe never implies target use.
 * Failures become unknown observations so they cannot suppress a target receipt.
 */
export async function captureRuntimeIdentity({ node, pi, bun, git, env, cwd, usage, launchers } = {}) {
  const options = { env: env ?? {}, cwd: cwd ?? process.cwd(), usage };
  const [nodeIdentity, piIdentityResult, bunIdentity] = await Promise.all([
    executableIdentity(node, 'node', options), piIdentity(pi, node, options),
    executableIdentity(bun, 'bun', options),
  ]);
  const declaredLaunchers = launchers === undefined ? undefined : Object.fromEntries(await Promise.all(
    Object.entries(launchers ?? {}).map(async ([name, path]) => [name,
      { ...await fileIdentity(path, options.cwd), scope: 'selected-launcher-file' }]),
  ));
  return { node: nodeIdentity, pi: piIdentityResult, bun: bunIdentity,
    ...(git === undefined ? {} : { git: await executableIdentity(git, 'git', options) }),
    ...(declaredLaunchers === undefined ? {} : { launchers: declaredLaunchers }) };
}

/** Compare only the declared endpoint scope; known differences outrank unknowns. */
export function compareRuntimeIdentity(before, after) {
  const changes = [], unknown = [];
  function compare(name, first, last, fields, optional = false) {
    if (optional && first?.status === 'absent' && last?.status === 'absent') return;
    if (optional && ((first?.status === 'absent' && last?.status === 'observed') ||
        (first?.status === 'observed' && last?.status === 'absent'))) {
      changes.push({ tool: name, field: 'presence', before: first.status, after: last.status });
      return;
    }
    for (const field of fields) {
      const a = first?.[field], b = last?.[field];
      if (typeof a !== 'string' || typeof b !== 'string') {
        unknown.push({ tool: name, field, reason: 'INCOMPLETE_OBSERVATION' });
      } else if (a !== b) changes.push({ tool: name, field, before: a, after: b });
    }
    if (first?.status !== 'observed' || last?.status !== 'observed') {
      unknown.push({ tool: name, field: 'status',
        before: first?.reason ?? first?.version_probe?.reason ?? first?.status ?? 'missing',
        after: last?.reason ?? last?.version_probe?.reason ?? last?.status ?? 'missing' });
    }
  }
  const fields = ['invocation_path', 'path', 'sha256', 'version'];
  for (const tool of ['node', 'pi', 'bun']) compare(tool, before?.[tool], after?.[tool], fields);
  if (before?.git !== undefined || after?.git !== undefined) compare('git', before?.git, after?.git, fields);
  compare('pi.package_manifest', before?.pi?.package_manifest, after?.pi?.package_manifest,
    ['invocation_path', 'path', 'sha256', 'name', 'version']);
  compare('pi.runtime_module', before?.pi?.runtime_module, after?.pi?.runtime_module,
    ['invocation_path', 'path', 'sha256'], true);
  const launcherNames = new Set([...Object.keys(before?.launchers ?? {}), ...Object.keys(after?.launchers ?? {})]);
  for (const name of launcherNames) {
    compare('launchers.' + name, before?.launchers?.[name], after?.launchers?.[name],
      ['invocation_path', 'path', 'sha256']);
  }
  return { status: changes.length ? 'drifted' : unknown.length ? 'unknown' : 'unchanged',
    changes, unknown, scope: 'selected-runtime-and-declared-launcher-files-at-run-endpoints' };
}
