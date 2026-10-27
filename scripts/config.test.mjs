import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './env.mjs';

test('CLI help works from outside the repository without credentials', () => {
  const help = execFileSync(process.execPath, [join(root, 'scripts/run.mjs'), '--help'], {
    cwd: '/tmp',
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
  });
  assert.match(help, /pnpm agent COMMAND/);
  assert.match(help, /--execute/);
  assert.match(help, /--adb-serial SERIAL/);
});

test('configuration template has no embedded account keys or device ID', () => {
  const template = readFileSync(join(root, '.env.example'), 'utf8');
  for (const key of ['ADB_SERIAL', 'TYPESAFE_API_KEY'])
    assert.match(template, new RegExp(`^${key}=$`, 'm'));
  assert.match(template, /^ADB_SERIAL=$/m);
});
