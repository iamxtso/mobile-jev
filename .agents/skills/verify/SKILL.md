---
name: verify
description: Drive Mobile Jev against a real Android device over ADB and prove behavior with device state — the CLI agent (`pnpm agent`), the local studio at 127.0.0.1:STUDIO_PORT, and the scripted `pnpm verify` / `pnpm demo` runners. Use when a change to the device adapter, policy, executor, CLI, or studio needs proof on a phone rather than an offline test.
---

# Verify Mobile Jev

Two surfaces, one target. The primary surface is the **CLI agent** (`scripts/mobile-agent/cli.mjs`), which reads the phone over ADB and lets TypeSafe's Jev pick each operation. The secondary surface is the **studio** (`apps/jev-studio`), a Next.js UI on localhost that shows a live snapshot, the action timeline, and model latency. Both mutate the same phone, and only one task may own the configured device at a time.

The phone decides whether a run passed. A model `DONE` response is not proof (see `README.md`, "How Jev drives it").

Feature map: `features/README.md` next to this file. Read the file for the feature you are about to drive.

## Launch

No server is needed for the CLI. It talks to ADB directly.

```sh
pnpm install --frozen-lockfile        # once
pnpm run doctor                       # readiness; run this before anything else
```

Studio, in its own process group so cleanup can kill exactly what this run started:

```sh
.agents/skills/verify/scripts/studio.sh start 3999   # dev server on 3999
.agents/skills/verify/scripts/studio.sh status 3999
.agents/skills/verify/scripts/studio.sh stop 3999
```

Ready means `HTTP 200` from `http://127.0.0.1:3999/`, which the helper polls for (up to 90s; a cold Next.js dev compile is slow). `STUDIO_PORT` exported in the environment beats `.env.local`, so a verification port never collides with the operator's 3040. For a production build, run `pnpm build` once, then `STUDIO_PORT=3999 pnpm start`.

Configuration comes from `.env.local`, then `.env`, with exported variables winning: `ADB_SERIAL`, `TYPESAFE_API_KEY`, `TYPESAFE_MODEL`, `STUDIO_PORT`, `HELPER_PORT`. Never print `.env.local` — it holds the API key.

### When the device is a remote devpod

On this checkout the phone hangs off an adb server on another machine, reached through an SSH tunnel
(`ssh -f -N -L5037:127.0.0.1:5037 -L27183:127.0.0.1:27183 devpod5`). Two consequences:

- `adb forward` creates its listener on that remote machine, so the helper tunnel is only reachable
  through the same tunnel. `HELPER_PORT=27183` is set in `.env.local` for that reason, and it must match
  the `-L` forward. Without it every read falls back to the ten-second `uiautomator` dump.
- `adb kill-server` kills the remote server through the tunnel and there is nothing local to restart it.
  Recover with `ssh devpod5 'adb start-server'`, then check `adb devices -l` before driving anything.
  A helper whose accessibility service the ROM unbound shows up as `ping` failing on its port; the agent
  restarts it once per run (see `HelperClient.repair`).

## Doctor

`pnpm run doctor` is the read-only "is this instance worth driving?" check. It prints one line per check and exits 1 if any fails:

```text
PASS  Node.js: 24.x
PASS  Device backend: adb (emulator-5554)
PASS  TypeSafe API key: Presence checked; no paid inference is made by doctor.
PASS  Device connection: Pixel 8: device
PASS  UI observation: 42 elements, 1080×2400
PASS  App inventory: 187 packages
```

It checks key presence only, so a `PASS` there does not prove the key works. No device attached, a serial that is not connected, or a device in `unauthorized` state fails at `Device connection`. `adb devices -l` shows what ADB sees. Run doctor first whenever a drive fails for no visible reason.

Always type `pnpm run doctor`. Bare `pnpm doctor` resolves to pnpm's own built-in `doctor` command, which shadows the script: it prints nothing and exits 0, so a broken setup looks healthy.

## Drive

### CLI

