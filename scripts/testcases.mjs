/**
 * Run a directory of manual test-case sheets through the agent, one case at a time, on one device.
 *
 * Usage:
 *   pnpm testcases --list
 *   pnpm testcases --run --group 新1UI --limit 5
 *   pnpm testcases --run --only f07-12,f07-13
 *   pnpm testcases --run --resume            # skip ids that already have a result
 *   pnpm testcases --summary                 # morning report from results.jsonl
 *
 * Evidence for each case lands in `artifacts/testcases/<id>/`, and one line per case is appended to
 * `artifacts/testcases/results.jsonl`, so an interrupted night still has every verdict it reached.
 */
import { parseArgs } from 'node:util';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { loadEnvironment } from './env.mjs';
import { createAgentDevice, deviceConfig } from './mobile-agent/device-factory.mjs';
import { runAgent, TypeSafePolicy } from './mobile-agent/agent.mjs';
import { pooledRequest } from './mobile-agent/http.mjs';
import { readWorkbook } from './mobile-agent/xlsx.mjs';
import {
  casesFromRows,
  goalFor,
  judgeExpected,
  summaryMarkdown,
  expectationPreexists,
  oneLinePerCase,
  verdictOf,
} from './mobile-agent/testcase-suite.mjs';

loadEnvironment();

const run = promisify(execFile);
const OUT = 'artifacts/testcases';
const RESULTS = join(OUT, 'results.jsonl');

const help = `Run the manual test-case sheets through the agent on one device.

Options:
  --dir PATH            Directory of .xlsx sheets (default tmp/testcases_20261028)
  --list                Print the cases and exit
  --run                 Run the selected cases
  --summary             Write ${OUT}/summary.md from the results so far
  --group TEXT          Only cases whose group contains TEXT (repeatable)
  --file PREFIX         Only cases from one sheet, by id prefix: f01 … f12 (repeatable)
  --only IDS            Comma-separated case ids
  --limit N             Stop after N cases
  --steps N             Actions per case (default 15)
  --settle-ms N         Extra wait after each action (default 0)
  --resume              Skip cases that already have a verdict
  --keep-open           Leave the final screen alone instead of returning home
`;

async function load(args) {
  const sheetDir = join(process.cwd(), args['--dir'] ?? 'tmp/testcases_20261028');
  const names = (await run('ls', [sheetDir])).stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.xlsx'))
    .sort();
  const cases = [];
  for (const [index, name] of names.entries()) {
    const sheets = await readWorkbook(join(sheetDir, name));
    for (const sheet of sheets) cases.push(...casesFromRows(name, index + 1, sheet.rows));
  }
  return cases;
}

