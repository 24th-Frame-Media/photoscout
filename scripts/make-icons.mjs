// Draws the app icons into web/public/icons: the pin from the favicon in
// web/index.html (amber #f5a623 on #0e1014), as PNGs the manifest can name.
// No dependencies: the shape is rasterised here and written with node:zlib.
//
//   node scripts/make-icons.mjs
//
// The output is committed, so this only needs running to change the design.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/public/icons');

const BG = [0x0e, 0x10, 0x14];
const PIN = [0xf5, 0xa6, 0x23];

/** The favicon's pin (a 32-unit box) as a polygon: a round head and a point at (16, 30). */
function pinOutline() {
  const pts = [];
  const bez = (p0, p1, p2, p3, n = 24) => {
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      pts.push([
        u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0],
        u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1],
      ]);
    }
  };
  const arc = (from, to, n = 32) => {
    for (let i = 0; i <= n; i++) {
      const a = from + ((to - from) * i) / n;
      pts.push([16 + 10 * Math.cos(a), 12 + 10 * Math.sin(a)]);
    }
  };
  arc(1.5 * Math.PI, Math.PI); // top, round the left side to (6, 12)
  bez([6, 12], [6, 19.5], [16, 30], [16, 30]); // down to the point
  bez([16, 30], [16, 30], [26, 19.5], [26, 12]); // and up the right side
  arc(2 * Math.PI, 1.5 * Math.PI); // round the right and back to the top
  return pts;
}

function inside(poly, x, y) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** An RGB image `size` square, the pin filling `pinFraction` of its height and centred. */
function render(size, pinFraction) {
  const poly = pinOutline();
  const scale = (size * pinFraction) / 28; // the pin is 28 units tall (y 2..30)
  const SS = 3;
  const px = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let pin = 0, dot = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // back into the pin's 32-unit box, whose centre (16, 16) is the canvas centre
          const ux = 16 + (x + (sx + 0.5) / SS - size / 2) / scale;
          const uy = 16 + (y + (sy + 0.5) / SS - size / 2) / scale;
          if (inside(poly, ux, uy)) {
            pin++;
            if ((ux - 16) ** 2 + (uy - 12) ** 2 <= 16) dot++;
          }
        }
      }
      const n = SS * SS, a = (pin - dot) / n;
      for (let k = 0; k < 3; k++) px[(y * size + x) * 3 + k] = Math.round(BG[k] * (1 - a) + PIN[k] * a);
    }
  }
  return px;
}

function png(size, rgb) {
  const crcChunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits per channel
  ihdr[9] = 2; // RGB
  const rows = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) rgb.copy(rows, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    crcChunk('IHDR', ihdr),
    crcChunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    crcChunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(out, { recursive: true });
const icons = [
  // Plain icons: the pin fills most of the square.
  ['icon-192.png', 192, 0.66],
  ['icon-512.png', 512, 0.66],
  // Maskable: the platform may crop to a circle of 80% of the width, so the pin stays well inside it.
  ['icon-maskable-512.png', 512, 0.5],
  ['apple-touch-icon.png', 180, 0.66],
];
for (const [name, size, fraction] of icons) {
  fs.writeFileSync(path.join(out, name), png(size, render(size, fraction)));
  console.log(`${name} ${size}x${size}`);
}
