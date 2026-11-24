#!/usr/bin/env node
import { nativeFileRef, nativeSkillId } from '../packages/context-broker/src/native-reference.ts';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const canary = 'NOTION_INTEGRATION_BODY_61C9';
export const resourceCanary = 'NOTION_INTEGRATION_RESOURCE_61C9';
export const alias = 'ui-alpha';
export const pageId = '11111111-1111-4111-8111-111111111111';
const secondPageId = '22222222-2222-4222-8222-222222222222';
export const libraryId = '99999999-9999-4999-8999-999999999999';
const identity = page => nativeSkillId(libraryId, page);
const mainRef = page => nativeFileRef(identity(page), 'SKILL.md');
export const skillRef = mainRef(pageId);
const snapshot = 's_' + 'a'.repeat(64);
export const database = '33333333-3333-4333-8333-333333333333';
const scope = 'b'.repeat(64);
export const secondCanary = 'NOTION_INTEGRATION_SECOND_BODY_61C9';
export const unflaggedAlias = 'ui-beta';
export const unflaggedCanary = 'NOTION_INTEGRATION_UNFLAGGED_BODY_61C9';
export const unflaggedPageId = '55555555-5555-4555-8555-555555555555';
export const unflaggedRef = mainRef(unflaggedPageId);
export const missingAlias = 'ui-gamma';
export const missingCanary = 'NOTION_INTEGRATION_MISSING_FLAG_BODY_61C9';
export const missingPageId = '66666666-6666-4666-8666-666666666666';
export const missingRef = mainRef(missingPageId);
export const firstViewId = '77777777-7777-4777-8777-777777777777';
export const secondViewId = '88888888-8888-4888-8888-888888888888';
export async function createNotionFixture(directory) {
  await mkdir(directory, { recursive: true });
  const statePath = join(directory, 'notion-fixture-state.json');
  const callsPath = join(directory, 'notion-fixture-calls.jsonl');
  const setScenario = async (scenario, options = {}) => writeFile(statePath, JSON.stringify({ ...options, scenario, callsPath }));
  await setScenario('normal');
  return { command: [process.execPath, fileURLToPath(import.meta.url), '--state', statePath], statePath, callsPath, canary, resourceCanary, skillRef, alias, name: 'UI Alpha', snapshotId: snapshot, scope, setScenario,
    duplicateSelections: [{ pageId, marker: canary }, { pageId: '22222222-2222-4222-8222-222222222222', marker: secondCanary }] };
}
/** The current shared test double covers the bundled View-management CLI only.
 * Catalogs and content use fixtures/current-notion-source.ts through the SDK. */
async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== '--state' || !args[1]) throw new Error('Fixture requires --state FILE');
  const state = JSON.parse(await readFile(args[1], 'utf8'));
  const [command, ...flags] = args.slice(2);
  const operation = command === 'ctl' ? flags[0] : command;
  await appendFile(state.callsPath, JSON.stringify({ command, args: flags, operation, scenario: state.scenario, at: new Date().toISOString() }) + '\n');
  if (command !== 'ctl' || operation !== 'views') {
    console.log(JSON.stringify({ ok: false, error: { code: 'UNSUPPORTED_CONTROLLED_OPERATION', message: 'This fixture implements only the current bundled ctl views boundary; catalogs and content require the SDK fixture.' } }));
    process.exitCode = 1;
    return;
  }
  const views = state.noViews ? [] : [firstViewId, secondViewId].map((id, index) => ({ id, name: index ? 'Beta work' : 'Default work', type: 'table', database_id: database, data_source_id: '44444444-4444-4444-8444-444444444444', url: `https://notion.so/${database}?v=${id}` }));
  console.log(JSON.stringify({ ok: true, views, count: views.length }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
