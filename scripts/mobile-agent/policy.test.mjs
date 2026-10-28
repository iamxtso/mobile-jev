import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuestions, TypeSafePolicy, validateChoice } from './policy.mjs';
import { assertFresh, StaleObservationError } from './device.mjs';
import { runAgent } from './agent.mjs';
process.env.TYPESAFE_MODEL ??= 'test-model';

const node = (id, text, extra = {}) => ({
  id,
  text,
  label: '',
  resourceId: id,
  bounds: { left: 0, top: 0, right: 200, bottom: 200 },
  enabled: true,
  clickable: true,
  editable: false,
  scrollable: false,
  ...extra,
});
const observe = () => ({
  deviceId: 'phone',
  observedAt: Date.now(),
  fingerprint: 'screen',
  screen: { width: 200, height: 400 },
  phone: { packageName: 'settings', isEditable: true },
  elements: [
    node('ui.0', 'Search', { editable: true }),
    node('ui.1', 'About phone'),
    node('ui.2', 'Settings list', { clickable: false, scrollable: true }),
  ],
});
const answer = (criteria, choice = Object.keys(criteria)[0], confidence = 1) => ({
  type: 'choice',
  choice,
  confidence,
  probabilities: Object.fromEntries(
    Object.keys(criteria).map((key) => [key, key === choice ? 1 : 0]),
  ),
});

test('operation and compatible targets are asked in one call; only selected target is consumed', async () => {
  let calls = 0;
  const policy = new TypeSafePolicy({
    request: async ({ body }) => {
      calls++;
      assert.deepEqual(Object.keys(body.questions), [
        'operation',
        'stuck',
        'tap_target',
        'gesture_target',
        'drag_direction',
        'text_value',
      ]);
      assert.equal(Object.keys(body.questions.tap_target.criteria).length, 2);
      // One scroll region: a one-option choice is rejected by the API, so the answer is forced.
      assert.equal(body.questions.scroll_target, undefined);
      return Buffer.from(
        JSON.stringify({
          model: 'jev-test',
          answers: {
            operation: answer(body.questions.operation.criteria, 'TAP'),
            tap_target: answer(body.questions.tap_target.criteria, '2'),
            scroll_target: { malicious: 'invalid unused answer' },
            text_value: null,
          },
        }),
      );
    },
  });
  const decision = await policy.decide({
    goal: 'Open About phone',
    observation: observe(),
    texts: ['hello'],
  });
  assert.equal(calls, 1);
  assert.equal(decision.operation, 'TAP');
  assert.equal(decision.action.elementId, 'ui.1');
  assert.equal(decision.responseModel, 'jev-test');
});

test('scroll choice consumes its region only; single-candidate target is supported', async () => {
  const policy = new TypeSafePolicy({
    request: async ({ body }) => {
      // A choice needs two options, so the only region is forced rather than asked.
      assert.equal(body.questions.scroll_target, undefined);
      return Buffer.from(
        JSON.stringify({
          answers: {
            operation: answer(body.questions.operation.criteria, 'SCROLL_DOWN'),
            tap_target: { choice: 'not-offered' },
          },
        }),
      );
    },
  });
  const decision = await policy.decide({ goal: 'Find version', observation: observe() });
  assert.equal(decision.action.type, 'swipe');
  assert.equal(decision.action.regionId, 'ui.2');
  assert.ok(decision.action.startY > decision.action.endY);
});

test('typing uses exactly one supplied value and never an unused tap answer', async () => {
  const policy = new TypeSafePolicy({
    request: async ({ body }) =>
      Buffer.from(
        JSON.stringify({
          answers: {
            operation: answer(body.questions.operation.criteria, 'TYPE_TEXT'),
            text_value: answer(body.questions.text_value.criteria, '2'),
          },
        }),
      ),
  });
  const result = await policy.decide({
    goal: 'Type Berlin',
    observation: observe(),
    texts: ['London', 'Berlin'],
  });
  assert.deepEqual(result.action, { type: 'type', text: 'Berlin', clear: true });
});

test('invalid selected distributions stop; unused questions are not required for DONE', async () => {
  let operation = 'TAP';
  const policy = new TypeSafePolicy({
    request: async ({ body }) =>
      Buffer.from(
        JSON.stringify({
          answers: {
            operation: answer(body.questions.operation.criteria, operation),
            tap_target: {
              type: 'choice',
              choice: 'shell-command',
              confidence: 1,
              probabilities: {},
            },
          },
        }),
      ),
  });
  await assert.rejects(policy.decide({ goal: 'Go', observation: observe() }), /invalid choice/);
  operation = 'DONE';
  assert.equal((await policy.decide({ goal: 'Go', observation: observe() })).status, 'done');
  for (const invalid of [
    { choice: 'x' },
    { confidence: NaN },
    { probabilities: { a: 0.9 } },
    { probabilities: { a: 0.2, b: 0.8 } },
    { probabilities: { a: 1, b: Infinity } },
  ])
    assert.throws(
      () => validateChoice({ ...answer({ a: '', b: '' }, 'a'), ...invalid }, { a: '', b: '' }),
      /invalid/,
    );
});

