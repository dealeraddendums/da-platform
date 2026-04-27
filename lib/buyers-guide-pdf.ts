// Server-only. Overlays dealer/vehicle/warranty data onto the official FTC PDF backgrounds.
import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from 'pdf-lib';
import type { BuyersGuideDefaults } from '@/lib/db';
import { getBuyersGuidePdfBytes } from '@/lib/buyers-guide-storage';
import type { BgKey } from '@/lib/buyers-guide-constants';

export interface BuyersGuidePdfInput {
  language: 'en' | 'es';
  dealerUuid?: string | null;
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

const VROW_Y = 646;                        // vehicle data row baseline
const MAKE_X = 72;                         // left inner border
const MODEL_X = 190;
const YEAR_X = 310;
const VIN_X = 390;

// Checkbox drawing params: cx/cy = center, sz = half-width of X strokes
type CB = { cx: number; cy: number; sz: number };

// ── English AS IS coords (calibrated) ────────────────────────────────────────
const EN_P0 = {
  asIs:    { cx: 92, cy: 585, sz: 11 } as CB,
  dlrW:    { cx: 92, cy: 535, sz: 11 } as CB,
  full:    { cx: 99, cy: 510, sz:  4 } as CB,
  lim:     { cx: 99, cy: 492, sz:  4 } as CB,
  laborX:  280, laborY:  489,
  partsX:  370, partsY:  489,
  sysX:     68, sysY:    419,
  durX:    315, durY:    419,
  mfrNew:  { cx: 85, cy: 325, sz: 4 } as CB,
  mfrUsed: { cx: 85, cy: 301, sz: 4 } as CB,
  othUsed: { cx: 85, cy: 285, sz: 4 } as CB,
  svcCont: { cx: 85, cy: 235, sz: 4 } as CB,
};

// ── English IMPLIED coords (calibrated) ──────────────────────────────────────
const EN_P1 = {
  implied: { cx: 92, cy: 586, sz: 11 } as CB,
  dlrW:    { cx: 92, cy: 536, sz: 11 } as CB,
  full:    { cx: 99, cy: 511, sz:  4 } as CB,
  lim:     { cx: 99, cy: 493, sz:  4 } as CB,
  laborX:  280, laborY:  490,
  partsX:  370, partsY:  490,
  sysX:     68, sysY:    420,
  durX:    315, durY:    420,
  mfrNew:  { cx: 85, cy: 326, sz: 4 } as CB,
  mfrUsed: { cx: 85, cy: 302, sz: 4 } as CB,
  othUsed: { cx: 85, cy: 286, sz: 4 } as CB,
  svcCont: { cx: 85, cy: 236, sz: 4 } as CB,
};

// ── Spanish AS IS coords — same as EN_P0 except non-dealer boxes shifted ─────
// mfrNew  -14pt (3/16" down), mfrUsed -9pt (1/8" down), othUsed -5pt (1/16" down)
const ES_P0 = {
  asIs:    { cx: 92, cy: 585, sz: 11 } as CB,
  dlrW:    { cx: 92, cy: 535, sz: 11 } as CB,
  full:    { cx: 99, cy: 510, sz:  4 } as CB,
  lim:     { cx: 99, cy: 492, sz:  4 } as CB,
  laborX:  280, laborY:  489,
  partsX:  370, partsY:  489,
  sysX:     68, sysY:    419,
  durX:    315, durY:    419,
  mfrNew:  { cx: 85, cy: 311, sz: 4 } as CB,
  mfrUsed: { cx: 85, cy: 292, sz: 4 } as CB,
  othUsed: { cx: 85, cy: 280, sz: 4 } as CB,
  svcCont: { cx: 85, cy: 235, sz: 4 } as CB,
};

// ── Spanish IMPLIED coords — EN_P1 base with same non-dealer offsets as ES_P0 ─
// mfrNew -14pt (3/16"), mfrUsed -9pt (1/8"), othUsed -5pt (1/16")
const ES_P1 = {
  implied: { cx: 92, cy: 586, sz: 11 } as CB,
  dlrW:    { cx: 92, cy: 536, sz: 11 } as CB,
  full:    { cx: 99, cy: 511, sz:  4 } as CB,
  lim:     { cx: 99, cy: 493, sz:  4 } as CB,
  laborX:  280, laborY:  490,
  partsX:  370, partsY:  490,
  sysX:     68, sysY:    420,
  durX:    315, durY:    420,
  mfrNew:  { cx: 85, cy: 312, sz: 4 } as CB,
  mfrUsed: { cx: 85, cy: 293, sz: 4 } as CB,
  othUsed: { cx: 85, cy: 281, sz: 4 } as CB,
  svcCont: { cx: 85, cy: 236, sz: 4 } as CB,
};

// Back page (page 2) dealer info fields — same layout for EN and ES
const BACK = {
  nameX:  104, nameY:  197,
  addrX:  104, addrY:  175,
  phoneX: 104, phoneY: 152,
  emailX: 346, emailY: 152,
};

// ── Drawing helpers ───────────────────────────────────────────────────────────

function drawX(page: PDFPage, { cx, cy, sz }: CB) {
  page.drawRectangle({ x: cx - sz - 1, y: cy - sz - 1, width: sz * 2 + 2, height: sz * 2 + 2, color: rgb(1, 1, 1) });
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
  page.drawText(String(val), { x, y, size: 9, font, color: rgb(0, 0, 0) });
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function buildBuyersGuidePdf(input: BuyersGuidePdfInput): Promise<Buffer> {
  const { language: lang, dealerUuid, vehicle: v, dealer: d, warranty: w } = input;

  const isAsIs    = w.warranty_type === 'as_is';
  const isImplied = w.warranty_type === 'implied_only';
  const isFull    = w.warranty_type === 'full';
  const isLimited = w.warranty_type === 'limited';
  const hasDealerW = isFull || isLimited;

  const bgKey: BgKey = `${lang === 'es' ? 'spanish' : 'english'}-${isImplied ? 'implied' : 'as-is-warranty'}`;
  const srcBuf = await getBuyersGuidePdfBytes(bgKey, dealerUuid);
  const srcDoc = await PDFDocument.load(srcBuf);

  const outDoc = await PDFDocument.create();
  const [front, back] = await outDoc.copyPages(srcDoc, [0, 1]);
  outDoc.addPage(front);
  outDoc.addPage(back);

  const font     = await outDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await outDoc.embedFont(StandardFonts.HelveticaBold);

  // ── Front page ─────────────────────────────────────────────────────────────
  const fp = outDoc.getPage(0);
  const C = lang === 'es'
    ? (isImplied ? ES_P1 : ES_P0)
    : (isImplied ? EN_P1 : EN_P0);

  // Vehicle data
  drawTxt(fp, font, MAKE_X,  VROW_Y, v.make  ?? '');
  drawTxt(fp, font, MODEL_X, VROW_Y, v.model ?? '');
  drawTxt(fp, font, YEAR_X,  VROW_Y, v.year  ?? '');
  drawTxt(fp, font, VIN_X,   VROW_Y, v.vin   ?? '');

  // Primary warranty checkbox
  if (isAsIs    && 'asIs'    in C) drawX(fp, (C as typeof EN_P0).asIs);
  if (isImplied && 'implied' in C) drawX(fp, (C as typeof EN_P1).implied);
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

  const bytes = await outDoc.save();
  return Buffer.from(bytes);
}
