// Opens Eve's UI as a standalone desktop window: Edge (or Chrome) in app mode with a dedicated
// profile under data/, so microphone permission and window placement persist between runs.
// Falls back to the default browser when no Chromium browser is found.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

export const PROFILE_DIR = path.join(DATA_DIR, 'browser-profile');

const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
const KNOWN = {
  msedge: roots.map((r) => path.join(r, 'Microsoft/Edge/Application/msedge.exe')),
  chrome: roots.map((r) => path.join(r, 'Google/Chrome/Application/chrome.exe')),
};

// cfg.browser may be "msedge", "chrome", a path to a browser exe, or empty (= try Edge, then Chrome).
export function findBrowser(cfg) {
  const want = (cfg.browser || '').trim();
  if (want && fs.existsSync(want)) return want;
  const key = want.toLowerCase().replace(/\.exe$/, '');
  const order = key === 'chrome' ? ['chrome', 'msedge'] : !key || key === 'msedge' || key === 'edge' ? ['msedge', 'chrome'] : [];
  for (const name of order) {
    const exe = KNOWN[name].find((p) => fs.existsSync(p));
    if (exe) return exe;
  }
  return null;
}

// Pre-allow the microphone for Eve's origin in a brand-new profile (harmless if the browser ignores it;
// otherwise the first "Allow" click is remembered by the profile anyway).
function seedProfile(origin) {
  const prefs = path.join(PROFILE_DIR, 'Default/Preferences');
  if (fs.existsSync(prefs)) return;
  try {
    fs.mkdirSync(path.dirname(prefs), { recursive: true });
    const site = { [`${origin},*`]: { setting: 1 } };
    fs.writeFileSync(prefs, JSON.stringify({ profile: { content_settings: { exceptions: { media_stream_mic: site, notifications: site } } } }));
  } catch {}
}

export function openWindow(cfg, url) {
  if (process.platform !== 'win32') return;
  const exe = cfg.appWindow === false ? null : findBrowser(cfg);
  if (exe) {
    seedProfile(new URL(url).origin);
    const args = [`--app=${url}`, `--user-data-dir=${PROFILE_DIR}`, '--window-size=480,820',
      '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required'];
    spawn(exe, args, { detached: true, stdio: 'ignore' }).on('error', () => openInBrowser(null, url)).unref();
    return;
  }
  // App mode is off, or cfg.browser is something else (e.g. firefox): open a normal tab like before.
  // If Edge/Chrome were wanted but not found, use the default browser.
  const known = ['msedge', 'edge', 'chrome'].includes((cfg.browser || '').toLowerCase());
  openInBrowser(cfg.appWindow === false || !known ? cfg.browser : null, url);
}

function openInBrowser(browser, url) {
  const args = browser ? ['/c', 'start', '', browser, url] : ['/c', 'start', '', url];
  spawn('cmd', args, { windowsHide: true, stdio: 'ignore' });
}
