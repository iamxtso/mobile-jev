import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedFraction, cropControl, decodePng, encodePng } from './pixels.mjs';

const grey = (value) => () => [value, value, value];

test('a PNG round-trips through the decoder', () => {
  const png = decodePng(encodePng({ width: 3, height: 2, paint: (x, y) => [x * 60, y * 40, 7] }));
  assert.equal(png.width, 3);
  assert.equal(png.height, 2);
  assert.equal(png.channels, 3);
  assert.deepEqual([...png.data.subarray(0, 6)], [0, 0, 7, 60, 0, 7]);
  assert.deepEqual([...png.data.subarray(9, 12)], [0, 40, 7]);
});

test('the change share counts only the pixels inside the control', () => {
  const before = decodePng(encodePng({ width: 100, height: 100, paint: grey(20) }));
  // A different control repaints, and the control under test does not.
  const elsewhere = decodePng(
    encodePng({
      width: 100,
      height: 100,
      paint: (x, y) => (y < 50 ? [240, 240, 240] : [20, 20, 20]),
    }),
  );
  assert.equal(
    changedFraction(before, elsewhere, { left: 0, top: 50, right: 100, bottom: 100 }),
    0,
  );
  // A glyph-sized repaint inside the control: a quarter of it.
  const glyph = decodePng(
    encodePng({
      width: 100,
      height: 100,
      paint: (x) => (x < 25 ? [250, 250, 250] : [20, 20, 20]),
    }),
  );
  assert.equal(changedFraction(before, glyph, { left: 0, top: 0, right: 100, bottom: 100 }), 0.25);
  // Below-threshold noise is not a change.
  const noise = decodePng(encodePng({ width: 100, height: 100, paint: () => [30, 30, 30] }));
  assert.equal(changedFraction(before, noise, { left: 0, top: 0, right: 100, bottom: 100 }), 0);
});

test('a mismatched or empty region has no answer, and a non-PNG is refused', () => {
  const before = decodePng(encodePng({ width: 10, height: 10, paint: grey(1) }));
  const other = decodePng(encodePng({ width: 11, height: 10, paint: grey(1) }));
  assert.equal(changedFraction(before, other, { left: 0, top: 0, right: 5, bottom: 5 }), null);
  assert.equal(changedFraction(before, before, { left: 20, top: 20, right: 30, bottom: 30 }), null);
  assert.throws(() => decodePng(Buffer.from('not a png')), /Not a PNG/);
});

test('a control crop is enlarged to what the model API accepts, keeping its drawing', () => {
  // A dashboard icon is about 90 px; the API needs at least 280 px on each side.
  const screen = encodePng({
    width: 300,
    height: 200,
    paint: (x, y) => (x > 80 && x < 120 && y > 80 && y < 120 ? [255, 0, 0] : [0, 0, 0]),
  });
  const crop = decodePng(
    Buffer.from(cropControl(screen, { left: 90, top: 90, right: 110, bottom: 110 }), 'base64'),
  );
  assert.equal(crop.width, 280);
  assert.equal(crop.height, 280);
  const centre = ((crop.height >> 1) * crop.width + (crop.width >> 1)) * crop.channels;
  assert.deepEqual([...crop.data.subarray(centre, centre + 3)], [255, 0, 0]);
  // A crop that runs off the screen is clamped, not refused.
  const corner = decodePng(
    Buffer.from(cropControl(screen, { left: 0, top: 0, right: 10, bottom: 10 }), 'base64'),
  );
  assert.equal(corner.width, 280);
  // An unreadable screenshot is not evidence about the tap.
  assert.equal(cropControl('not a png', { left: 0, top: 0, right: 10, bottom: 10 }), undefined);
});
