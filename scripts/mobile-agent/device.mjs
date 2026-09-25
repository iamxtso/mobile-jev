import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { curlRequest, decodeJson } from './http.mjs';
import { prepareInputVerification } from './input-verification.mjs';

export const GLOBAL_ACTIONS = { back: 1, home: 2, recent: 3 };
export const KEYS = { back: 4, tab: 61, enter: 66, delete: 67, forward_delete: 112 };

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
  if (action.type === 'tap-element') {
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
        elements.push({
          id: path,
          text,
          label,
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

export class MobilerunDevice {
  constructor({
    apiKey = process.env.MOBILERUN_API_KEY || process.env.MOBILERUN_CLOUD_API_KEY,
    deviceId = process.env.MOBILERUN_DEVICE_ID,
    baseUrl = process.env.MOBILERUN_BASE_URL || 'https://api.mobilerun.ai/v1',
    textCompletionMode = process.env.MOBILERUN_TEXT_COMPLETION_MODE || 'accepted',
    request = curlRequest,
  } = {}) {
    this.apiKey = apiKey;
    this.deviceId = deviceId;
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new Error('MOBILERUN_BASE_URL must be an HTTPS API base URL.');
    this.baseUrl = url.href.replace(/\/$/, '');
    this.request = request;
    if (!['accepted', 'committed'].includes(textCompletionMode))
      throw new Error('Text completion mode must be accepted or committed.');
    this.textCompletionMode = textCompletionMode;
    this.readyAt = -Infinity;
    this.installedApps = [];
  }

  async api(path, method = 'GET', body, binary = false) {
    const bytes = await this.request({
      url: `${this.baseUrl}${path}`,
      apiKey: this.apiKey,
      method,
      body,
    });
    return binary ? bytes : decodeJson(bytes);
  }

  path(suffix = '') {
    if (!this.deviceId)
      throw new Error('Set MOBILERUN_DEVICE_ID or pass --device. Use devices to list IDs.');
    return `/devices/${encodeURIComponent(this.deviceId)}${suffix}`;
  }

  async listDevices() {
    const devices = [];
    for (let page = 1; page <= 1000; page++) {
      const result = await this.api(`/devices?page=${page}&pageSize=100`);
      if (!Array.isArray(result?.items)) throw new Error('Invalid device list response.');
      devices.push(...result.items.map(({ id, name, state }) => ({ id, name, state })));
      if (result.items.length < 100) return devices;
    }
    throw new Error('Device pagination exceeded 1000 pages.');
  }

  async listApps() {
    const result = await this.api(this.path('/apps?includeSystemApps=true'));
    if (!Array.isArray(result)) throw new Error('Invalid installed-app response.');
    this.installedApps = result
      .filter((app) => typeof app.packageName === 'string' && typeof app.label === 'string')
      .map(({ packageName, label }) => ({ packageName, label }));
    return this.installedApps;
  }

  async assertReady() {
    const device = await this.api(this.path());
    if (device?.state !== 'ready')
      throw new Error(`Device is ${device?.state || 'unknown'}; it must be ready.`);
    this.readyAt = performance.now();
    return { id: device.id, name: device.name, state: device.state };
  }

  async observe() {
    // Keep noninteractive text: it is evidence for goal completion and control labels.
    return summarizeState(await this.api(this.path('/ui-state?filter=false')), this.deviceId);
  }

  async screenshot() {
    const bytes = await this.api(this.path('/screenshot?hideOverlay=true'), 'GET', undefined, true);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new Error('Screenshot response is not a PNG.');
    return bytes;
  }

  async act(action, { expected, maxAgeMs = 30_000 } = {}) {
    return resolveAction(
      this,
      action,
      { expected, maxAgeMs },
      async (resolved) => {
        switch (resolved.type) {
          case 'open-app':
            await this.api(
              this.path(`/apps/${encodeURIComponent(resolved.packageName)}`),
              'PUT',
              {},
            );
            return;
          case 'tap':
            await this.api(this.path('/tap'), 'POST', { x: resolved.x, y: resolved.y });
            return;
          case 'swipe': {
            const body = {
              startX: resolved.startX,
              startY: resolved.startY,
              endX: resolved.endX,
              endY: resolved.endY,
              duration: resolved.duration,
            };
            await this.api(this.path('/swipe'), 'POST', body);
            return;
          }
          case 'type': {
            const accepted =
              this.textCompletionMode === 'accepted' && Boolean(resolved.inputVerification);
            await this.api(this.path('/keyboard'), 'POST', {
              text: resolved.text,
              clear: resolved.clear,
              completionMode: accepted ? 'accepted' : 'committed',
            });
            return;
          }
          case 'clear':
            await this.api(this.path('/keyboard'), 'DELETE');
            return;
          case 'key':
            await this.api(this.path('/keyboard'), 'PUT', { key: KEYS[resolved.key] });
            return;
          case 'global':
            await this.api(this.path('/global'), 'POST', { action: GLOBAL_ACTIONS[resolved.name] });
            return;
          default:
            throw new Error('Unsupported action type.');
        }
      },
      (current, action) =>
        this.textCompletionMode === 'accepted' ? prepareInputVerification(current, action) : null,
    );
  }
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

  const section = selected || displaySections[0];
  const values = [
    ...(section || '').matchAll(/\b(?:current|cur|app)\s*(?:=|:)\s*(\d+)\s*[xX]\s*(\d+)/gi),
  ].map((match) => ({ width: Number(match[1]), height: Number(match[2]) }));
  const unique = new Map(values.map((value) => [`${value.width}x${value.height}`, value]));
  if (unique.size > 1)
    throw new Error('ADB dumpsys window returned ambiguous current display bounds.');
  if (unique.size === 0) return null;
  const size = [...unique.values()][0];
  if (
    !Number.isSafeInteger(size.width) ||
    size.width < 1 ||
    !Number.isSafeInteger(size.height) ||
    size.height < 1
  )
    throw new Error('ADB dumpsys window returned invalid current display bounds.');
  return size;
}

function wmDisplaySize(sizeText) {
  const match =
    sizeText.match(/Override size:\s*(\d+)\s*[xX]\s*(\d+)/) ||
    sizeText.match(/Physical size:\s*(\d+)\s*[xX]\s*(\d+)/);
  return match ? parseDisplaySize(match[0], 'screen') : null;
}

function assertTreeFitsScreen(tree, size) {
  const root = tree.boundsInScreen || tree.children?.[0]?.boundsInScreen;
  if (
    !root ||
    root.left !== 0 ||
    root.top !== 0 ||
    root.right !== size.width ||
    root.bottom !== size.height
  )
    throw new Error('ADB UIAutomator bounds do not match the current display bounds.');
  const visit = (node) => {
    for (const child of node.children || []) {
      if (
        child.boundsInScreen &&
        (child.boundsInScreen.right > size.width || child.boundsInScreen.bottom > size.height)
      )
        throw new Error('ADB UIAutomator bounds exceed the current display bounds.');
      visit(child);
    }
  };
  visit(tree);
}

export class AdbDevice {
  constructor({ serial, adbPath = 'adb', execFile: runner = execFileAsync } = {}) {
    if (typeof serial !== 'string' || !/^[A-Za-z0-9._:-]+$/.test(serial.trim()))
      throw new Error('ADB mode requires one explicit serial using letters, numbers, . _ : or -.');
    this.serial = serial.trim();
    this.deviceId = this.serial;
    this.adbPath = adbPath;
    this.execFile = runner;
    this.readyAt = -Infinity;
    this.installedApps = [];
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
      throw new Error(
        error?.code === 'ENOENT'
          ? 'Could not run adb. Install Android platform-tools and retry.'
          : 'ADB read failed. Check the explicit serial and device connection.',
      );
    }
  }

  async assertReady() {
    const state = (await this.run(['get-state'])).toString('utf8').trim();
    if (state !== 'device') throw new Error(`ADB device is ${state || 'unavailable'}.`);
    this.readyAt = performance.now();
    return { id: this.serial, name: this.serial, state: 'ready' };
  }

  async observe() {
    const [sizeOutput, windowOutput, xmlOutput] = await Promise.all([
      this.run(['shell', 'wm', 'size']),
      this.run(['shell', 'dumpsys', 'window']),
      this.run(['exec-out', 'uiautomator', 'dump', '/dev/tty']),
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

  async listApps() {
    const output = (await this.run(['shell', 'pm', 'list', 'packages'])).toString('utf8');
    const packageNames = output
      .split(/\r?\n/)
      .map((line) => line.match(/^package:(.+)$/)?.[1])
      .filter(Boolean);
    if (!packageNames.length) throw new Error('ADB returned an empty app inventory.');
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
    const bytes = await this.run(['exec-out', 'screencap', '-p'], false, { timeout: 5_000 });
    if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE))
      throw new Error('ADB screenshot is not a PNG.');
    return bytes;
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
