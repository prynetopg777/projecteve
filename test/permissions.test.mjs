import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { isAutoAllowed, alwaysAsk } from '../src/permissions.mjs';
import { parseDuration } from '../src/reminders.mjs';

test('read-only shell commands run freely', () => {
  assert.equal(isAutoAllowed('Bash', { command: 'git status' }), true);
});

test('arbitrary shell commands need approval', () => {
  assert.equal(isAutoAllowed('Bash', { command: 'Remove-Item C:/x -Recurse' }), false);
});

test('editing source files needs approval', () => {
  const file_path = new URL('../src/brain.mjs', import.meta.url).pathname.replace(/^\//, '');
  assert.equal(isAutoAllowed('Edit', { file_path }), false);
});

test('shutdown is always confirmed individually', () => {
  assert.ok(alwaysAsk('PowerShell', { command: 'Stop-Computer -Force' }));
});

test('an approved task stops covering shell actions after web content', () => {
  const cmd = { command: 'Remove-Item C:/x' };
  assert.equal(isAutoAllowed('Bash', cmd, { taskActive: true }), true);
  assert.equal(isAutoAllowed('Bash', cmd, { taskActive: true, webTainted: true }), false);
});

test('reminder durations parse', () => {
  assert.equal(parseDuration('10m'), 600000);
});

test('memory tool runs freely', () => {
  const cmd = `node "${decodeURIComponent(new URL('../tools/memory.mjs', import.meta.url).pathname.replace(/^\//, ''))}" search "x"`;
  assert.equal(isAutoAllowed('Bash', { command: cmd }), true);
});
