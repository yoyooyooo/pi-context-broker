import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, constants } from "node:fs";
import { access, open, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";

export function isolatedEnv({ base, agentDir, ...overrides }) {
  // Keep runtime lookup, but never inherit model credentials, host configuration,
  // NODE_OPTIONS, extension discovery flags, or the developer's home directory.
  const env = {
    PATH: process.env.PATH,
    HOME: base,
    USER: "context-broker-e2e",
    LOGNAME: "context-broker-e2e",
    LANG: "C.UTF-8",
    XDG_CONFIG_HOME: join(base, "xdg", "config"),
    XDG_STATE_HOME: join(base, "xdg", "state"),
    XDG_CACHE_HOME: join(base, "xdg", "cache"),
    XDG_DATA_HOME: join(base, "xdg", "data"),
    NTN_SKILLS_CONFIG_HOME: join(base, "ntn", "config"),
    NTN_SKILLS_HOME: join(base, "ntn", "state"),
    NTN_SKILLS_CACHE_HOME: join(base, "ntn", "cache"),
    NTN_SKILLS_DATA_HOME: join(base, "ntn", "data"),
    ...(process.env.BROKER_E2E_PROCESS_LEDGER ? { BROKER_E2E_PROCESS_LEDGER: process.env.BROKER_E2E_PROCESS_LEDGER } : {}),
    PI_CODING_AGENT_DIR: agentDir,
    OMP_CODING_AGENT_DIR: agentDir,
    ...overrides,
  };
  if (process.env.TMPDIR && !env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

const hostCommands = new Map();

export async function resolveHost(host) {
  if (hostCommands.has(host)) return hostCommands.get(host);
  let executable;
  for (const candidate of isAbsolute(host) ? [host] : (process.env.PATH ?? "").split(delimiter).map(dir => join(dir, host))) {
    try { await access(candidate, constants.X_OK); executable = resolve(candidate); break; }
    catch (error) { if (isAbsolute(host) || (error.code !== "ENOENT" && error.code !== "EACCES" && error.code !== "ENOTDIR")) throw error; }
  }
  if (!executable) throw new Error(`${host}: executable not found on PATH`);
  const prefix = async (path) => {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally { await handle.close(); }
  };
  const source = await prefix(executable);
  const voltaBin = join(process.env.VOLTA_HOME ?? join(homedir(), ".volta"), "bin");
  if (executable.startsWith(`${voltaBin}/`) || (source.startsWith("#!") && source.includes(`${voltaBin}/`))) {
    // Resolve shims with the real host environment before HOME is isolated.
    // A Volta shim under fixture HOME can recursively rediscover itself on PATH.
    executable = execFileSync(join(voltaBin, "volta"), ["which", basename(host)], {
      env: process.env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    await access(executable, constants.X_OK);
  }
  const script = await prefix(executable);
  // Keep the executable spelling: symlinks can select a shim's argv[0].
  // Only the simple Node shebang has an equivalent explicit-runtime argv.
  const command = /^#!(?:\/usr\/bin\/env node|\/[^\s]+\/node)\r?\n/.test(script)
    ? { file: process.execPath, prefix: [executable], path: executable, identity: await realpath(executable) }
    : { file: executable, prefix: [], path: executable, identity: await realpath(executable) };
  hostCommands.set(host, command);
  return command;
}

export async function spawnHost(host, args, options) {
  const command = await resolveHost(host);
  const child = spawn(command.file, [...command.prefix, ...args], { ...options, detached: process.platform !== "win32" });
  const ledger = options?.env?.BROKER_E2E_PROCESS_LEDGER;
  if (ledger) {
    const identity = { host, pid: child.pid, file: command.file, args: [...command.prefix, ...args], cwd: options.cwd };
    appendFileSync(ledger, JSON.stringify({ ...identity, event: "spawn", at: new Date().toISOString() }) + "\n");
    child.once("error", error => appendFileSync(ledger, JSON.stringify({ ...identity, event: "error", code: error.code, at: new Date().toISOString() }) + "\n"));
    child.once("close", (code, signal) => appendFileSync(ledger, JSON.stringify({ ...identity, event: "close", code, signal, observedExit: true, at: new Date().toISOString() }) + "\n"));
  }
  return child;
}

export function signalHost(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else if (child.pid) process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code === "ESRCH") return;
    if (error.code === "EPERM" && child.pid && child.exitCode === null && child.signalCode === null) {
      // Some hosts disallow process-group signals; this handle still owns its child.
      try { child.kill(signal); }
      catch (childError) { if (childError.code !== "ESRCH") throw childError; }
      return;
    }
    throw error;
  }
}

export async function runCommand(file, args, { cwd, env, timeoutMs = 120_000 }) {
  const child = await spawnHost(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let escalation;
    const timer = setTimeout(() => {
      timedOut = true;
      signalHost(child, "SIGTERM");
      escalation = setTimeout(() => signalHost(child, "SIGKILL"), 2_000);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => { clearTimeout(timer); clearTimeout(escalation); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (!timedOut && code === 0) resolve(result);
      else reject(new Error(`${file}: ${timedOut ? `timed out after ${timeoutMs}ms` : `exited (code=${code}, signal=${signal})`}; stdout: ${result.stdout}; stderr: ${result.stderr}`));
    });
  });
}

export function preserveTemp(path) {
  // Ephemeral CI runners discard these automatically; locally retain evidence.
  // Never permanently delete a user's temporary session files.
  console.log(`E2E evidence retained: ${path}`);
}

export async function writeFakeProvider(base) {
  const path = join(base, "fake-provider.mjs");
  await writeFile(path, `
import { appendFileSync } from "node:fs";

function stream(model, context) {
  const captureFile = process.env.CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE;
  if (!captureFile) throw new Error("Missing isolated provider context capture path");
  appendFileSync(captureFile, JSON.stringify({ model: model.id, context }) + "\\n");
  const output = {
    role: "assistant", content: [{ type: "text", text: "OK" }],
    api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now(),
  };
  const events = [
    { type: "start", partial: output },
    { type: "text_start", contentIndex: 0, partial: output },
    { type: "text_delta", contentIndex: 0, delta: "OK", partial: output },
    { type: "text_end", contentIndex: 0, content: "OK", partial: output },
    { type: "done", reason: "stop", message: output },
  ];
  let sent = false;
  return { push() {}, end() {}, result: async () => output,
    async *[Symbol.asyncIterator]() {
      if (sent) return;
      sent = true;
      for (const event of events) yield event;
    },
  };
}

export default function provider(pi) {
  pi.registerProvider("context-broker-e2e", {
    name: "Context Broker E2E Fixture", api: "context-broker-e2e-api",
    apiKey: "fixture-no-secret", baseUrl: "http://127.0.0.1",
    streamSimple: stream,
    models: [{ id: "fake", name: "Fixture", input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000, maxTokens: 4096 }],
  });
}
`);
  return path;
}
