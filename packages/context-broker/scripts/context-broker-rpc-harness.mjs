import { signalHost, spawnHost } from "./context-broker-e2e-fixture.mjs";
import { createInterface } from "node:readline";

// Native host RPC uses newline-delimited JSON. readline has no 64 KiB frame limit.
export async function startRpc({ host = "omp", args = [], cwd, env = process.env }) {
  const timeoutMs = 120_000;
  const secretValues = Object.entries(env)
    .filter(([key, value]) => /(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL)/i.test(key) && typeof value === "string" && value.length >= 4)
    .map(([, value]) => value);
  const redact = (text) => secretValues.reduce((result, value) => result.split(value).join("[redacted]"), String(text));
  const child = await spawnHost(host, ["--mode", "rpc", ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const frames = [];
  const pending = new Map();
  const eventWaiters = new Set();
  let sequence = 0;
  let failure;
  let stopping = false;
  let stopped = false;
  let stderr = "";
  let escalation;
  const terminate = () => {
    signalHost(child, "SIGTERM");
    escalation ??= setTimeout(() => signalHost(child, "SIGKILL"), 2_000);
  };
  const diagnostic = () => stderr ? `\nstderr: ${redact(stderr)}` : "";
  const fail = (error) => {
    failure ??= error;
    for (const waiter of pending.values()) waiter.reject(failure);
    pending.clear();
    for (const waiter of eventWaiters) waiter.reject(failure);
    eventWaiters.clear();
  };
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let frame;
    try { frame = JSON.parse(line); }
    catch { fail(new Error(`${host}: non-JSON RPC stdout${diagnostic()}`)); terminate(); return; }
    frames.push(frame);
    if (frame.type === "response") {
      const waiter = pending.get(frame.id);
      if (waiter) {
        pending.delete(frame.id);
        if (frame.success === false) waiter.reject(new Error(`${host}: ${waiter.type} failed: ${redact(frame.error ?? "unknown RPC error")}${diagnostic()}`));
        else waiter.resolve(frame.data);
      }
    }
    for (const waiter of [...eventWaiters]) {
      if (waiter.matches(frame)) { eventWaiters.delete(waiter); waiter.resolve(frame); }
    }
  });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-16_384); });
  child.stdin.on("error", (error) => { if (!stopping) fail(new Error(`${host}: RPC stdin failed: ${redact(error.message)}${diagnostic()}`)); });
  child.on("error", (error) => fail(new Error(`${host}: cannot start RPC: ${redact(error.message)}${diagnostic()}`)));
  const exited = new Promise((resolve) => {
    child.on("close", (code, signal) => {
      stopped = true;
      clearTimeout(escalation);
      lines.close();
      const expectedStop = code === 0 || code === 143 || code === 137 || signal === "SIGTERM" || signal === "SIGKILL";
      if (!stopping || !expectedStop) {
        fail(new Error(`${host}: RPC exited (code=${code}, signal=${signal})${diagnostic()}`));
      }
      resolve({ code, signal });
    });
  });
  const withDeadline = (label, install) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    if (stopped || stopping) { reject(new Error(`${host}: RPC is stopped`)); return; }
    const timer = setTimeout(() => {
      const error = new Error(`${host}: ${label} timed out after ${timeoutMs}ms${diagnostic()}`);
      fail(error);
      terminate();
      reject(error);
    }, timeoutMs);
    const waiter = {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    };
    install(waiter);
  });
  const command = (type, fields = {}) => withDeadline(type, (waiter) => {
    const id = `broker-e2e-${++sequence}`;
    pending.set(id, { ...waiter, type });
    child.stdin.write(`${JSON.stringify({ ...fields, id, type })}\n`, (error) => {
      if (error) fail(new Error(`${host}: RPC write failed: ${redact(error.message)}${diagnostic()}`));
    });
  });
  let prompting = false;
  const prompt = async (message) => {
    if (prompting) throw new Error(`${host}: concurrent prompts are unsupported`);
    prompting = true;
    let completionWaiter;
    const completed = withDeadline("prompt completion", (waiter) => {
      completionWaiter = { ...waiter, matches: (frame) => host === "omp" ? frame.type === "prompt_result" : frame.type === "agent_end" || frame.type === "prompt_result" };
      eventWaiters.add(completionWaiter);
    });
    // Attach both rejection handlers before either promise can reject.
    try {
      const acknowledged = command("prompt", { message }).then((data) => {
        if ((data?.agentInvoked === false || data?.disposition === "handled") && eventWaiters.delete(completionWaiter)) {
          completionWaiter.resolve({ type: "prompt_result", agentInvoked: false, status: "completed", sessionSettled: true });
        }
        return data;
      });
      const [, frame] = await Promise.all([acknowledged, completed]);
      if (frame.error || frame.success === false || (frame.status && frame.status !== "completed")) {
        throw new Error(`${host}: prompt failed: ${redact(frame.error?.message ?? frame.error ?? frame.status ?? "unknown prompt error")}${diagnostic()}`);
      }
      for (const item of frame.messages ?? []) {
        if (item.role === "assistant" && (item.stopReason === "error" || item.stopReason === "aborted")) {
          throw new Error(`${host}: assistant ${item.stopReason}: ${redact(item.errorMessage ?? "prompt did not complete")}${diagnostic()}`);
        }
      }
      return frame;
    } finally {
      if (completionWaiter && eventWaiters.delete(completionWaiter)) completionWaiter.resolve(undefined);
      prompting = false;
    }
  };
  const stop = async () => {
    if (!stopped) {
      stopping = true;
      const stopError = new Error(`${host}: RPC stopped before pending operation completed`);
      for (const waiter of pending.values()) waiter.reject(stopError);
      pending.clear();
      for (const waiter of eventWaiters) waiter.reject(stopError);
      eventWaiters.clear();
      // RPC hosts are long-lived: completion is established by native events,
      // persisted sessions and provider captures before intentional termination.
      // Do not mistake SIGTERM for a naturally successful print-mode exit.
      terminate();
      await exited;
    }
    if (failure) throw failure;
  };
  const closeInput = async () => {
    if (stopped || stopping) throw new Error(`${host}: RPC is stopped`);
    stopping = true;
    child.stdin.end();
    // Both native RPC loops dispose their session on EOF. A timeout is a failure,
    // never a successful substitute with process-group termination.
    let timer;
    try {
      const result = await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => { terminate(); reject(new Error(`${host}: graceful EOF shutdown timed out`)); }, 10000);
      })]);
      if (result.code !== 0 || result.signal) throw new Error(`${host}: graceful EOF exited (code=${result.code}, signal=${result.signal})`);
      if (failure) throw failure;
    } finally { clearTimeout(timer); }
  };
  try { await command("get_state"); }
  catch (error) { await stop().catch(() => {}); throw error; }
  return { command, prompt, stop, closeInput, frames };
}
