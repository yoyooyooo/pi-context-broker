import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const matrix = Object.freeze({
  'bundled-builtin': 'Select an official packaged builtin through ordinary $ and load its body once with its package identity',
  'candidate-draft-submit': 'Choose an exact Skill identity, preserve the remaining draft and submit the original request once',
  'kind-source': 'Observe complete candidate identity, kind and source and select the intended same-name record',
  'router-lazy': 'Choose exact Router identity and autonomously read its selected member',
  'prompt-two-rounds': 'Two Prompt turns each retain only their own references',
  'mixed-image': 'Mixed image and text survive actual provider delivery',
  'selected-unavailable': 'Submit a previously observed exact reference that is now unavailable; show not-loaded to user and model while preserving the request and other references',
  'resource-read': 'Read a needed relative resource from the selected Skill directory or pinned source scope through the actual host tool and verify returned content',
  'unicode-cursor': 'Complete at a Unicode cursor without changing surrounding text; supported manual entrypoints also reject acceptance after the full draft changes',
  'delete-undo': 'Delete a selected reference without damaging surrounding text and restore it with host undo where supported',
  'cancel-stop': 'Cancel completion without replacing or sending the draft; stop preparation or an actual request without a duplicate dispatch',
  'stale-pane': 'Changing the active pane while manual completion is open cannot edit a different pane',
  'stale-cwd': 'Changing cwd while a manual query is pending prevents insertion from the old scope',
  'stale-session': 'Changing the host session during automatic preparation cannot complete or reuse the previous submission',
});
const sharedScenarios = Object.freeze(Object.keys(matrix).filter(id => !id.startsWith('stale-')));
export function requiredScenarios(surface) {
  assert.ok(['pi-terminal', 'omp-terminal', 'omp-native'].includes(surface), `Unknown surface ${surface}`);
  // Terminal editors have no companion manual picker. Keep observable native
  // guards in the native run; shared automatic lifecycle tests cover all hosts.
  return surface === 'omp-native' ? [...sharedScenarios, 'stale-pane', 'stale-cwd'] : [...sharedScenarios];
}
export const capabilities = Object.freeze({
  candidate: { native: 'exact visible node identity and current rect', terminal: 'Pi or OMP queryText plus exact identity/ref/kind/source/value; one public query candidate, then real Tab acceptance and draft evidence' },
  startup: { omp: 'owned --config with startup.setupWizard=false/checkUpdate=false and selected model roles; actual editor with no dialogs required' },
  controlledProof: 'absolute actual provider output path; entry/task once per context, initial dispatch and real member-read followup retained separately',
  traces: ['ctl.jsonl complete control stdout/stderr', 'actions.jsonl stable input steps', 'provider-events.jsonl', 'controlled provider input and read-result hashes'],
});
export const digest = value => createHash('sha256').update(value).digest('hex');
export function exactCandidate(tree, identity) {
  assert.ok(identity && Object.keys(identity).length, 'Candidate selection requires exact observed identity fields');
  const visit = value => !value || typeof value !== 'object' ? [] : [...(Array.isArray(value) ? [] : [value]), ...Object.values(value).flatMap(visit)];
  const matches = visit(tree).filter(node => Object.entries(identity).every(([key, value]) => node[key] === value));
  assert.equal(matches.length, 1, `Expected one exact candidate, got ${matches.length}`);
  assert.ok(matches[0].rect, 'Exact candidate must expose a clickable rect');
  return matches[0];
}
// Optional harness limits belong to the frozen spec, never to the user task or runtime API.
export function validateRunLimits(limits) {
  if (limits === undefined) return;
  assert.ok(limits && typeof limits === 'object' && !Array.isArray(limits), 'runLimits must be an object');
  for (const name of ['maxRunMs', 'maxProviderRequests']) {
    assert.ok(Number.isSafeInteger(limits[name]) && limits[name] > 0, `runLimits.${name} must be a positive safe integer`);
  }
}
export function validateSpec(spec) {
  validateRunLimits(spec.runLimits);
  assert.equal(spec.model, 'magpie/group/e2e');
  assert.ok(Array.isArray(spec.hostEnvNames), 'Explicit environment-name allowlist required');
  assert.ok(!spec.hostEnv || !Object.keys(spec.hostEnv).some(key => /token|secret|password|api.?key/i.test(key)), 'Credentials must be inherited by name, never copied into spec');
  const ids = new Set();
  for (const item of spec.scenarios ?? []) {
    assert.ok(matrix[item.id], `Unknown matrix case ${item.id}`);
    assert.ok(!ids.has(item.id), `Duplicate case ${item.id}`); ids.add(item.id);
    assert.equal(item.intent, matrix[item.id], `Case intent differs from matrix: ${item.id}`);
    assert.ok(!item.gate || (typeof item.gate === 'string' && item.gate.trim().length > 20), 'Explicit unsupported API/evidence gate required');
    if (!item.gate) {
      assert.ok(item.reset?.length, `Independent resume needs reset steps: ${item.id}`);
      assert.ok(item.steps?.every(step => /^[a-z0-9-]+$/.test(step.id ?? '')), `Stable step IDs required: ${item.id}`);
      assert.equal(new Set(item.steps.map(step => step.id)).size, item.steps.length);
    }
  }
  for (const id of requiredScenarios(spec.surface)) assert.ok(ids.has(id), `Missing matrix case ${id}`);
}
