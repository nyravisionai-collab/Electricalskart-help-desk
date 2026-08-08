// Generate PWA icons (192, 512) from the SVG favicon using a minimal approach.
// We'll create a simple PNG with a colored background and a lightning bolt drawn
// with filled rectangles so we don't depend on canvas/skia.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT_DIR = path.resolve('public');

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePng(size) {
  // RGBA pixels, blue gradient with a simple white lightning bolt.
  const w = size, h = size;
  const pixels = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // Gradient from #2d8cff (top-left) to #0f172a (bottom-right)
      const t = (x / w + y / h) / 2;
      const r = Math.round(0x2d + (0x0f - 0x2d) * t);
      const g = Math.round(0x8c + (0x17 - 0x8c) * t);
      const b = Math.round(0xff + (0x2a - 0xff) * t);
      pixels[i] = r; pixels[i+1] = g; pixels[i+2] = b; pixels[i+3] = 255;
    }
  }
  // Draw a white lightning bolt (polygon) via scanline fill.
  const poly = [
    [0.50, 0.15], [0.38, 0.45], [0.28, 0.45], [0.52, 0.85], [0.58, 0.58],
    [0.72, 0.58], [0.56, 0.30], [0.66, 0.30],
  ].map(([px, py]) => [Math.round(px * w), Math.round(py * h)]);

  function pointInPolygon(px, py) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      const intersect = ((yi > py) !== (yj > py)) &&
        (px < ((xj - xi) * (py - yi)) / (yj - yi + 0.000001) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (pointInPolygon(x, y)) {
        const i = (y * w + x) * 4;
        pixels[i] = 255; pixels[i+1] = 255; pixels[i+2] = 255; pixels[i+3] = 255;
      }
    }
  }
  // Green status dot bottom-right
  const cx = Math.round(w * 0.75), cy = Math.round(h * 0.75), r = Math.round(w * 0.09);
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx*dx + dy*dy <= r*r) {
        const i = (y * w + x) * 4;
        pixels[i] = 34; pixels[i+1] = 197; pixels[i+2] = 94; pixels[i+3] = 255;
      }
    }
  }
  // PNG encode
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // Filtered scanlines (filter byte 0 per row)
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    pixels.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw);
  const png = Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png;
}

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'icon-192.png'), makePng(192));
fs.writeFileSync(path.join(OUT_DIR, 'icon-512.png'), makePng(512));
console.log('Icons written to', OUT_DIR);
