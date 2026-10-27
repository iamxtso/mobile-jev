# Local ADB backend design

## Problem

Mobile Jev already has a backend-neutral Agent loop. `runAgent()` depends on
four device operations, while policy, candidate discovery, stale checks, and
input verification depend on one normalized observation shape. Local ADB is
the only device backend. It must hold that boundary without weakening mutation
safety or changing the task SSE.

The ADB backend binds one explicit serial. It does not select the
first available device, expose a shell API, or manage multiple devices.

## Usage

The CLI and Studio configure the single ADB device through one configuration.

```js
const device = createAgentDevice({ adbSerial: 'emulator-5554' });
const result = await runAgent({ device, policy, goal, execute: true });
```

`ADB_SERIAL=emulator-5554` configures the same path
without a CLI flag.

Studio receives the ADB device descriptor. It never receives an ADB
command or a general device-control endpoint.

```ts
type StudioDevice = {
  kind: 'adb';
  id: string;
  name: string;
  state: 'ready' | string;
  snapshotUrl: string | null;
  control: 'disabled';
};
```

The browser polls the same-origin PNG snapshot for the ADB device. Browser
device controls stay disabled.

## Shape

### Domain data

```js
/** @typedef {{ adbSerial: string }} DeviceConfig */

/**
 * @typedef {object} AgentDevice
 * @property {() => Promise<unknown>} assertReady
 * @property {() => Promise<Observation>} observe
 * @property {(action: Action, context: { expected: Observation }) => Promise<Receipt | undefined>} act
 * @property {(() => Promise<App[]>) | undefined} listApps
 */
```

The factory is the only module that reads device environment variables. CLI overrides pass a complete config into the same factory.

### Device boundary

`scripts/mobile-agent/device.mjs` remains the source of truth for the existing
normalized observation, `StaleObservationError`, `summarizeState()`, and
`assertFresh()`. This avoids a behavior-preserving file migration in the same
change that adds a backend.

A private `resolveAction()` performs the checks shared by every action dispatch:

1. Validate the action shape and target device.
2. Acquire a current observation.
3. Run the existing fresh-state checks.
4. Resolve coordinates against the current observation.
5. Dispatch exactly one mapped device operation.
6. Build an input verification receipt when applicable.

Only a pre-dispatch stale result throws `StaleObservationError`. A subprocess
failure, malformed UI dump, empty observation, or uncertain post-dispatch
result throws an ordinary error. The Agent does not replay it.

The helper stays private to the device module. It is not a plugin interface and
does not expose transport types.

### ADB adapter

```js
/** @typedef {{ execFile: Function }} AdbCommandRunner */

export class AdbDevice {
  /** @param {{ serial: string, adbPath?: string, runner?: AdbCommandRunner }} options */
  constructor(options) {}

  async assertReady() {}
  async observe() {}
  async listApps() {}
  async screenshot() {}
  async act(action, { expected }) {}
}
```

The runner always uses `execFile` with `shell: false` and these argument
shapes:

```text
adb -s SERIAL get-state
adb -s SERIAL shell wm size
adb -s SERIAL shell dumpsys window
adb -s SERIAL exec-out uiautomator dump /dev/tty
adb -s SERIAL shell cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER
adb -s SERIAL shell am start -n PACKAGE/ACTIVITY
adb -s SERIAL shell input tap X Y
adb -s SERIAL shell input swipe X1 Y1 X2 Y2 DURATION
adb -s SERIAL shell input text VALUE
adb -s SERIAL shell input keyevent CODE
```

The adapter rejects a missing serial, an empty result, malformed XML, and
unsupported text before dispatch. Text is limited to a documented Android-safe
character set for the first version. Input still returns
`prepareInputVerification()` when the focused field can be identified. The
existing read-only `confirmInput()` flow remains the success authority.

The observation adapter reads screen size, foreground activity, and the
UIAutomator hierarchy, then converts them to the raw state
accepted by `summarizeState()`. A real XML parser validates the document at
this boundary. Tree-path element IDs and fingerprints remain derived by the
existing functions.

These separate ADB reads can observe different instants. The first version
accepts that limitation and records it as a known race. It does not add a
multi-command atomicity protocol.

### Studio

The API creates the same configured device used by `web-runner.mjs`.

- ADB returns a descriptor with a same-origin snapshot URL.
- ADB screenshot bytes never pass through JSON or the Agent observation path.
- ADB browser touch, keyboard, clipboard, and system-key controls are disabled.
- The serial may appear as the local device identifier, but no ADB server
  socket, executable path, environment variable, or command is returned.
- ADB mode requires the TypeSafe credential used by the Agent policy.

`server/store.mjs` and task SSE remain unchanged.

## Synthesis decision

Candidate 2 is the base. It earned 27/30 in the cross-judge and defined the
complete ADB Studio preview boundary.

Two ideas from candidate 1 were grafted into it. First, `device.mjs` remains
the shared observation and action-safety owner instead of splitting device
code into new files. Second, shared target resolution stays behind a
private helper rather than duplicating validation at each call site.

The status-only Studio proposal from candidate 1 was rejected. A read-only PNG
snapshot gives the local path real screen-level verification. The larger
`observation.mjs` migration from candidate 2 was
rejected because it adds churn without changing the public contract.

## Tradeoffs accepted

- The first version uses one ADB serial and has no device picker.
- ADB Studio shows periodic screenshots instead of a live stream.
- The first version rejects text outside the tested Android-safe character set.
- The ADB observation is a sequence of commands and can span a screen
  transition.
- The backend is ADB-only, so one concrete device and one small factory
  exist.

## Alternatives considered

A local HTTP shim that emulated a remote device API was rejected. It would expose a
larger network protocol, duplicate transport policy, and make browser access
more dangerous.

A shared abstract device base class was rejected. The existing four-method
structural contract is sufficient. A base class would add inheritance without
hiding new behavior.

A fixed list of prepared tap scripts was rejected. It would not generalize
beyond the demo and would violate the Agent's policy boundary.

## Element identity

ADB element IDs such as `ui.0.0.0.0` are snapshot-local paths through the
UIAutomator tree. They identify a node only within one observation and must not
be persisted across observations or screens. Cross-screen identity should use
`resourceId` when available, plus text, label, and bounds. The Agent uses the
snapshot-local ID to resolve an action target, then rechecks the observation
before dispatch.

## Open questions and risks

- Which non-ASCII characters can a target Android version accept through
  `input text`? The first implementation answers this conservatively by
  rejecting untested characters.
- Does every supported device emit clean XML through `uiautomator dump
/dev/tty`? The emulator confirms it does. Real-device verification remains
  required.
- How should screenshot cadence adapt under load? Begin at one snapshot every
  500 ms while the Studio tab is visible and make no liveness guarantee.

## Verification status

The offline parser, fixed-argv ADB actions, orientation handling, screenshot
polling, and input verification tests are implemented on this branch. The
remaining verification gap is live-device mutation testing; the current device
checks are read-only.
