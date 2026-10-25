#!/usr/bin/env node
// Screenshot of the primary screen, saved to data/screen.png. Prints the file path. Usage:
//   node tools/screenshot.mjs [--max 1600]   (--max scales the image down so its longest side is at most N pixels)
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { DATA_DIR } from '../src/config.mjs';

const FILE = path.join(DATA_DIR, 'screen.png');
const ps = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
try { Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' -Name Dpi -Namespace Eve | Out-Null; [Eve.Dpi]::SetProcessDPIAware() | Out-Null } catch {}
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$max = [int]$env:EVE_MAX
if ($max -gt 0 -and [Math]::Max($b.Width, $b.Height) -gt $max) {
  $k = $max / [Math]::Max($b.Width, $b.Height)
  $small = New-Object System.Drawing.Bitmap ([int]($b.Width * $k)), ([int]($b.Height * $k))
  $g2 = [System.Drawing.Graphics]::FromImage($small)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, $small.Width, $small.Height)
  $g2.Dispose(); $bmp.Dispose(); $bmp = $small
}
$bmp.Save($env:EVE_SHOT, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`;

try {
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    env: { ...process.env, EVE_SHOT: FILE, EVE_MAX: String(Number(process.argv[process.argv.indexOf('--max') + 1]) || 0) },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    timeout: 20000,
  });
  console.log(FILE);
} catch (e) {
  console.error(`Screenshot failed: ${String(e.stderr || e.message).trim()}`);
  process.exit(1);
}
