const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const pageId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const property = (row, ids, name) => {
  const value = Object.values(row?.properties ?? {}).find(item => item.id === ids?.[name]) ?? row?.properties?.[name];
  return value?.select?.name ?? value?.status?.name ?? (value?.rich_text ?? value?.title ?? []).map(item => item.plain_text ?? item.text?.content ?? '').join('');
};

// A never-replay create can be resumed by observing the exact Source already
// created under this operation. The handoff never clears or repeats the request.
export function isAgentSourceHandoff({ inspection, operationId, library, sourceId, sourcePageId, inputSha256, interrupted }) {
  const operation = inspection?.operation;
  if (inspection?.ok !== true || inspection.status !== 'observed' || inspection.library?.library_id !== library?.library_id
    || operation?.intent?.operation_id !== operationId || operation.intent.owner?.kind !== 'source' || operation.intent.owner.id !== sourceId
    || !digest(inputSha256) || operation.intent.input_sha256 !== inputSha256 || operation.local_lifecycle?.phase !== 'active'
    || !pageId(operation.record_page_id)) return false;
  if (operation.in_flight === null) return true;
  const pending = operation.in_flight, source = interrupted?.after?.source, failure = interrupted?.cli?.error?.details;
  return pending?.key === 'source:create' && pending.replay === 'never' && digest(pending.request_sha256)
    && operation.source_progress?.next_index === 0 && operation.source_progress.child_started === false
    && operation.owner_state?.state === 'applying' && operation.owner_state.operation_id === operationId
    && operation.owner_page_id === sourcePageId && operation.owner_in_trash === false && operation.record_observed === true
    && operation.local_lifecycle.record_page_id === operation.record_page_id
    && source?.id === sourcePageId && source.in_trash !== true && source.archived !== true && interrupted.after.skill === null
    && property(source, library.sources?.property_ids, 'Source ID') === sourceId
    && property(source, library.sources?.property_ids, 'Status') === 'applying'
    && property(source, library.sources?.property_ids, 'Operation') === operationId
    && interrupted.cli?.error?.code === 'REQUEST_BUDGET_EXHAUSTED'
    && failure?.operation_id === operationId && failure.source_id === sourceId
    && failure.source_page_id === sourcePageId && failure.input_sha256 === inputSha256;
}
