import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyArchiveInstallation } from './verify-package-closure.mjs';

const root = resolve(import.meta.dirname, '..');
export const registry = 'https://registry.npmjs.org';
const packageName = 'pi-context-broker';
const repository = 'https://github.com/yoyooyooo/pi-context-broker';
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

export function stable(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Only stable x.y.z releases are supported');
  return value.split('.').map(BigInt);
}

export function compare(left, right) {
  const a = stable(left), b = stable(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

export function validateManifest(manifest, version) {
  stable(version);
  assert.equal(manifest.name, packageName);
  assert.equal(manifest.version, version);
  assert.ok(!manifest.private, 'A private package cannot be published');
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies', 'overrides', 'resolutions']) {
    assert.ok(!/(?:catalog|workspace|file|link):/.test(JSON.stringify(manifest[field] ?? {})),
      'Unresolved or local dependency in archive ' + field);
  }
}

export async function validateSource({ cwd = root, cliRoot, tag, mode }) {
  assert.ok(['new', 'repair'].includes(mode));
  assert.ok(tag?.startsWith('v'));
  const version = tag.slice(1); stable(version);
  validateManifest(await json(join(cwd, 'packages/context-broker/package.json')), version);
  assert.equal(git(cwd, 'cat-file', '-t', 'refs/tags/' + tag), 'tag', 'Release tags must be annotated and immutable');
  const commit = git(cwd, 'rev-parse', 'refs/tags/' + tag + '^{commit}');
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), commit, 'Checkout must be the selected tag');
  assert.equal(git(cwd, 'status', '--porcelain', '--untracked-files=no'), '', 'Release source must be clean');
  git(cwd, 'fetch', 'origin', 'main', '--no-tags');
  const main = git(cwd, 'rev-parse', 'origin/main');
  const parents = git(cwd, 'rev-list', '--parents', '-n', '1', commit).split(' ');
  assert.equal(parents.length, 2, 'A release commit must have exactly one main parent');
  const parent = parents[1];
  if (mode === 'new') assert.equal(parent, main, 'A new release must be based on current origin/main');
  else git(cwd, 'merge-base', '--is-ancestor', parent, main);
  const config = await json(join(cwd, '.github/release.config.json'));
  const allowed = new Set([...config.versionFiles, ...config.lockfiles]);
  for (const path of git(cwd, 'diff-tree', '--no-commit-id', '--name-only', '-r', commit).split('\n').filter(Boolean)) {
    assert.ok(allowed.has(path), 'Release commit changed an unauthorized path: ' + path);
  }
  for (const path of config.versionFiles) {
    const before = JSON.parse(git(cwd, 'show', parent + ':' + path)), after = await json(join(cwd, path));
    assert.equal(after.version, version);
    delete before.version; delete after.version;
    assert.ok(isDeepStrictEqual(before, after), 'Release commit changed more than the version in ' + path);
  }
  const pin = (await readFile(join(cwd, '.github/ntn-skills-cli-revision'), 'utf8')).trim();
  assert.match(pin, /^[a-f0-9]{40}$/u, 'The selected CLI input must be one full commit');
  for (const name of ['ci', 'publish', 'formal']) {
    const text = await readFile(join(cwd, '.github/workflows/' + name + '.yml'), 'utf8');
    assert.ok(text.includes('cat .github/ntn-skills-cli-revision')
      && /repository: yoyooyooo\/notion-skills-cli\s+ref: \$\{\{ steps\.cli-input\.outputs\.revision \}\}/u.test(text),
    name + ' must use the shared CLI revision');
  }
  assert.equal(git(cliRoot, 'rev-parse', 'HEAD'), pin, 'Actual CLI checkout differs from the pin');
  assert.equal(git(cliRoot, 'status', '--porcelain', '--untracked-files=no'), '', 'CLI source must be clean');
  return { version: 1, name: packageName, packageVersion: version, tag, mode, channel: 'latest',
    brokerCommit: commit, brokerTree: git(cwd, 'rev-parse', 'HEAD^{tree}'),
    main, parent, cliRoot: resolve(cliRoot), cliCommit: pin, cliTree: git(cliRoot, 'rev-parse', 'HEAD^{tree}') };
}