```sh
pnpm agent devices                                   # what ADB sees
pnpm agent observe --out artifacts/verify/observe.json
pnpm agent screenshot --out artifacts/verify/before.png
pnpm agent run "Turn on dark theme in Android Settings."                    # preview decision, no input
pnpm agent run "Turn on dark theme in Android Settings." --execute --steps 20 \
  --trace artifacts/verify/dark-theme.jsonl
```

`run` without `--execute` is the safe path for checking the policy layer: it prints the decision and touches nothing. Direct controls (`tap X Y`, `type TEXT --clear`, `back`, `home`, `key enter`) execute immediately and are for debugging, not for proofs — a proof that scripts taps proves the script, not the agent. `--out` and `--trace` refuse to overwrite an existing file (`wx`), so use a fresh name per attempt.

### Studio over HTTP

Same-origin rules apply: `POST` requires an `Origin` header matching the `Host`, and the host must be `localhost` or `127.0.0.1`.

```sh
BASE=http://127.0.0.1:3999/api/studio
curl -fsS "$BASE/device"                             # readiness + snapshotUrl
curl -fsS -o artifacts/verify/snapshot.png "$BASE/device/snapshot"
curl -fsS "$BASE/runs"                               # recent runs
curl -fsS -X POST "$BASE/runs" -H "Origin: http://127.0.0.1:3999" \
  -H 'Content-Type: application/json' -d '{"goal":"Turn on dark theme in Android Settings."}'
curl -fsS -N "$BASE/runs/<id>/events"                # SSE: state, actions, timings
curl -fsS -X POST "$BASE/runs/<id>/stop" -H "Origin: http://127.0.0.1:3999"
```

`GET /device/snapshot` returns `503` with the adb error text when the device is unreachable — that is the honest signal, not a bug. Browser controls in the studio are deliberately disabled; driving goes through the API or the CLI.

## Evidence

Everything lands in `artifacts/verify/` (gitignored, survives cleanup). Capture:

- **The action and the resulting state**, not just the last screen: `before.png`, `after.png`, and the `observe.json` for each, plus the `--trace` JSONL for executed runs.
- **The device's own verdict** for any state claim, read over ADB, not from the UI:

```sh
adb -s "$ADB_SERIAL" shell settings get global airplane_mode_on      # want 1
adb -s "$ADB_SERIAL" shell settings get system screen_brightness     # want < 30
```

A toggle with no settings key is verified from the observation instead: `darkThemeState()` in `scripts/demo-verifiers.mjs` requires exactly one `checkable` element labeled `Dark theme` and reads its `checked` state, failing closed on anything ambiguous.

- **The model name** from the trace, since `jev-latest` moves under you.

Proof standards: exercise the real user path (`pnpm agent run ... --execute`, or a studio run), not internal setters; verify side effects with the `adb shell settings get` reads above alongside what the screen shows; keep a failing attempt — the repo records failures next to successes on purpose (`README.md`, "Speed and reproducibility"). Report the model's declared status (`done`, `blocked`, `max_steps`) separately from the device verdict.

## Cleanup

```sh
.agents/skills/verify/scripts/studio.sh stop 3999
```

The helper kills the process group it created and nothing else; it never kills by process name. It removes the pid file and leaves `artifacts/verify/` intact. After cleanup, confirm the evidence is still there — a cleanup that eats the proof fails the run.

Device state is _not_ restored automatically. The scripted cases leave the phone changed on purpose (see Gotchas in `features/verification-suite.md`): airplane mode stays on, which takes the phone off Wi-Fi and mobile data. Re-enable it yourself:

```sh
adb -s "$ADB_SERIAL" shell cmd connectivity airplane-mode disable
```

## Helpers

- `scripts/studio.sh start|status|stop [PORT]` — studio lifecycle in its own process group, log and pid file under `artifacts/verify/`. Default port 3999.
- `scripts/verify.mjs` — the repo's own four-case live suite (`pnpm verify`), the fastest end-to-end proof of the agent loop.
- `scripts/demo.mjs` — the dark-theme demo with independent verification (`pnpm demo dark-theme --reset`).
