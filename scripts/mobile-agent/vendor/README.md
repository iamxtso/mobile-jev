# Vendored device-side tools

The agent installs what it needs on the device from this directory, so a fresh phone needs no setup
step by hand.

| File                             | What it is                                                                                                                                                                                                   | Licence                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| `ArtemisAccessibilityHelper.apk` | The accessibility helper (`com.artemis.helper`, versionCode 6, `sha256 133e373f…1969`). Reads the tree and the screenshot in one request and sets text on the focused field.                                 | Apache-2.0, © Google LLC     |
| `helper_manifest.json`           | The bundled version and checksum the agent compares a device against.                                                                                                                                        | —                            |
| `yadb`                           | [YADB](https://github.com/ysbing/YADB) by ysbing: a jar the device runs with `app_process` to type text no IME can otherwise receive. Pushed to `/data/local/tmp/yadb` on first use. `sha256 5274791f…d3c6`. | LGPL-3.0, see `yadb.LICENSE` |

`yadb` is invoked as a separate program, never linked into this code, which is what the LGPL asks for.
Its source is at the link above.

To refresh either artifact, replace the file and update the numbers in `helper_manifest.json` (the APK)
or this table (both).
