#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
const { parse, stringify } = createRequire(new URL('../packages/context-broker/package.json', import.meta.url))('yaml');

// Explicit import only: ordinary catalog/session readers never call this conversion.
const [input, output] = process.argv.slice(2);
if (!input || !output || resolve(input) === resolve(output)) throw new Error('Usage: node scripts/migrate-content-assets.mjs INPUT OUTPUT (distinct paths; output must not exist)');
function convertMember(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid historical Router member');
  if (value.type === 'remote') {
    if (Object.keys(value).some(key => !['type', 'source', 'id', 'locator', 'ref'].includes(key))) throw new Error('Unknown or mixed remote Router member field');
    return { ...value };
  }
  if (value.type !== undefined && value.type !== 'local') throw new Error('Unknown Router member type');
  if (Object.keys(value).some(key => !['type', 'path', 'name', 'description', 'aliases'].includes(key))) throw new Error('Unknown or mixed historical local Router member field');
  if (typeof value.path !== 'string' || !value.path.trim()) throw new Error('Historical local Router member requires an exact Skill entry path');
  if ([value.name, value.description].some(item => item !== undefined && typeof item !== 'string') || value.aliases !== undefined && (!Array.isArray(value.aliases) || !value.aliases.every(item => typeof item === 'string'))) throw new Error('Invalid historical local Router member metadata');
  return { ...value, type: 'local' };
}
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function routerReference(value) {
  return typeof value === 'string' && value.startsWith('bundle:') ? 'router:' + value.slice('bundle:'.length) : value;
}
function convertRecord(value) {
  if (!isRecord(value)) throw new Error('Invalid historical content record');
  const result = { ...value };
  if (value.kind === 'bundle') result.kind = 'router';
  if (result.kind === 'router') {
    for (const key of ['id', 'recordId', 'ref']) {
      if (key in value) result[key] = routerReference(value[key]);
    }
    if (Array.isArray(value.members)) result.members = value.members.map(convertMember);
  }
  if (typeof value.sourceSkillId === 'string' && typeof value.sourceId === 'string') {
    const page = value.sourceSkillId;
    const notion = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(page);
    const compact = page.replaceAll('-', '').toLowerCase();
    const canonical = notion ? compact.replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5') : page;
    const id = (notion ? 'notion_page:' : 'local:') + canonical;
    result.recordId = id;
    result.identity = JSON.stringify([value.sourceId, value.sourceScope ?? '', result.kind ?? 'skill', notion ? 'notion_page' : 'local', id]);
    delete result.sourceSkillId;
  }
  return result;
}
function convertDetails(value) {
  if (!isRecord(value)) return value;
  const result = convertRecord(value);
  if (Array.isArray(value.records)) result.records = value.records.map(convertRecord);
  return result;
}
function convert(value) {
  if (!isRecord(value)) throw new Error('Expected historical catalog or session entry object');
  const result = { ...value };
  if ('bundles' in value) {
    if ('routers' in value) throw new Error('Cannot merge historical bundles with existing routers');
    if (!isRecord(value.bundles)) throw new Error('Historical bundles must be a named catalog map');
    result.routers = Object.fromEntries(Object.entries(value.bundles).map(([name, record]) => [name, convertRecord(record)]));
    delete result.bundles;
  }
  if (Array.isArray(value.records)) result.records = value.records.map(convertRecord);
  if (value.type === 'message' && isRecord(value.message)) result.message = convertSessionMessage(value.message);
  if (['custom', 'custom_message'].includes(value.type)) return convertSessionMessage(result);
  return result;
}
function convertSessionMessage(value) {
  const result = { ...value };
  if (typeof value.customType !== 'string' || !['context-broker', 'skill-prompt-message'].includes(value.customType) && !value.customType.startsWith('context-broker:')) return result;
  if (value.customType.startsWith('context-broker:bundle:')) result.customType = 'context-broker:router:' + value.customType.slice('context-broker:bundle:'.length);
  if (isRecord(value.details)) result.details = convertDetails(value.details);
  return result;
}
const content = await readFile(input, 'utf8');
const jsonl = /\.jsonl$/i.test(input);
const yaml = /\.ya?ml$/i.test(input);
const converted = jsonl
  ? content.split('\n').filter(line => line.trim()).map(line => JSON.stringify(convert(JSON.parse(line)))).join('\n') + '\n'
  : yaml ? stringify(convert(parse(content))) : JSON.stringify(convert(JSON.parse(content)), null, 2) + '\n';
await writeFile(output, converted, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ operation: 'convert_content_assets', input: resolve(input), output: resolve(output), preservedOriginal: true }));
