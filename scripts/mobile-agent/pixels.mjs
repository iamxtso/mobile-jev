import { deflateSync, inflateSync } from 'node:zlib';

/**
 * A PNG decoder for the formats Android and the accessibility helper send: 8-bit, non-interlaced,
 * grayscale, RGB or RGBA, without a palette. Decoding here keeps the agent free of image
 * dependencies, and the inputs are known because both producers are on the device.
 */
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

export function decodePng(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG.');
  let offset = 8;
  let header;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR')
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const channels = CHANNELS[header?.colorType];
  if (!header || !channels) throw new Error('Unsupported PNG color type.');
  if (header.bitDepth !== 8 || header.interlace !== 0) throw new Error('Unsupported PNG format.');
  const { width, height } = header;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error('PNG is truncated.');
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const filter = raw[start];
    const line = raw.subarray(start + 1, start + 1 + stride);
    const target = data.subarray(y * stride, (y + 1) * stride);
    const prior = y ? data.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? target[x - channels] : 0;
      const up = prior ? prior[x] : 0;
      const upLeft = prior && x >= channels ? prior[x - channels] : 0;
      const value = line[x];
      const restored =
        filter === 0
          ? value
          : filter === 1
            ? value + left
            : filter === 2
              ? value + up
              : filter === 3
                ? value + ((left + up) >> 1)
                : filter === 4
                  ? value + paeth(left, up, upLeft)
                  : NaN;
      if (Number.isNaN(restored)) throw new Error('Unsupported PNG filter.');
      target[x] = restored & 0xff;
    }
  }
  return { width, height, channels, data };
}

/**
 * The share of pixels that differ between two screenshots, inside `bounds` only. A whole screenshot
 * cannot answer this: a progress bar or a clock moves more pixels every second than a button's glyph
 * moves when it is pressed. The threshold ignores dithering and antialiased edges; 16 of 255 still
 * sees a glyph swap, which measured about 5 % of a car dock's pause tile.
 */
export function changedFraction(before, after, bounds, { threshold = 16 } = {}) {
  if (before.width !== after.width || before.height !== after.height) return null;
  if (before.channels !== after.channels) return null;
  const left = Math.max(0, Math.floor(bounds.left));
  const top = Math.max(0, Math.floor(bounds.top));
  const right = Math.min(before.width, Math.ceil(bounds.right));
  const bottom = Math.min(before.height, Math.ceil(bounds.bottom));
  if (right <= left || bottom <= top) return null;
  let changed = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const index = (y * before.width + x) * before.channels;
      for (let channel = 0; channel < before.channels; channel++) {
        if (Math.abs(before.data[index + channel] - after.data[index + channel]) > threshold) {
          changed++;
          break;
        }
      }
    }
  }
  return changed / ((right - left) * (bottom - top));
}

const CRC = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function encodePng({ width, height, paint }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = [Buffer.alloc(0)];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * One control's own drawing, cut out of a screenshot and enlarged for a model to read, base64 PNG.
 * The model API requires at least 280 px on each side, and a dashboard icon is about 90 px, so the
 * crop is scaled up rather than sent at its captured size. `undefined` when the screenshot cannot be
 * read, which is not evidence about the tap.
 */
export function cropControl(source, bounds, { margin = 10, minSide = 280, maxSide = 1568 } = {}) {
  let png;
  try {
    png = decodePng(typeof source === 'string' ? Buffer.from(source, 'base64') : source);
  } catch {
    return undefined;
  }
  const left = Math.max(0, Math.floor(bounds.left) - margin);
  const top = Math.max(0, Math.floor(bounds.top) - margin);
  const right = Math.min(png.width, Math.ceil(bounds.right) + margin);
  const bottom = Math.min(png.height, Math.ceil(bounds.bottom) + margin);
  const width = right - left;
  const height = bottom - top;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    return undefined;
  const scale = Math.min(
    Math.max(1, Math.ceil(minSide / Math.min(width, height))),
    Math.max(1, Math.floor(maxSide / Math.max(width, height))),
  );
  // Too wide to fit the API's limits and too short to reach its minimum at once: no crop, rather
  // than one the API refuses.
  if (width * scale < minSide || height * scale < minSide) return undefined;
  return encodePng({
    width: width * scale,
    height: height * scale,
    paint: (x, y) => {
      const index =
        ((top + Math.floor(y / scale)) * png.width + left + Math.floor(x / scale)) * png.channels;
      return [png.data[index], png.data[index + 1], png.data[index + 2]];
    },
  }).toString('base64');
}
