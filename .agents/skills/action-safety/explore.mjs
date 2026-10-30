#!/usr/bin/env node
/**
 * Bounded exploration of the run loop's action safety, over the real `runAgent`.
 *
 * A test writes down the cases someone thought of. This walks *every* order of the device's answers in
 * a stated scope: for each step of a short run, the phone may apply the mutation, ignore it, refuse it
 * before input, redraw on its own before the freshness gate, accept the input and then drop the
 * connection, hand back a system-chrome-only read, or fail the read after the input landed. Every
 * sequence of those up to four acts is run, for a tap first and for a hold first, against
 * `scripts/mobile-agent/agent.mjs` itself, with a model that repeats itself and one that changes its
 * mind every step. Four promises the loop makes are checked on each trace:
 *
 *   NoStaleDispatch          input is sent only while the screen still is the one the decision saw.
 *   NoSameActionTwice        the same action is never sent twice while no read showed a change; the
 *                            only second send is the documented longer hold, which is a different
 *                            action because its duration differs.
 *   NoInputAfterUncertain    input whose outcome is unknown ends the run; it is never sent again.
 *   RespectsStepLimit        a run dispatches mutations in at most maxSteps steps.
 *
 * The device double implements only the contract `AdbDevice` offers the loop: `observe()` reads the
 * screen, `act()` checks freshness with the real `assertFresh` and then sends exactly one mutation.
 * `run.sh` checks that contract against the code, so a change to it is reported rather than silently
 * verified against an out-of-date double.
 *
 *   node explore.mjs                                    # explore the real loop
 *   node explore.mjs --schedule stale,noop              # replay one schedule, with the trace in words
 *   node explore.mjs --policy again --action long-press # replay it for the other model, or action
 *   node explore.mjs --mutants                          # each property must be caught on its variant
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const source = join(root, 'scripts/mobile-agent');
const work = join(root, 'tmp/action-safety');
const DEVICE = 'emulator-explored';

/** What the phone answers to one `act()`, in the order the acts happen. */
const KINDS = [
  'applied', // the input lands and the screen changes
  'noop', // the input lands and the screen does not change
  'twitch', // the input lands, and something else on the screen redraws on its own
  'stale', // another window redraws before the freshness gate, so the decision is refused
  'refused', // the gate passes but the target is gone, so nothing is sent
  'uncertain', // the input lands and the connection drops before the answer arrives
  'unknown-read', // the input lands and the next read comes back as system chrome only
  'read-fails', // the input lands and every read after it fails
];
const ACTIONS = ['tap-element', 'long-press'];
const OTHER = { 'tap-element': 'long-press', 'long-press': 'tap-element' };
// The model repeats itself, or it changes its mind between steps. The second is the one that can send a
// new action after a mutation whose outcome the loop never learned.
const POLICIES = ['again', 'changes-its-mind'];
const DEPTH = 4;
const MAX_STEPS = 2;

const plain = {
  applied: 'the input landed and the screen changed',
  noop: 'the input landed and the screen did not change',
  twitch: 'the input landed, and a card elsewhere on the screen redrew on its own',
  stale: 'another window redrew first, so the decision was stale before input',
  refused: 'the target was gone, so nothing was sent',
  uncertain: 'the input landed and the connection dropped before the answer arrived',
  'unknown-read': 'the input landed and the next read came back as system chrome only',
  'read-fails': 'the input landed and every read after it failed',
};

