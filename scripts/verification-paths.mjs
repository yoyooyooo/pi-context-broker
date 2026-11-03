import assert from 'node:assert/strict';
import { access, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

// cwd ancestors are searched by hosts even when HOME and agentDir are isolated.
export async function systemTempRoot() {
  const root = await realpath(process.platform === 'darwin' ? '/private/tmp' : '/tmp');
  for (let ancestor = root; ; ancestor = dirname(ancestor)) {
    let found = false;
    try { await access(join(ancestor, '.agents')); found = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.equal(found, false, `System temporary root has a .agents ancestor: ${ancestor}`);
    if (ancestor === dirname(ancestor)) break;
  }
  return root;
}

export async function evidenceRoot(option, fallback) {
  if (option === undefined) return fallback;
  assert.ok(isAbsolute(option), '--evidence-root must be absolute');
  await mkdir(option, { recursive: true, mode: 0o700 });
  return realpath(option);
}

/** Keep authentication in the inherited host environment, while giving oracle
 * preparation and the actual consumer disjoint mutable CLI/XDG roots. */
export function verificationCliEnvironment(base, inherited = process.env) {
  assert.ok(isAbsolute(base), 'Verification CLI root must be absolute');
  const roots = { NTN_SKILLS_CONFIG_HOME: 'config', NTN_SKILLS_HOME: 'state', NTN_SKILLS_CACHE_HOME: 'cache', NTN_SKILLS_DATA_HOME: 'data', XDG_CONFIG_HOME: 'xdg/config', XDG_STATE_HOME: 'xdg/state', XDG_CACHE_HOME: 'xdg/cache', XDG_DATA_HOME: 'xdg/data' };
  return { ...inherited, ...Object.fromEntries(Object.entries(roots).map(([key, path]) => [key, join(base, path)])) };
}
