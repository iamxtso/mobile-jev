import { setTimeout as delay } from 'node:timers/promises';
import { StaleObservationError } from './device.mjs';
import { describeAction } from './actions.mjs';

// A read that carries only the system's own window: the dock, the status bar, the launcher. The app the
// goal lives in is missing, so nothing on that tree can confirm or deny what the app just did.
const CHROME_PACKAGES = /^(com\.android\.systemui|com\.sgmw\.launcher)$/i;
const isChromeRead = (observation) => CHROME_PACKAGES.test(observation?.phone?.packageName || '');
import { rememberedEntry, rememberEntry } from './network-memo.mjs';
import { confirmInput } from './input-verification.mjs';
import { changedFraction, cropControl, decodePng } from './pixels.mjs';
export { candidatesFor } from './actions.mjs';

// Two taps a few pixels apart are one retry; a third tap around the same point, with nothing changing
// on screen, is a stall. Exact action equality misses this: 24 px was enough to look like progress.
const NEARBY_TAP_PX = 48;
const MAX_NEARBY_MISSES = 3;
// The same operation that changes nothing, repeated, is a loop. The exact-repeat guard misses it
// whenever the screen twitches on its own (a clock, a battery icon), so it is counted separately.
const MAX_STALLED_REPEAT = 3;
// Wi-Fi takes a few seconds to associate after it is switched on, and repeating the switch undoes it.
const MAX_NETWORK_WAITS = 3;
const NETWORK_POLLS = 5;
// The model has to be this sure a screen really is the network page before the walk stops there.
const MIN_NETWORK_SCREEN = 0.8;
// A stall is usually a wrong operation, not a dead end: try the next-best one a few times first.
const MAX_RECOVERIES = 3;
// Jev judged the recent actions are going nowhere. The first steps legitimately show no progress,
// so the watcher stays quiet until the run has a few actions to judge.
const MIN_STUCK_PROBABILITY = 0.85;
const MIN_STUCK_STEP = 2;
// A control's state can live in pixels alone: a dock icon swaps between two glyphs without changing
// its id, bounds, text or checked state, so the accessibility fingerprint cannot see the tap work.
// Only a small tapped control is compared, because a moving progress bar or a clock changes more of
// a screenshot every second than a pressed button does. Measured on a car dock: the pause tile went
// 4.9 % when pressed, the whole dock 0.26 %, and a playing player page 1.45 % on its own.
const MAX_PIXEL_CHECK_PX = 90_000;
const MIN_PIXEL_CHANGE = 0.02;
// Pixels say an area was redrawn, not what changed in it. Asking about the control's own drawing is a
// judgment, so it needs a confident answer to stand as evidence. Measured on a car dock's play/pause
// tile: the before/after pair read "changed" at 99-100 % and the goal as met at 100 % when it was,
// 8 % when it was not.
const MIN_GLYPH_CONFIDENCE = 0.9;
// A long press is 600 ms, which opens a context menu and does not release a touch-locked screen: this
// car's screen-cleaning mode waits three seconds and says so on the display. The second press on the
// same control holds longer, because the policy cannot observe a duration to ask for.
const HOLD_ESCALATION_MS = 3000;
function longerHold(action) {
  if (action?.type !== 'long-press' || action.duration) return undefined;
  return { ...action, duration: HOLD_ESCALATION_MS };
}
// Base64 keeps the leading magic bytes, so the agent can tell the helper's JPEG from a PNG.
const PNG_BASE64 = 'iVBORw0KGgo';
// Repeating one of these three times in a row is always a loop: they have no incremental progress to
// make. Scrolling and typing are excluded, where the same action legitimately repeats.
const REPEAT_IS_A_LOOP = new Set([
  'EXPAND_NOTIFICATIONS',
  'EXPAND_QUICK_SETTINGS',
  'COLLAPSE_NOTIFICATIONS',
  'OPEN_APP',
  'HOME',
  'BACK',
]);

/** Where a tap would land, from the observation it was decided on. */
function tapPoint(action, observation) {
  if (action?.type === 'tap') return { x: action.x, y: action.y };
  if (action?.type !== 'tap-element') return null;
  const node = observation.elements.find((element) => element.id === action.elementId);
  return node
    ? {
        x: (node.bounds.left + node.bounds.right) / 2,
        y: (node.bounds.top + node.bounds.bottom) / 2,
      }
    : null;
}

