---
name: action-safety
description: Bounded exploration of the run loop's action safety in `scripts/mobile-agent/agent.mjs` — the freshness gate before input, the stale-only retry, the repeated-action guard, the longer-hold escalation and the step budget. Use when a change touches `runAgent`'s decide/act/read loop, `assertFresh`, `resolveAction` or `AdbDevice.run`, and before publishing a change to the way a decision becomes a tap, a hold or a key press; run it when a run tapped something twice, kept going after a dropped connection, or mutated past its step limit.
---

<!-- sync-commit: c29bacb -->

# The run loop's action safety

`AGENTS.md` states the rule the loop cannot break: keep navigation actions sequential, retry only a
stale decision that was refused before input, and never replay an uncertain mutation. A tap sent twice
on a delete, a send button or a Wi-Fi switch undoes what the goal asked for, and the phone does not say
so — the second tap lands on the same control and looks exactly like the first.

This skill checks four promises that keep that rule, over every order of the phone's answers to a short
run, running the real `runAgent`. All four hold at `18a6746`.

## What it proves

| property                | in one sentence                                                                          | the harm when it breaks                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `NoStaleDispatch`       | input is sent only while the screen is still the one the decision was made on            | the tap aims at a control that has moved, so it lands on whatever is there now                                |
| `NoSameActionTwice`     | the same action is never sent twice while no read showed the screen move                 | a toggle is switched back off, a delete is asked for again, a message is sent twice                           |
| `NoInputAfterUncertain` | a mutation whose outcome the loop never learned ends the run, so nothing further is sent | the loop acts on a screen it knows nothing about, and a retry repeats a mutation that may already have landed |
| `RespectsStepLimit`     | a run dispatches mutations in at most `maxSteps` steps                                   | the run keeps tapping past its budget, and a benchmark's step limit stops meaning anything                    |

The one second press the properties allow is the loop's own longer hold: a `long-press` that drew
nothing is pressed again at 3000 ms (`HOLD_ESCALATION_MS`), which is a different action, so it is not a
replay. Everything else — a tap, a swipe, a key, a typed value — is sent once per fresh observation.

## The bound

Seven answers from the phone, for every act of a run:

| answer         | what the phone does                                                             |
| -------------- | ------------------------------------------------------------------------------- |
| `applied`      | the input lands and the screen changes                                          |
| `noop`         | the input lands and the screen does not change                                  |
| `stale`        | another window redraws before the gate, so the decision is refused before input |
| `refused`      | the gate passes but the target is gone, so nothing is sent                      |
| `uncertain`    | the input lands and the connection drops before the answer arrives              |
| `unknown-read` | the input lands and the next read comes back as system chrome only              |
| `read-fails`   | the input lands and every read after it fails                                   |

Every sequence of up to four of those, for a tap first and for a hold first, with a model that repeats
itself and a model that changes its mind every step, with `maxSteps` 2: 2 × 2 × 7⁴ = 9604 runs. A
longer run repeats the same branches, so the bound is where the exploration stops, not where the
promises do.

## Run it

```sh
.agents/skills/action-safety/run.sh                                             # about a second
.agents/skills/action-safety/run.sh long-press noop,uncertain                    # one schedule, in the loop's words
.agents/skills/action-safety/run.sh long-press noop,uncertain changes-its-mind   # the finding, step by step
```

Exit code 0 means all four promises hold, every broken variant of them is still caught where the code
passes, and the code still offers what the exploration assumes.
No device, no network, no API key: this never leaves the repository. It is deliberately not part of
`pnpm check`, which must stay offline and fast, but it runs offline too and costs about a second.

The script runs three things:

- `anchors.mjs` greps `agent.mjs` and `device.mjs` for the facts the exploration assumes — the gate
  before the one dispatch, what a stale decision compares, the transport that reports an unknown
  mutation instead of retrying it, the stale-only catch, the repeated-action guard, the hold escalation,
  the step budget. A `GONE` line means the code moved and a pass would now mean nothing.
- `explore.mjs` runs the 9604 schedules against `scripts/mobile-agent/agent.mjs` and reports each
  property as `ok` or `GONE`, with one counterexample and the command that prints it in the loop's words.
- `explore.mjs --mutants` copies `scripts/mobile-agent/` into `tmp/action-safety/mutants/`, removes one
  mechanism per copy, and requires the corresponding property to fail on a schedule the unpatched code
  passes. A property that survives its own broken variant is not being checked at all.

### Why the code and not a model checker

The question is which branch of _this_ loop follows a given phone answer: twelve ways to end a run, a
stale retry that does not consume a step, a guard keyed on the control's own state, and a hold
escalation that is only for one action type. Written as a TLA+ model that would be a second
implementation of the loop, and the two would drift the first time either changed. So the exploration
runs the loop itself and fakes only the phone, and `anchors.mjs` pins the contract the phone double
stands in for. The concurrency here is between the agent and one device, which is what the schedule
enumerates exhaustively; the ledger's cross-process write protocol is the kind of question where a
TLA+ model earns its keep, and `.agents/skills/testcase-ledger` already has one.

