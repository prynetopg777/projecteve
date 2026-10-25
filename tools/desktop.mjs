#!/usr/bin/env node
// Desktop automation for apps the browser connector can't reach (Windows, via PowerShell). Usage:
//   node tools/desktop.mjs windows                  (visible windows: process and title)
//   node tools/desktop.mjs focus "Notepad"          (bring the first window whose title contains this to the front)
//   node tools/desktop.mjs type "hello there"       (type text into the focused window)
//   node tools/desktop.mjs keys "^s"                (SendKeys syntax: ^ ctrl, % alt, + shift, {ENTER}, {TAB}, {F5})
//   node tools/desktop.mjs click 500 300 [right]    (click at screen coordinates; take a screenshot first to find them)
//   node tools/desktop.mjs move 500 300
//   node tools/desktop.mjs wait 2                   (seconds, between steps of a workflow)
import { execFileSync } from 'node:child_process';

const [cmd = '', ...args] = process.argv.slice(2);
const q = (s) => `'${String(s).replace(/'/g, "''")}'`; // PowerShell single-quoted literal
const USER32 = `Add-Type -Namespace W -Name U -MemberDefinition '
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, System.UIntPtr e);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);';`;
const SENDKEYS = 'Add-Type -AssemblyName System.Windows.Forms;';

function ps(script) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
    if (out.trim()) console.log(out.trim());
  } catch (e) {
    console.log((e.stderr || e.message).toString().trim());
    process.exit(1);
  }
}
const num = (v) => { const n = Number(v); if (!Number.isFinite(n)) { console.log(`"${v}" isn't a number.`); process.exit(1); } return Math.round(n); };

if (cmd === 'windows') {
  ps(`Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { "$($_.ProcessName): $($_.MainWindowTitle)" }`);
} else if (cmd === 'focus' && args[0]) {
  ps(`${USER32} $p = Get-Process | Where-Object { $_.MainWindowTitle -like ('*' + ${q(args.join(' '))} + '*') } | Select-Object -First 1;
if (-not $p) { 'No window matches that title.'; exit 1 }
[W.U]::ShowWindow($p.MainWindowHandle, 9) | Out-Null; [W.U]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; "Focused: $($p.MainWindowTitle)"`);
} else if (cmd === 'type' && args.length) {
  // Escape SendKeys specials so the text is typed literally.
  const text = args.join(' ').replace(/[+^%~(){}[\]]/g, '{$&}');
  ps(`${SENDKEYS} [System.Windows.Forms.SendKeys]::SendWait(${q(text)}); 'Typed.'`);
} else if (cmd === 'keys' && args[0]) {
  ps(`${SENDKEYS} [System.Windows.Forms.SendKeys]::SendWait(${q(args.join(' '))}); 'Sent.'`);
} else if ((cmd === 'click' || cmd === 'move') && args.length >= 2) {
  const [x, y] = [num(args[0]), num(args[1])];
  const [down, up] = args[2] === 'right' ? [0x08, 0x10] : [0x02, 0x04];
  ps(`${USER32} [W.U]::SetCursorPos(${x}, ${y}) | Out-Null;`
    + (cmd === 'click' ? ` [W.U]::mouse_event(${down},0,0,0,[System.UIntPtr]::Zero); [W.U]::mouse_event(${up},0,0,0,[System.UIntPtr]::Zero); 'Clicked ${x},${y}.'` : ` 'Moved to ${x},${y}.'`));
} else if (cmd === 'wait' && args[0]) {
  await new Promise((r) => setTimeout(r, Math.min(num(args[0]), 60) * 1000));
  console.log('Waited.');
} else {
  console.log('Usage: windows | focus "title" | type "text" | keys "^s" | click x y [right] | move x y | wait seconds');
}
