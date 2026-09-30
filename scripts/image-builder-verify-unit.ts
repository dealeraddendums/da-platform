/**
 * Image Builder checks (migration 163).
 *   npm run test:image-builder
 *
 * What matters: exports are exactly the tab spec (dimensions + a real 150 DPI
 * pHYs chunk + size cap), anything else is rejected, the pHYs writer produces a
 * valid PNG (correct CRCs, chunk before IDAT), design_json is validated, and
 * the editing ops (resize/reorder/duplicate) behave.
 */

import { deflateSync } from "zlib";
import { crc32, readPngInfo, setPngPhys } from "../lib/image-builder/png-dpi";
import { checkExport } from "../lib/image-builder/export-check";
import { IMAGE_TYPES, IMAGE_TYPE_LIST, PPM_150_DPI, validateDesign, type DesignDoc } from "../lib/image-builder/spec";
import { createElement, duplicateElement, reorder, resizeRect } from "../lib/image-builder/ops";
import { STARTER_TEMPLATES } from "../lib/image-builder/starter-templates";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

/** Minimal valid RGBA PNG of w×h (all white), no pHYs — like canvas.toBlob output. */
function makePng(w: number, h: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const b = new Uint8Array(12 + data.length);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
    b.set(data, 8);
    dv.setUint32(8 + data.length, crc32(b.subarray(4, 8 + data.length)));
    return b;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;
  const raw = new Uint8Array(h * (1 + w * 4)).fill(255);
  for (let y = 0; y < h; y++) raw[y * (1 + w * 4)] = 0;
  const parts = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function chunkTypes(b: Uint8Array): string[] {
  const out: string[] = []; let o = 8;
  while (o < b.length) {
    const len = new DataView(b.buffer, b.byteOffset).getUint32(o);
    out.push(String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7])); o += 12 + len;
  }
  return out;
}
function crcsValid(b: Uint8Array): boolean {
  let o = 8; const dv = new DataView(b.buffer, b.byteOffset);
  while (o < b.length) {
    const len = dv.getUint32(o);
    if (crc32(b.subarray(o + 4, o + 8 + len)) !== dv.getUint32(o + 8 + len)) return false;
    o += 12 + len;
  }
  return true;
}

console.log("\nimage builder — PNG DPI\n");
{
  check("crc32('IEND') = 0xAE426082 (PNG reference)", crc32(Uint8Array.from([73, 69, 78, 68])) === 0xae426082);
  check("150 DPI = 5906 px/m", PPM_150_DPI === Math.round(150 / 0.0254));
  const png = makePng(553, 339);
  check("fixture PNG has no pHYs (like canvas output)", readPngInfo(png).phys === null);
  const tagged = setPngPhys(png, PPM_150_DPI);
  const info = readPngInfo(tagged);
  check("tagged: dimensions preserved", info.width === 553 && info.height === 339);
  check("tagged: pHYs 5906×5906, unit metre", !!info.phys && info.phys.ppmX === 5906 && info.phys.ppmY === 5906 && info.phys.unit === 1);
  const types = chunkTypes(tagged);
  check("tagged: pHYs sits right after IHDR, before IDAT", types.join(",") === "IHDR,pHYs,IDAT,IEND", types.join(","));
  check("tagged: every chunk CRC valid", crcsValid(tagged));
  const twice = setPngPhys(setPngPhys(png, 2835), PPM_150_DPI);
  check("re-tagging replaces (exactly one pHYs, new value)",
    chunkTypes(twice).filter((t) => t === "pHYs").length === 1 && readPngInfo(twice).phys?.ppmX === 5906);
  let threw = false; try { setPngPhys(Uint8Array.from([1, 2, 3]), 5906); } catch { threw = true; }
  check("non-PNG input throws", threw);
}

console.log("\nimage builder — export validation (all four types)\n");
for (const spec of IMAGE_TYPE_LIST) {
  const good = setPngPhys(makePng(spec.width, spec.height), PPM_150_DPI);
  check(`${spec.type}: exact ${spec.width}×${spec.height} @150 DPI accepted`, checkExport(good, spec.type) === null, String(checkExport(good, spec.type)));
  check(`${spec.type}: missing pHYs rejected`, checkExport(makePng(spec.width, spec.height), spec.type) !== null);
  check(`${spec.type}: 72 DPI rejected`, checkExport(setPngPhys(makePng(spec.width, spec.height), 2835), spec.type) !== null);
  check(`${spec.type}: 1px off rejected`, checkExport(setPngPhys(makePng(spec.width - 1, spec.height), PPM_150_DPI), spec.type) !== null);
}
{
  const std = setPngPhys(makePng(638, 1650), PPM_150_DPI);
  check("standard-width PNG rejected as narrow", checkExport(std, "addendum_bg_narrow") !== null);
  // A real, valid PNG padded past 5 MB with an ancillary chunk before IEND.
  const small = setPngPhys(makePng(553, 339), PPM_150_DPI);
  const pad = 6 * 1024 * 1024;
  const big = new Uint8Array(small.length + 12 + pad);
  big.set(small.subarray(0, small.length - 12), 0);
  const o = small.length - 12;
  new DataView(big.buffer).setUint32(o, pad);
  big.set([0x7a, 0x5a, 0x7a, 0x5a], o + 4); // "zZzZ" private ancillary chunk
  big.set(small.subarray(small.length - 12), o + 12 + pad);
  check("oversize (valid PNG, 6 MB) rejected on size", /MB/.test(String(checkExport(big, "infobox"))), String(checkExport(big, "infobox")));
  check("JPEG bytes rejected", checkExport(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), "infobox") !== null);
}

