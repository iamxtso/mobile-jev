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

function fakeAdb({ installed = true, enabled = '', forwards = '', port = '41234' } = {}) {
  const calls = [];
  const execFile = async (file, args) => {
    calls.push(args.slice(2).join(' '));
    const command = args.slice(2).join(' ');
    if (command.startsWith('shell pm list packages')) return [`package:com.artemis.helper\n`, ''];
    if (command.startsWith('shell settings get secure enabled_accessibility_services'))
      return [`${enabled}\n`, ''];
    if (command === 'forward --list') return [forwards, ''];
    if (command.startsWith('forward tcp:0')) return [`${port}\n`, ''];
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

test('without the helper installed a snapshot is null, so the caller can fall back', async () => {
  const { execFile } = fakeAdb();
  execFile().catch(() => {});
  const client = new HelperClient({
    serial: 'emulator-5554',
    execFile: async (file, args) =>
      args.slice(4).join(' ').startsWith('list packages') ? ['', ''] : ['', ''],
  });
  assert.equal(await client.snapshot(), null);
  assert.equal(await client.ping(), false);
});

test('enabling the helper keeps the accessibility services that were already on', async () => {
  const { execFile, calls } = fakeAdb({ enabled: 'com.other/.Service' });
  const client = new HelperClient({ serial: 'emulator-5554', execFile, settleMs: 0 });
  assert.equal(await client.available(), true);
  const put = calls.find((call) => call.includes('put secure enabled_accessibility_services'));
  assert.match(put, /com\.other\/\.Service:com\.artemis\.helper\/\.ArtemisAccessibilityService/);
});
