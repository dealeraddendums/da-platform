// Server-only. Overlays dealer/vehicle/warranty data onto the official FTC PDF backgrounds.
import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from 'pdf-lib';
import type { BuyersGuideDefaults } from '@/lib/db';
import { getBuyersGuidePdfBytes } from '@/lib/buyers-guide-storage';
import type { BgKey } from '@/lib/buyers-guide-constants';

/** Pre-printed-label offsets (PDF points). Same shape + field keys as the
 *  da-pdf-service overlay — the two implementations must stay in lockstep. */
export interface BgPreprintedOffsets {
  global?: { x?: number; y?: number };
  fields?: Record<string, { x?: number; y?: number }>;
}

export interface BuyersGuidePdfInput {
  language: 'en' | 'es';
  /** Pre-printed-label mode: render data-only on blank pages at
   *  default coordinates + these offsets. */
  preprinted?: BgPreprintedOffsets | null;
  /** Calibration render (alignment-tool Test print ONLY): draw a visible
   *  sample in EVERY field position regardless of the vehicle/warranty logic,
   *  so the dealer can verify each position. Never used for real prints. */
  calibration?: boolean;
  /** Calibration only: which front-page layout to sample-fill (the tool's
   *  variant toggle) — real prints derive this from warranty_type. */
  impliedLayout?: boolean;
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
  asIs:    { cx: 92, cy: 585, sz:  8 } as CB,
  dlrW:    { cx: 92, cy: 535, sz:  8 } as CB,
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
  implied: { cx: 92, cy: 586, sz:  8 } as CB,
  dlrW:    { cx: 92, cy: 536, sz:  8 } as CB,
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

// ── Spanish AS IS coords ──────────────────────────────────────────────────────
// non-dealer: mfrNew −14pt, mfrUsed −9pt, othUsed −5pt
// dlrW/lim/labor/parts: −27pt (3/8" down); laborX/partsX +32pt (7/16" right)
const ES_P0 = {
  asIs:    { cx: 92, cy: 585, sz:  8 } as CB,
  dlrW:    { cx: 92, cy: 508, sz:  8 } as CB,
  full:    { cx: 99, cy: 510, sz:  4 } as CB,
  lim:     { cx: 99, cy: 465, sz:  4 } as CB,
  laborX:  312, laborY:  462,
  partsX:  402, partsY:  462,
  sysX:     68, sysY:    392,
  durX:    315, durY:    392,
  mfrNew:  { cx: 85, cy: 311, sz: 4 } as CB,
  mfrUsed: { cx: 85, cy: 292, sz: 4 } as CB,
  othUsed: { cx: 85, cy: 280, sz: 4 } as CB,
  svcCont: { cx: 85, cy: 235, sz: 4 } as CB,
};

// ── Spanish IMPLIED coords — EN_P1 base with same non-dealer offsets as ES_P0 ─
// mfrNew -14pt (3/16"), mfrUsed -9pt (1/8"), othUsed -5pt (1/16")
const ES_P1 = {
  implied: { cx: 92, cy: 586, sz:  8 } as CB,
  dlrW:    { cx: 92, cy: 536, sz:  8 } as CB,
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
  // "FOR COMPLAINTS AFTER SALE, CONTACT:" sits one row below telephone/email
  // (~23pt below). Full-width line, left-aligned at nameX.
  complaintsX: 104, complaintsY: 128,
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

  // Pre-printed-label mode (2026-08-25): data-only on blank pages, each field
  // at its calibrated default + the dealer's saved offsets. Field SET is
  // unchanged (compliance) — repositioning only.
  const pp = input.preprinted && typeof input.preprinted === 'object' ? input.preprinted : null;
  const gx = pp ? Number(pp.global?.x) || 0 : 0;
  const gy = pp ? Number(pp.global?.y) || 0 : 0;
  const fo = (key: string) => (pp?.fields?.[key]) ?? {};
  const ox = (key: string, x: number) => x + gx + (Number(fo(key).x) || 0);
  const oy = (key: string, y: number) => y + gy + (Number(fo(key).y) || 0);
  const oCB = (key: string, cb: CB): CB => (pp ? { ...cb, cx: ox(key, cb.cx), cy: oy(key, cb.cy) } : cb);

  const cal = input.calibration === true;
  const isAsIs    = w.warranty_type === 'as_is';
  const isImplied = w.warranty_type === 'implied_only';
  // Which front-page layout: calibration follows the tool's variant toggle,
  // real prints follow the warranty type.
  const layoutImplied = cal ? input.impliedLayout === true : isImplied;
  const isFull    = w.warranty_type === 'full';
  const isLimited = w.warranty_type === 'limited';
  const hasDealerW = isFull || isLimited;

  const outDoc = await PDFDocument.create();
  if (pp) {
    outDoc.addPage([612, 792]);
    outDoc.addPage([612, 792]);
  } else {
    const bgKey: BgKey = `${lang === 'es' ? 'spanish' : 'english'}-${layoutImplied ? 'implied' : 'as-is-warranty'}`;
    const srcBuf = await getBuyersGuidePdfBytes(bgKey, dealerUuid);
    const srcDoc = await PDFDocument.load(srcBuf);
    const [front, back] = await outDoc.copyPages(srcDoc, [0, 1]);
    outDoc.addPage(front);
    outDoc.addPage(back);
  }

  const font     = await outDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await outDoc.embedFont(StandardFonts.HelveticaBold);

  // ── Front page ─────────────────────────────────────────────────────────────
  const fp = outDoc.getPage(0);
  const C = lang === 'es'
    ? (layoutImplied ? ES_P1 : ES_P0)
    : (layoutImplied ? EN_P1 : EN_P0);

  // Vehicle data
  drawTxt(fp, font, ox('make', MAKE_X),   oy('make', VROW_Y),  v.make  ?? '');
  drawTxt(fp, font, ox('model', MODEL_X), oy('model', VROW_Y), v.model ?? '');
  drawTxt(fp, font, ox('year', YEAR_X),   oy('year', VROW_Y),  v.year  ?? '');
  drawTxt(fp, font, ox('vin', VIN_X),     oy('vin', VROW_Y),   v.vin   ?? '');

  // Primary warranty checkbox. Calibration marks the layout's own primary box
  // (every position must print something); real prints follow the warranty.
  if ((cal ? !layoutImplied : isAsIs)    && 'asIs'    in C) drawX(fp, oCB('asIs', (C as typeof EN_P0).asIs));
  if ((cal ? layoutImplied  : isImplied) && 'implied' in C) drawX(fp, oCB('implied', (C as typeof EN_P1).implied));
  if (cal || hasDealerW) drawX(fp, oCB('dlrW', C.dlrW));

  // Sub-checkboxes and warranty details
  if (cal || isFull) drawX(fp, oCB('full', C.full));
  if (cal || isLimited) {
    drawX(fp, oCB('lim', C.lim));
    drawPct(fp, fontBold, ox('labor', C.laborX), oy('labor', C.laborY), cal ? (w.labor_pct ?? 100) : w.labor_pct);
    drawPct(fp, fontBold, ox('parts', C.partsX), oy('parts', C.partsY), cal ? (w.parts_pct ?? 100) : w.parts_pct);
  }
  if (cal || (hasDealerW && w.systems_covered)) drawTxt(fp, font, ox('systems', C.sysX), oy('systems', C.sysY), (cal ? (w.systems_covered || 'SAMPLE SYSTEMS') : w.systems_covered) ?? '', 7.5);
  if (cal || (hasDealerW && w.duration))        drawTxt(fp, font, ox('duration', C.durX), oy('duration', C.durY), (cal ? (w.duration || 'SAMPLE DURATION') : w.duration) ?? '', 7.5);

  // Non-dealer warranty checkboxes
  const ndw = w.non_dealer_warranties ?? [];
  if (cal || ndw.includes('mfr_new'))    drawX(fp, oCB('mfrNew', C.mfrNew));
  if (cal || ndw.includes('mfr_used'))   drawX(fp, oCB('mfrUsed', C.mfrUsed));
  if (cal || ndw.includes('other_used')) drawX(fp, oCB('othUsed', C.othUsed));
  if (cal || w.service_contract)         drawX(fp, oCB('svcCont', C.svcCont));

  // ── Back page ──────────────────────────────────────────────────────────────
  const bp = outDoc.getPage(1);

  const dealerName = d.name ?? '';
  const dealerAddr = [d.address, [d.city, d.state, d.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const dealerPhone = d.phone ?? '';
  const dealerEmail = w.dealer_email ?? d.email ?? (cal ? 'sample@dealer.com' : '');

  drawTxt(bp, font, ox('name', BACK.nameX),   oy('name', BACK.nameY),  dealerName,  8);
  drawTxt(bp, font, ox('addr', BACK.addrX),   oy('addr', BACK.addrY),  dealerAddr,  8);
  drawTxt(bp, font, ox('phone', BACK.phoneX), oy('phone', BACK.phoneY), dealerPhone, 8);
  if (dealerEmail) drawTxt(bp, font, ox('email', BACK.emailX), oy('email', BACK.emailY), dealerEmail, 8);
  const complaints = cal ? (w.complaints_contact || 'SAMPLE CONTACT') : w.complaints_contact;
  if (complaints) drawTxt(bp, font, ox('complaints', BACK.complaintsX), oy('complaints', BACK.complaintsY), complaints, 8);

  const bytes = await outDoc.save();
  return Buffer.from(bytes);
}
