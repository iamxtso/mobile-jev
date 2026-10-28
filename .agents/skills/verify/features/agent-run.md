# Agent task run

Jev reads the phone's UI, chooses one operation per step, and code validates and executes it. This is the product: a goal in, real device actions out, with a trace of every decision.

## Sub-features

- **Preview** — `run GOAL` without `--execute` prints the next decision and changes nothing.
- **Execute** — `--execute` runs the observe → decide → validate → act loop until `done`, `blocked`, or `--steps`.
- **Goal text spans** — text typed into a field comes from exact spans of the goal; `--text VALUE` (repeatable) overrides the candidates.
- **Confidence cutoff** — `--confidence N` rejects decisions below the cutoff instead of executing them.
- **Trace** — `--trace PATH` writes model requests, responses, actions, and final state as JSONL.
- **Studio run** — the same loop started from the studio's goal input (see [studio.md](studio.md)).

## How to get to it (user POV)

From a terminal: type a goal in plain language. "Turn on dark theme in Android Settings." "Open Settings and turn on Airplane mode." From the studio: type the goal in the input and press **Run task** (⌘↵).

## Driving it with ADB + the agent CLI

```sh
mkdir -p artifacts/verify
pnpm agent run "Open Settings and turn on Airplane mode" --execute --steps 10 \
  --trace artifacts/verify/airplane-$(date +%s).jsonl
```

Reset the precondition first so the goal has work to do, then read the device's own answer:

```sh
adb -s "$ADB_SERIAL" shell cmd connectivity airplane-mode disable
adb -s "$ADB_SERIAL" shell pm clear com.android.settings
adb -s "$ADB_SERIAL" shell input keyevent KEYCODE_HOME
```

Prove it:

```sh
adb -s "$ADB_SERIAL" shell settings get global airplane_mode_on    # want 1
```

Read the trace's last `decision` line for the model's claimed status and the returned model name. Report those next to the device verdict; `done` alone is not proof.

## Gotchas

- A `tap` that lands while a shade is still animating misses. Do not add `--settle-ms 0` and expect reliability; the default settle window exists for this.
- Stale targets are rejected before input, so a step count lower than the number of visible transitions ends in `max_steps`, not failure. Raise `--steps` before concluding the policy is wrong.
- An uncertain transport failure is never retried automatically. A run that stops mid-mutation leaves the device half-changed; reset the precondition before the next attempt.
- `jev-latest` moves. For comparisons, pin `TYPESAFE_MODEL` to a fixed version.
- Airplane mode disconnects the phone from Wi-Fi and mobile data. Re-enable it in cleanup.
