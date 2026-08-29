'use strict';

/**
 * Renders the Celar emblem to build/icon.png (512×512 RGBA) with zero
 * dependencies: the shape is drawn with per-pixel distance math and the PNG
 * is encoded by hand around node:zlib.
 *
 * Geometry mirrors renderer SVG (viewBox 0 0 64 64, scaled ×8):
 *   dashed halo r=30 (stroke 1.5, dash 2.5 gap 4, 55% opacity)
 *   gold disc  r=22
 *   dark ring  r=12
 *   gold dot   r=4.5
 *
 * Usage: node scripts/make-icon.js
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 512;
const SCALE = SIZE / 64;
const CENTER = SIZE / 2;

const GOLD = [0xd4, 0xb0, 0x78];
const DARK = [0x0d, 0x0a, 0x07];

// ------------------------------------------------------------------ drawing

const smooth = (edge, d) => Math.min(1, Math.max(0, edge - d + 0.5)); // 1px AA

function pixel(x, y) {
  const dx = x - CENTER + 0.5;
  const dy = y - CENTER + 0.5;
  const dist = Math.hypot(dx, dy);

  // Solid emblem: gold disc with a dark ring and gold core.
  const disc = smooth(22 * SCALE, dist);
  if (disc > 0) {
    const dark = smooth(12 * SCALE, dist);
    const core = smooth(4.5 * SCALE, dist);
    const rgb = core > 0.5 ? GOLD : dark > 0.5 ? DARK : GOLD;
    // Blend the outermost edge for antialiasing.
    return [rgb[0], rgb[1], rgb[2], Math.round(255 * disc)];
  }

  // Dashed halo at r=30, stroke 1.5, dash 2.5 / gap 4 (in 64-unit space).
  const rHalo = 30 * SCALE;
  const half = (1.5 * SCALE) / 2;
  const ringCoverage = Math.min(smooth(rHalo + half, dist), smooth(dist + half, rHalo));
  if (ringCoverage > 0) {
    const theta = Math.atan2(dy, dx) + Math.PI; // 0..2π
    const dashAngle = 2.5 / 30;
    const period = 6.5 / 30;
    const inDash = theta % period < dashAngle;
    if (inDash) {
      return [GOLD[0], GOLD[1], GOLD[2], Math.round(255 * 0.55 * ringCoverage)];
    }
  }

  return [0, 0, 0, 0]; // transparent
}

// -------------------------------------------------------------- png encode

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // compression 0, filter 0, interlace 0

  // Each scanline prefixed with filter byte 0 (None).
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y++) {
    const rowStart = y * (SIZE * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------- main

const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b, a] = pixel(x, y);
    const i = (y * SIZE + x) * 4;
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = a;
  }
}

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'icon.png');
fs.writeFileSync(outFile, encodePng(rgba));
console.log(`wrote ${outFile} (${SIZE}x${SIZE})`);
