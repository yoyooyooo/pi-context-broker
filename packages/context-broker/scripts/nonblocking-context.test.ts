import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { brokerToolResultDigest, continueWithoutBrokerPayload, withoutBrokerInstructions } from "../src/nonblocking-context";
import { withPreparationDeadline } from "../src/skill-preparation";
import { nativeReadReceipt, sourceDeliveryReceipt, sourceMessageText } from "../src/session-source-snapshot";
import type { AgentMessage, MessageContent, SkillRecord } from "../src/types";

const body = "Private Skill instructions: exact guarded body.";
const record = { kind: "skill", sourceId: "notion", sourceScope: "scope", source: "notion",
  id: "skill://guarded?library=93a845c1-6c12-5b02-b395-ecf819622e7f", name: "guarded", token: "notion/guarded",
  path: "/immutable/SKILL.md", description: "Guarded", aliases: [], normalizedName: "guarded",
  normalizedDescription: "guarded", normalizedAliases: [], autoloadEnabled: false, body, snapshotId: "s_" + "a".repeat(64),
} satisfies SkillRecord;
const image = (data: string) => ({ type: "image" as const, data, mimeType: "image/png" });
const originalUser: AgentMessage = { role: "user", content: [{ type: "text", text: "Explain my screenshot." }, image("USER_IMAGE")] };
const source: AgentMessage = { role: "custom", customType: "context-broker", content: body, details: { records: [sourceDeliveryReceipt(record, body)] } };
const read: AgentMessage = { role: "toolResult", toolName: "read", toolCallId: "source-read", content: body,
  details: { contextBrokerRead: nativeReadReceipt(record, "source-read", body) } };
const quote: AgentMessage = { role: "user", content: "My own quote: " + body };
const warning: AgentMessage = { role: "custom", customType: "context-broker-preparation-warning", content: "Source unavailable. Continue the original user request." };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function messages(value: unknown, key = "messages"): Record<string, unknown>[] {
  if (!object(value) || !Array.isArray(value[key]) || !value[key].every(object)) throw new Error("Expected native message array");
  return value[key];
}

test("fallback removes owned instructions and source reads while preserving user quotations, tool pairs and images", () => {
  const picture: AgentMessage = { role: "toolResult", toolName: "read", toolCallId: "local-image", content: [image("LOCAL_IMAGE")] };
  const input = [originalUser, source, read, quote, picture], saved = JSON.stringify(input);
  const result = withoutBrokerInstructions(input);
  expect(result).toContain(originalUser); expect(result).toContain(quote); expect(result).toContain(picture);
  expect(result.find(message => message.toolCallId === "source-read")).toMatchObject({ role: "toolResult", isError: true });
  expect(sourceMessageText(result.find(message => message.toolCallId === "source-read")?.content)).not.toContain(body);
  expect(result.some(message => message.customType === "context-broker")).toBe(false);
  expect(JSON.stringify(input)).toBe(saved);
});

test("fallback preserves native array tool results for serializers while withholding source images and text", () => {
  const native: AgentMessage = { ...read, content: [{ type: "text", text: body }, image("SOURCE_IMAGE")] };
  const [result] = withoutBrokerInstructions([native]);
  expect(result).toMatchObject({ role: "toolResult", toolCallId: native.toolCallId, isError: true });
  expect(Array.isArray(result?.content)).toBe(true);
  expect(result?.content).toEqual([{ type: "text", text: expect.stringContaining("could not verify") }]);
  expect(JSON.stringify(result)).not.toContain("SOURCE_IMAGE");
  expect(JSON.stringify(result)).not.toContain(body);
  expect(native.content).toEqual([{ type: "text", text: body }, image("SOURCE_IMAGE")]);
});

test("recovery retains exact source bytes and proof, independently of host display metadata", () => {
  const native: AgentMessage = { ...read, content: [{ type: "text", text: body }] };
  const retained = new Map([[native.toolCallId!, brokerToolResultDigest(native)]]);
  const copied = structuredClone(native);
  copied.timestamp = 123;
  copied.isError = false;
  copied.details = { ...native.details as object, hostDisplay: "ordinary host metadata" };
  expect(withoutBrokerInstructions([copied], [], retained)).toEqual([copied]);
  for (const changed of [
    { ...copied, isError: true },
    { ...copied, content: [{ type: "text" as const, text: "Unverified replacement instructions" }] },
    { ...copied, details: { contextBrokerRead: { ...nativeReadReceipt(record, native.toolCallId!, native.content), bodySha256: "0".repeat(64) } } },
  ]) {
    const [withheld] = withoutBrokerInstructions([changed], [], retained);
    expect(withheld).toMatchObject({ isError: true });
    expect(sourceMessageText(withheld?.content)).not.toContain(body);
    expect(sourceMessageText(withheld?.content)).not.toContain("Unverified replacement instructions");
  }
});

