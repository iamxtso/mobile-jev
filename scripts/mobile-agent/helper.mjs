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
 *
 * The agent owns the install: the APK it was written against is vendored in `vendor/`, and a device
 * without it (or with an older one) is provisioned on first use, because nothing else in the agent can
 * read the tree without it.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const APK_PATH = fileURLToPath(new URL('./vendor/ArtemisAccessibilityHelper.apk', import.meta.url));
const MANIFEST_PATH = fileURLToPath(new URL('./vendor/helper_manifest.json', import.meta.url));
// A ROM that only accepts platform-signed packages refuses a plain install; its own forced-install
// window is the way in. The device-side copy is where that path installs from.
const FORCED_INSTALL_PATH = '/data/local/tmp/artemis-helper.apk';
const FORCED_INSTALL_WINDOW_SECONDS = 600;
const FORCED_INSTALL_FAILURES = [
  'INSTALL_FAILED_VERIFICATION_FAILURE',
  'INSTALL_FAILED_VERIFICATION_TIMEOUT',
  'Signature is not platform signed',
];

export const PACKAGE_NAME = 'com.artemis.helper';
export const SERVICE_NAME = `${PACKAGE_NAME}/.ArtemisAccessibilityService`;
export const TOKEN_RECEIVER = `${PACKAGE_NAME}/.TokenReceiver`;
export const TOKEN_ACTION = `${PACKAGE_NAME}.SET_TOKEN`;
export const DEVICE_PORT = 18_888;

export class HelperUnavailable extends Error {}

/** The tunnel is gone, not the helper: worth one fresh forward before the caller gives up. */
class TunnelLost extends HelperUnavailable {}

// A helper that is really gone must not cost two adb calls per read for the rest of the run.
const MAX_REATTACH = 3;

/** Everything an adb failure said: the verdict is often on stderr, the progress line on stdout. */
function failureText(error) {
  return [error?.stdout, error?.stderr, error?.message].filter(Boolean).join('\n');
}

/** The helper's session token lives on the phone, so it is derived, not stored per run. */
function hostToken(serial) {
  return createHash('sha256').update(`artemis-helper:${serial}`).digest('hex').slice(0, 32);
}

