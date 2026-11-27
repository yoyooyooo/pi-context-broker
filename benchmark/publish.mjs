import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, fingerprint } from './protocol.mjs';
import { scoreExperiment } from './analysis/compare.mjs';
import { renderAnalysisMarkdown, renderMetricSvg, reportTables, toCsv } from './analysis/report.mjs';
import { verifyArtifactFiles, verifyBundle } from './evidence/store.mjs';
import { OFFLINE_REPORT_SOURCE_FILES } from './offline-source-files.mjs';

export const PUBLICATION_VERSION = '1.0.7';
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const within = (root, path) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
const uuidPattern = /\b(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{32})\b/gi;
const machinePathPattern = /\/(?:Users|home|workspace|tmp|private\/(?:tmp|var)|var\/(?:folders|tmp)|Volumes|mnt)\/[^\s"'<>]+|(?<![A-Za-z0-9])[A-Za-z]:\\[^\s"'<>]+/g;
const credentialPattern = /\b(?:Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*|\b(?:sk-(?:proj-|svcacct-)?|ntn_|secret_|gh[pousr]_)[A-Za-z0-9_-]{16,}/g;
const secretKey = /^(?:authorization|proxy[-_]?authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|encrypted[-_]?content|encrypted[-_]?reasoning|api[-_]?token|notion[-_]?token|token[-_]?v[0-9]+|private[-_]?key|secret[-_]?key|client[-_]?secret|password|passwd|cookie|set[-_]?cookie|secret|token|credentials?)$/i;
const bindingKey = /^(?:bound_name|bound_skill_id|bound_owner|bound_page_id|bound_path)$/;
const terminalOwnerPattern = /^([bcdlps-][rwxStTs-]{9}[+@.]?[ \t]+\d+[ \t]+)([^\s]+)(?=[ \t]+[^\s]+[ \t]+(?:\d+|\d+,[ \t]*\d+)[ \t]+)/gm;
// Streaming tool arguments may end partway through a home directory name.
// A following separator proves that the observed username component is complete.
const homeUsernamePattern = /\/(?:Users|home)\/([^/\s"'<>\\]+)(?=\/)|(?<![\p{L}\p{N}_])[A-Za-z]:[\\/]Users[\\/]([^\\/\s"'<>]+)(?=[\\/])/gu;
const declaredHomeRootPattern = /^(?:\/(?:Users|home)\/([^/\s"'<>\\]+)|[A-Za-z]:[\\/]Users[\\/]([^\\/\s"'<>]+))$/u;
const usernamePattern = /^[\p{L}_][\p{L}\p{N}_.-]*\$?$/u;
const projectedUsername = /^\[username:[a-f0-9]{20}\]$/;
const escapeRegex = value => value.replace(/[.*+?^{}$()|[\]\\]/g, '\\$&');
const wholeIdentifierPattern = value => new RegExp('(?<![\\p{L}\\p{N}_-])' + escapeRegex(value) + '(?![\\p{L}\\p{N}_-])', 'gu');
const asList = value => value === undefined ? [] : (assert.ok(Array.isArray(value) && value.every(x => typeof x === 'string' && x.length), 'Redaction lists contain nonempty strings'), value);
const unique = values => [...new Set(values)];
const alias = (kind, value) => '[' + kind + ':' + hash(kind + '\0' + value).slice(0, 20) + ']';
function reviewedBinaryMap(entries) {
  assert.ok(Array.isArray(entries), 'Reviewed binary artifacts must be an explicit allowlist');
  const approved = new Map();
  for (const entry of entries) {
    assert.ok(object(entry));
    assert.deepEqual(Object.keys(entry).sort(), ['bytes', 'kind', 'purpose', 'sha256']);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes > 0);
    assert.equal(entry.kind, 'source-bytes', 'Only reviewed synthetic source bytes may bypass text redaction');
    assert.equal(entry.purpose, 'public-synthetic-fixture');
    assert.ok(!approved.has(entry.sha256), 'Duplicate reviewed binary identity');
    approved.set(entry.sha256, { ...entry });
  }
  return approved;
}
function approveBinary(bytes, artifact, approved) {
  const entry = approved.get(artifact.sha256);
  assert.ok(entry, 'Opaque binary evidence needs an explicit reviewed publication policy: ' + artifact.id);
  assert.equal(hash(bytes), entry.sha256, 'Reviewed binary hash mismatch');
  assert.equal(bytes.length, entry.bytes, 'Reviewed binary byte count mismatch');
  assert.equal(artifact.kind, entry.kind, 'Reviewed binary artifact kind mismatch');
  return entry;
}
function parseRaw(bytes, artifact, approved) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return { format: 'binary', value: bytes, approval: approveBinary(bytes, artifact, approved) }; }
  if (artifact.kind === 'jsonl' || /\.jsonl$/i.test(artifact.path)) {
    assert.ok(text.endsWith('\n'), 'Cannot publish truncated JSONL');
    const lines = text.split('\n'); lines.pop();
    return { format: 'jsonl', value: lines.map(line => line === '' ? null : JSON.parse(line)), blank: lines.map(line => line === '') };
  }
  try { return { format: 'json', value: JSON.parse(text) }; }
  catch { return { format: 'text', value: text }; }
}

/** Deterministic pseudonyms, never a claim of irreversible anonymization. */
export function createPublicSanitizer({ redactions = {}, material = [] } = {}) {
  const secrets = unique(asList(redactions.secrets));
  const prefixes = unique(asList(redactions.path_prefixes)).sort((a, b) => b.length - a.length);
  const identifiers = new Set(asList(redactions.identifiers));
  const identifierWords = new Set(asList(redactions.identifier_words));
  const terminalUsernames = new Set(asList(redactions.terminal_usernames));
  function discover(value) {
    if (typeof value === 'string') {
      for (const match of value.matchAll(homeUsernamePattern)) {
        const username = match[1] ?? match[2];
        if (usernamePattern.test(username)) terminalUsernames.add(username);
      }
      for (const match of value.matchAll(terminalOwnerPattern))
        if (usernamePattern.test(match[2])) terminalUsernames.add(match[2]);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (value.observed_provider === '[REDACTED_CREDENTIAL]' && typeof value.value === 'string') identifiers.add(value.value);
    for (const [key, child] of Object.entries(value)) {
      if (bindingKey.test(key) && typeof child === 'string' && child.length) identifiers.add(child);
      discover(child);
    }
  }
  for (const prefix of prefixes) {
    discover(prefix);
    // Explicit roots are declarations, unlike potentially unfinished raw text.
    const match = prefix.match(declaredHomeRootPattern), username = match?.[1] ?? match?.[2];
    if (username && usernamePattern.test(username)) terminalUsernames.add(username);
  }
  for (const value of material) discover(value);
  const replacements = [...identifiers].sort((a, b) => b.length - a.length).map(value => [value, alias('identity', value)]);
  const wordReplacements = [
    ...[...terminalUsernames].map(value => [value, alias('username', value), 'terminal_usernames']),
    ...[...identifierWords].filter(value => !terminalUsernames.has(value)).map(value => [value, alias('identifier-word', value), 'identifier_words']),
  ].sort((a, b) => b[0].length - a[0].length);
  const counts = { credential_values: 0, explicit_identifiers: 0, identifier_words: 0, terminal_usernames: 0,
    machine_paths: 0, uuid_identifiers: 0, private_endpoints: 0 };
  function replace(text, from, to, category) {
    if (!from || !text.includes(from)) return text;
    counts[category] += text.split(from).length - 1;
    return text.split(from).join(to);
  }
  function text(value, { nested = true, filesystem = true } = {}) {
    let result = value.replace(terminalOwnerPattern, (match, prefix, owner) => {
      if (projectedUsername.test(owner)) return match;
      counts.terminal_usernames++; return prefix + alias('username', owner);
    });
    for (const [from, to, category] of wordReplacements)
      for (const form of unique([from, encodeURIComponent(from)]))
        result = result.replace(wholeIdentifierPattern(form), () => { counts[category]++; return to; });
    for (const secret of secrets) for (const form of unique([secret, encodeURIComponent(secret)]))
      result = replace(result, form, '[REDACTED]', 'credential_values');
    for (const [from, to] of replacements) for (const form of unique([from, encodeURIComponent(from)]))
      result = replace(result, form, to, 'explicit_identifiers');
    for (const prefix of prefixes) for (const form of unique([prefix, encodeURIComponent(prefix)]))
      result = replace(result, form, '[PRIVATE_ROOT]', 'machine_paths');
    result = result.replace(credentialPattern, () => { counts.credential_values++; return '[REDACTED]'; });
    result = result.replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|PASSWORD|SECRET))=(?:"[^"]*"|'[^']*'|[^\s"'<>]+)/g,
      (_, key) => { counts.credential_values++; return key + '=[REDACTED]'; });
    result = result.replace(uuidPattern, value => { counts.uuid_identifiers++; return alias('id', value.toLowerCase().replaceAll('-', '')); });
    result = result.replace(/\bagent-workflow-bm-notion-[a-z0-9-]+\b/gi, value => { counts.explicit_identifiers++; return alias('notion', value); });
    result = result.replace(/https?:\/\/[^\s"'<>\\]+/g, value => {
      try {
        const url = new URL(value);
        let changed = false;
        if (url.username || url.password) { url.username = ''; url.password = ''; changed = true; counts.credential_values++; }
        for (const key of [...url.searchParams.keys()]) if (secretKey.test(key) || /^(?:signature|sig|key|auth|code)$/i.test(key)) {
          url.searchParams.set(key, '[REDACTED]'); counts.credential_values++; changed = true;
        }
        if (url.hostname === 'localhost' || url.hostname.endsWith('.local') || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.startsWith('[')) {
          url.hostname = 'endpoint-' + hash(url.hostname + ':' + url.port).slice(0, 16) + '.invalid';
          url.port = ''; counts.private_endpoints++; changed = true;
        }
        return changed ? url.toString() : value;
      } catch { return value; }
    });
    result = result.replace(machinePathPattern, value => { counts.machine_paths++; return alias('path', value); });
    if (filesystem && (/^\/(?!\/)/.test(result) || /^[A-Za-z]:[\\/]/.test(result))) {
      counts.machine_paths++; result = alias('path', result);
    }
    if (nested && /^[\s]*[\[{]/.test(result)) {
      try {
        const decoded = JSON.parse(result);
        if (object(decoded) || Array.isArray(decoded)) {
          const projected = walk(decoded);
          if (canonicalJson(projected) !== canonicalJson(decoded)) result = canonicalJson(projected);
        }
      } catch { /* Plain text with a leading bracket remains text. */ }
    }
    return result;
  }
  function conceal(value) {
    if (Array.isArray(value)) return value.map(conceal);
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [text(key), conceal(child)]));
    if (value === null || typeof value === 'boolean') return value;
    counts.credential_values++; return '[REDACTED]';
  }
  function pointer(value) {
    if (value === '') return '';
    assert.ok(value.startsWith('/'), 'Evidence pointer must be absolute');
    return '/' + value.slice(1).split('/').map(segment => {
      const decoded = segment.replaceAll('~1', '/').replaceAll('~0', '~');
      return text(decoded).replaceAll('~', '~0').replaceAll('/', '~1');
    }).join('/');
  }
  function requestUrlPath(value) {
    if (!/^\/(?!\/)/.test(value)) return text(value);
    // An observed HTTP path is not a filesystem path. Reuse URL sanitization
    // so query credentials and private identifiers are still projected.
    const origin = 'https://request-path.invalid';
    const projected = text(origin + value, { nested: false, filesystem: false });
    assert.ok(projected.startsWith(origin), 'Public HTTP path projection changed its placeholder origin');
    return projected.slice(origin.length);
  }
  function walk(value, parentKey = '', httpAttemptData = false) {
    if (typeof value === 'string') {
      const modelField = parentKey === 'field' && ['/data/event/model', '/data/event/response/model'].includes(value);
      return parentKey === 'pointer' || modelField ? pointer(value) : text(value);
    }
    if (Array.isArray(value)) return value.map(child => walk(child));
    if (!object(value)) return value;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      const projected = text(key);
      assert.ok(!Object.hasOwn(output, projected), 'Public redaction would merge distinct object keys');
      output[projected] = secretKey.test(key) ? conceal(child)
        : httpAttemptData && key === 'url_path' && typeof child === 'string' ? requestUrlPath(child)
        : walk(child, key, value.type === 'http_attempt_start' && key === 'data');
    }
    return output;
  }
  function assertClean(value) {
    const bytes = typeof value === 'string' ? value : value.toString('utf8');
    for (const [values, message] of [[secrets, 'Explicit secret'], [[...identifiers], 'Private identifier'], [prefixes, 'Private path prefix']])
      for (const item of values) for (const form of unique([item, encodeURIComponent(item), JSON.stringify(item).slice(1, -1)]))
        assert.ok(!bytes.includes(form), message + ' remained in a public artifact');
    assert.equal([...bytes.matchAll(credentialPattern)].length, 0, 'A credential pattern remained in a public artifact');
    // Inspect decoded JSON strings, so a serialized heading plus newline is
    // not mistaken for a Windows drive followed by a backslash.
    const scalars = [];
    const collect = item => {
      if (typeof item === 'string') scalars.push(item);
      else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) { scalars.push(key); collect(child); }
    };
    try { collect(JSON.parse(bytes)); }
    catch {
      try { for (const line of bytes.trimEnd().split('\n')) collect(JSON.parse(line)); }
      catch { scalars.length = 0; scalars.push(bytes); }
    }
    for (const value of scalars) {
      for (const [word] of wordReplacements)
        for (const form of unique([word, encodeURIComponent(word)]))
          assert.equal([...value.matchAll(wholeIdentifierPattern(form))].length, 0, 'A private identifier word remained in a public artifact');
      for (const match of value.matchAll(terminalOwnerPattern))
        assert.ok(projectedUsername.test(match[2]), 'A terminal owner remained in a public artifact');
    }
    assert.equal(scalars.reduce((count, value) => count + [...value.matchAll(machinePathPattern)].length, 0), 0,
      'A machine path remained in a public artifact');
    assert.equal([...bytes.matchAll(uuidPattern)].length, 0, 'An original UUID remained in a public artifact');
  }
  return { walk, text, pointer, assertClean, counts,
    policy: { version: PUBLICATION_VERSION, credentials: 'values removed; original secret mappings are never written',
      identities: 'deterministic pseudonyms; not an irreversible-anonymization claim', paths: 'machine paths and caller-supplied roots replaced',
      http_request_paths: 'Observed HTTP URL paths retain route structure; URL credentials and private identifiers remain redacted',
      identifier_words: 'Whole-token replacement bounded by Unicode letters, digits, underscore and hyphen; longer public identifiers remain intact',
      terminal_usernames: 'POSIX long-listing owner fields; whole-token usernames from separator-terminated home components, listings, explicitly declared home roots, or explicit username input',
      explicit_secret_count: secrets.length, explicit_identifier_count: identifiers.size, explicit_path_prefix_count: prefixes.length,
      identifier_word_count: identifierWords.size, terminal_username_count: terminalUsernames.size } };
}
function privateGradingMaterial(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value.contracts) && value.contracts.some(contract =>
    contract?.kind === 'artifact-json' && Object.hasOwn(contract, 'expected')
    || contract?.kind === 'final-answer' && ['all', 'any', 'none'].some(key => Object.hasOwn(contract, key)))) return true;
  if (Array.isArray(value.canaries) || object(value.oracles)) return true;
  return Object.values(value).some(privateGradingMaterial);
}
function encodeRaw(parsed, sanitize) {
  if (parsed.format === 'binary') return Buffer.from(parsed.value);
  if (parsed.format === 'json') return Buffer.from(canonicalJson(sanitize.walk(parsed.value)) + '\n');
  if (parsed.format === 'jsonl') return Buffer.from(parsed.value.map((value, index) => parsed.blank[index] ? '' : canonicalJson(sanitize.walk(value))).join('\n') + '\n');
  return Buffer.from(sanitize.text(parsed.value, { filesystem: false }));
}
function analysisMeaning(value) {
  if (Array.isArray(value)) return value.map(analysisMeaning);
  if (!object(value)) return value;
  const ignore = new Set(['analysis_sha256', 'protocol_sha256', 'plan_sha256', 'episode_refs', 'refs']);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !ignore.has(key)).map(([key, child]) => [key, analysisMeaning(child)]));
}
async function writeOnce(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assert.ok((await readFile(path)).equals(Buffer.from(bytes)), 'Refusing to overwrite a different public package member');
  }
}
function memberPath(directory, name) {
  assert.ok(typeof name === 'string' && name && !isAbsolute(name));
  const path = resolve(directory, name);
  assert.ok(within(directory, path) && path !== directory, 'Package member escapes its directory');
  return path;
}
// Also embedded in the dependency-free public replay below.
function verifyBinaryPublication(manifest, episodes) {
  const approved = manifest.policy.reviewed_binary_artifacts ?? [];
  assert.ok(Array.isArray(approved));
  const bySha = new Map(approved.map(entry => [entry.sha256, entry]));
  assert.equal(bySha.size, approved.length, 'Duplicate public binary approval');
  const rows = manifest.raw_mapping.filter(row => row.format === 'binary');
  assert.equal(rows.length, approved.length, 'Public binary approvals differ from the released files');
  for (const row of rows) {
    const entry = bySha.get(row.source_sha256); assert.ok(entry, 'Public binary approval missing');
    assert.equal(entry.kind, 'source-bytes'); assert.equal(entry.purpose, 'public-synthetic-fixture');
    assert.equal(entry.bytes, row.source_bytes); assert.equal(row.source_bytes, row.public_bytes);
    assert.equal(row.source_sha256, row.public_sha256); assert.equal(row.changed, false);
  }
  for (const episode of episodes) for (const artifact of episode.artifacts) {
    const entry = bySha.get(artifact.sha256);
    if (entry) assert.equal(artifact.kind, entry.kind, 'Public binary artifact kind mismatch');
  }
}
const replaySource = [
"import assert from 'node:assert/strict';",
"import {readFile} from 'node:fs/promises';",
"import {createHash} from 'node:crypto';",
"import {dirname,join,resolve,isAbsolute,relative,sep} from 'node:path';",
"import {fileURLToPath} from 'node:url';",
"import {fingerprint} from './offline/benchmark/protocol.mjs';",
"import {scoreExperiment} from './offline/benchmark/analysis/compare.mjs';",
"import {writeAnalysisReport} from './offline/benchmark/analysis/report.mjs';",
"import {verifyBundle} from './offline/benchmark/evidence/store.mjs';",
"const root=dirname(fileURLToPath(import.meta.url)),hash=bytes=>createHash('sha256').update(bytes).digest('hex');",
verifyBinaryPublication.toString(),
"const manifest=JSON.parse(await readFile(join(root,'public-manifest.json'),'utf8'));",
"assert.equal(manifest.kind,'benchmark-public-evidence-package');",
"assert.equal(manifest.manifest_sha256,fingerprint({...manifest,manifest_sha256:null}));",
"assert.equal(manifest.raw_mapping_sha256,fingerprint(manifest.raw_mapping));",
"for(const file of manifest.files){",
" assert.ok(!isAbsolute(file.path));",
" const path=resolve(root,file.path),part=relative(root,path);",
" assert.ok(part && part!=='..' && !part.startsWith('..'+sep) && !isAbsolute(part));",
" const bytes=await readFile(path);assert.equal(hash(bytes),file.sha256);assert.equal(bytes.length,file.bytes);",
"}",
"const input=JSON.parse(await readFile(join(root,'analysis-input.json'),'utf8'));",
"verifyBinaryPublication(manifest,input.episodes);",
"const pathsBySha256=Object.fromEntries(manifest.raw_mapping.map(item=>[item.public_sha256,join(root,item.public_path)]));",
"const publicProjection={raw_mapping_sha256:manifest.raw_mapping_sha256,raw_mapping:manifest.raw_mapping};",
"for(const episode of input.episodes)await verifyBundle({episode},{root,pathsBySha256,publicProjection});",
"const analysis=scoreExperiment(input);assert.equal(analysis.analysis_sha256,manifest.public_analysis_sha256);",
"const flag=process.argv.indexOf('--out');",
"if(flag>=0){assert.ok(process.argv[flag+1] && isAbsolute(process.argv[flag+1]));await writeAnalysisReport({directory:resolve(process.argv[flag+1]),analysis});}",
"process.stdout.write(JSON.stringify({status:'verified',scope:manifest.replay_scope,analysis_sha256:analysis.analysis_sha256,original_analysis_sha256:manifest.source_analysis_sha256,model_requests:0})+'\\n');",
].join('\n') + '\n';

