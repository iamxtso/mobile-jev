# What changed in the mobile agent

A record of the changes made while bringing the phone agent from "text-only, tap only" to a working
mobile-use loop, with the measurement that justified each one. Every number below was taken on an
Android emulator (Pixel 7, Android 16, `emulator-5554`) against `vllm-sr/d3-ultra`, and every claim
marked "live" was checked on the device rather than in a unit test.

## Observation: one request for the tree and the picture

The agent used to spend about two seconds per step reading the screen, and the read failed whenever a
window was animating.

|              | before                                                           | after                                       |
| ------------ | ---------------------------------------------------------------- | ------------------------------------------- |
| Observation  | 2.1 s (three adb calls, dump to `/dev/tty`, then parse)          | 0.17–0.46 s (one HTTP request)              |
| Screenshot   | a second adb call                                                | included, from the same instant as the tree |
| UiAutomation | held while dumping, so `android layout` and other tools collided | not used at all                             |

- `helper.mjs` talks to the Artemis accessibility helper (`com.artemis.helper`) over an adb tunnel:
  `GET /snapshot?fields=xml` returns the hierarchy and a bitmap, plus `atomic_elapsed_ms`.
- The helper is opt-in at construction (`createAgentDevice` enables it, tests do not), cached per run,
  reuses an existing tunnel instead of leaking one per process, and falls back to the old adb read when
  it is missing.
- `device.mjs` keeps the class name on each element. Without it a `SeekBar` and a button are the same
  shape, and a slider cannot be described at all.

## Vision: the model can see, point, and answer yes/no

- Every decision request carries the screenshot, `state.screen = "screenshot"` and `assets.screenshot`.
  The API rejects an unreferenced asset (`asset_unreferenced`), which the first version hit.
- `TAP_POINT`: a coordinate tap for controls the tree does not expose. It snaps onto the smallest
  observed control containing the point, and falls back to the raw coordinate. With the element list
  stripped to simulate a blind tree, it still tapped (911, 1970) against a true centre of (910, 1970).
- `DRAG_POINT`: a drag between two points for what has no element at all. Verified on the brightness
  slider, which is `clickable: false` and therefore never a tap candidate: 102 → 2.
- `goal_visible` (a `noul` question in the same request) decides whether a DONE is believed:

  | screen                            | `goal_visible` |
  | --------------------------------- | -------------- |
  | the goal is on screen             | 1.000          |
  | same screen, one requirement left | 0.009          |
  | unrelated goal                    | 0.000          |

  A DONE that disagrees returns `done_unverified` with a reason instead of claiming success.

- `commit` (a second request, only for a committing action below 75 % confidence) asks whether the step
  would send, post, publish, delete, buy or pay. Measured: a settings row 0.000, a scroll 0.000, a Post
  button 0.956. The first wording included "or change a setting", which blocked the dark-theme demo —
  the demo's whole point is changing a setting.
- Instructions are sent as strings. A structured `{ goal, rules }` value is rejected as a malformed
  question for a `box` question, and the API documents `instructions` as text.

## API contract fixes found only by running it

1. A `choice` needs at least two options. `scroll_target` with one scrollable region was rejected as
   `question_malformed`; a single candidate is now forced instead of asked.
2. An asset must be referenced from the state, instructions or criteria (`asset_unreferenced`).
3. `uiautomator dump /dev/tty` truncates or interleaves large trees (a settings screen is about 30 KB),
   which the parser then rejects. Dumping to a file and reading it back is deterministic.
4. `uiautomator` reports its failures on stdout, not stderr, so the error said only "ADB read failed".
   Both streams are now read, and the message names the device's own words.
5. `assertTreeFitsScreen` demanded a root exactly equal to the display. Chrome reports
   `[0,136][1080,2337]` (inset by the status and navigation bars) and a dialog is a legitimate root of
   its own, so every run died after the first popup. The rule is now "inside the display, not empty".
