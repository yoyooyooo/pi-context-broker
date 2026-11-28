// Observation only: normal host tools remain available; attempted probes fail
// acceptance after the turn rather than being blocked to manufacture a pass.
export function observeConsumerModel(api, settings) {
  const { appendFileSync } = settings.fs;
  const { createHash } = settings.crypto;
  const { model, provider, id, sourceRoots, cacheRoots, output, marker, bodySha256, resourceSha256 } = settings;
  const values = Object.entries(process.env).filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL/i.test(key) && typeof value === 'string' && value.length >= 4).map(([, value]) => value);
  const sanitize = text => values.reduce((text, value) => text.split(value).join('[redacted]'), String(text)).replace(/\b(?:Bearer|Basic)\s+[a-z0-9+/._=-]+/gi, '[authorization withheld]').replace(/https?:\/\/[^\s"'<>]+/gi, '[url withheld]');
  const record = value => appendFileSync(output, JSON.stringify(value) + '\n', { mode: 0o600 });
  const texts = value => typeof value === 'string' ? value : Array.isArray(value) ? value.filter(part => part.type === 'text').map(part => part.text).join('\n') : '';
  const check = value => {
    const text = JSON.stringify(value);
    return { sourcePathExposed: sourceRoots.some(root => text.includes(root)), cachePathExposed: cacheRoots.some(root => text.includes(root)) };
  };
  const digest = text => createHash('sha256').update(text).digest('hex');
  const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  const cliCalls = new Set();
  const cliArtifacts = new Set();
  let resourceBody;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function(input, init) {
    const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    let payload;
    try { if (typeof raw === 'string') payload = JSON.parse(raw); } catch {}
    if (typeof payload?.model === 'string') {
      if (![id, model].includes(payload.model)) throw new Error('Consumer model rejected unauthorized transport selector');
      const text = JSON.stringify(payload);
      const parts = strings(payload);
      const bodies = parts.flatMap(text => [...text.matchAll(/<body>([\s\S]*?)<\/body>/g)].map(match => match[1].replace(/^\n|\n$/g, '')));
      const resourceBodyPresent = Boolean(resourceBody && parts.some(text => text.includes(resourceBody) || text.includes(JSON.stringify(resourceBody).slice(1, -1))));
      record({ phase: 'request', model, wireModel: payload.model, ...check(payload), cliGuidance: text.split('<ntn-skills-guidance>').length - 1, bodyPresent: text.includes(marker), completeBodies: bodies.filter(body => digest(body) === bodySha256).length, resourceBodyPresent, publicCommandPresent: text.includes('ntn-skills') });
    }
    const response = await originalFetch.call(this, input, init);
    if (typeof payload?.model === 'string') record({ phase: 'response', status: response.status });
    return response;
  };
  api.on('session_start', (_event, ctx) => {
    if (ctx.model?.provider !== provider || ctx.model?.id !== id) throw new Error('Consumer model rejected unauthorized selector');
    record({ phase: 'selected', model, tools: api.getActiveTools() });
  });
  api.on('tool_call', event => {
    if (event.toolName === 'bash' && /\bntn-skills\b/.test(event.input?.command ?? '')) cliCalls.add(event.toolCallId);
    const artifact = event.input?.path?.match(/^artifact:\/\/[a-z0-9_-]+/i)?.[0];
    if (event.toolName === 'read' && artifact && cliArtifacts.has(artifact)) cliCalls.add(event.toolCallId);
    record({ phase: 'tool_call', id: event.toolCallId, tool: event.toolName, input: JSON.parse(sanitize(JSON.stringify(event.input))), ...check(event.input) });
  });
  api.on('tool_result', event => {
    const body = texts(event.content);
    const viaPublicCli = cliCalls.has(event.toolCallId);
    if (viaPublicCli) for (const match of body.matchAll(/artifact:\/\/[a-z0-9_-]+/gi)) cliArtifacts.add(match[0]);
    let result;
    try { result = JSON.parse(body); } catch {
      try { result = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)); } catch {}
    }
    if (viaPublicCli && result?.ok === true && typeof result.content === 'string' && digest(result.content) === resourceSha256) resourceBody = result.content;
    record({ phase: 'tool_result', id: event.toolCallId, tool: event.toolName, isError: Boolean(event.isError), viaPublicCli, ...check(body), ...(result ? {
      ok: result.ok, errorCode: result.error?.code, source: result.source, path: result.path, ref: result.ref, snapshotId: result.snapshot_id,
      operation: typeof result.operation === 'string' ? result.operation : undefined, operationId: result.operation_id,
      action: result.action, verified: result.verified, reused: result.reused, dryRun: result.dry_run,
      changedFiles: result.changes?.files, removedFiles: result.changes?.removed,
      recordId: result.record?.id, databaseId: result.record?.locator?.database_id ?? result.database_id,
      contentSha256: typeof result.content === 'string' ? digest(result.content) : undefined,
    } : {}) });
  });
  api.on('message_end', event => {
    const message = event.message;
    if (message?.role !== 'assistant' || !['stop', 'length'].includes(message.stopReason)) return;
    const text = texts(message.content);
    record({ phase: 'assistant_final', success: Boolean(text.trim()), stopReason: message.stopReason, text: sanitize(text), ...check(text) });
  });
}
