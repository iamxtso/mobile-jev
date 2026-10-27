import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { prepareInputVerification } from './input-verification.mjs';
import { HelperClient } from './helper.mjs';

export const GLOBAL_ACTIONS = { back: 1, home: 2, recent: 3 };
export const KEYS = { back: 4, tab: 61, enter: 66, delete: 67, forward_delete: 112 };
// A drag moves the chosen element by a share of the screen, far enough to reorder a row or throw a
// card away, and short enough to stay on screen.
const DRAG_VECTORS = { LEFT: [-0.35, 0], RIGHT: [0.35, 0], UP: [0, -0.3], DOWN: [0, 0.3] };
const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

export class StaleObservationError extends Error {}

function targetMeaning(observation, id) {
  const target = observation.elements.find((element) => element.id === id);
  if (!target) return null;
  const meaning = Object.fromEntries(Object.entries(target).filter(([key]) => key !== 'bounds'));
  return JSON.stringify({
    ...meaning,
    content: observation.elements
      .filter((e) => e.id.startsWith(id + '.'))
      .map(({ id, text, label, resourceId, editable, enabled, checked, selected }) => ({
        id,
        text,
        label,
        resourceId,
        editable,
        enabled,
        checked,
        selected,
      })),
  });
}

export function assertFresh(current, expected, action, maxAgeMs = 30_000) {
  if (
    !expected ||
    current.deviceId !== expected.deviceId ||
    !Number.isFinite(expected.observedAt) ||
    Date.now() - expected.observedAt > maxAgeMs ||
    expected.observedAt > Date.now() ||
    current.phone.packageName !== expected.phone?.packageName ||
    JSON.stringify(current.screen) !== JSON.stringify(expected.screen)
  ) {
    throw new StaleObservationError(
      'Screen changed or observation expired; observe and decide again.',
    );
  }
  let fresh;
  // Element gestures are checked like an element tap. A drag between two points has no element to
  // compare, so it falls through to the screen-level check below.
  const onElement =
    action.type === 'tap-element' ||
    (action.elementId && ['long-press', 'double-tap', 'drag'].includes(action.type));
  if (onElement) {
    fresh =
      targetMeaning(expected, action.elementId) !== null &&
      targetMeaning(current, action.elementId) === targetMeaning(expected, action.elementId);
  } else if (['type', 'clear', 'key'].includes(action.type) && expected.phone.inputElementId) {
    const id = expected.phone.inputElementId;
    fresh =
      current.phone.isEditable &&
      current.phone.inputElementId === id &&
      targetMeaning(current, id) === targetMeaning(expected, id);
  } else if (action.type === 'global' && action.name === 'home') {
    fresh = true; // HOME is independent of in-app content such as clocks and animations.
  } else if (action.type === 'global') {
    const navigationMeaning = (state) =>
      JSON.stringify({
        phone: state.phone,
        controls: state.elements
          .filter((e) => e.clickable || e.editable)
          .map((e) => targetMeaning(state, e.id)),
        headings: state.elements
          .filter((e) => e.resourceId?.endsWith(':id/title') || e.label)
          .map((e) => [e.id, e.text, e.label]),
      });
    fresh = navigationMeaning(current) === navigationMeaning(expected);
  } else if (action.type === 'swipe' && action.regionId) {
    const before = expected.elements.find((e) => e.id === action.regionId);
    const after = current.elements.find((e) => e.id === action.regionId);
    fresh = before && after?.enabled && after.scrollable && before.resourceId === after.resourceId;
  } else {
    fresh = current.fingerprint === expected.fingerprint;
  }
  if (!fresh)
    throw new StaleObservationError(
      'Screen changed or observation expired; observe and decide again.',
    );
}

function integer(value, name, min = 0) {
  if (!Number.isSafeInteger(value) || value < min)
    throw new Error(`${name} must be an integer >= ${min}.`);
}

