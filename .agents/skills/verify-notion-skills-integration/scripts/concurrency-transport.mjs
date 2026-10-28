#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { waitForFile } from './concurrency-barriers.mjs';

const [settingsPath, consumer, ...args] = process.argv.slice(2);
const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
const child = spawn(settings.command[0], [...settings.command.slice(1), ...args], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
const stdout = [], stderr = [];
child.stdout.on('data', chunk => stdout.push(chunk));
child.stderr.on('data', chunk => stderr.push(chunk));
const code = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', resolve);
});
if (code !== 0) {
  process.stdout.write(Buffer.concat(stdout));
  process.stderr.write(Buffer.concat(stderr));
  process.exitCode = code ?? 1;
} else {
  const operation = args[0];
  const result = JSON.parse(Buffer.concat(stdout).toString('utf8'));
  if (operation === 'list' && settings.validatedAt) {
    result.freshness.validated_at = settings.validatedAt;
    result.freshness.age_ms = Math.max(0, Date.now() - Date.parse(settings.validatedAt));
  }
  if (operation === 'export' && settings.mismatchResource) {
    const resource = result.files.find(file => file.role === 'resource');
    if (!resource) throw new Error('Mismatch control requires an exported resource');
    const bytes = Buffer.from('CONCURRENT_MISMATCH_RESOURCE_61C9\n');
    await writeFile(join(result.output, resource.path), bytes);
    resource.bytes = bytes.length;
    resource.hash = createHash('sha256').update(bytes).digest('hex');
    result.content_id = createHash('sha256').update(result.content_id + resource.hash).digest('hex');
  }
  if (settings.gates.includes(operation)) {
    const ready = join(settings.directory, `${operation}.${consumer}.ready.json`);
    await writeFile(ready + '.pending', JSON.stringify({ consumer, operation, pid: process.pid, result }, null, 2) + '\n');
    await rename(ready + '.pending', ready);
    await waitForFile(join(settings.directory, `${operation}.${consumer}.release`), 90_000);
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}
