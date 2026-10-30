# Device inspection and direct controls

The CLI can read the phone and drive it without Jev. This is the debugging surface: it shows exactly what the agent sees, and it lets you act on the device when the model is not the thing under test.

## Sub-features

- **`observe`** — compact UI state: every element with its bounds, label, and id, plus screen size. `--out PATH` saves the JSON.
- **`screenshot`** — PNG to `--out` (default `artifacts/screen-<timestamp>.png`).
- **`profile`** — times readiness plus five UI-state reads, without changing the device. `--out PATH` saves the report.
- **`tap X Y`**, **`tap-element ID --snapshot PATH`** — coordinate and observation-based taps.
- **`swipe X1 Y1 X2 Y2 [MS]`**, **`type TEXT [--clear]`**, **`clear`**, **`key enter|tab|delete|forward_delete|back`**, **`home`**, **`back`**, **`recent`**.

## How to get to it (user POV)

From a terminal, against the connected phone. Nothing in this surface is reachable from the studio — its browser device controls are disabled on purpose.

## Driving it with ADB + the agent CLI

```sh
adb devices -l
pnpm agent observe --out artifacts/verify/observe.json
pnpm agent screenshot --out artifacts/verify/screen.png
pnpm agent profile --out artifacts/verify/profile.json
pnpm agent tap-element <id> --snapshot artifacts/verify/observe.json
pnpm agent type "San Francisco" --clear
```

Prove the surface: `observe.json` contains at least one element and a `screen` with non-zero width and height; `screen.png` is a valid PNG whose dimensions match `screen`; `profile.json` reports a `totalMs` covering six device reads. Cross-check with `adb -s "$ADB_SERIAL" exec-out screencap -p > /tmp/x.png` and compare sizes.

## Gotchas

- `--out` and `--trace` use `wx`: they refuse to overwrite. Two attempts with the same path fail on the second — use a timestamp in the name.
- ADB text is limited to letters, numbers, spaces, and `. _ @ + : -`. Anything else fails before dispatch, by design.
- `tap-element` needs the snapshot that produced the id; ids are not stable across observations.
- `profile` makes no model call and costs nothing. It is the right check when a run feels slow before the first decision.
