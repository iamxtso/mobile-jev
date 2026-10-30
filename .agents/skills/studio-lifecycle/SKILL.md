---
name: studio-lifecycle

description: TLA+ model check of the studio's run lifecycle in `apps/jev-studio/server/store.mjs` — the single-run guard, the one terminal status per run, `stop`'s early return, the SIGTERM→SIGKILL escalation, and the exit-code mapping. Use when a change touches `createStore`, `start`, `stop`, `finish`, or the child's `stdout`/`error`/`close` handlers; run it when the studio answered "a task is already running" with no task alive, showed a run as stopping forever, or reported a run as succeeded that the task never finished.
---

<!-- sync-commit: 44764bf -->

# The studio's run lifecycle

The studio drives one device, so it holds one task at a time: `start` refuses while a run is `running`
or `stopping`, and the run is reported finished only by the child's `close`. If that accounting goes
wrong, the harm is not a wrong tap — it is a studio that refuses every later task, or a run history
that claims a task succeeded when it did not.

This skill model checks the lifecycle. It does not check the task itself.

## What it proves

| property             | in one sentence                                                            | the harm when it breaks                                                                                        |
| -------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `SingleActive`       | at most one run is `running` or `stopping` at any time                     | two tasks drive the same device, so their taps interleave and neither trace means anything                     |
| `EndedIsFinal`       | a run the store has reported never changes status again                    | a finished run flips back to `stopping`, no `close` will ever come, and every later `start` answers 409        |
| `StoppingIsArmed`    | every `stopping` run has the 3 s SIGKILL behind it                         | a task that ignores SIGTERM holds the device until the studio is restarted                                     |
| `SucceededNeedsDone` | a run is reported `succeeded` only when the task printed `outcome: "done"` | the history says a goal was met that never was; the exit code of a killed or half-finished run decides nothing |

A pass covers those four over the model's bound, not over the whole studio. The bound is two run ids,
three task outcomes (`done`, `blocked`, `step_limit`), exit codes 0 and 1, and every interleaving of
start, spawn, stop, result, error, close and the 3 s timer: 5,724 distinct states in the baseline.

## Run it

```sh
.agents/skills/studio-lifecycle/run.sh                   # about ten seconds
.agents/skills/studio-lifecycle/run.sh stop-after-end    # one configuration, full TLC output in tmp/tla/studio/
```

Exit code 0 means every configuration behaved as this skill records. No device and no API key. A JRE is
needed; the first run fetches the pinned TLA+ tools (1.8.0, sha256 checked) into the gitignored
`tmp/tla/`, shared with `.agents/skills/testcase-ledger`, and every run after that is offline. It is
deliberately not part of `pnpm check`, which must stay offline.

The script runs three things:

- `anchors.mjs` greps `apps/jev-studio/server/store.mjs` for the facts the model assumes — the
  `active()` guard, the run's first status, `finish`'s early return and its two writes, the five
  branches of the exit mapping, `stop`'s early return, the SIGTERM plus the timer that only kills
  while the id is still tracked, and the flood path that kills through that same timer. A `GONE` line
  means the code moved and the model may now describe a store nobody runs.
- It fails when a `.cfg` in this directory is not one of the configurations the script runs. A
  configuration nobody runs cannot fail, so it must either be named here or deleted.
- TLC checks each configuration: `baseline` (the store as it is, must pass) and four variants with one
  mechanism taken away (the proof that these invariants are able to fail, and that those lines are what
  make them hold).

| configuration          | what it takes away                                          | expected                      |
| ---------------------- | ----------------------------------------------------------- | ----------------------------- |
| `baseline`             | nothing                                                     | pass                          |
| `two-active`           | `active()` no longer refuses a second start                 | `violated:SingleActive`       |
| `stop-after-end`       | `stop` no longer returns early for a run that already ended | `violated:EndedIsFinal`       |
| `no-kill-timer`        | `stop` never arms the 3 s SIGKILL                           | `violated:StoppingIsArmed`    |
| `any-outcome-succeeds` | a clean exit is reported as success whatever the task said  | `violated:SucceededNeedsDone` |

### Why a model, and not the code

