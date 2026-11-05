import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { startRpc } from "../packages/context-broker/scripts/context-broker-rpc-harness.mjs";
import { isolatedEnv, runCommand, writeFakeProvider } from "../packages/context-broker/scripts/context-broker-e2e-fixture.mjs";
import { createNotionFixture, canary } from "./notion-integration-fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--host" || !["pi", "omp"].includes(args[1]))) throw new Error("Usage: node scripts/verify-source-dependencies.mjs [--host pi|omp]");
const hosts = args.length ? [args[1]] : ["omp", "pi"];
const base = await mkdtemp(join(tmpdir(), "broker-source-dependencies-"));
console.log(`Source dependency workspace retained: ${base}`);
const extension = process.env.BROKER_DEPENDENCY_EXTENSION ?? join(root, "packages/context-broker/src/index.ts");
const provider = await writeFakeProvider(base);
const skillRoot = join(base, "skills");
await mkdir(join(skillRoot, "local-one"), { recursive: true });
await writeFile(join(skillRoot, "local-one/SKILL.md"), "---\nname: local-one\ndescription: Local dependency isolation\nautoload:\n  enabled: true\n---\nLOCAL_DEPENDENCY_ISOLATION_BODY\n");
const captures = async file => {
  try { return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
};
const results = [];
for (const host of hosts) {
  for (const scenario of ["missing-command", "api-unavailable", "incompatible-list-schema", "malformed-source-output", "auth-required"]) {
    const directory = join(base, host, scenario);
    const agentDir = join(directory, "agent");
    await mkdir(agentDir, { recursive: true });
    const fixture = await createNotionFixture(join(directory, "fixture"));
    const config = join(directory, "config.json");
    const capture = join(directory, "provider.jsonl");
    const missingCommand = join(directory, "source-cli");
    const sourceCalls = join(directory, "source-calls.jsonl");
    const compatibleCatalog = join(directory, "compatible-catalog");
    const source = { id: "remote", type: "notion", command: [missingCommand] };
    await writeFile(config, JSON.stringify({ skillRoots: [skillRoot], sources: [source, { id: "local", type: "filesystem", roots: [skillRoot] }, { id: "healthy", type: "notion", command: fixture.command, cacheDir: join(directory, "cache") }] }));
    if (scenario !== "missing-command") {
      // Custom commands are validated at their actual list boundary. Doctor does
      // not assume that an arbitrary command implements the bundled CLI doctor.
      await writeFile(missingCommand, [
        "#!" + process.execPath,
        'import { appendFileSync, existsSync } from "node:fs";',
        "const scenario=" + JSON.stringify(scenario) + ";",
        "const sourceCalls=" + JSON.stringify(sourceCalls) + ";",
        "const compatibleCatalog=" + JSON.stringify(compatibleCatalog) + ";",
        "const argv=process.argv.slice(2);",
        'appendFileSync(sourceCalls, JSON.stringify(argv) + "\\n");',
        'if(scenario==="malformed-source-output"){console.log("invalid-json");}',
        'else if(scenario==="incompatible-list-schema"){',
        ' const selected=argv.includes("--default-view")||argv.includes("--view");',
        ' const result={ok:true,scope:"0".repeat(64),source:"notion",fetched_at:Date.now(),databases:[],records:[],count:0,coverage:{method:selected?"explicit_view":"search_and_registered",exhaustive:true,queried_data_sources:[],failed_sources:[],search_index_limited:false},freshness:{policy:"max_age",validated_at:new Date().toISOString(),age_ms:0,max_age_ms:60000,stale:false},...(selected?{view:null,view_selection:"none",view_query:null}:{})};',
        ' if(!existsSync(compatibleCatalog))result.skills=[];',
        ' console.log(JSON.stringify(result));',
        '}else{console.log(JSON.stringify({ok:false,error:{code:scenario==="api-unavailable"?"NOTION_UNAVAILABLE":"AUTH_REQUIRED"}}));process.exitCode=1;}',
      ].join("\n") + "\n");
      await chmod(missingCommand, 0o700);
    }
    const env = isolatedEnv({ base: directory, agentDir, CONTEXT_BROKER_HOST: host, CONTEXT_BROKER_CONFIG: config, CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: capture,
      BROKER_E2E_PROCESS_LEDGER: join(directory, "owned-processes.jsonl"),
      // Resolve nested bundled-CLI Node before HOME isolation can activate a Volta shim.
      PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
      NTN_SKILLS_HOME: join(directory, "state"), NTN_SKILLS_CONFIG_HOME: join(directory, "cli-config"), NTN_SKILLS_CACHE_HOME: join(directory, "cli-cache") });
    const args = ["--no-extensions", "--no-skills", "--no-tools", "--session-dir", join(directory, "sessions"), "-e", provider, "-e", extension, "--model", "context-broker-e2e/fake", "--system-prompt", "Only output OK.", ...(host === "omp" ? ["--no-title", "--no-rules"] : [])];
    const expectedCode = { "missing-command": "SOURCE_COMMAND_UNAVAILABLE", "api-unavailable": "NOTION_UNAVAILABLE", "incompatible-list-schema": "SOURCE_RESPONSE_INVALID", "malformed-source-output": "SOURCE_RESPONSE_INVALID", "auth-required": "AUTH_REQUIRED" }[scenario];
    const rpc = await startRpc({ host, cwd: directory, env, args });
    let stage = "ordinary";
    let schemaRepairValidated;
    try {
      await rpc.prompt("Reply OK.");
      stage = "explicit-local";
      await rpc.prompt("$local/local-one Use the local instructions.");
      stage = "healthy-remote";
      await rpc.prompt("$ui-alpha@healthy Use the healthy remote instructions.");
      assert.equal((await captures(capture)).length, 3, "Ordinary chat and available sources must dispatch");
      assert.match(JSON.stringify((await captures(capture))[1]), /LOCAL_DEPENDENCY_ISOLATION_BODY/);
      assert.match(JSON.stringify((await captures(capture))[2]), new RegExp(canary));
      let expectedRequests = 3;
      for (const prompt of ["$example@remote Use the unavailable source.", "/skill:remote-example"]) {
        stage = "unknown-selection";
        const callsBefore = (await captures(fixture.callsPath)).length;
        await rpc.prompt(prompt);
        const requests = await captures(capture);
        assert.equal(requests.length, ++expectedRequests, "Unknown literal selection must dispatch unchanged once");
        assert.ok(JSON.stringify(requests.at(-1)).includes(prompt), "Unknown selection retains original user material");
        const calls = (await captures(fixture.callsPath)).slice(callsBefore);
        assert.equal(calls.filter(call => ["read", "export"].includes(call.command)).length, 0, "Unknown selection never activates a source");
      }
      stage = "doctor";
      await rpc.prompt("/context-broker doctor");
      assert.match(JSON.stringify(rpc.frames), new RegExp(expectedCode), "Startup/doctor must preserve the actual custom source failure");
      if (scenario !== "missing-command") {
        const calls = await captures(sourceCalls);
        assert.ok(calls.some(argv => argv[0] === "list"), "The invalid source response must reach normal discovery");
        assert.ok(calls.every(argv => !(argv[0] === "ctl" && argv[1] === "doctor")), "Custom commands must not be treated as bundled CLI doctor implementations");
      }
      if (scenario === "incompatible-list-schema") {
        stage = "compatible-source";
        await writeFile(compatibleCatalog, "Remove only the incompatible legacy skills field.\n");
        await rpc.prompt("/context-broker refresh");
        const frameStart = rpc.frames.length;
        await rpc.prompt("/context-broker doctor");
        const doctor = rpc.frames.slice(frameStart).findLast(frame => frame.type === "extension_ui_request"
          && frame.method === "notify" && frame.message?.startsWith("Context Broker Doctor"));
        assert.ok(doctor, "A repaired catalog must be independently diagnosed");
        assert.match(doctor.message, /Config diagnostics: ok/, "Removing only the unsupported catalog field must recover the source");
        schemaRepairValidated = true;
      }
      if (scenario === "missing-command") {
        stage = "repaired-source";
        await writeFile(missingCommand, `#!${process.execPath}\nprocess.argv.splice(1,1,${JSON.stringify(fixture.command[1])},'--state',${JSON.stringify(fixture.statePath)});\nawait import(${JSON.stringify(fixture.command[1])});\n`);
        await chmod(missingCommand, 0o755);
        await rpc.prompt("/context-broker refresh");
        await rpc.prompt("$ui-alpha@remote Use the recovered source.");
        assert.equal((await captures(capture)).length, ++expectedRequests, "Refresh must recover a repaired source in the same process");
        assert.match(JSON.stringify((await captures(capture)).at(-1)), new RegExp(canary));
      }
      stage = "ordinary-after-selections";
      await rpc.prompt("Reply OK after the unknown selections.");
      const finalRequests = (await captures(capture)).length;
      assert.equal(finalRequests, ++expectedRequests);
      results.push({ host, scenario, boundary: "custom-command-discovery", expectedCode, providerRequests: finalRequests,
        ...(schemaRepairValidated ? { schemaRepairValidated } : {}), passed: true });
    } catch (error) {
      results.push({ host, scenario, expectedCode, stage, providerRequests: (await captures(capture)).length,
        passed: false, error: { code: error.code ?? error.name, message: error.message } });
      throw error;
    } finally {
      await rpc.stop();
      await writeFile(join(directory, "rpc.json"), JSON.stringify(rpc.frames, null, 2) + "\n");
      await writeFile(join(directory, "rpc-lifecycle.json"), JSON.stringify(rpc.lifecycle, null, 2) + "\n");
      await writeFile(join(base, "results.json"), JSON.stringify(results, null, 2) + "\n");
    }
    if (scenario === "missing-command") {
      // Same missing executable that previously terminated an ordinary print-mode prompt.
      await writeFile(config, JSON.stringify({ skillRoots: [skillRoot], sources: [{ ...source, command: [join(directory, "still-missing")] }] }));
      const printCapture = join(directory, "print-provider.jsonl");
      const printed = await runCommand(host, ["-p", ...args, "Reply OK."], { cwd: directory, env: { ...env, CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: printCapture } });
      assert.match(printed.stdout, /OK/);
      assert.equal((await captures(printCapture)).length, 1);
    }
  }
}
await writeFile(join(base, "results.json"), JSON.stringify(results, null, 2));
console.log(`Source dependency verification passed: missing command/API/incompatible catalog/malformed source/auth, local and healthy sources, unknown literal pass-through without activation, refresh recovery and ordinary print. Custom command doctor probing is not part of this boundary. Evidence: ${base}`);
