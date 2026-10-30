import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { MutationUncertainError, summarizeState } from './device.mjs';
import { candidatesFor, runAgent } from './agent.mjs';
import { encodePng } from './pixels.mjs';
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

test('a tap whose only evidence is pixels is not counted as a stall', async () => {
  const glyph = (lit) =>
    encodePng({
      width: 200,
      height: 300,
      paint: (x, y) =>
        lit && x >= 20 && x < 60 && y >= 120 && y < 160 ? [250, 250, 250] : [20, 20, 20],
    });
  const run = async (screens, { helperJpeg = false } = {}) => {
    const calls = [];
    const device = {
      assertReady: async () => {},
      observe: async () => summarizeState(state(), 'phone'),
      act: async () => {
        calls.push(true);
        return {};
      },
      screenshot: async () => screens(Math.min(calls.length, 1)),
    };
    // The helper's own screenshot is a JPEG; a pixel comparison has to skip it and ask for a PNG.
    if (helperJpeg) device.snapshotImage = '/9j/4AAQSkZJRgABAQAAAQ==';
    const policy = {
      decide: async () => ({
        status: 'action',
        action: { type: 'tap-element', elementId: 'ui.0' },
      }),
    };
    const result = await runAgent({
      device,
      policy,
      goal: 'Pause the music',
      execute: true,
      maxSteps: 3,
      settleMs: 0,
      settleTimeoutMs: 0,
    });
    return { result, actions: calls.length };
  };
  // The glyph under the tap swaps while the tree stays identical: the tap worked, and the run says
  // so instead of calling the screen dead — but it does not repeat a toggle it cannot confirm.
  const swapped = await run((step) => glyph(step === 1));
  assert.equal(swapped.result.status, 'stuck');
  assert.match(swapped.result.decision.reason, /changed 16% of the control's pixels/);
  assert.equal(swapped.actions, 1);
  // Identical screenshots stay a dead screen: the repeat guard fires on the second identical step.
  const identical = await run(() => glyph(false));
  assert.equal(identical.result.status, 'stuck');
  // A dead screen still stops the run, and now says so: the reason used to be empty, which read the same
  // as "no reason recorded".
  assert.match(identical.result.decision.reason, /repeated the same action on target/);
  assert.equal(identical.actions, 1);
  // A JPEG from the helper is not evidence either way: the PNG path answers instead.
  const fromJpeg = await run((step) => glyph(step === 1), { helperJpeg: true });
  assert.match(fromJpeg.result.decision.reason, /changed 16% of the control's pixels/);
});

test('a control that redrew and reads as the goal met confirms the tap', async () => {
  const glyph = (lit) =>
    encodePng({
      width: 200,
      height: 300,
      paint: (x, y) =>
        lit && x >= 20 && x < 60 && y >= 120 && y < 160 ? [250, 250, 250] : [20, 20, 20],
    });
  const run = async (read, decide) => {
    const calls = [];
    const device = {
      assertReady: async () => {},
      observe: async () => summarizeState(state(), 'phone'),
      act: async () => {
        calls.push(true);
        return {};
      },
      screenshot: async () => glyph(calls.length >= 1),
    };
    const seen = [];
    const policy = {
      decide:
        decide ??
        (async () => ({ status: 'action', action: { type: 'tap-element', elementId: 'ui.0' } })),
      readsControlChange: async (request) => {
        seen.push(request);
        return read;
      },
    };
    const result = await runAgent({
      device,
      policy,
      goal: 'Pause the music',
      execute: true,
      maxSteps: 3,
      settleMs: 0,
      settleTimeoutMs: 0,
    });
    return { result, actions: calls.length, seen };
  };
  // Both crops are of the same control, and the answer is enough to finish: repeating a confirmed
  // toggle would undo it, so the run stops with the evidence instead of tapping again.
  const confirmed = await run({ change: 'changed', confidence: 0.99, satisfied: 0.97 });
  assert.equal(confirmed.result.status, 'done');
  assert.equal(confirmed.actions, 1);
  assert.match(confirmed.result.decision.reason, /shows the goal met \(97%\)/);
  assert.equal(confirmed.seen.length, 1);
  assert.ok(confirmed.seen[0].before && confirmed.seen[0].after, 'both crops are sent');
  // The drawing changed but does not read as the goal: the tap worked and the result is unknown, so
  // the run stops without claiming either.
  const unproven = await run({ change: 'changed', confidence: 0.99, satisfied: 0.2 });
  assert.equal(unproven.result.status, 'stuck');
  assert.match(unproven.result.decision.reason, /changed 16% of the control's pixels/);
  // Nothing changed under the tap: no confirmation, and the same stop.
  const untouched = await run({ change: 'same', confidence: 0.99, satisfied: 0.05 });
  assert.equal(untouched.result.status, 'stuck');
  // Below the confidence the answer needs, an unconfirmed tap stays unconfirmed.
  const unsure = await run({ change: 'changed', confidence: 0.6, satisfied: 0.95 });
  assert.equal(unsure.result.status, 'stuck');
  // A DONE that the screen cannot confirm is upgraded only by that same reading.
  let taps = 0;
  const doneAfterTap = async () =>
    taps++ === 0
      ? { status: 'action', action: { type: 'tap-element', elementId: 'ui.0' } }
      : { status: 'done_unverified', reason: 'goal not visible (38%)' };
  const upgraded = await run(
    { change: 'changed', confidence: 0.99, satisfied: 0.96 },
    doneAfterTap,
  );
  assert.equal(upgraded.result.status, 'done');
  assert.match(upgraded.result.decision.reason, /reads as the goal being met \(96%\)/);
  // The same tap with a weaker goal reading leaves the model's claim unverified.
  taps = 0;
  const unprovenDone = await run(
    { change: 'changed', confidence: 0.99, satisfied: 0.7 },
    doneAfterTap,
  );
  assert.equal(unprovenDone.result.status, 'done_unverified');
});

// A home screen moves on its own: the launcher rotates its voice tips every 7-9 s. A tap has to be
// judged by the control it hit, or every tap on such a screen looks like progress.
const homeScreen = ({ row = 'Pause', tips = '“接电话”', dialog = false, above = false } = {}) => ({
  device_context: { screen_bounds: { width: 200, height: 400 } },
  phone_state: { packageName: 'home', currentApp: 'home/.MainActivity' },
  a11y_tree: {
    children: [
      ...(above
        ? [{ text: 'weather', boundsInScreen: { left: 0, top: 0, right: 200, bottom: 60 } }]
        : []),
      ...(row
        ? [
            {
              text: row,
              isClickable: true,
              isEnabled: true,
              boundsInScreen: { left: 10, top: 100, right: 110, bottom: 200 },
            },
          ]
        : []),
      { text: tips, boundsInScreen: { left: 10, top: 300, right: 190, bottom: 330 } },
      ...(dialog
        ? [
            {
              text: 'OK',
              isClickable: true,
              isEnabled: true,
              boundsInScreen: { left: 10, top: 200, right: 190, bottom: 260 },
            },
          ]
        : []),
    ],
  },
});

// The change a single tap is credited with, as the run reported it.
const creditedChange = async (before, after) => {
  const readings = [before, after];
  let reads = 0;
  const seen = [];
  const device = {
    assertReady: async () => {},
    observe: async () => summarizeState(readings[Math.min(reads++, readings.length - 1)], 'phone'),
    act: async () => ({}),
  };
  await runAgent({
    device,
    policy: {
      decide: async () => ({
        status: 'action',
        action: { type: 'tap-element', elementId: 'ui.0' },
      }),
    },
    goal: 'Pause the music',
    execute: true,
    maxSteps: 1,
    settleMs: 0,
    settleTimeoutMs: 0,
    onObservation: ({ screenChanged }) => seen.push(screenChanged),
  });
  return seen[0];
};

test('a tap is judged by the control it hit, not by churn around it', async () => {
  // The rotating tips card changes; the tapped control does not.
  assert.equal(await creditedChange(homeScreen(), homeScreen({ tips: '“音量最小”' })), false);
  assert.equal(await creditedChange(homeScreen(), homeScreen()), false);
  // The control itself answers, disappears, or the tap opens something.
  assert.equal(await creditedChange(homeScreen(), homeScreen({ row: 'Playing' })), true);
  assert.equal(await creditedChange(homeScreen(), homeScreen({ row: null })), true);
  assert.equal(await creditedChange(homeScreen(), homeScreen({ dialog: true })), true);
  // A node appearing above the control renames every path id below it. Still not the tap's doing.
  assert.equal(await creditedChange(homeScreen(), homeScreen({ above: true })), false);
});

test('a typed action reports which text tier carried it', async () => {
  const fixture = fakeDevice();
  fixture.device.act = async () => ({ inputTier: 'clipboard' });
  const events = [];
  const policy = {
    decide: async () => ({ status: 'action', action: { type: 'type', text: '重庆', clear: true } }),
  };
  await runAgent({
    device: fixture.device,
    policy,
    goal: 'Search for 重庆',
    execute: true,
    maxSteps: 1,
    settleMs: 0,
    settleTimeoutMs: 0,
    onAction: (event) => events.push(event),
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].inputTier, 'clipboard');
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
  // The tapped row restates its value on every read, so each tap visibly does something.
  device.observe = async () => summarizeState(state({ label: `Settings ${screens++}` }), 'phone');
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

test('a long press that changes nothing is tried again, held longer', async () => {
  const calls = [];
  const raw = state();
  const device = {
    assertReady: async () => {},
    observe: async () => summarizeState(raw, 'phone'),
    act: async (action) => {
      calls.push(action);
      return {};
    },
  };
  const policy = {
    decide: async () => ({
      status: 'action',
      operation: 'LONG_PRESS',
      action: { type: 'long-press', elementId: 'ui.0' },
      confidence: 0.95,
    }),
  };
  await runAgent({
    device,
    policy,
    goal: 'Leave screen cleaning mode',
    execute: true,
    maxSteps: 1,
  });
  // 600 ms first, then the same control at 3 s: a screen locked behind a three-second hold releases
  // for nobody who presses for 600 ms, and the policy has no way to ask for a duration.
  assert.equal(calls[0].duration, undefined);
  assert.equal(calls[1].duration, 3000);
  assert.equal(calls[1].elementId, 'ui.0');
  // A press that already carries a duration is taken as it is.
  calls.length = 0;
  await runAgent({
    device: {
      ...device,
      act: async (action) => {
        calls.push(action);
        return {};
      },
    },
    policy: {
      decide: async () => ({
        status: 'action',
        operation: 'LONG_PRESS',
        action: { type: 'long-press', elementId: 'ui.0', duration: 1200 },
        confidence: 0.95,
      }),
    },
    goal: 'Leave screen cleaning mode',
    execute: true,
    maxSteps: 1,
  });
  assert.deepEqual(
    calls.map((call) => call.duration),
    [1200],
  );
});

test('a longer hold whose outcome is unknown ends the run instead of being swallowed', async () => {
  const calls = [];
  const asks = [];
  const raw = state();
  const device = {
    assertReady: async () => {},
    observe: async () => summarizeState(raw, 'phone'),
    act: async (action) => {
      calls.push(action);
      // The first press lands and draws nothing; the escalated press lands and the answer never comes.
      if (calls.length > 1) throw new MutationUncertainError('ADB mutation outcome is uncertain.');
      return {};
    },
  };
  const policy = {
    decide: async () => {
      asks.push(true);
      return {
        status: 'action',
        operation: 'LONG_PRESS',
        action: { type: 'long-press', elementId: 'ui.0' },
        confidence: 0.95,
      };
    },
  };
  await assert.rejects(
    () =>
      runAgent({
        device,
        policy,
        goal: 'Leave screen cleaning mode',
        execute: true,
        maxSteps: 2,
      }),
    /uncertain/,
  );
  // Nothing is sent after a press that may have landed, and the model is not asked to decide again.
  assert.equal(calls.length, 2);
  assert.equal(asks.length, 1);
});

test('an uncertain open-app inside network recovery ends the run', async () => {
  const { device, calls } = fakeDevice();
  const offline = { internet: false, wifiOn: false, saved: 2 };
  device.observe = async () => ({
    ...summarizeState(state(), 'phone'),
    network: offline,
  });
  device.listApps = async () => [{ packageName: 'com.example.settings', label: 'Settings' }];
  device.act = async (action) => {
    calls.push(action);
    if (action.type === 'open-app')
      throw new MutationUncertainError(
        'ADB mutation outcome is uncertain; the action was not retried.',
      );
    return {};
  };
  const policy = { decide: async () => ({ status: 'blocked', reason: 'no network' }) };
  await assert.rejects(
    () =>
      runAgent({
        device,
        policy,
        goal: 'search for a place',
        execute: true,
        maxSteps: 8,
        settleMs: 0,
        settleTimeoutMs: 0,
      }),
    MutationUncertainError,
  );
  // Nothing is sent after the press that may have landed.
  assert.equal(calls.length, 1);
});

test('an uncertain guess tap inside network recovery ends the run', async () => {
  process.env.NETWORK_MEMO_PATH = join(tmpdir(), `network-memo-guess-${process.pid}.json`);
  const calls = [];
  const offline = { internet: false, wifiOn: false, saved: 2 };
  const menu = [
    {
      ...summarizeState(state(), 'phone').elements[0],
      id: 'ui.0',
      text: 'Network',
      label: '',
      resourceId: 'com.example.settings:id/row0',
      clickable: true,
      bounds: { left: 0, top: 100, right: 200, bottom: 180 },
    },
  ];
  // No screenshot: the page question cannot be asked, so recovery falls to the single guess tap.
  const screen = () => ({
    ...summarizeState(state(), 'phone'),
    network: offline,
    elements: menu,
  });
  const device = {
    assertReady: async () => {},
    observe: async () => screen(),
    observeDirect: async () => screen(),
    listApps: async () => [{ packageName: 'com.example.settings', label: 'Settings' }],
    act: async (action) => {
      calls.push(action);
      if (action.type !== 'open-app')
        throw new MutationUncertainError(
          'ADB mutation outcome is uncertain; the action was not retried.',
        );
      return {};
    },
  };
  const policy = {
    decide: async () => ({ status: 'blocked', reason: 'no network' }),
    confirmsNetworkScreen: async () => 0.99,
  };
  await assert.rejects(
    () =>
      runAgent({
        device,
        policy,
        goal: 'search for a place',
        execute: true,
        maxSteps: 8,
        settleMs: 0,
        settleTimeoutMs: 0,
      }),
    MutationUncertainError,
  );
  // The settings app was opened, the guess tap ended the run, and nothing followed it.
  assert.equal(calls.length, 2);
  delete process.env.NETWORK_MEMO_PATH;
});

test('an uncertain menu-row tap inside network recovery ends the run', async () => {
  process.env.NETWORK_MEMO_PATH = join(tmpdir(), `network-memo-row-${process.pid}.json`);
  const calls = [];
  const offline = { internet: false, wifiOn: false, saved: 2 };
  const menu = [
    { text: 'Bluetooth', clickable: true },
    { text: 'Network', clickable: true },
  ].map((node, index) => ({
    ...summarizeState(state(), 'phone').elements[0],
    id: `ui.${index}`,
    text: node.text,
    label: '',
    resourceId: `com.example.settings:id/row${index}`,
    clickable: true,
    bounds: { left: 0, top: 100 + index * 100, right: 200, bottom: 180 + index * 100 },
  }));
  const screen = () => ({
    ...summarizeState(state(), 'phone'),
    network: offline,
    elements: menu,
  });
  let onNetworkPage = false;
  const device = {
    assertReady: async () => {},
    observe: async () => screen(),
    observeDirect: async () => screen(),
    screenshot: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
    listApps: async () => [{ packageName: 'com.example.settings', label: 'Settings' }],
    act: async (action) => {
      calls.push(action);
      if (action.type === 'tap-element' && action.elementId === 'ui.1') onNetworkPage = true;
      if (action.type !== 'open-app')
        throw new MutationUncertainError(
          'ADB mutation outcome is uncertain; the action was not retried.',
        );
      return {};
    },
  };
  const policy = {
    decide: async () => ({ status: 'blocked', reason: 'no network' }),
    confirmsNetworkScreen: async () => (onNetworkPage ? 0.99 : 0.01),
  };
  await assert.rejects(
    () =>
      runAgent({
        device,
        policy,
        goal: 'search for a place',
        execute: true,
        maxSteps: 8,
        settleMs: 0,
        settleTimeoutMs: 0,
      }),
    MutationUncertainError,
  );
  // The settings app was opened, the first row tap ended the run, and nothing followed it.
  assert.equal(calls.length, 2);
  delete process.env.NETWORK_MEMO_PATH;
});

// The association wait below costs three real 2.5 s sleeps; that is the behaviour under test.
test('a Wi-Fi association wait keeps the repeat guard', async () => {
  const calls = [];
  // `saved: 0` keeps network recovery out of this run, so only the wait-and-guard path is exercised.
  const associating = { internet: false, wifiOn: true, saved: 0 };
  const button = {
    ...summarizeState(state(), 'phone').elements[0],
    id: 'ui.0',
    text: '重庆',
    label: '',
    resourceId: 'com.example.navi:id/result0',
    clickable: true,
    bounds: { left: 100, top: 100, right: 300, bottom: 200 },
  };
  const device = {
    assertReady: async () => {},
    observe: async () => ({
      ...summarizeState(state(), 'phone'),
      network: associating,
      elements: [button],
    }),
    act: async (action) => {
      calls.push(action);
      return {};
    },
  };
  const policy = {
    decide: async () => ({
      status: 'action',
      operation: 'TAP',
      action: { type: 'tap-element', elementId: 'ui.0' },
      label: 'Tap 重庆.',
    }),
  };
  const result = await runAgent({
    device,
    policy,
    goal: 'search for a place',
    execute: true,
    maxSteps: 8,
    settleMs: 0,
    settleTimeoutMs: 0,
  });
  assert.equal(result.status, 'stuck');
  assert.equal(calls.length, 1);
});

test('a run that would wait forever on a dead network opens the settings app once', async () => {
  const { device, calls } = fakeDevice();
  const offline = { internet: false, wifiOn: false, saved: 3 };
  device.observe = async () => ({
    ...summarizeState(state(), 'phone'),
    network: offline,
  });
  device.listApps = async () => [
    { packageName: 'com.sgmw.navi', label: 'Navi' },
    { packageName: 'com.sgmw.systemsettings', label: 'Systemsettings' },
  ];
  device.act = async (action) => {
    calls.push(action);
    return {};
  };
  const actions = [];
  const policy = {
    decide: async () => ({ status: 'action', operation: 'WAIT', action: { type: 'wait' } }),
  };
  const result = await runAgent({
    device,
    policy,
    goal: 'search for a place',
    execute: true,
    maxSteps: 8,
    settleMs: 0,
    settleTimeoutMs: 0,
    waitTimeoutMs: 60_000,
    onAction: (event) => actions.push(event),
  });
  // The recovery happens once, then the run reports the cause instead of burning the step budget.
  assert.equal(actions.filter((event) => event.operation === 'RECOVER_NETWORK').length, 1);
  assert.equal(
    calls.filter((action) => action.type === 'open-app').at(-1).packageName,
    'com.sgmw.systemsettings',
  );
  assert.equal(result.status, 'blocked');
  assert.match(result.decision.reason, /cannot reach the internet/);
});

test('the network recovery walks the settings menu until the network page arrives', async () => {
  process.env.NETWORK_MEMO_PATH = join(tmpdir(), `network-memo-walk-${process.pid}.json`);
  const { device, calls } = fakeDevice();
  const offline = { internet: false, wifiOn: false, saved: 2 };
  const menu = [
    { text: 'Bluetooth', clickable: true },
    { text: 'Network', clickable: true },
  ].map((node, index) => ({
    ...summarizeState(state(), 'phone').elements[0],
    id: `ui.${index}`,
    text: node.text,
    label: '',
    resourceId: `com.example.settings:id/row${index}`,
    clickable: true,
    bounds: { left: 0, top: 100 + index * 100, right: 200, bottom: 180 + index * 100 },
  }));
  let onNetworkPage = false;
  device.observe = async () => ({
    ...summarizeState(state(), 'phone'),
    network: offline,
    elements: menu,
  });
  device.observeDirect = async () => device.observe();
  device.screenshot = async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  device.listApps = async () => [{ packageName: 'com.example.settings', label: 'Settings' }];
  device.act = async (action) => {
    calls.push(action);
    if (action.type === 'tap-element' && action.elementId === 'ui.1') onNetworkPage = true;
    return {};
  };
  const asked = [];
  const policy = {
    decide: async () => ({ status: 'action', operation: 'WAIT', action: { type: 'wait' } }),
    confirmsNetworkScreen: async () => {
      asked.push('here');
      return onNetworkPage ? 0.99 : 0.01;
    },
  };
  const actions = [];
  await runAgent({
    device,
    policy,
    goal: 'search for a place',
    execute: true,
    maxSteps: 6,
    settleMs: 0,
    settleTimeoutMs: 0,
    waitTimeoutMs: 60_000,
    onAction: (event) => actions.push(event),
  });
  // Walked past the wrong row, stopped on the right one, and asked the page question at each stop.
  assert.deepEqual(
    actions
      .filter((event) => event.operation === 'RECOVER_NETWORK' && event.label.startsWith('Open'))
      .map((event) => event.label),
    // `Network` is tried first because the wording matched; the walk still confirmed the page before
    // stopping there, and `Bluetooth` was never touched.
    ['Open Settings to restore the network', 'Open Network'],
  );
  assert.ok(asked.length >= 2);
  delete process.env.NETWORK_MEMO_PATH;
});

test('the network recovery remembers the entry, so the next run skips the walk', async () => {
  const memo = join(tmpdir(), `network-memo-${process.pid}-${Date.now()}.json`);
  process.env.NETWORK_MEMO_PATH = memo;
  try {
    const walk = async () => {
      const { device, calls } = fakeDevice();
      const offline = { internet: false, wifiOn: false, saved: 2 };
      // No wording the hint list knows: only the walk can find it, and only the memo can skip it.
      const rows = ['Bluetooth', '无线局域网', 'Display'].map((text, index) => ({
        ...summarizeState(state(), 'phone').elements[0],
        id: `ui.${index}`,
        text,
        label: '',
        resourceId: `com.example.settings:id/row${index}`,
        clickable: true,
        bounds: { left: 0, top: 100 + index * 100, right: 200, bottom: 180 + index * 100 },
      }));
      let onNetworkPage = false;
      device.observe = async () => ({
        ...summarizeState(state(), 'phone'),
        network: offline,
        elements: rows,
      });
      device.observeDirect = async () => device.observe();
      device.screenshot = async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
      device.listApps = async () => [{ packageName: 'com.example.settings', label: 'Settings' }];
      device.act = async (action) => {
        calls.push(action);
        if (action.type === 'tap-element' && action.elementId === 'ui.1') onNetworkPage = true;
        return {};
      };
      const policy = {
        decide: async () => ({ status: 'action', operation: 'WAIT', action: { type: 'wait' } }),
        confirmsNetworkScreen: async () => (onNetworkPage ? 0.99 : 0.01),
      };
      const actions = [];
      await runAgent({
        device,
        policy,
        goal: 'search for a place',
        execute: true,
        maxSteps: 6,
        settleMs: 0,
        settleTimeoutMs: 0,
        waitTimeoutMs: 60_000,
        onAction: (event) => actions.push(event),
      });
      return actions
        .filter((event) => event.operation === 'RECOVER_NETWORK' && event.label.startsWith('Open'))
        .map((event) => event.label);
    };
    const first = await walk();
    assert.deepEqual(first, ['Open Settings to restore the network', 'Open 无线局域网']);
    const second = await walk();
    // The remembered row is tried before the others this time.
    assert.deepEqual(second, ['Open Settings to restore the network', 'Open 无线局域网']);
  } finally {
    delete process.env.NETWORK_MEMO_PATH;
  }
});

test('the run goes back to the app it left once the network returns', async () => {
  process.env.NETWORK_MEMO_PATH = join(tmpdir(), `network-memo-return-${process.pid}.json`);
  const { device, calls } = fakeDevice();
  let online = false;
  let inSettings = false;
  const base = () => summarizeState(state(), 'phone');
  device.listApps = async () => [
    { packageName: 'com.example.settings', label: 'Settings' },
    { packageName: 'com.example.navi', label: 'Navi' },
  ];
  device.observe = async () => {
    const summary = base();
    return {
      ...summary,
      network: { internet: online, wifiOn: online, saved: 3 },
      phone: inSettings ? { ...summary.phone, packageName: 'com.example.settings' } : summary.phone,
    };
  };
  device.observeDirect = async () => device.observe();
  device.screenshot = async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  device.act = async (action) => {
    calls.push(action);
    if (action.type === 'open-app' && /settings/.test(action.packageName)) inSettings = true;
    if (action.type === 'open-app' && /navi/.test(action.packageName)) inSettings = false;
    if (action.type === 'tap-element' || action.type === 'tap-point') online = true;
    return {};
  };
  let openedNavi = false;
  const policy = {
    decide: async ({ coach }) => {
      // The model only knows it was handed back if the coach says so.
      if (coach && /in front again/.test(coach)) return { status: 'done', reason: 'back in Navi' };
      // The run starts in the keyboard-free launcher (`home`), which cannot be launched on its own, so the
      // return target comes from the last app the run opened.
      if (!openedNavi) {
        openedNavi = true;
        return {
          status: 'action',
          operation: 'OPEN_APP',
          action: { type: 'open-app', packageName: 'com.example.navi', appLabel: 'Navi' },
        };
      }
      return { status: 'action', operation: 'WAIT', action: { type: 'wait' } };
    },
    confirmsNetworkScreen: async () => (online ? 0.99 : 0.01),
  };
  const actions = [];
  const result = await runAgent({
    device,
    policy,
    goal: 'search for a place',
    execute: true,
    maxSteps: 8,
    settleMs: 0,
    settleTimeoutMs: 0,
    waitTimeoutMs: 60_000,
    onAction: (event) => actions.push(event),
  });
  const recovery = actions.filter((event) => event.operation === 'RECOVER_NETWORK');
  // Whatever the walk did, the last thing recovery does is hand the app back: the launcher `home` cannot be
  // launched, so it is the app the run opened before the detour.
  assert.equal(recovery.at(-1).label, 'Return to Navi');
  assert.equal(recovery.at(-2).label.startsWith('Open'), true);
  assert.equal(result.status, 'done');
});

test('a repeated tap that changes nothing says why the run stopped', async () => {
  const { device } = fakeDevice();
  // One clickable control, and a screenshot that never changes: the repeat cannot be confirmed.
  const button = {
    ...summarizeState(state(), 'phone').elements[0],
    id: 'ui.0',
    text: '重庆',
    label: '',
    resourceId: 'com.example.navi:id/result0',
    clickable: true,
    bounds: { left: 100, top: 100, right: 300, bottom: 200 },
  };
  device.observe = async () => ({
    ...summarizeState(state(), 'phone'),
    network: { internet: true, wifiOn: true, saved: 1 },
    elements: [button],
  });
  device.screenshot = async () => encodePng(20, 8, (x, y) => [x * 3, y * 5, 40, 255]);
  device.act = async () => ({});
  const policy = {
    decide: async () => ({
      status: 'action',
      operation: 'TAP',
      confidence: 0.9,
      target: '1',
      action: { type: 'tap-element', elementId: 'ui.0' },
      label: 'Tap 重庆.',
    }),
  };
  const result = await runAgent({
    device,
    policy,
    goal: 'search for a place',
    execute: true,
    maxSteps: 8,
    settleMs: 0,
    settleTimeoutMs: 0,
    waitTimeoutMs: 60_000,
  });
  assert.equal(result.status, 'stuck');
  assert.match(result.decision.reason, /repeated TAP on Tap 重庆\./);
});