async function resolveAction(device, action, { expected, maxAgeMs }, dispatch, inputVerification) {
  if (!action || typeof action !== 'object') throw new Error('An action object is required.');
  if (performance.now() - device.readyAt > 30_000) await device.assertReady();
  if (action.type === 'open-app') {
    if (!device.installedApps.some((app) => app.packageName === action.packageName))
      throw new Error('The app was not observed in the installed-app list.');
    if (expected && expected.deviceId !== device.deviceId)
      throw new Error('Observation belongs to a different device.');
    await dispatch({ type: 'open-app', packageName: action.packageName });
    return;
  }

  const current = await device.observe();
  if (expected) assertFresh(current, expected, action, maxAgeMs);
  const point = (x, y) => {
    integer(x, 'x');
    integer(y, 'y');
    if (x >= current.screen.width || y >= current.screen.height)
      throw new Error('Coordinates are outside the screen.');
  };
  let resolved;
  switch (action.type) {
    case 'tap':
      point(action.x, action.y);
      resolved = { type: 'tap', x: action.x, y: action.y };
      break;
    case 'tap-element': {
      if (!expected) throw new Error('Element taps require their original observation.');
      const node = current.elements.find((entry) => entry.id === action.elementId);
      if (!node?.enabled || !(node.clickable || node.editable))
        throw new Error('Element is not actionable.');
      resolved = {
        type: 'tap',
        x: Math.floor((node.bounds.left + node.bounds.right) / 2),
        y: Math.floor((node.bounds.top + node.bounds.bottom) / 2),
      };
      break;
    }
    case 'swipe':
      point(action.startX, action.startY);
      point(action.endX, action.endY);
      integer(action.duration ?? 300, 'duration', 10);
      resolved = {
        type: 'swipe',
        startX: action.startX,
        startY: action.startY,
        endX: action.endX,
        endY: action.endY,
        duration: action.duration ?? 300,
      };
      if (action.regionId && expected) {
        const before = expected.elements.find((element) => element.id === action.regionId);
        const after = current.elements.find((element) => element.id === action.regionId);
        if (!before || !after) throw new Error('Swipe leaves its observed region.');
        const project = (value, oldStart, oldEnd, newStart, newEnd) => {
          const fraction = (value - oldStart) / (oldEnd - oldStart);
          if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1)
            throw new Error('Swipe leaves its observed region.');
          return Math.floor(newStart + fraction * (newEnd - newStart));
        };
        resolved.startX = project(
          action.startX,
          before.bounds.left,
          before.bounds.right,
          after.bounds.left,
          after.bounds.right,
        );
        resolved.endX = project(
          action.endX,
          before.bounds.left,
          before.bounds.right,
          after.bounds.left,
          after.bounds.right,
        );
        resolved.startY = project(
          action.startY,
          before.bounds.top,
          before.bounds.bottom,
          after.bounds.top,
          after.bounds.bottom,
        );
        resolved.endY = project(
          action.endY,
          before.bounds.top,
          before.bounds.bottom,
          after.bounds.top,
          after.bounds.bottom,
        );
        point(resolved.startX, resolved.startY);
        point(resolved.endX, resolved.endY);
      }
      break;
    case 'long-press':
    case 'double-tap': {
      let at;
      if (action.elementId) {
        const node = current.elements.find((entry) => entry.id === action.elementId);
        if (!node) throw new Error('Element is no longer on screen.');
        at = {
          x: Math.floor((node.bounds.left + node.bounds.right) / 2),
          y: Math.floor((node.bounds.top + node.bounds.bottom) / 2),
        };
      } else {
        point(action.x, action.y);
        at = { x: action.x, y: action.y };
      }
      integer(action.duration ?? 600, 'duration', 10);
      resolved = { type: action.type, ...at, duration: action.duration ?? 600 };
      break;
    }
    case 'drag': {
      if (action.from && action.to) {
        point(action.from.x, action.from.y);
        point(action.to.x, action.to.y);
        resolved = {
          type: 'drag',
          startX: action.from.x,
          startY: action.from.y,
          endX: action.to.x,
          endY: action.to.y,
          duration: action.duration ?? 600,
        };
        break;
      }
      if (!Object.hasOwn(DRAG_VECTORS, action.direction))
        throw new Error('Unsupported drag direction.');
      const node = current.elements.find((entry) => entry.id === action.elementId);
      if (!node) throw new Error('Element is no longer on screen.');
      const [dx, dy] = DRAG_VECTORS[action.direction];
      const startX = Math.floor((node.bounds.left + node.bounds.right) / 2);
      const startY = Math.floor((node.bounds.top + node.bounds.bottom) / 2);
      // `input swipe` moves at once, which the launcher treats as a fling. `draganddrop` presses,
      // waits, then moves: what a finger does when it picks an icon up.
      resolved = {
        type: 'drag',
        startX,
        startY,
        endX: clamp(startX + Math.round(dx * current.screen.width), 0, current.screen.width - 1),
        endY: clamp(startY + Math.round(dy * current.screen.height), 0, current.screen.height - 1),
        duration: action.duration ?? 600,
      };
      break;
    }
    case 'statusbar':
      if (!['notifications', 'settings', 'collapse'].includes(action.view))
        throw new Error('statusbar needs a view: notifications, settings or collapse.');
      resolved = { type: 'statusbar', view: action.view };
      break;
    case 'type':
      if (!current.phone.isEditable) throw new Error('Focus an editable field before typing.');
      if (
        typeof action.text !== 'string' ||
        (action.clear !== undefined && typeof action.clear !== 'boolean')
      )
        throw new Error('Text must be a string and clear must be boolean.');
      resolved = {
        type: 'type',
        text: action.text,
        clear: action.clear ?? false,
        inputVerification: prepareInputVerification(current, action),
      };
      break;
    case 'clear':
      if (!current.phone.isEditable) throw new Error('Focus an editable field before clearing.');
      resolved = { type: 'clear' };
      break;
    case 'key':
      if (!Object.hasOwn(KEYS, action.key)) throw new Error('Unsupported keyboard key.');
      resolved = { type: 'key', key: action.key };
      break;
    case 'global':
      if (!Object.hasOwn(GLOBAL_ACTIONS, action.name))
        throw new Error('Unsupported global action.');
      resolved = { type: 'global', name: action.name };
      break;
    default:
      throw new Error('Unsupported action type.');
  }
  const receipt = inputVerification?.(current, action);
  await dispatch(resolved);
  return receipt ? { inputVerification: receipt } : undefined;
}
// A list row is often a clickable container whose text lives in a child TextView, so the container
// itself looks anonymous. Folding the children's text in lets the row keep a name without the model
// having to guess which container is which.
function descendantText(node, depth = 0) {
  if (depth > 4 || !Array.isArray(node.children)) return '';
  for (const child of node.children) {
    if (!child || child.isPassword === true) continue;
    const own = (child.text || child.contentDescription || '').trim();
    if (own) return own;
    const deeper = descendantText(child, depth + 1);
    if (deeper) return deeper;
  }
  return '';
}

