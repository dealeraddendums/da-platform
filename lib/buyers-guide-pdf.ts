// Server-only. Overlays dealer/vehicle/warranty data onto the official FTC PDF backgrounds.
import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from 'pdf-lib';
import fs from 'fs';
import path from 'path';
import type { BuyersGuideDefaults } from '@/lib/db';

export interface BuyersGuidePdfInput {
  language: 'en' | 'es';
  vehicle: {
    make: string | null;
    model: string | null;
    year: string | null;
    vin: string | null;
  };
  dealer: {
    name: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    phone: string | null;
    email?: string | null;
  };
  warranty: BuyersGuideDefaults;
}

// ── Calibrated coordinates (PDF pts, origin = bottom-left, 612×792 page) ─────
// Source PDFs: assets/buyers-guide/en.pdf (3 pp), assets/buyers-guide/es.pdf (3 pp)
// Page index: 0 = AS IS / COMO ESTÁ front, 1 = IMPLIED ONLY front, 2 = back page

const VROW_Y = 629;                        // vehicle data row baseline
const MAKE_X = 68;                         // left inner border
const MODEL_X = 196;
const YEAR_X = 348;
const VIN_X = 428;

// Checkbox drawing params: cx/cy = center, sz = half-width of X strokes
type CB = { cx: number; cy: number; sz: number };

// Page 0 coords (AS IS / COMO ESTÁ version)
const P0 = {
  asIs:    { cx: 79, cy: 585, sz: 9 } as CB,   // large primary checkbox
  dlrW:    { cx: 79, cy: 524, sz: 9 } as CB,   // large primary checkbox
  full:    { cx: 87, cy: 501, sz: 6 } as CB,   // small sub-checkbox
  lim:     { cx: 87, cy: 482, sz: 6 } as CB,
  laborX:  285, laborY:  482,                   // inline percent overlay
  partsX:  396, partsY:  482,
  sysX:     68, sysY:    419,                   // systems covered / duration lines
  durX:    315, durY:    419,
  mfrNew:  { cx: 79, cy: 319, sz: 5 } as CB,
  mfrUsed: { cx: 79, cy: 299, sz: 5 } as CB,
  othUsed: { cx: 79, cy: 281, sz: 5 } as CB,
  svcCont: { cx: 79, cy: 237, sz: 5 } as CB,
};

// Page 1 coords (IMPLIED WARRANTIES ONLY / SOLO GARANTÍAS IMPLÍCITAS)
// Everything below the primary section is shifted ~22pt lower (extra description text)
const P1 = {
  implied: { cx: 79, cy: 585, sz: 9 } as CB,
  dlrW:    { cx: 79, cy: 502, sz: 9 } as CB,
  full:    { cx: 87, cy: 479, sz: 6 } as CB,
  lim:     { cx: 87, cy: 460, sz: 6 } as CB,
  laborX:  285, laborY:  460,
  partsX:  396, partsY:  460,
  sysX:     68, sysY:    397,
  durX:    315, durY:    397,
  mfrNew:  { cx: 79, cy: 297, sz: 5 } as CB,
  mfrUsed: { cx: 79, cy: 277, sz: 5 } as CB,
  othUsed: { cx: 79, cy: 259, sz: 5 } as CB,
  svcCont: { cx: 79, cy: 215, sz: 5 } as CB,
};

// Back page (page 2) dealer info fields — same layout for EN and ES
const BACK = {
  nameX:  68, nameY:  201,
  addrX:  68, addrY:  177,
  phoneX: 68, phoneY: 154,
  emailX: 310, emailY: 154,
  complX: 68, complY: 114,
};

// ── Drawing helpers ───────────────────────────────────────────────────────────

function drawX(page: PDFPage, { cx, cy, sz }: CB) {
  page.drawLine({ start: { x: cx - sz, y: cy - sz }, end: { x: cx + sz, y: cy + sz }, thickness: 1.5, color: rgb(0, 0, 0) });
  page.drawLine({ start: { x: cx + sz, y: cy - sz }, end: { x: cx - sz, y: cy + sz }, thickness: 1.5, color: rgb(0, 0, 0) });
}

function drawTxt(page: PDFPage, font: PDFFont, x: number, y: number, text: string, size = 8) {
  const t = (text ?? '').trim();
  if (!t) return;
  page.drawText(t, { x, y, size, font, color: rgb(0, 0, 0) });
}