test("inline native receipts remove only their verified user body even when session projection is unavailable", () => {
  const text = "Explain this.\n\n<skill>" + body + "</skill>";
  const user: AgentMessage = { role: "user", content: [{ type: "text", text }, image("USER_IMAGE")] };
  const receipt: AgentMessage = { role: "custom", customType: "context-broker", content: [],
    details: { nativePromptSha256: createHash("sha256").update(text).digest("hex"), records: [sourceDeliveryReceipt(record, text)] } };
  const result = withoutBrokerInstructions([user, receipt, quote]);
  expect(sourceMessageText(result[0]?.content)).toContain("Explain this.");
  expect(sourceMessageText(result[0]?.content)).not.toContain(body);
  expect(result[0]?.content).toContainEqual(image("USER_IMAGE"));
  expect(result).toContain(quote);
});

test("restoring same-text native user entries keeps each timestamp and image instead of taking the last matching entry", () => {
  const text = "Explain this.\n\n<skill>" + body + "</skill>";
  const one: AgentMessage = { role: "user", timestamp: 1, content: [{ type: "text", text: "Explain this." }, image("ONE")] };
  const two: AgentMessage = { role: "user", timestamp: 2, content: [{ type: "text", text: "Explain this." }, image("TWO")] };
  const projected = [one, two].map(message => ({ ...message, content: [{ type: "text" as const, text }, ...(Array.isArray(message.content) ? message.content.filter(part => part.type === "image") : [])] }));
  const entry = { type: "custom", customType: "context-broker",
    data: { nativePromptSha256: createHash("sha256").update(text).digest("hex"), records: [sourceDeliveryReceipt(record, text)] } };
  const result = withoutBrokerInstructions(projected, [
    { sourceEntry: { type: "message", id: "one", message: one }, messages: [projected[0]!] },
    { sourceEntry: { type: "message", id: "two", message: two }, messages: [projected[1]!] },
    { sourceEntry: entry, messages: [] },
  ]);
  expect(result).toEqual([one, two]);
});

test("OpenAI repair changes owned slots without rebuilding ordinary native images, tools, assistant signatures or user quotations", () => {
  const localImage: AgentMessage = { role: "toolResult", toolName: "read", toolCallId: "local-image", content: [image("LOCAL_IMAGE")] };
  const assistant: AgentMessage = { role: "assistant", content: "Reading." };
  const original = [originalUser, source, assistant, read, localImage, quote];
  const nativeUser = { role: "user", content: [{ type: "text", text: "Explain my screenshot." },
    { type: "image_url", image_url: { url: "data:image/png;base64,USER_IMAGE", detail: "high" } }], name: "user" };
  const nativeAssistant = { role: "assistant", tool_calls: [{ id: "source-read", type: "function", function: { name: "read", arguments: "{}" } },
    { id: "local-image", type: "function", function: { name: "read", arguments: "{}" } }], reasoning_content: "Keep this native signature." };
  const nativeToolImage = { role: "user", content: [{ type: "text", text: "Attached image(s) from tool result:" },
    { type: "image_url", image_url: { url: "data:image/png;base64,LOCAL_IMAGE" } }] };
  const tools = [{ type: "function", function: { name: "unrelated", description: body, parameters: { type: "object" } } }];
  const payload = { model: "model", temperature: 0.4, tools, messages: [
    { role: "system", content: "User-owned system quote: " + body }, nativeUser, { role: "user", content: "CORRUPTED PRIVATE SKILL" },
    nativeAssistant, { role: "tool", tool_call_id: "source-read", content: "CORRUPTED READ" },
    { role: "tool", tool_call_id: "local-image", content: "(see attached image)", name: "read" }, nativeToolImage,
    { role: "user", content: quote.content },
  ] };
  const before = JSON.stringify(payload);
  const result = continueWithoutBrokerPayload(payload, original, [...withoutBrokerInstructions(original), warning], "openai-completions");
  const output = messages(result);
  expect(output).toContain(nativeUser); expect(output).toContain(nativeAssistant); expect(output).toContain(nativeToolImage);
  expect(output.find(message => message.role === "tool" && message.tool_call_id === "local-image")).toBe(payload.messages[5]);
  expect(output.find(message => message.role === "tool" && message.tool_call_id === "source-read")?.content).not.toContain("CORRUPTED");
  expect(output.some(message => message.content === "CORRUPTED PRIVATE SKILL")).toBe(false);
  expect(output).toContain(payload.messages[0]); expect(output).toContain(payload.messages[7]);
  expect(object(result) && result.tools).toBe(tools); expect(object(result) && result.temperature).toBe(0.4);
  expect(JSON.stringify(payload)).toBe(before);
});

