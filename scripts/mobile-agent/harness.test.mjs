import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeState } from './device.mjs';
import { candidatesFor, runAgent } from './agent.mjs';
test('nested identical scroll regions produce one candidate per direction', () => {
  const observation = summarizeState(state(), 'phone');
  const scroll = {
    enabled: true,
    scrollable: true,
    bounds: { left: 0, top: 100, right: 720, bottom: 1600 },
  };
  observation.elements.push({ ...scroll, id: 'scroll' }, { ...scroll, id: 'scroll.child' });
  const candidates = candidatesFor(observation);
  assert.equal(Object.keys(candidates).filter((key) => key.startsWith('scroll_')).length, 4);
});
function state({ label = 'Settings', editable = false } = {}) {
  return {
    device_context: { screen_bounds: { width: 720, height: 1600 } },
    phone_state: { currentApp: 'Home', packageName: 'home', isEditable: editable },
    a11y_tree: {
      children: [
        {
          text: label,
          isClickable: true,
          isEnabled: true,
          boundsInScreen: { left: 10, top: 100, right: 110, bottom: 200 },
        },
        {
          text: 'hidden',
          isVisibleToUser: false,
          isClickable: true,
          boundsInScreen: { left: 0, top: 0, right: 100, bottom: 100 },
        },
      ],
    },
  };
}

test('summarizes UI without hidden nodes or password values; fingerprint excludes time', () => {
  const raw = state();
  raw.a11y_tree.children.push({
    isPassword: true,
    text: 'secret',
    contentDescription: 'secret',
    isEditable: true,
    boundsInScreen: { left: -5, top: 200, right: 800, bottom: 250 },
  });
  const a = summarizeState(raw, 'phone');
  assert.equal(a.elements.length, 2);
  assert.equal(JSON.stringify(a).includes('secret'), false);
  assert.deepEqual(a.elements[1].bounds, { left: 0, top: 200, right: 720, bottom: 250 });
  assert.equal(a.fingerprint, summarizeState(raw, 'phone').fingerprint);
  assert.throws(() => summarizeState({}, 'phone'), /UI state/);
});

test('a row whose name lives in a child keeps its tap; a blank icon does not', () => {
  const raw = state({ label: '' });
  raw.a11y_tree.children = [
    // A settings row: the clickable container is anonymous, its child carries the name.
    {
      isClickable: true,
      boundsInScreen: { left: 0, top: 100, right: 720, bottom: 200 },
      children: [{ text: '显示', boundsInScreen: { left: 40, top: 120, right: 300, bottom: 180 } }],
    },
    // An icon with nothing to name it: reachable by point, not by a guessed index.
    {
      isClickable: true,
      boundsInScreen: { left: 600, top: 0, right: 680, bottom: 80 },
      children: [],
    },
  ];
  const observation = summarizeState(raw, 'phone');
  const candidates = candidatesFor(observation);
  assert.ok(candidates['tap_ui.0'], 'the named row keeps a tap candidate');
  assert.equal(candidates['tap_ui.1'], undefined, 'the blank icon is not a tap candidate');
  assert.equal(observation.elements[0].nested, '显示');
});

test('disabled elements and unfocused text entry are excluded from policy actions', () => {
  const raw = state();
  raw.a11y_tree.children[0].isEnabled = false;
  const candidates = candidatesFor(summarizeState(raw, 'phone'), ['text']);
  assert.equal(candidates['tap_ui.0'], undefined);
  assert.equal(candidates.text_0, undefined);
});

function fakeDevice(initial) {
  const calls = [];
  const raw = initial || state();
  const device = {
    assertReady: async () => {},
    observe: async () => summarizeState(raw, 'phone'),
    act: async () => {
      calls.push(true);
      return {};
    },
  };
  return { device, calls };
}

test('preview does not mutate a device; unchanged repeated action stops the loop', async () => {
  const { device, calls } = fakeDevice();
  const policy = {
    decide: async () => ({ status: 'action', action: { type: 'tap-element', elementId: 'ui.0' } }),
  };
  const preview = await runAgent({ device, policy, goal: 'Settings' });
  assert.equal(preview.status, 'preview');
  assert.equal(calls.length, 0);
  const result = await runAgent({
    device,
    policy,
    goal: 'Settings',
    execute: true,
    settleMs: 0,
    settleTimeoutMs: 0,
  });
  assert.equal(result.status, 'stuck');
  assert.equal(result.steps, 1);
  assert.equal(calls.length, 1);
});

