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

  A DONE that disagrees returns `done_unverified` with a reason instead of claiming success. The cutoff
  is 0.8: on a car dock, Jev chose DONE for a music pause that had not happened and the screen agreed
  at 0.57, which the earlier 0.5 cutoff accepted as verified.

- `commit` (a second request, only for a committing action below 75 % confidence) asks whether the step
  would send, post, publish, delete, buy or pay. Measured: a settings row 0.000, a scroll 0.000, a Post
  button 0.956. The first wording included "or change a setting", which blocked the dark-theme demo —
  the demo's whole point is changing a setting.
- Instructions are sent as strings. A structured `{ goal, rules }` value is rejected as a malformed
  question for a `box` question, and the API documents `instructions` as text.

## A tap is judged by the control it hit

A whole-screen fingerprint cannot answer "did that tap work" on a screen that moves on its own. On a
car launcher the voice-tips card (`ui.3.0.0.1.*`) rotates every 7-9 s: 19 of 20 reads over 100 s
differed on an idle home screen, while the status-bar clock is minute-level. The loop now judges a tap
by the control it hit: its own state, what changed inside its bounds, whether the owning app changed,
and whether a new readable clickable appeared. Elements are matched by where they are drawn, because a
path id is positional and the accessibility tree reorders windows between reads.

A dock media icon is still invisible to the tree — it swaps two glyphs while its id, bounds, text and
checked state stay identical. Two signals cover that, and only for a small tapped control (≤ 90 000
px):

- the pixels under the tap, ≥ 2 % changed (`cropControl`/`changedFraction` in `pixels.mjs`);
- one request asking about the control's own drawing, before and after, as `choice`
  (same / changed / unreadable) plus a `noul` asking whether that drawing now shows the goal.

Measured on the dock tile (11 runs): the before/after pair read `changed` at 99-100 % and the goal at
100 % when it had happened, 8 % when it had not, and `same` at 99 % for two captures of one state. That
reading confirms the tap, ends the run as `done` with the evidence in the reason, and stops the loop
from repeating a toggle that would undo itself. Asking the model to name the glyph also works — 100 %
both directions in 9 reads — but the same/changed pair needs no per-icon vocabulary.

The crops are scaled to the API's image limits (280 to 1568 px per side, ≥ 78 400 px total); a
dashboard icon is about 90 px, and the helper's own screenshot is a JPEG, so the comparison asks for a
PNG. Requests that carry an image now send `TypeSafe-Danger-Zone-Images: true`, without which the
public API refuses them.

## Text entry: four tiers, and the agent installs what they need

`adb shell input text` writes ASCII only, which made every Chinese goal unreachable. `text-entry.mjs`
tries four ways, in order, each a real Android mechanism:

1. **Clipboard, then `KEYCODE_PASTE` (279).** The accessibility helper writes the text with
   `ClipData.newPlainText` (`POST /action {"cmd":"clipboard","text":…}`) and the host sends the paste
   key. The IME never sees a character, so Chinese, Japanese, emoji and several lines arrive as one
   commit.
2. **ADBKeyboard**, when installed and active: `am broadcast -a ADB_INPUT_B64 --es msg <base64>`, UTF-8,
   so the shell never sees the characters either.
3. **yadb** at `/data/local/tmp/yadb`, the same idea without an installed keyboard.
4. **`input text`**, for ASCII — and for anything else, its pinyin spelling, which is what a person
   types on a Chinese IME.

Nothing in that list is a manual setup step any more. `scripts/mobile-agent/vendor/` carries the helper
APK and the yadb jar, and the agent provisions them:

- `HelperClient.available()` compares the device's `versionCode` with the bundled manifest and installs
  or upgrades when it is behind. A ROM that only takes platform-signed packages answers
  `INSTALL_FAILED_VERIFICATION_FAILURE`, which switches to its own forced-install window
  (`pm caninstall 600` then `pm install --install-force`). Verified on `282999b1` after
  `adb uninstall`: `available()` went from false to true, `versionCode` 6, and the next run took the
  fast snapshot path again.
