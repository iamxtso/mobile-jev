import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HelperClient, DEVICE_PORT, SERVICE_NAME, TOKEN_ACTION } from './helper.mjs';

const snapshotAnswer = {
  success: true,
  xml: '<?xml version="1.0"?><hierarchy rotation="0"></hierarchy>',
  has_screenshot: true,
  screenshot_base64: 'AAAA',
  width: 1080,
  height: 2400,
  package: 'com.example.app',
  activity: 'com.example.app/.Main',
  node_count: 12,
};

function fakeAdb({
  installed = true,
  versionCode = 6,
  enabled = '',
  forwards = '',
  port = '41234',
  installFailure,
  onCommand,
} = {}) {
  const calls = [];
  const execFile = async (file, args) => {
    const command = args.slice(2).join(' ');
    calls.push(command);
    const override = onCommand?.(command);
    if (override) return override;
    if (command.startsWith('shell dumpsys package'))
      return [
        installed
          ? `versionCode=${versionCode} targetSdk=34\n`
          : 'Unable to find package: com.artemis.helper\n',
        '',
      ];
    if (command.startsWith('install ') || command.startsWith('shell pm install')) {
      // The forced install is the ROM's own path and is expected to succeed where the plain one failed.
      if (installFailure && !command.includes('--install-force')) {
        const error = new Error('Command failed');
        error.stdout = installFailure;
        throw error;
      }
      return ['Success\n', ''];
    }
    if (command.startsWith('push ')) return ['1 file pushed\n', ''];
    if (command.startsWith('shell pm caninstall'))
      return ['Success: package can be installed\n', ''];
    if (command.startsWith('shell settings get secure enabled_accessibility_services'))
      return [`${enabled}\n`, ''];
    if (command === 'forward --list') return [forwards, ''];
    // `forward tcp:0 …` lets adb choose; a pinned port comes through as `forward tcp:18888 …`.
    if (/^forward tcp:\d+ tcp:\d+$/.test(command)) {
      const local = command.split(' ')[1].slice(4);
      return [`${local === '0' ? port : local}\n`, ''];
    }
    return ['', ''];
  };
  return { execFile, calls, installed };
}

