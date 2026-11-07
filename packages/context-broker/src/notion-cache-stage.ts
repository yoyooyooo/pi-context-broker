import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** Only the caller's unpublished temporary path may be passed here. A platform
 * without verified system Trash retains it; cache cleanup never unlinks files. */
export async function retireOwnedCacheStage(path: string): Promise<boolean> {
  if (!isAbsolute(path)) return false;
  try { await lstat(path); }
  catch (error) { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
  if (process.platform !== "darwin") return false;
  try { await access("/usr/bin/trash", constants.X_OK); } catch { return false; }
  const completed = await new Promise<boolean>(resolve => {
    execFile("/usr/bin/trash", [path], { timeout: 10_000 }, error => resolve(error === null));
  });
  if (!completed) return false;
  try { await lstat(path); return false; }
  catch (error) { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
}
