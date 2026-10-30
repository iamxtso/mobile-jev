import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

/** A results file the way a night's run leaves it, plus one line no reader can use. */
async function sandbox(lines) {
  const cwd = await mkdtemp(join(tmpdir(), 'jev-ledger-'));
  const out = join(cwd, 'artifacts/testcases');
  await mkdir(out, { recursive: true });
  await writeFile(
    join(out, 'results.jsonl'),
    lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
  );
  return cwd;
}

const summary = async (cwd) =>
  run(process.execPath, [resolve(here, 'testcases.mjs'), '--summary'], { cwd });

test('the summary reads every verdict and skips a line that carries none', async () => {
  const cwd = await sandbox([
    { id: 'f01-2', group: 'UI', name: '状态栏', status: 'done', verdict: 'pass', steps: 3 },
    { id: 'f01-3', group: 'UI', name: '设置', status: 'done', verdict: 'fail', steps: 4 },
    { id: 'legacy' },
  ]);
  const { stdout } = await summary(cwd);
  assert.match(stdout, /^2 cases summarised/m);
  const markdown = await readFile(join(cwd, 'artifacts/testcases/summary.md'), 'utf8');
  assert.match(markdown, /状态栏/);
  assert.match(markdown, /设置/);
  assert.doesNotMatch(markdown, /legacy/);
});

test('a case recorded twice keeps its last verdict', async () => {
  const cwd = await sandbox([
    { id: 'f01-2', group: 'UI', name: '状态栏', status: 'done', verdict: 'fail', steps: 2 },
    { id: 'legacy' },
    { id: 'f01-2', group: 'UI', name: '状态栏', status: 'done', verdict: 'pass', steps: 3 },
  ]);
  const { stdout } = await summary(cwd);
  assert.match(stdout, /^1 cases summarised/m);
  const markdown = await readFile(join(cwd, 'artifacts/testcases/summary.md'), 'utf8');
  assert.match(markdown, /pass/);
});