export function summarizeState(raw, deviceId) {
  const screen = raw?.device_context?.screen_bounds;
  if (
    !screen ||
    !Number.isSafeInteger(screen.width) ||
    !Number.isSafeInteger(screen.height) ||
    screen.width < 1 ||
    screen.height < 1 ||
    !raw.phone_state ||
    !raw.a11y_tree
  ) {
    throw new Error('UI state is missing its tree, phone state, or valid screen bounds.');
  }
  const elements = [];
  const visit = (node, path) => {
    if (!node || typeof node !== 'object') return;
    const b = node.boundsInScreen;
    const bounds =
      b &&
      Object.values({ left: b.left, top: b.top, right: b.right, bottom: b.bottom }).every(
        Number.isFinite,
      )
        ? {
            left: Math.max(0, b.left),
            top: Math.max(0, b.top),
            right: Math.min(screen.width, b.right),
            bottom: Math.min(screen.height, b.bottom),
          }
        : null;
    if (
      node.isVisibleToUser !== false &&
      bounds &&
      bounds.right > bounds.left &&
      bounds.bottom > bounds.top
    ) {
      const password = node.isPassword === true;
      const text = password ? '[password]' : node.text || '';
      const label = password ? '' : node.contentDescription || '';
      const editable =
        node.isEditable === true ||
        [
          'android.widget.EditText',
          'android.widget.AutoCompleteTextView',
          'android.widget.MultiAutoCompleteTextView',
        ].includes(node.className);
      if (text || label || node.isClickable || editable || node.isScrollable) {
        const nested = text || label ? '' : descendantText(node);
        elements.push({
          id: path,
          className: node.className || '',
          text,
          label,
          ...(nested ? { nested } : {}),
          resourceId: node.resourceId || '',
          hint: node.hint || '',
          bounds,
          clickable: node.isClickable === true,
          editable,
          scrollable: node.isScrollable === true,
          enabled: node.isEnabled !== false,
          focused: node.isFocused === true,
          password,
          checkable: node.isCheckable === true,
          checked: node.isChecked === true,
          selected: node.isSelected === true,
        });
      }
    }
    if (Array.isArray(node.children))
      node.children.forEach((child, i) => visit(child, `${path}.${i}`));
  };
  visit(raw.a11y_tree, 'ui');
  const inputs = elements.filter((e) => e.editable && e.enabled);
  const focusedInputs = inputs.filter((e) => e.focused);
  const input =
    focusedInputs.length === 1
      ? focusedInputs[0]
      : raw.phone_state.keyboardVisible && inputs.length === 1
        ? inputs[0]
        : undefined;
  const phone = {
    packageName: raw.phone_state.packageName || '',
    currentApp: raw.phone_state.currentApp || '',
    isEditable: raw.phone_state.isEditable === true || Boolean(input),
    inputElementId: input?.id,
    focusEvidence: raw.phone_state.isEditable
      ? 'reported'
      : input?.focused
        ? 'focused-node'
        : input
          ? 'single-input-with-keyboard'
          : 'none',
    keyboardVisible: raw.phone_state.keyboardVisible === true,
    focusedElement: {
      resourceId: raw.phone_state.focusedElement?.resourceId || '',
      className: raw.phone_state.focusedElement?.className || '',
    },
  };
  const content = { deviceId, phone, screen, elements };
  return {
    ...content,
    fingerprint: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
    observedAt: Date.now(),
  };
}

