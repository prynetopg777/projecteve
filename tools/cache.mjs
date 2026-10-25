#!/usr/bin/env node
// Tool-result cache (level 2; level 1 is the model's own prompt cache). Stores outputs of expensive, repeatable
// lookups (web research, stats, slow commands) in data/cache/ with an expiry. Usage:
//   node tools/cache.mjs get "key"                       (prints the value, or "MISS" with exit code 1)
//   node tools/cache.mjs set "key" --ttl 1d "value"      (or pipe the value on stdin)
//   node tools/cache.mjs run "key" --ttl 6h -- <command> (runs the shell command only on a miss, caches its output)
//   node tools/cache.mjs list | clear [key|--expired]
// ttl: 30m, 6h, 1d, 2w (default 1d). Keys are free text; use something specific like "lol kindred build 26.21".
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { DATA_DIR } from '../src/config.mjs';

const DIR = path.join(DATA_DIR, 'cache');
fs.mkdirSync(DIR, { recursive: true });
const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const command = dash >= 0 ? argv.splice(dash).slice(1).join(' ') : '';
const ti = argv.indexOf('--ttl');
const ttl = ti >= 0 ? argv.splice(ti, 2)[1] : '1d';
const [cmd = '', key = '', ...rest] = argv;

const norm = (k) => k.toLowerCase().replace(/\s+/g, ' ').trim();
const file = (k) => path.join(DIR, createHash('sha1').update(norm(k)).digest('hex').slice(0, 16) + '.json');
const ttlMs = (s) => {
  const m = /^(\d+)\s*([mhdw])$/i.exec(s);
  if (!m) { console.log(`Bad ttl "${s}" (use 30m, 6h, 1d, 2w).`); process.exit(1); }
  return Number(m[1]) * { m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2].toLowerCase()];
};
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const fresh = (e) => e && Date.parse(e.expires) > Date.now();
const age = (e) => { const m = Math.round((Date.now() - Date.parse(e.ts)) / 6e4); return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
function put(k, value) {
  const entry = { key: norm(k), ts: new Date().toISOString(), expires: new Date(Date.now() + ttlMs(ttl)).toISOString(), value };
  fs.writeFileSync(file(k), JSON.stringify(entry));
  return entry;
}

if (cmd === 'get' && key) {
  const e = read(file(key));
  if (!fresh(e)) { console.log('MISS'); process.exit(1); }
  console.log(`[cached ${age(e)} ago]\n${e.value}`);
} else if (cmd === 'set' && key) {
  let value = rest.join(' ');
  if (!value && !process.stdin.isTTY) for await (const c of process.stdin) value += c;
  if (!value.trim()) { console.log('Nothing to cache.'); process.exit(1); }
  const e = put(key, value.trim());
  console.log(`Cached "${e.key}" until ${e.expires.slice(0, 16).replace('T', ' ')}.`);
} else if (cmd === 'run' && key && command) {
  const e = read(file(key));
  if (fresh(e)) { console.log(`[cached ${age(e)} ago]\n${e.value}`); process.exit(0); }
  let out;
  try { out = execSync(command, { encoding: 'utf8', maxBuffer: 20 * 2 ** 20 }); } catch (err) { console.log((err.stdout || '') + (err.stderr || err.message)); process.exit(1); } // failures are never cached
  put(key, out.trim());
  console.log(out.trim());
} else if (cmd === 'list') {
  const all = fs.readdirSync(DIR).map((f) => read(path.join(DIR, f))).filter(Boolean);
  all.forEach((e) => console.log(`${fresh(e) ? 'fresh  ' : 'expired'} ${age(e).padStart(4)} old  ${e.key}  (${e.value.length} chars)`));
  if (!all.length) console.log('Cache is empty.');
} else if (cmd === 'clear') {
  let n = 0;
  for (const f of fs.readdirSync(DIR)) {
    const e = read(path.join(DIR, f));
    if (key === '--expired' ? !fresh(e) : !key || (e && e.key === norm(key))) { fs.rmSync(path.join(DIR, f)); n++; }
  }
  console.log(`Cleared ${n}.`);
} else {
  console.log('Usage: get "key" | set "key" [--ttl 1d] "value" | run "key" [--ttl 6h] -- command | list | clear [key|--expired]');
}
