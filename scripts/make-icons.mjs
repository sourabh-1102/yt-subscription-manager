// Generates public/icon/{16,32,48,128}.png without dependencies (anti-aliased SDF rasterizer).
// Design: indigo rounded square with three "list" rows and a check — deliberately NOT
// YouTube's red play button (branding guidelines).
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Signed distance helpers in a 0..1 coordinate space.
const sdRoundBox = (px, py, cx, cy, hw, hh, r) => {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const sdSegment = (px, py, ax, ay, bx, by, r) => {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
};

const BG = [15, 138, 126];
const FG = [255, 255, 255];

function render(size) {
  const out = Buffer.alloc(size * size * 4);
  const ss = 4; // supersampling
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let bgA = 0, fgA = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const px = (x + (sx + 0.5) / ss) / size;
          const py = (y + (sy + 0.5) / ss) / size;
          if (sdRoundBox(px, py, 0.5, 0.5, 0.47, 0.47, 0.2) <= 0) {
            bgA++;
            const lw = size <= 16 ? 0.06 : 0.045;
            const rows = [0.32, 0.5, 0.68];
            const onRow = rows.some((ry, i) => sdSegment(px, py, i === 2 ? 0.24 : 0.24, ry, i === 2 ? 0.46 : 0.76, ry, lw) <= 0);
            const check =
              sdSegment(px, py, 0.56, 0.68, 0.64, 0.76, lw) <= 0 || sdSegment(px, py, 0.64, 0.76, 0.8, 0.58, lw) <= 0;
            if (onRow || check) fgA++;
          }
        }
      const n = ss * ss;
      const a = bgA / n;
      const f = bgA ? fgA / bgA : 0;
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) out[i + c] = Math.round(BG[c] * (1 - f) + FG[c] * f);
      out[i + 3] = Math.round(a * 255);
    }
  return out;
}

mkdirSync('public/icon', { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(`public/icon/${s}.png`, png(s, render(s)));
console.log('icons written');