test("repeated user text keeps each native image and content object attached to its own message", () => {
  const one: AgentMessage = { role: "user", content: [{ type: "text", text: "Compare." }, image("ONE")] };
  const two: AgentMessage = { role: "user", content: [{ type: "text", text: "Compare." }, image("TWO")] };
  const first = { role: "user", content: [{ type: "text", text: "Compare." }, { type: "image_url", image_url: { url: "data:image/png;base64,ONE" } }] };
  const second = { role: "user", content: [{ type: "text", text: "Compare." }, { type: "image_url", image_url: { url: "data:image/png;base64,TWO" } }] };
  const result = messages(continueWithoutBrokerPayload({ messages: [first, second] }, [one, two], [one, two, warning], "openai-completions"));
  expect(result[0]).toBe(first); expect(result[1]).toBe(second);
});

test("Anthropic repair is confined to owned user and tool_result blocks, with schemas and ordinary quotations unchanged", () => {
  const user = { role: "user", content: [{ type: "text", text: "Explain my screenshot." }, { type: "image", source: { type: "base64", media_type: "image/png", data: "USER_IMAGE" } }] };
  const quoted = { role: "user", content: quote.content };
  const other = { type: "tool_result", tool_use_id: "other", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "OTHER_IMAGE" } }] };
  const tools = [{ name: "other", description: body, input_schema: { type: "object" } }];
  const original = [originalUser, source, read, quote];
  const payload = { tools, system: "Keep this user-written quotation: " + body, messages: [user, { role: "user", content: body },
    { role: "assistant", content: [{ type: "tool_use", id: "source-read", name: "read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "source-read", content: body }, other] }, quoted] };
  const result = continueWithoutBrokerPayload(payload, original, [...withoutBrokerInstructions(original), warning], "anthropic-messages");
  const output = messages(result);
  expect(output).toContain(user); expect(output).toContain(quoted);
  expect(JSON.stringify(output)).toContain("OTHER_IMAGE");
  const toolResult = output.flatMap(item => Array.isArray(item.content) ? item.content : []).filter(object).find(item => item.tool_use_id === "source-read");
  expect(JSON.stringify(toolResult)).not.toContain(body);
  expect(object(result) && result.tools).toBe(tools); expect(object(result) && result.system).toBe(payload.system);
});

test("unknown schemas are not rewritten by recursively replacing coincidental strings", () => {
  const payload = { tools: [{ description: body }], metadata: { title: body }, custom: { opaque: body } };
  expect(continueWithoutBrokerPayload(payload, [source], [warning], "unknown-api")).toBe(payload);
});

test("Responses keeps native input_image and reasoning items while replacing the exact source call output", () => {
  const user = { role: "user", content: [{ type: "input_text", text: "Explain my screenshot." }, { type: "input_image", image_url: "data:image/png;base64,USER_IMAGE", detail: "original" }] };
  const reasoning = { type: "reasoning", id: "reasoning-id", encrypted_content: "PRIVATE_PROVIDER_SIGNATURE" };
  const sourceRead = { ...read, toolCallId: "source-read|provider-item" };
  const original = [originalUser, source, sourceRead, quote];
  const payload = { instructions: body, tools: [{ description: body }], input: [user, { role: "user", content: [{ type: "input_text", text: body }] },
    reasoning, { type: "function_call_output", call_id: "source-read", output: body }, { role: "user", content: quote.content }] };
  const result = continueWithoutBrokerPayload(payload, original, [...withoutBrokerInstructions(original), warning], "openai-responses");
  const output = messages(result, "input");
  expect(output).toContain(user); expect(output).toContain(reasoning);
  expect(output.find(item => item.call_id === "source-read")?.output).not.toContain(body);
  expect(output).toContain(payload.input[4]);
  expect(object(result) && result.instructions).toBe(body); expect(object(result) && result.tools).toBe(payload.tools);
});

test("Google functionResponse cleanup keeps native images, thought signatures and unowned tool declarations", () => {
  const user = { role: "user", parts: [{ text: "Explain my screenshot." }, { inlineData: { mimeType: "image/png", data: "USER_IMAGE" } }] };
  const model = { role: "model", parts: [{ functionCall: { name: "read", args: {}, id: "source-read" }, thoughtSignature: "KEEP_SIGNATURE" }] };
  const original = [originalUser, source, read, quote];
  const payload = { config: { systemInstruction: body, tools: [{ description: body }] }, contents: [user, { role: "user", parts: [{ text: body }] },
    model, { role: "user", parts: [{ functionResponse: { id: "source-read", name: "read", response: { output: body }, parts: [{ inlineData: { mimeType: "image/png", data: "SOURCE_IMAGE" } }] } }] },
    { role: "user", parts: [{ text: quote.content }] }] };
  const result = continueWithoutBrokerPayload(payload, original, [...withoutBrokerInstructions(original), warning], "google-generative-ai");
  const output = messages(result, "contents");
  expect(output).toContain(user); expect(output).toContain(model); expect(output).toContain(payload.contents[4]);
  expect(JSON.stringify(output.find(item => Array.isArray(item.parts) && item.parts.some(part => object(part) && object(part.functionResponse))))).not.toContain(body);
  expect(JSON.stringify(output)).not.toContain("SOURCE_IMAGE"); expect(object(result) && result.config).toBe(payload.config);
});

test("Bedrock changes only source toolResult blocks and retains ordinary image bytes", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const user = { role: "user", content: [{ text: "Explain my screenshot." }, { image: { format: "png", source: { bytes } } }] };
  const original = [{ ...originalUser, content: [{ type: "text" as const, text: "Explain my screenshot." }, image("AQID")] }, source, read, quote];
  const payload = { system: [{ text: body }], messages: [user, { role: "user", content: [{ text: body }] },
    { role: "user", content: [{ toolResult: { toolUseId: "source-read", content: [{ text: body }], status: "success" } }] },
    { role: "user", content: [{ text: quote.content }] }] };
  const result = continueWithoutBrokerPayload(payload, original, [...withoutBrokerInstructions(original), warning], "bedrock-converse-stream");
  const output = messages(result);
  expect(output).toContain(user); expect(output).toContain(payload.messages[3]); expect(object(result) && result.system).toBe(payload.system);
  const tool = output.flatMap(item => Array.isArray(item.content) ? item.content : []).filter(object).find(item => object(item.toolResult));
  expect(object(tool?.toolResult) && tool.toolResult.status).toBe("error");
  expect(JSON.stringify(tool)).not.toContain(body);
});

test("Pi message protocol retains array-shaped tool output and user image blocks", () => {
  const nativeUser = { role: "user", content: originalUser.content };
  const original = [originalUser, source, read, quote];
  const payload = { model: { api: "pi-messages" }, context: { tools: [{ description: body }], messages: [nativeUser,
    { role: "user", content: body }, { role: "toolResult", toolCallId: "source-read", toolName: "read", content: [{ type: "text", text: body }] },
    { role: "user", content: quote.content }] } };
  const result = continueWithoutBrokerPayload(payload, original, [...withoutBrokerInstructions(original), warning], "pi-messages");
  if (!object(result) || !object(result.context)) throw new Error("Expected Pi context");
  const output = messages(result.context);
  expect(output).toContain(nativeUser); expect(output).toContain(payload.context.messages[3]);
  expect(Array.isArray(output.find(item => item.toolCallId === "source-read")?.content)).toBe(true);
  expect(result.context.tools).toBe(payload.context.tools);
});

test("a source-owned image is withheld without losing another native tool image or the user's image", () => {
  const sourceImage = { ...read, content: [{ type: "text" as const, text: body }, image("SOURCE_IMAGE")] };
  const localImage: AgentMessage = { role: "toolResult", toolCallId: "local", toolName: "read", content: [image("LOCAL_IMAGE")] };
  const original = [originalUser, sourceImage, localImage];
  const payload = { messages: [{ role: "user", content: [{ type: "text", text: "Explain my screenshot." }, { type: "image_url", image_url: { url: "data:image/png;base64,USER_IMAGE" } }] },
    { role: "tool", tool_call_id: "source-read", content: body }, { role: "tool", tool_call_id: "local", content: "(see attached image)" },
    { role: "user", content: [{ type: "text", text: "Attached image(s) from tool result:" },
      { type: "image_url", image_url: { url: "data:image/png;base64,SOURCE_IMAGE" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,LOCAL_IMAGE" } }] }] };
  const result = continueWithoutBrokerPayload(payload, original, [...withoutBrokerInstructions(original), warning], "openai-completions");
  expect(JSON.stringify(result)).not.toContain("SOURCE_IMAGE");
  expect(JSON.stringify(result)).toContain("LOCAL_IMAGE"); expect(JSON.stringify(result)).toContain("USER_IMAGE");
});

test("a repeated fallback retains its existing warning instead of silently dropping it", () => {
  const original = [originalUser, warning], safe = [...withoutBrokerInstructions(original), warning];
  const payload = { messages: [{ role: "user", content: "Explain my screenshot." }, { role: "user", content: warning.content }] };
  const once = continueWithoutBrokerPayload(payload, original, safe, "openai-completions");
  const twice = continueWithoutBrokerPayload(once, original, safe, "openai-completions");
  expect(messages(twice).filter(item => sourceMessageText(item.content as MessageContent) === warning.content)).toHaveLength(1);
});

test("equal-size swapped native user and source slots retain the actual user exactly once", () => {
  const original = [originalUser, source];
  const nativeUser = { role: "user", content: [{ type: "text", text: "Explain my screenshot." },
    { type: "image_url", image_url: { url: "data:image/png;base64,USER_IMAGE" } }] };
  const payload = { messages: [{ role: "user", content: body }, nativeUser] };
  const result = messages(continueWithoutBrokerPayload(payload, original, [...withoutBrokerInstructions(original), warning], "openai-completions"));
  expect(result).toContain(nativeUser);
  expect(result.filter(message => JSON.stringify(message).includes("USER_IMAGE"))).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain(body);
});

for (const api of ["anthropic-messages", "bedrock-converse-stream"] as const) test(`${api} mixed tool/source/user blocks retain the user quote once and no Skill body`, () => {
  const isAnthropic = api === "anthropic-messages";
  const sourceRead = isAnthropic ? { type: "tool_result", tool_use_id: "source-read", content: body }
    : { toolResult: { toolUseId: "source-read", content: [{ text: body }], status: "success" } };
  const localResult = isAnthropic ? { type: "tool_result", tool_use_id: "local", content: "Unrelated local output." }
    : { toolResult: { toolUseId: "local", content: [{ text: "Unrelated local output." }], status: "success" } };
  const text = (value: unknown) => isAnthropic ? { type: "text", text: value } : { text: value };
  const original = [source, read, quote];
  const payload = { messages: [{ role: "user", content: [sourceRead, localResult, text("MODIFIED PRIVATE SOURCE BODY"), text(quote.content)] }] };
  const result = messages(continueWithoutBrokerPayload(payload, original, [...withoutBrokerInstructions(original), warning], api));
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("MODIFIED PRIVATE SOURCE BODY");
  expect(serialized.split(String(quote.content)).length - 1).toBe(1);
  expect(serialized.split(body).length - 1).toBe(1);
  expect(result.flatMap(message => Array.isArray(message.content) ? message.content : [])).toContain(localResult);
});

test("the whole preparation deadline completes for a producer that never settles and aborts its signal", async () => {
  const parent = new AbortController();
  let signal: AbortSignal | undefined;
  const started = Date.now();
  await expect(withPreparationDeadline(parent.signal, current => { signal = current; return new Promise<never>(() => {}); }, 15))
    .rejects.toMatchObject({ code: "SOURCE_PREPARATION_TIMEOUT" });
  expect(signal?.aborted).toBe(true); expect(parent.signal.aborted).toBe(false);
  expect(Date.now() - started).toBeLessThan(1000);
});

test("user cancellation wins without waiting for an uncooperative producer", async () => {
  const parent = new AbortController();
  const operation = withPreparationDeadline(parent.signal, () => new Promise<never>(() => {}), 1000);
  parent.abort();
  await expect(operation).rejects.toMatchObject({ code: "SOURCE_ACTIVATION_CANCELLED" });
});

test("late source completion after the deadline cannot change the settled result", async () => {
  const parent = new AbortController(), producer = Promise.withResolvers<string>();
  const operation = withPreparationDeadline(parent.signal, () => producer.promise, 15);
  await expect(operation).rejects.toMatchObject({ code: "SOURCE_PREPARATION_TIMEOUT" });
  producer.resolve("late successful material");
  await expect(operation).rejects.toMatchObject({ code: "SOURCE_PREPARATION_TIMEOUT" });
});