const execFilePromise = promisify(execFile);
const execFileAsync = async (...args) => {
  const { stdout, stderr } = await execFilePromise(...args);
  return [stdout, stderr];
};
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function parseBounds(value) {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(value || '');
  if (!match) throw new Error('UIAutomator XML contains invalid bounds.');
  return {
    left: Number(match[1]),
    top: Number(match[2]),
    right: Number(match[3]),
    bottom: Number(match[4]),
  };
}

function parseTree(value) {
  if (!value || typeof value !== 'object')
    throw new Error('UIAutomator XML is missing its hierarchy.');
  let focusedInput = false;
  const visit = (node) => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== 'object')
      throw new Error('UIAutomator XML contains an invalid node.');
    const children = node.node == null ? [] : [visit(node.node)].flat();
    if (typeof node.bounds !== 'string') return { children };
    const className = node.class || '';
    focusedInput ||= node.focused === 'true' && className.includes('EditText');
    return {
      className,
      // The app that owns the node: it names the foreground app when the helper cannot.
      package: node.package || '',
      text: node.text || '',
      contentDescription: node['content-desc'] || '',
      resourceId: node['resource-id'] || '',
      boundsInScreen: parseBounds(node.bounds),
      isVisibleToUser: node.displayed !== 'false',
      isEnabled: node.enabled !== 'false',
      isClickable: node.clickable === 'true',
      isEditable: node.editable === 'true' || className.includes('EditText'),
      isScrollable: node.scrollable === 'true',
      isCheckable: node.checkable === 'true',
      isChecked: node.checked === 'true',
      isSelected: node.selected === 'true',
      isFocused: node.focused === 'true',
      isPassword: node.password === 'true',
      children,
    };
  };
  return { tree: visit(value), focusedInput };
}