/** Export derived public copies. Original files and private grading inputs remain untouched.
 * reviewedBinaryArtifacts is opt-in: [{sha256, bytes, kind: 'source-bytes', purpose: 'public-synthetic-fixture'}].
 * Each entry approves reviewed public fixture content, never an arbitrary binary log or output. */
export async function writePublicEvidencePackage({ directory, input, analysis, rawRoot, redactions = {}, reviewedBinaryArtifacts = [] }) {
  assert.ok(isAbsolute(directory) && isAbsolute(rawRoot));
  const approvedBinary = reviewedBinaryMap(reviewedBinaryArtifacts);
  const original = scoreExperiment(input);
  if (analysis) assert.equal(analysis.analysis_sha256, original.analysis_sha256, 'Supplied analysis does not match its inputs');
  const owned = await realpath(rawRoot), sources = new Map();
  for (const episode of input.episodes) {
    await verifyBundle({ episode }, { root: owned });
    for (const { artifact, bytes } of (await verifyArtifactFiles(episode.artifacts, { root: owned })).values()) {
      assert.ok(!/(?:private[-_]?oracle|oracle[-_]?private)/i.test(artifact.kind ?? ''), 'Private oracle artifacts are not public evidence');
      if (!sources.has(artifact.sha256)) {
        const parsed = parseRaw(bytes, artifact, approvedBinary);
        assert.ok(['text', 'binary'].includes(parsed.format) || !privateGradingMaterial(parsed.value), 'Private oracle or control material cannot be published');
        sources.set(artifact.sha256, { artifact, bytes, parsed });
      } else if (sources.get(artifact.sha256).parsed.format === 'binary') approveBinary(bytes, artifact, approvedBinary);
    }
  }
  const sanitize = createPublicSanitizer({ redactions: { ...redactions, path_prefixes: unique([owned, ...asList(redactions.path_prefixes)]) },
    material: [input, ...[...sources.values()].filter(source => source.parsed.format !== 'binary').map(source => source.parsed.value)] });
  const files = new Map(), rawMapping = [], mapping = new Map(), binaryPaths = new Set(), binaryApprovals = [];
  for (const [sourceSha, source] of sources) {
    const bytes = encodeRaw(source.parsed, sanitize), publicSha = hash(bytes), path = 'raw/' + publicSha;
    if (source.parsed.format === 'binary') { binaryPaths.add(path); binaryApprovals.push(source.parsed.approval); }
    else try { sanitize.assertClean(bytes); } catch (error) { throw new Error(error.message + '; artifact=' + source.artifact.id + '; format=' + source.parsed.format); }
    files.set(path, bytes);
    const row = { source_sha256: sourceSha, public_sha256: publicSha, source_bytes: source.bytes.length, public_bytes: bytes.length,
      public_path: path, format: source.parsed.format, changed: !bytes.equals(source.bytes),
      line_locators: source.parsed.format === 'jsonl' ? 'preserved one-to-one' : 'not a JSONL artifact',
      inner_hash_claims: 'historical original claims; transformed bytes are identified by public_sha256' };
    rawMapping.push(row); mapping.set(sourceSha, row);
  }
  rawMapping.sort((a, b) => a.source_sha256.localeCompare(b.source_sha256));
  const mappingSha = fingerprint(rawMapping), protocol = sanitize.walk(input.protocol);
  protocol.protocol_sha256 = null; protocol.protocol_sha256 = fingerprint(protocol);
  const episodes = [];
  for (const episode of input.episodes) {
    const publicIds = new Map(episode.artifacts.map(artifact => [sanitize.text(artifact.id), artifact]));
    assert.equal(publicIds.size, episode.artifacts.length, 'Redaction merged artifact identities');
    const projected = sanitize.walk(episode);
    function rebind(value) {
      if (!value || typeof value !== 'object') return;
      if (typeof value.artifact_id === 'string' && typeof value.sha256 === 'string' && ('line' in value || 'pointer' in value)) {
        const artifact = publicIds.get(value.artifact_id), row = artifact && mapping.get(artifact.sha256);
        assert.ok(row && artifact.sha256 === value.sha256, 'A public reference lacks its retained original');
        value.sha256 = row.public_sha256; return;
      }
      for (const child of Object.values(value)) rebind(child);
    }
    rebind(projected);
    projected.artifacts = episode.artifacts.map(artifact => {
      const row = mapping.get(artifact.sha256);
      return { ...sanitize.walk(artifact), path: row.public_path, sha256: row.public_sha256, bytes: row.public_bytes,
        publication: { source_sha256: artifact.sha256, source_bytes: artifact.bytes ?? null, transformed: row.changed } };
    });
    projected.identity = { ...projected.identity, public_projection: { version: PUBLICATION_VERSION,
      source_episode_sha256: episode.episode_sha256, source_protocol_sha256: input.protocol.protocol_sha256,
      raw_mapping_sha256: mappingSha, role: 'derived privacy projection; not another execution or fresh grading' } };
    projected.episode_sha256 = null; projected.episode_sha256 = fingerprint(projected); episodes.push(projected);
  }
  const publicInput = { ...sanitize.walk(input), protocol, episodes };
  if (publicInput.plan) publicInput.plan.protocol_sha256 = protocol.protocol_sha256;
  const publicAnalysis = scoreExperiment(publicInput);
  assert.equal(canonicalJson(analysisMeaning(publicAnalysis)), canonicalJson(analysisMeaning(sanitize.walk(original))),
    'Publication changed a metric, denominator, outcome, interval, or decision');
  const meaningSha = fingerprint(analysisMeaning(publicAnalysis));
  files.set('analysis-input.json', Buffer.from(canonicalJson(publicInput) + '\n'));
  files.set('analysis.json', Buffer.from(canonicalJson(publicAnalysis) + '\n'));
  const explanation = [
    '# Public Benchmark evidence package', '',
    'This package contains transformed copies of retained evidence. Whenever redaction changed a file, its original bytes are not included.',
    'The manifest maps each verified original SHA256 to the public copy SHA256 and records both byte counts. JSONL line numbers and JSON pointer locations remain usable after deterministic key pseudonymization.',
    'Inner original body hashes, HTTP entity hashes and hash-chain entries are historical claims. Redaction changes those bytes; this package does not claim that original chains can be recomputed from transformed copies.',
    'Reported model labels, request/attempt references and provider configuration bindings are checked against transformed raw evidence. Explicit original-to-public mapping is required for this verification; private execution never accepts the public projection as original evidence. Original private endpoint/path hashes remain historical claims after redaction.',
    'Offline replay verifies public file hashes and source locators, then recomputes statistics from retained normalized observations. It does not rerun private business grading, recover secrets, call a provider, or create new executions.',
    'Counts, outcomes, unknown values, fixed denominators, intervals and decisions were compared with the original analysis before export and must be identical after identifier projection.',
    'Private oracles are not included. Credential and private identifier mappings are never written. Deterministic pseudonyms are not a guarantee of irreversible anonymization.',
    'Non-UTF-8 bytes are refused unless an explicit reviewed synthetic-fixture allowlist binds their SHA256, byte count, artifact kind and public purpose. Approved binary material is copied byte for byte; its approval is recorded in the manifest. Text and structured evidence still pass through redaction.',
    '', '## Replay', '', 'Run node replay.mjs to verify the package and recompute its analysis.',
    'Run node replay.mjs --out /absolute/new-report-directory to write a fresh report. Node with JSON import-attribute support is required; no package installation or credentials are needed.',
    '', '## Identity', '', '- Original analysis: ' + original.analysis_sha256,
    '- Public analysis: ' + publicAnalysis.analysis_sha256, '- Unchanged analysis meaning: ' + meaningSha, '',
  ].join('\n');
  files.set('README.md', Buffer.from(explanation));
  files.set('report.md', Buffer.from(renderAnalysisMarkdown(publicAnalysis).replace('## Reproduce offline', '## Reproduce offline\n\nSee README.md for the public transformation boundary and original-to-public hash mapping.')));
  for (const [name, rows] of Object.entries(reportTables(publicAnalysis))) files.set(name + '.csv', Buffer.from(toCsv(rows, rows.length ? Object.keys(rows[0]) : ['status'])));
  for (const [name, metric, title] of [['quality', 'verified_quality', 'Verified business quality'], ['input', 'input_total', 'Cumulative input'], ['time', 'capped_time', 'Capped time']])
    files.set(name + '.svg', Buffer.from(renderMetricSvg(publicAnalysis, { metric, title })));
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  for (const name of OFFLINE_REPORT_SOURCE_FILES) files.set('offline/' + name, await readFile(join(repository, name)));
  files.set('replay.mjs', Buffer.from(replaySource));
  const sourceBytes = await readFile(fileURLToPath(import.meta.url));
  files.set('sanitizer-source.mjs', sourceBytes);
  for (const [name, bytes] of files) if (!binaryPaths.has(name)) sanitize.assertClean(bytes);
  const manifest = { schema_version: 1, kind: 'benchmark-public-evidence-package', publication_version: PUBLICATION_VERSION,
    sanitizer_source_sha256: hash(sourceBytes), source_analysis_sha256: original.analysis_sha256,
    source_protocol_sha256: input.protocol.protocol_sha256, public_analysis_sha256: publicAnalysis.analysis_sha256,
    public_protocol_sha256: protocol.protocol_sha256, unchanged_analysis_meaning_sha256: meaningSha,
    source_episode_sha256: input.episodes.map(episode => episode.episode_sha256),
    public_episode_sha256: episodes.map(episode => episode.episode_sha256),
    raw_mapping_sha256: mappingSha, raw_mapping: rawMapping,
    replay_scope: 'public hashes and source locators; normalized-observation statistical reaggregation only; no raw-chain or private-grader rerun',
    policy: { ...sanitize.policy, reviewed_binary_artifacts: binaryApprovals.sort((a, b) => a.sha256.localeCompare(b.sha256)) },
    transformation_counts: { ...sanitize.counts },
    files: [...files].map(([path, bytes]) => ({ path, sha256: hash(bytes), bytes: bytes.length })).sort((a, b) => a.path.localeCompare(b.path)),
    manifest_sha256: null };
  manifest.manifest_sha256 = fingerprint(manifest);
  sanitize.assertClean(canonicalJson(manifest));
  await mkdir(directory, { recursive: true });
  const destination = await realpath(directory);
  for (const { artifact } of sources.values()) assert.ok(!within(destination, await realpath(artifact.path)), 'Public destination must not contain original raw evidence');
  for (const [name, bytes] of files) await writeOnce(memberPath(destination, name), bytes);
  await writeOnce(join(destination, 'public-manifest.json'), canonicalJson(manifest) + '\n');
  const verified = await verifyPublicEvidencePackage({ directory: destination });
  return { directory: destination, manifest_path: join(destination, 'public-manifest.json'), manifest_sha256: manifest.manifest_sha256,
    analysis: publicAnalysis, input: publicInput, manifest, verified, model_requests: 0 };
}

