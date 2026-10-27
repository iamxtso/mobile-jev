/**
 * Client for the Artemis accessibility helper app (com.artemis.helper).
 *
 * One HTTP request returns the accessibility tree and a screenshot taken at the same instant:
 *
 *   GET /snapshot?fields=xml -> { xml, has_screenshot, screenshot_base64, width, height, package, ... }
 *
 * It talks to a service the app exposes on loopback (18888), reached through an adb forward. The
 * service never takes the singleton UiAutomationConnection, so it runs alongside uiautomator, Mobly
 * and Espresso instead of fighting them for the accessibility channel. Reading one adb dump costs
 * about two seconds; one snapshot costs about a hundred milliseconds.
 *
 * The port is reachable by every app on the phone, so the helper refuses everything but /ping until
 * this host pushes a secret with an am broadcast that only the adb shell user may send.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const PACKAGE_NAME = 'com.artemis.helper';
export const SERVICE_NAME = `${PACKAGE_NAME}/.ArtemisAccessibilityService`;
export const TOKEN_RECEIVER = `${PACKAGE_NAME}/.TokenReceiver`;
export const TOKEN_ACTION = `${PACKAGE_NAME}.SET_TOKEN`;
export const DEVICE_PORT = 18_888;

export class HelperUnavailable extends Error {}

/** The helper's session token lives on the phone, so it is derived, not stored per run. */
function hostToken(serial) {
  return createHash('sha256').update(`artemis-helper:${serial}`).digest('hex').slice(0, 32);
}

export class HelperClient {
  constructor({ serial, adbPath = 'adb', execFile: runner = run, settleMs = 800 } = {}) {
    this.serial = serial;
    this.adbPath = adbPath;
    this.execFile = runner;
    this.port = null;
    this.token = hostToken(serial);
    this.settleMs = settleMs;
  }

  async adb(args) {
    const result = await this.execFile(this.adbPath, ['-s', this.serial, ...args], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    // The device passes its own runner through: it answers [stdout, stderr], while the default here
    // answers { stdout, stderr }. Accept either, so one swapped runner cannot look like a missing app.
    const stdout = Array.isArray(result) ? result[0] : result?.stdout;
    return typeof stdout === 'string' ? stdout : Buffer.from(stdout ?? '').toString('utf8');
  }

  /** An installed, enabled helper is the only thing that makes this client usable. Cached: the
   * answer cannot change during a run, and probing costs two adb calls. */
  async available() {
    if (this.availableCache !== undefined) return this.availableCache;
    this.availableCache = await this.probeAvailability();
    return this.availableCache;
  }

  async probeAvailability() {
    try {
      const packages = await this.adb(['shell', 'pm', 'list', 'packages', PACKAGE_NAME]);
      if (!packages.includes(`package:${PACKAGE_NAME}`)) return false;
      const enabled = await this.adb([
        'shell',
        'settings',
        'get',
        'secure',
        'enabled_accessibility_services',
      ]);
      const current = enabled.trim();
      const services = current === 'null' || !current ? [] : current.split(':');
      if (!services.includes(SERVICE_NAME)) {
        // Start from whatever else is enabled: turning the helper on must not turn others off.
        await this.adb([
          'shell',
          'settings',
          'put',
          'secure',
          'enabled_accessibility_services',
          [...services, SERVICE_NAME].join(':'),
        ]);
        await this.adb(['shell', 'settings', 'put', 'secure', 'accessibility_enabled', '1']);
        await new Promise((resolve) => setTimeout(resolve, this.settleMs));
      }
      return true;
    } catch {
      return false;
    }
  }

  async attach() {
    if (this.port) return this.port;
    if (!(await this.available()))
      throw new HelperUnavailable('The accessibility helper is not installed.');
    // Reuse a tunnel another run or process left behind instead of stacking one per run.
    const existing = await this.existingForward();
    if (existing) {
      this.port = existing;
      await this.pushToken();
      return this.port;
    }
    // Let adb pick the host port: two devices or two sessions on one host then never collide.
    const assigned = (await this.adb(['forward', 'tcp:0', `tcp:${DEVICE_PORT}`])).trim();
    if (!/^\d+$/.test(assigned))
      throw new HelperUnavailable('Could not open a tunnel to the helper.');
    this.port = Number(assigned);
    await this.pushToken();
    return this.port;
  }

  async existingForward() {
    try {
      for (const line of (await this.adb(['forward', '--list'])).split('\n')) {
        const [serial, local, remote] = line.trim().split(/\s+/);
        if (serial === this.serial && remote === `tcp:${DEVICE_PORT}` && /^tcp:\d+$/.test(local))
          return Number(local.slice(4));
      }
    } catch {
      // No forwards at all.
    }
    return null;
  }

  async pushToken() {
    await this.adb([
      'shell',
      'am',
      'broadcast',
      '-n',
      TOKEN_RECEIVER,
      '-a',
      TOKEN_ACTION,
      '--es',
      'token',
      this.token,
    ]);
  }

  async request(path, timeoutMs = 8_000) {
    const port = await this.attach();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { 'X-Artemis-Token': this.token },
        signal: controller.signal,
      });
      if (response.status === 401) {
        // A re-bound service starts without a token.
        await this.pushToken();
        throw new HelperUnavailable('The helper rejected its session token.');
      }
      if (!response.ok) throw new HelperUnavailable(`The helper answered HTTP ${response.status}.`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async ping() {
    try {
      return (await this.request('/ping', 3_000)).authenticated === true;
    } catch {
      return false;
    }
  }

  /**
   * The tree and the screenshot from one request, at the same instant. Null when the helper cannot
   * serve a snapshot, so the caller can fall back to the adb read instead of failing the run.
   */
  async snapshot() {
    try {
      const data = await this.request('/snapshot?fields=xml');
      if (!data?.success || typeof data.xml !== 'string' || !data.xml.includes('<hierarchy'))
        return null;
      return {
        xml: data.xml,
        image: data.has_screenshot ? (data.screenshot_base64 ?? null) : null,
        width: Number(data.width),
        height: Number(data.height),
        packageName: data.package || '',
        activity: data.activity || '',
        nodeCount: data.node_count,
      };
    } catch {
      return null;
    }
  }

  async detach() {
    if (!this.port) return;
    try {
      await this.adb(['forward', '--remove', `tcp:${this.port}`]);
    } catch {
      // The tunnel is already gone, which is the state we wanted.
    }
    this.port = null;
  }
}
