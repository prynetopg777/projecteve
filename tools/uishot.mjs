#!/usr/bin/env node
// Screenshots of the running Eve page at several window sizes, with a demo conversation filled in
// (messages, tool steps, a permission card, an error) so every state can be reviewed at once.
// Speech and the mic are never started, and permission cards are never answered.
// Usage: node tools/uishot.mjs [name] [--sizes 1440x900,1024x768,390x844] [--settings] [--empty | --busy]
// Saves data/ui-<name>-<w>x<h>.png and prints the paths; Read them to review the design.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, loadConfig } from '../src/config.mjs';

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--') && !/^\d+x\d+/.test(a)) || 'now';
const sizesArg = args[args.indexOf('--sizes') + 1];
const sizes = (args.includes('--sizes') ? sizesArg : '1440x900,1024x768,390x844').split(',').map((s) => s.split('x').map(Number));
const BASE = `http://127.0.0.1:${loadConfig().port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEMO = `(() => {
  document.getElementById('boot')?.remove();
  voiceOn = false; updateButtons();
  log.replaceChildren();
  addMsg('eve', 'Good afternoon, sir. All systems online. Say "eve" followed by your request.');
  if (${args.includes('--empty')}) return;
  if (${args.includes('--busy')}) { addMsg('user', 'what is on my to-do list?'); addMsg('tool', 'Reading my notes…'); busy = true; render(); return; }
  addMsg('user', 'how good is Kindred against Akali?');
  addMsg('tool', 'Searching the web…');
  addMsg('tool', 'Reading a web page…');
  const r = addMsg('eve', '');
  renderReply(r, 'The matchup slightly favors Kindred, sir, mostly because she can kite Akali out of her shroud. Want me to pull up the stats?\\n\\n\`\`\`\\nu.gg        Kindred 52.4% WR  (Emerald+, 14.20)\\nlolalytics  Kindred 51.8% WR  (Emerald+, 14.20)\\n\`\`\`');
  addMsg('stat', 'sonnet · auto · 6.2 s (first word 2.1 s) · $0.018 · 2 tools');
  addMsg('system', '⚡ Auto mode on. Eve will act without asking (shutdowns, disk wipes and similar still ask).');
  addMsg('reminder', '⏰ Stand up and stretch');
  lastAsked = 'how good is Kindred against Akali?'; addError("That request didn't go through (error 500).");
  showPermission({ id: 'demo-perm', title: 'delete the folder Downloads/old-builds', detail: 'Remove-Item -Recurse "C:/Users/Admin/Downloads/old-builds"', kind: 'action' });
  ${args.includes('--settings') ? "document.getElementById('settingsBtn')?.click();" : ''}
})()`;

const browsers = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const exe = browsers.find((b) => fs.existsSync(b));
if (!exe) { console.error('No Chrome or Edge found.'); process.exit(1); }
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-uishot-'));
const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore', windowsHide: true });
const errors = [];
try {
  let port;
  for (let i = 0; i < 40 && !port; i++) {
    try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { await sleep(250); }
  }
  if (!port) throw new Error('headless browser did not start');
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('DevTools connection failed')); });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  await send('Page.enable');
  for (const [w, h] of sizes) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
    await send('Page.navigate', { url: `${BASE}/` });
    await sleep(2500);
    const r = await send('Runtime.evaluate', { expression: DEMO, returnByValue: true });
    if (r.result?.exceptionDetails) errors.push(r.result.exceptionDetails.exception?.description || 'demo script failed');
    await sleep(900);
    // body hides overflow, so check the boxes themselves: anything poking past the right edge is clipped.
    const over = await send('Runtime.evaluate', { returnByValue: true, expression: `[...document.querySelectorAll('header, main, .panel, .log > *, form, .controls')].filter((el) => el.offsetParent && el.getBoundingClientRect().right > innerWidth + 1).map((el) => (el.id || el.className || el.tagName) + ' ' + Math.round(el.getBoundingClientRect().right) + 'px').join(', ')` });
    if (over.result?.result?.value) errors.push(`${w}x${h}: clipped past the right edge: ${over.result.result.value}`);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(DATA_DIR, `ui-${name}-${w}x${h}.png`);
    fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
    console.log(file);
  }
  ws.close();
} catch (e) {
  errors.push(e.message);
} finally {
  proc.kill();
  await sleep(400);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
if (errors.length) { console.log(`Problems:\n- ${[...new Set(errors)].join('\n- ')}`); process.exit(1); }