test('optional cutoff considers only operation and selected target', async () => {
  const policy = new TypeSafePolicy({
    threshold: 0.8,
    request: async ({ body }) =>
      Buffer.from(
        JSON.stringify({
          answers: {
            operation: answer(body.questions.operation.criteria, 'TAP'),
            tap_target: answer(body.questions.tap_target.criteria, '1', 0.4),
          },
        }),
      ),
  });
  assert.equal((await policy.decide({ goal: 'Go', observation: observe() })).status, 'uncertain');
  policy.threshold = 0;
  assert.equal((await policy.decide({ goal: 'Go', observation: observe() })).status, 'action');
});

test('unavailable operations are omitted', () => {
  const observation = observe();
  observation.phone.isEditable = false;
  observation.elements = [];
  const { questions } = buildQuestions(observation, ['text']);
  assert.deepEqual(Object.keys(questions), ['operation', 'stuck']);
  assert.equal(questions.operation.criteria.TAP, undefined);
  assert.equal(questions.operation.criteria.TYPE_TEXT, undefined);
  assert.equal(questions.operation.criteria.SCROLL_DOWN, undefined);
});

test('exact goal names narrow the inventory; one remaining app is forced', async () => {
  const policy = new TypeSafePolicy({
    request: async ({ body }) => {
      assert.equal(body.questions.app_target, undefined);
      assert.equal(body.state.availableApps.length, 1);
      assert.equal(body.state.availableApps[0].label, 'Notes');
      return Buffer.from(
        JSON.stringify({
          answers: {
            operation: answer(body.questions.operation.criteria, 'OPEN_APP'),
          },
        }),
      );
    },
  });
  const result = await policy.decide({
    goal: 'Open Notes',
    observation: observe(),
    apps: [
      { packageName: 'com.example.notes', label: 'Notes' },
      { packageName: 'com.example.music', label: 'Music' },
    ],
  });
  assert.equal(result.action.packageName, 'com.example.notes');
  assert.equal(result.operation, 'OPEN_APP');
});

test('target guards allow unrelated text updates and movement but reject changed identity or checked state', () => {
  const before = observe(),
    after = structuredClone(before);
  after.fingerprint = 'new';
  after.elements.push(node('clock', '12:34', { clickable: false }));
  after.elements[1].bounds.top = 20;
  assert.doesNotThrow(() => assertFresh(after, before, { type: 'tap-element', elementId: 'ui.1' }));
  after.elements[1].text = 'Purchase';
  assert.throws(
    () => assertFresh(after, before, { type: 'tap-element', elementId: 'ui.1' }),
    StaleObservationError,
  );
  after.elements[1].text = 'About phone';
  after.elements[1].checked = true;
  assert.throws(
    () => assertFresh(after, before, { type: 'tap-element', elementId: 'ui.1' }),
    StaleObservationError,
  );
  after.phone.packageName = 'other';
  assert.throws(
    () => assertFresh(after, before, { type: 'global', name: 'home' }),
    StaleObservationError,
  );
});

test('a point tap survives a screen that redraws elsewhere, but not a different control under it', () => {
  const before = observe(),
    after = structuredClone(before);
  // The launcher's rotating tips card: the tree and the whole-screen fingerprint differ, the control
  // under the point does not.
  after.fingerprint = 'rotated-card';
  after.elements.push(node('ui.9', 'Try saying: navigate home', { clickable: false }));
  const at = { type: 'tap', x: 100, y: 100 }; // inside ui.0, bounds 0,0-200,200
  assert.doesNotThrow(() => assertFresh(after, before, at));
  after.elements[0].text = 'Purchase';
  assert.throws(() => assertFresh(after, before, at), StaleObservationError);
  // A point that draws nothing in either read is still actionable: a dock glyph has no node at all.
  const blind = { type: 'tap', x: 500, y: 500 };
  assert.doesNotThrow(() => assertFresh(after, before, blind));
  after.elements.push(node('ui.10', 'Something arrived', { bounds: { left: 400, top: 400, right: 600, bottom: 600 } }));
  assert.throws(() => assertFresh(after, before, blind), StaleObservationError);
});

test('Back tolerates live text counters but rejects changed navigation controls', () => {
  const before = observe(),
    after = structuredClone(before);
  before.elements.push(node('uptime', '1:00:00', { clickable: false }));
  after.elements.push(node('uptime', '1:00:01', { clickable: false }));
  after.fingerprint = 'changed-clock';
  assert.doesNotThrow(() => assertFresh(after, before, { type: 'global', name: 'back' }));
  after.elements[1].text = 'Different screen';
  assert.throws(
    () => assertFresh(after, before, { type: 'global', name: 'back' }),
    StaleObservationError,
  );
});

test('three consecutive stale decisions stop without executing or consuming the action budget', async () => {
  let decisions = 0;
  const device = {
    assertReady: async () => {},
    observe: async () => observe(),
    act: async () => {
      throw new StaleObservationError('changed');
    },
  };
  const policy = {
    decide: async () => {
      decisions++;
      return { status: 'action', action: { type: 'global', name: 'home' } };
    },
  };
  const result = await runAgent({ device, policy, goal: 'Home', execute: true });
  assert.equal(result.status, 'unstable_screen');
  assert.equal(result.steps, 0);
  assert.equal(decisions, 3);
});

