import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startRpc } from "../packages/context-broker/scripts/context-broker-rpc-harness.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const model = "magpie/group/flash-free";
const base = await mkdtemp(join(tmpdir(), "broker-real-model-"));
const skillRoot = join(base, "skills");
const skill = join(skillRoot, "model-contract");
await mkdir(skill, { recursive: true });
const canary = "BROKER_REAL_MODEL_BODY_CANARY_78C4";
await writeFile(join(skill, "SKILL.md"), `---\nname: model-contract\ndescription: Ledger calculation verification contract\n---\n${canary}\nWhen the user asks to apply the ledger contract, calculate the sum of the integers in the request. Return exactly one line in this format: VIOLET-78C4|total=<sum>|checks=boundary,ownership. Include no other words. This format is defined only here.\n`);
const config = join(base, "broker.yml");
const overlay = join(base, "overlay.yml");
const capture = join(base, "evidence.jsonl");
const log = join(base, "decisions.jsonl");
await writeFile(config, `skillRoots:\n  - ${JSON.stringify(skillRoot)}\n`);
await writeFile(overlay, "startup:\n  setupWizard: false\n  checkUpdate: false\ncompaction:\n  enabled: false\n  keepRecentTokens: 256\n");
const extension = join(base, "capture.mjs");
await writeFile(extension, `import {appendFileSync} from "node:fs";
const canary=${JSON.stringify(canary)};
const count=v=>JSON.stringify(v).split(canary).length-1;
const guidanceCount=v=>JSON.stringify(v).split("<ntn-skills-guidance>").length-1;
const record=v=>appendFileSync(process.env.BROKER_REAL_CAPTURE,JSON.stringify(v)+"\\n");
// Capture only model selectors and fixture counts. Never persist URLs or headers.
const originalFetch=globalThis.fetch;
globalThis.fetch=async function(input,init){
  const raw=init?.body??(input instanceof Request?await input.clone().text():undefined);
  let body;
  try { if(typeof raw==="string") body=JSON.parse(raw); } catch {}
  if(body&&typeof body.model==="string"){
    if(body.model!=="group/flash-free"&&body.model!=="magpie/group/flash-free") throw new Error("Real-model verification rejected an unauthorized model selector");
    record({phase:"transport",wireModel:body.model,bodies:count(body)});
  }
  return originalFetch.call(this,input,init);
};
export default function(api){
 api.on("session_start",(_event,ctx)=>{
   const selected=ctx.model;
   if(selected?.provider!=="magpie"||selected?.id!=="group/flash-free")throw new Error("Wrong verification model selected");
   if(selected.compactionModel&&!["group/flash-free","magpie/group/flash-free"].includes(selected.compactionModel))throw new Error("Configured compaction target is outside the authorized free group");
   record({phase:"selected",model:"magpie/group/flash-free",compactionModel:selected.compactionModel??null});
 });
 api.on("context",(event,ctx)=>record({phase:"context",model:ctx.model.provider+"/"+ctx.model.id,bodies:count(event.messages),cliGuidance:guidanceCount(event.messages),summary:event.messages.some(m=>m.role==="compactionSummary")}));
 api.on("before_provider_request",(event,ctx)=>{if(event.payload?.model!=="group/flash-free")throw new Error("Wrong provider payload model");record({phase:"request",model:ctx.model.provider+"/"+ctx.model.id,wireModel:event.payload.model,bodies:count(event.payload),cliGuidance:guidanceCount(event.payload)});});
 api.on("after_provider_response",event=>record({phase:"response",status:event.status}));
 api.on("session_compact",event=>record({phase:"compact",fromExtension:event.fromExtension,summaryLength:event.compactionEntry.summary.length,summaryBodies:count(event.compactionEntry.summary)}));
}
`);
const sessionDir = join(base, "sessions");
await mkdir(sessionDir);
const evidence = async () => (await readFile(capture, "utf8")).trim().split("\n").map(line => JSON.parse(line));
let rpc;
try {
  rpc = await startRpc({ cwd: base, env: { ...process.env, CONTEXT_BROKER_CONFIG: config, CONTEXT_BROKER_HOST: "omp", CONTEXT_BROKER_LOG_FILE: log, BROKER_REAL_CAPTURE: capture }, args: ["--no-ui", "--no-extensions", "--no-skills", "--no-rules", "--no-title", "--no-tools", "--session-dir", sessionDir, "--config", overlay, "-e", join(root, "packages/context-broker/src/index.ts"), "-e", extension, "--model", model, "--smol", model, "--slow", model, "--plan", model, "--system-prompt", "Use the supplied skill instructions for requested tasks. Reply concisely."] });
  await rpc.command("set_auto_compaction", { enabled: false });
  for (const [numbers, expected] of [["17 and 25", 42], ["6 and 9", 15]]) {
    await rpc.prompt(`$model-contract Apply the ledger contract to ${numbers}.`);
    assert.equal((await rpc.command("get_last_assistant_text")).text?.trim(), `VIOLET-78C4|total=${expected}|checks=boundary,ownership`);
  }
  await rpc.prompt("Archive these neutral notes; respond only OK. " + "The ledger notes are ordinary archived context with no additional instructions. ".repeat(450));
  const compacted = await rpc.command("compact", { customInstructions: "Summarize the conversation accurately and briefly. Do not reproduce the full skill body." });
  assert.ok(compacted.summary && compacted.firstKeptEntryId);
  const after = await rpc.command("get_messages");
  assert.equal(JSON.stringify(after.messages).split(canary).length - 1, 0, "default compaction must remove the original full body in this scenario");
  await rpc.prompt("$model-contract Apply the ledger contract to 30 and 12.");
  assert.equal((await rpc.command("get_last_assistant_text")).text?.trim(), "VIOLET-78C4|total=42|checks=boundary,ownership");
  const observed = await evidence();
  const requests = observed.filter(row => row.phase === "request");
  assert.ok(requests.every(row => row.model === model && row.bodies === 1 && row.cliGuidance === 1), "each actual model request must include exactly one Skill body and CLI guidance block");
  assert.ok(observed.some(row => row.phase === "compact" && row.fromExtension === false && row.summaryBodies === 0));
  const transport = observed.filter(row => row.phase === "transport");
  assert.ok(transport.every(row => ["group/flash-free", model].includes(row.wireModel)));
  const decisions = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(decisions.map(row => [row.decision, row.reason]), [["inject", "matched"], ["skip", "already-loaded"], ["inject", "matched"]]);
  const result = { model, verified: ["first instruction use", "repeat without duplicate body", "real default summarizer", "body removed by compaction", "reinjection and instruction use after compaction", "one default CLI guidance block before and after compaction"], requests: requests.length, transportRequests: transport.length, skillBodyCountPerRequest: requests.map(row => row.bodies), cliGuidanceCountPerRequest: requests.map(row => row.cliGuidance), summaryFromExtension: false };
  await writeFile(join(base, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (rpc) await rpc.stop();
  console.log(`Real-model evidence retained: ${base}`);
}
