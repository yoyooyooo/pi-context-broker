import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readResourceProfile } from './paired-resource-profile.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'paired-resource-profile-'))), environmentRoot = join(root, 'environment');
  const source = join(root, 'source'); await mkdir(source); await mkdir(environmentRoot);
  const put = async (path, data) => { const bytes = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data) + '\n'); await writeFile(path, bytes); return { path, sha256: sha(bytes), bytes: bytes.length }; };
  const extension = await put(join(source, 'extension.mjs'), 'export default () => {};\n');
  const helper = await put(join(source, 'helper.mjs'), 'export const source = 1;\n');
  const visible = await put(join(source, 'visible.md'), '---\nname: visible\ndescription: fixture\n---\nVisible source.\n');
  const hidden = await put(join(source, 'hidden.md'), '---\nname: hidden\ndescription: fixture\ndisable-model-invocation: true\n---\nExplicit source.\n');
  const files = [extension, helper, visible, hidden].map(({ path, ...ref }) => ({ path: path.slice(source.length + 1), ...ref }));
  const closure = await put(join(root, 'closure.json'), { schema_version: 1, root: source, files, sha256: sha(JSON.stringify(files)) });
  const context = await put(join(root, 'AGENTS.md'), '# Explicit context\n');
  const origin = await put(join(root, 'ordinary-origin.json'), { scope: 'synthetic ordinary-source identity' });
  const command = await put(join(root, 'fixed-mcp-server'), 'synthetic executable identity; never executed by these tests');
  const mcp = await put(join(root, 'mcp.json'), { mcpServers: { memory: { command: command.path, args: ['mcp', 'memory'], env: { FIXTURE_ADDRESS: 'owned-fixture' } } } });
  const manifest = { schema_version: 1, kind: 'benchmark-ordinary-derived-resources', owner_root: root,
    ordinary_source_refs: [origin], extension_order: [{ role: 'frozen', ...extension, closure_ref: closure }, { role: 'selected-broker' }],
    native_skills: [{ ...visible, closure_ref: closure, visible: true }, { ...hidden, closure_ref: closure, visible: false }], context_files: [context],
    excluded_extensions: [{ path: join(source, 'automatic-write.mjs'), reason: 'Known lifecycle side effect excluded.' }],
    builtin_order: ['codemode', 'tool_search', 'mcp'], mcp_config: mcp, mcp_command_refs: [{ server: 'memory', ...command }], mcp_tools: ['mcp__memory__search'],
    settings: { enableSkillCommands: true }, shared_differences: ['CodeMode models:false; ToolSearch false; observer before other hooks.'],
    tool_policy: { allowed_tools: ['read', 'bash', 'codemode', 'mcp__memory__search', 'fetch_content'], blocked_tools: ['mcp__memory__save', 'subagent', 'tool_search'],
      blocked_parameters: [{ tool: 'fetch_content', path: ['model'], when: 'present', reason: 'Derived model is outside this episode budget.' }] } };
  const save = () => put(join(root, 'profile.json'), manifest);
  return { root, environmentRoot, source, manifest, put, save, ref: await save() };
}

test('explicit source closures, hidden native entries and context order survive an exact read without execution', async () => {
  const f = await fixture(), before = await readFile(join(f.root, 'fixed-mcp-server'));
  const result = await readResourceProfile(f.ref, f);
  assert.equal(result.manifest.native_skills.length, 2); assert.equal(result.manifest.native_skills.filter(item => item.visible).length, 1);
  assert.deepEqual(result.contextFiles, [{ path: join(f.root, 'AGENTS.md'), content: '# Explicit context\n' }]);
  assert.equal(result.evidence.closures.length, 1);
  assert.ok(result.evidence.files.some(item => item.path.endsWith('/helper.mjs')));
  assert.equal(result.mcpBytes.toString(), await readFile(f.manifest.mcp_config.path, 'utf8'));
  assert.deepEqual(await readFile(join(f.root, 'fixed-mcp-server')), before);
  assert.deepEqual((await readResourceProfile(f.ref, f)).evidence, result.evidence);
});

for (const name of ['extension.mjs', 'helper.mjs', 'visible.md']) test('a changed declared ' + name + ' is rejected before loading', async () => {
  const f = await fixture(); await writeFile(join(f.source, name), 'changed');
  await assert.rejects(readResourceProfile(f.ref, f), /RESOURCE_PROFILE_FILE_CHANGED/);
});