/** The bounds of the control a tap lands on, or null when it lands on nothing observed. */
function tapTarget(action, observation) {
  if (action?.type === 'tap-element') {
    const node = observation.elements.find((element) => element.id === action.elementId);
    return node
      ? { elementId: node.id, bounds: node.bounds, className: node.className }
      : { elementId: action.elementId };
  }
  if (action?.type !== 'tap') return null;
  const { x, y } = action;
  const node = observation.elements.find(
    ({ bounds }) => bounds.left <= x && x < bounds.right && bounds.top <= y && y < bounds.bottom,
  );
  return { elementId: node?.id, bounds: node?.bounds, className: node?.className };
}

/** Everything about one element that a tap could change without moving it. */
function elementState(element) {
  return element
    ? JSON.stringify([
        element.text,
        element.label,
        element.nested,
        element.checked,
        element.selected,
        element.bounds,
      ])
    : 'absent';
}

/**
 * Did this tap do anything? A home screen is never still: the launcher rotates its voice tips every
 * 7-9 s and the clock turns every minute, which makes a whole-screen comparison call every tap a
 * success. A tap is judged by the control it hit instead: that control's own state, the screen it
 * belongs to, the pixels inside it, and whether the tap opened something new. Elements are matched by
 * where they are drawn, not by their path id: an id is positional, so one node appearing above the
 * control renames everything below it and would read as a change.
 */
// Controls that name the network: switching Wi-Fi on or picking an access point starts a join the
// system finishes seconds later.
const NETWORK_CONTROL = /wi-?fi|无线|wlan|access point|网络/i;

/** How a control is named in the tree, for deciding what a tap was about to change. */
const controlLabel = (elementId, observation) => {
  const element = observation.elements.find((e) => e.id === elementId);
  return [element?.label, element?.text, element?.resourceId].filter(Boolean).join(' ');
};

const boxKey = (element) =>
  `${element.className}|${element.bounds.left},${element.bounds.top},${element.bounds.right},${element.bounds.bottom}`;
const boundsKey = (bounds) => `${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}`;

function tapChanged(before, after, target) {
  const answer = { control: false, elsewhere: false };
  if (before.phone.packageName !== after.phone.packageName)
    return { control: false, elsewhere: true };
  if ((before.phone.currentApp || '') !== (after.phone.currentApp || ''))
    return { control: false, elsewhere: true };
  const was = new Map(before.elements.map((element) => [element.id, element]));
  const wasDrawn = new Map(before.elements.map((element) => [boxKey(element), element]));
  const drawnCount = new Map();
  for (const element of before.elements)
    drawnCount.set(boxKey(element), (drawnCount.get(boxKey(element)) ?? 0) + 1);
  // Where a control is drawn identifies it; its path id does not. The accessibility tree can list the
  // same windows in a different order between two reads, which swaps every id under them.
  const control =
    (target.bounds &&
      before.elements.find((element) => boundsKey(element.bounds) === boundsKey(target.bounds))) ??
    was.get(target.elementId);
  const stillThere =
    control &&
    after.elements.find(
      (element) =>
        boundsKey(element.bounds) === boundsKey(control.bounds) &&
        element.className === control.className,
    );
  if (elementState(control) !== elementState(stillThere)) answer.control = true;
  // Something new appeared that can be touched and whose content a person could read: a dialog, a
  // menu, a keyboard. A ripple or an overlay carries nothing to read, and a tap that only paints one
  // has not answered.
  for (const element of after.elements)
    if (
      (element.clickable || element.editable) &&
      (element.text || element.label || element.nested) &&
      !wasDrawn.has(boxKey(element))
    )
      answer.elsewhere = true;
  // A change inside the control itself, such as a row's value text.
  if (target.bounds) {
    const outer = target.bounds;
    const previousOf = (element) => {
      const key = boxKey(element);
      // A box that identifies one element is the reliable match; a shared one falls back to the id
      // that still points at the same place.
      if (drawnCount.get(key) === 1) return wasDrawn.get(key);
      const byId = was.get(element.id);
      return byId && boundsKey(byId.bounds) === boundsKey(element.bounds)
        ? byId
        : wasDrawn.get(key);
    };
    for (const element of after.elements) {
      const box = element.bounds;
      if (box.left < outer.left || box.right > outer.right) continue;
      if (box.top < outer.top || box.bottom > outer.bottom) continue;
      if (elementState(previousOf(element)) !== elementState(element)) answer.control = true;
    }
  }
  return answer;
}
/** The share of the tapped control's pixels that differ, or null when the images cannot say. */
async function changedUnder(before, after, bounds) {
  if (!before || !after || !bounds) return null;
  try {
    return changedFraction(
      decodePng(Buffer.from(before, 'base64')),
      decodePng(Buffer.from(after, 'base64')),
      bounds,
    );
  } catch {
    // A format this decoder does not read is not evidence that nothing happened.
    return null;
  }
}
export { TypeSafePolicy } from './policy.mjs';

