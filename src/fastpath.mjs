// Speculative fast paths: common, predictable requests answered directly in code, with no model call.
// Each matcher must be strict: anything slightly unusual falls through to Eve as normal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

// Press a media/volume key n times (virtual-key codes: 173 mute, 174 vol down, 175 vol up, 176 next, 177 prev, 179 play/pause).
function pressKeys(...steps) {
  const script = steps.map(([code, n = 1]) => `1..${n} | % { $w.SendKeys([char]${code}) }`).join('; ');
  spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$w = New-Object -ComObject WScript.Shell; ${script}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
const MEDIA = { play: 179, resume: 179, pause: 179, 'play pause': 179, next: 176, skip: 176, previous: 177 };
const UNIT_MS = { second: 1000, minute: 60000, hour: 3600000 };

const MATCHERS = [
  {
    // "take a screenshot", "what's on my screen", "look at my screen": capture now, then the model describes it in one step.
    name: 'screen',
    re: /^(?:(?:take|grab|get) (?:a )?(?:screenshot|screen ?shot|screen capture)(?: of (?:my|the) screen)?(?: and (?:tell me what you see|describe it))?|what(?:'?s| is) on (?:my|the) screen|what do you see on (?:my|the) screen|(?:look at|check|describe) (?:my|the) screen)$/,
    run: (m, cfg, dry) => {
      if (dry) return 'ok';
      const tool = fileURLToPath(new URL('../tools/screenshot.mjs', import.meta.url));
      const file = execFileSync(process.execPath, [tool, '--max', '1600'], { encoding: 'utf8', timeout: 25000, windowsHide: true }).trim();
      return { image: file, ask: 'Here is a screenshot of my screen, taken just now. Describe what is on it in two or three short spoken sentences, focusing on what matters. No tool calls needed.' };
    },
  },
  {
    // "volume up", "turn the volume down a lot", "louder", "mute", "unmute"
    name: 'volume',
    re: /^(?:turn (?:the )?volume (up|down)|volume (up|down)|(louder|quieter|softer)|(mute|unmute)(?: (?:the )?(?:sound|volume|audio|pc|computer))?)(?: (a lot|a little|a bit))?$/,
    run: (m, cfg, dry) => {
      if (dry) return 'ok';
      if (m[4]) { pressKeys([173]); return `${m[4] === 'mute' ? 'Muted' : 'Unmuted'}, ${cfg.honorific}.`; }
      const up = (m[1] || m[2] || (m[3] === 'louder' ? 'up' : 'down')) === 'up';
      const steps = m[5] === 'a lot' ? 10 : m[5] ? 2 : 5; // each press is 2%
      pressKeys([up ? 175 : 174, steps]);
      return `Volume ${up ? 'up' : 'down'}, ${cfg.honorific}.`;
    },
  },
  {
    // "set the volume to 40" / "volume 40 percent"
    name: 'volume-set',
    re: /^(?:set (?:the )?volume (?:to )?|volume (?:to )?)(\d{1,3})(?: ?(?:%|percent))?$/,
    run: (m, cfg, dry) => {
      const n = Number(m[1]);
      if (n > 100) return null;
      if (dry) return 'ok';
      pressKeys([174, 50], [175, Math.round(n / 2)]); // to zero, then up in 2% steps
      return `Volume set to ${n} percent, ${cfg.honorific}.`;
    },
  },
  {
    // "pause", "next song", "skip track", "previous", "play music"
    name: 'media',
    re: /^(play|resume|pause|play pause|next|skip|previous)(?: (?:the )?(?:song|track|music|video|media))?$/,
    run: (m, cfg, dry) => {
      if (dry) return 'ok';
      pressKeys([MEDIA[m[1]]]);
      const said = { next: 'Skipping ahead', skip: 'Skipping ahead', previous: 'Going back' }[m[1]] || 'Done';
      return `${said}, ${cfg.honorific}.`;
    },
  },
  {
    // "set a timer for 10 minutes", "timer 5 minutes", "start a 20 second timer"
    name: 'timer',
    re: /^(?:set (?:a |the )?timer (?:for )?|timer (?:for )?|start (?:a |an )?)(\d+) (second|minute|hour)s?(?: timer)?$/,
    run: (m, cfg, dry) => {
      if (!/timer/.test(m[0])) return null; // "start 5 minutes" alone is too vague
      if (dry) return 'ok';
      const label = `${m[1]} ${m[2]}${m[1] === '1' ? '' : 's'}`;
      reminders.add(`Your ${m[1]} ${m[2]} timer is up`, new Date(Date.now() + Number(m[1]) * UNIT_MS[m[2]]));
      return `Timer set for ${label}, ${cfg.honorific}.`;
    },
  },
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

/** Returns { name, reply } when a request can be handled without the model, { name, image, ask } for a one-step model call, else null. */
export function fastPath(text, cfg, { dryRun = false } = {}) {
  if (cfg.fastPaths === false || text.length > 140 || /\[System note/i.test(text)) return null;
  const t = clean(text);
  for (const f of MATCHERS) {
    const m = f.re.exec(t);
    if (!m) continue;
    try {
      const reply = f.run(m, cfg, dryRun);
      if (reply && typeof reply === 'object') return { name: f.name, ...reply }; // { image, ask }: goes to the model with the image
      if (reply) return { name: f.name, reply };
    } catch {
      return null; // any hiccup: let Eve handle it properly
    }
  }
  return null;
}
