import { AdbDevice } from './device.mjs';

/** @typedef {{ adbSerial: string, helperPort?: number }} DeviceConfig */
export function deviceConfig(env = process.env, overrides = {}) {
  const adbSerial = overrides.adbSerial ?? env.ADB_SERIAL;
  if (typeof adbSerial !== 'string' || !adbSerial.trim())
    throw new Error('ADB mode requires ADB_SERIAL or --adb-serial.');
  // A remote adb server hands out tunnel ports on the machine that runs it. Pinning the port lets the
  // caller forward that exact port back, which is the only way the helper stays reachable from here.
  const raw = overrides.helperPort ?? env.HELPER_PORT;
  const helperPort = raw === undefined || raw === '' ? undefined : Number(raw);
  if (
    helperPort !== undefined &&
    (!Number.isSafeInteger(helperPort) || helperPort < 1 || helperPort > 65535)
  )
    throw new Error('HELPER_PORT must be an integer between 1 and 65535.');
  return { adbSerial: adbSerial.trim(), ...(helperPort ? { helperPort } : {}) };
}

/** @param {DeviceConfig} config */
export function createAgentDevice(config, options = {}) {
  return new AdbDevice({
    ...options,
    serial: config.adbSerial,
    helper: true,
    helperPort: config.helperPort,
  });
}
