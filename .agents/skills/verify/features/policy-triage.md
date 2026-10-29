# The model missed a control that is on screen

Three different faults look identical from the outside: the run stalls or ends short while the control it needed is visible in the screenshot. They are told apart by what the model was given, and each one is fixed in a different file. Check them in this order; each check is one command over the trace.

| What the trace shows                                                                                         | Layer               | Check                                                                                                                                                                                  | Fix lives in                                       |
| ------------------------------------------------------------------------------------------------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| The model answers confidently about the wrong thing, and the control it needed **was** among the criteria    | the question        | `model_request` in the trace: read `questions.<name>.instructions` and `.criteria`. Is the intended control offered, and does the instruction describe the judgment you actually want? | `policy.mjs`                                       |
| The control the model needed is **absent** from the criteria                                                 | candidate discovery | Run `candidatesFor` on the same `observation` JSON (`artifacts/verify/*.json`) and see what it offers: `node -e` with `candidatesFor(obs)` is enough                                   | `actions.mjs`, and `resolveAction` in `device.mjs` |
| The model answers about a page that is not the one in front (the package or title disagrees with the screen) | the state           | `pnpm agent observe` next to `adb shell dumpsys window \| grep mCurrentFocus`                                                                                                          | `readObservation` in `device.mjs`                  |

## Worked examples from `282999b1`

- **The question.** 主题商店 opens on `欢迎使用主题商店` with `同意并继续`. Asked whether anything stood between the screen and the _goal_, Jev answered `NONE` at 0.97 — opening the store was the goal, and to it the store was open. Asked whether a _dialog covers the app_, the same screen answered `Tap 同意并继续` at 0.99. Same model, same screen; the wording was the fault.
- **Candidate discovery.** The 连接 page marks 无线网络 `checkable` and leaves `clickable` false. `candidatesFor` only offered `clickable` and `editable` controls, so the switch was never in the list; the model pressed the only rows that were (Apple CarPlay, ICCOA Carlink) three times while the network stayed down. Nothing about the question could have fixed that.
- **The state.** The accessibility helper's tree was the chrome overlay — 53 elements, `com.android.systemui` — while `mCurrentFocus` said `com.sgmw.systemsettings`. The helper's own `package` field is empty on this ROM, so the read agreed with itself. The model was answering the right question about the wrong page.

## Reproducing one cheaply

```sh
adb -s "$ADB_SERIAL" shell pm clear com.sgmw.themestore          # put the screen back to first run
pnpm agent observe --out artifacts/verify/probe.json              # the state the model would get
node artifacts/verify/consent-probe.mjs                           # one decision, no input dispatched
```

`artifacts/verify/consent-probe.mjs` and `settings-probe.mjs` are small enough to copy for a new screen: clear the app, open it, observe, decide, print the decision.

## Rules that keep a fix honest

- A fault in the question is fixed by changing what is asked about, never by adding a keyword list: a typed question about the screen beats a regex over labels.
- A fault in candidate discovery is fixed in code, because candidate discovery is code's job (see `AGENTS.md`): the model may not invent a control, so a control that cannot be offered cannot be chosen.
- A fault in the state is fixed in the read. Asking about a tree from the wrong window only produces a confident answer about the wrong page.
