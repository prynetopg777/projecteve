// Local neural text-to-speech through Piper (CPU only, no GPU). One sentence in, one WAV out.
// Files live in data/piper: piper/piper.exe and voice.onnx (+ voice.onnx.json).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
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
      const p = spawn(EXE, ['-m', MODEL, '--output_file', '-', '--length_scale', '0.95', '--quiet'], { cwd: path.dirname(EXE), windowsHide: true });
      const out = [];
      p.stdout.on('data', (c) => out.push(c));
      p.on('error', reject);
      p.on('close', (code) => (code === 0 && out.length ? resolve(Buffer.concat(out)) : reject(new Error(`piper exited ${code}`))));
      p.stdin.end(text.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS) + '\n');
    });
  const next = chain.then(run, run);
  chain = next.catch(() => {});
  return next;
}
