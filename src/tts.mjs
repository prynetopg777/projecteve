// Local neural text-to-speech through Piper (CPU only, no GPU). One sentence in, one WAV out.
// Files live in data/piper: piper/piper.exe and voice.onnx (+ voice.onnx.json).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

const DIR = path.join(DATA_DIR, 'piper');
const EXE = path.join(DIR, 'piper/piper.exe');
const MODEL = path.join(DIR, 'voice.onnx');
const MAX_CHARS = 600;

export const ttsAvailable = () => process.platform === 'win32' && fs.existsSync(EXE) && fs.existsSync(MODEL);

let chain = Promise.resolve(); // one synthesis at a time keeps CPU use low

/** Resolves with a WAV buffer. */
export function synthesize(text) {
  const run = () =>
    new Promise((resolve, reject) => {
      // Piper's stdout is text mode on Windows and turns every 0x0A byte into 0x0D 0x0A, which wrecks the audio. Use a file.
      const tmp = path.join(os.tmpdir(), `eve-tts-${process.pid}-${Date.now()}.wav`);
      const p = spawn(EXE, ['-m', MODEL, '--output_file', tmp, '--length_scale', '0.95', '--quiet'], { cwd: path.dirname(EXE), windowsHide: true });
      p.on('error', reject);
      p.on('close', (code) => {
        try { const wav = fs.readFileSync(tmp); fs.unlinkSync(tmp); code === 0 && wav.length ? resolve(wav) : reject(new Error(`piper exited ${code}`)); }
        catch (e) { reject(e); }
      });
      p.stdout.resume();
      p.stdin.end(text.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS) + '\n');
    });
  const next = chain.then(run, run);
  chain = next.catch(() => {});
  return next;
}
