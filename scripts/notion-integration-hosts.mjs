import assert from 'node:assert/strict';
import { parseNativeReference, hasExactNativeOwner, bindNativeReference } from '../packages/context-broker/src/native-reference.ts';

export function decodeCatalogText(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_match, name) => entities[name]);
}

/** Select the owner of the supplied ref; the public read still validates its pin. */
export function selectLiveCatalogRecord(records, ref, libraryId) {
  let target = parseNativeReference(ref);
  if (!hasExactNativeOwner(target)) {
    assert.ok(typeof libraryId === 'string', 'A contextual stable ID requires an explicitly bound Library');
    target = bindNativeReference(target, libraryId);
  }
  const matches = records.filter(record => record.locator?.type === 'shared_skill'
    && record.id === target.selector && parseNativeReference(record.ref).selector === target.selector);
  assert.equal(matches.length, 1, 'Requested real Skill owner must match exactly one selected catalog record');
  return matches[0];
}

/** Copy a resource issued with the selected body, never append a path to sr:. */
export function projectedResourceRef(context, name, path) {
  const texts = context.messages.map(message => typeof message.content === 'string' ? message.content
    : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n'));
  const records = texts.flatMap(text => [...text.matchAll(/<context-broker-record\b([^>]*)>([\s\S]*?)<\/context-broker-record>/gu)])
    .filter(record => decodeCatalogText(/\bname="([^"]*)"/u.exec(record[1])?.[1] ?? '') === name);
  assert.equal(records.length, 1, 'Selected body owner must have one actual provider projection');
  const blocks = [...records[0][2].matchAll(/<resources>([\s\S]*?)<\/resources>/gu)];
  assert.equal(blocks.length, 1, 'Selected body must advertise its resource directory');
  const files = JSON.parse(decodeCatalogText(blocks[0][1])).filter(file => file.path === path);
  assert.equal(files.length, 1, 'Requested resource must belong to the selected body');
  assert.match(files[0].ref, /^sr:R[A-Za-z0-9_-]{22}$/u);
  return files[0].ref;
}

export function measuredConsumptionArgs(args) {
  if (args[0] === 'prepare' || args[0] === 'ctl' && args[1] === 'prepare')
    throw new Error('The prepare protocol is retired; select current content with use.');
  if (!['list', 'read', 'files', 'use'].includes(args[0]) || args.includes('--raw')) return args;
  return [...args, ...(args.includes('--json') ? [] : ['--json']), ...(args.includes('--metrics') ? [] : ['--metrics'])];
}
