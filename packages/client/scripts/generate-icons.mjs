// Generates deltos's placeholder PWA icons as real PNGs with zero image dependencies —
// a brand-dark field with a centered accent disc (smaller on the maskable variant so it
// survives the platform safe-zone crop). Run: `node scripts/generate-icons.mjs`.
// These are deliberate Phase-0 placeholders; a designed mark replaces them later.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'icons');

const BG = [0x11, 0x13, 0x1a, 0xff]; // #11131a
const ACCENT = [0x6e, 0x8b, 0xff, 0xff]; // #6e8bff

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function png(size, discRadiusRatio) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * discRadiusRatio;
  // Raw image: each row prefixed with a 0 filter byte, then RGBA pixels.
  const row = size * 4 + 1;
  const raw = Buffer.alloc(row * size);
  for (let y = 0; y < size; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < size; x++) {
      const inside = (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
      const [pr, pg, pb, pa] = inside ? ACCENT : BG;
      const o = y * row + 1 + x * 4;
      raw[o] = pr;
      raw[o + 1] = pg;
      raw[o + 2] = pb;
      raw[o + 3] = pa;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
const targets = [
  ['icon-192.png', 192, 0.34],
  ['icon-512.png', 512, 0.34],
  ['icon-maskable-512.png', 512, 0.28], // smaller disc → inside the maskable safe zone
  ['apple-touch-icon.png', 180, 0.34],
];
for (const [name, size, ratio] of targets) {
  writeFileSync(join(outDir, name), png(size, ratio));
  console.log('wrote', name);
}

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#11131a"/>
  <circle cx="32" cy="32" r="16" fill="#6e8bff"/>
</svg>
`;
writeFileSync(join(outDir, 'favicon.svg'), favicon);
console.log('wrote favicon.svg');
