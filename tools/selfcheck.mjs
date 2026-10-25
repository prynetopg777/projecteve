#!/usr/bin/env node
// Post-update check of the running Eve: page structure, /api/health, the page in headless Chrome/Edge
// (JS errors, stray text such as code leaking after </script>), a page screenshot, and a desktop screenshot.
// Exits non-zero on failure. Usage:
//   node tools/selfcheck.mjs [--no-desktop]
// Then Read data/selfcheck.png (the page) and data/screen.png (the desktop) to confirm it looks right.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, ROOT, loadConfig } from '../src/config.mjs';
import { pageStructure } from '../src/selfupdate.mjs';

const cfg = loadConfig();
const BASE = `http://127.0.0.1:${cfg.port}`;
const SHOT = path.join(DATA_DIR, 'selfcheck.png');
const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Structure of public/index.html (balanced <script> tags, nothing after the last </script>).
problems.push(...pageStructure(fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')));

// 2. Server health.
let up = false;
for (let i = 0; i < 20 && !up; i++) {
  const h = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  if (h) {
    up = true;
    const red = JSON.stringify(h).match(/"(status|level)":"red"/g);
    if (red) console.log(`Note: /api/health reports ${red.length} red item(s).`);
  } else await sleep(1000);
}
if (!up) problems.push(`server not reachable at ${BASE}`);

// 3. Load the page in a headless browser over the DevTools protocol.
const browsers = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const exe = browsers.find((b) => fs.existsSync(b));
if (up && !exe) problems.push('no Chrome or Edge found for the page check');
if (up && exe) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-selfcheck-'));
  const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1280,800', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore', windowsHide: true });
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
    const jsErrors = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') jsErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') jsErrors.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && m.params.entry.source === 'javascript') jsErrors.push(m.params.entry.text);
    };
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: `${BASE}/` });
    await sleep(3500);
    const probe = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const stray = [...document.body.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim().slice(0, 80));
        const text = document.body.innerText;
        const code = /(\\bfunction\\s*\\w*\\s*\\(|=>\\s*\\{|\\bconst \\w+ =|addEventListener\\(|<\\/script>)/.exec(text);
        const need = ['muteBtn', 'autoBtn', 'stopBtn', 'settingsBtn', 'modelSel', 'voiceSel', 'langSel', 'wakeBtn', 'newBtn', 'micBtn', 'log'].filter((id) => !document.getElementById(id));
        return { stray, code: code && text.slice(Math.max(0, code.index - 30), code.index + 60), need };
      })()`,
    });
    const r = probe.result?.result?.value || {};
    if (r.stray?.length) problems.push(`stray text in the page: ${JSON.stringify(r.stray)}`);
    if (r.code) problems.push(`code visible as page text: "${r.code}"`);
    if (r.need?.length) problems.push(`page is missing elements: ${r.need.join(', ')}`);
    problems.push(...jsErrors.map((e) => `JS error: ${String(e).split('\n')[0]}`));
    await send('Runtime.evaluate', { expression: "document.getElementById('boot')?.remove(); document.getElementById('settingsBtn')?.click()" }); // show the UI with settings open, without starting the mic
    await sleep(500);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
    else problems.push('could not capture the page screenshot');
    ws.close();
  } catch (e) {
    problems.push(`page check failed: ${e.message}`);
  } finally {
    proc.kill();
    await sleep(500);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

// 4. Desktop screenshot (shows the real Eve window, if open). Not fatal.
if (!process.argv.includes('--no-desktop')) {
  try { console.log(`Desktop screenshot: ${execFileSync(process.execPath, [path.join(ROOT, 'tools/screenshot.mjs'), '--max', '1600'], { encoding: 'utf8', timeout: 25000 }).trim()}`); } catch {}
}

if (fs.existsSync(SHOT)) console.log(`Page screenshot: ${SHOT} (Read it to confirm the page looks right)`);
if (problems.length) {
  console.log(`Self-check FAILED:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('Self-check passed: page structure ok, server healthy, page loads with no JS errors or stray text.');