// The phone this replaces, as `summarizeState` reads it. A revision is the state of the control the
// actions target; `tips` is everything else, which on a real launcher rotates on its own. A chrome read
// is the system's own window, which says nothing about what the app just did.
function rawState(revision, chrome, tips = 0) {
  const app = 'com.example.notes';
  const row = {
    className: 'android.widget.TextView',
    resourceId: `${app}:id/row`,
    boundsInScreen: { left: 20, top: 300, right: 700, bottom: 420 },
    isVisibleToUser: true,
    isEnabled: true,
    isClickable: true,
  };
  return {
    device_context: { screen_bounds: { width: 720, height: 1600 } },
    phone_state: {
      packageName: chrome ? 'com.android.systemui' : app,
      currentApp: chrome ? 'com.android.systemui/.dock' : `${app}/.MainActivity`,
      isEditable: false,
    },
    a11y_tree: {
      className: 'android.widget.FrameLayout',
      boundsInScreen: { left: 0, top: 0, right: 720, bottom: 1600 },
      isVisibleToUser: true,
      children: [
        chrome
          ? {
              ...row,
              text: '7:42',
              resourceId: 'com.android.systemui:id/clock',
              isClickable: false,
            }
          : { ...row, text: `Note ${revision}` },
        ...(tips
          ? [
              {
                ...row,
                text: `Try saying: navigate home ${tips}`,
                resourceId: `${app}:id/tips`,
                isClickable: false,
                boundsInScreen: { left: 20, top: 1400, right: 700, bottom: 1500 },
              },
            ]
          : []),
      ],
    },
  };
}

function loadApi(dir) {
  return Promise.all([
    import(pathToFileURL(join(dir, 'agent.mjs')).href),
    import(pathToFileURL(join(dir, 'device.mjs')).href),
  ]).then(([agent, device]) => ({
    runAgent: agent.runAgent,
    assertFresh: device.assertFresh,
    summarizeState: device.summarizeState,
    // The loop tells an unknown mutation from a refusal by this type, so the double has to throw it.
    MutationUncertainError: device.MutationUncertainError,
  }));
}

/** The device double: reads are real observations, and `act` is the one place input leaves the loop. */
function phone(api, schedule, actionType) {
  const state = { revision: 0, tips: 0, chrome: false, readFaults: 0, acts: 0 };
  const trace = [];
  const read = (why) => {
    if (state.readFaults > 0) {
      state.readFaults--;
      throw new Error('ADB read failed: uiautomator dump returned no XML.');
    }
    const observation = api.summarizeState(
      rawState(state.revision, state.chrome, state.tips),
      DEVICE,
    );
    state.chrome = false;
    trace.push({ at: 'read', why, revision: state.revision, fingerprint: observation.fingerprint });
    return observation;
  };
  const device = {
    deviceId: DEVICE,
    readyAt: performance.now(),
    installedApps: [],
    async assertReady() {
      device.readyAt = performance.now();
      return { id: DEVICE, state: 'ready' };
    },
    async observe() {
      return read('loop');
    },
    async act(action, { expected } = {}) {
      const attempt = state.acts++;
      const kind = schedule[attempt] ?? 'applied';
      // A stale rejection is a screen that moved under the decision, read by the real gate.
      if (kind === 'stale') state.revision++;
      const current = read('gate');
      // The real `act` checks freshness only when the caller passes the observation it decided on.
      try {
        if (expected) api.assertFresh(current, expected, action);
      } catch (error) {
        trace.push({ at: 'gate', attempt, kind, action });
        throw error;
      }
      if (kind === 'refused') {
        trace.push({ at: 'refused', attempt, kind, action });
        throw new Error('Element is not actionable.');
      }
      const event = {
        at: 'dispatch',
        attempt,
        kind,
        action,
        decidedOn: expected?.fingerprint,
        revisionAtDispatch: state.revision,
      };
      trace.push(event);
      if (kind === 'uncertain') {
        state.revision++;
        throw new api.MutationUncertainError(
          'ADB mutation outcome is uncertain; the action was not retried.',
        );
      }
      if (kind === 'read-fails') {
        state.revision++;
        state.readFaults = 3;
      } else if (kind === 'noop') {
        // The phone took the input and drew nothing: a press that was too short, or a control already
        // in the state the press asks for.
      } else if (kind === 'unknown-read') {
        state.revision++;
        state.chrome = true;
      } else if (kind === 'twitch') {
        // A card elsewhere redraws: the screen moved, the control the action names did not.
        state.tips++;
      } else {
        state.revision++;
      }
      return undefined;
    },
  };
  const action = (step, policy) => {
    const type = policy === 'changes-its-mind' && step % 2 === 1 ? OTHER[actionType] : actionType;
    return type === 'long-press'
      ? { type: 'long-press', elementId: 'ui.0' }
      : { type: 'tap-element', elementId: 'ui.0' };
  };
  return { device, trace, action };
}

