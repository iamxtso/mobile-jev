#!/usr/bin/env node
/**
 * Check that the code still offers what `explore.mjs` assumes.
 *
 * The explorer runs the real `runAgent`, but the phone under it is a double. The double stands in for
 * `AdbDevice` only in the ways listed here: the freshness gate that runs before every dispatch, what a
 * stale decision compares, the transport that never retries a mutation, and the loop's own stale
 * retry, repeated-action guard, hold escalation and step budget. When one of these facts is GONE, the
 * exploration may be checking a promise nobody makes any more.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const read = (file) => readFileSync(join(root, 'scripts/mobile-agent', file), 'utf8');

/** `first` appears before `second`, so the ordering the double relies on still holds. */
const ordered = (text, first, second) => {
  const a = text.indexOf(first);
  const b = text.indexOf(second);
  return a >= 0 && b > a;
};

const anchors = [
  {
    id: 'gate-before-dispatch',
    file: 'device.mjs',
    about: 'every gated action is read and checked fresh before the one dispatch it makes',
    holds: (text) =>
      ordered(
        text,
        'if (expected) assertFresh(current, expected, action, maxAgeMs);',
        'const executed = await dispatch(resolved);',
      ),
  },
  {
    id: 'the-gate-compares-the-target',
    file: 'device.mjs',
    about:
      'a stale decision is one whose control, text or bounds moved, which is what the double redraws',
    holds: (text) =>
      /\n\s+label,\n\s+resourceId,\n\s+editable,\n\s+enabled,\n\s+checked,\n\s+selected,\n/.test(
        text,
      ),
  },
  {
    id: 'open-app-skips-the-gate',
    file: 'device.mjs',
    about: 'open-app dispatches before the gate, so the double models taps and long presses only',
    holds: (text) =>
      ordered(text, "if (action.type === 'open-app') {", 'const current = await device.observe();'),
  },
  {
    id: 'mutation-never-retried',
    file: 'device.mjs',
    about: 'the transport reports an unknown mutation outcome once and never sends it again',
    holds: (text) =>
      text.includes(
        "if (mutation)\n        throw new Error('ADB mutation outcome is uncertain; the action was not retried.');",
      ),
  },
  {
    id: 'only-stale-continues',
    file: 'agent.mjs',
    about:
      'the loop swallows exactly one kind of dispatch failure: a stale decision, refused before input',
    holds: (text) =>
      text.includes(
        'if (!(error instanceof StaleObservationError)) throw error; // Never retry uncertain mutations.',
      ),
  },
  {
    id: 'repeated-guard-before-act',
    file: 'agent.mjs',
    about: 'the same action on an unchanged screen is stopped before input, not after',
    holds: (text) =>
      ordered(
        text,
        'if (!isWait && repeated.has(signature)) {',
        'else receipt = await device.act(decision.action, { expected: observation });',
      ),
  },
  {
    id: 'one-step-one-action',
    file: 'agent.mjs',
    about: 'the step budget is spent before the action, so a run cannot mutate past maxSteps',
    holds: (text) =>
      ordered(
        text,
        "if (step >= maxSteps) return finish('step_limit', decision);",
        'else receipt = await device.act(decision.action, { expected: observation });',
      ),
  },
  {
    id: 'hold-escalation-is-a-different-action',
    file: 'agent.mjs',
    about: 'a second press is a longer hold of the same control, never an identical action',
    holds: (text) =>
      text.includes('const HOLD_ESCALATION_MS = 3000;') &&
      text.includes("if (action?.type !== 'long-press' || action.duration) return undefined;"),
  },
  {
    id: 'the-double-replaces-the-whole-act',
    file: 'device.mjs',
    about:
      'one `act` is one resolution and one dispatch, which is what one `act` of the double answers',
    holds: (text) => text.includes('async act(action, context = {}) {\n    return resolveAction('),
  },
];

let failed = 0;
for (const anchor of anchors) {
  const holds = anchor.holds(read(anchor.file));
  if (!holds) failed++;
  console.log(`  ${holds ? 'ok  ' : 'GONE'} ${anchor.id.padEnd(32)} ${anchor.about}`);
}
if (failed) {
  console.log(
    '\nThe code moved away from this exploration. Read the GONE anchor, then either bring\n' +
      'explore.mjs and this list in line with the code as it is now, or treat the difference as\n' +
      'a finding on the code.',
  );
  process.exitCode = 1;
}
