import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, path) => path === root || path.startsWith(root + sep);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hashPattern = /^[a-f0-9]{64}$/;
const absolute = path => assert.ok(typeof path === 'string' && isAbsolute(path) && resolve(path) === path, 'RESOURCE_PROFILE_CANONICAL_PATH');

export function validateResourceProfileRef(ref) {
  assert.ok(object(ref), 'RESOURCE_PROFILE_REFERENCE_REQUIRED'); absolute(ref.path);
  assert.ok(hashPattern.test(ref.sha256 ?? ''), 'RESOURCE_PROFILE_SHA256_REQUIRED');
  if (ref.bytes !== undefined) assert.ok(Number.isSafeInteger(ref.bytes) && ref.bytes >= 0, 'RESOURCE_PROFILE_BYTE_COUNT');
  return ref;
}

async function verifiedFile(ref) {
  validateResourceProfileRef(ref);
  const before = await lstat(ref.path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.size <= 128 * 1024 * 1024, 'RESOURCE_PROFILE_ORDINARY_FILE_REQUIRED');
  assert.equal(await realpath(ref.path), ref.path, 'RESOURCE_PROFILE_SOURCE_ALIAS');
  const bytes = await readFile(ref.path), after = await lstat(ref.path);
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[key], 'RESOURCE_PROFILE_CHANGED_WHILE_READING');
  assert.equal(sha(bytes), ref.sha256, 'RESOURCE_PROFILE_FILE_CHANGED: ' + ref.path);
  if (ref.bytes !== undefined) assert.equal(bytes.length, ref.bytes, 'RESOURCE_PROFILE_FILE_SIZE_CHANGED');
  return bytes;
}

export function validateProfileToolPolicy(policy) {
  assert.ok(object(policy), 'RESOURCE_PROFILE_TOOL_POLICY_REQUIRED');
  for (const key of ['allowed_tools', 'blocked_tools']) {
    assert.ok(Array.isArray(policy[key]) && policy[key].every(name => typeof name === 'string' && name.length > 0), 'RESOURCE_PROFILE_TOOL_NAMES_REQUIRED');
    assert.equal(new Set(policy[key]).size, policy[key].length, 'RESOURCE_PROFILE_DUPLICATE_TOOL');
  }
  assert.ok(policy.allowed_tools.every(name => !policy.blocked_tools.includes(name)), 'RESOURCE_PROFILE_TOOL_POLICY_CONFLICT');
  assert.ok(Array.isArray(policy.blocked_parameters), 'RESOURCE_PROFILE_PARAMETER_RULES_REQUIRED');
  for (const rule of policy.blocked_parameters) {
    assert.ok(object(rule) && policy.allowed_tools.includes(rule.tool), 'RESOURCE_PROFILE_PARAMETER_TOOL');
    assert.ok(Array.isArray(rule.path) && rule.path.length > 0 && rule.path.every(key => typeof key === 'string' && key && !['__proto__', 'prototype', 'constructor'].includes(key)), 'RESOURCE_PROFILE_PARAMETER_PATH');
    assert.ok(['present', 'truthy', 'not_equal'].includes(rule.when), 'RESOURCE_PROFILE_PARAMETER_CONDITION');
    if (rule.when === 'not_equal') assert.ok(typeof rule.value === 'string' && rule.value.length > 0, 'RESOURCE_PROFILE_PARAMETER_LITERAL');
    assert.ok(typeof rule.reason === 'string' && rule.reason.length > 0, 'RESOURCE_PROFILE_PARAMETER_REASON');
  }
  return policy;
}

