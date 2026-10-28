import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdbDevice, StaleObservationError, lastState, summarizeState } from './device.mjs';
import { createAgentDevice, deviceConfig } from './device-factory.mjs';

const xml = `UI hierchary dumped to: /dev/tty
<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][400,800]">
    <node index="0" text="Search" resource-id="com.example.app:id/search" class="android.widget.EditText" package="com.example.app" content-desc="Search field" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="true" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[20,100][380,180]" />
  </node>
</hierarchy>`;

function screen() {
  return summarizeState(
    {
      device_context: { screen_bounds: { width: 400, height: 800 } },
      phone_state: {
        packageName: 'com.example.app',
        currentApp: 'com.example.app/.MainActivity',
        keyboardVisible: true,
        isEditable: true,
      },
      a11y_tree: {
        className: 'android.widget.FrameLayout',
        boundsInScreen: { left: 0, top: 0, right: 400, bottom: 800 },
        isVisibleToUser: true,
        isEnabled: true,
        children: [
          {
            className: 'android.widget.EditText',
            text: '',
            contentDescription: 'Search field',
            resourceId: 'com.example.app:id/search',
            boundsInScreen: { left: 20, top: 100, right: 380, bottom: 180 },
            isVisibleToUser: true,
            isEnabled: true,
            isClickable: true,
            isEditable: true,
            isFocused: true,
            isPassword: false,
            children: [],
          },
        ],
      },
    },
    'emulator-5554',
  );
}

function fakeAdb({
  onCall,
  onCommand,
  sizeText = 'Physical size: 400x800\n',
  windowText = 'mCurrentFocus=Window{123 u0 com.example.app/.MainActivity}\n',
  xmlText = xml,
  screencapBytes,
} = {}) {
  const calls = [];
  const runner = async (file, args, options) => {
    calls.push({ file, args, options });
    onCall?.(args);
    const command = args.slice(2).join(' ');
    // A caller that answers one command itself keeps this fixture readable for unrelated reads.
    const answer = onCommand?.(command);
    if (answer) return [Buffer.from(answer), Buffer.alloc(0)];
    if (command === 'get-state') return [Buffer.from('device\n'), Buffer.alloc(0)];
    if (command === 'shell wm size') return [Buffer.from(sizeText), Buffer.alloc(0)];
    if (command === 'shell dumpsys window') return [Buffer.from(windowText), Buffer.alloc(0)];
    if (command === 'shell uiautomator dump /sdcard/window_dump.xml')
      return [Buffer.from('UI hierchary dumped to: /sdcard/window_dump.xml\n'), Buffer.alloc(0)];
    if (command === 'exec-out cat /sdcard/window_dump.xml')
      return [Buffer.from(xmlText), Buffer.alloc(0)];
    if (
      command ===
      'shell cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER'
    )
      return [
        Buffer.from(
          [
            '2 activities found:',
            '  Activity #0:',
            '    com.android.settings/.Settings',
            '  Activity #1:',
            '    com.android.settings/.Settings',
            '    com.example.app/.MainActivity',
          ].join('\n'),
        ),
        Buffer.alloc(0),
      ];
    if (command.includes('resolve-activity'))
      return [Buffer.from('com.example.app/.MainActivity\n'), Buffer.alloc(0)];
    if (command === 'exec-out screencap -p')
      return [screencapBytes ?? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]), Buffer.alloc(0)];
    return [Buffer.alloc(0), Buffer.alloc(0)];
  };
  return { calls, device: new AdbDevice({ serial: 'emulator-5554', execFile: runner }) };
}

test('ADB configuration requires one explicit serial', () => {
  assert.deepEqual(deviceConfig({ ADB_SERIAL: 'emulator-5554' }), {
    adbSerial: 'emulator-5554',
  });
  assert.deepEqual(deviceConfig({}, { adbSerial: 'emulator-5554' }), {
    adbSerial: 'emulator-5554',
  });
  assert.throws(() => deviceConfig({}), /serial/i);
  assert.throws(() => deviceConfig({ ADB_SERIAL: '  ' }), /serial/i);
  assert.throws(() => new AdbDevice({ serial: '  ' }), /serial/);
  assert.throws(() => new AdbDevice({ serial: 'bad serial' }), /serial/);
  assert.equal(new AdbDevice({ serial: ' emulator-5554 ' }).serial, 'emulator-5554');
  assert.ok(createAgentDevice({ adbSerial: 'emulator-5554' }) instanceof AdbDevice);
});