function parseUiAutomatorXml(output) {
  const text = output.toString('utf8');
  const start = text.indexOf('<?xml');
  const end = text.lastIndexOf('</hierarchy>');
  if (start < 0 || end < start) throw new Error('UIAutomator returned malformed XML.');
  const xml = text.slice(start, end + '</hierarchy>'.length);
  if (XMLValidator.validate(xml) !== true) throw new Error('UIAutomator returned malformed XML.');
  let parsed;
  try {
    parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(xml);
  } catch {
    throw new Error('UIAutomator returned malformed XML.');
  }
  return parseTree(parsed?.hierarchy);
}
function parseDisplaySize(value, label) {
  const match = /(\d+)\s*[xX]\s*(\d+)/.exec(value);
  if (!match) throw new Error(`ADB returned invalid ${label} display bounds.`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1)
    throw new Error(`ADB returned invalid ${label} display bounds.`);
  return { width, height };
}

function currentDisplaySize(windowText) {
  const sections = windowText.split(/\n(?=\s*Display:\s*mDisplayId=)/);
  const displaySections = sections.filter((section) => /^\s*Display:\s*mDisplayId=/.test(section));
  const selected = displaySections.find((section) => /^\s*Display:\s*mDisplayId=0\b/.test(section));
  if (!selected && displaySections.length > 1)
    throw new Error('ADB dumpsys window returned ambiguous current display bounds.');

  const section = selected || displaySections[0] || '';
  const sizes = (names) => [
    ...new Set(
      [
        ...section.matchAll(
          new RegExp(`\\b(?:${names})\\s*(?:=|:)\\s*(\\d+)\\s*[xX]\\s*(\\d+)`, 'gi'),
        ),
      ].map((match) => `${Number(match[1])}x${Number(match[2])}`),
    ),
  ];
  // cur= is the display size; app= is the app viewport and legitimately differs, so only
  // fall back to it when the device omits cur.
  const unique = sizes('current|cur');
  const resolved = unique.length ? unique : sizes('app');
  if (resolved.length > 1)
    throw new Error('ADB dumpsys window returned ambiguous current display bounds.');
  if (resolved.length === 0) return null;
  const [width, height] = resolved[0].split('x').map(Number);
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1)
    throw new Error('ADB dumpsys window returned invalid current display bounds.');
  return { width, height };
}

function wmDisplaySize(sizeText) {
  const match =
    sizeText.match(/Override size:\s*(\d+)\s*[xX]\s*(\d+)/) ||
    sizeText.match(/Physical size:\s*(\d+)\s*[xX]\s*(\d+)/);
  return match ? parseDisplaySize(match[0], 'screen') : null;
}

function assertTreeFitsScreen(tree, size) {
  const root = tree.boundsInScreen || tree.children?.[0]?.boundsInScreen;
  // The accessibility root is normally inset by the status and navigation bars (Chrome reports
  // [0,136][1080,2337]), and a dialog or bubble is a legitimate root of its own (a popup can be a
  // fraction of the screen). So the rule is only that the tree sits inside the display and is not
  // empty; taps are checked by observing whether the screen actually changed.
  const inside = (bounds) =>
    bounds.left >= 0 &&
    bounds.top >= 0 &&
    bounds.right <= size.width &&
    bounds.bottom <= size.height;
  const empty = (bounds) => bounds.right <= bounds.left || bounds.bottom <= bounds.top;
  if (!root || !inside(root) || empty(root))
    throw new Error('ADB UIAutomator bounds do not match the current display bounds.');
  const visit = (node) => {
    if (node.boundsInScreen && !inside(node.boundsInScreen))
      throw new Error('ADB UIAutomator bounds exceed the current display bounds.');
    for (const child of node.children || []) visit(child);
  };
  visit(tree);
}