/** Run one schedule, and check the four promises on the trace it produced. */
async function explore(api, { actionType, policy, schedule, maxSteps = MAX_STEPS }) {
  const { device, trace, action } = phone(api, schedule, actionType);
  const decide = {
    async decide({ observation, history }) {
      const chosen = action(history.length, policy);
      return {
        status: 'action',
        operation: chosen.type === 'long-press' ? 'LONG_PRESS' : 'TAP',
        action: chosen,
        label: `${chosen.type === 'long-press' ? 'Press and hold' : 'Tap'} Note (${observation.phone.packageName})`,
      };
    },
  };
  let result;
  let failure;
  try {
    result = await api.runAgent({
      device,
      policy: decide,
      goal: 'Open the first note',
      execute: true,
      maxSteps,
      settleMs: 0,
      settleTimeoutMs: 0,
      onStep: (entry) => trace.push({ at: 'decide', step: entry.step }),
      onAction: (entry) =>
        trace.push({ at: 'action', label: entry.label, operation: entry.operation }),
      onObservation: (entry) =>
        trace.push({ at: 'after', step: entry.step, screenChanged: entry.screenChanged }),
    });
  } catch (error) {
    failure = error;
  }
  const dispatches = trace.filter((event) => event.at === 'dispatch');
  const violations = [];
  const add = (property, at, words) => violations.push({ property, at, words });
  // The step each event happened in. The longer hold belongs to the step that asked for the press.
  let step = -1;
  for (const event of trace) {
    if (event.at === 'decide') step = event.step;
    event.step = step;
  }

  // NoStaleDispatch: the decision's screen is still the screen when the input leaves.
  for (const event of dispatches) {
    const decidedOn = trace
      .filter((entry) => entry.at === 'read' && entry.why === 'loop')
      .reverse()
      .find((entry) => entry.fingerprint === event.decidedOn);
    if (decidedOn && decidedOn.revision !== event.revisionAtDispatch)
      add(
        'NoStaleDispatch',
        event.attempt,
        `step ${event.step + 1} sent input for a decision made on screen ${decidedOn.revision}, ` +
          `but the phone was already on screen ${event.revisionAtDispatch}.`,
      );
  }

  // NoSameActionTwice: an identical action is only sent again when a read showed the screen move.
  for (let index = 1; index < dispatches.length; index++) {
    const previous = dispatches[index - 1];
    const current = dispatches[index];
    if (JSON.stringify(previous.action) !== JSON.stringify(current.action)) continue;
    if (previous.revisionAtDispatch === current.revisionAtDispatch)
      add(
        'NoSameActionTwice',
        current.attempt,
        `the same ${current.action.type} was sent twice while the phone stayed on screen ` +
          `${current.revisionAtDispatch}, so a toggle would be undone.`,
      );
  }

  // NoInputAfterUncertain: an unknown outcome ends the run. Nothing is sent again, and nothing is
  // reported as done.
  const uncertain = dispatches.findIndex((event) => event.kind === 'uncertain');
  if (uncertain >= 0) {
    const later = dispatches.slice(uncertain + 1);
    if (later.length)
      add(
        'NoInputAfterUncertain',
        later[0].attempt,
        `input whose outcome was unknown (step ${dispatches[uncertain].step + 1}) was followed ` +
          `by ${later.length} more mutation(s).`,
      );
    if (result?.status === 'done')
      add(
        'NoInputAfterUncertain',
        uncertain,
        'the run reported done after a mutation whose outcome it never learned.',
      );
  }

  // RespectsStepLimit: a mutation runs on at most maxSteps steps.
  const mutating = new Set(dispatches.map((event) => event.step));
  if (mutating.size > maxSteps)
    add(
      'RespectsStepLimit',
      maxSteps,
      `${mutating.size} steps dispatched a mutation while maxSteps was ${maxSteps}.`,
    );

  return { schedule, actionType, policy, trace, dispatches, result, failure, violations };
}