test('UIAutomator XML becomes a deterministic normalized observation', async () => {
  const { device, calls } = fakeAdb();
  const first = await device.observe();
  const second = await device.observe();
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.deviceId, 'emulator-5554');
  assert.equal(first.phone.packageName, 'com.example.app');
  assert.equal(first.phone.inputElementId, 'ui.0.0');
  assert.equal(first.elements[0].resourceId, 'com.example.app:id/search');
  // Five reads per observation: size, windows, dump to file, read the file back, and the keyboard window
  // while an editable field has focus. The network fact is one more, and the second observation reuses the
  // cached answer instead of repeating it.
  assert.equal(calls.length, 5 + 1 + 5);
  assert.ok(calls.every(({ options }) => options.shell === false));
});
function anonymousIcon(left, top, right, bottom) {
  return {
    className: 'android.widget.FrameLayout',
    boundsInScreen: { left, top, right, bottom },
    isVisibleToUser: true,
    isEnabled: true,
    isClickable: true,
    children: [
      {
        className: 'android.widget.ImageView',
        resourceId: 'com.android.systemui:id/media_item_icon',
        boundsInScreen: { left: left + 10, top: top + 10, right: right - 10, bottom: bottom - 10 },
        isVisibleToUser: true,
        isClickable: false,
        children: [],
      },
    ],
  };
}

