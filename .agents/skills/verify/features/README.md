# Feature map — Mobile Jev

Each file covers one user-facing surface: what it is, how a user reaches it, how to drive it, and what observable end state proves it works. A proof that drives only the convenient entry point is incomplete when this map lists others.

| Feature                               | Surface                                                 | Needs a device              | File                                           |
| ------------------------------------- | ------------------------------------------------------- | --------------------------- | ---------------------------------------------- |
| Agent task run                        | CLI (`pnpm agent run`) + studio goal input              | yes                         | [agent-run.md](agent-run.md)                   |
| Device inspection and direct controls | CLI (`observe`, `screenshot`, `profile`, `tap`, `type`) | yes                         | [device-controls.md](device-controls.md)       |
| Live studio                           | Web UI at `127.0.0.1:STUDIO_PORT`                       | yes for the snapshot stream | [studio.md](studio.md)                         |
| Scripted verification suite           | CLI (`pnpm verify`, `pnpm demo`)                        | yes                         | [verification-suite.md](verification-suite.md) |
| Manual test-case sheets               | CLI (`pnpm testcases`)                                  | yes                         | [testcases.md](testcases.md)                   |

Readiness for all four comes from `pnpm run doctor` (see the Launch and Doctor sections of `../SKILL.md`).

## Seed-data preconditions the phone must already satisfy

The suite assumes an **English-language** Android device with:

- a Settings app that exposes a labeled `Airplane mode` switch and a `Dark theme` switch,
- a brightness slider reachable from Quick Settings,
- ADB authorized for the host, and exactly one device connected.

A journey that fails because one of these is missing reports a failure with that reason. Do not weaken a journey to make it pass; record the reason in the feature's Gotchas.
