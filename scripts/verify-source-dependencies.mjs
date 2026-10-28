import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { startRpc } from "../packages/context-broker/scripts/context-broker-rpc-harness.mjs";
import { isolatedEnv, runCommand, writeFakeProvider } from "../packages/context-broker/scripts/context-broker-e2e-fixture.mjs";
import { createNotionFixture, canary } from "./notion-integration-fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const base = await mkdtemp(join(tmpdir(), "broker-source-dependencies-"));
const extension = process.env.BROKER_DEPENDENCY_EXTENSION ?? join(root, "packages/context-broker/src/index.ts");
const provider = await writeFakeProvider(base);
const skillRoot = join(base, "skills");
await mkdir(join(skillRoot, "local-one"), { recursive: true });
await writeFile(join(skillRoot, "local-one/SKILL.md"), "---\nname: local-one\ndescription: Local dependency isolation\nautoload:\n  enabled: true\n---\nLOCAL_DEPENDENCY_ISOLATION_BODY\n");
const fakeNtn = join(base, "ntn");
const ntnState = join(base, "ntn-state.json");
await writeFile(fakeNtn, `#!${process.execPath}\nimport {readFileSync} from 'node:fs';\nconst state=JSON.parse(readFileSync(${JSON.stringify(ntnState)},'utf8'));\nif(process.argv[2]==='--version')console.log(state.version);\nelse if(process.argv[2]==='api'&&process.argv[3]==='--help')console.log(state.help);\nelse console.log(JSON.stringify({object:'error',code:'unauthorized',message:'fixture auth required'}));\n`);
await chmod(fakeNtn, 0o755);
const setNtn = (version = "ntn 0.22.12", help = "--notion-version") => writeFile(ntnState, JSON.stringify({ version, help }));
await setNtn();
const captures = async file => {
  try { return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
};
const results = [];
for (const host of ["omp", "pi"]) {
  for (const scenario of ["missing-command", "missing-ntn", "old-ntn", "missing-capability", "auth-required"]) {
    const directory = join(base, host, scenario);
    const agentDir = join(directory, "agent");
    await mkdir(agentDir, { recursive: true });
    const fixture = await createNotionFixture(join(directory, "fixture"));
    const config = join(directory, "config.json");
    const capture = join(directory, "provider.jsonl");
    const missingCommand = join(directory, "source-cli");
    const source = { id: "remote", type: "notion", ...(scenario === "missing-command" ? { command: [process.execPath, missingCommand] } : {}) };
    // A missing executable yields SOURCE_COMMAND_UNAVAILABLE rather than Node's non-JSON exit.
    if (scenario === "missing-command") source.command = [missingCommand];
    await writeFile(config, JSON.stringify({ skillRoots: [skillRoot], sources: [source, { id: "local", type: "filesystem", roots: [skillRoot] }, { id: "healthy", type: "notion", command: fixture.command, cacheDir: join(directory, "cache") }] }));
    await setNtn(scenario === "old-ntn" ? "ntn 0.21.0" : "ntn 0.22.12", scenario === "missing-capability" ? "api help without override" : "--notion-version");
    const env = isolatedEnv({ base: directory, agentDir, CONTEXT_BROKER_HOST: host, CONTEXT_BROKER_CONFIG: config, CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: capture,
      // Resolve nested bundled-CLI Node before HOME isolation can activate a Volta shim.
      PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
      NTN_SKILLS_NTN_BIN: scenario === "missing-ntn" ? join(base, "absent-ntn") : fakeNtn,
      NTN_SKILLS_HOME: join(directory, "state"), NTN_SKILLS_CONFIG_HOME: join(directory, "cli-config"), NTN_SKILLS_CACHE_HOME: join(directory, "cli-cache") });
    const args = ["--no-extensions", "--no-skills", "--no-tools", "--session-dir", join(directory, "sessions"), "-e", provider, "-e", extension, "--model", "context-broker-e2e/fake", "--system-prompt", "Only output OK.", ...(host === "omp" ? ["--no-title", "--no-rules"] : [])];
    const expectedCode = { "missing-command": "SOURCE_COMMAND_UNAVAILABLE", "missing-ntn": "NTN_UNAVAILABLE", "old-ntn": "NTN_VERSION_UNSUPPORTED", "missing-capability": "NTN_VERSION_UNSUPPORTED", "auth-required": "AUTH_REQUIRED" }[scenario];
    const rpc = await startRpc({ host, cwd: directory, env, args });
    try {
      await rpc.prompt("Reply OK.");
      await rpc.prompt("$local/local-one Use the local instructions.");
      await rpc.prompt("$ui-alpha@healthy Use the healthy remote instructions.");
      assert.equal((await captures(capture)).length, 3, "Ordinary chat and available sources must dispatch");
      assert.match(JSON.stringify((await captures(capture))[1]), /LOCAL_DEPENDENCY_ISOLATION_BODY/);
      assert.match(JSON.stringify((await captures(capture))[2]), new RegExp(canary));
      let expectedRequests = 3;
      for (const prompt of ["$example@remote Use the unavailable source.", "/skill:remote-example"]) {
        const callsBefore = (await captures(fixture.callsPath)).length;
        await rpc.prompt(prompt);
        const requests = await captures(capture);
        assert.equal(requests.length, ++expectedRequests, "Unknown literal selection must dispatch unchanged once");
        assert.ok(JSON.stringify(requests.at(-1)).includes(prompt), "Unknown selection retains original user material");
        const calls = (await captures(fixture.callsPath)).slice(callsBefore);
        assert.equal(calls.filter(call => ["read", "export"].includes(call.command)).length, 0, "Unknown selection never activates a source");
      }
      await rpc.prompt("/context-broker doctor");
      assert.match(JSON.stringify(rpc.frames), new RegExp(expectedCode), "Doctor/startup must identify the dependency failure");
      if (scenario === "missing-command") {
        await writeFile(missingCommand, `#!${process.execPath}\nprocess.argv.splice(1,1,${JSON.stringify(fixture.command[1])},'--state',${JSON.stringify(fixture.statePath)});\nawait import(${JSON.stringify(fixture.command[1])});\n`);
        await chmod(missingCommand, 0o755);
        await rpc.prompt("/context-broker refresh");
        await rpc.prompt("$ui-alpha@remote Use the recovered source.");
        assert.equal((await captures(capture)).length, ++expectedRequests, "Refresh must recover a repaired source in the same process");
        assert.match(JSON.stringify((await captures(capture)).at(-1)), new RegExp(canary));
      }
      await rpc.prompt("Reply OK after the unknown selections.");
      const finalRequests = (await captures(capture)).length;
      assert.equal(finalRequests, ++expectedRequests);
      await writeFile(join(directory, "rpc.json"), JSON.stringify(rpc.frames, null, 2));
      results.push({ host, scenario, expectedCode, providerRequests: finalRequests, passed: true });
    } finally { await rpc.stop(); }
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
console.log(`Source dependency verification passed: missing command/ntn/version/capability/auth, local and healthy sources, unknown literal pass-through without activation, refresh recovery and ordinary print. Evidence: ${base}`);
