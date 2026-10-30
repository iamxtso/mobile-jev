---
name: testcase-ledger
description: Model check of the `artifacts/testcases/results.jsonl` write protocol — the lock file, the read-modify-write, the atomic rename, and the `--resume` / `--summary` readers. Use when a change touches `recordResult`, `previousRuns`, `oneLinePerCase`, the case loop in `scripts/testcases.mjs`, or anything that writes or reads the benchmark verdicts; run it before publishing a change to them, and when a night of `pnpm testcases` left a verdict missing, duplicated, or a run stopped on "The results file stayed locked".
---

# The benchmark verdict ledger

`pnpm testcases` records one line per manual test case in `artifacts/testcases/results.jsonl`. That file
is the repo's evidence that a case passed: the morning summary, `--resume`, and any published number
come from it, and `AGENTS.md` requires unsuccessful attempts to be recorded as well as successful ones.
Losing or duplicating a line makes the evidence say something the device never did.

This skill model checks the write protocol. It does not check the verdicts themselves.

## What it proves

Four promises, each with the harm when it breaks:

| property                 | in one sentence                                                                                               | the harm when it breaks                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `OneLinePerCase`         | after a write, the file holds at most one line per case id                                                    | `--resume` and the summary disagree about which verdict counts                                           |
| `NoVerdictLost`          | a verdict already in the file is still there after the next one is written; only the same case may replace it | a case the device passed is reported as not run, or a failure disappears                                 |
| `ReadersSeeWholeContent` | a reader never sees a file with a line it cannot parse                                                        | `--summary` and `--resume` throw or silently read "nothing yet"                                          |
| `LockHeldByALiveWriter`  | the lock file is only held by a runner still inside its critical section                                      | a killed runner forbids every later record: each one waits out its retries and throws, and the run stops |

A pass covers those four properties over the model's bound, not over the whole tool. The bound is two
runners, two cases, two verdicts, and retries shortened from the code's `attempt > 100` to 2 — only
the fact that the wait is finite matters, and the model says so.

## Run it

```sh
.agents/skills/testcase-ledger/run.sh            # about five seconds
.agents/skills/testcase-ledger/run.sh damaged    # one configuration, full TLC output in tmp/tla/ledger/
```

Exit code 0 means every configuration behaved as this skill records, including the two findings below.
No device and no API key. A JRE is needed; the first run fetches the pinned TLA+ tools (1.8.0,
sha256 checked) into the gitignored `tmp/tla/`, and every run after that is offline. It is deliberately
not part of `pnpm check`, which must stay offline.

The script runs two things:

- `anchors.mjs` greps `scripts/testcases.mjs` and `scripts/mobile-agent/testcase-suite.mjs` for the
  facts the model assumes — the exclusive create, the read inside the lock, the rename, the `finally`,
  the catch-all read. A `GONE` line means the code moved and the model may now describe a protocol
  nobody runs.
- TLC checks each configuration: `baseline` (the code as it is, must pass), `damaged` and
  `stranded-lock` (the two findings), `no-lock` and `direct-write` (the code with its lock, or its
  rename, taken away — the proof that these invariants are able to fail, and that those two lines are
  what make the properties hold).

Read a result with the pstack `/statechart` skill. It turns a violation into the shortest path to the
bad state in plain words, which is what a finding needs, and draws a passing run as the chart of how
the ledger moves.

## Findings on record

Both are current behavior at commit `ad21b37`, reported rather than fixed. Neither has a test.

**1. One unreadable line erases every other case's verdict.** `previousRuns` (scripts/testcases.mjs:73)
wraps `readFile` _and_ `JSON.parse` in one `try … catch` that returns `[]`, and `recordResult` then
commits only the new entry. The model's `damaged` configuration:

1. runner `r1` records case `c1`; the file holds `c1`.
2. a line that is not JSON appears in the file — what an interrupted append-only run of the older
   version leaves, or a hand edit.
3. runner `r2` records `c2`: `previousRuns` throws on that line, the catch turns the whole file into
   "no results yet", and the rename replaces it with `c2` alone.

`c1` is gone and nothing is printed. Deliberately adding a `damaged` case to the model was the only
way to see it: the code writes only well-formed lines, so its own writes never produce the input that
triggers it.

**2. A killed runner strands the lock.** `recordResult` creates `results.jsonl.lock` with `flag: 'wx'`
and removes it in a `finally`, which does not run when the process is killed (SIGKILL, a power cut, a
`Ctrl-C` on a closing laptop, a killed adb call). The model's `stranded-lock` configuration: `r1`
acquires the lock, `r1` dies while holding it, and the lock file stays. Every later record then sees
`EEXIST`, makes 101 attempts 100 ms apart, and throws `The results file stayed locked` — so the
benchmark run aborts instead of recording anything, until a human deletes the file.

## What is verified, and what is not

Verified: the ordering and atomicity of `recordResult` (scripts/testcases.mjs:94-116), the read of
`previousRuns` (:73-85), the "last line wins" dedupe of `oneLinePerCase`
(scripts/mobile-agent/testcase-suite.mjs:156), and what a `--summary` / `--resume` reader
(scripts/testcases.mjs:243 onward) can see, for two concurrent runners.

Not verified, and not implied by a pass:

- `verdictOf`, `judgeExpected`, `expectationPreexists` — whether a verdict is _right_ about the phone.
- `runCase`, the evidence files under `artifacts/testcases/<id>/`, the agent, the device.
- Which cases `--resume` selects, the sheet parsing in `xlsx.mjs`, `summaryMarkdown`.
- Anything holding more than one lock, or writes to the file by other tools. The model also assumes a
  runner's critical section is short enough for another runner's 101 retries, which is a timing
  assumption the model cannot state.
- The studio (`apps/jev-studio`) and `pnpm verify`, which never touch this ledger.

## When it fails

1. Run the script. If an anchor is `GONE`, the model is out of date: update
   `testcase_ledger.tla`, or say the difference is a finding on the code. Do not edit the code to make
   the anchor green.
2. If only TLC reports something, read the trace with `/statechart`. It is a real bug when every step
   in the trace is a step the code can take — the anchor list is exactly that inventory. It is a
   modeling error when the trace needs something the code cannot do, such as two runners inside the
   critical section at once while `UseLock` is `TRUE`.
3. A recorded finding that now passes is news: the bug was fixed silently. Update the expectation in
   `run.sh` and this file in the same change.
4. A new violation, in a configuration that used to pass, is a regression in the protocol. Leave the
   invariant alone and report the counterexample in the code's words.

## Keeping it in step

Coverage record — the verification describes these, and nothing else:

| verified                                                                            | at        |
| ----------------------------------------------------------------------------------- | --------- |
| `scripts/testcases.mjs`: `recordResult`, `previousRuns`, the summary/resume readers | `ad21b37` |
| `scripts/mobile-agent/testcase-suite.mjs`: `oneLinePerCase`                         | `ad21b37` |

`ad21b37` is the commit at which this was last confirmed to describe the code. When a change touches
those functions, run the script before publishing; if it passes unchanged, and the anchors agree, move
the commit forward to the change that was confirmed. If it does not pass, the verification needs
another look — see `/maintain-formal-verification-skill` for that pass.

## Files here

| file                                | what it is                                                        |
| ----------------------------------- | ----------------------------------------------------------------- |
| `testcase_ledger.tla`               | the model; every action names the code line it stands for         |
| `baseline.cfg` … `direct-write.cfg` | one configuration each, with its expected result in the header    |
| `run.sh`                            | anchors plus all configurations, compared with those expectations |
| `anchors.mjs`                       | the model's premises, checked against the source                  |