- yadb is pushed on the first use of that tier, and the tier is skipped when the vendored jar is absent.

Measured on `282999b1` (only Sogou installed, no ADBKeyboard, navi search field):

| Attempt                                             | Result                                                                                                     |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `clipboard 星海广场` then 279                       | field `充电站星海广场`                                                                                     |
| `clipboard 测试⚡ / 第二行` then 279                | field `充电站星海广场测试⚡ 第二行`; the single-line field folds the break                                 |
| yadb tier, helper forced unavailable                | `yadb` answered, field `星海广场和平广场`, binary pushed by the agent                                      |
| pinyin tier, helper and yadb forced unavailable     | `和平广场` typed as `hepingguangchang`, and the search results under it were 凯德和平广场 and 国际和平广场 |
| goal `在导航搜索框输入“充电站”，然后点击搜索按钮。` | TYPE_TEXT → ENTER → DONE, 2 steps, 5 charging stations listed                                              |
| goal with `“大连北站”`                              | TYPE_TEXT → ENTER → WAIT → DONE, 3 steps, 大连北站 results                                                 |
| same goal after `adb uninstall com.artemis.helper`  | helper reinstalled by the agent, DONE in 2 steps (29 s including the install)                              |

The pinyin tier is honest about its limit: it delivers the spelling, and the field keeps the letters
while the app resolves them — the IME's own candidate selection is still the user's step. A text with no
ASCII spelling at all (an emoji on a device with no helper, no ADBKeyboard and no yadb) fails and says
which tiers were tried.

Clearing has its own order, because a field its app redraws itself ignores backspace: the helper's
`cmd:"clear"` first, then a held backspace, then select-all and delete. On the navi search box all three
do nothing (only its own ✗ button clears it), so the run reports `input_unverified` instead of claiming
the value was replaced.

A goal written without spaces offered the whole sentence as its only candidate value, so
`textCandidates` now offers a quoted span first (“…” 「…」 《…》); that is the only dependable signal in
a language that does not put spaces between words.

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

## A gesture aims at the label, not at the cell around it

A clickable container often has no name of its own: on the navi toolbar the `全览` button is an 88x88
cell (`ui.4.7`) named by a 36x26 label inside it (`ui.4.7.0`). Tapping the cell's centre lands 25 px
above the glyph — inside this cell's hit area, but not inside a narrower one.

The observation now keeps the box the name is drawn in (`nameBox`) whenever it is smaller than the
element, and one helper (`aim`) decides where tap, double tap, long press and drag start land: the
middle of that box. A settings row whose label fills the row has no `nameBox`, so its tap is unchanged.

Verified on `282999b1`: `tap-element ui.4.7` resolves to `input tap 345 893` (the label) instead of
`345 868` (the cell), and the map is in overview afterwards.

## A nameless badge is named by the cell it sits in

The control center's delete badges are 31x31 clickable `ImageView` nodes (`control_item_delet_im`) with
no text, no description, and no children: nothing in the tree says what one deletes. On `282999b1` the
model asked to delete `座椅加热` aimed at the cell instead of its badge, and in edit mode a cell tap does
nothing (`screenChanged: false`), so the run stopped `stuck` rather than deleting anything.

The observation now names an anonymous clickable node that hugs a corner of a bigger, named parent after
that parent and that corner: `座椅加热 的右上角按钮`. It only fires when the node is under 40 % of the cell
in both dimensions and touches one vertical and one horizontal edge within 32 px, so icons that fill
their cell and lone glyphs keep whatever name they had.

