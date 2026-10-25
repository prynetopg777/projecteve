// Speculative fast paths: common, predictable requests answered directly in code, with no model call.
// Each matcher must be strict: anything slightly unusual falls through to Eve as normal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as reminders from './reminders.mjs';

const WAKE = /^(hey |ok |okay )?(eve|eva|evie|ibe|ebe|eba|evy)[,.!\s]+/i;
const POLITE = /\b(please|for me|now|po|nga)\b/gi;
const clean = (t) => t.trim().replace(WAKE, '').replace(/[?.!,]+$/g, '').replace(POLITE, '').replace(/\s+/g, ' ').trim().toLowerCase();

// Start Menu and Desktop shortcuts, by lower-case name.
function shortcuts() {
  const dirs = [
    path.join(process.env.APPDATA || '', 'Microsoft/Windows/Start Menu/Programs'),
    path.join(process.env.ProgramData || 'C:/ProgramData', 'Microsoft/Windows/Start Menu/Programs'),
    path.join(os.homedir(), 'Desktop'),
    path.join(process.env.PUBLIC || 'C:/Users/Public', 'Desktop'),
  ];
  const found = new Map();
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (/\.(lnk|url)$/i.test(e.name)) {
        const name = e.name.replace(/\.(lnk|url)$/i, '').toLowerCase();
        if (!/uninstall|readme|help|documentation|website/.test(name) && !found.has(name)) found.set(name, p);
      }
    }
  };
  dirs.forEach((d) => walk(d, 0));
  return found;
}

// Built-in Windows apps that have no Start Menu shortcut file.
const BUILTIN = {
  notepad: 'notepad.exe', calculator: 'calc.exe', calc: 'calc.exe', paint: 'mspaint.exe', 'file explorer': 'explorer.exe',
  explorer: 'explorer.exe', 'task manager': 'taskmgr.exe', settings: 'ms-settings:', 'snipping tool': 'snippingtool.exe',
};

const MATCHERS = [
  {
    name: 'time',
    re: /^(what('?s| is) the time|what time is it|time check|anong oras na)$/,
    run: (_, cfg) => `It's ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}, ${cfg.honorific}.`,
  },
  {
    name: 'date',
    re: /^(what('?s| is) (the date|today'?s date)( today)?|what day is (it|today)|what('?s| is) today)$/,
    run: (_, cfg) => `It's ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}, ${cfg.honorific}.`,
  },
  {
    // "remind me in 10 minutes to stretch" (relative times only; anything else goes to Eve)
    name: 'remind',
    re: /^(?:set a )?remind(?:er)?(?: me)? in (\d+) (second|minute|hour)s? (?:to|that|about) (.{2,120})$/,
    run: (m, cfg, dry) => {
      if (dry) return 'ok';
      const ms = reminders.parseDuration(`${m[1]}${m[2][0]}`);
      reminders.add(m[3], new Date(Date.now() + ms));
      return `Okay, ${cfg.honorific}. I'll remind you to ${m[3]} in ${m[1]} ${m[2]}${m[1] === '1' ? '' : 's'}.`;
    },
  },
  {
    // "open discord" only when the name exactly matches a Start Menu or Desktop shortcut.
    name: 'open',
    re: /^(?:open|launch|start|run) (?:up )?(?:the )?(?:app )?([a-z0-9 .+'-]{2,40})$/,
    run: (m, cfg, dry) => {
      const target = BUILTIN[m[1].trim()] || shortcuts().get(m[1].trim());
      if (!target) return null;
      if (dry) return 'ok';
      spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      const name = BUILTIN[m[1].trim()] ? m[1].trim().replace(/\b\w/g, (c) => c.toUpperCase()) : path.basename(target).replace(/\.(lnk|url)$/i, '');
      return `Opening ${name}, ${cfg.honorific}.`;
    },
  },
];

/** Returns { name, reply } when a request can be handled without the model, else null. */
export function fastPath(text, cfg, { dryRun = false } = {}) {
  if (cfg.fastPaths === false || text.length > 140 || /\[System note/i.test(text)) return null;
  const t = clean(text);
  for (const f of MATCHERS) {
    const m = f.re.exec(t);
    if (!m) continue;
    try {
      const reply = f.run(m, cfg, dryRun);
      if (reply) return { name: f.name, reply };
    } catch {
      return null; // any hiccup: let Eve handle it properly
    }
  }
  return null;
}
