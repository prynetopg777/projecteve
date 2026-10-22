// Reminders live in data/reminders.json. Eve adds them via tools/remind.mjs;
// the server/CLI polls the file and fires the due ones.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

const FILE = path.join(DATA_DIR, 'reminders.json');
const REPEAT_MS = { daily: 86400000, weekly: 7 * 86400000 };

export function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

export function save(list) {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

export function add(text, due, repeat = null) {
  if (repeat && !REPEAT_MS[repeat]) throw new Error(`repeat must be one of: ${Object.keys(REPEAT_MS).join(', ')}`);
  const list = load();
  const id = Math.max(0, ...list.map((r) => r.id)) + 1;
  const reminder = { id, text, due: due.toISOString(), repeat };
  list.push(reminder);
  save(list);
  return reminder;
}

export function remove(id) {
  const list = load();
  const next = list.filter((r) => r.id !== id);
  save(next);
  return next.length !== list.length;
}

/** Parse "10m", "1h30m", "2d", "45s" into milliseconds. */
export function parseDuration(s) {
  const re = /(\d+(?:\.\d+)?)\s*(d|h|m|s)/gi;
  const unit = { d: 86400000, h: 3600000, m: 60000, s: 1000 };
  let ms = 0;
  let matched = '';
  for (const [whole, n, u] of s.matchAll(re)) {
    ms += Number(n) * unit[u.toLowerCase()];
    matched += whole;
  }
  if (!ms || matched.replace(/\s/g, '') !== s.replace(/\s/g, '')) throw new Error(`Bad duration "${s}" (use e.g. 10m, 1h30m, 2d)`);
  return ms;
}

/** Parse "2026-10-22 15:30", "2026-10-22T15:30" or "15:30" (today, or tomorrow if already past) as local time. */
export function parseAt(s) {
  const time = s.match(/^(\d{1,2}):(\d{2})$/);
  if (time) {
    const d = new Date();
    d.setHours(Number(time[1]), Number(time[2]), 0, 0);
    if (d <= new Date()) d.setDate(d.getDate() + 1);
    return d;
  }
  const d = new Date(s.trim().replace(' ', 'T'));
  if (isNaN(d)) throw new Error(`Bad time "${s}" (use "YYYY-MM-DD HH:MM" or "HH:MM")`);
  return d;
}

/** Poll for due reminders and call onFire(reminder) for each. Returns a stop function. */
export function startReminderLoop(onFire, intervalMs = 5000) {
  const tick = () => {
    const now = Date.now();
    const list = load();
    const due = list.filter((r) => new Date(r.due).getTime() <= now);
    if (!due.length) return;
    for (const r of due) {
      onFire(r);
      if (r.repeat) {
        let next = new Date(r.due).getTime();
        while (next <= now) next += REPEAT_MS[r.repeat];
        r.due = new Date(next).toISOString();
      }
    }
    save(list.filter((r) => r.repeat || !due.includes(r)));
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return () => clearInterval(timer);
}