Two unnamed icon rows can also share a container name, because any app without resource ids falls back
to the class name and then `1 of 2 in FrameLayout` describes two different controls. The second row gets
a `#2` suffix.

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
- **Screen-cleaning mode locks touch, and a hold is the only way out.** Tapping that control-center
  widget turns the display into a surface that ignores taps and swipes; the display itself says a long
  press releases it. `LONG_PRESS` used to be 600 ms with no way to ask for more, so the agent could
  enter that state and not leave it. Three changes fix that: a press can carry `duration`, the gesture
  target question offers the screen itself (`SCREEN`) for states released by holding the display, and a
  press that changed nothing is tried once more at 3 s. Verified on `282999b1`: from cleaning mode the
  agent held the screen centre, `screenChanged` came back true, and the state ended (`done`). The
  measured surprise is that this ROM releases on the first 600 ms hold even though its hint says three
  seconds, so the 3 s retry fires on the _second_ press rather than the first.
- **Guidance blinds the tree.** While the navigation app is guiding, `pnpm agent observe` returns the
  voice-engine window — 38 nodes, all dock and status bar — instead of the navigation screen, so the agent
  cannot see the map, the turn card, or `结束导航`. The helper's `/snapshot` follows the focused window and
  has no parameter to select another, and the APK is vendored, so this needs an upstream fix that merges
  the windows it can see. Workaround: stop guidance from the voice engine or from a screenshot-plus-point
  action before driving the navigation app.
- **A typed action now says which tier carried it.** `enterText` already returned `clipboard`,
  `adbkeyboard`, `yadb`, `input`, or `pinyin`, and `device.act` dropped it, so a trace could show the text
  arrived but not how. `action_executed` and the step history now carry `inputTier`. Measured on
  `282999b1`: the navigation search field takes 重庆 through `clipboard` (helper clipboard + KEYCODE_PASTE),
  which retires the earlier note that this field ignores every keyboard event.
- **A dead adb tunnel used to last the rest of the run.** The helper client caches its forwarded port for
  the whole process, so an adb server restart, a host sleep, or a device that fell off the bus left every
  later request failing on a port that no longer existed — and the slow `uiautomator dump` fallback hid it,
  turning 100 ms reads into 2 s reads for the rest of the run. `HelperClient.request` now recognises a
  tunnel that did not answer (a transport failure, not an HTTP error), removes the stale forward, opens a
  new one, and retries once. The recovery is single-flight, so two concurrent reads cannot remove each
  other's tunnel, and it stops after three, so a helper that is really gone costs no extra adb calls. The
  old forward is removed before the new one is opened, so the count stays at one tunnel per device.
  Measured on `282999b1`: killing the forward, and separately killing the adb server, each recovered on the
  next read (351 ms and 3.5 s including adb restart) with exactly one tunnel left behind and one recovery
  used; a helper answering HTTP 500 keeps its tunnel.
- **A run that died mid-way left no record of the screen.** A model outage or a lost device ended the
  process with one `error` line, so the only way to learn what the device had been left on was to replay
  the trace. `pnpm agent run` now reads the device once on the failure path and writes
  `error.last = { deviceId, packageName, currentApp, fingerprint, elements }`, or
  `error.last = { unreadable: "<adb reason>" }` when even that read fails, so an interrupted run cannot
  imply the screen is unchanged. Measured on `282999b1`: a dead model endpoint recorded the settings screen
  and its element count; a missing device recorded the adb refusal.
- **The agent can now see whether the device has a network, and act on it.** The status bar draws Wi-Fi
  and signal icons that carry no accessible name, and screen text such as 网络不佳 is only a symptom. So
  every observation now carries `network: { internet, wifiOn, saved }`, read from the device — a one-packet
  probe for `internet`, the Wi-Fi setting, and the count of saved networks the device could rejoin without
  being handed a password. It is cached for 1.5 s and the cache is dropped after any tap that names the
  network, so a step never acts on a stale answer.
  What the run does with it, all measured on `282999b1`:
  - A goal that asks for the network is recovered end to end by the agent itself: `Systemsettings` →
    `无线网络` switch → the saved access point, ending `done` with `ping` answering (`net-recovery-5`).
  - A goal that does not mention the network gets `blocked` with the cause named instead of a screen-full
    of `WAIT` (`net-recovery-implicit9` and the run above it).
  - After a tap on a network control the run waits out the join (up to 10 s) instead of asking again and
    cancelling it with a second tap, which is what happened before the wait existed.
  - Opening the app that owns the switches is left to code (`RECOVER_NETWORK`), because the model picked
    `Navi` over `Systemsettings` on every attempt. Choosing the network and every target stays with the
    model.
    **Open:** on an implicit goal the model still mis-targets that settings screen — twice it tapped a
    status-bar icon instead of `连接` — so automatic recovery there is not reliable yet.
