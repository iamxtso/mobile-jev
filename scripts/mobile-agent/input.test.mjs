import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textCandidates } from './text.mjs';
import { summarizeState, assertFresh } from './device.mjs';
import { candidatesFor, describeAction } from './actions.mjs';
import { TypeSafePolicy } from './policy.mjs';
import { runAgent } from './agent.mjs';
process.env.TYPESAFE_MODEL ??= 'test-model';

const bounds = { left: 0, top: 0, right: 400, bottom: 100 };
const input = {
  className: 'android.widget.EditText',
  isEditable: false,
  isVisibleToUser: true,
  isEnabled: true,
  boundsInScreen: bounds,
  children: [],
};
const raw = () => ({
  device_context: { screen_bounds: { width: 400, height: 800 } },
  phone_state: { packageName: 'app', keyboardVisible: true, isEditable: false },
  a11y_tree: { children: [structuredClone(input)] },
});
const answer = (criteria, choice) => ({
  type: 'choice',
  choice,
  confidence: 1,
  probabilities: Object.fromEntries(Object.keys(criteria).map((id) => [id, id === choice ? 1 : 0])),
});

test('goal spans include the requested city verbatim and explicit values override extraction', () => {
  const result = textCandidates(
    'Book an Airbnb for the 20 - 22 of September in San francisco by using the cheapest one',
  );
  assert.ok(result.values.includes('San francisco'));
  assert.equal(result.values.includes('San Francisco'), false);
  assert.deepEqual(textCandidates('Something else', ['San Francisco']).values, ['San Francisco']);
  assert.equal(
    textCandidates(Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ')).overflow,
    true,
  );
});

test('a quoted value is offered first, which is the only signal in text written without spaces', () => {
  // The goal has one whitespace-delimited word, so the span search can only offer the whole sentence.
  const quoted = textCandidates('在导航搜索框输入“充电站”，然后点击搜索按钮。');
  assert.equal(quoted.values[0], '充电站');
  assert.ok(quoted.values.includes('在导航搜索框输入“充电站”，然后点击搜索按钮。'));
  // Straight quotes, corner brackets and book-title marks are all quotation on this device.
  for (const goal of [
    '搜索 "星海广场" 并导航',
    '在搜索框输入「大连北站」',
    '把出发地设为《和平广场》',
  ]) {
    assert.equal(textCandidates(goal).values[0], goal.match(/["「《]([^"」》]+)["」》]/u)[1], goal);
  }
  // A goal with no quotation keeps the plain span search.
  assert.deepEqual(textCandidates('打开设置', []).values[0], '打开设置');
});

test('a value asked for without quotes is offered up to the next clause mark', () => {
  // The sheet writes `输入重庆、选择…`: no quotes, no spaces, so the span search can only offer the
  // whole sentence and the model has nothing to type.
  const goal = '在导航应用中点击搜索框，输入重庆、选择搜索目录中第一个地点的导航按钮，开始导航';
  assert.equal(textCandidates(goal).values[0], '重庆');
  // English keeps its spaces, so it stays with the span search.
  assert.ok(
    textCandidates('Search for San francisco and tap the first result').values.includes(
      'San francisco',
    ),
  );
});

test('visible children survive invisible accessibility containers', () => {
  const data = raw();
  data.a11y_tree.isVisibleToUser = false;
  const state = summarizeState(data, 'phone');
  assert.equal(state.elements.length, 1);
  assert.equal(state.elements[0].editable, true);
});

test('EditText plus a visible keyboard recovers inconsistent editable metadata without guessing between fields', () => {
  const data = raw();
  const state = summarizeState(data, 'phone');
  assert.equal(state.phone.isEditable, true);
  assert.equal(state.phone.focusEvidence, 'single-input-with-keyboard');
  data.phone_state.keyboardVisible = false;
  assert.equal(summarizeState(data, 'phone').phone.isEditable, false);
  data.phone_state.keyboardVisible = true;
  data.a11y_tree.children.push(structuredClone(input));
  assert.equal(summarizeState(data, 'phone').phone.isEditable, false);
});

test('autocomplete inputs are editable even when Android omits the editable flag', () => {
  for (const className of [
    'android.widget.AutoCompleteTextView',
    'android.widget.MultiAutoCompleteTextView',
  ]) {
    const data = raw();
    data.a11y_tree.children[0].className = className;
    const state = summarizeState(data, 'phone');
    assert.equal(state.phone.isEditable, true);
    assert.equal(state.elements[0].editable, true);
  }
});

test('input labels do not inherit nested Back buttons and password inputs do not get text candidates', () => {
  const data = raw();
  data.a11y_tree.children[0].children.push({
    text: 'Back',
    isClickable: true,
    boundsInScreen: bounds,
  });
  const state = summarizeState(data, 'phone');
  assert.equal(
    describeAction({ type: 'tap-element', elementId: 'ui.0' }, state),
    'Focus text input: empty input field.',
  );
  data.a11y_tree.children[0].isPassword = true;
  assert.equal(candidatesFor(summarizeState(data, 'phone'), ['hello']).text_0, undefined);
});

test('typing guards ignore unrelated suggestion updates but reject a changed input', () => {
  const before = summarizeState(raw(), 'phone'),
    after = structuredClone(before);
  after.elements.push({ id: 'suggestion', text: 'Different suggestion' });
  after.fingerprint = 'changed';
  assert.doesNotThrow(() => assertFresh(after, before, { type: 'type', text: 'San Francisco' }));
  after.elements[0].text = 'Someone typed';
  assert.throws(
    () => assertFresh(after, before, { type: 'type', text: 'San Francisco' }),
    /Screen changed/,
  );
});

test('Jev selects a goal span in the same request; NONE returns needs_input without an action', async () => {
  let chooseNone = false;
  const policy = new TypeSafePolicy({
    request: async ({ body }) => {
      const entry = Object.entries(body.questions.text_value.criteria).find(
        ([, value]) => value === 'San Francisco',
      );
      assert.ok(entry);
      return Buffer.from(
        JSON.stringify({
          answers: {
            operation: answer(body.questions.operation.criteria, 'TYPE_TEXT'),
            text_value: answer(body.questions.text_value.criteria, chooseNone ? 'NONE' : entry[0]),
          },
        }),
      );
    },
  });
  const args = { goal: 'Search San Francisco', observation: summarizeState(raw(), 'phone') };
  assert.equal((await policy.decide(args)).action.text, 'San Francisco');
  chooseNone = true;
  const result = await policy.decide(args);
  assert.equal(result.status, 'needs_input');
  assert.equal(result.action, undefined);
});

test('a fourth loading wait is allowed, but elapsed wait budgets still stop the run', async () => {
  const observation = summarizeState(raw(), 'phone');
  const device = { assertReady: async () => {}, observe: async () => observation };
  let decisions = 0;
  const policy = {
    decide: async () =>
      decisions++ < 4 ? { status: 'action', action: { type: 'wait' } } : { status: 'done' },
  };
  const result = await runAgent({
    device,
    policy,
    goal: 'Wait for app',
    execute: true,
    maxSteps: 6,
  });
  assert.equal(result.status, 'done');
  assert.equal(result.steps, 4);
  decisions = 0;
  const timed = await runAgent({
    device,
    policy,
    goal: 'Wait for app',
    execute: true,
    waitTimeoutMs: 0,
  });
  assert.equal(timed.status, 'loading_timeout');
  assert.equal(timed.steps, 0);
});