/**
 * The app that owns most of the tree, for screens where the helper cannot name the foreground app.
 * The status bar and notification shade belong to systemui and are always present, so the most
 * common package is the app, not the first one encountered.
 */
function treePackage(node) {
  const counts = new Map();
  const visit = (current) => {
    if (current?.package) counts.set(current.package, (counts.get(current.package) ?? 0) + 1);
    for (const child of current?.children || []) visit(child);
  };
  visit(node);
  let best = '',
    most = 0;
  for (const [name, count] of counts) {
    if (count > most) {
      best = name;
      most = count;
    }
  }
  return best;
}

export class AdbDevice {
  constructor({ serial, adbPath = 'adb', execFile: runner = execFileAsync, helper = false } = {}) {
    if (typeof serial !== 'string' || !/^[A-Za-z0-9._:-]+$/.test(serial.trim()))
      throw new Error('ADB mode requires one explicit serial using letters, numbers, . _ : or -.');
    this.serial = serial.trim();
    this.deviceId = this.serial;
    this.adbPath = adbPath;
    this.execFile = runner;
    this.readyAt = -Infinity;
    this.installedApps = [];
    // The accessibility helper app reads the tree and takes a screenshot in one request, without
    // taking the UiAutomation channel that uiautomator needs. Opt-in: it costs one probe per run.
    this.helper = helper
      ? new HelperClient({ serial: this.serial, adbPath, execFile: runner })
      : null;
    this.snapshotImage = null;
  }

  async run(args, mutation = false, options = {}) {
    try {
      const [stdout] = await this.execFile(this.adbPath, ['-s', this.serial, ...args], {
        encoding: 'buffer',
        maxBuffer: 20 * 1024 * 1024,
        shell: false,
        ...options,
      });
      const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
      if (mutation && /\b(error|exception|unknown command)\b/i.test(bytes.toString('utf8')))
        throw new Error('uncertain');
      return bytes;
    } catch (error) {
      if (mutation)
        throw new Error('ADB mutation outcome is uncertain; the action was not retried.');
      // The device's own words are the only way to tell a launching app ("could not get idle state")
      // from a dead connection, which need opposite handling.
      // `uiautomator` reports its own failures on stdout, not stderr, so read both.
      const reason = String(error?.stderr || error?.stdout || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
      throw new Error(
        error?.code === 'ENOENT'
          ? 'Could not run adb. Install Android platform-tools and retry.'
          : `ADB read failed${reason ? `: ${reason}` : ''}. Check the explicit serial and device connection.`,
      );
    }
  }

  async assertReady() {
    const state = (await this.run(['get-state'])).toString('utf8').trim();
    if (state !== 'device') throw new Error(`ADB device is ${state || 'unavailable'}.`);
    await this.wake();
    this.readyAt = performance.now();
    return { id: this.serial, name: this.serial, state: 'ready' };
  }

  /**
   * A phone that fell asleep reports no focused window and an empty tree, so every step after the
   * screen timeout fails as if the app had vanished. Wake it and dismiss the keyguard instead.
   */
  async wake() {
    try {
      const power = (await this.run(['shell', 'dumpsys', 'power'])).toString('utf8');
      // Only a clear "asleep" is worth acting on: an answer we cannot read is not evidence.
      if (!/mWakefulness=/.test(power) || /mWakefulness=(Awake|Dreaming)/.test(power)) return false;
      await this.run(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], true);
      await this.run(['shell', 'wm', 'dismiss-keyguard'], true);
      return true;
    } catch {
      return false;
    }
  }