/** Read exact, reviewed inputs. No ambient discovery, package installation or source rewriting. */
export async function readResourceProfile(ref, { environmentRoot } = {}) {
  const bytes = await verifiedFile(ref), manifest = JSON.parse(bytes);
  assert.equal(manifest.schema_version, 1, 'RESOURCE_PROFILE_SCHEMA');
  assert.equal(manifest.kind, 'benchmark-ordinary-derived-resources', 'RESOURCE_PROFILE_KIND');
  absolute(manifest.owner_root);
  assert.equal(await realpath(manifest.owner_root), manifest.owner_root, 'RESOURCE_PROFILE_OWNER_ALIAS');
  assert.ok(manifest.owner_root !== dirname(manifest.owner_root) && manifest.owner_root !== homedir(), 'RESOURCE_PROFILE_TASK_OWNER_REQUIRED');
  assert.ok(inside(manifest.owner_root, ref.path) && ref.path !== manifest.owner_root, 'RESOURCE_PROFILE_MANIFEST_NOT_OWNED');
  if (environmentRoot !== undefined) {
    absolute(environmentRoot);
    assert.ok(inside(manifest.owner_root, environmentRoot), 'RESOURCE_PROFILE_ENVIRONMENT_NOT_OWNED');
    assert.equal(await realpath(environmentRoot), environmentRoot, 'RESOURCE_PROFILE_ENVIRONMENT_ALIAS');
    assert.ok((await lstat(environmentRoot)).isDirectory(), 'RESOURCE_PROFILE_ENVIRONMENT_DIRECTORY_REQUIRED');
  }
  assert.ok(Array.isArray(manifest.ordinary_source_refs) && manifest.ordinary_source_refs.length > 0, 'RESOURCE_PROFILE_ORDINARY_ORIGIN_REQUIRED');
  assert.ok(Array.isArray(manifest.extension_order) && manifest.extension_order.filter(item => item.role === 'selected-broker').length === 1, 'RESOURCE_PROFILE_ONE_SELECTED_BROKER');
  assert.ok(manifest.extension_order.every(item => ['frozen', 'selected-broker'].includes(item.role)), 'RESOURCE_PROFILE_EXTENSION_ROLE');
  assert.deepEqual(manifest.builtin_order, ['codemode', 'tool_search', 'mcp'], 'RESOURCE_PROFILE_BUILTIN_ORDER');
  assert.ok(Array.isArray(manifest.native_skills) && Array.isArray(manifest.context_files), 'RESOURCE_PROFILE_EXPLICIT_INPUTS_REQUIRED');
  assert.ok(Array.isArray(manifest.excluded_extensions) && manifest.excluded_extensions.length > 0, 'RESOURCE_PROFILE_LIFECYCLE_EXCLUSIONS_REQUIRED');
  assert.ok(Array.isArray(manifest.shared_differences) && manifest.shared_differences.length > 0 && manifest.shared_differences.every(value => typeof value === 'string'), 'RESOURCE_PROFILE_DIFFERENCES_REQUIRED');
  assert.ok(object(manifest.settings) && Object.keys(manifest.settings).every(key => key === 'enableSkillCommands') && manifest.settings.enableSkillCommands === true, 'RESOURCE_PROFILE_SETTINGS_SCOPE');
  validateProfileToolPolicy(manifest.tool_policy);
  const declared = new Map(), closures = new Map();
  const verify = async descriptor => {
    const previous = declared.get(descriptor.path);
    if (previous) { assert.equal(previous.sha256, descriptor.sha256, 'RESOURCE_PROFILE_CONFLICTING_IDENTITY'); return verifiedFile(descriptor); }
    const data = await verifiedFile(descriptor);
    declared.set(descriptor.path, { path: descriptor.path, sha256: sha(data), bytes: data.length });
    return data;
  };
  const verifyClosure = async descriptor => {
    validateResourceProfileRef(descriptor);
    assert.ok(inside(manifest.owner_root, descriptor.path), 'RESOURCE_PROFILE_CLOSURE_MANIFEST_NOT_OWNED');
    if (closures.has(descriptor.path)) { assert.equal(closures.get(descriptor.path).ref.sha256, descriptor.sha256, 'RESOURCE_PROFILE_CONFLICTING_CLOSURE'); return closures.get(descriptor.path); }
    const closure = JSON.parse(await verify(descriptor));
    assert.equal(closure.schema_version, 1, 'RESOURCE_PROFILE_CLOSURE_SCHEMA'); absolute(closure.root);
    assert.equal(await realpath(closure.root), closure.root, 'RESOURCE_PROFILE_CLOSURE_ALIAS');
    assert.ok(Array.isArray(closure.files) && closure.files.length > 0, 'RESOURCE_PROFILE_CLOSURE_FILES');
    assert.equal(sha(JSON.stringify(closure.files)), closure.sha256, 'RESOURCE_PROFILE_CLOSURE_INVENTORY_CHANGED');
    const seen = new Set();
    for (const file of closure.files) {
      assert.ok(typeof file.path === 'string' && file.path && !isAbsolute(file.path), 'RESOURCE_PROFILE_RELATIVE_MEMBER');
      const path = resolve(closure.root, file.path);
      assert.ok(inside(closure.root, path) && path !== closure.root && relative(closure.root, path) === file.path && !seen.has(path), 'RESOURCE_PROFILE_CLOSURE_MEMBER');
      seen.add(path); await verify({ ...file, path });
    }
    const result = { ref: { path: descriptor.path, sha256: descriptor.sha256 }, root: closure.root, sha256: closure.sha256, paths: seen };
    closures.set(descriptor.path, result); return result;
  };
  const entries = [...manifest.extension_order.filter(item => item.role === 'frozen'), ...manifest.native_skills];
  for (const item of entries) {
    await verify(item);
    const closure = await verifyClosure(item.closure_ref);
    assert.ok(closure.paths.has(item.path), 'RESOURCE_PROFILE_ENTRY_OUTSIDE_CLOSURE');
  }
  assert.equal(new Set(manifest.extension_order.filter(item => item.role === 'frozen').map(item => item.path)).size, manifest.extension_order.length - 1, 'RESOURCE_PROFILE_DUPLICATE_EXTENSION');
  assert.equal(new Set(manifest.native_skills.map(item => item.path)).size, manifest.native_skills.length, 'RESOURCE_PROFILE_DUPLICATE_SKILL');
  for (const item of manifest.native_skills) assert.equal(typeof item.visible, 'boolean', 'RESOURCE_PROFILE_SKILL_VISIBILITY_REQUIRED');
  for (const excluded of manifest.excluded_extensions) {
    absolute(excluded.path); assert.ok(typeof excluded.reason === 'string' && excluded.reason, 'RESOURCE_PROFILE_EXCLUSION_REASON');
    assert.ok(!manifest.extension_order.some(item => item.path === excluded.path), 'RESOURCE_PROFILE_EXCLUDED_EXTENSION');
  }
  for (const item of [...manifest.ordinary_source_refs, ...manifest.context_files]) await verify(item);
  assert.equal(new Set(manifest.context_files.map(item => item.path)).size, manifest.context_files.length, 'RESOURCE_PROFILE_DUPLICATE_CONTEXT');
  assert.ok(inside(manifest.owner_root, manifest.mcp_config?.path ?? ''), 'RESOURCE_PROFILE_MCP_CONFIG_NOT_OWNED');
  const mcpBytes = await verify(manifest.mcp_config), mcpConfig = JSON.parse(mcpBytes);
  assert.ok(object(mcpConfig) && object(mcpConfig.mcpServers), 'RESOURCE_PROFILE_MCP_CONFIG');
  const environmentNames = manifest.environment_names ?? [];
  assert.ok(Array.isArray(environmentNames) && environmentNames.every(name => /^[A-Z][A-Z0-9_]*$/.test(name)) && new Set(environmentNames).size === environmentNames.length, 'RESOURCE_PROFILE_ENVIRONMENT_NAMES');
  const commandRefs = manifest.mcp_command_refs ?? [];
  assert.ok(Array.isArray(commandRefs) && new Set(commandRefs.map(item => item.server)).size === commandRefs.length, 'RESOURCE_PROFILE_MCP_COMMAND_IDENTITIES');
  // Only the explicit, reviewed server configuration may start a stdio process.
  // This does not authorize model-requested subprocesses or supply a general sandbox.
  for (const [name, server] of Object.entries(mcpConfig.mcpServers)) {
    assert.ok(object(server), 'RESOURCE_PROFILE_MCP_SERVER');
    if (typeof server.command === 'string') {
      const approved = commandRefs.find(item => item.server === name);
      assert.ok(approved && approved.path === server.command && server.url === undefined, 'RESOURCE_PROFILE_UNDECLARED_STDIO_SERVER');
      assert.ok(Array.isArray(server.args) && server.args.every(value => typeof value === 'string'), 'RESOURCE_PROFILE_MCP_FIXED_ARGS');
      assert.ok(Object.values(server.env ?? {}).every(value => typeof value === 'string' && !value.startsWith('!')), 'RESOURCE_PROFILE_MCP_ENV_EXPRESSION');
      await verify(approved);
    } else {
      assert.ok(typeof server.url === 'string', 'RESOURCE_PROFILE_MCP_TRANSPORT');
      const url = new URL(server.url);
      assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search, 'RESOURCE_PROFILE_MCP_URL');
      assert.equal(server.auth, undefined, 'RESOURCE_PROFILE_MCP_PROVIDER_AUTH_UNSUPPORTED');
      for (const value of Object.values(server.headers ?? {})) {
        const match = typeof value === 'string' && value.match(/^(?:Bearer )?\$\{([A-Z][A-Z0-9_]*)\}$/);
        assert.ok(match && environmentNames.includes(match[1]), 'RESOURCE_PROFILE_MCP_HEADER_ENV_REQUIRED');
      }
    }
  }
  assert.ok(commandRefs.every(item => mcpConfig.mcpServers[item.server]?.command === item.path), 'RESOURCE_PROFILE_UNUSED_MCP_COMMAND');
  assert.ok(Array.isArray(manifest.mcp_tools) && manifest.mcp_tools.every(name => typeof name === 'string' && name.startsWith('mcp__')) && new Set(manifest.mcp_tools).size === manifest.mcp_tools.length, 'RESOURCE_PROFILE_MCP_TOOLS_REQUIRED');
  const agentFiles = [], credentials = [];
  const agentPaths = new Set();
  for (const item of manifest.agent_files ?? []) {
    assert.ok(inside(manifest.owner_root, item.path ?? ''), 'RESOURCE_PROFILE_AGENT_FILE_NOT_OWNED');
    const target = item.relative_path;
    assert.ok(typeof target === 'string' && target && !isAbsolute(target) && relative('/owned-agent', resolve('/owned-agent', target)) === target && !target.startsWith('..') && !agentPaths.has(target), 'RESOURCE_PROFILE_AGENT_FILE_PATH');
    assert.ok(!['settings.json', 'mcp.json', 'models.json', 'auth.json', 'mcp-auth.json', 'model-store.json', 'sessions'].includes(target.split('/')[0]), 'RESOURCE_PROFILE_AGENT_FILE_RESERVED');
    agentPaths.add(target);
    const data = await verify(item);
    agentFiles.push({ relative_path: target, bytes: data, source: { path: item.path, sha256: item.sha256, bytes: data.length } });
    if (item.credential_paths !== undefined) {
      assert.ok(Array.isArray(item.credential_paths), 'RESOURCE_PROFILE_CREDENTIAL_PATHS');
      assert.equal((await lstat(item.path)).mode & 0o077, 0, 'RESOURCE_PROFILE_CREDENTIAL_FILE_PRIVATE');
      assert.equal((await lstat(dirname(item.path))).mode & 0o077, 0, 'RESOURCE_PROFILE_CREDENTIAL_DIRECTORY_PRIVATE');
      const value = JSON.parse(data);
      for (const path of item.credential_paths) {
        assert.ok(Array.isArray(path) && path.length > 0 && path.every(key => typeof key === 'string' && !['__proto__', 'prototype', 'constructor'].includes(key)), 'RESOURCE_PROFILE_CREDENTIAL_PATH');
        let secret = value; for (const key of path) secret = secret?.[key];
        assert.ok(typeof secret === 'string' && secret.length > 3, 'RESOURCE_PROFILE_CREDENTIAL_VALUE_UNAVAILABLE');
        credentials.push(secret);
      }
    }
  }
  const contextFiles = [];
  for (const item of manifest.context_files) contextFiles.push({ path: item.path, content: (await verifiedFile(item)).toString('utf8') });
  await verifiedFile(ref);
  return { manifest, ref: { path: ref.path, sha256: ref.sha256 }, contextFiles, mcpBytes, agentFiles, credentials,
    evidence: { manifest: { path: ref.path, sha256: ref.sha256, bytes: bytes.length },
      files: [...declared.values()].sort((a, b) => a.path.localeCompare(b.path)),
      closures: [...closures.values()].map(({ paths, ...item }) => item),
      scope: 'exact declared source files and closure members, rechecked before loading and after cleanup; no OS sandbox or whole-home freeze' } };
}
