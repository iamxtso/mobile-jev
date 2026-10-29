/**
 * The launcher's app list: the screen that holds the tiles a person taps.
 *
 * This car exposes one package per app to `pm`, but its launcher also shows tiles that are not packages
 * at all — `QQ音乐`, `酷我音乐`, `喜马拉雅`, each opening a service inside `com.sgmw.local.media`. A goal
 * that names one of them had nothing to open: the model was offered `MediaCenter` and the whole media
 * sheet failed on `blocked`. The tiles are ordinary named clickable cells once the list is on screen.
 *
 * Opening the list is the hard part: the launcher's entry is an unlabelled glyph in the dock, so its
 * coordinates are learned once per device by probing the dock cells and remembering the one that produced
 * a grid of named tiles. That memo (`APPLIST_MEMO_PATH`, default `.cache/applist.json`) is a hint like the
 * network memo: a stale point costs one wrong tap and a re-probe.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PATH = fileURLToPath(new URL('../../.cache/applist.json', import.meta.url));
const memoPath = () => process.env.APPLIST_MEMO_PATH || DEFAULT_PATH;

/** How many named cells make a screen an app list rather than a page with a few rows. */
export const MIN_TILES = 6;

function readAll() {
  try {
    const parsed = JSON.parse(readFileSync(memoPath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** The dock point that opened the app list last time, for this device. */
export function rememberedAppListPoint(serial) {
  const entry = readAll()[serial];
  return entry && Number.isFinite(entry.x) && Number.isFinite(entry.y) ? entry : undefined;
}

/** Best effort: a read-only checkout must not break a run that could still work. */
export function rememberAppListPoint(serial, point) {
  if (!point) return;
  const all = readAll();
  all[serial] = {
    x: Math.round(point.x),
    y: Math.round(point.y),
    // The package the list was found in, so a stale point on another app's page is not mistaken for it.
    ...(point.packageName ? { packageName: point.packageName } : {}),
  };
  try {
    mkdirSync(dirname(memoPath()), { recursive: true });
    writeFileSync(memoPath(), `${JSON.stringify(all, null, 2)}\n`);
  } catch {
    // Nothing to recover: the probe still works next time, it just costs taps again.
  }
}

const nameOf = (element) =>
  String(element.nested || element.text || element.label || '')
    .trim()
    .replace(/\s+/g, ' ');

/**
 * The tiles of an app list, or null when this screen is not one. A tile is a named clickable cell above
 * the dock; the dock's own media card and status bar are named too, so the dock strip is excluded.
 */
export function appListTiles(observation, { minTiles = MIN_TILES, packageName } = {}) {
  // The dock's media player is a window of the system UI with a dozen named cells of its own, and it was
  // the first thing the probe found: a system window is never the launcher's app list.
  if (/^com\.android\.systemui$/i.test(observation.phone.packageName || '')) return null;
  // The app list is the home app's other screen, so it keeps the home app's package. The probe otherwise
  // stops at the first dock icon whose page is a grid — the settings page's six sections were enough.
  if (packageName && observation.phone.packageName !== packageName) return null;
  const dockTop = observation.screen.height * 0.9;
  const tiles = observation.elements
    .filter((element) => element.enabled && element.clickable)
    .filter((element) => element.bounds.top < dockTop && element.bounds.bottom <= dockTop)
    .map((element) => ({ label: nameOf(element), bounds: element.bounds, id: element.id }))
    .filter((tile) => tile.label && tile.label.length <= 14)
    // One label can appear twice (a cell and its icon); the largest box is the one a finger hits.
    .filter(
      (tile, index, all) =>
        all.findIndex((other) => other.label === tile.label) === index &&
        !/^\d+ of \d+/.test(tile.label),
    );
  // A grid, not a list: an app list wraps into rows, a page with a few rows does not.
  const rows = new Set(tiles.map((tile) => tile.bounds.top));
  return tiles.length >= minTiles && rows.size >= 2 ? tiles : null;
}

/** The dock cells worth probing: clickable, unlabelled, inside the bottom strip. */
export function probeCells(observation) {
  const dockTop = observation.screen.height * 0.9;
  return observation.elements
    .filter((element) => element.enabled && element.clickable)
    .filter((element) => element.bounds.top >= dockTop)
    .filter((element) => !nameOf(element));
}
