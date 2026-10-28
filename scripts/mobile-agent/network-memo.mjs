/**
 * Which row of a car's settings menu opens the network page, remembered per device and app.
 *
 * The wording differs between models (连接, Network, WLAN), so the entry is found by walking the menu and
 * asking whether the page arrived. That walk costs several seconds per row, and the same car asks for the
 * same row every time, so the answer is written down once. It is a hint for the next run's ordering, never
 * a decision: the page question still confirms it, and a stale entry only costs one wrong tap.
 *
 * Written under `.cache/` in the repository, which is not committed. `NETWORK_MEMO_PATH` moves it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PATH = fileURLToPath(new URL('../../.cache/network-memo.json', import.meta.url));

const memoPath = () => process.env.NETWORK_MEMO_PATH || DEFAULT_PATH;

function readAll() {
  try {
    const parsed = JSON.parse(readFileSync(memoPath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** The row name that opened the network page last time, for this device and app. */
export function rememberedEntry(key) {
  const entry = readAll()[key];
  return typeof entry === 'string' ? entry : undefined;
}

/** A best-effort write: a read-only checkout must not break a recovery. */
export function rememberEntry(key, label) {
  if (!label) return;
  const all = readAll();
  if (all[key] === label) return;
  all[key] = label;
  const path = memoPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`);
  } catch {
    // Nothing to recover: the walk still works next time, it just costs more.
  }
}