test('manifest ownership and exact bytes are independently required', async () => {
  const f = await fixture();
  await assert.rejects(readResourceProfile({ ...f.ref, sha256: '0'.repeat(64) }, f), /RESOURCE_PROFILE_FILE_CHANGED/);
  await assert.rejects(readResourceProfile(f.ref, { environmentRoot: '/another-owned-task/environment' }), /ENVIRONMENT_NOT_OWNED/);
  const link = join(f.root, 'alias.json'); await symlink(f.ref.path, link);
  await assert.rejects(readResourceProfile({ ...f.ref, path: link }, f), /ORDINARY_FILE_REQUIRED/);
});

for (const [label, change, reason] of [
  ['an excluded lifecycle extension', f => { f.manifest.excluded_extensions[0].path = f.manifest.extension_order[0].path; }, /EXCLUDED_EXTENSION/],
  ['a second Broker slot', f => { f.manifest.extension_order.push({ role: 'selected-broker' }); }, /ONE_SELECTED_BROKER/],
  ['an unbound stdio process', f => { f.manifest.mcp_command_refs = []; }, /UNDECLARED_STDIO/],
  ['conflicting tool authorization', f => { f.manifest.tool_policy.allowed_tools.push('subagent'); }, /TOOL_POLICY_CONFLICT/],
  ['an implicit parameter classifier', f => { f.manifest.tool_policy.blocked_parameters[0].when = 'looks-dangerous'; }, /PARAMETER_CONDITION/],
  ['a nonliteral parameter condition', f => { Object.assign(f.manifest.tool_policy.blocked_parameters[0], { when: 'not_equal', value: ['raw'] }); }, /PARAMETER_LITERAL/],
]) test(label + ' cannot enter the explicit profile', async () => {
  const f = await fixture(); change(f); await assert.rejects(readResourceProfile(await f.save(), f), reason);
});

test('a frozen closure cannot substitute a different entry or escape its declared root', async () => {
  const f = await fixture(), item = f.manifest.extension_order[0];
  const closure = JSON.parse(await readFile(item.closure_ref.path, 'utf8'));
  closure.files = closure.files.filter(file => file.path !== 'extension.mjs'); closure.sha256 = sha(JSON.stringify(closure.files));
  const ref = await f.put(item.closure_ref.path, closure);
  for (const entry of [...f.manifest.extension_order.filter(item => item.role === 'frozen'), ...f.manifest.native_skills]) entry.closure_ref = ref;
  await assert.rejects(readResourceProfile(await f.save(), f), /ENTRY_OUTSIDE_CLOSURE/);
  closure.files[0].path = '../outside.mjs'; closure.sha256 = sha(JSON.stringify(closure.files));
  const escaped = await f.put(ref.path, closure);
  for (const entry of [...f.manifest.extension_order.filter(item => item.role === 'frozen'), ...f.manifest.native_skills]) entry.closure_ref = escaped;
  await assert.rejects(readResourceProfile(await f.save(), f), /CLOSURE_MEMBER/);
});


test('private agent configuration exposes only descriptors and explicitly selected credential values to the recorder', async () => {
  const f = await fixture(), secret = 'SYNTHETIC-ONLY-CREDENTIAL-12345';
  const source = await f.put(join(f.root, 'private-web.json'), { apiKeyForFixture: secret, mode: 'read' });
  await chmod(source.path, 0o600);
  f.manifest.agent_files = [{ ...source, relative_path: 'web-search.json', credential_paths: [['apiKeyForFixture']] }];
  const resources = await readResourceProfile(await f.save(), f);
  assert.deepEqual(resources.credentials, [secret]);
  assert.equal(resources.agentFiles[0].relative_path, 'web-search.json');
  assert.doesNotMatch(JSON.stringify(resources.evidence), new RegExp(secret));
  f.manifest.agent_files[0].relative_path = 'models.json';
  await assert.rejects(readResourceProfile(await f.save(), f), /AGENT_FILE_RESERVED/);
  f.manifest.agent_files[0].relative_path = '../outside.json';
  await assert.rejects(readResourceProfile(await f.save(), f), /AGENT_FILE_PATH/);
  f.manifest.agent_files[0].relative_path = 'web-search.json'; await chmod(source.path, 0o644);
  await assert.rejects(readResourceProfile(await f.save(), f), /CREDENTIAL_FILE_PRIVATE/);
});


test('a required literal parameter rule survives exact reading and absent references are never profiles', async () => {
  const f = await fixture();
  f.manifest.tool_policy.blocked_parameters.push({ tool: 'fetch_content', path: ['mode'], when: 'not_equal', value: 'raw', reason: 'Reviewed explicit raw route.' });
  assert.equal((await readResourceProfile(await f.save(), f)).manifest.tool_policy.blocked_parameters.at(-1).value, 'raw');
  for (const ref of [null, false, '']) await assert.rejects(readResourceProfile(ref, f), /RESOURCE_PROFILE_REFERENCE_REQUIRED/);
});
