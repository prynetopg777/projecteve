// Offline text-to-speech through Windows' built-in System.Speech.
// Used when no browser is connected (e.g. a reminder fires while the UI is closed).
import { spawn } from 'node:child_process';

export function speak(text) {
  if (process.platform !== 'win32') return;
  const script =
    'Add-Type -AssemblyName System.Speech; ' +
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
    'try { $s.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::Female) } catch {}; ' +
    '$s.Speak($env:EVE_SAY)';
  spawn('powershell', ['-NoProfile', '-Command', script], {
    env: { ...process.env, EVE_SAY: text },
    windowsHide: true,
    stdio: 'ignore',
  });
}