export async function verifyPublicEvidencePackage({ directory }) {
  const root = await realpath(directory);
  const manifest = JSON.parse(await readFile(join(root, 'public-manifest.json'), 'utf8'));
  assert.equal(manifest.kind, 'benchmark-public-evidence-package');
  assert.equal(manifest.manifest_sha256, fingerprint({ ...manifest, manifest_sha256: null }));
  assert.equal(manifest.raw_mapping_sha256, fingerprint(manifest.raw_mapping));
  const paths = new Set();
  for (const item of manifest.files) {
    assert.ok(!paths.has(item.path), 'Duplicate public package member'); paths.add(item.path);
    const path = memberPath(root, item.path), actual = await realpath(path);
    assert.ok(within(root, actual), 'Public package member symlink escapes its directory');
    const bytes = await readFile(actual); assert.equal(hash(bytes), item.sha256); assert.equal(bytes.length, item.bytes);
  }
  const input = JSON.parse(await readFile(join(root, 'analysis-input.json'), 'utf8'));
  verifyBinaryPublication(manifest, input.episodes);
  const pathsBySha256 = Object.fromEntries(manifest.raw_mapping.map(item => [item.public_sha256, memberPath(root, item.public_path)]));
  const publicProjection = { raw_mapping_sha256: manifest.raw_mapping_sha256, raw_mapping: manifest.raw_mapping };
  for (const episode of input.episodes) await verifyBundle({ episode }, { root, pathsBySha256, publicProjection });
  const analysis = scoreExperiment(input);
  assert.equal(analysis.analysis_sha256, manifest.public_analysis_sha256);
  assert.equal(fingerprint(analysisMeaning(analysis)), manifest.unchanged_analysis_meaning_sha256);
  return { valid: true, files: manifest.files.length, episodes: input.episodes.length, model_requests: 0,
    public_analysis_sha256: analysis.analysis_sha256, source_analysis_sha256: manifest.source_analysis_sha256 };
}
