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