async function previousRuns() {
  try {
    const text = await readFile(RESULTS, 'utf8');
    return oneLinePerCase(
      text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
  } catch {
    return [];
  }
}

/**
 * Write one case's verdict, replacing any line the same case already has.
 *
 * Append-only is what let two runners on one device leave two verdicts for one case: the reader then
 * took whichever line came last, so a pass could silently become a fail. A lock file keeps two runners
 * from rewriting the file at the same moment.
 */
async function recordResult(entry) {
  const lock = `${RESULTS}.lock`;
  await mkdir(OUT, { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await writeFile(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (error) {
      if (attempt > 100) throw new Error(`The results file stayed locked: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    const runs = await previousRuns().catch(() => []);
    const lines = [...runs.filter((run) => run.id !== entry.id), entry].map(
      (run) => `${JSON.stringify(run)}\n`,
    );
    await writeFile(`${RESULTS}.tmp`, lines.join(''));
    await rename(`${RESULTS}.tmp`, RESULTS);
  } finally {
    await unlink(lock).catch(() => {});
  }
}

/** The phone drops its USB link when it sleeps. Recover before a case, and say how. */
async function ensureDevice(serial) {
  const state = async () =>
    (
      await run('adb', ['-s', serial, 'get-state']).catch((error) => ({ stdout: error.message }))
    ).stdout.trim();
  if ((await state()) === 'device') return true;
  await run('adb', ['reconnect', 'offline']).catch(() => {});
  await run('adb', ['connect', '127.0.0.1:15555']).catch(() => {});
  for (let attempt = 0; attempt < 12; attempt++) {
    if ((await state()) === 'device') return true;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  if (existsSync('/usr/local/bin/radb') || existsSync('/opt/homebrew/bin/radb'))
    await run('radb', []).catch(() => {});
  return false;
}

async function writeEvidence(id, name, data) {
  const dir = join(OUT, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), data);
}

async function runCase({ testCase, device, policy, steps, settleMs, serial }) {
  const ready = await ensureDevice(serial);
  if (!ready) throw new Error(`Device ${serial} is not reachable.`);
  await device.act({ type: 'global', name: 'home' }).catch(() => {});
  const before = await device.observe();
  const beforeImage = await device.screenshot().catch(() => null);
  await writeEvidence(testCase.id, 'before.json', JSON.stringify(before, null, 2));
  if (beforeImage) await writeEvidence(testCase.id, 'before.png', beforeImage);

  // Written as the case runs, so a case that hangs still says what it was doing.
  await mkdir(join(OUT, testCase.id), { recursive: true });
  const traceFile = await open(join(OUT, testCase.id, 'trace.jsonl'), 'w');
  const record = async (event) =>
    traceFile.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  let result;
  let error;
  try {
    result = await runAgent({
      device,
      policy,
      goal: goalFor(testCase),
      texts: [],
      execute: true,
      maxSteps: steps,
      settleMs,
      waitTimeoutMs: 15_000,
      onStep: async (step) => {
        // The probability maps are large and the verdict never reads them; the chosen probability does.
        const {
          operationProbabilities: _operations,
          targetProbabilities: _targets,
          ...rest
        } = step;
        await record({ event: 'decision', ...rest });
      },
      onAction: async (event) => record({ event: 'action_executed', ...event }),
    });
  } catch (caught) {
    error = caught.message;
  } finally {
    await traceFile.close();
  }

  const after = await device.observe().catch((caught) => {
    error ??= `The final screen could not be read: ${caught.message}`;
    return null;
  });
  if (after) await writeEvidence(testCase.id, 'after.json', JSON.stringify(after, null, 2));
  const afterImage = await device.screenshot().catch(() => null);
  if (afterImage) await writeEvidence(testCase.id, 'after.png', afterImage);

  let judgment;
  if (afterImage) {
    judgment = await judgeExpected({
      request: pooledRequest,
      apiKey: process.env.TYPESAFE_API_KEY,
      model: process.env.TYPESAFE_MODEL,
      image: afterImage.toString('base64'),
      testCase,
    }).catch((caught) => ({ error: caught.message }));
  }
  const status = result?.status ?? (error ? 'error' : 'unknown');
  // A case with a "nothing changed" branch is only evidence if it was false when the case started.
  let beforeVerified = false;
  if (!error && beforeImage && testCase.expected.length > 1) {
    const beforeJudgment = await judgeExpected({
      request: pooledRequest,
      apiKey: process.env.TYPESAFE_API_KEY,
      model: process.env.TYPESAFE_MODEL,
      image: beforeImage.toString('base64'),
      testCase,
    }).catch(() => null);
    beforeVerified = expectationPreexists({ testCase, judgment: beforeJudgment });
    await writeEvidence(
      testCase.id,
      'before-judgment.json',
      `${JSON.stringify(beforeJudgment, null, 2)}\n`,
    );
  }
  const verdict = verdictOf({ status, judgment, beforeVerified, error });
  const entry = {
    id: testCase.id,
    source: testCase.source,
    group: testCase.group,
    name: testCase.name,
    steps: testCase.steps,
    expected: testCase.expected,
    status,
    verdict,
    judgment: judgment && { probability: judgment.probability, verified: judgment.verified },
    ...(testCase.expected.length > 1 ? { beforeVerified } : {}),
    reason: result?.reason,
    modelSteps: result?.steps,
    timings: result?.timings,
    ...(error ? { error } : {}),
  };
  await writeEvidence(testCase.id, 'run.json', `${JSON.stringify(entry, null, 2)}\n`);
  await recordResult(entry);
  return entry;
}

async function main() {
  const { values } = parseArgs({
    allowPositionals: true,
    options: {
      dir: { type: 'string' },
      list: { type: 'boolean' },
      run: { type: 'boolean' },
      summary: { type: 'boolean' },
      group: { type: 'string', multiple: true, default: [] },
      file: { type: 'string', multiple: true, default: [] },
      only: { type: 'string' },
      limit: { type: 'string' },
      steps: { type: 'string', default: '15' },
      'settle-ms': { type: 'string', default: '0' },
      resume: { type: 'boolean' },
      'keep-open': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(help);
    return;
  }
  if (!values.list && !values.run && !values.summary) {
    console.log(help);
    return;
  }
  if (values.summary) {
    const unique = await previousRuns();
    await writeFile(join(OUT, 'summary.md'), summaryMarkdown(unique));
    console.log(`${unique.length} cases summarised in ${OUT}/summary.md`);
    return;
  }
  const all = await load(values);
  if (values.list) {
    for (const testCase of all) console.log(`${testCase.id}\t${testCase.group}\t${testCase.name}`);
    console.log(`\n${all.length} cases in ${new Set(all.map((c) => c.source)).size} sheets`);
    return;
  }

  const done = values.resume ? new Set((await previousRuns()).map((entry) => entry.id)) : new Set();
  const only = values.only ? new Set(values.only.split(',').map((id) => id.trim())) : null;
  // An empty --only reads as "no filter" and would run every sheet: refuse it instead.
  if (only && !only.size)
    throw new Error('--only needs at least one case id, e.g. --only f07-2,f07-3.');
  const groups = values.group ?? [];
  const files = values.file ?? [];
  const selected = all
    .filter((testCase) => !only || only.has(testCase.id))
    .filter((testCase) => !files.length || files.includes(testCase.id.split('-')[0]))
    .filter((testCase) => !groups.length || groups.some((group) => testCase.group.includes(group)))
    .filter((testCase) => !done.has(testCase.id))
    .slice(0, values.limit ? Number(values.limit) : undefined);
  if (!selected.length) {
    console.log('Nothing selected. Use --list to see the case ids.');
    return;
  }

  const config = deviceConfig(process.env, {});
  const device = createAgentDevice(config);
  const policy = new TypeSafePolicy({ request: pooledRequest });
  await mkdir(OUT, { recursive: true });
  const started = Date.now();
  let passed = 0;
  for (const [index, testCase] of selected.entries()) {
    process.stdout.write(`[${index + 1}/${selected.length}] ${testCase.id} ${testCase.name} ... `);
    try {
      const record = await runCase({
        testCase,
        device,
        policy,
        steps: Number(values.steps),
        settleMs: Number(values['settle-ms']),
        serial: config.adbSerial,
      });
      if (record.verdict.startsWith('pass')) passed += 1;
      const percent = Number.isFinite(record.judgment?.probability)
        ? ` ${Math.round(record.judgment.probability * 100)}%`
        : '';
      console.log(`${record.verdict} (${record.status}${percent})`);
    } catch (error) {
      console.log(`error (${error.message})`);
      await recordResult({
        id: testCase.id,
        group: testCase.group,
        name: testCase.name,
        status: 'error',
        verdict: 'error',
        error: error.message,
      });
    }
    const minutes = ((Date.now() - started) / 60_000).toFixed(1);
    process.stdout.write(`    ${passed}/${index + 1} verified, ${minutes} min elapsed\n`);
  }
  if (!values['keep-open']) await device.act({ type: 'global', name: 'home' }).catch(() => {});
  const unique = await previousRuns();
  await writeFile(join(OUT, 'summary.md'), summaryMarkdown(unique));
  console.log(
    `\n${passed}/${selected.length} verified this pass; ${unique.length} results recorded.`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
