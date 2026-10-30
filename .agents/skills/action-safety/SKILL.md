---
name: action-safety
description: Bounded exploration of the run loop's action safety in `scripts/mobile-agent/agent.mjs` — the freshness gate before input, the stale-only retry, the repeated-action guard, the longer-hold escalation and the step budget. Use when a change touches `runAgent`'s decide/act/read loop, `assertFresh`, `resolveAction` or `AdbDevice.run`, and before publishing a change to the way a decision becomes a tap, a hold or a key press; run it when a run tapped something twice, kept going after a dropped connection, or mutated past its step limit.
---

<!-- sync-commit: ad21b37 -->

# The run loop's action safety

`AGENTS.md` states the rule the loop cannot break: keep navigation actions sequential, retry only a
stale decision that was refused before input, and never replay an uncertain mutation. A tap sent twice
on a delete, a send button or a Wi-Fi switch undoes what the goal asked for, and the phone does not say
so — the second tap lands on the same control and looks exactly like the first.

This skill checks four promises that keep that rule, over every order of the phone's answers to a short
run, running the real `runAgent`. Three hold at `ad21b37`; the fourth has one hole, recorded below.

## What it proves

| property                | in one sentence                                                                          | the harm when it breaks                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `NoStaleDispatch`       | input is sent only while the screen is still the one the decision was made on            | the tap aims at a control that has moved, so it lands on whatever is there now                                |
| `NoSameActionTwice`     | the same action is never sent twice while no read showed the screen move                 | a toggle is switched back off, a delete is asked for again, a message is sent twice                           |
| `NoInputAfterUncertain` | a mutation whose outcome the loop never learned ends the run, so nothing further is sent | the loop acts on a screen it knows nothing about, and a retry repeats a mutation that may already have landed |
| `RespectsStepLimit`     | a run dispatches mutations in at most `maxSteps` steps                                   | the run keeps tapping past its budget, and a benchmark's step limit stops meaning anything                    |

`NoInputAfterUncertain` is the one that fails today, in the second press of a long hold: see
[Findings on record](#findings-on-record).

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

Exit code 0 means the loop behaves as this skill records: three promises hold, the fourth fails only on
the finding below, and every broken variant of those promises is still caught where the code passes.
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

**1. A second, longer press whose outcome is unknown does not end the run.** `ad21b37`, unfixed, no
test. 50 of the 9604 schedules. The transport rule alone is tested (adb-device.test.mjs:357, "an
uncertain ADB mutation fails once and is not replayed"); the loop's second press is not.

The loop presses a control a second time, held 3000 ms, when the first press drew nothing
(`longerHold`, agent.mjs:48). That second press sits in a `try … catch` that records
`entry.holdRefused = true` and keeps the read from _before_ the press (agent.mjs:824-840), while the
press the model actually asked for is rethrown on any non-stale error (agent.mjs:682). So an unknown
outcome ends the run in one place and is swallowed in the other.

`.agents/skills/action-safety/run.sh long-press noop,uncertain changes-its-mind`:

1. step 1: the model asks for `long-press` on `Note`. The phone takes the input and draws nothing.
2. the loop presses the same control again, held 3000 ms. The phone takes that input too, and the
   connection drops before it answers.
3. the loop catches the error as a refused press, keeps its read from before the press, and continues
   to step 2.
4. the model asks for a tap. The gate refuses it as stale — the screen did move — the loop re-reads,
   and then sends the tap.

Why it matters: after a 3-second hold the loop does not know what the phone did. That hold is escalated
precisely because a short press may not have released a touch-locked screen or opened a context menu,
which are states where a second action is not free. The run continues to spend steps on the result, and
the failure never reaches the trace as a failure — `holdRefused` reads like a refusal, not like a lost
connection.

Why it is not the replay `AGENTS.md` forbids: the same press is not sent again, because the
repeated-action guard stops that, and every later input still passes the gate, so nothing is aimed at a
screen two versions old. What is broken is the weaker promise in the table, that an unknown outcome
ends the run.

What would close it: treat a non-stale error from that second press the way the primary press treats
it — end the run and report it — instead of folding it into `holdRefused`. Not applied here, because it
is a product decision and not what this skill was asked to change.

## What is verified, and what is not

Verified: `runAgent`'s decide → act → read loop, the stale retry and its budget, the repeated-action
guard, the longer-hold escalation and the step budget in `scripts/mobile-agent/agent.mjs`; the freshness
gate as `resolveAction` uses it, and the one-attempt mutation rule of `AdbDevice.run`, in
`scripts/mobile-agent/device.mjs`.

Not verified, and not implied by a pass, or by the finding:

- `open-app`, `HOME`, `BACK` and the other navigation actions: `resolveAction` dispatches them before
  the gate on purpose, so the double does not model them.
- `type`, `clear` and `key` actions, and `input-verification.mjs`: the exploration's phone has no
  editable field, so typing and the read that confirms the typed value are outside it.
- The network recovery's own taps inside `runAgent`, which call `device.act` outside `history` and
  outside the repeated-action guard.
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
   record it here with its schedule and its count.
4. The recorded finding passing is news: the hole was closed, silently. Remove it from this file and
   from the `finding` list in `run.sh` in the same change.

## Keeping it in step

Coverage record — this exploration describes these, and nothing else:

| verified                                                                                                                              | at        |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `scripts/mobile-agent/agent.mjs`: `runAgent`'s loop, the stale retry, the repeated-action guard, the hold escalation, the step budget | `ad21b37` |
| `scripts/mobile-agent/device.mjs`: `assertFresh`, `resolveAction`'s gate, `AdbDevice.run`'s one-attempt mutation                      | `ad21b37` |

`run.sh` reads the sync commit from the `<!-- sync-commit: -->` line above and lists every commit that
touched `scripts/mobile-agent` since then. Move that line forward only after confirming the exploration
still describes the loop at the new commit; when it does, say in one line what changed and why the
properties still cover it.
