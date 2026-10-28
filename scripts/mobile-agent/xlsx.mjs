/**
 * Read an .xlsx workbook without a spreadsheet dependency.
 *
 * An xlsx file is a zip of XML parts: `xl/workbook.xml` names the sheets, its relationship part says
 * which file holds each one, and every cell is either an index into `xl/sharedStrings.xml` or a
 * literal. The test-case sheets are plain tables, so that is all this reads. `unzip` ships with macOS
 * and every Linux CI image; a machine without it fails with a clear message instead of a stack trace.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { XMLParser } from 'fast-xml-parser';

const run = promisify(execFile);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => ['sheet', 'si', 'row', 'c', 'Relationship'].includes(name),
});

const asArray = (value) => (Array.isArray(value) ? value : value === undefined ? [] : [value]);

async function part(path, entry) {
  try {
    return (await run('unzip', ['-p', path, entry], { maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (error) {
    throw new Error(`Cannot read ${entry} from ${path}: ${error.message}`);
  }
}

/**
 * Some writers double-escape a line break, so the XML holds `&#10;` as text and the parser hands it
 * back literally. Decode the references a cell can carry so a multi-line step stays multi-line.
 */
export function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, digits) => String.fromCodePoint(Number(digits)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** The text of a shared string, which is either one run or several styled runs. */
export function sharedStringText(si) {
  const texts = si.t !== undefined ? [si.t] : asArray(si.r).map((r) => r.t);
  const joined = texts
    .map((value) => (typeof value === 'string' ? value : (value?.['#text'] ?? '')))
    .join('');
  return decodeEntities(joined);
}

/** `BC12` → 54. Column 0 is `A`. */
export function columnIndex(reference) {
  const letters = String(reference).match(/^[A-Z]+/)?.[0] ?? '';
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/**
 * One worksheet as rows of strings. Empty cells become `''` so a column keeps its position, and rows
 * that are entirely empty are dropped.
 */
export function sheetRows(sheet, sharedStrings) {
  const rows = [];
  for (const row of asArray(sheet?.sheetData?.row)) {
    const cells = [];
    for (const cell of asArray(row.c)) {
      const at = columnIndex(cell['@_r'] ?? `${String.fromCharCode(65 + cells.length)}1`);
      while (cells.length < at) cells.push('');
      const value = cell.v === undefined ? '' : String(cell.v);
      const text =
        cell['@_t'] === 's'
          ? (sharedStrings[Number(value)] ?? '')
          : cell['@_t'] === 'inlineStr'
            ? sharedStringText(cell.is ?? {})
            : value;
      cells[at] = (cell['@_t'] === 's' ? text : decodeEntities(text)).trim();
    }
    const trimmed = cells.map((cell) => cell ?? '');
    if (trimmed.some((cell) => cell !== '')) rows.push(trimmed);
  }
  return rows;
}

/** Every sheet in the workbook, in the order the workbook lists them. */
export async function readWorkbook(path) {
  const workbook = parser.parse(await part(path, 'xl/workbook.xml'));
  const rels = parser.parse(await part(path, 'xl/_rels/workbook.xml.rels'));
  const targets = new Map(
    asArray(rels?.Relationships?.Relationship).map((rel) => [rel['@_Id'], rel['@_Target']]),
  );
  const sharedPart = await part(path, 'xl/sharedStrings.xml').catch(() => '');
  const sharedStrings = sharedPart
    ? asArray(parser.parse(sharedPart)?.sst?.si).map(sharedStringText)
    : [];
  const sheets = [];
  for (const sheet of asArray(workbook?.workbook?.sheets?.sheet)) {
    const target = targets.get(sheet['@_r:id']);
    if (!target) continue;
    const entry = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    sheets.push({
      name: sheet['@_name'],
      rows: sheetRows(parser.parse(await part(path, entry))?.worksheet, sharedStrings),
    });
  }
  return sheets;
}