  async observe() {
    // A dump taken while a window is settling can disagree with the display size, or arrive as
    // malformed XML. Those are stale reads, and a read is safe to repeat: do not end the run for them.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.readObservation();
      } catch (error) {
        // A window that is still animating has no idle state yet, and the dump then writes an error
        // instead of XML. Waiting is the fix; a real disconnect keeps failing and is reported.
        const transient =
          /do not match the current display|malformed XML|could not get (idle state|dump)|ERROR: could not/.test(
            error?.message,
          );
        // A launch animation keeps `uiautomator dump` unreliable for about a second; the read is
        // free to repeat, so wait it out instead of ending the run.
        if (!transient || attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }

  async readObservation() {
    // One request for the tree and the image, when the helper is there; about 20 times faster than
    // an adb dump, and the image comes from the same instant as the tree.
    if (this.helper) {
      // The helper is the reliable path: one request, no UiAutomation contention, no dump file. A
      // momentary miss is worth repeating before falling back to the slower, fussier adb read.
      for (let attempt = 0; (await this.helper.available()) && attempt < 3; attempt++) {
        const snapshot = await this.helper.snapshot();
        if (snapshot) return this.observationFromSnapshot(snapshot);
        await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
      }
    }
    this.snapshotImage = null;
    const [sizeOutput, windowOutput, xmlOutput] = await Promise.all([
      this.run(['shell', 'wm', 'size']),
      this.run(['shell', 'dumpsys', 'window']),
      // Dump to a file and read it back: `dump /dev/tty` truncates or interleaves the XML on larger
      // trees (a settings screen is about 30 KB), which the parser then rejects as malformed.
      this.run(['shell', 'uiautomator', 'dump', '/sdcard/window_dump.xml']).then(() =>
        this.run(['exec-out', 'cat', '/sdcard/window_dump.xml']),
      ),
    ]);
    const sizeText = sizeOutput.toString('utf8');
    const windowText = windowOutput.toString('utf8');
    const size = currentDisplaySize(windowText) || wmDisplaySize(sizeText);
    if (!size) throw new Error('ADB returned invalid screen bounds.');
    const foreground = windowText.match(
      /m(?:CurrentFocus|FocusedApp)[^\n]*?\s([A-Za-z0-9._]+)\/([^\s}]+)/,
    );
    const { tree, focusedInput } = parseUiAutomatorXml(xmlOutput);
    assertTreeFitsScreen(tree, size);
    return summarizeState(
      {
        device_context: { screen_bounds: size },
        phone_state: {
          packageName: foreground?.[1] || '',
          currentApp: foreground ? `${foreground[1]}/${foreground[2]}` : '',
          keyboardVisible: focusedInput,
          isEditable: focusedInput,
        },
        a11y_tree: tree,
      },
      this.serial,
    );
  }

  observationFromSnapshot(snapshot) {
    const size = { width: snapshot.width, height: snapshot.height };
    if (!size.width || !size.height) throw new Error('The helper returned invalid screen bounds.');
    const { tree, focusedInput } = parseUiAutomatorXml(Buffer.from(snapshot.xml, 'utf8'));
    assertTreeFitsScreen(tree, size);
    // The image must match the tree the policy is about to read, so keep the pair together.
    this.snapshotImage = snapshot.image;
    const packageName = snapshot.packageName || treePackage(tree) || '';
    return summarizeState(
      {
        device_context: { screen_bounds: size },
        phone_state: {
          packageName,
          currentApp:
            snapshot.activity && packageName ? `${packageName}/${snapshot.activity}` : packageName,
          keyboardVisible: focusedInput,
          isEditable: focusedInput,
        },
        a11y_tree: tree,
      },
      this.serial,
    );
  }

  async listApps() {
    const output = (
      await this.run([
        'shell',
        'cmd',
        'package',
        'query-activities',
        '--brief',
        '-a',
        'android.intent.action.MAIN',
        '-c',
        'android.intent.category.LAUNCHER',
      ])
    ).toString('utf8');
    const packageNames = [
      ...new Set(
        output
          .split(/\r?\n/)
          .map((line) => line.trim().match(/^([A-Za-z0-9._]+)\/[^\s]+$/)?.[1])
          .filter(Boolean),
      ),
    ];
    if (!packageNames.length) throw new Error('ADB returned no launchable apps.');
    this.installedApps = packageNames.map((packageName) => ({
      packageName,
      label: packageName
        .split('.')
        .at(-1)
        .replaceAll(/[_-]/g, ' ')
        .replaceAll(/\b\w/g, (character) => character.toUpperCase()),
    }));
    return this.installedApps;
  }