- **A remote adb server breaks the helper tunnel.** When the device is attached to another machine and reached
  through `ADB_SERVER_SOCKET`, `adb forward` binds its port on _that_ machine, so the helper client's request
  to `127.0.0.1:<port>` goes to the local host and fails. Every observation then fell back to
  `uiautomator dump` and took 12-33 s instead of about 1 s, which also made the model decide on stale
  screens. Fix for this bench: pin the forward and forward it back over the same ssh connection —
  `adb forward tcp:18888 tcp:18888` plus `ssh -N -L18888:127.0.0.1:18888 <host>`; the client reuses an
  existing forward on that port (`existingForward`). A proper fix would have the client tunnel its HTTP
  through `adb shell` or take the helper port from configuration.
- **The helper tunnel port can be pinned.** `adb forward tcp:0 …` picks its port on the machine that runs
  the adb server. When that machine is not this one — a device attached to a remote host and reached with
  `ADB_SERVER_SOCKET` — the chosen port cannot be reached from here, every helper request fails, and each
  observation quietly drops to the 12-33 s `uiautomator` read. `HELPER_PORT` (or `--helper-port`) pins the
  host side, so the same ssh connection that carries the adb socket can forward that exact port back:
  `adb forward tcp:18888 tcp:18888` plus `ssh -N -L18888:127.0.0.1:18888 <host>`. The client opens the
  pinned port when there is no tunnel yet and reuses it when there is. Measured on the remote setup:
  observation through the helper with the pinned port instead of the fallback read.
- **Implicit network recovery: the loop now tries, and gets to the right screen.** Measured on the remote
  setup with `BOOT` Wi-Fi switched off and a goal that never mentions the network:
  - The wait guard sat after the wait budget was spent, so a dead network always ended as
    `loading_timeout`. It now runs first and spends the run's single recovery on the settings app
    (`RECOVER_NETWORK`).
  - The recovery's landing check demanded the word `无线网络`, which the settings app does not show on its
    own menu, so a correct landing was rejected. It accepts the settings menu now.
  - On that screen the helper kept answering with the dock, and the dock is named by position (`- -`), so
    the model tapped chrome. The recovery reads that one screen the slow way (`observeDirect`, ~11 s), and
    the dock and status bar stop being tap targets whenever an app owns the screen.
  - A read error is now retried on any cause, not only the known transient ones, because a remote adb
    connection drops the odd read outright and an aborted run there loses the whole attempt.
    **Still open:** with the correct menu in front (1 蓝牙, 2 连接, 3 显示, 4 声音, 5 语音, 6 系统) the model
    picks `语音` twice at 0.93-0.97 confidence, even when the coach names target 2 and the word 连接. The
    network is therefore not restored on an implicit goal; an explicit goal still recovers end to end.
