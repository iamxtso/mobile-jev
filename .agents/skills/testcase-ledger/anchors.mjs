/**
 * Check that testcase_ledger.tla still describes the code it models.
 *
 * TLC proves properties of the model. This proves the model's premises are still in the source: the
 * lock file is created exclusively, the read happens inside the lock, the commit is a rename, the lock
 * is released in a `finally`. A refactor that moves any of these makes the model describe a protocol
 * nobody runs, and this script is what says so before TLC's silence is believed.
 *
 *   node .agents/skills/testcase-ledger/anchors.mjs
 *
 * Exit 0 when every anchor is still in place; 1, naming the anchor that moved, otherwise.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const at = (path) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const source = (path) => readFileSync(at(path), 'utf8');

/** The body of one top-level function: from its signature to the next line that closes at column 0. */
function body(file, signature) {
  const lines = source(file).split('\n');
  const start = lines.findIndex((line) => line.includes(signature));
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && line === '}');
  return lines.slice(start, end < 0 ? undefined : end + 1).join('\n');
}

const record = body('scripts/testcases.mjs', 'async function recordResult(');
const previous = body('scripts/testcases.mjs', 'async function previousRuns(');
const suite = source('scripts/mobile-agent/testcase-suite.mjs');

/** Whether `first` appears before `second` in the text. */
const before = (text, first, second) => {
  const a = text.indexOf(first),
    b = text.indexOf(second);
  return a >= 0 && b > a;
};

const givenUp = /if \(attempt > (\d+)\)/.exec(record);

const anchors = [
  {
    model: 'Acquire, Retry, GiveUp',
    about: 'the lock is a file created exclusively, so a second runner sees EEXIST',
    holds: () => /`\$\{RESULTS\}\.lock`/.test(record) && /flag: 'wx'/.test(record),
  },
  {
    model: 'Retry, GiveUp',
    about: 'the wait is bounded, and long enough for a live runner to commit: at least 10 tries',
    holds: () => Boolean(givenUp) && Number(givenUp[1]) >= 10,
  },
  {
    model: 'Read',
    about:
      'the ledger is read inside the lock, after the lock exists and before anything is written',
    holds: () =>
      before(record, 'for (let attempt = 0;', 'previousRuns()') &&
      before(record, 'previousRuns()', '${RESULTS}.tmp'),
  },
  {
    model: 'WriteTmp',
    about:
      "this case's old line is dropped and the new verdict appended, which is one line per case",
    holds: () => /runs\.filter\(\(run\) => run\.id !== entry\.id\)/.test(record),
  },
  {
    model: 'WriteTmp, Commit',
    about: 'the commit is a temp file plus a rename, so a reader never sees a half-written line',
    holds: () => before(record, '${RESULTS}.tmp', 'rename(') && !/writeFile\(RESULTS,/.test(record),
  },
  {
    model: 'Release',
    about: 'the lock is removed in a finally, so an ordinary error does not keep it',
    holds: () => /finally \{\s*await unlink\(lock\)/.test(record),
  },
  {
    model: 'Parse',
    about: 'any read error, including one unparseable line, is read as "no results yet"',
    holds: () => /catch \{\s*return \[\];\s*\}/.test(previous) && /JSON\.parse/.test(previous),
  },
  {
    model: 'the reader side of OneLinePerCase',
    about: 'oneLinePerCase keeps the last line written for a case',
    holds: () => /last\.set\(entry\.id, entry\)/.test(suite),
  },
];

let failed = false;
for (const anchor of anchors) {
  let holds;
  try {
    holds = anchor.holds();
  } catch {
    holds = false;
  }
  if (!holds) failed = true;
  console.log(`  ${holds ? 'ok  ' : 'GONE'} ${anchor.model.padEnd(34)} ${anchor.about}`);
}
if (givenUp)
  console.log(`  note recordResult gives up after ${givenUp[1]} attempts; the model keeps 2.`);
if (failed) {
  console.log(
    '\nThe code no longer matches this model. Read the anchor marked GONE, then either fix\n' +
      'testcase_ledger.tla to describe the code as it is now, or treat the difference as a finding.',
  );
  process.exitCode = 1;
}
