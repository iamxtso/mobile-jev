# Manual test-case sheets

The QA sheets in `tmp/testcases_<date>/*.xlsx`, run as agent goals on the device. One row of the sheet is one case: `前置条件` and `测试步骤` become the goal, `预期结果` becomes the question the final screen is judged on.

## How to get to it (user POV)

From a terminal, with the device connected and the sheets in place. Nothing here is exposed in the studio.

```sh
pnpm testcases --list                                  # id, group, title for every case
pnpm testcases --run --file f07 --limit 5              # one sheet, five cases
pnpm testcases --run --group 导航 --steps 12           # one group
pnpm testcases --run --resume                          # continue an interrupted run
pnpm testcases --summary                               # markdown from the results so far
```

Case ids are `<sheet>-<row>`: `f07-2` is the second sheet of the directory, row 2. The sheets are sorted by file name, so an id stays valid as long as the sheet directory does not change.

## What a case does

1. Press HOME, then read the screen and take a screenshot (`before.png`, `before.json`).
2. Run the goal through the agent loop with the step budget, writing `trace.jsonl` as it goes.
3. Read the screen again (`after.png`, `after.json`).
4. Ask one question about that screenshot: does it show the sheet's expected result? (`noul`, cutoff 0.8, the same primitive that refuses an unearned DONE.)

The model's status and the screen's verdict are recorded separately, and `verdict` combines them:

| verdict          | meaning                                                        |
| ---------------- | -------------------------------------------------------------- |
| `pass`           | the model said done and the screen shows the expected result   |
| `pass_unclaimed` | the screen shows it, the model ended some other way            |
| `claimed_only`   | the model said done and the screen disagrees                   |
| `fail`           | neither                                                        |
| `error`          | the run or the read died (device, transport)                   |

## Evidence

`artifacts/testcases/<id>/` holds `before.png`, `before.json`, `trace.jsonl`, `after.png`, `after.json`, `run.json`. `artifacts/testcases/results.jsonl` gets one line per case and `summary.md` is rebuilt from it, worst first. Nothing here is committed.

## Gotchas

- One device, so cases run one at a time, and a case costs about 30 s at best and 3 min when the agent stalls: 8 to 15 steps at 2 to 6 s per read plus a model call per step.
- A case that hangs the loop is bounded by `--steps`, not by a timer.
- The sheets are written for a person. A case whose precondition is a hardware state (wireless charging, a phone call) or a four-screen permission walk is beyond a single goal; record it as a failure with its trace rather than weakening the case.
- `--resume` skips any id that already has a line in `results.jsonl`, including a failure. Delete the line, or drop `--resume`, to re-run one.
