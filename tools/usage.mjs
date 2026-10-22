#!/usr/bin/env node
// Token usage summary from data/usage.jsonl (one line per turn, written by src/brain.mjs). Usage:
//   node tools/usage.mjs [days]     (default: last 7 days)
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../src/config.mjs';

const FILE = path.join(DATA_DIR, 'usage.jsonl');
const days = Math.max(1, Number(process.argv[2]) || 7);
const since = Date.now() - days * 86400000;

const rows = (fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8').split('\n') : [])
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && Date.parse(r.ts) >= since);

if (!rows.length) {
  console.log(`No usage logged in the last ${days} day(s).`);
  process.exit(0);
}

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const groups = new Map();
for (const r of rows) {
  const key = `${new Date(r.ts).toLocaleDateString('en-CA')}  ${r.model}`;
  const g = groups.get(key) || { turns: 0, input: 0, cache_read: 0, cache_creation: 0, output: 0, total: 0 };
  g.turns++;
  for (const f of ['input', 'cache_read', 'cache_creation', 'output', 'total']) g[f] += r[f] || 0;
  groups.set(key, g);
}

console.log(`Usage, last ${days} day(s) (tokens):`);
console.log('date        model    turns   input  cacheRd  cacheWr  output   total  avg/turn');
for (const [key, g] of [...groups].sort()) {
  const [date, model] = key.split('  ');
  console.log(
    `${date}  ${model.padEnd(7)} ${String(g.turns).padStart(5)} ${k(g.input).padStart(7)} ${k(g.cache_read).padStart(8)} ` +
      `${k(g.cache_creation).padStart(8)} ${k(g.output).padStart(7)} ${k(g.total).padStart(7)} ${k(g.total / g.turns).padStart(9)}`,
  );
}
const total = rows.reduce((a, r) => a + (r.total || 0), 0);
const out = rows.reduce((a, r) => a + (r.output || 0), 0);
console.log(`\n${rows.length} turns, ${k(total)} tokens total, ${k(total / rows.length)} per turn on average (${k(out / rows.length)} output).`);
