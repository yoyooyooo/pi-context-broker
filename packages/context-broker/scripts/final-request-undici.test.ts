import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { createFinalRequestLedger } from "../src/final-request.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const payload = (content: string) => ({ model: "fixture", stream: true, messages: [{ role: "user", content }] });

function listen(t: TestContext, statuses: number[] = [200]) {
  const bodies: Buffer[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      bodies.push(Buffer.concat(chunks));
      response.writeHead(statuses.shift() ?? 200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return new Promise<{ server: http.Server; url: string; bodies: Buffer[] }>(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${address.port}/v1`, bodies });
    });
  });
}

async function post(url: string, body: unknown): Promise<void> {
  const response = await fetch(url + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer SECRET_HEADER" },
    body: JSON.stringify(body),
  });
  await response.arrayBuffer();
}

test("Node Undici localhost bytes confirm the bound entity and a later mutation does not", { timeout: 10_000 }, async t => {
  const endpoint = await listen(t);
  const ledger = createFinalRequestLedger();
  t.after(() => ledger.close());
  const signal = new AbortController().signal;
  const body = payload("hello wire");
  assert.equal(ledger.inspect({
    messages: [{ role: "user", content: "hello wire" }], payload: body, api: "openai-completions",
    baseUrl: endpoint.url, sessionId: "session-wire", generation: 1, signal,
  }).block, false);
  await post(endpoint.url, body);
  assert.equal(ledger.observeProvider(signal, 200, 1).blocked, false);
  const confirmed = ledger.recent().at(-1)!;
  const sent = endpoint.bodies[0]!.toString("utf8");
  assert.equal(sent, JSON.stringify(body));
  assert.equal(confirmed.wireConfirmed, true);
  assert.equal(confirmed.dispatched, true);
  assert.equal(confirmed.sentEntitySha256, sha(sent));
  assert.equal(confirmed.chunkCount! > 0, true);
  assert.equal(confirmed.httpStatus, 200);

  const rewrittenSignal = new AbortController().signal;
  const expected = payload("expected body");
  ledger.inspect({
    messages: [{ role: "user", content: "expected body" }], payload: expected, api: "openai-completions",
    baseUrl: endpoint.url, sessionId: "session-wire", generation: 2, signal: rewrittenSignal,
  });
  const rewritten = payload("rewritten body");
  await post(endpoint.url, rewritten);
  assert.equal(ledger.observeProvider(rewrittenSignal, 200, 2).blocked, true);
  const mismatch = ledger.recent().at(-1)!;
  assert.equal(mismatch.dispatched, true);
  assert.equal(mismatch.wireConfirmed, false);
  assert.equal(mismatch.disposition, "mismatch");
  assert.equal(mismatch.logicalProviderStatus, 200);
  assert.notEqual(mismatch.logicalProviderStatus, 0);
  assert.equal(mismatch.sentEntitySha256, sha(JSON.stringify(rewritten)));
  assert.ok(mismatch.errors.includes("PAYLOAD_REWRITTEN"));
});

test("same-endpoint concurrent dispatches stay unknown", { timeout: 10_000 }, async t => {
  const endpoint = await listen(t);
  const ledger = createFinalRequestLedger();
  t.after(() => ledger.close());
  const left = new AbortController();
  const right = new AbortController();
  const shared = payload("same entity");
  const other = payload("other entity");
  for (const [signal, body, generation] of [[left.signal, shared, 1], [right.signal, other, 1]] as const) {
    ledger.inspect({
      messages: [{ role: "user", content: String((body.messages[0] as { content: string }).content) }],
      payload: body, api: "openai-completions", baseUrl: endpoint.url, sessionId: "s", generation, signal,
    });
  }
  await post(endpoint.url, shared);
  assert.equal(ledger.observeProvider(left.signal, 200, 1).blocked, true);
  assert.equal(ledger.observeProvider(right.signal, 200, 1).blocked, true);
  assert.equal(ledger.recent().every(row => row.wireConfirmed === false && row.errors.includes("CONCURRENT_UNBOUND")), true);
});
