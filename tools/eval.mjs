#!/usr/bin/env node
// Automated evaluations: did an optimisation actually help? Usage:
//   node tools/eval.mjs compare <commit|YYYY-MM-DD[THH:MM]> [days]   (usage before vs after that point; default 7 days each side)
//   node tools/eval.mjs checks                                       (offline tests: fast paths, memory dedup, tool cache)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DATA_DIR, ROOT } from '../src/config.mjs';

const [cmd = '', point = '', daysArg] = process.argv.slice(2);

if (cmd === 'compare' && point) {
  let split = Date.parse(point);
  if (isNaN(split)) {
    try { split = Date.parse(execFileSync('git', ['-C', ROOT, 'show', '-s', '--format=%cI', point], { encoding: 'utf8' }).trim()); } catch {}
  }
  if (isNaN(split)) { console.log(`"${point}" is neither a date nor a commit.`); process.exit(1); }
  const span = (Number(daysArg) || 7) * 864e5;
  const rows = fs.readFileSync(path.join(DATA_DIR, 'usage.jsonl'), 'utf8').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const stats = (list) => {
    const n = list.length || 1, ok = list.filter((r) => r.status !== 'error' && r.status !== 'interrupted');
    const has = (f) => list.filter((r) => r[f]);
    const mean = (l, f) => (l.length ? l.reduce((a, r) => a + r[f], 0) / l.length : NaN);
    const prompt = list.reduce((a, r) => a + r.input + r.cache_read + r.cache_creation, 0);
    const s = {
      turns: list.length,
      'cost $/turn': mean(has('cost_usd'), 'cost_usd'),
      'cost $/ok task': ok.length ? ok.reduce((a, r) => a + (r.cost_usd || 0), 0) / ok.length : NaN,
      'tokens/turn': list.reduce((a, r) => a + r.total, 0) / n,
      'output/turn': list.reduce((a, r) => a + r.output, 0) / n,
      'cache hit %': prompt ? (list.reduce((a, r) => a + r.cache_read, 0) / prompt) * 100 : NaN,
      'avg time s': mean(has('ms'), 'ms') / 1000,
      'first word s': mean(has('ttft_ms'), 'ttft_ms') / 1000,
      'success %': (ok.length / n) * 100,
      'fast path %': (list.filter((r) => r.fast).length / n) * 100,
      'local runs': list.filter((r) => r.local).length,
      escalations: list.filter((r) => r.escalated).length,
    };
    if (!list.length) for (const k of Object.keys(s)) if (k !== 'turns') s[k] = NaN; // no data is not "0"
    return s;
  };
  const t = (r) => Date.parse(r.ts);
  const before = stats(rows.filter((r) => t(r) < split && t(r) >= split - span));
  const after = stats(rows.filter((r) => t(r) >= split && t(r) < split + span));
  const lower = new Set(['cost $/turn', 'cost $/ok task', 'tokens/turn', 'output/turn', 'avg time s', 'first word s']);
  const f = (v) => (Number.isNaN(v) ? '-' : Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : v.toFixed(v < 1 ? 3 : 1));
  console.log(`Split at ${new Date(split).toLocaleString()}, ${daysArg || 7} day(s) each side.`);
  console.log('metric'.padEnd(16) + 'before'.padStart(12) + 'after'.padStart(12) + '   change');
  for (const k of Object.keys(before)) {
    const a = before[k], b = after[k];
    let verdict = '';
    if (!Number.isNaN(a) && !Number.isNaN(b) && a && k !== 'turns') {
      const pct = ((b - a) / Math.abs(a)) * 100;
      const better = lower.has(k) ? pct < 0 : pct > 0;
      verdict = `${pct > 0 ? '+' : ''}${pct.toFixed(0)}% ${Math.abs(pct) < 5 ? '(same)' : better ? '(better)' : '(worse)'}`;
    }
    console.log(k.padEnd(16) + f(a).padStart(12) + f(b).padStart(12) + '   ' + verdict);
  }
  if (after.turns < 20) console.log(`\nOnly ${after.turns} turns since the split: too few to judge yet.`);
} else if (cmd === 'checks') {
  const { fastPath } = await import('../src/fastpath.mjs');
  const cfg = { honorific: 'sir' };
  const cases = [
    ['what time is it', 'time'], ['Eve, what time is it?', 'time'], ["what's the date today", 'date'], ['what day is it', 'date'],
    ['remind me in 10 minutes to stretch', 'remind'], ['open notepad', 'open'],
    ['what time is it in Tokyo', null], ['open the file I edited yesterday', null], ['remind me tomorrow to call mom', null],
    ['how good is kindred against akali', null], ['open nonexistent app xyz', null],
    ['volume up', 'volume'], ['Eve, turn the volume down a little', 'volume'], ['mute', 'volume'], ['set the volume to 40', 'volume-set'],
    ['pause', 'media'], ['next song', 'media'], ['set a timer for 10 minutes', 'timer'], ['start a 5 minute timer', 'timer'],
    ['play despacito on spotify', null], ['set the volume to 400', null], ['start 5 minutes', null], ['why is my volume so low', null],
  ];
  let pass = 0;
  for (const [text, want] of cases) {
    const got = fastPath(text, cfg, { dryRun: true })?.name || null;
    const ok = got === want;
    pass += ok;
    if (!ok) console.log(`FAIL fast path: "${text}" -> ${got}, expected ${want}`);
  }
  console.log(`Fast paths: ${pass}/${cases.length} passed.`);
  const node = (tool, ...a) => { try { return execFileSync('node', [path.join(ROOT, 'tools', tool), ...a], { encoding: 'utf8' }); } catch (e) { return String(e.stdout); } };
  const key = `eval-check-${Date.now()}`;
  node('cache.mjs', 'set', key, '--ttl', '1m', 'hello');
  const cacheOk = node('cache.mjs', 'get', key).includes('hello');
  node('cache.mjs', 'clear', key);
  console.log(`Tool cache: ${cacheOk ? 'passed' : 'FAILED'}.`);
  const first = node('memory.mjs', 'add', 'Eval check note about purple elephants dancing', '--tag', 'eval');
  const dupe = node('memory.mjs', 'add', 'eval check note about the purple elephants dancing', '--tag', 'eval');
  const id = /#(\d+)/.exec(first)?.[1];
  if (id) node('memory.mjs', 'remove', id);
  const dedupOk = /Already remembered/.test(dupe);
  if (!dedupOk) { const id2 = /#(\d+)/.exec(dupe)?.[1]; if (id2) node('memory.mjs', 'remove', id2); }
  console.log(`Memory dedup: ${dedupOk ? 'passed' : 'FAILED'}.`);
  process.exit(pass === cases.length && cacheOk && dedupOk ? 0 : 1);
} else {
  console.log('Usage: compare <commit|date> [days] | checks');
}
