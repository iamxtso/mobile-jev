import assert from 'node:assert/strict';
import test from 'node:test';
import {
  casesFromRows,
  goalFor,
  oneLinePerCase,
  summaryMarkdown,
  verdictOf,
} from './testcase-suite.mjs';
import { columnIndex, decodeEntities, sheetRows, sharedStringText } from './xlsx.mjs';

const HEADER = [
  '分组名称',
  '测试用例名称',
  '前置条件',
  '执行方式',
  '测试步骤',
  '执行方式',
  '预期结果',
  '执行方式',
  '标签',
];

test('a sheet row becomes a case with its steps and expected result', () => {
  const rows = [
    HEADER,
    [
      '1028UI',
      '状态栏进入个人中心',
      '1.返回车机主页\n2.WIFI网络已连接',
      '触控模拟',
      '1.点击状态栏头像',
      '触控模拟',
      '1.进入个人中心',
      '视觉信号',
      'nan',
    ],
  ];
  const [testCase] = casesFromRows('新1UI.xlsx', 7, rows);
  assert.equal(testCase.id, 'f07-2');
  assert.equal(testCase.group, '1028UI');
  assert.deepEqual(testCase.precondition, ['返回车机主页', 'WIFI网络已连接']);
  assert.deepEqual(testCase.steps, ['点击状态栏头像']);
  assert.deepEqual(testCase.expected, ['进入个人中心']);
  assert.deepEqual(testCase.tags, []);
});

test('column order is read from the header, so an extra column changes nothing', () => {
  const rows = [
    ['预期结果', '测试用例名称', '测试步骤', '分组名称', '备注'],
    ['导航开始', '开始导航', '1.点击开始', '导航', 'ignored'],
  ];
  const [testCase] = casesFromRows('导航.xlsx', 9, rows);
  assert.equal(testCase.id, 'f09-2');
  assert.equal(testCase.name, '开始导航');
  assert.equal(testCase.group, '导航');
  assert.deepEqual(testCase.steps, ['点击开始']);
  assert.deepEqual(testCase.expected, ['导航开始']);
});

test('rows without a case name are skipped, and ids stay on their sheet row', () => {
  const rows = [
    HEADER,
    ['空'],
    ['组', '', '', '', '', '', '', '', ''],
    ['组', '真用例', '', '', '1.做', '', '1.成', '', ''],
  ];
  const cases = casesFromRows('x.xlsx', 1, rows);
  assert.deepEqual(
    cases.map((c) => c.id),
    ['f01-4'],
  );
});

test('the goal carries preconditions and steps but never the expected result', () => {
  const goal = goalFor({
    name: 'n',
    precondition: ['返回车机主页'],
    steps: ['点击头像', '点击同意'],
    expected: ['进入个人中心'],
  });
  assert.match(goal, /前置条件：返回车机主页/);
  assert.match(goal, /目标：点击头像；点击同意/);
  assert.doesNotMatch(goal, /进入个人中心/);
});

test('a run that reached the screen without claiming it still counts as reached', () => {
  assert.equal(verdictOf({ status: 'done', judgment: { verified: true } }), 'pass');
  assert.equal(verdictOf({ status: 'stuck', judgment: { verified: true } }), 'pass_unclaimed');
  assert.equal(verdictOf({ status: 'done', judgment: { verified: false } }), 'claimed_only');
  assert.equal(verdictOf({ status: 'step_limit', judgment: { verified: false } }), 'fail');
  assert.equal(verdictOf({ status: 'error', error: 'adb gone' }), 'error');
});

test('a case with two lines is read once, as the line written last', () => {
  const lines = [
    { id: 'f01-2', verdict: 'fail' },
    { id: 'f01-3', verdict: 'pass' },
    { id: 'f01-2', verdict: 'pass_unclaimed' },
  ];
  assert.deepEqual(
    oneLinePerCase(lines).map((entry) => `${entry.id} ${entry.verdict}`),
    ['f01-2 pass_unclaimed', 'f01-3 pass'],
  );
});

test('the summary counts verdicts and puts failures first', () => {
  const runs = [
    {
      id: 'f01-2',
      group: 'g',
      name: 'b',
      verdict: 'pass',
      status: 'done',
      judgment: { probability: 0.99 },
    },
    {
      id: 'f01-3',
      group: 'g',
      name: 'a',
      verdict: 'fail',
      status: 'stuck',
      judgment: { probability: 0.1 },
    },
  ];
  const markdown = summaryMarkdown(runs);
  assert.match(markdown, /pass: 1, fail: 1/);
  assert.ok(markdown.indexOf('f01-3') < markdown.indexOf('f01-2'));
});

test('a cell reference maps to a zero-based column', () => {
  assert.equal(columnIndex('A1'), 0);
  assert.equal(columnIndex('K12'), 10);
  assert.equal(columnIndex('AA4'), 26);
});

test('a sheet keeps empty columns in place and drops empty rows', () => {
  const sheet = {
    sheetData: {
      row: [
        {
          c: [
            { '@_r': 'A1', v: '0', '@_t': 's' },
            { '@_r': 'C1', v: 'literal' },
          ],
        },
        { c: [{ '@_r': 'B2', v: '' }] },
        {
          c: [
            { '@_r': 'A3', '@_t': 'inlineStr', is: { t: 'two' } },
            { '@_r': 'B3', v: 'lines' },
          ],
        },
      ],
    },
  };
  assert.deepEqual(sheetRows(sheet, ['shared']), [
    ['shared', '', 'literal'],
    ['two', 'lines'],
  ]);
});

test('a shared string joins its styled runs and decodes an escaped break', () => {
  assert.equal(sharedStringText({ r: [{ t: 'a' }, { t: 'b' }] }), 'ab');
  assert.equal(decodeEntities('1.回到主页&#10;2.点击'), '1.回到主页\n2.点击');
});
