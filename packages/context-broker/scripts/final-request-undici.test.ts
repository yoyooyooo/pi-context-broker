import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveHost } from "./context-broker-e2e-fixture.mjs";
import { createFinalRequestLedger } from "../src/final-request.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const payload = (content: string) => ({ model: "fixture", stream: true, messages: [{ role: "user", content }] });

function listen(statuses: number[] = [200]) {
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

test("Node Undici localhost bytes confirm the bound entity and a later mutation does not", async () => {
  const endpoint = await listen();
  const ledger = createFinalRequestLedger();
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
  ledger.close();
  endpoint.server.close();
});

test("same-endpoint concurrent dispatches stay unknown", async () => {
  const endpoint = await listen();
  const ledger = createFinalRequestLedger();
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
  ledger.close();
  endpoint.server.close();
});

test("the installed OpenAI completions serializer matches the sent Undici entity", async () => {
  const endpoint = await listen();
  const ledger = createFinalRequestLedger();
  const signal = new AbortController().signal;
  const body = payload("openai client");
  ledger.inspect({
    messages: [{ role: "user", content: "openai client" }], payload: body, api: "openai-completions",
    baseUrl: endpoint.url, sessionId: "serializer", generation: 1, signal,
  });
  const host = await resolveHost("pi");
  let root = dirname(host.identity);
  for (;;) {
    try {
      if (JSON.parse(await readFile(join(root, "package.json"), "utf8")).name === "@earendil-works/pi-coding-agent") break;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    assert.notEqual(root, dirname(root), "Find the actual installed Pi package"); root = dirname(root);
  }
  const { createRequire } = await import("node:module");
  const require = createRequire(join(root, "package.json"));
  const openai = await import(pathToFileURL(require.resolve("openai")).href);
  const client = new openai.default({ apiKey: "test-key", baseURL: endpoint.url });
  await client.chat.completions.create(body, { maxRetries: 0 }).then(() => undefined, () => undefined);
  assert.equal(ledger.observeProvider(signal, 200, 1).blocked, false);
  assert.equal(endpoint.bodies[0]!.toString("utf8"), JSON.stringify(body));
  assert.equal(ledger.recent().at(-1)!.wireConfirmed, true);
  ledger.close();
  endpoint.server.close();
});