test('changed screens proceed without any fixed post-action wait', async () => {
  let reads = 0,
    decisions = 0;
  const device = {
    assertReady: async () => {},
    observe: async () => ({ ...observe(), fingerprint: String(reads++) }),
    act: async () => {},
  };
  const policy = {
    decide: async () =>
      decisions++
        ? { status: 'done' }
        : { status: 'action', action: { type: 'global', name: 'home' } },
  };
  const result = await runAgent({ device, policy, goal: 'Home', execute: true });
  assert.equal(result.timings.waitMs, 0);
  assert.equal(reads, 2);
});

test('transitional snapshots without a foreground app are polled before another model call', async () => {
  let reads = 0,
    decisions = 0;
  const device = {
    assertReady: async () => {},
    observe: async () => {
      const state = observe();
      reads++;
      state.fingerprint = String(reads);
      if (reads === 2) state.phone.packageName = '';
      return state;
    },
    act: async () => {},
  };
  const policy = {
    decide: async ({ observation }) => {
      assert.ok(observation.phone.packageName);
      return decisions++
        ? { status: 'done' }
        : { status: 'action', action: { type: 'global', name: 'home' } };
    },
  };
  const result = await runAgent({ device, policy, goal: 'Home', execute: true });
  assert.equal(result.status, 'done');
  assert.equal(reads, 3);
  assert.equal(decisions, 2);
});

test('execution is logged before a failing post-action observation', async () => {
  let reads = 0,
    logged = false,
    acted = false;
  const device = {
    assertReady: async () => {},
    observe: async () => {
      if (reads++) throw new Error('Read failed');
      return observe();
    },
    act: async () => {
      acted = true;
    },
  };
  const policy = {
    decide: async () => ({ status: 'action', action: { type: 'global', name: 'home' } }),
  };
  await assert.rejects(
    runAgent({
      device,
      policy,
      goal: 'Home',
      execute: true,
      onAction: async () => {
        assert.equal(acted, true);
        logged = true;
      },
    }),
    /Read failed/,
  );
  assert.equal(logged, true);
});

test('stale decisions re-observe and re-predict; uncertain mutations never retry', async () => {
  for (const stale of [true, false]) {
    let acts = 0,
      decisions = 0;
    const device = {
      assertReady: async () => {},
      observe: async () => observe(),
      act: async () => {
        acts++;
        if (acts === 1)
          throw stale ? new StaleObservationError('stale') : new Error('transport failed');
      },
    };
    const policy = {
      decide: async () => {
        decisions++;
        return decisions >= 3
          ? { status: 'done' }
          : { status: 'action', action: { type: 'global', name: 'home' } };
      },
    };
    const run = runAgent({ device, policy, goal: 'Home', execute: true, settleTimeoutMs: 0 });
    if (stale) {
      const result = await run;
      assert.equal(result.steps, 1);
      assert.equal(result.timings.staleRetries, 1);
      assert.equal(decisions, 3);
    } else {
      await assert.rejects(run, /transport failed/);
      assert.equal(acts, 1);
      assert.equal(decisions, 1);
    }
  }
});

// A row whose value changes on every read keeps the exact-repeat and nearby-tap guards out of the
// way, so a stop can only come from the stuck answer. A moved fingerprint alone is not enough: a tap
// is judged by the control it hit, and a home screen moves on its own anyway.
const steppingDevice = () => {
  let reads = 0,
    acts = 0;
  const device = {
    assertReady: async () => {},
    observe: async () => {
      const observation = observe();
      observation.elements[1].text = `About phone ${reads++}`;
      return observation;
    },
    act: async () => {
      acts++;
    },
  };
  return { device, acts: () => acts };
};

test('stuck above 0.85 on step 3 stops before dispatching input', async () => {
  const { device, acts } = steppingDevice();
  const policy = {
    decide: async ({ history }) => ({
      status: 'action',
      action: { type: 'tap', x: history.length, y: 10 },
      ...(history.length >= 3 ? { stuck: 0.92 } : {}),
    }),
  };
  const result = await runAgent({
    device,
    policy,
    goal: 'Reach the setting',
    execute: true,
    settleTimeoutMs: 0,
  });
  assert.equal(result.status, 'stuck');
  assert.equal(result.steps, 3);
  assert.equal(acts(), 3);
  assert.match(result.decision.reason, /not making progress \(92%\)/);
});

test('stuck below 0.85 does not stop the run', async () => {
  const { device, acts } = steppingDevice();
  const policy = {
    decide: async ({ history }) =>
      history.length >= 5
        ? { status: 'done' }
        : { status: 'action', stuck: 0.6, action: { type: 'tap', x: history.length, y: 10 } },
  };
  const result = await runAgent({
    device,
    policy,
    goal: 'Reach the setting',
    execute: true,
    settleTimeoutMs: 0,
  });
  assert.equal(result.status, 'done');
  assert.equal(result.steps, 5);
  assert.equal(acts(), 5);
});

