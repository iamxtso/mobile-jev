import { loadEnvironment } from './env.mjs';
import { createAgentDevice, deviceConfig } from './mobile-agent/device-factory.mjs';

loadEnvironment();
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
}
check('Node.js', Number(process.versions.node.split('.')[0]) >= 22, process.versions.node);
let config;
try {
  config = deviceConfig();
  check('Device backend', true, `adb (${config.adbSerial})`);
} catch (error) {
  check('Device backend', false, error.message);
}
check(
  'TypeSafe API key',
  Boolean(process.env.TYPESAFE_API_KEY),
  'Presence checked; no paid inference is made by doctor.',
);
if (config) {
  try {
    const device = createAgentDevice(config);
    const info = await device.assertReady();
    check('Device connection', true, `${info.name || info.id}: ${info.state}`);
    const observation = await device.observe();
    check(
      'UI observation',
      true,
      `${observation.elements.length} elements, ${observation.screen.width}×${observation.screen.height}`,
    );
    const apps = await device.listApps();
    check('App inventory', true, `${apps.length} packages`);
  } catch (error) {
    check('Device connection', false, error.message);
  }
}
for (const item of checks)
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}: ${item.detail}`);
if (checks.some((c) => !c.ok)) process.exitCode = 1;
