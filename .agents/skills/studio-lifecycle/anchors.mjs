#!/usr/bin/env node
/**
 * Check that the store still offers what `studio_lifecycle.tla` assumes.
 *
 * The model is a small state machine written by hand, so every guard it relies on has to exist in
 * `apps/jev-studio/server/store.mjs`: the single-run guard, the run's first status, the latch that
 * makes `finish` idempotent, the five branches that map an exit to a status, `stop`'s early return,
 * the SIGTERM plus the 3 s SIGKILL that only fires while the id is still tracked, and the child's
 * own error handler.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const text = readFileSync(join(root, 'apps/jev-studio/server/store.mjs'), 'utf8');

/** `first` appears before `second`, so the ordering the model relies on still holds. */
const ordered = (first, second) => {
  const a = text.indexOf(first);
  const b = text.indexOf(second);
  return a >= 0 && b > a;
};

const anchors = [
  {
    id: 'one-run-at-a-time',
    about:
      'start refuses while any run is running or stopping, which is the only thing keeping SingleActive',
    holds: () =>
      text.includes(
        "const active = () => [...runs.values()].find((r) => ['running', 'stopping'].includes(r.status));",
      ) &&
      ordered(
        "if (active()) throw new StudioError('A task is already running on this device.', 409);",
        'runs.set(id, run);',
      ),
  },
  {
    id: 'a-run-starts-running',
    about: 'a run is added with status running and no end time, before the task exists',
    holds: () => text.includes("status: 'running',") && text.includes('endedAt: null,'),
  },
  {
    id: 'finish-is-idempotent',
    about:
      'finish returns early for a run that already ended, and records the status and the end together',
    holds: () =>
      ordered('if (run.endedAt !== null) return;', 'run.status = status;') &&
      ordered('run.status = status;', 'processes.delete(id);'),
  },
  {
    id: 'close-decides-in-order',
    about: 'the exit maps to one status: stopped, failed, succeeded, exhausted, then blocked',
    holds: () =>
      ordered("if (run.status === 'stopping') finish('stopped');", 'else if (code !== 0') &&
      ordered('else if (code !== 0 || run.error || !outcome)', "else if (outcome === 'done')") &&
      ordered("else if (outcome === 'done')", "finish('exhausted')") &&
      ordered("finish('exhausted')", "else finish('blocked');"),
  },
  {
    id: 'stop-leaves-ended-runs-alone',
    about: 'stop returns for a run that already ended, or whose process is gone',
    holds: () => text.includes('if (!child || run.endedAt !== null) return snapshot(id);'),
  },
  {
    id: 'stop-escalates',
    about:
      'stop marks the run stopping, sends SIGTERM, and arms a 3 s SIGKILL that only fires while the id is tracked',
    holds: () =>
      ordered("run.status = 'stopping';", "\n      kill('SIGTERM');") &&
      ordered("\n      kill('SIGTERM');", 'const timer = setTimeout(') &&
      ordered('const timer = setTimeout(', "if (processes.has(id)) kill('SIGKILL');"),
  },
  {
    id: 'child-error-reports-failure',
    about: "the child's own error event reports the run as failed, before close",
    holds: () =>
      text.includes(
        "child.once('error', () => finish('failed', 'Unable to start the task process.'));",
      ),
  },
  {
    id: 'spawn-failure-is-reported',
    about: 'a spawn that throws reports the run failed instead of leaving it running',
    holds: () => ordered("} catch {\n        finish('failed',", 'return snapshot(id);'),
  },
];

let failed = 0;
for (const anchor of anchors) {
  const holds = anchor.holds();
  if (!holds) failed++;
  console.log(`  ${holds ? 'ok  ' : 'GONE'} ${anchor.id.padEnd(28)} ${anchor.about}`);
}
if (failed) {
  console.log(
    '\nThe store moved away from this model. Read the GONE anchor, then either bring\n' +
      'studio_lifecycle.tla and this list in line with the code as it is now, or treat the\n' +
      'difference as a finding on the code.',
  );
  process.exitCode = 1;
}
