/**
 * Turn one worksheet of manual test cases into cases the agent can run, and judge each run against
 * the result the sheet expects.
 *
 * The sheet is written for a person: `前置条件` says what must already hold, `测试步骤` says what to do,
 * and `预期结果` says what the screen must show afterwards. The agent is given the preconditions and the
 * steps as its goal, and never the expected result, because that is what the run is being judged on.
 */
import { decodeJson } from './http.mjs';

/** Header cells are matched by name, so a sheet with extra columns still parses. */
const COLUMNS = {
  group: '分组名称',
  name: '测试用例名称',
  precondition: '前置条件',
  steps: '测试步骤',
  expected: '预期结果',
  tags: '标签',
};

/** A numbered cell holds one step per line, and the numbering is for a person, not the model. */
export function numberedLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\d+[.、)]\s*/, '').trim())
    .filter((line) => line && line.toLowerCase() !== 'nan');
}

/**
 * Cases from one sheet's rows. `fileIndex` keeps ids stable and ASCII, because a case id is a file
 * name in the evidence directory and several sources are named in Chinese.
 */
export function casesFromRows(source, fileIndex, rows) {
  if (!rows.length) return [];
  const header = rows[0].map((cell) => String(cell).trim());
  const at = Object.fromEntries(
    Object.entries(COLUMNS).map(([key, label]) => [key, header.indexOf(label)]),
  );
  const cases = [];
  for (const [offset, row] of rows.slice(1).entries()) {
    const cell = (key) => (at[key] >= 0 ? (row[at[key]] ?? '') : '');
    const name = String(cell('name')).trim();
    if (!name || name === COLUMNS.name) continue;
    cases.push({
      id: `f${String(fileIndex).padStart(2, '0')}-${offset + 2}`,
      source,
      group: String(cell('group')).trim() || source,
      name,
      precondition: numberedLines(cell('precondition')),
      steps: numberedLines(cell('steps')),
      expected: numberedLines(cell('expected')),
      tags: numberedLines(cell('tags')),
    });
  }
  return cases;
}

/** What the agent is asked to do: the preconditions it must establish, then the steps. */
export function goalFor(testCase) {
  const parts = [];
  if (testCase.precondition.length) parts.push(`前置条件：${testCase.precondition.join('；')}`);
  parts.push(`目标：${testCase.steps.join('；') || testCase.name}`);
  return parts.join('\n');
}

/** The result the sheet expects, as one paragraph for the judging question. */
export function expectedFor(testCase) {
  return testCase.expected.join('\n') || testCase.name;
}

/**
 * One question about the screen the run ended on: does it show what the sheet expects? It is the same
 * `noul` primitive the loop uses to refuse an unearned DONE, applied to the sheet's own wording. The
 * preconditions are left out: they describe the starting state, not the result.
 */
export async function judgeExpected({ request, apiKey, model, image, testCase, threshold = 0.8 }) {
  if (!image) throw new Error('A judgment needs a screenshot of the final screen.');
  const response = decodeJson(
    await request({
      url: apiUrl(),
      apiKey,
      method: 'POST',
      body: {
        model,
        state: {
          goal: `${testCase.name}：${expectedFor(testCase)}`,
          screen: 'screenshot',
          next: testCase.steps.join('；'),
        },
        questions: {
          expected_visible: {
            type: 'noul',
            instructions:
              'The screen was captured after the steps in `next` were taken. Does it show the expected result described in `goal`? Answer only about what is visible now.',
          },
        },
        assets: { screenshot: { type: 'image', format: 'png', data_base64: image } },
      },
    }),
  );
  const probability = response?.answers?.expected_visible?.noul;
  return {
    probability,
    verified: Number.isFinite(probability) && probability >= threshold,
    threshold,
    usage: response?.usage,
    responseModel: response?.model,
  };
}

function apiUrl() {
  const base = process.env.TYPESAFE_BASE_URL;
  return base ? `${base.replace(/\/+$/, '')}/systemone` : 'https://api.typesafe.ai/v1/systemone';
}

/**
 * What the evidence supports. The model's own status and the screen are reported separately, because
 * a run can reach the right state without recognising it, and can claim a state it never reached.
 */
export function verdictOf({ status, judgment, error }) {
  if (error) return 'error';
  if (judgment?.verified) return status === 'done' ? 'pass' : 'pass_unclaimed';
  if (status === 'done') return 'claimed_only';
  return 'fail';
}

/**
 * One line per case, keeping the last one written.
 *
 * Two runners on one device each append their own verdict, and a reader that takes them all says a case
 * was run twice. The file is rewritten on every record, so this also cleans a file an earlier run left
 * with duplicates.
 */
export function oneLinePerCase(entries) {
  const last = new Map();
  for (const entry of entries) if (entry?.id) last.set(entry.id, entry);
  return [...last.values()];
}

/** One line per case for the morning summary, worst first. */
export function summaryMarkdown(runs) {
  const order = { error: 0, fail: 1, claimed_only: 2, pass_unclaimed: 3, pass: 4 };
  const sorted = [...runs].sort(
    (a, b) => (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9) || a.id.localeCompare(b.id),
  );
  const counts = runs.reduce((all, run) => {
    all[run.verdict] = (all[run.verdict] ?? 0) + 1;
    return all;
  }, {});
  const lines = [
    '# Test case run',
    '',
    `${runs.length} cases run on ${process.env.ADB_SERIAL || 'the configured device'}.`,
    '',
    Object.entries(counts)
      .map(([verdict, count]) => `${verdict}: ${count}`)
      .join(', '),
    '',
    '| id | group | case | verdict | model | screen | steps |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const run of sorted) {
    const screen = Number.isFinite(run.judgment?.probability)
      ? `${Math.round(run.judgment.probability * 100)}%`
      : 'n/a';
    lines.push(
      `| ${run.id} | ${run.group} | ${run.name.replace(/\|/g, '\\|')} | ${run.verdict} | ${run.status ?? '-'} | ${screen} | ${run.steps ?? '-'} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}
