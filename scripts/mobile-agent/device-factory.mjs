import { AdbDevice, MobilerunDevice } from './device.mjs';
/** @typedef {{ backend: 'mobilerun' }} MobilerunConfig */
/** @typedef {{ backend: 'adb', adbSerial: string }} AdbConfig */
/** @typedef {MobilerunConfig | AdbConfig} DeviceConfig */
export function deviceConfig(env = process.env, overrides = {}) {
  const backend = overrides.backend || env.JEV_DEVICE_BACKEND || 'mobilerun';
  if (backend === 'adb') {
    const adbSerial = overrides.adbSerial ?? env.ADB_SERIAL;
    if (typeof adbSerial !== 'string' || !adbSerial.trim())
      throw new Error('ADB mode requires ADB_SERIAL or --adb-serial.');
    return { backend, adbSerial: adbSerial.trim() };
  }
  if (backend === 'mobilerun') return { backend };
  throw new Error('JEV_DEVICE_BACKEND must be mobilerun or adb.');
}

/**
 * @overload
 * @param {MobilerunConfig} config
 * @param {ConstructorParameters<typeof MobilerunDevice>[0]} [options]
 * @returns {MobilerunDevice}
 */
/**
 * @overload
 * @param {AdbConfig} config
 * @param {ConstructorParameters<typeof AdbDevice>[0]} [options]
 * @returns {AdbDevice}
 */
/** @param {DeviceConfig} config */
export function createAgentDevice(config, options = {}) {
  if (config.backend === 'adb') return new AdbDevice({ ...options, serial: config.adbSerial });
  if (config.backend === 'mobilerun') return new MobilerunDevice(options);
  throw new Error('Unsupported device backend.');
}
