import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { prepareInputVerification } from './input-verification.mjs';
import { HelperClient } from './helper.mjs';
import {
  appListTiles,
  probeCells,
  rememberedAppListPoint,
  rememberAppListPoint,
} from './applist.mjs';
import { clearField, enterText } from './text-entry.mjs';

export const GLOBAL_ACTIONS = { back: 1, home: 2, recent: 3 };
export const KEYS = { back: 4, tab: 61, enter: 66, delete: 67, forward_delete: 112 };
// The system's own windows: the dock, the status bar, the launcher. A tree made only of these while an
// app owns the screen is a read of the wrong window.
const CHROME_PACKAGES = /^(com\.android\.systemui|com\.sgmw\.launcher)$/i;
// A drag moves the chosen element by a share of the screen, far enough to reorder a row or throw a
// card away, and short enough to stay on screen.
const DRAG_VECTORS = { LEFT: [-0.35, 0], RIGHT: [0.35, 0], UP: [0, -0.3], DOWN: [0, 0.3] };
const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

export class StaleObservationError extends Error {}

// The network does not change between two steps of one run, and each read costs three adb calls.
const NETWORK_TTL_MS = 1500;

/** Whether a box covers less than the element itself, which is when aiming at it matters. */
function differsFrom(box, bounds) {
  if (!box || !bounds) return false;
  if (box.right <= box.left || box.bottom <= box.top) return false;
  return (
    box.left !== bounds.left ||
    box.top !== bounds.top ||
    box.right !== bounds.right ||
    box.bottom !== bounds.bottom
  );
}

/**
 * Where a gesture on an element lands: the middle of the box its name is drawn in when that is a label
 * inside a larger cell, otherwise the middle of the element itself. A toolbar cell centres its glyph,
 * so the two usually agree; when they do not, the glyph is what a person aims at.
 */
function aim(element) {
  const box = element.nameBox ?? element.bounds;
  return {
    x: Math.floor((box.left + box.right) / 2),
    y: Math.floor((box.top + box.bottom) / 2),
  };
}

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
  } else if (action.type === 'tap') {
    // A point tap is judged by the control it lands on, not by the whole tree. A car launcher redraws its
    // voice-tips card every few seconds, so the fingerprint of an idle home screen differs between two
    // reads and expired every point tap decided on one: three stale retries ended the run.
    const atPoint = (state) =>
      state.elements
        .filter(
          ({ bounds }) =>
            bounds.left <= action.x &&
            action.x < bounds.right &&
            bounds.top <= action.y &&
            action.y < bounds.bottom,
        )
        // The smallest control containing the point is the one a person would say they tapped; a
        // container and its child share the point, and only the child says whether the tap still means
        // the same thing.
        .sort(
          (a, b) =>
            (a.bounds.right - a.bounds.left) * (a.bounds.bottom - a.bounds.top) -
            (b.bounds.right - b.bounds.left) * (b.bounds.bottom - b.bounds.top),
        )[0];
    const drawn = (node) =>
      node
        ? JSON.stringify([node.bounds, node.text, node.label, node.resourceId, node.checked])
        : null;
    fresh = drawn(atPoint(current)) === drawn(atPoint(expected));
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
      // A checkable control answers a tap even when this ROM forgets to mark it clickable: that is what a
      // person does with a switch, and the settings page here reports both its switches that way.
      if (!node?.enabled || !(node.clickable || node.editable || node.checkable))
        throw new Error('Element is not actionable.');
      resolved = { type: 'tap', ...aim(node) };
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
        at = aim(node);
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
      const { x: startX, y: startY } = aim(node);
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
  const executed = await dispatch(resolved);
  const consumed = {
    ...(receipt ? { inputVerification: receipt } : {}),
    // Which text tier answered — clipboard, adbkeyboard, yadb, input, or pinyin. Without it a trace
    // cannot say whether a Chinese goal arrived by paste or by a keyboard spelling.
    ...(resolved.type === 'type' && typeof executed === 'string' ? { inputTier: executed } : {}),
  };
  return Object.keys(consumed).length ? consumed : undefined;
}
// A list row is often a clickable container whose text lives in a child TextView, so the container
// itself looks anonymous. Folding the children's text in lets the row keep a name without the model
// having to guess which container is which.
/**
 * The first named descendant of a node that has no name of its own, with the box that name is drawn in.
 * A clickable container is often much larger than the label it is named after — a toolbar cell whose
 * glyph sits in the middle of its own cell — so the box is what a tap has to aim at.
 */
