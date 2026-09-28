import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdbDevice, StaleObservationError, summarizeState } from './device.mjs';
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
    if (command === 'get-state') return [Buffer.from('device\n'), Buffer.alloc(0)];
    if (command === 'shell wm size') return [Buffer.from(sizeText), Buffer.alloc(0)];
    if (command === 'shell dumpsys window') return [Buffer.from(windowText), Buffer.alloc(0)];
    if (command === 'exec-out uiautomator dump /dev/tty')
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

test('ADB configuration is explicit, defaults to Mobilerun, and rejects unsupported backends', () => {
  assert.deepEqual(deviceConfig({}), { backend: 'mobilerun' });
  assert.deepEqual(deviceConfig({ JEV_DEVICE_BACKEND: 'adb', ADB_SERIAL: 'emulator-5554' }), {
    backend: 'adb',
    adbSerial: 'emulator-5554',
  });
  assert.throws(() => deviceConfig({ JEV_DEVICE_BACKEND: 'adb' }), /serial/i);
  assert.throws(() => deviceConfig({ JEV_DEVICE_BACKEND: 'usb' }), /mobilerun or adb/);
  assert.throws(() => new AdbDevice({ serial: '  ' }), /serial/);
  assert.throws(() => new AdbDevice({ serial: 'bad serial' }), /serial/);
  assert.equal(new AdbDevice({ serial: ' emulator-5554 ' }).serial, 'emulator-5554');
  assert.ok(createAgentDevice({ backend: 'adb', adbSerial: 'emulator-5554' }) instanceof AdbDevice);
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
  assert.equal(calls.length, 6);
  assert.ok(calls.every(({ options }) => options.shell === false));
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
  assert.deepEqual(
    calls.map(({ args }) => args),
    [
      ['-s', 'emulator-5554', 'shell', 'input', 'keyevent', '--longpress', '67'],
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
      ['shell', 'input', 'keyevent', '--longpress', '67'],
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

test('ADB rejects unsupported text before dispatch', async () => {
  const { device, calls } = fakeAdb();
  const expected = screen();
  device.observe = async () => expected;
  await device.assertReady();
  calls.length = 0;
  await assert.rejects(
    device.act({ type: 'type', text: 'café', clear: false }, { expected }),
    /supports only/,
  );
  assert.equal(calls.length, 0);
});
