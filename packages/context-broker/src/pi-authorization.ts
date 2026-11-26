import { execFile } from "node:child_process";
import type { ExtensionContext } from "./types";

/** The SDK owns the callback, grant and waiter. The host only presents its URL. */
export type AuthorizationPresentation = {
  readonly url: string;
  readonly signal: AbortSignal;
  readonly deadline: number;
};
type BrowserOpener = (url: string, signal: AbortSignal) => Promise<void>;
type PresentationResult = "closed" | "cancelled" | "expired" | "browser_unavailable";
const authorizationError = (code: string) => Object.assign(new Error(code), { code });

function openSystemBrowser(url: string, signal: AbortSignal): Promise<void> {
  const command = process.platform === "darwin" ? "/usr/bin/open"
    : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise((resolve, reject) => {
    execFile(command, args, { signal, timeout: 5_000, windowsHide: true }, error => {
      if (error) reject(authorizationError("MCP_AUTH_BROWSER_UNAVAILABLE"));
      else resolve();
    });
  });
}

function wrap(text: string, width: number): string[] {
  const columns = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80;
  const lines: string[] = [];
  for (let at = 0; at < text.length; at += columns) lines.push(text.slice(at, at + columns));
  return lines.length ? lines : [""];
}

function authorizationUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw authorizationError("MCP_AUTH_URL_INVALID"); }
  if (url.protocol !== "https:" || url.username || url.password || value.length > 16_384
    || /[\u0000-\u001f\u007f]/u.test(value)) throw authorizationError("MCP_AUTH_URL_INVALID");
  return url;
}

/**
 * The core runs this presentation beside its callback listener. Closing the
 * presentation signal completes the UI; Esc rejects only this waiter.
 */
export async function presentPiAuthorization(
  request: AuthorizationPresentation,
  ctx: ExtensionContext,
  openBrowser: BrowserOpener = openSystemBrowser,
): Promise<void> {
  if (request.signal.aborted) return;
  if (!ctx.hasUI || ctx.mode !== "tui" || !ctx.ui?.custom)
    throw authorizationError("MCP_AUTH_INTERACTION_REQUIRED");
  if (!Number.isFinite(request.deadline) || Date.now() >= request.deadline)
    throw authorizationError("MCP_AUTH_TIMEOUT");
  const url = authorizationUrl(request.url);
  const result = await ctx.ui.custom<PresentationResult>((tui, _theme, _keys, done) => {
    const opener = new AbortController();
    let settled = false;
    let opening = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const repaint = () => {
      if (tui !== null && typeof tui === "object" && "requestRender" in tui && typeof tui.requestRender === "function")
        tui.requestRender();
    };
    const finish = (value: PresentationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal.removeEventListener("abort", close);
      opener.abort();
      done(value);
    };
    const close = () => finish("closed");
    request.signal.addEventListener("abort", close, { once: true });
    timer = setTimeout(() => finish("expired"), Math.max(0, request.deadline - Date.now()));
    // custom() may install a component asynchronously. Check again immediately
    // before the browser side effect, including an already elapsed deadline.
    queueMicrotask(() => {
      if (settled) return;
      if (request.signal.aborted) { close(); return; }
      if (Date.now() >= request.deadline) { finish("expired"); return; }
      void openBrowser(url.href, AbortSignal.any([request.signal, opener.signal])).then(() => {
        if (settled) return;
        opening = false;
        repaint();
      }, () => {
        if (!settled) finish(request.signal.aborted ? "closed" : "browser_unavailable");
      });
    });
    return {
      render(width) {
        return [
          ...wrap("Connect Notion content search", width), "",
          ...wrap((opening ? "Opening your browser at " : "Complete sign-in in your browser at ") + url.origin + ".", width),
          ...wrap("This search resumes after authorization. Esc cancels this search.", width),
        ];
      },
      handleInput(data) {
        if (data === "\u001b" || data === "\u0003" || /^\u001b\[27(?:;1)?u$/u.test(data)) finish("cancelled");
      },
      invalidate() {},
      dispose() { finish("cancelled"); },
    };
  });
  switch (result) {
    case "closed": return;
    case "cancelled": throw authorizationError("MCP_AUTH_CANCELLED");
    case "expired": throw authorizationError("MCP_AUTH_TIMEOUT");
    case "browser_unavailable": throw authorizationError("MCP_AUTH_BROWSER_UNAVAILABLE");
    default: { const exhaustive: never = result; throw exhaustive; }
  }
}
