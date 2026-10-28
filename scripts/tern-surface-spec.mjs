#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { capabilities, digest, matrix, validateSpec } from './tern-surface-contract.mjs';

const surfaces = Object.freeze(['pi-terminal', 'omp-terminal', 'omp-native']);
const specFields = new Set(['version', 'surface', 'model', 'hostEnvNames', 'hostBinary', 'hostSha256', 'hostArgs', 'ternBinary', 'extension', 'companion', 'config', 'agentDir', 'cwd', 'scope', 'fixtureReceipt', 'artifacts', 'companionConfig', 'markers', 'refs', 'scenarios', 'staticContract', 'fixtureMetadataInputs', 'runLimits']);
const placeholder = /\b(?:TODO|TBD|FIXME|placeholder|replace[-_ ]me|insert[-_ ]here)\b|<[^>]*(?:path|identity|candidate|key|value)[^>]*>/i;
const object = (value, label) => assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
const absolute = (value, label) => assert.ok(typeof value === 'string' && isAbsolute(value), `${label} must be an absolute path`);
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const usage = 'Usage: node scripts/tern-surface-spec.mjs --config /absolute/config.json --out /absolute/new-directory\nConfig: { common: { ...runSpec, staticContract: { keybindings, parse } }, surfaces: { "pi-terminal": { scenarios: [...] }, "omp-terminal": { scenarios: [...] }, "omp-native": { scenarios: [...] } } }. Each required case needs concrete reset + steps, an explicit public API limitation, or an exact FIXTURE_REQUIRED prerequisite gate. OMP native also requires manual stale-pane and stale-cwd cases; stale-session remains available for a real host session interaction. Optional fixtureMetadataInputs is an array of absolute paths, and runLimits bounds elapsed time and provider requests. No processes, preparation commands, or model requests are executed. The output directory must not exist.';

function checkCredentials(value, label) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'token' && value.op === 'draft' && typeof item === 'string' && item.startsWith('$')) continue;
    assert.ok(key !== 'hostEnv' && key !== 'env' && key !== 'credentials' && !/authorization|cookie|password|secret|token|api[-_]?key/i.test(key), `${label}.${key}: inherit credentials by hostEnvNames only`);
    checkCredentials(item, `${label}.${key}`);
  }
}

function checkSteps(steps, label) {
  assert.ok(Array.isArray(steps) && steps.length > 0, `${label} requires concrete steps`);
  const ids = new Set();
  for (const step of steps) {
    object(step, label);
    assert.match(step.id ?? '', /^[a-z0-9-]+$/, `${label} needs stable step IDs`);
    assert.ok(!ids.has(step.id), `${label} repeats step ID ${step.id}`);
    ids.add(step.id);
    const required = { type: 'text', key: 'key', candidate: 'identity', click: 'selector', palette: 'query', expect: 'text', draft: 'text', requests: 'count', provider: null, events: 'phase', shot: null, control: 'command', 'tool-read': 'path' };
    assert.ok(Object.hasOwn(required, step.op), `${label}/${step.id}: unsupported operation ${step.op}`);
    if (required[step.op]) assert.ok(Object.hasOwn(step, required[step.op]), `${label}/${step.id}: missing ${required[step.op]}`);
    if (step.op === 'provider') {
      assert.ok(step.markers && Object.keys(step.markers).length || step.minImages !== undefined || step.imageCount !== undefined || step.sameImagesFrom !== undefined, `${label}/${step.id}: provider assertion must check delivery content`);
      if (step.imageCount !== undefined) assert.ok(Number.isSafeInteger(step.imageCount) && step.imageCount >= 0, `${label}/${step.id}: imageCount must be a non-negative safe integer`);
    }
    if (['type', 'key', 'expect', 'draft', 'tool-read'].includes(step.op)) assert.ok(typeof step[required[step.op]] === 'string' && step[required[step.op]].length > 0, `${label}/${step.id}: concrete ${required[step.op]} required`);
    if (step.op === 'expect' && step.match !== undefined) assert.equal(step.match, 'contains', `${label}/${step.id}: only explicit contains matching is supported`);
    if (step.op === 'draft' && step.token !== undefined) {
      assert.ok(typeof step.token === 'string' && step.token.startsWith('$'), `${label}/${step.id}: exact capsule token required`);
      assert.ok(typeof step.prefix === 'string' && typeof (step.suffix ?? '') === 'string', `${label}/${step.id}: exact prefix/suffix required`);
    }
    if (step.op === 'candidate') {
      object(step.identity, `${label}/${step.id} observed identity`);
      assert.ok(Object.keys(step.identity).length > 0, `${label}/${step.id} needs an observed candidate identity`);
      if (step.queryText !== undefined) {
        assert.ok(typeof step.queryText === 'string' && step.queryText.length, `${label}/${step.id}: concrete queryText required`);
        for (const key of ['identity', 'ref', 'kind', 'source', 'value']) assert.ok(typeof step.identity[key] === 'string' && step.identity[key].length, `${label}/${step.id}: exact public candidate ${key} required`);
      }
    }
  }
}