6. A phone that fell asleep reports no focused window and an empty tree; the run then failed as if the
   app had vanished. `assertReady()` reads `mWakefulness` and wakes the device. Live: a run that starts
   with `mWakefulness=Asleep` finishes with the task done and `mWakefulness=Awake`.
7. `TYPESAFE_BASE_URL` was documented in `.env.local` but never read, so a self-hosted endpoint was
   ignored. It is now a base URL with `/systemone` appended.
8. `execFileAsync` answers `[stdout, stderr]`, while the helper client expected `{ stdout }`. The
   mismatch made the helper look uninstalled and silently disabled the fast path.

## Guards in the loop

The loop now stops for reasons other than "the model said so":

- the same action at the same observation (existing);
- three taps within 48 px that change nothing — 24 px was enough to look like progress;
- three identical `EXPAND_*` / `OPEN_APP` / `HOME` / `BACK` decisions, which can never make
  incremental progress (a clock in the status bar defeats the exact-repeat check);
- a DONE the screen contradicts, up to five times;
- a committing action below 75 % confidence that would send, post, delete or pay.

`step_limit` and `decision_limit` map to a separate `exhausted` state in the studio: a task that ran out
of actions did not fail and needs nobody's attention.

## Actions

| action                   | how                                                           | live check                    |
| ------------------------ | ------------------------------------------------------------- | ----------------------------- |
| `TAP` / `TAP_POINT`      | element centre, or a coordinate with snapping                 | ✔                             |
| `LONG_PRESS`             | zero-length swipe, 600 ms (`input tap` has no duration)       | ✔ Play Store menu appeared    |
| `DOUBLE_TAP`             | two taps                                                      | ✔ argv asserted               |
| `DRAG`                   | `input draganddrop`, because `input swipe` is read as a fling | ✔ icon bounds moved           |
| `DRAG_POINT`             | two box questions, both ends in pixels, no snapping           | ✔ brightness 102 → 2          |
| `EXPAND_NOTIFICATIONS`   | `cmd statusbar expand-notifications`                          | ✔                             |
| `EXPAND_QUICK_SETTINGS`  | `cmd statusbar expand-settings`                               | ✔ brightness slider 1/3 → 3/3 |
| `COLLAPSE_NOTIFICATIONS` | `cmd statusbar collapse`                                      | ✔                             |

`EXPAND_QUICK_SETTINGS` exists because expanding the notification list alone _closes_ the quick settings
panel, where the brightness slider lives. Without it the model expanded three times, found nothing, and
reported blocked: 1/3 success before, 3/3 after.

Two scrollable columns on one screen give two independent scroll targets, each gesture staying inside
its own column, and coordinates are projected onto the region if it moved between decision and
execution.

## Verification

- `pnpm check`: 80 tests, lint, typecheck, formatting, production build — three consecutive clean runs.
- `pnpm verify`: four live tasks, each resetting its own preconditions and checking the device:
  airplane toggle, slider by tap, slider by drag, and a run that starts asleep. 8/8 over two rounds,
  median 4 steps and 10.2 s.
- `pnpm demo dark-theme --reset`: `verified`, `baselineVerifiedOff` and `stateChangeVerified` all true.

## Known limits

- **A slider's value is not observable.** The tree gives the track, not the thumb, and neither the
  uiautomator XML nor the helper's parsed elements carry `range-info`. The model therefore taps two or
  three times to reach an extreme and then cannot recognise that it arrived — the slider cases pass on
  device state while the run itself ends `stuck`. Fixing this needs the Android side of the helper
  (`range-current/min/max` and a `set_progress` command).
- **A self-hosted endpoint was unreachable** from the machine used here (`183.66.251.10:38000`), so
  `holo4` is unverified; everything above ran against `vllm-sr/d3-ultra` on `decision.vllm-sr.ai`.
- **App state leaks between runs.** A settings search box still holding the previous query changed the
  same task from 2 steps to 17. `pnpm verify` resets its own preconditions and `pnpm demo` collapses a
  leftover shade; a manual run does neither.