test('a missing stuck answer stays undefined and does not stop the run', async () => {
  const policy = new TypeSafePolicy({
    request: async ({ body }) =>
      Buffer.from(
        JSON.stringify({
          answers: {
            operation: answer(body.questions.operation.criteria, 'TAP'),
            tap_target: answer(body.questions.tap_target.criteria),
          },
        }),
      ),
  });
  const decision = await policy.decide({ goal: 'Open About phone', observation: observe() });
  assert.equal(decision.status, 'action');
  assert.equal(decision.stuck, undefined);

  const { device, acts } = steppingDevice();
  const stuckless = {
    decide: async ({ history }) =>
      history.length >= 5
        ? { status: 'done' }
        : { status: 'action', action: { type: 'tap', x: history.length, y: 10 } },
  };
  const result = await runAgent({
    device,
    policy: stuckless,
    goal: 'Reach the setting',
    execute: true,
    settleTimeoutMs: 0,
  });
  assert.equal(result.status, 'done');
  assert.equal(acts(), 5);
});

test('a screenshot adds one box question; the accessibility tree is used when it has the control', async () => {
  const policy = new TypeSafePolicy({
    request: async ({ body }) => {
      assert.ok(body.assets.screenshot.data_base64);
      assert.equal(body.state.screen, 'screenshot');
      assert.ok(body.questions.operation.criteria.TAP_POINT);
      assert.equal(body.questions.target_point.type, 'box');
      assert.equal(typeof body.questions.target_point.instructions, 'string');
      return Buffer.from(
        JSON.stringify({
          answers: {
            operation: answer(body.questions.operation.criteria, 'TAP_POINT'),
            target_point: {
              type: 'box',
              box: { left: 0.45, top: 0.32, right: 0.55, bottom: 0.38 },
            },
          },
        }),
      );
    },
  });
  // Two separate rows on a 200x400 screen; the box marks the middle of the second one.
  const observation = observe();
  observation.elements = [
    node('ui.0', 'Search', { editable: true, bounds: { left: 0, top: 0, right: 200, bottom: 60 } }),
    node('ui.1', 'About phone', { bounds: { left: 0, top: 100, right: 200, bottom: 200 } }),
  ];
  const decision = await policy.decide({
    goal: 'Open About phone',
    observation,
    image: 'AAAA',
  });
  assert.equal(decision.operation, 'TAP_POINT');
  assert.equal(decision.snapped, true);
  assert.deepEqual(decision.action, { type: 'tap-element', elementId: 'ui.1' });
  assert.deepEqual(decision.point, { x: 100, y: 140 });
});

test('a point inside a row of identical icons is resolved by asking which icon, not where', async () => {
  const asked = [];
  const policy = new TypeSafePolicy({
    request: async ({ body }) => {
      if (body.questions.row) {
        asked.push(body.questions.row);
        return Buffer.from(
          JSON.stringify({ answers: { row: answer(body.questions.row.criteria, 'icon_1') } }),
        );
      }
      // The box marks the second icon; the row knows the first one is the one the goal needs.
      return Buffer.from(
        JSON.stringify({
          answers: {
            operation: answer(body.questions.operation.criteria, 'TAP_POINT'),
            target_point: { type: 'box', box: { left: 0.5, top: 0.8, right: 0.7, bottom: 0.9 } },
          },
        }),
      );
    },
  });
  const observation = observe();
  observation.elements = [
    node('ui.0', 'Track title', { clickable: false }),
    node('ui.1', '', {
      nested: '1 of 2 in rv_action_list',
      bounds: { left: 40, top: 320, right: 90, bottom: 380 },
    }),
    node('ui.2', '', {
      nested: '2 of 2 in rv_action_list',
      bounds: { left: 90, top: 320, right: 140, bottom: 380 },
    }),
  ];
  const decision = await policy.decide({ goal: 'Pause the music', observation, image: 'AAAA' });
  assert.equal(decision.operation, 'TAP_POINT');
  assert.deepEqual(decision.action, { type: 'tap-element', elementId: 'ui.1' });
  assert.deepEqual(decision.rowPick, { group: 'rv_action_list', index: 1, confidence: 1 });
  assert.equal(asked.length, 1);
  assert.equal(Object.keys(asked[0].criteria).length, 2);
  assert.match(asked[0].instructions, /rv_action_list/);
});

test('a screenshot still taps when no observed element contains the point', async () => {
  const policy = new TypeSafePolicy({
    request: async ({ body }) =>
      Buffer.from(
        JSON.stringify({
          answers: {
            operation: answer(body.questions.operation.criteria, 'TAP_POINT'),
            // Below every element in the fixture: 0.5..0.7 of 400px is y=200..280.
            target_point: { type: 'box', box: { left: 0.4, top: 0.5, right: 0.6, bottom: 0.7 } },
          },
        }),
      ),
  });
  const decision = await policy.decide({
    goal: 'Dismiss the banner',
    observation: observe(),
    image: 'AAAA',
  });
  assert.equal(decision.snapped, false);
  assert.deepEqual(decision.action, { type: 'tap', x: 100, y: 240 });
});

