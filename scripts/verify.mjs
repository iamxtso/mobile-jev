/**
 * Live verification: run the real tasks on the connected phone and check the device itself, not the
 * model's word for it. Every case resets its own preconditions first, because left-over app state
 * (an open shade, a search box still holding yesterday's text) changes what the agent sees.
 *
 *   pnpm verify                 # all cases once
 *   pnpm verify --only slider   # cases whose name contains "slider"
 *   pnpm verify --repeat 3      # repeat the set, to see variance
 *
 * Needs a device, an API key and a model, the same as `pnpm agent`. Costs about forty seconds per run.
 */
import { parseArgs } from 'node:util';
import { loadEnvironment } from './env.mjs';
import { createAgentDevice, deviceConfig } from './mobile-agent/device-factory.mjs';
import { TypeSafePolicy, runAgent } from './mobile-agent/agent.mjs';

loadEnvironment();
const { values } = parseArgs({
  allowPositionals: true,
  options: {
    only: { type: 'string', default: '' },
    repeat: { type: 'string', default: '1' },
    steps: { type: 'string', default: '10' },
  },
});

const shell = (device, command, mutation = false) => device.run(['shell', ...command], mutation);

/** The device's own answer, so a passing case cannot be the model agreeing with itself. */
const CASES = [
  {
    name: 'airplane-from-home',
    goal: 'Open Settings and turn on Airplane mode',
    async prepare(device) {
      await shell(device, ['cmd', 'connectivity', 'airplane-mode', 'disable'], true).catch(
        () => {},
      );
      await shell(device, ['pm', 'clear', 'com.android.settings'], true).catch(() => {});
    },
    async verify(device) {
      const value = (await shell(device, ['settings', 'get', 'global', 'airplane_mode_on']))
        .toString('utf8')
        .trim();
      return { ok: value === '1', detail: `airplane_mode_on=${value}` };
    },
  },
  {
    name: 'slider-low',
    goal: 'Set the brightness slider as low as it goes',
    async prepare(device) {
      await shell(device, ['settings', 'put', 'system', 'screen_brightness', '200'], true);
      await shell(device, ['cmd', 'statusbar', 'collapse'], true).catch(() => {});
    },
    async verify(device) {
      const value = (await shell(device, ['settings', 'get', 'system', 'screen_brightness']))
        .toString('utf8')
        .trim();
      return { ok: Number(value) < 30, detail: `brightness=${value} (want under 30)` };
    },
  },
  {
    name: 'slider-drag',
    goal: 'Drag the brightness slider thumb all the way to the left',
    async prepare(device) {
      await shell(device, ['settings', 'put', 'system', 'screen_brightness', '200'], true);
      await shell(device, ['cmd', 'statusbar', 'collapse'], true).catch(() => {});
    },
    async verify(device) {
      const value = (await shell(device, ['settings', 'get', 'system', 'screen_brightness']))
        .toString('utf8')
        .trim();
      return { ok: Number(value) < 30, detail: `brightness=${value} (want under 30)` };
    },
  },
  {
    name: 'wake-from-sleep',
    goal: 'Open Settings and turn on Airplane mode',
    async prepare(device) {
      await shell(device, ['cmd', 'connectivity', 'airplane-mode', 'disable'], true).catch(
        () => {},
      );
      await shell(device, ['pm', 'clear', 'com.android.settings'], true).catch(() => {});
      await shell(device, ['input', 'keyevent', 'KEYCODE_SLEEP'], true);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    },
    async verify(device) {
      const value = (await shell(device, ['settings', 'get', 'global', 'airplane_mode_on']))
        .toString('utf8')
        .trim();
      return { ok: value === '1', detail: `airplane_mode_on=${value} after starting asleep` };
    },
  },
];

async function runCase(entry, label) {
  const device = createAgentDevice(deviceConfig());
  await device.assertReady();
  await entry.prepare(device);
  await shell(device, ['input', 'keyevent', 'KEYCODE_HOME'], true).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const started = performance.now();
  const result = await runAgent({
    device,
    policy: new TypeSafePolicy(),
    goal: entry.goal,
    execute: true,
    maxSteps: Number(values.steps),
    // Keep the default settle window: a tap that lands while the shade is still opening misses.
  });
  const elapsedMs = Math.round(performance.now() - started);
  const verdict = await entry.verify(device);
  // The device decides. A run that reached the asked-for state but did not recognise it (a slider at
  // its minimum, where the value cannot be read) still did the task; the status is reported next to it.
  const ok = verdict.ok;
  return {
    label,
    ok,
    status: result.status,
    steps: result.steps,
    elapsedMs,
    detail: verdict.detail,
    reason: result.decision?.reason,
  };
}

async function main() {
  const repeat = Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10)
    throw new Error('--repeat must be between 1 and 10.');
  const cases = CASES.filter((entry) => entry.name.includes(values.only));
  if (!cases.length) throw new Error(`No case matches ${JSON.stringify(values.only)}.`);
  const results = [];
  for (let round = 1; round <= repeat; round++) {
    for (const entry of cases) {
      const label = repeat > 1 ? `${entry.name} #${round}` : entry.name;
      process.stdout.write(`${label.padEnd(28)} `);
      try {
        const result = await runCase(entry, label);
        results.push(result);
        console.log(
          `${result.ok ? 'PASS' : 'FAIL'}  ${result.status.padEnd(9)} ${String(result.steps).padStart(2)} steps ` +
            `${String(Math.round(result.elapsedMs / 100) / 10).padStart(5)}s  ${result.detail}` +
            (result.ok && result.status !== 'done' ? ` (model ended ${result.status})` : ''),
        );
      } catch (error) {
        results.push({ label, ok: false, status: 'error' });
        console.log(`FAIL  ${error.message}`);
      }
    }
  }
  const passed = results.filter((result) => result.ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  const median = (numbers) => numbers.sort((a, b) => a - b)[Math.floor(numbers.length / 2)] ?? 0;
  if (results.length)
    console.log(
      `median ${median(results.map((result) => result.steps))} steps, ` +
        `${Math.round(median(results.map((result) => result.elapsedMs)) / 100) / 10}s`,
    );
  if (passed !== results.length) process.exitCode = 1;
}

await main();
