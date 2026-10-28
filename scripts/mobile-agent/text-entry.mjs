/**
 * Putting text into a focused field, cheapest reliable way first.
 *
 * `adb shell input text` writes ASCII only, so a goal in Chinese, Japanese, or with any emoji has no
 * spelling on the shell. Four tiers, in order, each one a real Android mechanism rather than a guess:
 *
 * 1. `clipboard` on the accessibility helper, then KEYCODE_PASTE (279). The IME never sees the text,
 *    so any script, several lines, and emoji all arrive as one commit.
 * 2. ADBKeyboard, when it is installed and active: a base64 broadcast the IME decodes as UTF-8.
 * 3. yadb, pushed to `/data/local/tmp` by the agent when it is missing: the same idea, one process
 *    instead of an installed keyboard.
 * 4. `input text`, which covers ASCII. Text that is not ASCII is spelled in pinyin first, which is what
 *    a person types on a Chinese IME: `充电站` becomes `chongdianzhan`, and the IME offers the
 *    characters.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pinyin } from 'pinyin-pro';

const ASCII_SAFE = /^[\x20-\x7e]+$/;
const PASTE_KEYCODE = '279';
const CLEAR = '67';
const ADBKEYBOARD_PACKAGE = 'com.android.adbkeyboard';
const ADBKEYBOARD_ACTION = 'ADB_INPUT_B64';
const YADB_PATH = '/data/local/tmp/yadb';
const YADB_LOCAL = fileURLToPath(new URL('./vendor/yadb', import.meta.url));

/** A per-device cache: these answers cannot change during a run, and each probe costs an adb call. */
function remember(device, key, produce) {
  device.textTiers ??= {};
  if (device.textTiers[key] === undefined) device.textTiers[key] = produce();
  return device.textTiers[key];
}

async function output(device, args) {
  try {
    return (await device.run(args)).toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Empty the focused field. The accessibility helper can set an empty text through the field's own
 * node, which is the only way that works on a field its app redraws itself; select-all then delete
 * covers a plain EditText, and holding backspace covers the rest.
 */
// A search box on this car held 重庆 after `clear`: select-all is Ctrl+A (key 29, not MOVE_END), and the
// Sogou IME does not implement it, so the selection never happened and the delete had nothing to delete.
// Backspace from the end of the line is the one clear a Chinese IME honours, and a bounded sweep of them
// costs one adb call: deleting past the start of an empty field does nothing.
const CLEAR_KEYSTROKES = 40;

export async function clearField(device) {
  // The helper's own clear is the cheapest, but it is not required to exist: the keys below are the
  // mechanism that works, and running them costs about a second.
  if (device.helper && (await device.helper.available()))
    await device.helper.action({ cmd: 'clear' });
  await device.run(['shell', 'input', 'keyevent', '123'], true);
  await device.run(['shell', 'input', 'keyevent', ...Array(CLEAR_KEYSTROKES).fill(CLEAR)], true);
  return 'keys';
}

async function pastesFromClipboard(device, text) {
  if (!device.helper || !(await device.helper.available())) return false;
  if (!(await device.helper.action({ cmd: 'clipboard', text }))) return false;
  await device.run(['shell', 'input', 'keyevent', PASTE_KEYCODE], true);
  return true;
}

async function typesThroughAdbKeyboard(device, text) {
  const installed = await remember(device, 'adbKeyboard', async () => {
    const packages = await output(device, ['shell', 'pm', 'list', 'packages', ADBKEYBOARD_PACKAGE]);
    if (!packages.includes(`package:${ADBKEYBOARD_PACKAGE}`)) return false;
    const active = await output(device, [
      'shell',
      'settings',
      'get',
      'secure',
      'default_input_method',
    ]);
    return active.toLowerCase().includes('adbkeyboard');
  });
  if (!installed) return false;
  // base64 keeps the shell out of the encoding entirely: no quoting, no locale, no code page.
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  await device.run(
    ['shell', 'am', 'broadcast', '-a', ADBKEYBOARD_ACTION, '--es', 'msg', encoded],
    true,
  );
  return true;
}

/**
 * yadb is a jar the device runs with `app_process`; the agent pushes the vendored copy on first use, so
 * a fresh device needs no setup step.
 */
async function hasYadb(device) {
  return remember(device, 'yadb', async () => {
    if ((await output(device, ['shell', 'ls', YADB_PATH])).includes('yadb')) return true;
    try {
      readFileSync(YADB_LOCAL);
    } catch {
      return false;
    }
    const pushed = await device.run(['push', YADB_LOCAL, YADB_PATH], true).catch(() => null);
    return pushed !== null && (await output(device, ['shell', 'ls', YADB_PATH])).includes('yadb');
  });
}

async function typesThroughYadb(device, text) {
  if (!(await hasYadb(device))) return false;
  // yadb takes the text as one argument, so a quote or a space is escaped for the shell by hand.
  const quoted = `'${text.replaceAll("'", `'\\''`)}'`;
  await device.run(
    [
      'shell',
      `app_process -Djava.class.path=${YADB_PATH} /data/local/tmp com.ysbing.yadb.Main -keyboard ${quoted}`,
    ],
    true,
  );
  return true;
}

/** The ASCII spelling a Chinese IME expects: `充电站` is typed as `chongdianzhan`. */
export function toPinyin(text) {
  const syllables = pinyin(text, { toneType: 'none', type: 'array', nonZh: 'consecutive' });
  return (
    (Array.isArray(syllables) ? syllables.join('') : String(syllables))
      .normalize('NFD')
      // A keyboard spells an accented letter as the plain one; combining marks are not typed at all.
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\x20-\x7e]/g, '')
      .trim()
  );
}

/** Type `text` into the focused field, clearing it first when asked. Returns the tier that answered. */
export async function enterText(device, { text, clear }) {
  if (clear) await clearField(device);
  if (ASCII_SAFE.test(text)) {
    await device.run(['shell', 'input', 'text', text.replaceAll(' ', '%s')], true);
    return 'input';
  }
  if (await pastesFromClipboard(device, text)) return 'clipboard';
  if (await typesThroughAdbKeyboard(device, text)) return 'adbkeyboard';
  if (await typesThroughYadb(device, text)) return 'yadb';
  // Last tier: spell it in pinyin. A Chinese IME turns that back into the characters, which is exactly
  // how a person types it, and it is the only tier that needs nothing on the device.
  const spelled = toPinyin(text);
  if (spelled) {
    await device.run(['shell', 'input', 'text', spelled.replaceAll(' ', '%s')], true);
    return 'pinyin';
  }
  throw new Error(
    'Text outside ASCII needs the accessibility helper clipboard, ADBKeyboard, or yadb, or characters a Chinese IME can spell in pinyin, and this text has none of them.',
  );
}