test('a box that is not four ordered fractions is rejected', async () => {
  const policy = new TypeSafePolicy({
    request: async ({ body }) =>
      Buffer.from(
        JSON.stringify({
          answers: {
            operation: answer(body.questions.operation.criteria, 'TAP_POINT'),
            target_point: { type: 'box', box: { left: 0.8, top: 0.1, right: 0.2, bottom: 0.3 } },
          },
        }),
      ),
  });
  await assert.rejects(
    policy.decide({ goal: 'Anything', observation: observe(), image: 'AAAA' }),
    /invalid box/,
  );
});

test('without a screenshot the request stays text-only', () => {
  const { questions } = buildQuestions(observe(), ['hello']);
  assert.equal(questions.target_point, undefined);
  assert.equal(questions.operation.criteria.TAP_POINT, undefined);
});

const visionPolicy = (goalVisible, operation = 'DONE') =>
  new TypeSafePolicy({
    request: async ({ body }) => {
      assert.equal(body.questions.goal_visible.type, 'noul');
      return Buffer.from(
        JSON.stringify({
          answers: {
            operation: answer(body.questions.operation.criteria, operation),
            target_point: { type: 'box', box: { left: 0.1, top: 0.1, right: 0.2, bottom: 0.2 } },
            goal_visible: { type: 'noul', noul: goalVisible },
          },
        }),
      );
    },
  });

test('DONE is reported as done only when the screen agrees', async () => {
  const decision = await visionPolicy(0.97).decide({
    goal: 'Open About phone',
    observation: observe(),
    image: 'AAAA',
  });
  assert.equal(decision.status, 'done');
  assert.equal(decision.goalVisible, 0.97);
  assert.equal(decision.reason, undefined);
});

test('DONE against a screen that does not show the goal is reported, not accepted', async () => {
  const decision = await visionPolicy(0).decide({
    goal: 'Post the message',
    observation: observe(),
    image: 'AAAA',
  });
  assert.equal(decision.status, 'done_unverified');
  assert.match(decision.reason, /not visible/);
});

test('DONE that the screen only half supports is reported, not accepted', async () => {
  // 0.57 was measured on a car dock: Jev chose DONE while the music still played, and the run
  // recorded success. Only a screen that clearly shows the finished goal may count.
  for (const goalVisible of [0.5, 0.57, 0.79]) {
    const decision = await visionPolicy(goalVisible).decide({
      goal: 'Pause the music',
      observation: observe(),
      image: 'AAAA',
    });
    assert.equal(decision.status, 'done_unverified', `goalVisible ${goalVisible}`);
    assert.match(decision.reason, /not visible/);
  }
});

test('a model that answers no noul question keeps the old DONE behaviour', async () => {
  const policy = new TypeSafePolicy({
    request: async ({ body }) =>
      Buffer.from(
        JSON.stringify({
          answers: { operation: answer(body.questions.operation.criteria, 'DONE') },
        }),
      ),
  });
  const decision = await policy.decide({ goal: 'x', observation: observe(), image: 'AAAA' });
  assert.equal(decision.status, 'done');
  assert.equal(decision.goalVisible, undefined);
});

const spread = (criteria, choice, confidence) => {
  const keys = Object.keys(criteria);
  const rest = (1 - confidence) / (keys.length - 1);
  return Object.fromEntries(keys.map((key) => [key, key === choice ? confidence : rest]));
};

const commitPolicy = (commitProbability, confidence = 0.6) =>
  new TypeSafePolicy({
    request: async ({ body }) => {
      if (body.questions.commit) {
        assert.equal(body.questions.commit.type, 'noul');
        assert.match(body.state.next, /^(Tap|Focus text input)/);
        return Buffer.from(
          JSON.stringify({ answers: { commit: { type: 'noul', noul: commitProbability } } }),
        );
      }
      const operationAnswer = answer(body.questions.operation.criteria, 'TAP', confidence);
      const choice = operationAnswer.choice;
      return Buffer.from(
        JSON.stringify({
          answers: {
            operation: {
              ...operationAnswer,
              probabilities: spread(body.questions.operation.criteria, choice, confidence),
            },
            tap_target: answer(body.questions.tap_target.criteria),
            target_point: { type: 'box', box: { left: 0.1, top: 0.1, right: 0.2, bottom: 0.2 } },
            goal_visible: { type: 'noul', noul: 0 },
          },
        }),
      );
    },
  });

test('an unsure step that would commit something is reported instead of executed', async () => {
  const decision = await commitPolicy(0.95).decide({
    goal: 'Buy the ticket',
    observation: observe(),
    image: 'AAAA',
  });
  assert.equal(decision.status, 'uncertain');
  assert.equal(decision.operation, 'TAP');
  assert.equal(decision.commitProbability, 0.95);
  assert.match(decision.reason, /would commit/);
});