/** The fault kinds of one schedule, padded with `applied` so a schedule can be shorter than the run. */
const schedules = (depth) => {
  if (depth === 0) return [[]];
  const shorter = schedules(depth - 1);
  return KINDS.flatMap((kind) => shorter.map((rest) => [kind, ...rest]));
};

async function exploreAll(api) {
  const outcomes = [];
  for (const actionType of ACTIONS)
    for (const policy of POLICIES)
      for (const schedule of schedules(DEPTH))
        outcomes.push(await explore(api, { actionType, policy, schedule }));
  return outcomes;
}

const PROPERTIES = [
  'NoStaleDispatch',
  'NoSameActionTwice',
  'NoInputAfterUncertain',
  'RespectsStepLimit',
];

function report(outcomes) {
  let failed = 0;
  for (const property of PROPERTIES) {
    const broken = outcomes.filter((outcome) =>
      outcome.violations.some((violation) => violation.property === property),
    );
    if (!broken.length) {
      console.log(`  ok    ${property}`);
      continue;
    }
    failed++;
    const first = broken[0];
    const violation = first.violations.find((entry) => entry.property === property);
    console.log(`  GONE  ${property}   ${broken.length} of ${outcomes.length} schedules`);
    console.log(`        ${violation.words}`);
    console.log(
      `        to see it: --action ${first.actionType} --policy ${first.policy} ` +
        `--schedule ${first.schedule.join(',')}`,
    );
  }
  return failed;
}

// A counterexample in the code's words: what the loop decided, what the phone answered, and what the
// loop did next.
function narrate(outcome) {
  console.log(
    `\n${outcome.actionType} first, model ${outcome.policy === 'again' ? 'asks for the same thing every step' : 'changes its mind every step'}, ` +
      `phone answers: ${outcome.schedule.join(', ') || 'applied'}`,
  );
  for (const event of outcome.trace) {
    if (event.at === 'read') continue;
    if (event.at === 'decide') console.log(`  step ${event.step + 1}: the model decides`);
    if (event.at === 'dispatch')
      console.log(
        `    attempt ${event.attempt + 1}: sent ${event.action.type}` +
          `${event.action.duration ? ` held ${event.action.duration}ms` : ''} on screen ${event.revisionAtDispatch}` +
          ` - ${plain[event.kind]}`,
      );
    if (event.at === 'refused')
      console.log(
        `    attempt ${event.attempt + 1}: nothing sent - the gate passed, the target was gone`,
      );
    if (event.at === 'gate')
      console.log(
        `    attempt ${event.attempt + 1}: nothing sent - the gate refused it, the screen moved under the decision`,
      );
    if (event.at === 'action') console.log(`    the loop says: ${event.label}`);
    if (event.at === 'after')
      console.log(`    read after the step: screenChanged=${event.screenChanged}`);
  }
  console.log(
    outcome.failure
      ? `  the run ended by throwing: ${outcome.failure.message}`
      : `  the run ended as ${outcome.result.status}: ${outcome.result.decision?.reason ?? ''}`,
  );
  for (const violation of outcome.violations)
    console.log(`  ${violation.property}: ${violation.words}`);
}

/**
 * The broken variants. Each one removes a mechanism the properties are meant to guard, so a check that
 * never fails on it proves nothing. The patch is applied to a copy of `scripts/mobile-agent/` under
 * `tmp/`, never to the working tree.
 */
const MUTANTS = [
  {
    name: 'replay-uncertain',
    file: 'agent.mjs',
    find: 'if (!(error instanceof StaleObservationError)) throw error; // Never retry uncertain mutations.',
    replace: 'if (false) throw error;',
    property: 'NoInputAfterUncertain',
    about: 'treats an unknown mutation outcome as a stale decision and carries on',
  },
  {
    name: 'repeat-the-same-action',
    file: 'agent.mjs',
    find: 'if (!isWait && repeated.has(signature)) {',
    replace: 'if (false) {',
    property: 'NoSameActionTwice',
    about: 'drops the guard that stops the same action being sent twice on an unchanged screen',
  },
  {
    name: 'no-freshness-gate',
    file: 'device.mjs',
    find: 'export function assertFresh(current, expected, action, maxAgeMs = 30_000) {',
    replace:
      'export function assertFresh(current, expected, action, maxAgeMs = 30_000) {\n  return; // mutant',
    property: 'NoStaleDispatch',
    about: 'removes the freshness check that every dispatch runs behind',
  },
  {
    name: 'no-step-limit',
    file: 'agent.mjs',
    find: "if (step >= maxSteps) return finish('step_limit', decision);",
    replace: "if (false) return finish('step_limit', decision);",
    property: 'RespectsStepLimit',
    about: 'removes the step budget that stops a run from mutating past its limit',
  },
];

