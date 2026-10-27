import { AdbDevice } from './device.mjs';

/** @typedef {{ adbSerial: string }} DeviceConfig */
export function deviceConfig(env = process.env, overrides = {}) {
  const adbSerial = overrides.adbSerial ?? env.ADB_SERIAL;
  if (typeof adbSerial !== 'string' || !adbSerial.trim())
    throw new Error('ADB mode requires ADB_SERIAL or --adb-serial.');
  return { adbSerial: adbSerial.trim() };
}

/** @param {DeviceConfig} config */
export function createAgentDevice(config, options = {}) {
  return new AdbDevice({ ...options, serial: config.adbSerial, helper: true });
}