test('an unsure step that commits nothing runs', async () => {
  const decision = await commitPolicy(0.02).decide({
    goal: 'Open About phone',
    observation: observe(),
    image: 'AAAA',
  });
  assert.equal(decision.status, 'action');
  assert.equal(decision.commitProbability, 0.02);
  assert.equal(decision.action.type, 'tap-element');
});

test('a confident step is not asked about committing at all', async () => {
  let asked = 0;
  const policy = new TypeSafePolicy({
    request: async ({ body }) => {
      if (body.questions.commit) asked++;
      const choice = 'TAP';
      return Buffer.from(
        JSON.stringify({
          answers: {
            operation: {
              type: 'choice',
              choice,
              confidence: 0.99,
              probabilities: spread(body.questions.operation.criteria, choice, 0.99),
            },
            tap_target: answer(body.questions.tap_target.criteria),
            target_point: { type: 'box', box: { left: 0.1, top: 0.1, right: 0.2, bottom: 0.2 } },
          },
        }),
      );
    },
  });
  const decision = await policy.decide({
    goal: 'Open About phone',
    observation: observe(),
    image: 'AAAA',
  });
  assert.equal(asked, 0);
  assert.equal(decision.status, 'action');
});

test('commitThreshold 0 disables the commit question; the default still asks it', async () => {
  for (const [commitThreshold, expectedAsks, expectedStatus] of [
    [undefined, 1, 'uncertain'],
    [0, 0, 'action'],
  ]) {
    let commitAsks = 0;
    const policy = new TypeSafePolicy({
      ...(commitThreshold === undefined ? {} : { commitThreshold }),
      request: async ({ body }) => {
        if (body.questions.commit) {
          commitAsks++;
          return Buffer.from(JSON.stringify({ answers: { commit: { type: 'noul', noul: 0.95 } } }));
        }
        const choice = 'TAP';
        return Buffer.from(
          JSON.stringify({
            answers: {
              operation: {
                type: 'choice',
                choice,
                confidence: 0.6,
                probabilities: spread(body.questions.operation.criteria, choice, 0.6),
              },
              tap_target: answer(body.questions.tap_target.criteria),
            },
          }),
        );
      },
    });
    const decision = await policy.decide({
      goal: 'Buy the ticket',
      observation: observe(),
      image: 'AAAA',
    });
    assert.equal(commitAsks, expectedAsks);
    assert.equal(decision.status, expectedStatus);
  }
});

test('a point drag carries both ends in screen pixels', async () => {
  const policy = new TypeSafePolicy({
    request: async ({ body }) => {
      assert.ok(body.questions.drag_to);
      assert.ok(body.questions.operation.criteria.DRAG_POINT);
      return Buffer.from(
        JSON.stringify({
          answers: {
            operation: answer(body.questions.operation.criteria, 'DRAG_POINT'),
            target_point: { type: 'box', box: { left: 0.1, top: 0.1, right: 0.2, bottom: 0.2 } },
            drag_to: { type: 'box', box: { left: 0.5, top: 0.5, right: 0.6, bottom: 0.6 } },
          },
        }),
      );
    },
  });
  // The fixture screen is 200x400.
  const decision = await policy.decide({
    goal: 'Move the slider',
    observation: observe(),
    image: 'AAAA',
  });
  assert.equal(decision.operation, 'DRAG_POINT');
  assert.equal(decision.status, 'action');
  assert.deepEqual(decision.drag, { from: { x: 30, y: 60 }, to: { x: 110, y: 220 } });
  assert.deepEqual(decision.action, {
    type: 'drag',
    from: { x: 30, y: 60 },
    to: { x: 110, y: 220 },
  });
});

test('a point drag with a missing end is rejected', async () => {
  const policy = new TypeSafePolicy({
    request: async ({ body }) =>
      Buffer.from(
        JSON.stringify({
          answers: {
            operation: answer(body.questions.operation.criteria, 'DRAG_POINT'),
            target_point: { type: 'box', box: { left: 0.1, top: 0.1, right: 0.2, bottom: 0.2 } },
          },
        }),
      ),
  });
  await assert.rejects(
    policy.decide({ goal: 'Move the slider', observation: observe(), image: 'AAAA' }),
    /invalid box/,
  );
});

test('a slider is listed even though Android does not report it as clickable', async () => {
  const observation = observe();
  observation.elements.push({
    ...node('ui.9', ''),
    className: 'android.widget.SeekBar',
    clickable: false,
    text: '',
    label: 'Display brightness',
    bounds: { left: 0, top: 200, right: 200, bottom: 300 },
  });
  const policy = new TypeSafePolicy({
    request: async ({ body }) => {
      // Not a tap candidate: a click on the track centre would set the middle value.
      assert.equal(
        Object.values(body.questions.tap_target?.criteria || {}).some((text) =>
          text.includes('Display brightness'),
        ),
        false,
      );
      assert.deepEqual(body.state.adjustableControls, [
        { label: 'Display brightness', bounds: { left: 0, top: 0.5, right: 1, bottom: 0.75 } },
      ]);
      assert.match(
        body.questions.operation.criteria.TAP_POINT,
        /tap there sets the value directly/,
      );
      return Buffer.from(
        JSON.stringify({
          answers: {
            operation: answer(body.questions.operation.criteria, 'TAP_POINT'),
            target_point: { type: 'box', box: { left: 0.05, top: 0.55, right: 0.1, bottom: 0.6 } },
          },
        }),
      );
    },
  });
  const decision = await policy.decide({ goal: 'Dim the screen', observation, image: 'AAAA' });
  assert.equal(decision.operation, 'TAP_POINT');
  assert.equal(decision.status, 'action');
});

