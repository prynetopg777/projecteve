// Supervisor: runs the server, restarts it when Eve asks (exit code 75), rolls back a
// self-update that crashes on startup, and shows the desktop overlay.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, loadConfig, ROOT } from './config.mjs';
import * as su from './selfupdate.mjs';

const RESTART_CODE = 75;
const HEALTHY_AFTER_MS = 30000;
const cfg = loadConfig();
let restarts = 0;
let crashes = [];

if (cfg.overlay && process.platform === 'win32') {
  const overlay = spawn(
    'powershell',
    ['-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'overlay/overlay.ps1'),
      '-Port', String(cfg.port), '-ParentPid', String(process.pid), '-Browser', cfg.browser || ''],
    { windowsHide: true, stdio: 'ignore' }, // not `detached`: PowerShell exits immediately when detached
  );
  overlay.unref(); // it watches our PID and exits by itself when we're gone
}

// Create the "Eve" desktop shortcut once (deleting it later is respected). Failure is harmless.
const shortcutMarker = path.join(DATA_DIR, 'shortcut-created');
if (cfg.desktopShortcut !== false && process.platform === 'win32' && !fs.existsSync(shortcutMarker)) {
  spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools/create-shortcut.ps1')],
    { windowsHide: true, stdio: 'ignore' })
    .on('exit', (code) => { if (code === 0) try { fs.writeFileSync(shortcutMarker, new Date().toISOString()); } catch {} })
    .on('error', () => {});
}

function run() {
  const started = Date.now();
  let stderrTail = '';
  const child = spawn(process.execPath, [path.join(ROOT, 'src/server.mjs')], {
    stdio: ['inherit', 'inherit', 'pipe'],
    env: { ...process.env, EVE_LAUNCHER: '1', ...(restarts ? { EVE_RESTARTED: '1' } : {}) },
  });
  child.stderr.on('data', (d) => {
    process.stderr.write(d);
    stderrTail = (stderrTail + d).slice(-2000);
  });

  child.on('exit', (code, signal) => {
    restarts++;
    if (code === RESTART_CODE) return run();
    if (code === 0 || signal) process.exit(0);

    // Crashed. If that was freshly self-updated code, roll it back.
    if (fs.existsSync(su.PENDING_FILE) && Date.now() - started < HEALTHY_AFTER_MS) {
      const { reason } = JSON.parse(fs.readFileSync(su.PENDING_FILE, 'utf8'));
      const stash = `eve: crashed self-update ${new Date().toISOString()}`;
      try {
        su.stash(stash);
        fs.writeFileSync(su.FAILED_FILE, JSON.stringify({ reason, stash, error: stderrTail.trim() }, null, 2));
        console.error(`\n⏪ Self-update "${reason}" crashed on startup. Rolled back (git stash: "${stash}").\n`);
      } catch (e) {
        console.error(`\nRollback failed: ${e.message}`);
      }
      fs.rmSync(su.PENDING_FILE, { force: true });
      return run();
    }

    crashes = crashes.filter((t) => Date.now() - t < 60000).concat(Date.now());
    if (crashes.length >= 4) {
      console.error('\nEve crashed 4 times in a minute; giving up. Check the errors above.');
      process.exit(1);
    }
    console.error(`\nEve exited with code ${code}; restarting in 3s…`);
    setTimeout(run, 3000);
  });
}

run();
