/** Minimal PNG encoding and image-size sniffing (no DOM needed: works in tests, Workers and the editor). */
import { zlibSync } from 'fflate';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encodes 8-bit RGBA pixels as a PNG file. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw, { level: 9 })), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Width/height of a PNG, JPEG, GIF or WebP file from its header, or null. */
export function readImageSize(b: Uint8Array): { width: number; height: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: dv.getUint32(16), height: dv.getUint32(20) };
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) {
    const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (fourcc === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (fourcc === 'VP8 ') return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    if (fourcc === 'VP8L') {
      const bits = dv.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      const len = dv.getUint16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: dv.getUint16(i + 7), height: dv.getUint16(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

/** The default project icon: a friendly rounded-square face, 128×128 (Game Studio's equivalent of Godot's icon.svg). */
export function generateIconPng(size = 128): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const s = size / 128;
  const roundedRect = (x: number, y: number, cx: number, cy: number, hw: number, hh: number, r: number) => {
    const qx = Math.abs(x - cx) - hw + r;
    const qy = Math.abs(y - cy) - hh + r;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  };
  const circle = (x: number, y: number, cx: number, cy: number, r: number) => Math.hypot(x - cx, y - cy) - r;
  const cov = (d: number) => Math.max(0, Math.min(1, 0.5 - d));
  const blend = (i: number, rgb: [number, number, number], a: number) => {
    if (a <= 0) return;
    const ia = 1 - a;
    px[i] = px[i] * ia + rgb[0] * a;
    px[i + 1] = px[i + 1] * ia + rgb[1] * a;
    px[i + 2] = px[i + 2] * ia + rgb[2] * a;
    px[i + 3] = Math.min(255, px[i + 3] + 255 * a);
  };
  for (let yy = 0; yy < size; yy++) {
    for (let xx = 0; xx < size; xx++) {
      const x = (xx + 0.5) / s;
      const y = (yy + 0.5) / s;
      const i = (yy * size + xx) * 4;
      // Antenna
      blend(i, [58, 111, 216], cov(roundedRect(x, y, 64, 18, 3, 10, 3) * s));
      blend(i, [245, 165, 36], cov(circle(x, y, 64, 9, 7) * s));
      // Head with a vertical gradient and darker rim
      const head = roundedRect(x, y, 64, 70, 52, 46, 22);
      const t = Math.min(1, Math.max(0, (y - 24) / 92));
      blend(i, [58 - 10 * t, 111 - 25 * t, 216 - 30 * t], cov(head * s));
      blend(i, [96 - 20 * t, 150 - 30 * t, 255 - 30 * t], cov((head + 4) * s));
      // Eyes
      for (const ex of [44, 84]) {
        blend(i, [255, 255, 255], cov(circle(x, y, ex, 64, 13) * s));
        blend(i, [22, 26, 34], cov(circle(x, y, ex + 2, 66, 6.5) * s));
      }
      // Smile
      const smile = Math.abs(circle(x, y, 64, 78, 18)) - 3.2;
      if (y > 84) blend(i, [22, 26, 34], cov(smile * s));
    }
  }
  return encodePng(size, size, px);
}