function buildMutant(mutant) {
  const dir = join(work, 'mutants', mutant.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // The loop imports its siblings by relative path, so the whole directory travels, tests and the
  // vendored binaries left behind.
  for (const file of readdirSync(source))
    if (file.endsWith('.mjs') && !file.endsWith('.test.mjs'))
      cpSync(join(source, file), join(dir, file));
  const target = join(dir, mutant.file);
  const text = readFileSync(target, 'utf8');
  // A patch that no longer matches is news in itself: the code may already have moved this way.
  if (!text.includes(mutant.find))
    throw new Error(
      `the patch no longer matches ${mutant.file}; the code may already read that way`,
    );
  writeFileSync(target, text.replace(mutant.find, mutant.replace));
  return dir;
}

const scheduleKey = (outcome) =>
  `${outcome.actionType}|${outcome.policy}|${outcome.schedule.join(',')}`;
const breaks = (outcome, property) =>
  outcome.violations.some((violation) => violation.property === property);

async function checkMutants() {
  // A variant is only caught where the code is clean: the same schedule, without the patch, must pass.
  // Otherwise a property that is already red on the real loop would "catch" nothing.
  const clean = new Map(
    (await exploreAll(await loadApi(source))).map((outcome) => [scheduleKey(outcome), outcome]),
  );
  let failed = 0;
  for (const mutant of MUTANTS) {
    let outcomes;
    try {
      outcomes = await exploreAll(await loadApi(buildMutant(mutant)));
    } catch (error) {
      console.log(`  stale ${mutant.name.padEnd(24)} ${error.message}`);
      failed++;
      continue;
    }
    const caught = outcomes.filter(
      (outcome) =>
        breaks(outcome, mutant.property) &&
        !breaks(clean.get(scheduleKey(outcome)), mutant.property),
    );
    console.log(
      `  ${caught.length ? 'caught' : 'MISSED'} ${mutant.name.padEnd(24)} ${mutant.about}`,
    );
    if (!caught.length) {
      console.log(
        `         ${mutant.property} still passed on a variant that removes its mechanism.`,
      );
      failed++;
    } else {
      const first = caught[0];
      console.log(
        `         on ${caught.length} schedules the code passes: --action ${first.actionType} ` +
          `--policy ${first.policy} --schedule ${first.schedule.join(',')}`,
      );
    }
  }
  return failed;
}

const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

if (argv.includes('--mutants')) {
  process.exitCode = (await checkMutants()) ? 1 : 0;
} else if (option('--schedule')) {
  const schedule = option('--schedule').split(',').filter(Boolean);
  const actionType = option('--action') ?? 'tap-element';
  const policy = option('--policy') ?? 'changes-its-mind';
  if (!POLICIES.includes(policy)) throw new Error(`--policy is one of ${POLICIES.join(', ')}.`);
  const mutant = option('--mutant');
  const definition = MUTANTS.find((entry) => entry.name === mutant);
  if (mutant && !definition) throw new Error(`No mutant named ${mutant}.`);
  const api = await loadApi(definition ? buildMutant(definition) : source);
  narrate(await explore(api, { actionType, policy, schedule }));
} else {
  const outcomes = await exploreAll(await loadApi(source));
  console.log(
    `== ${outcomes.length} schedules: ${KINDS.length} phone answers up to ${DEPTH} acts, ` +
      `tap and long press, model repeating itself and changing its mind, maxSteps ${MAX_STEPS} ==`,
  );

  process.exitCode = report(outcomes) ? 1 : 0;
}
