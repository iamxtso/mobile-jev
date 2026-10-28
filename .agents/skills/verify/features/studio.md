# Live studio

A local web workspace: a read-only ADB snapshot of the phone refreshed every 500 ms, the executed-action timeline, model latency, a task clock, and a stop control. One task owns the device at a time.

## Sub-features

- **Goal input** — placeholder `Ask Jev to do something on your phone…`, submitted by **Run task** or ⌘↵.
- **Step limit** — number field, `aria-label="Step limit"`.
- **Device panel** — snapshot stream, `aria-label="Expand device view"`, `Reconnect stream`. Android back/home/recent buttons are present but disabled.
- **Activity panel** — action timeline with `aria-live="polite"`, model latency, task clock `aria-label="Task elapsed time"` that stops on completion, failure, or cancellation.
- **Run history** — `aria-label="Run history"` in the rail; **Clear** removes finished runs and resets the timer, and is refused while a task runs.
- **Stop** — **Stop task** while a run is active.

## How to get to it (user POV)

`pnpm dev`, then open **http://127.0.0.1:3040** (or whatever `STUDIO_PORT` is). Type a goal, press **Run task**, watch the phone snapshot and the timeline.

## Driving it with the studio HTTP API

Browser automation is not needed for a proof; the same-origin API is enough. `POST` requires an `Origin` header matching the host.

```sh
.agents/skills/verify/scripts/studio.sh start 3999
BASE=http://127.0.0.1:3999/api/studio
curl -fsS "$BASE/device"                                          # {kind,id,name,state,snapshotUrl}
curl -fsS -o artifacts/verify/snapshot.png "$BASE/device/snapshot" # PNG, or 503 + adb error
curl -fsS -X POST "$BASE/runs" -H "Origin: http://127.0.0.1:3999" \
  -H 'Content-Type: application/json' -d '{"goal":"Open Settings and turn on Airplane mode"}'
curl -fsS -N "$BASE/runs/<id>/events"                              # SSE frames + 15s heartbeats
curl -fsS -X POST "$BASE/runs/<id>/stop" -H "Origin: http://127.0.0.1:3999"
```

Prove it: `GET /` returns HTML containing the goal input placeholder; `GET /device` returns `state: "device"` and a `snapshotUrl`; `GET /device/snapshot` returns a PNG whose dimensions match `pnpm agent observe`; a `POST /runs` returns `201` with a run id and `GET /runs/<id>` shows the status advance from `running` to a terminal state. If the UI itself is the thing under test, drive the DOM with a browser at `127.0.0.1:3999` and assert on the `aria-label`s above.

## Gotchas

- Host must be `localhost` or `127.0.0.1`; any other host is `403`. `POST` without `Origin` is also `403`.
- `POST /runs` returns `503` when `TYPESAFE_API_KEY` is missing on the server — that is a configuration signal, not a studio bug.
- `GET /device/snapshot` returns `503` with the adb error text when the device is unreachable; `GET /device` returns `502` with a generic "configured device backend is unavailable" message and no adb detail. Neither is a studio bug — run `pnpm run doctor`.
- Runs live in server memory and are lost on restart. Do not use the studio as the store of record; keep traces in `artifacts/verify/`.
- The first request after `pnpm dev` compiles the page and can take tens of seconds. Readiness means HTTP 200, which `studio.sh start` waits for.