  async screenshot() {
    const raw = await this.run(['exec-out', 'screencap', '-p'], false, { timeout: 5_000 });
    // adb writes warnings to stdout ahead of the PNG (e.g. "Multiple displays were found").
    const start = raw.indexOf(PNG_SIGNATURE);
    if (start < 0) throw new Error('ADB screenshot is not a PNG.');
    return raw.subarray(start);
  }

  async act(action, context = {}) {
    return resolveAction(
      this,
      action,
      context,
      async (resolved) => {
        if (resolved.type === 'open-app') {
          const output = (
            await this.run([
              'shell',
              'cmd',
              'package',
              'resolve-activity',
              '--brief',
              '-a',
              'android.intent.action.MAIN',
              '-c',
              'android.intent.category.LAUNCHER',
              resolved.packageName,
            ])
          )
            .toString('utf8')
            .trim()
            .split(/\r?\n/)
            .at(-1);
          if (!/^[A-Za-z0-9._]+\/[A-Za-z0-9._$]+$/.test(output || ''))
            throw new Error('ADB could not resolve the app launch activity.');
          await this.run(['shell', 'am', 'start', '-n', output], true);
          return;
        }
        if (resolved.type === 'tap')
          return this.run(['shell', 'input', 'tap', String(resolved.x), String(resolved.y)], true);
        if (resolved.type === 'long-press')
          // `input tap` has no duration; a zero-length swipe is how a hold is expressed.
          return this.run(
            [
              'shell',
              'input',
              'swipe',
              String(resolved.x),
              String(resolved.y),
              String(resolved.x),
              String(resolved.y),
              String(resolved.duration),
            ],
            true,
          );
        if (resolved.type === 'double-tap') {
          await this.run(['shell', 'input', 'tap', String(resolved.x), String(resolved.y)], true);
          return this.run(['shell', 'input', 'tap', String(resolved.x), String(resolved.y)], true);
        }
        if (resolved.type === 'drag')
          return this.run(
            [
              'shell',
              'input',
              'draganddrop',
              String(resolved.startX),
              String(resolved.startY),
              String(resolved.endX),
              String(resolved.endY),
              String(resolved.duration),
            ],
            true,
          );
        if (resolved.type === 'statusbar')
          return this.run(
            [
              'shell',
              'cmd',
              'statusbar',
              // The quick settings tiles (brightness, wifi, bluetooth) only exist on the expanded
              // panel; expanding the notification list alone closes them again.
              {
                notifications: 'expand-notifications',
                settings: 'expand-settings',
                collapse: 'collapse',
              }[resolved.view],
            ],
            true,
          );
        if (resolved.type === 'swipe')
          return this.run(
            [
              'shell',
              'input',
              'swipe',
              String(resolved.startX),
              String(resolved.startY),
              String(resolved.endX),
              String(resolved.endY),
              String(resolved.duration),
            ],
            true,
          );
        if (resolved.type === 'clear')
          return this.run(['shell', 'input', 'keyevent', '--longpress', '67'], true);
        if (resolved.type === 'key')
          return this.run(['shell', 'input', 'keyevent', String(KEYS[resolved.key])], true);
        if (resolved.type === 'global') {
          const keycode = { back: 4, home: 3, recent: 187 }[resolved.name];
          return this.run(['shell', 'input', 'keyevent', String(keycode)], true);
        }
        if (resolved.type === 'type') {
          if (!/^[A-Za-z0-9 ._@+:-]+$/.test(resolved.text))
            throw new Error(
              'ADB text supports only letters, numbers, spaces, and ._@+:- characters.',
            );
          if (resolved.clear)
            await this.run(['shell', 'input', 'keyevent', '--longpress', '67'], true);
          return this.run(['shell', 'input', 'text', resolved.text.replaceAll(' ', '%s')], true);
        }
        throw new Error('Unsupported action type.');
      },
      (current, action) => prepareInputVerification(current, action),
    );
  }
}
