import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFakeProvider } from "../packages/context-broker/scripts/context-broker-e2e-fixture.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = await mkdtemp("/tmp/broker-ui-selector-");
const socket = join(base, "control.sock");
const daemonSocket = join(base, "daemon.sock");
const ternDir = join(base, "tern");
const env = { ...process.env, TERN_CONFIG_DIR: ternDir, TERN_DAEMON_SOCKET: daemonSocket, STENCIL_LOG_DIR: join(base, "logs") };
const shellQuote = t => `'${t.replaceAll("'", "'\\''")}'`;
const run = (f, a, o = {}) => { const r = spawnSync(f, a, { cwd: base, env, encoding: "utf8", timeout: 30_000, ...o }); if (r.status !== 0) throw new Error(`${f}: ${r.stdout || r.stderr || r.error}`); return r.stdout; };
const ctl = (...a) => JSON.parse(run("tern", ["ctl", "--control", socket, ...a]));
const pause = ms => new Promise(r => setTimeout(r, ms));
const until = async (l, p, t = 30_000) => { const d = Date.now() + t; while (Date.now() < d) { if (await p()) return; await pause(150); } throw new Error("probe timeout: " + l); };
const stop = c => { if (!c?.pid || c.exitCode !== null || c.signalCode !== null) return; c.kill("SIGTERM"); setTimeout(() => { try { c.kill("SIGKILL"); } catch {} }, 2_000); };
const out = { base, steps: {} };
async function capture(label, sel) {
  let resp;
  try { resp = sel ? ctl("tree", sel) : ctl("tree"); } catch (e) { out.steps[label] = { sel: sel ?? "(whole)", error: e.message }; return; }
  await writeFile(join(base, `${label}.json`), JSON.stringify(resp, null, 2));
  const nodes = resp?.nodes;
  const summary = { sel: sel ?? "(whole)", keys: Object.keys(resp || {}), count: resp?.count, nodesType: Array.isArray(nodes) ? "array" : typeof nodes, nodesLen: Array.isArray(nodes) ? nodes.length : null };
  if (Array.isArray(nodes) && nodes.length) summary.first = { tag: nodes[0]?.tag, class: nodes[0]?.class, text: nodes[0]?.text, hasChildren: !!nodes[0]?.children };
  out.steps[label] = summary;
}
let daemon, tern;
try {
  await writeFakeProvider(base);
  const agentDir = join(base, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "config.yml"), "startup:\n  setupWizard: false\n  checkUpdate: false\ncompaction:\n  enabled: false\n");
  await mkdir(join(ternDir, "plugin-data/context-broker"), { recursive: true });
  await writeFile(join(ternDir, "plugin-data/context-broker/config.json"), JSON.stringify({ config: join(base, "broker.yml"), agentDir }));
  await mkdir(join(ternDir, "omp"), { recursive: true });
  await writeFile(join(ternDir, "omp/state.json"), JSON.stringify({ managed: false, checked: 0, no_build: false, offered: true }) + "\n");
  const release = join(base, "release");
  await mkdir(release);
  const archive = join(base, "tern-context-broker.tar.gz");
  run("tar", ["-czf", archive, "-C", join(root, "packages/tern-context-broker"), "plugin.toml", "window.luau", "composer.luau", "query", "README.md", "LICENSE"]);
  run("tar", ["-xzf", archive, "-C", release]);
  const omp = process.env.BROKER_UI_OMP ?? "omp";
  const launcher = join(base, "start.sh");
  const launchArgs = [omp, "--no-extensions", "--no-skills", "--no-rules", "--no-title", "--no-tools", "--session-dir", join(base, "sessions"), "-e", join(base, "fake-provider.mjs"), "-e", process.env.BROKER_UI_EXTENSION ?? join(root, "packages/context-broker/src/index.ts"), "--model", "context-broker-e2e/fake"];
  await writeFile(launcher, `#!/bin/sh\nexport PI_CODING_AGENT_DIR=${shellQuote(agentDir)}\nexec ${launchArgs.map(shellQuote).join(" ")}\n`, { mode: 0o755 });
  daemon = spawn("tern", ["daemon", "--socket", daemonSocket], { cwd: base, env, stdio: ["ignore", "ignore", "pipe"] });
  await until("daemon socket", async () => { try { return (await stat(daemonSocket)).isSocket(); } catch { return false; } });
  tern = spawn("tern", ["--control", socket, "--out", join(base, "shots")], { cwd: base, env, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((res, rej) => {
    const dl = setTimeout(() => rej(new Error("control not ready")), 30_000);
    let logs = "";
    tern.stderr.on("data", d => { logs += d; if (logs.includes(`control on ${socket}`)) { clearTimeout(dl); res(); } });
    tern.on("error", rej);
    tern.on("exit", c => { clearTimeout(dl); rej(new Error("tern exited: " + c)); });
  });
  run("tern", ["plugin", "install", release, "--json"]);
  ctl("ready");
  ctl("run", shellQuote(launcher));
  await until("idle composer", async () => {
    const resp = ctl("tree");
    const all = [];
    const rec = n => { if (!n) return; if (Array.isArray(n)) return n.forEach(rec); all.push(n); if (n.children) rec(n.children); };
    rec(resp?.tree);
    return all.some(n => n.text === "What are we cooking?");
  }, 60_000);
  // Now exercise selector variants
  const sels = [
    "01-whole",
    "02-sf-main",
    "03-sf-main-sf-tool",
    "04-sf-tool",
    "05-sf-overlay",
    "06-sf-editor",
    "07-sf-text",
    "08-attr-title-stop",
    "09-attr-data-role-stop",
  ];
  const inputs = [null, ".sf-main", ".sf-main .sf-tool", ".sf-tool", ".sf-overlay", ".sf-editor", ".sf-text", '[title*="Stop"]', '[data-role="omp.composer.stop"]'];
  for (let i = 0; i < sels.length; i++) {
    await capture(sels[i], inputs[i]);
  }
  await writeFile(join(base, "summary.json"), JSON.stringify(out, null, 2));
  console.log("PROBE_OK", base);
} catch (e) {
  await writeFile(join(base, "error.json"), JSON.stringify({ error: e.message, stack: e.stack }, null, 2));
  console.error("PROBE_FAIL", base, e.message);
  process.exitCode = 1;
} finally {
  try { if (tern && tern.exitCode === null) ctl("quit"); } catch {}
  stop(tern); stop(daemon);
  await writeFile(join(base, "cleanup.json"), JSON.stringify({ stopped: true }, null, 2));
}
