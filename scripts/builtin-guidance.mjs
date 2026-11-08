import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const history = /\blegacy\b|\bmigrat(?:e|ed|ion|ing)\b|compatibility default|ctl sync (?:local|upstream)|ctl library migration|ctl operation resume|已迁移|未迁移|过渡期/iu;

export function assertCurrentBuiltinGuidance(content, label) {
  if (history.test(content)) throw new Error(`Bundled Agent guidance must describe the current library workflow: ${label}`);
}

/** Validate the actual package selected for embedding, not another checkout. */
export async function checkBuiltinGuidance(root) {
  let checked = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Bundled instruction sources must be regular files: ${path}`);
    if (entry.isDirectory()) checked += await checkBuiltinGuidance(path);
    else if (entry.isFile() && entry.name.endsWith(".md")) {
      assertCurrentBuiltinGuidance(await readFile(path, "utf8"), path);
      checked++;
    }
  }
  return checked;
}