export class HelperClient {
  /**
   * `fixedPort` pins the host side of the tunnel. `adb forward tcp:0 …` lets adb pick a port on the
   * machine that runs the adb server, which is unreachable when that machine is not this one: with
   * `ADB_SERVER_SOCKET` pointing at a remote server, the chosen port belongs to the remote host and every
   * request here fails, dropping each observation to the slow `uiautomator` read. A pinned port can be
   * forwarded back over the same connection that carries the adb socket.
   */
  constructor({ serial, adbPath = 'adb', execFile: runner = run, settleMs = 800, fixedPort } = {}) {
    if (
      fixedPort !== undefined &&
      (!Number.isSafeInteger(fixedPort) || fixedPort < 1 || fixedPort > 65535)
    )
      throw new Error('A helper port must be an integer between 1 and 65535.');
    this.serial = serial;
    this.adbPath = adbPath;
    this.execFile = runner;
    this.fixedPort = fixedPort;
    this.port = null;
    this.token = hostToken(serial);
    this.settleMs = settleMs;
    this.reattaches = 0;
    this.reattaching = null;
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

  /** The versionCode of the bundled APK, which is what a device is brought up to. */
  static bundledVersion() {
    try {
      return Number(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')).version_code) || 0;
    } catch {
      return 0;
    }
  }

  /** The versionCode on the device, or null when the helper is not installed. */
  async installedVersion() {
    const dump = await this.adb(['shell', 'dumpsys', 'package', PACKAGE_NAME]).catch(() => '');
    const match = /versionCode=(\d+)/.exec(dump);
    return match ? Number(match[1]) : null;
  }

  /** Install or upgrade the vendored APK. False when the device refused in a way worth reporting. */
  async install() {
    let apk;
    try {
      apk = APK_PATH;
      readFileSync(apk);
    } catch {
      return false;
    }
    // The verdict is on stderr while stdout carries only the progress line, so read both.
    const plain = await this.adb(['install', '-r', '-g', apk]).catch(failureText);
    if (/\bSuccess\b/.test(plain)) return true;
    if (!FORCED_INSTALL_FAILURES.some((text) => plain.includes(text))) return false;
    // The ROM wants a platform-signed package: open its forced-install window and install from there.
    await this.adb(['push', apk, FORCED_INSTALL_PATH]).catch(() => '');
    await this.adb(['shell', 'pm', 'caninstall', String(FORCED_INSTALL_WINDOW_SECONDS)]).catch(
      () => '',
    );
    const forced = await this.adb([
      'shell',
      'pm',
      'install',
      '--install-force',
      '-r',
      '-g',
      FORCED_INSTALL_PATH,
    ]).catch(failureText);
    return /\bSuccess\b/.test(forced);
  }

  async probeAvailability() {
    try {
      const installed = await this.installedVersion();
      const wanted = HelperClient.bundledVersion();
      if (installed === null || installed < wanted) {
        if (!(await this.install())) return false;
        // Right after an install the service is not resolvable yet; the enable step below waits.
        await new Promise((resolve) => setTimeout(resolve, this.settleMs));
      }
      await this.enableService();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Bring a helper back that settings say is enabled but that answers nothing.
   *
   * This ROM leaves the APK's process alive after it unbinds the accessibility service: the setting reads
   * as enabled, the helper's port is closed, and every read silently falls back to the ten-second adb
   * dump. Restarting the process and re-enabling the service is the only thing that clears it, so the
   * device calls this once per run, after the snapshot path has already failed.
   */
  async repair() {
    try {
      await this.adb(['shell', 'am', 'force-stop', PACKAGE_NAME]).catch(() => '');
      await this.detach();
      await new Promise((resolve) => setTimeout(resolve, this.settleMs));
      await this.enableService();
      return await this.ping();
    } catch {
      return false;
    }
  }

  async enableService() {
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
    const wanted = this.fixedPort ?? 0;
    const assigned = (await this.adb(['forward', `tcp:${wanted}`, `tcp:${DEVICE_PORT}`])).trim();
    if (!/^\d+$/.test(assigned))
      throw new HelperUnavailable(
        wanted
          ? `Could not open a tunnel to the helper on port ${wanted}.`
          : 'Could not open a tunnel to the helper.',
      );
    this.port = wanted || Number(assigned);
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

  /**
   * Open a fresh tunnel after the cached one stopped answering. An adb server restart, a host sleep,
   * or a device that fell off the bus takes the forward away, and the cached port then fails every
   * request for the rest of the run while the slow adb read quietly covers for it.
   *
   * The old forward is removed first, so the count stays at one tunnel per device instead of growing a
   * dead one per failure; recovery is single-flight, so two concurrent reads cannot remove each
   * other's tunnel; and it stops after MAX_REATTACH, so a helper that is gone costs two adb calls at
   * most per read.
   */
  async reattach() {
    if (this.reattaches >= MAX_REATTACH) return false;
    this.reattaching ??= (async () => {
      this.reattaches++;
      const stale = this.port;
      this.port = null;
      if (stale) await this.adb(['forward', '--remove', `tcp:${stale}`]).catch(() => {});
      await this.attach();
      return true;
    })()
      .catch(() => false)
      .finally(() => {
        this.reattaching = null;
      });
    return this.reattaching;
  }

  async request(path, timeoutMs = 8_000, { method = 'GET', body } = {}) {
    try {
      return await this.requestOnce(path, timeoutMs, { method, body });
    } catch (error) {
      // Only a dead tunnel is worth a second try; a helper that answered with an error answered.
      if (!(error instanceof TunnelLost) || !(await this.reattach())) throw error;
      return this.requestOnce(path, timeoutMs, { method, body });
    }
  }

  async requestOnce(path, timeoutMs, { method, body }) {
    const port = await this.attach();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: {
            'X-Artemis-Token': this.token,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
        });
      } catch {
        // Nothing answered on the loopback port: refused, reset, or timed out.
        throw new TunnelLost('The helper did not answer on its tunnel.');
      }
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
   * One command on the helper's `/action` endpoint: `type` (any text, `append` at the cursor),
   * `clear`, `clipboard`, `global`, or a scroll. False when the helper refused or could not take it.
   */
  async action(payload) {
    try {
      const data = await this.request('/action', 8_000, { method: 'POST', body: payload });
      return data?.success === true;
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
