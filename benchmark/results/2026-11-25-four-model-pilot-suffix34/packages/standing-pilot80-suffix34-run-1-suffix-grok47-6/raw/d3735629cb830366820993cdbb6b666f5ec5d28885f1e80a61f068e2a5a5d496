#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const rows = readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/).slice(1);
const aliases = JSON.parse(readFileSync(new URL('../assets/depots.json', import.meta.url), 'utf8'));
const marker = readFileSync(new URL('../assets/format-marker.bin', import.meta.url)).toString('hex');
const result = rows.map(line => { const [id, depot, count] = line.split(','); return { id: id.trim(), depot: aliases[depot.trim().toLowerCase()], count: Number(count), format_marker_hex: marker }; });
writeFileSync(process.argv[3], JSON.stringify(result, null, 2) + '\n');