test('agent checks completion after the final allowed action and never exceeds budget', async () => {
  for (const complete of [true, false]) {
    const fixture = fakeDevice();
    let decisions = 0;
    const policy = {
      decide: async () => {
        decisions++;
        return complete && decisions > 1
          ? { status: 'done' }
          : { status: 'action', action: { type: 'global', name: 'home' } };
      },
    };
    const result = await runAgent({
      device: fixture.device,
      policy,
      goal: 'Home',
      execute: true,
      maxSteps: 1,
      settleMs: 0,
      settleTimeoutMs: 0,
    });
    assert.equal(result.status, complete ? 'done' : 'step_limit');
    assert.equal(result.steps, 1);
    assert.equal(fixture.calls.length, 1);
  }
});

test('taps a few pixels apart that change nothing still count as one stall', async () => {
  const { device, calls } = fakeDevice();
  // ui.0 sits at 10..110 x 100..200, so its centre is (60, 150).
  const points = [
    { type: 'tap', x: 60, y: 150 },
    { type: 'tap', x: 84, y: 151 },
    { type: 'tap', x: 46, y: 149 },
  ];
  let index = 0;
  const policy = {
    decide: async () => ({ status: 'action', action: points[index++ % points.length] }),
  };
  const result = await runAgent({
    device,
    policy,
    goal: 'Settings',
    execute: true,
    maxSteps: 8,
    settleMs: 0,
    settleTimeoutMs: 0,
  });
  assert.equal(result.status, 'stuck');
  assert.match(result.decision.reason, /3 taps around/);
  assert.equal(calls.length, 3);
});

test('a tap that changes the screen resets the stall counter', async () => {
  const { device } = fakeDevice();
  let step = 0;
  let screens = 0;
  // The screen changes after every tap, so the run is allowed to keep going.
  device.observe = async () => {
    const observation = summarizeState(state(), 'phone');
    observation.fingerprint = `screen-${screens++}`;
    return observation;
  };
  const policy = {
    decide: async () => {
      step++;
      return step > 6
        ? { status: 'done' }
        : { status: 'action', action: { type: 'tap', x: 60, y: 150 } };
    },
  };
  const result = await runAgent({
    device,
    policy,
    goal: 'Settings',
    execute: true,
    maxSteps: 8,
    settleMs: 0,
    settleTimeoutMs: 0,
  });
  assert.equal(result.status, 'done');
});

test('two scrollable columns on one screen give two independent scroll targets', () => {
  const raw = state();
  raw.a11y_tree.children.push(
    {
      text: 'left column',
      isScrollable: true,
      isEnabled: true,
      boundsInScreen: { left: 0, top: 200, right: 350, bottom: 1500 },
    },
    {
      text: 'right column',
      isScrollable: true,
      isEnabled: true,
      boundsInScreen: { left: 370, top: 200, right: 720, bottom: 1500 },
    },
  );
  const observation = summarizeState(raw, 'phone');
  const candidates = candidatesFor(observation);
  const scrolls = Object.entries(candidates).filter(([key]) => key.startsWith('scroll_down_'));
  assert.equal(scrolls.length, 2);
  const regions = scrolls.map(([, action]) => action.regionId);
  assert.equal(new Set(regions).size, 2, 'each column keeps its own region');
  // Each gesture stays inside its own column: a swipe in the left one never crosses x=350.
  for (const [key, action] of scrolls) {
    const column = observation.elements.find((element) => element.id === action.regionId);
    assert.ok(action.startX >= column.bounds.left && action.startX <= column.bounds.right, key);
  }
});

test('the same operation that cannot make progress three times stops the run', async () => {
  const { device, calls } = fakeDevice();
  // The fingerprint moves on its own (a clock), so the exact-repeat guard cannot see this loop.
  let screens = 0;
  device.observe = async () => {
    const observation = summarizeState(state(), 'phone');
    observation.fingerprint = `screen-${screens++}`;
    return observation;
  };
  // Each stall switches operation, so the stop can only come once the recovery budget is spent.
  const loop = ['EXPAND_NOTIFICATIONS', 'EXPAND_QUICK_SETTINGS', 'COLLAPSE_NOTIFICATIONS', 'HOME'];
  const policy = {
    decide: async ({ avoid }) => ({
      status: 'action',
      operation: loop.find((operation) => !avoid.has(operation)),
      action: { type: 'statusbar', expand: true },
    }),
  };
  const result = await runAgent({
    device,
    policy,
    goal: 'Read the notifications',
    execute: true,
    maxSteps: 20,
    settleMs: 0,
    settleTimeoutMs: 0,
  });
  assert.equal(result.status, 'stuck');
  assert.match(result.decision.reason, /3 × HOME/);
  assert.equal(calls.length, 12);
});