console.log("\nimage builder — design validation\n");
{
  const ok: DesignDoc = {
    version: 1, background: "#ffffff", elements: [
      { id: "a", name: "F", type: "frame", x: 0, y: 0, w: 10, h: 10, stroke: "#000000", strokeWidth: 2, radius: 3 },
      { id: "b", name: "B", type: "box", x: 0, y: 0, w: 10, h: 10, fill: "#ffa500", opacity: 0.5, radius: 0, stroke: null, strokeWidth: 1 },
      { id: "c", name: "T", type: "text", x: 0, y: 0, w: 10, h: 10, text: "Hi", font: "inter", size: 12, bold: true, color: "#2a2b3c", align: "center", lineHeight: 1.2 },
      { id: "d", name: "I", type: "image", x: 0, y: 0, w: 10, h: 10, src: "data:image/png;base64,iVBORw0KGgo=", fit: "contain", opacity: 1 },
    ],
  };
  check("valid doc with all four element types passes", validateDesign(ok) === null, String(validateDesign(ok)));
  check("transparent background (null) allowed", validateDesign({ ...ok, background: null }) === null);
  check("unknown element type rejected", validateDesign({ ...ok, elements: [{ ...ok.elements[0], type: "circle" }] }) !== null);
  check("duplicate ids rejected", validateDesign({ ...ok, elements: [ok.elements[0], ok.elements[0]] }) !== null);
  check("remote image URL rejected (data URLs only — keeps canvas untainted)",
    validateDesign({ ...ok, elements: [{ ...ok.elements[3], src: "https://example.com/x.png" } as never] }) !== null);
  check("unknown font rejected", validateDesign({ ...ok, elements: [{ ...ok.elements[2], font: "comic-sans" } as never] }) !== null);
  check("bad colour rejected", validateDesign({ ...ok, background: "red" }) !== null);
  check("zero width rejected", validateDesign({ ...ok, elements: [{ ...ok.elements[0], w: 0 }] }) !== null);
  check("wrong version rejected", validateDesign({ ...ok, version: 2 }) !== null);
}

console.log("\nimage builder — editing ops\n");
{
  const r = { x: 100, y: 100, w: 50, h: 40 };
  const se = resizeRect(r, "se", 10, 5);
  check("se handle grows w/h, keeps origin", se.x === 100 && se.y === 100 && se.w === 60 && se.h === 45);
  const nw = resizeRect(r, "nw", 10, 5);
  check("nw handle moves origin, keeps far corner", nw.x === 110 && nw.y === 105 && nw.x + nw.w === 150 && nw.y + nw.h === 140);
  const n = resizeRect(r, "n", 99, -20);
  check("n handle ignores dx", n.x === 100 && n.w === 50 && n.y === 80 && n.h === 60);
  const tiny = resizeRect(r, "e", -500, 0);
  check("can't shrink below 1px", tiny.w === 1);

  let doc: DesignDoc = { version: 1, background: null, elements: [] };
  for (const t of ["frame", "box", "text"] as const) doc = { ...doc, elements: [...doc.elements, createElement(doc, t, 553, 339)] };
  check("created elements validate", validateDesign(doc) === null, String(validateDesign(doc)));
  const frameInside = doc.elements[0];
  check("new frame sits inside the document", frameInside.x >= 0 && frameInside.x + frameInside.w <= 553 && frameInside.y + frameInside.h <= 339);
  const up = reorder(doc, doc.elements[0].id, "up");
  check("bring forward swaps paint order", up.elements[1].id === doc.elements[0].id);
  check("bring forward at top is a no-op", reorder(doc, doc.elements[2].id, "up") === doc);
  const d = duplicateElement(doc, doc.elements[1].id, 5);
  check("duplicate inserts directly above with new id + offset",
    d.doc.elements[2].id === d.id && d.id !== doc.elements[1].id && d.doc.elements[2].x === doc.elements[1].x + 5);
}

console.log("\nimage builder — starter templates\n");
{
  check("all 7 named templates present (+ narrow variant)", [
    "Classic Black Frame + Notch", "Frame + Pricing Block", "Two-Panel", "Colored Frame",
    "Dealer Infosheet", "Disclaimer Box", "Not-a-Factory-Sticker"].every((n) => STARTER_TEMPLATES.some((t) => t.name === n)));
  check("every image type has at least one template", IMAGE_TYPE_LIST.every((s) => STARTER_TEMPLATES.some((t) => t.image_type === s.type)));
  check("template ids unique", new Set(STARTER_TEMPLATES.map((t) => t.id)).size === STARTER_TEMPLATES.length);
  for (const t of STARTER_TEMPLATES) {
    const spec = IMAGE_TYPES[t.image_type];
    check(`${t.name}: validates`, validateDesign(t.design_json) === null, String(validateDesign(t.design_json)));
    check(`${t.name}: every element inside ${spec.width}×${spec.height}`, t.design_json.elements.every(
      (e) => e.x >= 0 && e.y >= 0 && e.x + e.w <= spec.width && e.y + e.h <= spec.height));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log("\nFAILED:"); failures.forEach((f) => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);