// Weights become the operation distribution, so the next-best choice of a stall is known exactly.
const distribution = (criteria, weights) => {
  const total = Object.values(weights).reduce((sum, n) => sum + n, 0);
  return Object.fromEntries(Object.keys(criteria).map((key) => [key, (weights[key] ?? 0) / total]));
};

const weightedPolicy = (choice, weights, omit = []) =>
  new TypeSafePolicy({
    request: async ({ body }) => {
      const probabilities = distribution(body.questions.operation.criteria, weights);
      const answers = {
        operation: { type: 'choice', choice, confidence: probabilities[choice], probabilities },
      };
      // Every offered target is answered, so only the recovery itself decides the outcome.
      for (const [name, question] of Object.entries(body.questions))
        if (name.endsWith('_target') && !omit.includes(name))
          answers[name] = answer(question.criteria);
      return Buffer.from(JSON.stringify({ answers }));
    },
  });

test('avoid switches to the next-best operation and reports that option probability', async () => {
  const policy = weightedPolicy('TAP', { TAP: 0.6, SCROLL_DOWN: 0.25, DONE: 0.1, WAIT: 0.05 });
  const decision = await policy.decide({
    goal: 'Find version',
    observation: observe(),
    avoid: new Set(['TAP']),
  });
  assert.equal(decision.operation, 'SCROLL_DOWN');
  assert.equal(decision.status, 'action');
  assert.equal(decision.confidence, decision.operationProbabilities.SCROLL_DOWN);
  assert.equal(decision.recovered, 'switched to SCROLL_DOWN after TAP stopped changing the screen');
});

test('avoid covering every actionable option keeps the operation status and no recovery', async () => {
  const policy = weightedPolicy('TAP', { TAP: 0.6, SCROLL_DOWN: 0.4 });
  const decision = await policy.decide({
    goal: 'Open About phone',
    observation: observe(),
    avoid: new Set(['TAP', 'SCROLL_DOWN']),
  });
  assert.equal(decision.operation, 'TAP');
  assert.equal(decision.status, 'action');
  assert.equal(decision.recovered, undefined);
});

test('a stall never recovers into a stop gate or a wait', async () => {
  const policy = weightedPolicy('TAP', { TAP: 0.5, DONE: 0.3, BLOCKED: 0.1, WAIT: 0.1 });
  const decision = await policy.decide({
    goal: 'Open About phone',
    observation: observe(),
    avoid: new Set(['TAP']),
  });
  assert.equal(decision.operation, 'TAP');
  assert.equal(decision.status, 'action');
  assert.equal(decision.recovered, undefined);
});

test('a recovery skips an operation whose target was never answered', async () => {
  const policy = weightedPolicy('TAP', { TAP: 0.5, LONG_PRESS: 0.5 }, ['gesture_target']);
  const decision = await policy.decide({
    goal: 'Open About phone',
    observation: observe(),
    avoid: new Set(['TAP']),
  });
  // LONG_PRESS is the only other option and its gesture_target answer is missing, so staying with
  // TAP is honest: a recovery must not reach for a target the model never chose.
  assert.equal(decision.operation, 'TAP');
  assert.equal(decision.status, 'action');
  assert.equal(decision.recovered, undefined);
});

// A screen that never changes: every tap lands near the last one, so only the stall guards can act.
const frozenDevice = () => {
  let acts = 0;
  const device = {
    assertReady: async () => {},
    observe: async () => observe(),
    act: async () => {
      acts++;
    },
  };
  return { device, acts: () => acts };
};

test('a tap that never changes the screen recovers three times, then reports the stall', async () => {
  const { device, acts } = frozenDevice();
  const operations = ['TAP', 'SCROLL_DOWN', 'ENTER', 'TYPE_TEXT'];
  const policy = {
    decide: async ({ history, avoid }) => ({
      status: 'action',
      operation: operations.find((operation) => !avoid.has(operation)),
      action: { type: 'tap', x: 100 + history.length * 2, y: 100 },
    }),
  };
  const result = await runAgent({
    device,
    policy,
    goal: 'Reach the setting',
    execute: true,
    settleTimeoutMs: 0,
  });
  // Three misses per stall, three recoveries, then the fourth stall stops the run.
  assert.equal(result.status, 'stuck');
  assert.equal(acts(), 12);
  assert.equal(result.steps, 12);
  assert.match(result.decision.reason, /^3 taps around \(122, 100\) changed nothing on screen\.$/);
});