test('sibling controls with no text are numbered so a choice can name one', () => {
  const state = summarizeState(
    {
      device_context: { screen_bounds: { width: 1920, height: 1080 } },
      phone_state: { packageName: 'com.android.systemui', isEditable: false },
      a11y_tree: {
        className: 'android.widget.FrameLayout',
        boundsInScreen: { left: 0, top: 0, right: 1920, bottom: 1080 },
        isVisibleToUser: true,
        children: [
          {
            className: 'androidx.recyclerview.widget.RecyclerView',
            resourceId: 'com.android.systemui:id/rv_action_list',
            boundsInScreen: { left: 420, top: 992, right: 642, bottom: 1080 },
            isVisibleToUser: true,
            children: [anonymousIcon(420, 992, 516, 1080), anonymousIcon(516, 992, 642, 1080)],
          },
          anonymousIcon(650, 992, 766, 1080),
          {
            className: 'android.widget.TextView',
            text: 'Pause',
            boundsInScreen: { left: 800, top: 992, right: 900, bottom: 1080 },
            isVisibleToUser: true,
            isClickable: true,
            children: [],
          },
          {
            className: 'android.widget.FrameLayout',
            resourceId: 'com.android.systemui:id/rv_drag_List',
            boundsInScreen: { left: 0, top: 990, right: 1920, bottom: 1080 },
            isVisibleToUser: true,
            children: [
              anonymousIcon(8, 992, 96, 1080),
              anonymousIcon(650, 992, 766, 1080),
              // A named sibling means the row is not an icon row: numbering it would name the wrong
              // control, which is how the dock's volume and climate buttons got names they did not own.
              {
                className: 'android.widget.RelativeLayout',
                boundsInScreen: { left: 100, top: 992, right: 646, bottom: 1080 },
                isVisibleToUser: true,
                isClickable: true,
                children: [
                  {
                    className: 'android.widget.TextView',
                    text: '童话',
                    boundsInScreen: { left: 203, top: 1013, right: 415, bottom: 1042 },
                    isVisibleToUser: true,
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
    'emulator-5554',
  );
  const byId = Object.fromEntries(state.elements.map((e) => [e.id, e]));
  assert.equal(byId['ui.0.0'].nested, '1 of 2 in rv_action_list');
  assert.equal(byId['ui.0.1'].nested, '2 of 2 in rv_action_list');
  // A lone unnamed icon is unambiguous, and a labelled control keeps its own text.
  assert.equal(byId['ui.1'].nested, undefined);
  assert.equal(byId['ui.2'].text, 'Pause');
  assert.equal(byId['ui.2'].nested, undefined);
  // Different-sized siblings are already distinguishable, so they stay unnamed.
  assert.equal(byId['ui.3.0'].nested, undefined);
  assert.equal(byId['ui.3.1'].nested, undefined);
});

test('ADB uses current landscape display bounds for coordinates and input', async () => {
  const landscapeXml = xml.replace('[0,0][400,800]', '[0,0][1920,1080]');
  const { device, calls } = fakeAdb({
    sizeText: 'Physical size: 1080x2400\n',
    windowText:
      'Display: mDisplayId=0\n  init=1080x2400 cur=1920x1080 app=1920x1080\nmCurrentFocus=Window{123 u0 com.example.app/.MainActivity}\n',
    xmlText: landscapeXml,
  });
  const observed = await device.observe();
  assert.deepEqual(observed.screen, { width: 1920, height: 1080 });
  await device.act({ type: 'tap', x: 1900, y: 1000 }, { expected: observed });
  assert.deepEqual(calls.at(-1).args.slice(2), ['shell', 'input', 'tap', '1900', '1000']);
});

test('ADB prefers cur over the smaller app viewport across several displays', async () => {
  const { device } = fakeAdb({
    sizeText: 'Physical size: 2560x1440\n',
    windowText: [
      '  Display: mDisplayId=4',
      '    init=2560x1440 cur=2560x1440 app=2560x1440',
      '  Display: mDisplayId=2',
      '    init=1920x720 cur=1920x720 app=1920x720',
      '  Display: mDisplayId=0',
      '    init=2560x1440 cur=2560x1440 app=2560x1312',
      'mCurrentFocus=Window{123 u0 com.example.app/.MainActivity}',
      '',
    ].join('\n'),
    xmlText: xml.replace('[0,0][400,800]', '[0,0][2560,1440]'),
  });
  assert.deepEqual((await device.observe()).screen, { width: 2560, height: 1440 });
});

test('ADB uses wm size only when it matches UIAutomator bounds', async () => {
  const { device } = fakeAdb();
  assert.deepEqual((await device.observe()).screen, { width: 400, height: 800 });

  const { device: rotated } = fakeAdb({
    sizeText: 'Physical size: 1080x2400\n',
    xmlText: xml.replace('[0,0][400,800]', '[0,0][1920,1080]'),
  });
  await assert.rejects(rotated.observe(), /bounds/);
});

test('ADB screenshot subprocess has a finite timeout', async () => {
  const { device, calls } = fakeAdb();
  await device.screenshot();
  assert.equal(calls.at(-1).options.timeout, 5_000);
});

test('ADB screenshot drops adb warnings printed before the PNG', async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]);
  const { device } = fakeAdb({
    screencapBytes: Buffer.concat([Buffer.from('[Warning] Multiple displays were found.\n'), png]),
  });
  assert.deepEqual(await device.screenshot(), png);
});

test('malformed UIAutomator XML fails as an ordinary read error', async () => {
  const { device } = fakeAdb({
    onCall: (args) => {
      if (args.includes('uiautomator')) throw new Error('fixture');
    },
  });
  await assert.rejects(device.observe(), /ADB read failed/);
});

test('ADB actions use fixed argv payloads and return input verification receipts', async () => {
  const { device, calls } = fakeAdb();
  const expected = screen();
  device.observe = async () => expected;
  await device.assertReady();
  calls.length = 0;
  const receipt = await device.act(
    { type: 'type', text: 'San Francisco', clear: true },
    { expected },
  );
  assert.equal(receipt.inputVerification.text, 'San Francisco');
  assert.equal(receipt.inputTier, 'input');
  assert.deepEqual(
    calls.map(({ args }) => args),
    [
      ['-s', 'emulator-5554', 'shell', 'input', 'keyevent', '123'],
      ['-s', 'emulator-5554', 'shell', 'input', 'keyevent', ...Array(40).fill('67')],
      ['-s', 'emulator-5554', 'shell', 'input', 'text', 'San%sFrancisco'],
    ],
  );
  assert.ok(calls.every(({ options }) => options.shell === false));
});

test('ADB mutation argv shapes cover tap, swipe, clear, key, and global', async () => {
  const { device, calls } = fakeAdb();
  const expected = screen();
  device.observe = async () => expected;
  await device.assertReady();
  calls.length = 0;
  await device.act({ type: 'tap', x: 10, y: 20 }, { expected });
  await device.act(
    { type: 'swipe', startX: 1, startY: 2, endX: 3, endY: 4, duration: 300 },
    { expected },
  );
  await device.act({ type: 'clear' }, { expected });
  await device.act({ type: 'key', key: 'enter' }, { expected });
  await device.act({ type: 'global', name: 'back' }, { expected });
  assert.deepEqual(
    calls.map(({ args }) => args.slice(2)),
    [
      ['shell', 'input', 'tap', '10', '20'],
      ['shell', 'input', 'swipe', '1', '2', '3', '4', '300'],
      // Clear is backspace from the end of the line, forty times: the Sogou IME ignores Ctrl+A, so a
      // selection-based clear left the text in place on the navi search box.
      ['shell', 'input', 'keyevent', '123'],
      ['shell', 'input', 'keyevent', ...Array(40).fill('67')],
      ['shell', 'input', 'keyevent', '66'],
      ['shell', 'input', 'keyevent', '4'],
    ],
  );
});

test('ADB stale observations are rejected before any mutation', async () => {
  const { device, calls } = fakeAdb();
  await device.assertReady();
  const expected = screen();
  device.observe = async () => ({ ...expected, fingerprint: 'changed' });
  calls.length = 0;
  await assert.rejects(
    device.act({ type: 'tap', x: 10, y: 10 }, { expected }),
    StaleObservationError,
  );
  assert.equal(calls.length, 0);
});

test('an uncertain ADB mutation fails once and is not replayed', async () => {
  let dispatches = 0;
  const { device, calls } = fakeAdb({
    onCall: (args) => {
      if (args.includes('input')) {
        dispatches++;
        throw new Error('subprocess failed');
      }
    },
  });
  const expected = screen();
  device.observe = async () => expected;
  await device.assertReady();
  calls.length = 0;
  const error = await device
    .act({ type: 'tap', x: 10, y: 10 }, { expected })
    .catch((value) => value);
  assert.match(error.message, /uncertain/);
  assert.doesNotMatch(error.message, /Stale/);
  assert.equal(dispatches, 1);
});

test('ADB readiness, screenshots, app inventory, and launch use argv-only commands', async () => {
  const { device, calls } = fakeAdb();
  assert.deepEqual(await device.assertReady(), {
    id: 'emulator-5554',
    name: 'emulator-5554',
    state: 'ready',
  });
  assert.equal((await device.screenshot()).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.deepEqual(await device.listApps(), [
    { packageName: 'com.android.settings', label: 'Settings' },
    { packageName: 'com.example.app', label: 'App' },
  ]);
  await device.act({ type: 'open-app', packageName: 'com.example.app' });
  assert.deepEqual(calls.at(-2).args.slice(2), [
    'shell',
    'cmd',
    'package',
    'resolve-activity',
    '--brief',
    '-a',
    'android.intent.action.MAIN',
    '-c',
    'android.intent.category.LAUNCHER',
    'com.example.app',
  ]);
  assert.deepEqual(calls.at(-1).args.slice(2), [
    'shell',
    'am',
    'start',
    '-n',
    'com.example.app/.MainActivity',
  ]);
  assert.ok(calls.every(({ options }) => options.shell === false));
});

test('text no tier can carry falls back to pinyin, and fails only when that spells nothing', async () => {
  const { device, calls } = fakeAdb();
  const expected = screen();
  device.observe = async () => expected;
  await device.assertReady();
  calls.length = 0;
  // No helper, no ADBKeyboard, no yadb left on this device: a Chinese IME can still be typed at as
  // pinyin, which is what a person does.
  const spelled = await device.act({ type: 'type', text: '充电站', clear: false }, { expected });
  // The trace has to say how the text arrived, not only that it did.
  assert.equal(spelled.inputTier, 'pinyin');
  assert.equal(
    calls.filter((call) => call.args.join(' ').includes('input text chongdianzhan')).length,
    1,
  );
  // An accent is not Chinese text, but its ASCII spelling is what a keyboard would produce.
  await device.act({ type: 'type', text: 'café', clear: false }, { expected });
  assert.equal(calls.filter((call) => call.args.join(' ').includes('input text cafe')).length, 1);
  // Nothing ASCII survives this, so no tier can carry it and the run must say so.
  calls.length = 0;
  await assert.rejects(
    device.act({ type: 'type', text: '⚡⚡', clear: false }, { expected }),
    /none of them could take it|has none of them/,
  );
  assert.equal(calls.filter((call) => call.args.join(' ').includes('input text')).length, 0);
});

test('long press, double tap, drag and the notification shade dispatch one clear argv each', async () => {
  const { device, calls } = fakeAdb();
  const expected = screen();
  device.observe = async () => expected;
  await device.assertReady();
  calls.length = 0;
  const elementId = expected.elements.find((e) => e.clickable).id;
  const centre = expected.elements.find((e) => e.id === elementId).bounds;

  await device.act({ type: 'long-press', elementId }, { expected });
  await device.act({ type: 'long-press', elementId, duration: 3000 }, { expected });
  await device.act({ type: 'double-tap', elementId }, { expected });
  await device.act({ type: 'drag', elementId, direction: 'LEFT' }, { expected });
  await device.act({ type: 'statusbar', view: 'notifications' }, { expected });
  await device.act({ type: 'statusbar', view: 'settings' }, { expected });
  await device.act({ type: 'statusbar', view: 'collapse' }, { expected });

  const commands = calls.map((call) => call.args.slice(2).join(' '));
  const x = Math.floor((centre.left + centre.right) / 2);
  const y = Math.floor((centre.top + centre.bottom) / 2);
  // A hold is a zero-length swipe, so the touch stays down for its duration.
  assert.ok(commands.includes(`shell input swipe ${x} ${y} ${x} ${y} 600`));
  // An asked-for duration is honoured: this car's screen-cleaning mode ignores a 600 ms hold.
  assert.ok(commands.includes(`shell input swipe ${x} ${y} ${x} ${y} 3000`));
  assert.equal(commands.filter((command) => command === `shell input tap ${x} ${y}`).length, 2);
  // A drag presses, waits, then moves; a swipe would be read as a fling.
  assert.ok(commands.some((command) => command.startsWith('shell input draganddrop ')));
  assert.ok(commands.includes('shell cmd statusbar expand-notifications'));
  assert.ok(commands.includes('shell cmd statusbar expand-settings'));
  assert.ok(commands.includes('shell cmd statusbar collapse'));
});

test('a drag between two points uses draganddrop, not a fling', async () => {
  const { device, calls } = fakeAdb();
  const expected = screen();
  device.observe = async () => expected;
  await device.assertReady();
  calls.length = 0;
  await device.act({ type: 'drag', from: { x: 40, y: 300 }, to: { x: 320, y: 300 } }, { expected });
  assert.deepEqual(
    calls.map((call) => call.args.slice(2).join(' ')),
    ['shell input draganddrop 40 300 320 300 600'],
  );
});

test('text an IME would produce goes through the helper clipboard, then paste', async () => {
  const { device, calls } = fakeAdb();
  const expected = screen();
  device.observe = async () => expected;
  await device.assertReady();
  const sent = [];
  device.helper = {
    available: async () => true,
    action: async (payload) => {
      sent.push(payload);
      return payload.cmd !== 'clear';
    },
  };
  await device.act({ type: 'type', text: '充电站', clear: false }, { expected });
  // One clipboard write, then KEYCODE_PASTE: the IME never sees the text, so any script arrives as
  // one commit, and `input text` never sees a character it cannot spell.
  assert.deepEqual(sent, [{ cmd: 'clipboard', text: '充电站' }]);
  assert.equal(
    calls.filter((call) => call.args.join(' ').includes('shell input keyevent 279')).length,
    1,
  );
  assert.equal(calls.filter((call) => call.args.join(' ').includes('input text')).length, 0);
  // A clear first goes through the helper; when it refuses, keys are the fallback.
  calls.length = 0;
  sent.length = 0;
  await device.act({ type: 'type', text: '星海广场', clear: true }, { expected });
  assert.deepEqual(
    sent.map((payload) => payload.cmd),
    ['clear', 'clipboard'],
  );
  // Clear is the key sweep, not a long press: the IME ignores selection-based clearing.
  assert.equal(calls.filter((call) => call.args.join(' ').includes('keyevent 123')).length, 1);
  // ASCII still takes the shell path: no clipboard write, no paste.
  calls.length = 0;
  sent.length = 0;
  await device.act({ type: 'type', text: 'San Francisco', clear: false }, { expected });
  assert.deepEqual(sent, []);
  assert.equal(
    calls.filter((call) => call.args.join(' ').includes('input text San%sFrancisco')).length,
    1,
  );
});

test('ADBKeyboard is the fallback when the helper cannot take the text', async () => {
  const { device, calls } = fakeAdb();
  const expected = screen();
  device.observe = async () => expected;
  await device.assertReady();
  // Installed and active, with the helper either absent or refusing.
  device.run = async (args, mutation) => {
    const command = args.join(' ');
    calls.push({ args });
    if (command.includes('pm list packages'))
      return Buffer.from('package:com.android.adbkeyboard\n');
    if (command.includes('default_input_method'))
      return Buffer.from('com.android.adbkeyboard/.AdbIME\n');
    return args.length && mutation ? Buffer.alloc(0) : Buffer.alloc(0);
  };
  await device.act({ type: 'type', text: '充电站', clear: false }, { expected });
  const broadcast = calls.find((call) => call.args.join(' ').includes('ADB_INPUT_B64'));
  assert.ok(broadcast, 'the base64 broadcast was sent');
  assert.ok(
    broadcast.args.join(' ').includes(Buffer.from('充电站', 'utf8').toString('base64')),
    'UTF-8 encoded, so the shell never sees the characters',
  );
});

test('a cell named by a label inside it is tapped at the label, not the cell', async () => {
  // The navi toolbar on 282999b1: an 88x88 cell whose 36x26 label sits in the middle of its own cell.
  const toolbar = (containerTop, labelTop) => ({
    device_context: { screen_bounds: { width: 1920, height: 1080 } },
    phone_state: { packageName: 'com.sgmw.navi', currentApp: 'com.sgmw.navi/.Main' },
    a11y_tree: {
      children: [
        {
          isClickable: true,
          isEnabled: true,
          boundsInScreen: { left: 301, top: containerTop, right: 389, bottom: containerTop + 88 },
          children: [
            {
              text: '全览',
              boundsInScreen: { left: 327, top: labelTop, right: 363, bottom: labelTop + 26 },
            },
          ],
        },
      ],
    },
  });
  const container = summarizeState(toolbar(824, 880), 'phone').elements[0];
  assert.equal(container.nested, '全览');
  assert.deepEqual(container.nameBox, { left: 327, top: 880, right: 363, bottom: 906 });

  const { device, calls } = fakeAdb();
  const expected = summarizeState(toolbar(824, 880), 'phone');
  device.observe = async () => expected;
  await device.assertReady();
  calls.length = 0;
  await device.act({ type: 'tap-element', elementId: container.id }, { expected });
  const argv = calls.at(-1).args.join(' ');
  // Cell centre would be 345,868; the glyph is at 345,893.
  assert.match(argv, /shell input tap 345 893$/);

  // A row whose label fills it keeps the row's own centre: nothing moves.
  const row = summarizeState(
    {
      device_context: { screen_bounds: { width: 1920, height: 1080 } },
      phone_state: { packageName: 'com.sgmw.systemsettings', currentApp: 'settings/.Home' },
      a11y_tree: {
        children: [
          {
            isClickable: true,
            isEnabled: true,
            boundsInScreen: { left: 100, top: 200, right: 900, bottom: 280 },
            children: [
              { text: '显示', boundsInScreen: { left: 100, top: 200, right: 900, bottom: 280 } },
            ],
          },
        ],
      },
    },
    'phone',
  );
  const rowElement = row.elements[0];
  assert.equal(rowElement.nameBox, undefined, 'a label the size of its row adds no aim box');
  device.observe = async () => row;
  calls.length = 0;
  await device.act({ type: 'tap-element', elementId: rowElement.id }, { expected: row });
  assert.match(calls.at(-1).args.join(' '), /shell input tap 500 240$/);
});

function controlCell(name, box, badge) {
  return {
    className: 'android.widget.RelativeLayout',
    boundsInScreen: box,
    isVisibleToUser: true,
    isClickable: true,
    children: [
      {
        className: 'android.widget.TextView',
        text: name,
        boundsInScreen: {
          left: box.left + 20,
          top: box.top + 120,
          right: box.right - 20,
          bottom: box.bottom - 60,
        },
        isVisibleToUser: true,
        children: [],
      },
      {
        className: 'android.widget.ImageView',
        boundsInScreen: badge,
        isVisibleToUser: true,
        isClickable: true,
        children: [],
      },
    ],
  };
}

test('a nameless badge on a named cell is named by that cell and its corner', () => {
  const state = summarizeState(
    {
      device_context: { screen_bounds: { width: 1920, height: 1080 } },
      phone_state: { packageName: 'com.android.systemui', isEditable: false },
      a11y_tree: {
        className: 'android.widget.GridLayout',
        boundsInScreen: { left: 239, top: 121, right: 1681, bottom: 735 },
        isVisibleToUser: true,
        children: [
          controlCell(
            '开启尾门',
            { left: 649, top: 121, right: 853, bottom: 326 },
            { left: 822, top: 121, right: 853, bottom: 152 },
          ),
          controlCell(
            'EPB;EPB电子驻车系统;打开EPB',
            { left: 853, top: 121, right: 1058, bottom: 326 },
            { left: 1027, top: 121, right: 1058, bottom: 152 },
          ),
        ],
      },
    },
    'emulator-5554',
  );
  const byId = Object.fromEntries(state.elements.map((e) => [e.id, e]));
  // The badge itself: named after the cell, so a choice can offer it instead of the cell underneath.
  assert.equal(byId['ui.0.1'].nested, '开启尾门 的右上角按钮');
  // Only the first entry of a cell's semicolon list becomes part of the name.
  assert.equal(byId['ui.1.1'].nested, 'EPB 的右上角按钮');
  // The cell keeps the name it already had, and is not mistaken for a badge.
  assert.equal(byId['ui.0'].nested, '开启尾门');
});

test('two unnamed rows that share a container name get different names', () => {
  const row = (top, left) => ({
    className: 'android.widget.FrameLayout',
    boundsInScreen: { left, top, right: left + 400, bottom: top + 88 },
    isVisibleToUser: true,
    children: [
      anonymousIcon(left, top, left + 96, top + 88),
      anonymousIcon(left + 96, top, left + 192, top + 88),
    ],
  });
  const state = summarizeState(
    {
      device_context: { screen_bounds: { width: 1920, height: 1080 } },
      phone_state: { packageName: 'com.example.app', isEditable: false },
      a11y_tree: {
        className: 'android.widget.ScrollView',
        boundsInScreen: { left: 0, top: 0, right: 1920, bottom: 1080 },
        isVisibleToUser: true,
        children: [row(100, 0), row(300, 0)],
      },
    },
    'emulator-5554',
  );
  const byId = Object.fromEntries(state.elements.map((e) => [e.id, e]));
  assert.equal(byId['ui.0.0'].nested, '1 of 2 in FrameLayout');
  assert.equal(byId['ui.1.0'].nested, '1 of 2 in FrameLayout#2');
  assert.equal(byId['ui.1.1'].nested, '2 of 2 in FrameLayout#2');
});

test('a run that dies mid-way records the screen it left, or says the screen is unreadable', async () => {
  const { device } = fakeAdb();
  device.observe = async () => screen();
  const read = await lastState(device);
  assert.equal(read.packageName, 'com.example.app');
  assert.ok(read.fingerprint);
  assert.ok(read.elements > 0);
  device.observe = async () => {
    throw new Error('ADB read failed');
  };
  assert.deepEqual(await lastState(device), { unreadable: 'ADB read failed' });
});

test('the network fact is read from the device, and reused until it can have changed', async () => {
  const { device, calls } = fakeAdb({
    onCommand: (command) => {
      if (command.includes('ping')) return 'N:up\nW:1\nS:3\n';
      return undefined;
    },
  });
  const state = await device.networkState();
  assert.deepEqual(state, { internet: true, wifiOn: true, saved: 2 });
  const reads = calls.length;
  await device.networkState();
  assert.equal(calls.length, reads);
});

test('a device with no internet and no saved network says so, so the run can name the cause', async () => {
  const { device } = fakeAdb({
    onCommand: (command) => {
      if (command.includes('ping')) return 'N:down\nW:0\nS:1\n';
      return undefined;
    },
  });
  assert.deepEqual(await device.networkState(), { internet: false, wifiOn: false, saved: 0 });
});

test('HELPER_PORT pins the helper tunnel, and a bad value is refused at config time', () => {
  assert.deepEqual(deviceConfig({ ADB_SERIAL: 'emulator-5554', HELPER_PORT: '18888' }), {
    adbSerial: 'emulator-5554',
    helperPort: 18888,
  });
  assert.deepEqual(deviceConfig({ ADB_SERIAL: 'emulator-5554', HELPER_PORT: '' }), {
    adbSerial: 'emulator-5554',
  });
  assert.throws(
    () => deviceConfig({ ADB_SERIAL: 'emulator-5554', HELPER_PORT: '70000' }),
    /between 1 and 65535/,
  );
});

test('the keyboard window’s own buttons are not offered as tap targets', async () => {
  // The Sogou toolbar sits at y 452-536 while the search field has focus; it is three unnamed buttons.
  const keyboard = [
    '  Window #10 Window{84bbad9 u0 InputMethod}:',
    '    mIsImWindow=true mIsFloatingLayer=true',
    '    touchable region=SkRegion((0,452,1920,992))',
    '    frame=[0,80][1920,1080] isOnScreen=true',
    '    isVisible=true',
  ].join('\n');
  const node = (attrs) => `<node ${attrs} />`;
  const xmlText = [
    'UI hierchary dumped to: /dev/tty',
    "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>",
    '<hierarchy rotation="0">',
    node(
      'index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][400,800]"',
    ),
    node(
      'index="0" text="重庆" resource-id="com.example.app:id/search" class="android.widget.EditText" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="true" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[20,100][380,180]"',
    ),
    node(
      'index="1" text="" resource-id="" class="android.widget.ViewGroup" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,452][274,536]"',
    ),
    '</hierarchy>',
  ].join('\n');
  const { device, calls } = fakeAdb({
    xmlText,
    onCommand: (command) => (command === 'shell dumpsys window windows' ? keyboard : undefined),
  });
  const observation = await device.observe();
  // The field above the keyboard survives; the toolbar button inside it does not.
  assert.ok(
    observation.elements.some((element) => element.resourceId === 'com.example.app:id/search'),
  );
  assert.ok(
    !observation.elements.some(
      (element) => element.bounds.top === 452 && element.bounds.bottom === 536,
    ),
  );
  assert.deepEqual(observation.keyboardRegion, { left: 0, top: 452, right: 1920, bottom: 992 });
  assert.ok(calls.some(({ args }) => args.join(' ').endsWith('shell dumpsys window windows')));
});