export async function registryDocument(path, fetcher = fetch) {
  const response = await fetcher(registry + '/' + path, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (response.status === 404) return { kind: 'absent' };
  assert.equal(response.status, 200, 'Registry state is unknown: HTTP ' + response.status);
  const document = await response.json();
  assert.ok(document && typeof document === 'object' && !Array.isArray(document), 'Registry response is malformed');
  return { kind: 'present', document };
}

export function publicationDecision(candidate, presence, channel) {
  if (presence.kind === 'present') {
    assert.equal(presence.document.name, candidate.name);
    assert.equal(presence.document.version, candidate.packageVersion);
    assert.equal(presence.document.dist?.integrity, candidate.integrity, 'Published bytes differ from the checked archive');
    return { alreadyPublished: true };
  }
  assert.equal(presence.kind, 'absent');
  assert.equal(candidate.mode, 'new', 'Unpublished failed tags are immutable. Choose a higher version; repair cannot publish.');
  if (channel.kind === 'present') {
    assert.equal(channel.document.name, candidate.name);
    assert.ok(compare(candidate.packageVersion, channel.document.version) > 0, 'Refusing to move latest backward');
  }
  return { alreadyPublished: false };
}

export function validateRegistry(candidate, document, channel, alreadyPublished) {
  assert.equal(document.name, candidate.name);
  assert.equal(document.version, candidate.packageVersion);
  assert.equal(document.dist?.integrity, candidate.integrity, 'Registry integrity differs from the checked tarball');
  assert.equal(channel.name, candidate.name);
  const order = compare(channel.version, candidate.packageVersion);
  assert.ok(order === 0 || alreadyPublished && order > 0, 'Registry latest is inconsistent with this release or repair');
  assert.ok(typeof document.dist?.attestations?.url === 'string', 'Registry provenance is not visible');
}

export function validateProvenance(candidate, audit) {
  assert.deepEqual(audit.invalid, []);
  assert.deepEqual(audit.missing, []);
  const verified = audit.verified?.find(value => value.name === candidate.name && value.version === candidate.packageVersion);
  assert.equal(verified?.registry?.replace(/\/$/, ''), registry, 'The exact package must have verified npm attestations');
  const attestation = verified.attestationBundles?.find(value => value.predicateType === 'https://slsa.dev/provenance/v1');
  const payload = attestation?.bundle?.dsseEnvelope?.payload;
  assert.equal(typeof payload, 'string', 'Verified SLSA provenance is missing');
  const statement = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  const sha512 = Buffer.from(candidate.integrity.slice('sha512-'.length), 'base64').toString('hex');
  assert.ok(statement.subject?.some(value => value.name === `pkg:npm/${candidate.name}@${candidate.packageVersion}` && value.digest?.sha512 === sha512), 'Provenance subject differs from the checked archive');
  const definition = statement.predicate?.buildDefinition, workflow = definition?.externalParameters?.workflow;
  assert.equal(workflow?.repository, repository);
  assert.equal(workflow?.path, '.github/workflows/publish.yml');
  assert.equal(workflow?.ref, 'refs/tags/' + candidate.tag);
  assert.ok(definition?.resolvedDependencies?.some(value => value.digest?.gitCommit === candidate.brokerCommit), 'Provenance commit differs from the immutable tag');
  assert.equal(statement.predicate?.runDetails?.builder?.id, 'https://github.com/actions/runner/github-hosted');
  return statement;
}

export async function archiveIdentity(archive, version) {
  const bytes = await readFile(archive);
  const members = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(members.length > 0 && new Set(members).size === members.length);
  for (const member of members) assert.ok(member.startsWith('package/') && !member.split('/').includes('..'), 'Unsafe archive member');
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
  validateManifest(manifest, version);
  return { archive: resolve(archive), sha256: hash(bytes), integrity: 'sha512-' + hash(bytes, 'sha512', 'base64'), bytes: bytes.length, manifest };
}

async function checkedCandidate(path) {
  const candidate = await json(path), actual = await archiveIdentity(candidate.archive, candidate.packageVersion);
  assert.equal(candidate.name, packageName);
  assert.equal(actual.sha256, candidate.sha256, 'Checked archive changed');
  assert.equal(actual.integrity, candidate.integrity);
  assert.equal(git(root, 'rev-parse', 'HEAD'), candidate.brokerCommit);
  assert.equal(git(candidate.cliRoot, 'rev-parse', 'HEAD'), candidate.cliCommit);
  return candidate;
}

async function registryConsumer(candidate, output) {
  const base = await mkdtemp(join(dirname(resolve(output)), 'registry-consumer-'));
  await writeFile(join(base, 'package.json'), JSON.stringify({ name: 'broker-registry-readback', private: true }));
  const commands = [];
  const run = (command, argv) => {
    const result = spawnSync(command, argv, { cwd: base, encoding: 'utf8', timeout: 360_000,
      maxBuffer: 32 * 1024 * 1024, env: { ...process.env, npm_config_cache: join(base, 'npm-cache') } });
    commands.push({ command, argv, exit: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
    assert.equal(result.status, 0, command + ' failed; original output is retained'); return result.stdout;
  };
  try {
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--omit=peer', '--save-exact', candidate.name + '@' + candidate.packageVersion, '--registry', registry]);
    const installed = join(base, 'node_modules', candidate.name);
    const archive = await verifyArchiveInstallation(installed, candidate.archive, candidate.sha256);
    const lock = await json(join(base, 'package-lock.json'));
    assert.equal(lock.packages['node_modules/' + candidate.name].integrity, candidate.integrity);
    run(process.execPath, [join(installed, 'dist/ntn-skills.mjs'), '--help']);
    run(process.execPath, ['--input-type=module', '-e',
      'const s=await import(process.argv[1]); if(s.SDK_VERSION!==2 || typeof s.listCatalog!=="function" || typeof s.readSkill!=="function") process.exit(1);',
      pathToFileURL(join(installed, 'dist/ntn-skills-sdk.mjs')).href]);
    const signatures = JSON.parse(run('npm', ['audit', 'signatures', '--json', '--include-attestations', '--omit=dev', '--omit=peer', '--registry', registry]));
    const provenance = validateProvenance(candidate, signatures);
    await save(join(base, 'signatures.json'), signatures);
    return { root: base, fileCount: archive.file_count, installedSha256: archive.sha256, provenance };
  } finally {
    await save(join(base, 'commands.json'), commands);
  }
}

export function repairGitHubRelease({ candidate, archive, notes, run }) {
  const repo = 'yoyooyooo/pi-context-broker';
  const name = `pi-context-broker-${candidate.packageVersion}.tgz`;
  assert.equal(basename(archive), name, 'Release asset name must match the checked package');
  const query = run(['api', `repos/${repo}/releases/tags/${candidate.tag}`]);
  let existing;
  if (query.status === 0) {
    existing = JSON.parse(query.stdout);
    assert.ok(existing && typeof existing === 'object' && !Array.isArray(existing)
      && Array.isArray(existing.assets), 'GitHub Release state is malformed; do not change it');
  }
  else assert.match(query.stderr, /\(HTTP 404\)/, 'GitHub Release state is unknown; do not create another release');
  const checked = args => {
    const result = run(args);
    assert.equal(result.status, 0, 'GitHub command failed; retain the original result and reconcile before retry');
    return result;
  };
  if (existing) {
    assert.equal(existing.tag_name, candidate.tag);
    assert.equal(existing.draft, false, 'A separately prepared draft needs its own publication decision');
    const asset = existing.assets?.find(value => value.name === name);
    if (asset) assert.equal(asset.digest, 'sha256:' + candidate.sha256, 'Existing release asset differs; never overwrite it');
    checked(['release', 'edit', candidate.tag, '--repo', repo, '--title', candidate.tag, '--notes-file', notes, '--latest=false']);
  } else {
    checked(['release', 'create', candidate.tag, '--repo', repo, '--title', candidate.tag, '--notes-file', notes, '--verify-tag', '--latest=false']);
  }
  const asset = existing?.assets?.find(value => value.name === name);
  if (!asset) checked(['release', 'upload', candidate.tag, archive, '--repo', repo]);
  const observed = JSON.parse(checked(['api', `repos/${repo}/releases/tags/${candidate.tag}`]).stdout);
  assert.equal(observed.tag_name, candidate.tag);
  assert.equal(observed.draft, false);
  assert.equal(observed.assets?.find(value => value.name === name)?.digest, 'sha256:' + candidate.sha256,
    'GitHub Release asset is not confirmed; preserve this attempt and reconcile before retry');
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === 'source' && rest.length === 4) {
    const [tag, mode, cliRoot, output] = rest;
    await save(output, await validateSource({ tag, mode, cliRoot }));
  } else if (command === 'candidate' && rest.length === 4) {
    const [sourcePath, archive, verificationPath, output] = rest;
    const source = await json(sourcePath), verified = await json(verificationPath);
    const identity = await archiveIdentity(archive, source.packageVersion);
    assert.equal(verified.status, 'passed');
    assert.equal(verified.package.archive.sha256, identity.sha256, 'Installed verifier did not check this archive');
    assert.equal(verified.currentSdk.status, 'passed');
    assert.equal(verified.currentSdk.semantic_writes, 0);
    await save(output, { ...source, ...identity, verificationSha256: hash(await readFile(verificationPath)),
      cli: verified.buildInput.cli, sdk: verified.buildInput.sdk, bundled: verified.runtime });
  } else if (command === 'presence' && rest.length === 2) {
    const [path, output] = rest, candidate = await checkedCandidate(path);
    const presence = await registryDocument(candidate.name + '/' + candidate.packageVersion);
    const channel = await registryDocument(candidate.name + '/latest');
    await save(output, { ...publicationDecision(candidate, presence, channel), presence, channel });
  } else if (command === 'verify' && rest.length === 3) {
    const [path, presencePath, output] = rest, candidate = await checkedCandidate(path);
    const { alreadyPublished } = await json(presencePath);
    assert.equal(typeof alreadyPublished, 'boolean');
    const observations = [];
    try {
      let presence;
      for (let attempt = 0; attempt < 20; attempt++) {
        presence = await registryDocument(candidate.name + '/' + candidate.packageVersion);
        observations.push(presence);
        if (presence.kind === 'present') break;
        if (attempt < 19) await new Promise(resolve => setTimeout(resolve, 5000));
      }
      assert.equal(presence?.kind, 'present', 'Registry publication remains unconfirmed');
      const channel = await registryDocument(candidate.name + '/latest');
      assert.equal(channel.kind, 'present');
      validateRegistry(candidate, presence.document, channel.document, alreadyPublished);
      const consumer = await registryConsumer(candidate, output);
      await save(output, { status: 'passed', tag: candidate.tag, brokerCommit: candidate.brokerCommit,
        cliCommit: candidate.cliCommit, integrity: candidate.integrity, registry: presence.document, channel: channel.document, consumer });
    } finally {
      await save(output + '.observations.json', observations);
    }
  } else if (command === 'github-release' && rest.length === 4) {
    const [path, verifiedPath, notes, archive] = rest;
    const candidate = await json(path), verified = await json(verifiedPath);
    assert.equal(verified.status, 'passed', 'Registry verification must complete before GitHub Release');
    for (const field of ['tag', 'brokerCommit', 'cliCommit', 'integrity']) assert.equal(verified[field], candidate[field]);
    assert.equal(process.env.RELEASE_TAG, candidate.tag);
    assert.equal(git(root, 'rev-parse', 'HEAD'), candidate.brokerCommit);
    const actual = await archiveIdentity(archive, candidate.packageVersion);
    assert.equal(actual.sha256, candidate.sha256); assert.equal(actual.integrity, candidate.integrity);
    const commands = [];
    try {
      repairGitHubRelease({ candidate, archive, notes, run: argv => {
        const result = spawnSync('gh', argv, { encoding: 'utf8', timeout: 120_000 });
        commands.push({ argv, exit: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr });
        return result;
      } });
    } finally { await save(resolve(path) + '.github-commands.json', commands); }
  } else {
    throw new Error('Usage: release-evidence.mjs source TAG new|repair CLI_ROOT OUT | candidate SOURCE ARCHIVE INSTALLED_REPORT OUT | presence CANDIDATE OUT | verify CANDIDATE PRESENCE OUT | github-release CANDIDATE VERIFIED NOTES ARCHIVE');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
}