- **Implicit network recovery works, without naming the menu entry.** A run whose goal never mentions the
  network now restores it: the wait guard spends the run's one recovery on the settings app, the walk reads
  that screen without the helper, taps the menu rows in order, and asks a yes/no question about each page
  until the network page answers 0.8+. Nothing matches a word, so 连接, Network and WLAN are the same
  problem. Rows are ordered by a remembered entry, then by a wording hint, then as they come. The entry that
  worked is written to `.cache/network-memo.json` (not committed, `NETWORK_MEMO_PATH` moves it) keyed by
  device and app, so the next run tries it first; the page question still confirms it, so a stale entry
  costs one tap.
  Two details only a trace shows: a settings row is usually an unnamed container whose name is in a child
  TextView, so the row list has to read the child; and the walk logs what it decided
  (`Walk 6 menu rows: 连接, 蓝牙, …`, `Walk stopped: no menu rows in the tree`) because a silent stop looked
  identical to a wrong answer.
  Measured on `282999b1` with Wi-Fi off and the goal "在导航里搜索重庆…" (`net-recovery-A13`): recovery ran
  16:34:14 → 16:35:56, the device came back online (`ping` answers), and the memo recorded
  `282999b1:com.sgmw.systemsettings: 连接`. About 100 s on the remote bench, dominated by the helper-less
  read (11 s) and the model's own steps; locally it is roughly a quarter of that. The run itself then ended
  `stuck` while looking for the search field it had opened before the detour.
  Re-run with the memo in place (`net-recovery-A14`): the settings app resumed on the page it was left on,
  so the page question answered 0.8+ before any row was tapped — recovery ran 16:40:22 → 16:41:47 (85 s)
  with no walk at all, and the device came back online. The memo path itself is covered by the unit test
  that runs the walk twice and asserts the remembered row is tried first; on this car the app resumed the
  page, so the memo was not needed.
- **The detour ends where it started.** Recovery records the app the run left, and once the network fact
  reads `internet: true` it opens that app again and tells the model `Navi is in front again. The network is
back, so continue the goal from here.` The app in front is not always the goal's app — the Sogou keyboard
  held the foreground on one run and the launch failed (`Could not return to
com.sogou.inputmethod.iot: …`) — so the target must be launchable and not an input method, else the last
  app the run opened.
  Two bugs found by reading traces, both fixed:
  the page question was asked about `snapshot()`'s cached helper image, which right after opening settings is
  still the screen from before the detour, so it answered 0.9997 on the settings menu and the walk tapped
  nothing; it now asks about a fresh `device.screenshot()`, which answers 0.0007 there. And a failed return
  used to be silent, reading exactly like "the return never ran"; it now logs the cause.
  `net-recovery-A19` on `282999b1` with Wi-Fi off: open Navi → recovery opens settings → `here` 0.9998 →
  `Tap 无线网络` → `Return to Navi` → `Tap 重庆 / 搜索`, device back online. The run then ended `stuck` with
  an empty reason, which is the next open item.
- **A stopped run says why.** The repeat guard had a branch that passed the model's decision through
  untouched when the pixels under the tap had not moved, so `result` carried `{"status":"stuck"}` with no
  reason — `net-recovery-A19` ended that way, and eight runs this round did. The reason now names the action
  and the control (`Jev repeated TAP on Tap 重庆. and neither the tree nor the pixels changed…`), and the
  test that used to assert `reason === undefined` asserts the sentence instead.
  Device confirmation (`tc26-recheck`): `Jev repeated TAP on Tap 1 of 3 in ViewGroup. and neither the tree
nor the pixels changed…`. The sentence exposed the next defect instead of hiding it: the model re-tapped an
  unnamed element three times, so the run could not tell which control it was on.
- **The keyboard's own buttons are not targets.** The search results screen carries the Sogou keyboard in
  the same tree as the app: its toolbar is three unnamed buttons at y 452-536, which the tree numbers
  `1 of 3 in ViewGroup`. The model tapped that number twice while looking for a result, and the run stopped as
  a stall. Text entry never taps the keyboard — it goes in through the helper's clipboard — so
  `dropKeyboardCandidates` reads the input method window's `touchable region` from `dumpsys window windows`
  (only when an editable field is focused, and cached by the region check failing safely) and drops the
  clickable elements whose centre falls inside. On `282999b1` with the results screen up the observation went
  from 84 elements to 40, with `keyboardRegion {0,452,1920,992}` and no anonymous clickable left above the
  dock. The next run stopped earlier, at `input_unverified` (typing 重庆 into a field that already held it), so
  the end-to-end tap on a result row is still unproven.
