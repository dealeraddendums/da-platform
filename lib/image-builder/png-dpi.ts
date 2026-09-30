// PNG pHYs (physical pixel density) read/write. Pure Uint8Array — runs in the
// browser (export) and on the server (export validation) with no dependencies.
//
// Browsers' canvas.toBlob("image/png") writes no pHYs chunk, so viewers and
// exiftool assume 72 DPI. We strip any existing pHYs and insert one right after
// IHDR (the spec requires it before the first IDAT).

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let CRC_TABLE: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

/** CRC-32 (ISO 3309 / PNG) over `bytes`. */
export function crc32(bytes: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function putU32(b: Uint8Array, o: number, v: number): void {
  b[o] = (v >>> 24) & 0xff; b[o + 1] = (v >>> 16) & 0xff; b[o + 2] = (v >>> 8) & 0xff; b[o + 3] = v & 0xff;
}

export function isPng(b: Uint8Array): boolean {
  return b.length > 33 && PNG_SIG.every((v, i) => b[i] === v);
}

interface Chunk { type: string; start: number; end: number } // [start,end) incl. length+type+data+crc

function chunks(b: Uint8Array): Chunk[] {
  const out: Chunk[] = [];
  let o = 8;
  while (o + 12 <= b.length) {
    const len = u32(b, o);
    const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    const end = o + 12 + len;
    if (end > b.length) throw new Error("Truncated PNG chunk");
    out.push({ type, start: o, end });
    o = end;
    if (type === "IEND") break;
  }
  return out;
}

/** Return a copy of `png` carrying exactly one pHYs chunk (unit = metre). */
export function setPngPhys(png: Uint8Array, ppm: number): Uint8Array {
  if (!isPng(png)) throw new Error("Not a PNG");
  const list = chunks(png);
  if (list[0]?.type !== "IHDR") throw new Error("PNG missing IHDR");

  // pHYs: length(9) + "pHYs" + ppmX + ppmY + unit(1) + crc
  const phys = new Uint8Array(21);
  putU32(phys, 0, 9);
  phys.set([0x70, 0x48, 0x59, 0x73], 4);
  putU32(phys, 8, ppm);
  putU32(phys, 12, ppm);
  phys[16] = 1;
  putU32(phys, 17, crc32(phys.subarray(4, 17)));

  const keep = list.filter((c) => c.type !== "pHYs");
  const size = 8 + phys.length + keep.reduce((s, c) => s + (c.end - c.start), 0);
  const out = new Uint8Array(size);
  out.set(png.subarray(0, 8), 0);
  let o = 8;
  for (const c of keep) {
    out.set(png.subarray(c.start, c.end), o);
    o += c.end - c.start;
    if (c.type === "IHDR") { out.set(phys, o); o += phys.length; }
  }
  return out;
}

export interface PngInfo {
  width: number;
  height: number;
  /** null when the PNG has no pHYs chunk. */
  phys: { ppmX: number; ppmY: number; unit: number } | null;
}

/** Read dimensions + pHYs from a PNG. Throws on a non-PNG / malformed file. */
export function readPngInfo(png: Uint8Array): PngInfo {
  if (!isPng(png)) throw new Error("Not a PNG");
  const list = chunks(png);
  const ihdr = list[0];
  if (ihdr?.type !== "IHDR") throw new Error("PNG missing IHDR");
  const width = u32(png, ihdr.start + 8);
  const height = u32(png, ihdr.start + 12);
  const p = list.find((c) => c.type === "pHYs");
  const phys = p
    ? { ppmX: u32(png, p.start + 8), ppmY: u32(png, p.start + 12), unit: png[p.start + 16] }
    : null;
  return { width, height, phys };
}