test('a snapshot carries the tree and the image from one request', async () => {
  const { execFile, calls } = fakeAdb({ enabled: SERVICE_NAME, port: '41234' });
  const client = new HelperClient({ serial: 'emulator-5554', execFile, settleMs: 0 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /^http:\/\/127\.0\.0\.1:41234\/snapshot\?fields=xml$/);
    assert.ok(options.headers['X-Artemis-Token']);
    return { ok: true, status: 200, json: async () => snapshotAnswer };
  };
  try {
    const snapshot = await client.snapshot();
    assert.deepEqual(snapshot, {
      xml: snapshotAnswer.xml,
      image: 'AAAA',
      width: 1080,
      height: 2400,
      packageName: 'com.example.app',
      activity: 'com.example.app/.Main',
      nodeCount: 12,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  // The tunnel is opened once, and the token is pushed with the explicit receiver.
  assert.ok(calls.some((call) => call.startsWith('forward tcp:0')));
  assert.ok(calls.some((call) => call.includes(TOKEN_ACTION)));
});

test('an existing tunnel for this device is reused instead of stacking another', async () => {
  const { execFile, calls } = fakeAdb({
    enabled: SERVICE_NAME,
    forwards: `emulator-5554 tcp:40001 tcp:${DEVICE_PORT}\nother tcp:40002 tcp:${DEVICE_PORT}\n`,
  });
  const client = new HelperClient({ serial: 'emulator-5554', execFile, settleMs: 0 });
  assert.equal(await client.attach(), 40001);
  assert.ok(!calls.some((call) => call.startsWith('forward tcp:0')));
});

test('a tunnel that stopped answering is replaced, and the old forward is removed first', async () => {
  let opened = 0;
  const { execFile, calls } = fakeAdb({
    enabled: SERVICE_NAME,
    onCommand: (command) =>
      command.startsWith('forward tcp:0') ? [`${41234 + opened++}\n`, ''] : undefined,
  });
  const client = new HelperClient({ serial: 'emulator-5554', execFile, settleMs: 0 });
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    // An adb server restart takes the loopback socket with it; the fresh tunnel answers.
    if (attempts++ === 0) throw new TypeError('fetch failed');
    return { ok: true, status: 200, json: async () => snapshotAnswer };
  };
  try {
    const snapshot = await client.snapshot();
    assert.equal(snapshot.packageName, 'com.example.app');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(attempts, 2);
  assert.ok(calls.includes(`forward --remove tcp:41234`));
  assert.equal(opened, 2);
});

test('recovery is bounded, so a helper that is gone costs no more adb calls as the run goes on', async () => {
  let opened = 0;
  const { execFile, calls } = fakeAdb({
    enabled: SERVICE_NAME,
    onCommand: (command) =>
      command.startsWith('forward tcp:0') ? [`${41234 + opened++}\n`, ''] : undefined,
  });
  const client = new HelperClient({ serial: 'emulator-5554', execFile, settleMs: 0 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  try {
    for (let read = 0; read < 12; read++) assert.equal(await client.snapshot(), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
  // One tunnel opened up front, three recoveries, and then the client settles for the adb read.
  assert.equal(opened, 4);
  assert.equal(calls.filter((call) => call.startsWith('forward tcp:0')).length, 4);
  // Every recovery removed the tunnel it replaced, so no dead forward was left behind.
  assert.equal(calls.filter((call) => call.startsWith('forward --remove')).length, 3);
});

test('a helper that answered with an error keeps its tunnel', async () => {
  const { execFile, calls } = fakeAdb({ enabled: SERVICE_NAME, port: '41234' });
  const client = new HelperClient({ serial: 'emulator-5554', execFile, settleMs: 0 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  try {
    assert.equal(await client.snapshot(), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(!calls.some((call) => call.startsWith('forward --remove')));
  assert.equal(calls.filter((call) => call.startsWith('forward tcp:0')).length, 1);
});

test('a device that refuses the install leaves a snapshot null, so the caller can fall back', async () => {
  const { execFile } = fakeAdb({
    installed: false,
    installFailure: 'Failure [INSTALL_FAILED_INTERNAL_ERROR]',
  });
  const client = new HelperClient({ serial: 'emulator-5554', execFile, settleMs: 0 });
  assert.equal(await client.snapshot(), null);
  assert.equal(await client.ping(), false);
});

test('the agent installs the helper itself when the device does not have it', async () => {
  const { execFile, calls } = fakeAdb({ installed: false, port: '41000' });
  const client = new HelperClient({ serial: 'emulator-5554', execFile, settleMs: 0 });
  assert.equal(await client.available(), true);
  const install = calls.find((call) => call.startsWith('install -r -g '));
  assert.match(install, /ArtemisAccessibilityHelper\.apk$/);
  // The service is enabled after the install, not instead of it.
  assert.ok(calls.some((call) => call.includes('put secure enabled_accessibility_services')));
});

test('an older helper is upgraded, and a current one costs two calls and no install', async () => {
  const older = fakeAdb({ installed: true, versionCode: 3, enabled: SERVICE_NAME, port: '41001' });
  const upgraded = new HelperClient({
    serial: 'emulator-5554',
    execFile: older.execFile,
    settleMs: 0,
  });
  assert.equal(await upgraded.available(), true);
  assert.ok(older.calls.some((call) => call.startsWith('install -r -g ')));

  const current = fakeAdb({
    installed: true,
    versionCode: HelperClient.bundledVersion(),
    enabled: SERVICE_NAME,
  });
  const upToDate = new HelperClient({
    serial: 'emulator-5554',
    execFile: current.execFile,
    settleMs: 0,
  });
  assert.equal(await upToDate.available(), true);
  assert.equal(
    current.calls.some((call) => call.startsWith('install ')),
    false,
  );
});

test('a ROM that only takes platform-signed packages gets the forced-install window', async () => {
  const { execFile, calls } = fakeAdb({
    installed: false,
    installFailure:
      'Failure [INSTALL_FAILED_VERIFICATION_FAILURE: Signature is not platform signed]',
  });
  const client = new HelperClient({ serial: 'emulator-5554', execFile, settleMs: 0 });
  assert.equal(await client.available(), true);
  assert.ok(
    calls.some(
      (call) => call.startsWith('push ') && call.includes('/data/local/tmp/artemis-helper.apk'),
    ),
  );
  assert.ok(calls.some((call) => call.startsWith('shell pm caninstall')));
  assert.ok(calls.some((call) => call.includes('pm install --install-force')));
});

test('enabling the helper keeps the accessibility services that were already on', async () => {
  const { execFile, calls } = fakeAdb({ enabled: 'com.other/.Service' });
  const client = new HelperClient({ serial: 'emulator-5554', execFile, settleMs: 0 });
  assert.equal(await client.available(), true);
  const put = calls.find((call) => call.includes('put secure enabled_accessibility_services'));
  assert.match(put, /com\.other\/\.Service:com\.artemis\.helper\/\.ArtemisAccessibilityService/);
});

test('a pinned helper port is opened as asked, so a remote adb server stays reachable', async () => {
  const { execFile, calls } = fakeAdb({ enabled: SERVICE_NAME, port: '43000' });
  const client = new HelperClient({
    serial: 'emulator-5554',
    execFile,
    settleMs: 0,
    fixedPort: 18888,
  });
  assert.equal(await client.attach(), 18888);
  assert.ok(calls.includes(`forward tcp:18888 tcp:${DEVICE_PORT}`));
  assert.ok(!calls.some((call) => call.startsWith('forward tcp:0')));
});

test('a pinned helper port is reused when the tunnel is already there', async () => {
  const { execFile, calls } = fakeAdb({
    enabled: SERVICE_NAME,
    forwards: `emulator-5554 tcp:18888 tcp:${DEVICE_PORT}\n`,
  });
  const client = new HelperClient({
    serial: 'emulator-5554',
    execFile,
    settleMs: 0,
    fixedPort: 18888,
  });
  assert.equal(await client.attach(), 18888);
  assert.ok(!calls.some((call) => call.startsWith('forward tcp:')));
});

test('a helper port outside the port range is refused rather than used', () => {
  assert.throws(
    () => new HelperClient({ serial: 'emulator-5554', settleMs: 0, fixedPort: 0 }),
    /between 1 and 65535/,
  );
});