// A policy selects one operation and (where needed) its target in one model request.
export async function runAgent({
  device,
  policy,
  goal,
  texts = [],
  execute = false,
  maxSteps = 20,
  settleMs = 0,
  settleTimeoutMs = 400,
  waitTimeoutMs = 15_000,
  inputTimeoutMs = 2500,
  onStep = () => {},
  onAction = () => {},
  onObservation = () => {},
}) {
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 100)
    throw new Error('maxSteps must be 1–100.');
  for (const [key, value] of Object.entries({ settleMs, settleTimeoutMs, inputTimeoutMs })) {
    if (!Number.isFinite(value) || value < 0 || value > 10_000)
      throw new Error(`${key} must be 0–10000.`);
  }
  if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 0 || waitTimeoutMs > 60_000)
    throw new Error('waitTimeoutMs must be 0–60000.');
  const started = performance.now();
  const timings = {
    modelMs: 0,
    actionMs: 0,
    observationMs: 0,
    snapshotMs: 0,
    waitMs: 0,
    staleRetries: 0,
    modelCalls: 0,
  };
  const history = [],
    repeated = new Set();
  const observe = async () => {
    const start = performance.now();
    try {
      return await device.observe();
    } finally {
      timings.observationMs += performance.now() - start;
    }
  };
  // A screenshot lets the policy point at controls the accessibility tree does not expose. Devices
  // without one (and test doubles) keep the text-only request.
  const snapshot = async () => {
    if (typeof device.screenshot !== 'function') return undefined;
    // The accessibility helper returns its image with the tree it read, from the same instant.
    if (typeof device.snapshotImage === 'string' && device.snapshotImage)
      return device.snapshotImage;
    const start = performance.now();
    try {
      return (await device.screenshot()).toString('base64');
    } finally {
      timings.snapshotMs += performance.now() - start;
    }
  };
  const wait = async (ms) => {
    const start = performance.now();
    await delay(ms);
    timings.waitMs += performance.now() - start;
  };
  // The helper sends its screenshot as JPEG, which loses the pixels a glyph swap lives in, so the
  // comparison asks for the lossless PNG that `screencap -p` writes whenever the image at hand is
  // not already one. Both images come from the same source, so the two are comparable.
  const capturePng = async () => {
    const image = await snapshot();
    if (image?.startsWith(PNG_BASE64)) return image;
    if (typeof device.screenshot !== 'function') return undefined;
    const start = performance.now();
    try {
      return (await device.screenshot()).toString('base64');
    } finally {
      timings.snapshotMs += performance.now() - start;
    }
  };
  await device.assertReady();
  const [initialObservation, installedApps] = await Promise.all([
    observe(),
    typeof device.listApps === 'function' ? device.listApps() : Promise.resolve([]),
  ]);
  let observation = initialObservation;
  const finish = (status, decision) => ({
    status,
    steps: history.length,
    decision,
    observation,
    timings: {
      ...Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v * 10) / 10])),
      wallMs: Math.round((performance.now() - started) * 10) / 10,
    },
  });
  // The model picks `Navi` over `Systemsettings` when the goal names the app it is already in, so the one
  // step it cannot be relied on for is opening the app that owns the network switches. Code opens that
  // app; the model still chooses the network, and every target, from the screen it lands on. Tried once
  // per run, only when the device says it has no internet but does have a saved network to rejoin.
  let coach;
  let networkRecoveries = 0;
  // The app the run left when the network detour began. Recovery hands it back afterwards, because the
  // model has no way to know it is standing in settings while its goal lives in another app.
  let networkReturnTo = null;
  const networkRecovery = async () => {
    if (networkRecoveries >= 1) return false;
    const network = observation.network;
    if (!network || network.internet || network.saved === 0) return false;
    // `com.sgmw.systemsettings` runs the word together, so match it anywhere in the package name.
    const settingsApp = installedApps.find((app) => /settings/i.test(app.packageName));
    if (!settingsApp || typeof device.act !== 'function') return false;
    // The app in front is not always the app the goal lives in: a keyboard or the launcher can hold it.
    // Return only to an app that can be launched on its own, else to the last app the run opened.
    const inFront = observation.phone.packageName;
    const launchable =
      installedApps.some((app) => app.packageName === inFront) &&
      !/inputmethod|keyboard|\bime\b/i.test(inFront);
    const lastOpened = [...history].reverse().find((entry) => entry.action?.type === 'open-app')
      ?.action.packageName;
    if (!/settings/i.test(inFront)) networkReturnTo = launchable ? inFront : (lastOpened ?? null);
    networkRecoveries++;
    avoid.add('WAIT');
    avoid.add('BLOCKED');
    try {
      await device.act(
        { type: 'open-app', packageName: settingsApp.packageName, appLabel: settingsApp.label },
        { expected: observation },
      );
      await onAction({
        step: history.length,
        action: { type: 'open-app', packageName: settingsApp.packageName },
        operation: 'RECOVER_NETWORK',
        label: `Open ${settingsApp.label} to restore the network`,
        executedMs: 0,
      });
    } catch {
      // A stale read or an app that would not launch: the coach still tells the model what is wrong.
    }
    // The settings app opens on its own menu, so the page is right when either the app is in front or a
    // network word is on the screen; requiring 无线网络 alone rejected the menu the model should use.
    const onNetworkScreen = () =>
      /settings/i.test(observation.phone.packageName) ||
      observation.elements.some((e) =>
        /无线网络|WLAN|Wi-?Fi|network settings|连接/i.test(`${e.label ?? ''}${e.text ?? ''}`),
      );
    coach = `The device cannot reach the internet and has ${network.saved} saved Wi-Fi networks, so it can be fixed here. Restoring it is part of this goal: switch Wi-Fi on, then tap a saved network to join it. Do not wait.`;
    await wait(1200);
    observation = await observe();
    // Walk the menu instead of naming it: the wording differs between car models, and the model picks a
    // menu row badly when it is one target among twenty (`语音` for `连接`, five times over). Tapping a row
    // and asking whether the page arrived is a yes/no the model gets right — 0.0008 against 1.0 — so the
    // screen decides which row was the network one.
    const arrives = async () => {
      // Ask about a *fresh* frame. `snapshot()` hands back the helper's cached image, which right after
      // opening settings is still the screen from before the detour — and a question about that image
      // answers "yes, this is the network page" at 0.9997 on the settings menu.
      const image =
        typeof device.screenshot === 'function'
          ? (await device.screenshot().catch(() => null))?.toString('base64')
          : undefined;
      // Without a screenshot the page question would be answered blind, so the walk stops instead of
      // tapping menu rows it cannot check.
      if (!image) return undefined;
      const here = await policy.confirmsNetworkScreen?.({ goal, image });
      return Number(here) >= MIN_NETWORK_SCREEN;
    };
    // Order the rows the walk will try: the entry this car used last time, then anything whose wording
    // names the network, then the rest. Nothing here decides the answer — the page question does.
    const HINT = /连接|网络|无线|WLAN|Wi-?Fi|Network|Internet|Wireless/i;
    const memoKey = `${observation.deviceId}:${observation.phone.packageName}`;
    const entryName = (element) => String(element.text || element.label || '').trim();
    // A settings row is often a clickable container whose name lives in a child TextView, so the row
    // itself reads as unnamed; the child's text is what a person reads off it.
    const nameOf = (element) => {
      const own = entryName(element);
      if (own) return own;
      const child = observation.elements.find(
        (candidate) => candidate.id.startsWith(`${element.id}.`) && entryName(candidate),
      );
      return child ? entryName(child) : '';
    };
    const menuRows = () => {
      const remembered = rememberedEntry(memoKey);
      const rank = (element) => {
        const name = nameOf(element);
        return name === remembered ? 2 : HINT.test(name) ? 1 : 0;
      };
      return observation.elements
        .filter(
          (element) =>
            element.clickable &&
            !element.editable &&
            !element.checkable &&
            !(element.resourceId || '').startsWith('com.android.systemui:') &&
            nameOf(element),
        )
        .sort((a, b) => rank(b) - rank(a))
        .slice(0, 6);
    };
    if (typeof device.observeDirect === 'function' && policy.confirmsNetworkScreen) {
      // Read the screen the slow way first: the tree the helper just gave back was the dock, so the rows
      // it offered were chrome, not the menu this needs to walk.
      observation = await device.observeDirect();
      // Ask once before walking: some cars open straight on the Wi-Fi page.
      const already = await arrives();
      if (already === undefined) {
        // No screenshot to ask about, so the walk cannot check itself. Tap the best-ranked row once — the
        // one the memo or the wording points at — and report that the result could not be confirmed,
        // rather than walking several rows blind.
        const guess = menuRows()[0];
        if (guess)
          await device
            .act({ type: 'tap-element', elementId: guess.id }, { expected: observation })
            .catch(() => {});
        return false;
      }
      if (already) return true;
      const rows = menuRows();
      // Say what the walk decided, so a trace answers "why did recovery stop here" without a rerun.
      await onAction({
        step: history.length,
        action: { type: 'wait' },
        operation: 'RECOVER_NETWORK',
        label: rows.length
          ? `Walk ${rows.length} menu rows: ${rows.map(nameOf).join(', ')}`
          : 'Walk stopped: no menu rows in the tree',
        executedMs: 0,
      });
      for (const row of rows) {
        // Re-resolve by text in the fresh tree: the ids from before the read are positional.
        const name = nameOf(row);
        const again = observation.elements.find(
          (element) => element.clickable && nameOf(element) === name,
        );
        if (!again) continue;
        try {
          await device.act({ type: 'tap-element', elementId: again.id }, { expected: observation });
        } catch {
          break;
        }
        await onAction({
          step: history.length,
          action: { type: 'tap-element', elementId: again.id },
          operation: 'RECOVER_NETWORK',
          label: `Open ${name}`,
          executedMs: 0,
        });
        await wait(1200);
        observation = await observe();
        const verdict = await arrives();
        if (verdict === undefined) return false;
        if (verdict) {
          rememberEntry(memoKey, name);
          break;
        }
      }
    }
    // Only a screen with the app's own controls is worth handing over; otherwise the caller reports the
    // cause instead of letting the model tap chrome.
    return onNetworkScreen();
  };
  let consecutiveWaits = 0,
    consecutiveStale = 0;
  let networkWaits = 0;
  let nearbyMisses = 0,
    lastMissedTap = null;
  const avoid = new Set();
  let recoveries = 0;
  let stalledOperation = null,
    stalledCount = 0;
  let waitingSince;
  // Stale decisions never dispatch input, but still consume a separate model-call budget.
  for (let attempt = 0; attempt < maxSteps * 2 + 4; attempt++) {
    // The network came back during the detour: put the app the run left back in front, and say so.
    if (networkReturnTo && observation.network?.internet) {
      const back = installedApps.find((app) => app.packageName === networkReturnTo);
      const label = back?.label ?? networkReturnTo;
      try {
        await device.act(
          { type: 'open-app', packageName: networkReturnTo, appLabel: back?.label },
          { expected: observation },
        );
        await onAction({
          step: history.length,
          action: { type: 'open-app', packageName: networkReturnTo },
          operation: 'RECOVER_NETWORK',
          label: `Return to ${label}`,
          executedMs: 0,
        });
        coach = `${label} is in front again. The network is back, so continue the goal from here.`;
        observation = await observe();
      } catch (error) {
        // A launch that fails leaves the run where it was; the model can still find the app itself, but
        // say so in the trace, because a silent miss reads exactly like "the return never ran".
        await onAction({
          step: history.length,
          action: { type: 'open-app', packageName: networkReturnTo },
          operation: 'RECOVER_NETWORK',
          label: `Could not return to ${label}: ${error?.message ?? error}`,
          executedMs: 0,
        });
      }
      networkReturnTo = null;
    }
    const modelStart = performance.now();
    const decision = await policy.decide({
      goal,
      observation,
      history,
      texts,
      apps: installedApps,
      image: await snapshot(),
      avoid,
      coach,
    });
    timings.modelMs += performance.now() - modelStart;
    timings.modelCalls++;
    const step = history.length;
    await onStep({ step, attempt, ...decision });
    if (decision.status !== 'action') {
      // The model says it is done. A control that shows the goal's change is evidence the
      // accessibility tree never carries, so a low goal_visible reading need not stand alone.
      const last = history.at(-1);
      if (decision.status === 'done_unverified' && last?.goalMet >= MIN_GLYPH_CONFIDENCE)
        return finish('done', {
          ...decision,
          reason: `Jev chose DONE. The tapped control's own drawing reads as the goal being met (${Math.round(last.goalMet * 100)}%), which the accessibility tree cannot show.`,
        });
      // A network the device could rejoin is not a dead end. Say that once, drop the option, and let the
      // model find the settings app, rather than ending a goal the device can still be brought to do.
      if (decision.status === 'blocked' && (await networkRecovery())) continue;
      return finish(decision.status, decision);
    }
    if (!execute) return finish('preview', decision);
    if (
      Number.isFinite(decision.stuck) &&
      decision.stuck > MIN_STUCK_PROBABILITY &&
      step > MIN_STUCK_STEP
    ) {
      if (await networkRecovery()) continue;
      return finish('stuck', {
        ...decision,
        reason: `Jev judged the recent actions are not making progress (${Math.round(decision.stuck * 100)}%).`,
      });
    }
    if (step >= maxSteps) return finish('step_limit', decision);
    const isWait = decision.action.type === 'wait';
    // A control that names the network is a switch whose effect lands seconds later: joining a saved
    // access point is the system's job, and the tap only starts it. Read from the label rather than the
    // app, because this ROM reports the dock's package even while the settings page owns the screen.
    const networkAction =
      !isWait &&
      NETWORK_CONTROL.test(
        `${decision.label ?? ''} ${decision.action.elementId ? controlLabel(decision.action.elementId, observation) : ''} ${decision.action.text ?? ''}`,
      );
    const wifiOffBefore = observation.network?.wifiOn === false;
    const label =
      decision.label ||
      (isWait ? 'Wait for screen update' : describeAction(decision.action, observation));
    // A tap is remembered by the control it hit, not by the whole screen: a launcher that rotates a
    // tips card every few seconds would otherwise make two identical taps look like different steps.
    // A coordinate that lands on no observed control has nothing to scope the answer to, so that tap
    // falls back to the whole screen.
    const target = tapTarget(decision.action, observation);
    const scoped = target?.elementId ? target : undefined;
    const signature = `${
      scoped
        ? elementState(observation.elements.find((element) => element.id === scoped.elementId))
        : observation.fingerprint
    }:${JSON.stringify(decision.action)}`;
    if (!isWait && repeated.has(signature)) {
      // The same action on a tree that did not move. If the last tap's own drawing changed and reads
      // as the goal being met, repeating it would undo that: stop, and say what the evidence was.
      const last = history.at(-1);
      if (last?.goalMet >= MIN_GLYPH_CONFIDENCE)
        return finish('done', {
          ...decision,
          reason: `Jev asked for the same tap again. The control's own drawing already shows the goal met (${Math.round(last.goalMet * 100)}%) and repeating the tap would undo it, so the run stops here.`,
        });
      // Wi-Fi that just came on is not a network yet: the device scans and associates for several
      // seconds, and repeating the switch would turn it back off. Wait for the association instead.
      if (
        networkWaits < MAX_NETWORK_WAITS &&
        observation.network?.wifiOn &&
        !observation.network.internet
      ) {
        networkWaits++;
        await wait(2500);
        observation = await observe();
        repeated.clear();
        continue;
      }
      // One step can be reported twice while the screen catches up: this control center still listed a
      // deleted widget about five seconds after it vanished. If the control the last tap hit is gone
      // from the current tree, that tap did land — stop treating it as a repeat and carry on.
      const fresh = scoped ? await observe() : null;
      if (fresh && !fresh.elements.some((element) => element.id === scoped.elementId)) {
        repeated.clear();
        observation = fresh;
        continue;
      }
      // The pixels under the last tap did move, so the tap worked and the tree simply cannot confirm
      // it: say so, instead of blaming a dead screen and repeating a toggle that would undo itself.
      return finish(
        'stuck',
        last?.pixelChange
          ? {
              ...decision,
              reason: `The tap changed ${Math.round(last.pixelChange * 100)}% of the control's pixels but nothing in the accessibility tree, so the result cannot be confirmed and Jev stops instead of repeating it.`,
            }
          : {
              ...decision,
              reason: `Jev repeated ${decision.operation ?? 'the same action'} on ${decision.label ?? `target ${decision.target ?? '?'}`} and neither the tree nor the pixels changed, so it stops instead of doing it again.`,
            },
      );
    }
    // Waiting on a screen that has no network behind it never finishes, and the wait budget would spend
    // the whole step allowance before anything else is tried. Reconnect once, then name the cause.
    if (isWait && consecutiveWaits >= 1 && observation.network && !observation.network.internet) {
      if (await networkRecovery()) {
        consecutiveWaits = 0;
        waitingSince = undefined;
        continue;
      }
      return finish('blocked', {
        ...decision,
        reason:
          observation.network.saved > 0
            ? 'The device cannot reach the internet and waiting does not change that. Reconnect a saved network in the settings app, then retry.'
            : 'The device cannot reach the internet and has no saved network to join. Connect one before retrying.',
      });
    }
    if (isWait) {
      waitingSince ??= performance.now();
      if (performance.now() - waitingSince >= waitTimeoutMs)
        return finish('loading_timeout', decision);
    } else waitingSince = undefined;
    const actionStart = performance.now();
    // Read the control before it is touched: a state that only lives in pixels has to be compared
    // against the same control afterwards.
    const tapped = target?.bounds;
    const imageBefore =
      !isWait &&
      tapped &&
      (tapped.right - tapped.left) * (tapped.bottom - tapped.top) <= MAX_PIXEL_CHECK_PX
        ? await capturePng()
        : undefined;
    let stale = false;
    let receipt;
    try {
      if (isWait)
        await wait(
          Math.min(
            100 * 2 ** Math.min(consecutiveWaits, 4),
            1000,
            Math.max(0, waitTimeoutMs - (performance.now() - waitingSince)),
          ),
        );
      else receipt = await device.act(decision.action, { expected: observation });
    } catch (error) {
      if (!(error instanceof StaleObservationError)) throw error; // Never retry uncertain mutations.
      timings.staleRetries++;
      stale = true;
    } finally {
      if (!isWait) timings.actionMs += performance.now() - actionStart;
    }
    if (stale) {
      if (++consecutiveStale >= 3) return finish('unstable_screen', decision);
      observation = await observe();
      continue;
    }
    consecutiveStale = 0;
    repeated.add(signature);
    consecutiveWaits = isWait ? consecutiveWaits + 1 : 0;
    const entry = {
      operation: decision.operation || decision.action.type,
      label,
      action: decision.action,
      ...(decision.action.type === 'type' ? { text: decision.action.text } : {}),
      before: observation.fingerprint,
      screenChanged: null,
    };
    history.push(entry);
    // Log the mutation before observing: a failed read must not erase an executed action.
    if (receipt?.inputTier) entry.inputTier = receipt.inputTier;
    await onAction({
      step,
      action: decision.action,
      operation: entry.operation,
      label,
      ...(receipt?.inputTier ? { inputTier: receipt.inputTier } : {}),
      executedMs: Math.round(performance.now() - started),
    });
    if (settleMs) await wait(settleMs);
    // A tap on a network control makes the cached answer wrong at once: read it again with this step.
    if (networkAction) device.invalidateNetwork?.();
    let after = await observe();
    // The helper follows whatever window has accessibility focus, so a read taken while the keyboard is up
    // can come back as the dock and status bar only — with a dock node posing as the focused field. That is
    // not evidence the text went nowhere: when the step typed into an app and the read came back as chrome,
    // read the app's own window before concluding the input failed.
    const typedIntoApp = !CHROME_PACKAGES.test(observation?.phone?.packageName || '');
    const reread = async (read) =>
      receipt?.inputVerification &&
      typedIntoApp &&
      isChromeRead(read) &&
      typeof device.observeDirect === 'function'
        ? await device.observeDirect()
        : read;
    after = await reread(after);
    if (receipt?.inputVerification) {
      const confirmation = await confirmInput({
        initial: after,
        verification: receipt.inputVerification,
        observe: async () => reread(await observe()),
        timeoutMs: inputTimeoutMs,
        sleep: wait,
      });
      after = confirmation.observation;
      if (!confirmation.verified) {
        observation = after;
        await onObservation({
          step,
          observation: after,
          screenChanged: entry.before !== after.fingerprint,
        });
        return finish('input_unverified', {
          ...decision,
          reason:
            'Text was sent, but its complete value could not be confirmed in the input field. Inspect the screen before retrying.',
        });
      }
    }
    const waitDeadline = performance.now() + settleTimeoutMs;
    // Skip a transient system-bar-only snapshot (no foreground app) before asking Jev again.
    while (
      !isWait &&
      !receipt?.inputVerification &&
      (after.fingerprint === observation.fingerprint || !after.phone.packageName) &&
      performance.now() + 60 < waitDeadline
    ) {
      await wait(60);
      after = await observe();
    }
    entry.after = after.fingerprint;
    const change = scoped ? tapChanged(observation, after, scoped) : undefined;
    entry.screenChanged = change
      ? change.control || change.elsewhere
      : observation.fingerprint !== after.fingerprint;
    if (!change?.control && imageBefore) {
      // The control itself shows nothing, even if something elsewhere on the screen moved. A redraw
      // takes a moment — this control center removed a widget about a second after the tap, while the
      // tree captured 60 ms later still listed it — so look again at both the pixels under the tap and
      // the tree that describes them.
      let latest = await capturePng();
      let fraction = await changedUnder(imageBefore, latest, tapped);
      for (
        let attempt = 0;
        fraction !== null && fraction < MIN_PIXEL_CHANGE && attempt < 2;
        attempt++
      ) {
        await wait(150);
        const retryShot = await capturePng();
        const retry = await changedUnder(imageBefore, retryShot, tapped);
        if (retry !== null && retry > fraction) {
          fraction = retry;
          latest = retryShot;
        }
        const retryTree = await observe();
        const retryChange = scoped ? tapChanged(observation, retryTree, scoped) : undefined;
        if (retryChange?.control || retryChange?.elsewhere) {
          entry.screenChanged = true;
          entry.retrySettled = true;
          after = retryTree;
          entry.after = after.fingerprint;
          break;
        }
      }
      if (fraction !== null && fraction >= MIN_PIXEL_CHANGE) {
        entry.screenChanged = true;
        entry.pixelChange = Math.round(fraction * 1000) / 1000;
        // Pixels only say the area was redrawn. What the control's own drawing now shows is a
        // judgment, and the same control before and after is what a person would look at.
        const beforeCrop = latest && cropControl(imageBefore, tapped);
        const afterCrop = latest && cropControl(latest, tapped);
        if (beforeCrop && afterCrop && typeof policy.readsControlChange === 'function') {
          const read = await policy.readsControlChange({
            goal,
            before: beforeCrop,
            after: afterCrop,
          });
          if (read) {
            const redrew = read.change === 'changed' && read.confidence >= MIN_GLYPH_CONFIDENCE;
            entry.controlChange = read.change;
            entry.screenChanged = redrew;
            // The goal reading rides on the same comparison, so it stands only when that comparison
            // itself is confident the control redrew.
            if (redrew) entry.goalMet = read.satisfied;
          }
        }
      }
    }
    const longer = entry.screenChanged ? undefined : longerHold(decision.action);
    if (longer) {
      // A press that changed nothing may have been too short. Try once more, longer, and judge the
      // result the same way; a refusal to press again is not evidence either way.
      entry.holdMs = longer.duration;
      try {
        await device.act(longer, { expected: after });
        after = await observe();
        const recheck = scoped ? tapChanged(observation, after, scoped) : undefined;
        entry.screenChanged =
          entry.screenChanged || Boolean(recheck?.control || recheck?.elsewhere);
        entry.after = after.fingerprint;
      } catch {
        // Keep the original verdict: the control may be gone, and that is not this step's failure.
        entry.holdRefused = true;
      }
    }
    const name = decision.operation || decision.action.type;
    if (REPEAT_IS_A_LOOP.has(name)) {
      stalledCount = name === stalledOperation ? stalledCount + 1 : 1;
      stalledOperation = name;
    } else {
      stalledOperation = null;
      stalledCount = 0;
    }
    const touched = tapPoint(decision.action, observation);
    if (!touched || entry.screenChanged) {
      nearbyMisses = 0;
      lastMissedTap = null;
    } else {
      nearbyMisses =
        lastMissedTap &&
        Math.abs(lastMissedTap.x - touched.x) <= NEARBY_TAP_PX &&
        Math.abs(lastMissedTap.y - touched.y) <= NEARBY_TAP_PX
          ? nearbyMisses + 1
          : 1;
      lastMissedTap = touched;
    }
    await onObservation({
      step,
      observation: after,
      screenChanged: entry.screenChanged,
      ...(entry.holdMs ? { holdMs: entry.holdMs } : {}),
      ...(entry.holdRefused ? { holdRefused: true } : {}),
    });
    observation = after;
    // A saved network is joined by the system after the tap, not by the tap: association takes a few
    // seconds, and asking the model in the middle of it only produces a repeat tap that cancels the
    // join. Wait out that window on a settings screen, and only there, so no other screen pays for it.
    const joining =
      observation.network?.wifiOn &&
      !observation.network.internet &&
      (networkAction || wifiOffBefore);
    if (joining)
      for (let poll = 0; poll < NETWORK_POLLS; poll++) {
        await wait(2000);
        observation = await observe();
        if (observation.network.internet) break;
      }
    if (nearbyMisses >= MAX_NEARBY_MISSES) {
      if (await networkRecovery()) {
        nearbyMisses = 0;
        lastMissedTap = null;
        continue;
      }
      if (recoveries < MAX_RECOVERIES && decision.operation) {
        avoid.add(decision.operation);
        recoveries++;
        nearbyMisses = 0;
        lastMissedTap = null;
        continue;
      }
      return finish('stuck', {
        ...decision,
        reason: `${MAX_NEARBY_MISSES} taps around (${Math.round(lastMissedTap.x)}, ${Math.round(lastMissedTap.y)}) changed nothing on screen.`,
      });
    }
    if (stalledCount >= MAX_STALLED_REPEAT) {
      if (await networkRecovery()) {
        stalledCount = 0;
        stalledOperation = null;
        continue;
      }
      if (recoveries < MAX_RECOVERIES && decision.operation) {
        avoid.add(decision.operation);
        recoveries++;
        stalledCount = 0;
        stalledOperation = null;
        continue;
      }
      return finish('stuck', {
        ...decision,
        reason: `${stalledCount} × ${stalledOperation} in a row changed nothing on screen.`,
      });
    }
  }
  return finish('decision_limit');
}