function descendantName(node, depth = 0) {
  if (depth > 4 || !Array.isArray(node.children)) return null;
  for (const child of node.children) {
    if (!child || child.isPassword === true) continue;
    const own = (child.text || child.contentDescription || '').trim();
    if (own) return { text: own, box: child.boundsInScreen ?? null };
    const deeper = descendantName(child, depth + 1);
    if (deeper) return deeper;
  }
  return null;
}

// A clickable icon that carries no text and no description.
function anonymousControl(node) {
  return (
    node?.isVisibleToUser !== false &&
    node?.isClickable === true &&
    !(node.text || '').trim() &&
    !(node.contentDescription || '').trim() &&
    !descendantName(node)
  );
}

// A row of nothing but unnamed clickable icons: the only thing that tells one from another is where
// it sits.
function anonymousIconRow(parent) {
  const children = Array.isArray(parent?.children) ? parent.children : [];
  const clickable = children.filter(
    (child) => child?.isVisibleToUser !== false && child?.isClickable === true,
  );
  const unnamed = clickable.filter(anonymousControl);
  return clickable.length >= 2 && unnamed.length === clickable.length ? unnamed : [];
}

// A delete or add badge sits in the corner of the cell it belongs to and carries no name of its own,
// so the cell is the only thing that says what the badge acts on. Without this the badge is an
// anonymous 31 px square, and the model taps the cell underneath it instead.
function anonymousCornerName(node, parent) {
  if (!anonymousControl(node)) return '';
  const cell = parent?.boundsInScreen;
  const own = node.boundsInScreen;
  if (!cell || !own) return '';
  const cellWidth = cell.right - cell.left;
  const cellHeight = cell.bottom - cell.top;
  const width = own.right - own.left;
  const height = own.bottom - own.top;
  if (!(width > 0 && height > 0)) return '';
  if (width > cellWidth * 0.4 || height > cellHeight * 0.4) return '';
  const contact = 32;
  const vertical =
    own.top - cell.top <= contact ? '上' : cell.bottom - own.bottom <= contact ? '下' : '';
  const horizontal =
    cell.right - own.right <= contact ? '右' : own.left - cell.left <= contact ? '左' : '';
  if (!vertical || !horizontal) return '';
  const cellName =
    (parent.text || parent.contentDescription || '').trim() || descendantName(parent)?.text;
  if (!cellName) return '';
  // Cells describe themselves with a list, and only the first entry is the name a person reads.
  const short = cellName.split(';')[0].trim().slice(0, 24);
  return short ? `${short} 的${horizontal}${vertical}角按钮` : '';
}

// Two unnamed rows can share a container name — any app without resource ids falls back to the class
// name — and then `1 of 2 in FrameLayout` names two different controls. The second gets a suffix.
function rowAnchor(parent, counts, assigned) {
  const known = assigned.get(parent);
  if (known) return known;
  const base =
    (parent.resourceId || '').split('/').pop() ||
    (parent.className || '').split('.').pop() ||
    'parent';
  const seen = (counts.get(base) || 0) + 1;
  counts.set(base, seen);
  const anchor = seen === 1 ? base : `${base}#${seen}`;
  assigned.set(parent, anchor);
  return anchor;
}

// Several siblings like that read as the same blank to the model, which then has to guess: on a car
// dock it pressed "next track" instead of "pause", eleven times in a row. Numbering them by position
// turns a blind pick into a named choice, without teaching the policy what any glyph means. The row
// has to be all icons: mixed rows are already distinguishable by their named members, and numbering
// their containers would name the wrong control.
function anonymousSiblingName(node, parent, anchors) {
  const siblings = anonymousIconRow(parent);
  if (!siblings.includes(node)) return '';
  const anchor = anchors ? rowAnchor(parent, anchors.counts, anchors.assigned) : '';
  return `${siblings.indexOf(node) + 1} of ${siblings.length} in ${anchor || 'parent'}`;
}

/**
 * Where a device is right now, small enough for one trace line. A run that dies mid-way uses this to
 * say what it left on the screen; a read that fails here is reported as unreadable rather than as an
 * unchanged screen.
 */