## Findings on record

None at `18a6746`. All four properties hold, and each one is caught by the removal it guards:

| variant                  | what it removes                                        | property it breaks      |
| ------------------------ | ------------------------------------------------------ | ----------------------- |
| `replay-uncertain`       | the stale-only catch, so an unknown outcome is retried | `NoInputAfterUncertain` |
| `repeat-the-same-action` | the `repeated.has(signature)` guard                    | `NoSameActionTwice`     |
| `no-freshness-gate`      | `assertFresh` itself                                   | `NoStaleDispatch`       |
| `no-step-limit`          | the `step >= maxSteps` check before the action         | `RespectsStepLimit`     |

Five mechanisms carry the promises: the gate in `resolveAction` (`device.mjs`), the transport's
one-attempt mutation reported as `MutationUncertainError` (`AdbDevice.run`), the loop's
`instanceof StaleObservationError` catch, the `instanceof MutationUncertainError` rethrow in the second
press of a hold, and the repeated-action guard that runs before `device.act`. If a change moves any of
them, run the script before deciding the change is fine.

One hole was found here and closed at `18a6746`: the escalated second press of a hold swallowed its own
unknown outcome and the run continued, where the press the model asked for ends it. The
`uncertain-ends-the-run` anchor keeps that closed.

## What is verified, and what is not

Verified: `runAgent`'s decide → act → read loop, the stale retry and its budget, the repeated-action
guard, the longer-hold escalation and the step budget in `scripts/mobile-agent/agent.mjs`; the freshness
gate as `resolveAction` uses it, and the one-attempt mutation rule of `AdbDevice.run`, in
`scripts/mobile-agent/device.mjs`.

Not verified, and not implied by a pass:

- `open-app`, `HOME`, `BACK` and the other navigation actions: `resolveAction` dispatches them before
  the gate on purpose, so the double does not model them.
- `type`, `clear` and `key` actions, and `input-verification.mjs`: the exploration's phone has no
  editable field, so typing and the read that confirms the typed value are outside it.
- The network recovery's own taps inside `runAgent`, which call `device.act` outside `history` and
  outside the repeated-action guard. The three recovery dispatches (the settings `open-app`, the
  single guess tap, the menu-row walk) and the Wi-Fi association wait are covered by
  `scripts/mobile-agent/harness.test.mjs` instead: the 2.5 s association waits and the settings-app
  walk would not fit the exploration's bound, so the schedules stay out of them.
- The pixel and glyph path (`pixels.mjs`, `policy.readsControlChange`): the double has no screenshot, so
  `goalMet` is always absent and a `done` can only come from the policy. The model in the exploration
  never answers done, so the reporting half of `AGENTS.md` is not what these schedules check.
- The accessibility helper, the studio, `pnpm verify` and `pnpm testcases`.
- Two assumptions the double makes. A read always describes the screen as it is at that moment, so a
  tree that lags a redraw is modelled by `noop` — to the loop the two are the same answer. And the
  exploration runs with `settleTimeoutMs: 0`, so the first read after an action is the verdict; the
  loop's default settlement window can only add reads that turn "unchanged" into "changed", which is
  the direction that stops a repeat, so the exploration is the pessimistic case.

## When it fails

1. Run the script. A `GONE` property that is not the finding above is a real change in what the loop
   promises, and the script prints the schedule that shows it; replay it with
   `run.sh <action> <schedule> [policy]` to read it in the loop's words.
2. A `GONE` anchor is not a finding on the code: it means the exploration no longer describes the loop.
   Bring `explore.mjs` and the anchor list in line with the code as it is now first, then judge the
   properties.
3. A violation at a step the code can really take is a finding. Do not weaken the property and do not
   change the loop to make it pass unless the task asks for it; report the counterexample instead, and
   record it here with its schedule and its count. `run.sh` then fails until the record says so.
4. A finding recorded here that starts passing is news: the hole was closed, silently. Say so, and
   drop it from this section in the same change.

## Keeping it in step

Coverage record — this exploration describes these, and nothing else:

| verified                                                                                                                              | at        |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `scripts/mobile-agent/agent.mjs`: `runAgent`'s loop, the stale retry, the repeated-action guard, the hold escalation, the step budget | `18a6746` |
| `scripts/mobile-agent/device.mjs`: `assertFresh`, `resolveAction`'s gate, `AdbDevice.run`'s one-attempt mutation                      | `c29bacb` |
| `scripts/mobile-agent/harness.test.mjs`: the recovery dispatches' uncertain-outcome rule, the Wi-Fi association wait's repeat guard   | `7aa9605` |

`run.sh` reads the sync commit from the `<!-- sync-commit: -->` line above and lists every commit that
touched `scripts/mobile-agent` since then. Move that line forward only after confirming the exploration
still describes the loop at the new commit; when it does, say in one line what changed and why the
properties still cover it.