test('a tapped control is compared by its own drawing and its own goal reading', async () => {
  let body;
  const policy = new TypeSafePolicy({
    request: async (request) => {
      body = request.body;
      return Buffer.from(
        JSON.stringify({
          model: 'jev-test',
          answers: {
            change: answer(
              {
                same: '',
                changed: '',
                unreadable: '',
              },
              'changed',
              0.97,
            ),
            satisfied: { type: 'noul', noul: 0.92 },
          },
        }),
      );
    },
  });
  const read = await policy.readsControlChange({
    goal: '暂停音乐',
    before: 'before-png',
    after: 'after-png',
  });
  assert.deepEqual(read, {
    change: 'changed',
    confidence: 0.97,
    satisfied: 0.92,
    usage: undefined,
  });
  // Both crops travel with the question, and the goal is in the state so the second question can use it.
  assert.equal(body.assets.before.data_base64, 'before-png');
  assert.equal(body.assets.after.data_base64, 'after-png');
  assert.equal(body.state.goal, '暂停音乐');
  assert.equal(body.questions.change.type, 'choice');
  assert.equal(body.questions.satisfied.type, 'noul');
  // A missing reading is not a "no change": the caller must not treat it as evidence either way.
  const silent = new TypeSafePolicy({ request: async () => Buffer.from('{"answers":{}}') });
  await assert.rejects(
    silent.readsControlChange({ goal: 'x', before: 'a', after: 'b' }),
    /invalid choice distribution/,
  );
});

test('a point in the corner of a large card is tapped where it was marked', async () => {
  const policy = new TypeSafePolicy({
    request: async ({ body }) =>
      Buffer.from(
        JSON.stringify({
          answers: {
            operation: answer(body.questions.operation.criteria, 'TAP_POINT'),
            target_point: { type: 'box', box: { left: 0.86, top: 0.34, right: 0.9, bottom: 0.36 } },
          },
        }),
      ),
  });
  const observation = observe();
  // A 476x234 card whose title is drawn in the middle; its add badge sits in the top-right corner.
  observation.elements = [
    {
      ...node('ui.0', '露营模式', { bounds: { left: 100, top: 300, right: 576, bottom: 534 } }),
      nameBox: { left: 180, top: 420, right: 320, bottom: 470 },
      clickable: true,
    },
  ];
  const decision = await policy.decide({
    goal: 'Add the camping widget',
    observation,
    image: 'AAAA',
  });
  // 0.88 of the screen width lands in the card's corner, outside the name it is drawn for.
  assert.equal(decision.snapped, false);
  assert.equal(decision.action.type, 'tap');
});

test('a positional label loses to the box the model marked', async () => {
  // Two unnamed icons and one named row: the choice answer can only say "1 of 2 in ViewGroup", which is
  // the keyboard toolbar's logo. The box answer marks the row the model actually means.
  const row = node('ui.9', '重庆市 1470公里', {
    bounds: { left: 0, top: 300, right: 200, bottom: 360 },
  });
  const observation = {
    ...observe(),
    screen: { width: 200, height: 400 },
    elements: [
      node('ui.0', '1 of 2 in ViewGroup', {
        bounds: { left: 0, top: 0, right: 100, bottom: 40 },
      }),
      node('ui.1', '2 of 2 in ViewGroup', {
        bounds: { left: 100, top: 0, right: 200, bottom: 40 },
      }),
      row,
    ],
  };
  const policy = new TypeSafePolicy({
    request: async ({ body }) => {
      // The box question only exists when a screenshot does.
      if (!body.questions.target_point) {
        return Buffer.from(
          JSON.stringify({
            answers: { operation: answer(body.questions.operation.criteria, 'TAP') },
          }),
        );
      }
      return Buffer.from(
        JSON.stringify({
          answers: {
            operation: answer(body.questions.operation.criteria, 'TAP'),
            tap_target: answer(body.questions.tap_target.criteria, '1', 0.96),
            target_point: { type: 'box', box: { left: 0.1, top: 0.78, right: 0.6, bottom: 0.88 } },
          },
        }),
      );
    },
  });
  const decision = await policy.decide({
    goal: 'Go to 重庆市',
    observation,
    image: 'AAAA',
  });
  assert.equal(decision.action.elementId, 'ui.9');
  assert.equal(decision.boxFallback.reason, 'label `1 of 2 in ViewGroup` says where, not what');
  assert.equal(decision.boxFallback.chose, '重庆市 1470公里');
});

test('a low-confidence named pick also follows the box', async () => {
  const observation = observe();
  const policy = new TypeSafePolicy({
    request: async ({ body }) =>
      Buffer.from(
        JSON.stringify({
          answers: {
            operation: answer(body.questions.operation.criteria, 'TAP'),
            tap_target: answer(body.questions.tap_target.criteria, '2', 0.5),
            target_point: { type: 'box', box: { left: 0.05, top: 0.05, right: 0.4, bottom: 0.2 } },
          },
        }),
      ),
  });
  const decision = await policy.decide({
    goal: 'Open the search field',
    observation,
    image: 'AAAA',
  });
  // The box lands on the search field (ui.0), not on the row the unsure choice named (ui.1).
  assert.equal(decision.action.elementId, 'ui.0');
  assert.equal(decision.boxFallback.reason, 'choice was unsure');
});
