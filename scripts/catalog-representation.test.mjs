import assert from 'node:assert/strict';
import test from 'node:test';
import { viewSystemPrompt } from '../packages/context-broker/src/view-prompt.ts';

const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const decode = value => value.replaceAll('&#13;', '\r').replaceAll('&#10;', '\n').replaceAll('&#9;', '\t')
  .replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const bytes = value => Buffer.byteLength(value);
const attrs = raw => Object.fromEntries([...raw.matchAll(/([a-z]+)="([^"]*)"/g)].map(match => [match[1], decode(match[2])]));

function fixture() {
  return Array.from({ length: 74 }, (_, index) => {
    const sourceId = index < 70 ? 'alpha' : 'beta';
    const description = index === 3 ? '' : `Use synthetic ${index}${index % 5 === 0 ? ' "quoted" ' : ' '}中文 😀${index % 7 === 0 ? ' <tag> & tail' : ''}${index % 11 === 0 ? '\n' : ''}`;
    return {
      name: index === 12 ? 'Skill & "twelve"' : `Skill ${index}`, description, source: 'notion', sourceId,
      path: `/owned/${index}/SKILL.md`, ref: `skill://synthetic/${index}/SKILL.md`, aliases: [],
      normalizedName: `skill-${index}`, normalizedAliases: [], normalizedDescription: description, autoloadEnabled: true,
    };
  });
}

function legacy(records) {
  const entries = records.map(record => `<skill><name>${xml(record.name)}</name><description>${xml(record.description)}</description><source>${xml(record.sourceId)}</source><location>${xml(record.ref)}</location></skill>`).join('\n');
  return `<ntn-skills-view-catalog>\n<available_skills>\n${entries}\n</available_skills>\n</ntn-skills-view-catalog>`;
}

function groupedObject(records) {
  const groups = [];
  for (let index = 0; index < records.length;) {
    const source = records[index].sourceId;
    let end = index + 1;
    while (end < records.length && records[end].sourceId === source) end += 1;
    groups.push({ kind: 'skill', source, cards: records.slice(index, end).map(record => ({ name: record.name, location: record.ref, description: record.description })) });
    index = end;
  }
  return { groups };
}

function decodeGrouped(catalog) {
  const block = /<catalog-cards>([\s\S]*?)<\/catalog-cards>/.exec(catalog)?.[1] ?? '';
  return [...block.matchAll(/<group\b([^>]*)>([\s\S]*?)<\/group>/g)].flatMap(group => {
    const header = attrs(group[1]);
    return [...group[2].matchAll(/<card\b([^>]*?)\/>|<card\b([^>]*)>([\s\S]*?)<\/card>/g)].map(card => {
      const self = card[1] !== undefined;
      const fields = attrs(self ? card[1] : card[2]);
      return { kind: header.kind, name: fields.name, source: fields.source ?? header.source, location: fields.location,
        description: self ? undefined : decode(card[3]) };
    });
  });
}

test('public synthetic catalog compares legacy XML, grouped XML and grouped JSON without dropping fields', () => {
  const records = fixture();
  const grouped = viewSystemPrompt('', records, [], new Set(), [], '/cwd', value => value.ref, 'notion_list', true);
  const decoded = decodeGrouped(grouped);
  assert.deepEqual(decoded.map(card => [card.kind, card.name, card.source, card.location, card.description]),
    records.map(record => ['skill', record.name, record.sourceId, record.ref, record.description]));
  const object = groupedObject(records);
  assert.deepEqual(object.groups.flatMap(group => group.cards.map(card => [group.kind, card.name, group.source, card.location, card.description])),
    decoded.map(card => [card.kind, card.name, card.source, card.location, card.description]));
  const legacyCatalog = legacy(records);
  const request = value => JSON.stringify({ role: 'user', content: value });
  const measured = {
    source_model_utf8: bytes(JSON.stringify(records.map(record => ({ name: record.name, description: record.description, source: record.sourceId, ref: record.ref, kind: 'skill' })))),
    legacy_catalog_utf8: bytes(legacyCatalog),
    grouped_xml_catalog_utf8: bytes(grouped),
    grouped_object_json_utf8: bytes(JSON.stringify(object).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')),
    legacy_request_json_utf8: bytes(request(legacyCatalog)),
    grouped_xml_request_json_utf8: bytes(request(grouped)),
  };
  assert.ok(measured.grouped_xml_catalog_utf8 < measured.legacy_catalog_utf8);
  assert.ok(measured.grouped_xml_request_json_utf8 < measured.legacy_request_json_utf8);
  assert.equal(viewSystemPrompt('', records, [], new Set(), [], '/cwd', value => value.ref).includes('<catalog-cards>'), false);
  console.log(JSON.stringify({ fixture: 'public-synthetic-74', ...measured }));
});