export async function lastState(device) {
  try {
    const observation = await device.observe();
    return {
      deviceId: observation.deviceId,
      packageName: observation.phone.packageName,
      currentApp: observation.phone.currentApp,
      fingerprint: observation.fingerprint,
      elements: observation.elements.length,
    };
  } catch (error) {
    return { unreadable: error.message };
  }
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
  const anchors = { counts: new Map(), assigned: new WeakMap() };
  const visit = (node, path, parent) => {
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
        const named = text || label ? null : descendantName(node);
        const nested =
          named?.text ||
          (text || label
            ? ''
            : anonymousCornerName(node, parent) || anonymousSiblingName(node, parent, anchors));
        // Where the name is drawn, when that is somewhere inside the container rather than on it.
        const nameBox =
          named?.box &&
          [named.box.left, named.box.top, named.box.right, named.box.bottom].every(Number.isFinite)
            ? {
                left: Math.max(bounds.left, named.box.left),
                top: Math.max(bounds.top, named.box.top),
                right: Math.min(bounds.right, named.box.right),
                bottom: Math.min(bounds.bottom, named.box.bottom),
              }
            : null;
        elements.push({
          id: path,
          className: node.className || '',
          text,
          label,
          ...(nested ? { nested } : {}),
          ...(nameBox && differsFrom(nameBox, bounds) ? { nameBox } : {}),
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
      node.children.forEach((child, i) => visit(child, `${path}.${i}`, node));
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
  constructor({
    serial,
    adbPath = 'adb',
    execFile: runner = execFileAsync,
    helper = false,
    helperPort,
  } = {}) {
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
      ? new HelperClient({ serial: this.serial, adbPath, execFile: runner, fixedPort: helperPort })
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

  /**
   * One read that skips the helper. The helper follows the accessibility-focused window, which on this
   * ROM is sometimes the dock overlay even while an app owns the screen; the slow `uiautomator` read
   * returns the app's own window. Costs about ten seconds, so it is for the one screen where the wrong
   * window would send the model at chrome it cannot use.
   */
  async observeDirect() {
    const helper = this.helper;
    this.helper = null;
    try {
      return await this.observe();
    } finally {
      this.helper = helper;
    }
  }

  async observe() {
    // A dump taken while a window is settling can disagree with the display size, or arrive as
    // malformed XML. Those are stale reads, and a read is safe to repeat: do not end the run for them.
    for (let attempt = 0; ; attempt++) {
      try {
        const observation = await this.readObservation();
        observation.network = await this.networkState();
        return await this.dropKeyboardCandidates(observation);
      } catch (error) {
        // A window that is still animating has no idle state yet, and the dump then writes an error
        // instead of XML. Waiting is the fix; a real disconnect keeps failing and is reported.
        const transient =
          /do not match the current display|malformed XML|could not get (idle state|dump)|ERROR: could not/.test(
            error?.message,
          );
        // A launch animation keeps `uiautomator dump` unreliable for about a second, and a remote adb
        // connection drops the odd read outright. A read has no side effect, so every read error is
        // worth repeating once before it ends the run; a device that is really gone keeps failing.
        if (attempt >= 2) throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, (transient ? 250 : 600) * (attempt + 1)),
        );
      }
    }
  }

  /**
   * Is the helper's tree the chrome layer while an app owns the screen? `mCurrentFocus` names the window
   * the user is in; a chrome-only tree that disagrees with it is a read of the wrong window, and the
   * caller reads the app's own window instead.
   */
  async chromeHidesApp(packageName) {
    if (!CHROME_PACKAGES.test(packageName || '')) return false;
    const output = await this.run(['shell', 'dumpsys', 'window']).catch(() => null);
    if (!output) return false;
    const focus = output.toString('utf8').match(/mCurrentFocus=[^\n]*?\s([A-Za-z0-9._]+)\//);
    return Boolean(focus && focus[1] !== packageName && !CHROME_PACKAGES.test(focus[1]));
  }

  async readObservation() {
    // One request for the tree and the image, when the helper is there; about 20 times faster than
    // an adb dump, and the image comes from the same instant as the tree.
    if (this.helper) {
      // The helper is the reliable path: one request, no UiAutomation contention, no dump file. A
      // momentary miss is worth repeating before falling back to the slower, fussier adb read.
      let chromeOnly = false;
      for (let attempt = 0; (await this.helper.available()) && attempt < 3; attempt++) {
        const snapshot = await this.helper.snapshot();
        // A tree that is only the dock and status bar is what the helper sometimes returns while an app
        // owns the screen. Reading the adb way costs several seconds, but being wrong about which app is
        // in front costs the run: on the settings 连接 page the helper reported `com.android.systemui`
        // with the dock's nodes, and the model then pressed a row of the page it had been told was not
        // there. One `dumpsys window` decides, and the app's own tree is the one worth reading.
        if (snapshot) {
          // The helper's own `package` is empty on this ROM, so the tree decides what it read, and a
          // chrome-only tree agrees with itself. `mCurrentFocus` is the only oracle for the window the
          // user is in, and it is what says whether this read can be believed.
          const observation = this.observationFromSnapshot(snapshot);
          if (!(await this.chromeHidesApp(observation.phone.packageName))) return observation;
          chromeOnly = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
      }
      // A helper the system reports as enabled can still answer nothing: this ROM leaves its process
      // alive after unbinding the service. Restart it once per run rather than read every screen through
      // the ten-second adb dump for the rest of the night.
      // A working helper that read the wrong window is not a helper to repair: repairing would take the
      // same chrome-only snapshot again and hand it back.
      if (!chromeOnly && !this.helperRepaired && (await this.helper.repair())) {
        this.helperRepaired = true;
        const snapshot = await this.helper.snapshot();
        if (snapshot) return this.observationFromSnapshot(snapshot);
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

  /**
   * Where the input method window sits, or null when it is not on screen.
   *
   * The keyboard is a window of its own and its buttons arrive in the same tree as the app's controls:
   * on a search screen the Sogou toolbar's Sogou logo, keyboard toggle and collapse arrow look like three
   * unnamed buttons, which the tree then numbers `1 of 3 in ViewGroup`. The model tapped that number twice
   * while looking for a search result. Typing never taps the keyboard — text goes in through the helper's
   * clipboard — so anything inside that window is noise that reads as a target.
   */
  async keyboardRegion() {
    const output = await this.run(['shell', 'dumpsys', 'window', 'windows']);
    const block = output
      .toString('utf8')
      .split(/\n\s*Window #/)
      .find((chunk) => /mIsImWindow=true/.test(chunk) && /isVisible=true/.test(chunk));
    if (!block) return null;
    // The touchable region is the area the keyboard actually takes: it excludes the app's own bar above it.
    const region = block.match(/touchable region=SkRegion\(\((-?\d+),(-?\d+),(-?\d+),(-?\d+)\)\)/);
    const frame = region ?? block.match(/\bframe=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    if (!frame) return null;
    return {
      left: Number(frame[1]),
      top: Number(frame[2]),
      right: Number(frame[3]),
      bottom: Number(frame[4]),
    };
  }

  /** Drop the keyboard's own buttons from the clickable set; the field above it stays. */
  async dropKeyboardCandidates(observation) {
    if (!observation.phone?.keyboardVisible) return observation;
    let region;
    try {
      region = await this.keyboardRegion();
    } catch {
      // A read that fails costs one stale candidate list, not the whole observation.
      return observation;
    }
    if (!region || region.right <= region.left || region.bottom <= region.top) return observation;
    const inside = (bounds) => {
      const x = (bounds.left + bounds.right) / 2;
      const y = (bounds.top + bounds.bottom) / 2;
      return x >= region.left && x <= region.right && y >= region.top && y <= region.bottom;
    };
    const elements = observation.elements.filter(
      (element) => !(element.clickable && inside(element.bounds)),
    );
    if (elements.length === observation.elements.length) return observation;
    return { ...observation, elements, keyboardRegion: region };
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

  /**
   * Can this device reach the internet, and could it get there on its own? Read from the device rather
   * than from the status-bar glyph, so an agent that acts on it acts on a fact: `internet` is a real
   * one-packet probe, `wifiOn` is the setting, and `saved` counts the networks this device already has
   * credentials for — a non-zero count is what makes reconnecting something the agent can do without
   * asking for a password. Cached for NETWORK_TTL_MS: three adb calls per observation would otherwise
   * cost more than the tree read.
   */
  /** A tap on a network control makes the cached answer wrong at once; the next read refreshes it. */
  invalidateNetwork() {
    this.networkAt = -Infinity;
  }

  async networkState() {
    const now = performance.now();
    if (this.network && now - this.networkAt < NETWORK_TTL_MS) return this.network;
    // One shell round trip, not three: over a remote adb server each call costs about a second, and this
    // runs on every observation.
    const report = await this.run([
      'shell',
      'echo "N:$(ping -c1 -W1 223.5.5.5 >/dev/null 2>&1 && echo up || echo down)"; echo "W:$(settings get global wifi_on)"; echo "S:$(cmd wifi list-networks 2>/dev/null | wc -l)"',
    ])
      .then((out) => out.toString('utf8'))
      .catch(() => '');
    const value = (tag) => (new RegExp(`^${tag}:(.*)$`, 'm').exec(report)?.[1] ?? '').trim();
    this.network = {
      internet: value('N') === 'up',
      wifiOn: value('W') === '1',
      // `wc -l` counts the header line too, and a device with no saved network prints only that header.
      saved: Math.max(0, Number(value('S') || 0) - 1),
    };
    this.networkAt = now;
    return this.network;
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

  /**
   * Open the launcher's app list: tap the dock cell that worked last time, or probe the dock's unlabelled
   * cells once and remember the one that produced a grid of named tiles. Null when none of them does.
   */
  async openAppList({ observation } = {}) {
    const home = observation ?? (await this.observe());
    const homePackage = home.phone.packageName;
    const remembered = rememberedAppListPoint(this.serial);
    // The probe wants the dock, and the dock belongs to the system UI: a correct read of the launcher's own
    // window does not contain it. Read the overlay tree when the app window has no dock cells in it.
    let cells = probeCells(home);
    if (!cells.length && this.helper?.snapshot) {
      const overlay = await this.helper.snapshot().catch(() => null);
      if (overlay) cells = probeCells(this.observationFromSnapshot(overlay));
    }
    const attempts = remembered
      ? [{ point: remembered }]
      : cells.map((cell) => ({
          point: {
            x: Math.round((cell.bounds.left + cell.bounds.right) / 2),
            y: Math.round((cell.bounds.top + cell.bounds.bottom) / 2),
          },
        }));
    for (const { point } of attempts) {
      await this.run(['shell', 'input', 'tap', String(point.x), String(point.y)], true);
      await new Promise((resolve) => setTimeout(resolve, 900));
      const tiles = appListTiles(await this.observe(), { packageName: homePackage });
      if (tiles) {
        rememberAppListPoint(this.serial, point);
        return tiles;
      }
    }
    return null;
  }

  /** The app list's tiles, read once per run, with the launcher put back where it was. */
  async learnTiles({ observation } = {}) {
    if (this.tiles) return this.tiles;
    // The app list is the home app's other screen, so the probe has to start from the home app's own
    // window: a run that begins inside a settings page would otherwise learn that page's sections as
    // "apps". HOME first, then a read that is not the chrome overlay.
    await this.run(['shell', 'input', 'keyevent', '3'], true).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 900));
    const before =
      typeof this.observeDirect === 'function'
        ? await this.observeDirect()
        : (observation ?? (await this.observe()));
    this.tiles = await this.openAppList({ observation: before });
    await this.run(['shell', 'input', 'keyevent', '3'], true).catch(() => {});
    return this.tiles;
  }

  /** Open one tile of the app list: the app list is opened first, then the cell is tapped. */
  async openTile(label) {
    const home = await this.observe();
    const packageName = home.phone.packageName;
    let tiles = await this.openAppList({ observation: home });
    if (!tiles) throw new Error('The app list could not be opened.');
    let tile = tiles.find((entry) => entry.label === label);
    if (!tile) {
      // A remembered dock point can land on the list a moment before it fills.
      await new Promise((resolve) => setTimeout(resolve, 600));
      tiles = appListTiles(await this.observe(), { packageName }) ?? tiles;
      tile = tiles.find((entry) => entry.label === label);
    }
    if (!tile) throw new Error(`The app list has no ${label} tile.`);
    const x = Math.round((tile.bounds.left + tile.bounds.right) / 2);
    const y = Math.round((tile.bounds.top + tile.bounds.bottom) / 2);
    await this.run(['shell', 'input', 'tap', String(x), String(y)], true);
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
          // A tile in the launcher's app list is not a package: opening it means opening the list and
          // tapping the cell, which is what a person does and what the media sheets start with.
          if (String(resolved.packageName).startsWith('tile:'))
            return this.openTile(String(resolved.packageName).slice('tile:'.length));
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
        if (resolved.type === 'clear') return clearField(this);
        if (resolved.type === 'key')
          return this.run(['shell', 'input', 'keyevent', String(KEYS[resolved.key])], true);
        if (resolved.type === 'global') {
          const keycode = { back: 4, home: 3, recent: 187 }[resolved.name];
          return this.run(['shell', 'input', 'keyevent', String(keycode)], true);
        }
        if (resolved.type === 'type')
          return enterText(this, { text: resolved.text, clear: resolved.clear });
        throw new Error('Unsupported action type.');
      },
      (current, action) => prepareInputVerification(current, action),
    );
  }
}
