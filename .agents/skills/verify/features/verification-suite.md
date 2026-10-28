# Scripted verification suite

The repo's own repeatable proofs. Each case resets its preconditions, runs a real goal through the agent, then asks the device whether the goal's state holds. The device decides; a run that reached the state without recognising it reports that beside the pass.

## Sub-features

- **`pnpm verify`** — four cases: `airplane-from-home`, `slider-low`, `slider-drag`, `wake-from-sleep`. About forty seconds per run.
- **`pnpm verify --only NAME`** — cases whose name contains `NAME` (`slider`, `airplane`, `wake`).
- **`pnpm verify --repeat N`** — repeat the set, 1–10, to see variance.
- **`pnpm verify --steps N`** — per-case step budget, default 10.
- **`pnpm demo dark-theme [--reset] [--repeat N]`** — the dark-theme demo with independent verification; `--reset` first asks Jev to establish and verify an off baseline, and no measured run starts unless that baseline verified.

## How to get to it (user POV)

From a terminal, with a phone connected and keys configured. Nothing here is exposed in the studio.

## Driving it with ADB + the agent CLI

```sh
pnpm run doctor
pnpm verify --only slider --repeat 2
pnpm demo dark-theme --reset
```

Prove it: the suite prints one line per case and a `PASS`/`FAIL` verdict plus `n/m passed` and a median. Exit code is 1 when any case fails, so `pnpm verify && echo ok` is a usable gate. Independently confirm a verdict:

```sh
adb -s "$ADB_SERIAL" shell settings get system screen_brightness   # slider cases: want < 30
adb -s "$ADB_SERIAL" shell settings get global airplane_mode_on    # airplane cases: want 1
```

`pnpm demo` writes reports and JSONL traces under `artifacts/demos/`; each report carries `claimedStatus` (what the model said), `verified` (what the device showed), `stateChangeVerified` (baseline off _and_ verified on), step count, model calls, and separated setup/execution/verification timings.

## Gotchas

- Cases mutate the phone and do not restore it. Airplane mode stays on after `airplane-from-home` and `wake-from-sleep`; turn it off with `adb -s "$ADB_SERIAL" shell cmd connectivity airplane-mode disable`.
- `wake-from-sleep` sends `KEYCODE_SLEEP` and waits two seconds; a device with a lock screen that needs a PIN fails this case for a reason unrelated to the agent.
- A case can be `PASS` with a model status other than `done` (for example a slider at its minimum, where the value cannot be read). The line prints `(model ended <status>)` so the two are never conflated.
- `--repeat` above 10 is rejected. Use `--only` to iterate on one case rather than repeating all four.
- These cases cost real model requests. Do not run them in CI; CI is offline by contract (`AGENTS.md`).