// White-out the pre-printed blank and overlay the percentage value
function drawPct(page: PDFPage, font: PDFFont, x: number, y: number, val: number | null | undefined) {
  if (val == null) return;
  page.drawRectangle({ x: x - 1, y: y - 2, width: 26, height: 10, color: rgb(1, 1, 1) });
  page.drawText(String(val), { x, y, size: 7.5, font, color: rgb(0, 0, 0) });
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function buildBuyersGuidePdf(input: BuyersGuidePdfInput): Promise<Buffer> {
  const { language: lang, vehicle: v, dealer: d, warranty: w } = input;

  const srcPath = path.join(process.cwd(), 'assets', 'buyers-guide', lang === 'es' ? 'es.pdf' : 'en.pdf');
  const srcBuf = fs.readFileSync(srcPath);
  const srcDoc = await PDFDocument.load(srcBuf);

  const isAsIs    = w.warranty_type === 'as_is';
  const isImplied = w.warranty_type === 'implied_only';
  const isFull    = w.warranty_type === 'full';
  const isLimited = w.warranty_type === 'limited';
  const hasDealerW = isFull || isLimited;

  // Page 0 = AS IS front, page 1 = IMPLIED ONLY front, page 2 = back
  const frontIdx = isImplied ? 1 : 0;

  const outDoc = await PDFDocument.create();
  const [front, back] = await outDoc.copyPages(srcDoc, [frontIdx, 2]);
  outDoc.addPage(front);
  outDoc.addPage(back);

  const font     = await outDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await outDoc.embedFont(StandardFonts.HelveticaBold);

  // ── Front page ─────────────────────────────────────────────────────────────
  const fp = outDoc.getPage(0);
  const C = frontIdx === 0 ? P0 : P1;

  // Vehicle data
  drawTxt(fp, font, MAKE_X,  VROW_Y, v.make  ?? '');
  drawTxt(fp, font, MODEL_X, VROW_Y, v.model ?? '');
  drawTxt(fp, font, YEAR_X,  VROW_Y, v.year  ?? '');
  drawTxt(fp, font, VIN_X,   VROW_Y, v.vin   ?? '');

  // Primary warranty checkbox
  if (isAsIs    && 'asIs'    in C) drawX(fp, (C as typeof P0).asIs);
  if (isImplied && 'implied' in C) drawX(fp, (C as typeof P1).implied);
  if (hasDealerW) drawX(fp, C.dlrW);

  // Sub-checkboxes and warranty details
  if (isFull) drawX(fp, C.full);
  if (isLimited) {
    drawX(fp, C.lim);
    drawPct(fp, fontBold, C.laborX, C.laborY, w.labor_pct);
    drawPct(fp, fontBold, C.partsX, C.partsY, w.parts_pct);
  }
  if (hasDealerW && w.systems_covered) drawTxt(fp, font, C.sysX, C.sysY, w.systems_covered, 7.5);
  if (hasDealerW && w.duration)        drawTxt(fp, font, C.durX, C.durY, w.duration, 7.5);

  // Non-dealer warranty checkboxes
  const ndw = w.non_dealer_warranties ?? [];
  if (ndw.includes('mfr_new'))    drawX(fp, C.mfrNew);
  if (ndw.includes('mfr_used'))   drawX(fp, C.mfrUsed);
  if (ndw.includes('other_used')) drawX(fp, C.othUsed);
  if (w.service_contract)         drawX(fp, C.svcCont);

  // ── Back page ──────────────────────────────────────────────────────────────
  const bp = outDoc.getPage(1);

  const dealerName = d.name ?? '';
  const dealerAddr = [d.address, [d.city, d.state, d.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const dealerPhone = d.phone ?? '';
  const dealerEmail = w.dealer_email ?? d.email ?? '';

  drawTxt(bp, font, BACK.nameX,  BACK.nameY,  dealerName,  8);
  drawTxt(bp, font, BACK.addrX,  BACK.addrY,  dealerAddr,  8);
  drawTxt(bp, font, BACK.phoneX, BACK.phoneY, dealerPhone, 8);
  if (dealerEmail) drawTxt(bp, font, BACK.emailX, BACK.emailY, dealerEmail, 8);
  drawTxt(bp, font, BACK.complX, BACK.complY, dealerName,  8);

  const bytes = await outDoc.save();
  return Buffer.from(bytes);
}
