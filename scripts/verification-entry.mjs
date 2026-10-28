import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';

export async function entryIdentity(entry) {
  const path = await realpath(entry);
  const bytes = await readFile(path);
  return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function verifyEntryIdentity(entry, expected) {
  const actual = await entryIdentity(entry);
  assert.deepEqual(actual, expected, 'Consumed extension entry must match the recorded installed/selected bytes');
  return actual;
}
