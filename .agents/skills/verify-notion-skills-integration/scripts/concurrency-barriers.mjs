import { watch } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname } from 'node:path';

export function waitForFile(path, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let checking = false;
    let dirty = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher.close();
      if (error) reject(error);
      else resolve(path);
    };
    const check = async () => {
      dirty = true;
      if (checking || settled) return;
      checking = true;
      try {
        do {
          dirty = false;
          try { await access(path); finish(); }
          catch (error) { if (error.code !== 'ENOENT') finish(error); }
        } while (dirty && !settled);
      } finally { checking = false; }
    };
    const watcher = watch(dirname(path), () => { void check(); });
    watcher.on('error', finish);
    const timer = setTimeout(() => finish(new Error(`Unreached explicit gate: ${path}`)), timeoutMs);
    void check();
  });
}