This is the one place in the repo where the question really is about a design: four variables, seven
events, and one obligation — exactly one status per run, and the device released by it. The model is
183 lines and every action names the line of code it stands for, so a reviewer can check it against
`store.mjs` in one sitting, and `anchors.mjs` reports when the code moves away from it. The store also
imports `node:child_process`, so there is no way to drive the real module through every order of
child events without a hand-written double; the model is that double, written in the language that can
exhaust it. The run loop is different — 900 lines of branches that no model could keep up with — and
`.agents/skills/action-safety` drives the real code there instead.

Read a violation with the pstack `/statechart` skill. It turns the shortest path to the bad state into
plain words, which is what a finding needs, and draws a passing run as the chart of how the lifecycle
moves.

## Findings on record

Two, both closed by the model they now describe. Both were found by driving the real store, and neither
test nor TLC configuration reached them before.

1. **A task that floods stdout was reported ended while it still held the device.** The `stdout`
   handler past the 1 MB limit killed the child with `SIGTERM` alone, then `finish` deleted it from
   `processes`, so the run read `failed` (`active()` no longer saw it) while the child kept running;
   `stop` could not reach it, and a second `start` was accepted on top of it. The run now sets its
   error and goes through `terminate`, the same `SIGTERM` plus armed 3 s `SIGKILL` that `stop` uses, so
   a flooding task stays `stopping` and `SingleActive` covers it. `store.test.mjs` pins it.

2. **A result printed after the run ended was written onto it.** The `stdout` handler had no `ended`
   guard (the model's `Result` requires an active status), so a late `result` line gave a `failed` run
   `outcome: "done"`, and `close` could not correct a report already latched. The handler now returns
   for an ended run. `store.test.mjs` pins it.

One difference from the code is worth knowing rather than reporting: the model treats a SIGKILL as
effective. `store.mjs` swallows a failed kill ("Process already exited."), so a task that survives both
signals — uninterruptible sleep, or a detached process the store no longer matches — leaves the run
`stopping` until the studio restarts. Nothing in the store can fix that, and `StoppingIsArmed` is what
the store can promise.

## What is verified, and what is not

Verified: `createStore`'s run bookkeeping in `apps/jev-studio/server/store.mjs` — `start`, `finish`,
`stop`, the flood path past the 1 MB output limit, and the `stdout` / `error` / `close` handlers — for
two runs and every order of their events.

Not verified, and not implied by a pass:

- `checkRequest`, the route handlers, and `web-runner.mjs` — what a browser may ask for.
- The task itself, and the `decision` / `action` / `error` events on stdout other than `result`: the
  model reads only the outcome.
- The 30-run history cap, `list`, `get`, `clear`, `subscribe`, and the global singleton with its
  `process.once('exit')` handler.
- Real process behaviour: signals, process groups on Windows (the code kills `-pid` off win32), and the
  3 s timer's real duration. The model assumes the child eventually exits or is killed.
- `apps/jev-studio/server/store.test.mjs`, which covers the ordinary paths; this skill covers the
  orders a test does not write down.

## When it fails

1. Run the script. If an anchor is `GONE`, the model is out of date: update `studio_lifecycle.tla`, or
   say the difference is a finding on the code. Do not edit the code to make the anchor green.
2. If only TLC reports something, read the trace with `/statechart`. It is a real bug when every step
   in the trace is a step the store can take — the anchor list is exactly that inventory. It is a
   modeling error when the trace needs something the store cannot do, such as a `stop` on an ended run
   while `StopChecksEnded` is `TRUE`.
3. A recorded finding that now passes is news: the bug was fixed silently. Update the expectation in
   `run.sh` and this file in the same change.
4. A new violation, in a configuration that used to pass, is a regression in the lifecycle. Leave the
   invariant alone and report the counterexample in the store's words.

## Keeping it in step

Coverage record — the verification describes these, and nothing else:

| verified                                                                                                                              | at        |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `apps/jev-studio/server/store.mjs`: `start`, `finish`, `stop`, `terminate`, the flood path, the `stdout` / `error` / `close` handlers | `44764bf` |

`run.sh` reads the sync commit from the `<!-- sync-commit: -->` line above and lists every commit that
touched `apps/jev-studio/server` since then. Move that line forward only after confirming the model
still describes the store at the new commit; when it does, say in one line what changed and why the
properties still cover it.
