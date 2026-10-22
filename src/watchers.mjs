// Background watchers live in data/watchers.json. Eve adds them via tools/watch.mjs; the server polls
// them with plain code (no model calls) and speaks an alert only when a condition becomes true.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from './config.mjs';

const FILE = path.join(DATA_DIR, 'watchers.json');
export const TYPES = {
  'url-change': 'target = URL; fires when the page content changes',
  'url-contains': 'target = URL, text = phrase; fires when the page contains the phrase',
  'file-exists': 'target = file path; fires when the file appears',
  'process-stopped': 'target = process name (e.g. chrome); fires when it is no longer running',
  'process-started': 'target = process name; fires when it starts running',
  'disk-low': 'target = drive (e.g. C:), text = minimum free GB; fires when free space drops below it',
  'cpu-high': 'text = percent (default 90); fires when CPU stays above it for a full check',
};

export function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}
export const save = (list) => fs.writeFileSync(FILE, JSON.stringify(list, null, 2));

export function add({ type, target = '', text = '', message = '', everyMs = 60000, repeat = false }) {
  if (!TYPES[type]) throw new Error(`Unknown type "${type}". Types: ${Object.keys(TYPES).join(', ')}`);
  const list = load();
  const id = Math.max(0, ...list.map((w) => w.id)) + 1;
  const w = { id, type, target, text, message, everyMs: Math.max(10000, everyMs), repeat, nextCheck: 0, lastFired: 0, state: null };
  list.push(w);
  save(list);
  return w;
}
export function remove(id) {
  const list = load();
  const next = list.filter((w) => w.id !== id);
  save(next);
  return next.length !== list.length;
}

const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (e, out) => resolve(String(out || ''))));
const running = async (name) => (await run('tasklist', ['/FO', 'CSV', '/NH'])).toLowerCase().includes(`"${name.toLowerCase().replace(/\.exe$/, '')}.exe"`);
const fetchText = async (url) => (await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0 EveWatcher' } })).text();

let lastCpu = null;
function cpuPercent() {
  const sum = os.cpus().reduce((a, c) => { const t = Object.values(c.times).reduce((x, y) => x + y, 0); return [a[0] + t, a[1] + c.times.idle]; }, [0, 0]);
  const prev = lastCpu;
  lastCpu = sum;
  return prev ? (1 - (sum[1] - prev[1]) / (sum[0] - prev[0])) * 100 : 0;
}

/** Returns an alert sentence when the watcher's condition is met, otherwise null. May update w.state. */
async function check(w) {
  switch (w.type) {
    case 'url-change': {
      const hash = createHash('sha1').update(await fetchText(w.target)).digest('hex');
      const changed = w.state && w.state !== hash;
      w.state = hash;
      return changed ? `The page ${w.target} has changed.` : null;
    }
    case 'url-contains':
      return (await fetchText(w.target)).toLowerCase().includes(w.text.toLowerCase()) ? `The page ${w.target} now mentions "${w.text}".` : null;
    case 'file-exists':
      return fs.existsSync(w.target) ? `The file ${path.basename(w.target)} has appeared.` : null;
    case 'process-stopped': {
      const up = await running(w.target);
      const was = w.state;
      w.state = up ? 'up' : 'down';
      return !up && was === 'up' ? `${w.target} has stopped running.` : null;
    }
    case 'process-started': {
      const up = await running(w.target);
      const was = w.state;
      w.state = up ? 'up' : 'down';
      return up && was === 'down' ? `${w.target} has started.` : null;
    }
    case 'disk-low': {
      const s = fs.statfsSync(w.target.endsWith('\\') ? w.target : `${w.target}\\`);
      const freeGb = (s.bavail * s.bsize) / 1e9;
      return freeGb < Number(w.text || 10) ? `Drive ${w.target} is low on space: ${freeGb.toFixed(1)} gigabytes free.` : null;
    }
    case 'cpu-high': {
      const pct = cpuPercent();
      return pct > Number(w.text || 90) ? `Your CPU is at ${Math.round(pct)} percent.` : null;
    }
    default:
      return null;
  }
}

/** Poll watchers and call onFire({ id, text }) for each one that triggers. Returns a stop function. */
export function startWatcherLoop(onFire, tickMs = 10000) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const list = load();
      const now = Date.now();
      const fired = [];
      for (const w of list) {
        if (w.nextCheck > now) continue;
        w.nextCheck = now + w.everyMs;
        let alert = null;
        try {
          alert = await check(w);
        } catch {
          // transient failure (offline, timeout): try again next time
        }
        const cooldown = 30 * 60000;
        if (alert && now - w.lastFired > cooldown) {
          w.lastFired = now;
          fired.push(w);
          onFire({ id: w.id, text: w.message || alert });
        }
      }
      if (list.length) save(list.filter((w) => w.repeat || !fired.includes(w)));
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, tickMs);
  tick();
  return () => clearInterval(timer);
}