- **A box beats a label that only says where.** Every image request already asks `target_point` (a box) next
  to `tap_target` (a choice over named elements), and the box was only used when the model picked `TAP_POINT`.
  That left the whole round's failures in place: `1 of 3 in ViewGroup` was the Sogou toolbar's logo, `语音` was
  read for `连接`. Now, when the chosen target's name is positional (`N of M in …`, or empty) or the choice
  itself came in under `BOX_FALLBACK_CONFIDENCE` (0.75), the box decides: `elementAt` picks the _smallest_
  clickable element under the marked point, and the decision records
  `boxFallback: {reason, choice, chose}` so a trace shows both the label and what the point hit. Costs nothing
  extra — the answer was already in the request. Unit tests cover both triggers; on-device proof is still
  blocked by the step before it: typing 重庆 stops at `input_unverified` because the read taken while the
  keyboard is up reports `com.android.systemui` with a dock node as the focused field, so the field cannot be
  identified. Loosening that check to "the text is somewhere on screen" makes the strict cases in
  `input-verification.test.mjs` fail, so the fix belongs in how the focused field is identified, not in the
  assertion.
- **`clear` cleared nothing, and the field was never the problem.** The navi search box held 重庆 after a
  `type … clear: true`, so verification compared 重庆 with 重庆重庆 and ended the step as `input_unverified`.
  The clear pressed `KEYCODE_CLEAR` (67, delete) after a selection that never happened: `--meta 1 122` is
  Ctrl+MOVE_END, not Ctrl+A (29), and the Sogou IME does not implement select-all anyway. Clear is now
  MOVE_END followed by forty backspaces in one adb call — deleting past the start of an empty field does
  nothing — with the helper's own clear kept as an optional first try. Device: `重庆重庆` → `''`.
  With typing unblocked the box fallback reached the device: `tc26-box4` step 2 chose the row and logged
  `boxFallback {reason: "label `(none)` says where, not what", chose: "第2个;第2条"}`, the 重庆市 result. The
  run then died on a lost remote adb connection, not on a decision.

## The 10-28 sheets: what the car unit cost per case

`pnpm testcases` runs one row of a QA sheet as a goal and judges the final screen on its own, so the
numbers below are wall time on `282999b1` rather than on an emulator.

- **A point tap expired on a screen that redraws itself.** The freshness gate hashed the whole tree, and
  the launcher rotates its voice-tips card every 7-9 s, so a tap decided on one read was stale by the
  next. Three stale retries ended the run: `f07-2` spent 64 s of model and read time to report
  `unstable_screen` with nothing tapped. A point tap is now judged by the smallest control under the
  point, with the whole-tree hash kept for a point that draws nothing, and the same case reached the
  personal-center screen.
- **A helper that settings call enabled can be dead.** This ROM leaves `com.artemis.helper`'s process
  alive after it unbinds the accessibility service: `enabled_accessibility_services` lists it, its port
  is closed, and every read falls through to `uiautomator dump`, which is the ten-second path. A run
  cannot tell: it just gets slow. `pnpm agent observe` took 33.4 s and 31.7 s per read while that was
  true. `HelperClient.repair()` now restarts the process and re-enables the service once per run, after
  the snapshot path has already failed, and a read costs 6.3 s end to end (helper snapshot alone:
  0.65-1.07 s over five reads).
- **The device here is a remote devpod.** The adb server runs on another machine behind an SSH tunnel
  that forwards 5037 and, for the helper, 27183. `adb forward` therefore listens on the far side, and
  `HELPER_PORT=27183` is what keeps the helper reachable from this checkout; without it every read pays
  for the adb dump. `adb kill-server` killed the server on the other side of the tunnel and left nothing
  local to restart, which reads as `protocol fault (couldn't read status)` on every later command:
  `ssh devpod5 'adb start-server'` is the recovery.