function checkInput(input, label) {
  object(input, label);
  for (const key of Object.keys(input)) assert.ok(specFields.has(key), `${label}: unsupported field ${key}; credentials may only be inherited through hostEnvNames`);
  assert.ok(!placeholder.test(JSON.stringify(input)), `${label} contains a placeholder`);
  checkCredentials(input, label);
}

export async function generateSurfaceSpecs(configPath, outPath) {
  absolute(configPath, '--config');
  absolute(outPath, '--out');
  const configBytes = await readFile(configPath);
  const config = JSON.parse(configBytes.toString('utf8'));
  object(config, 'Config');
  assert.deepEqual(Object.keys(config).sort(), ['common', 'surfaces'], 'Config requires exactly common and surfaces');
  checkInput(config.common, 'common');
  assert.ok(!Object.hasOwn(config.common, 'scenarios'), 'Scenarios must be explicit for each surface');
  object(config.surfaces, 'surfaces');
  assert.deepEqual(Object.keys(config.surfaces).sort(), [...surfaces].sort(), 'Config requires exactly three surfaces');
  const frozen = [];
  const hashFile = async (path, label) => {
    absolute(path, label);
    const bytes = await readFile(path);
    return { path, sha256: digest(bytes), bytes: bytes.length };
  };
  for (const surface of surfaces) {
    const own = config.surfaces[surface];
    checkInput(own, surface);
    assert.ok(Object.hasOwn(own, 'scenarios'), `${surface} requires its own complete scenarios`);
    const spec = { ...config.common, ...own };
    assert.ok(spec.version === undefined || spec.version === 1, `${surface}: unsupported spec version`);
    assert.ok(spec.surface === undefined || spec.surface === surface, `${surface}: conflicting surface`);
    spec.version = 1;
    spec.surface = surface;
    assert.equal(spec.model, 'magpie/group/e2e');
    assert.ok(Array.isArray(spec.hostEnvNames) && spec.hostEnvNames.every(name => typeof name === 'string' && /^[A-Z][A-Z0-9_]*$/.test(name)), `${surface}: explicit environment-name allowlist required`);
    assert.equal(new Set(spec.hostEnvNames).size, spec.hostEnvNames.length, `${surface}: duplicate environment names`);
    object(spec.staticContract, `${surface}.staticContract`);
    for (const key of ['keybindings', 'parse']) {
      const value = spec.staticContract[key];
      assert.ok(value && typeof value === 'object' && Object.keys(value).length > 0, `${surface}: explicit static ${key} contract required`);
    }
    assert.ok(Array.isArray(spec.scenarios), `${surface}: scenarios must be an array`);
    const gates = new Set();
    spec.scenarios = spec.scenarios.map(item => {
      object(item, `${surface} scenario`);
      assert.ok(Object.hasOwn(matrix, item.id), `${surface}: unknown matrix case ${item.id}`);
      assert.ok(item.intent === undefined || item.intent === matrix[item.id], `${surface}/${item.id}: conflicting intent`);
      if (Object.hasOwn(item, 'gate')) {
        assert.ok(typeof item.gate === 'string' && item.gate.trim().length > 20 && (/\b(?:API|ctl|renderer|transport|public)\b/i.test(item.gate) || item.gate.startsWith('FIXTURE_REQUIRED:')), `${surface}/${item.id}: gate must identify the public API limitation or exact missing fixture prerequisite`);
        assert.ok(!gates.has(item.gate), `${surface}/${item.id}: default/reused gates are forbidden`);
        gates.add(item.gate);
        assert.ok(!Object.hasOwn(item, 'reset') && !Object.hasOwn(item, 'steps'), `${surface}/${item.id}: a gate cannot silently replace concrete steps`);
      } else {
        checkSteps(item.reset, `${surface}/${item.id}/reset`);
        checkSteps(item.steps, `${surface}/${item.id}/steps`);
        assert.ok(item.steps.some(step => ['type', 'key', 'candidate', 'click', 'palette', 'control'].includes(step.op)), `${surface}/${item.id}: steps must perform a real interaction`);
        assert.ok(item.steps.some(step => ['expect', 'draft', 'requests', 'provider', 'events', 'tool-read'].includes(step.op)), `${surface}/${item.id}: steps must assert observable evidence`);
      }
      return { ...item, intent: matrix[item.id] };
    });
    validateSpec(spec);
    for (const key of ['extension', 'companion', 'config', 'agentDir', 'cwd', 'fixtureReceipt', 'hostBinary', 'ternBinary']) absolute(spec[key], `${surface}.${key}`);
    assert.ok(/\.[cm]?tsx?$/.test(spec.extension), `${surface}: use an official TypeScript extension entry`);
    const receipt = await hashFile(spec.fixtureReceipt, 'fixtureReceipt');
    assert.equal(JSON.parse((await readFile(spec.fixtureReceipt)).toString('utf8')).owned, true, `${surface}: fixture receipt must attest owned targets`);
    assert.ok((config.common.fixtureMetadataInputs === undefined || Array.isArray(config.common.fixtureMetadataInputs)) && (own.fixtureMetadataInputs === undefined || Array.isArray(own.fixtureMetadataInputs)), 'fixtureMetadataInputs must be arrays of absolute paths');
    const inputs = [...new Set([...(config.common.fixtureMetadataInputs ?? []), ...(own.fixtureMetadataInputs ?? [])])];
    const fixtureMetadata = await Promise.all(inputs.map(path => hashFile(path, 'fixtureMetadataInputs')));
    delete spec.fixtureMetadataInputs;
    assert.ok(Array.isArray(spec.artifacts), `${surface}: explicit frozen artifacts required`);
    const roles = new Set();
    spec.artifacts = await Promise.all(spec.artifacts.map(async item => {
      object(item, `${surface} artifact`);
      assert.ok(typeof item.role === 'string' && !roles.has(item.role), `${surface}: duplicate or missing artifact role`);
      roles.add(item.role);
      const actual = await hashFile(item.path, `${surface}.${item.role}`);
      if (item.sha256 !== undefined) assert.equal(item.sha256, actual.sha256, `${surface}: frozen ${item.role} hash mismatch`);
      return { role: item.role, ...actual };
    }));
    for (const role of ['cli', 'broker', 'tern', 'query']) assert.ok(roles.has(role), `${surface}: missing frozen ${role}`);
    const host = await hashFile(spec.hostBinary, `${surface}.hostBinary`);
    if (spec.hostSha256 !== undefined) assert.equal(spec.hostSha256, host.sha256, `${surface}: frozen host hash mismatch`);
    spec.hostSha256 = host.sha256;
    spec.generatorInputs = { config: { path: configPath, sha256: digest(configBytes), bytes: configBytes.length }, fixtureReceipt: receipt, fixtureMetadata };
    const bytes = encode(spec);
    frozen.push({ surface, spec, bytes, file: `${surface}.json`, sha256: digest(bytes) });
  }
  const manifest = {
    version: 1,
    model: 'magpie/group/e2e',
    status: 'generated-not-run',
    preparation: 'read-only-files; no CLI or provider calls',
    config: { path: configPath, sha256: digest(configBytes) },
    capabilities,
    matrix: Object.entries(matrix).map(([id, intent]) => ({ id, intent })),
    surfaces: frozen.map(({ surface, spec, file, sha256 }) => ({ surface, file, sha256, hostEnvNames: spec.hostEnvNames, staticContract: spec.staticContract, fixtureMetadata: spec.generatorInputs.fixtureMetadata, scenarios: spec.scenarios.map(({ id, gate }) => ({ id, disposition: gate ? 'gated-not-run' : 'ready-not-run', ...(gate ? { gate } : {}) })) })),
  };
  // Exclusive mkdir preserves all existing outputs, including incomplete earlier generations.
  await mkdir(outPath, { mode: 0o700 });
  for (const item of frozen) await writeFile(join(outPath, item.file), item.bytes, { flag: 'wx', mode: 0o400 });
  await writeFile(join(outPath, 'manifest.json'), encode(manifest), { flag: 'wx', mode: 0o400 });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) console.log(usage);
    else {
      assert.equal(args.length, 4, usage);
      const options = {};
      for (let index = 0; index < args.length; index += 2) {
        assert.ok(['--config', '--out'].includes(args[index]) && !Object.hasOwn(options, args[index]), usage);
        options[args[index]] = args[index + 1];
      }
      const manifest = await generateSurfaceSpecs(options['--config'], options['--out']);
      console.log(JSON.stringify({ out: options['--out'], status: manifest.status, specs: manifest.surfaces.map(item => ({ surface: item.surface, path: join(options['--out'], item.file), sha256: item.sha256 })), manifest: join(options['--out'], 'manifest.json') }, null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
