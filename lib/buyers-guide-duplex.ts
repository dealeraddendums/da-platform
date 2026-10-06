import { PDFDocument, degrees } from "pdf-lib";

/**
 * Arrange a printed Buyer's Guide for the dealer's printer. Two independent,
 * opt-in dealer settings in buyers_guide_defaults (Fowler Honda, 2026-10-06):
 *
 *   flip_back_page  — turn every BACK page 180° for double-sided printing.
 *   back_page_first — put each guide's back page before its front page.
 *
 * Every guide renders as exactly 2 pages — front, then back — in every
 * variant (EN/ES, AS IS / IMPLIED / warranty, custom-uploaded backgrounds,
 * pre-printed labels), and the merged outputs (EN+ES, bulk) are those 2-page
 * guides back to back. So in the RENDERED document the backs are always the
 * odd-indexed pages (1, 3, 5…). The flip is applied to those pages before any
 * reorder, so it follows the back page wherever it ends up.
 *
 * Applied ONLY to what is sent to the printer. The {VIN}_buyers_guide.pdf the
 * dealer website links stays upright and front-first. Both settings off = the
 * input buffer is returned untouched, so output is byte-identical.
 */
export async function arrangeForPrint(
  buf: Buffer,
  opts: { flipBack: boolean; backFirst: boolean },
): Promise<Buffer> {
  if (!opts.flipBack && !opts.backFirst) return buf;
  const doc = await PDFDocument.load(buf);
  if (opts.flipBack) {
    doc.getPages().forEach((page, i) => {
      if (i % 2 === 1) page.setRotation(degrees((page.getRotation().angle + 180) % 360));
    });
  }
  if (!opts.backFirst) return Buffer.from(await doc.save());

  // Swap each front/back pair. A trailing unpaired page (not expected) keeps
  // its place rather than being dropped.
  const n = doc.getPageCount();
  const order: number[] = [];
  for (let i = 0; i < n; i += 2) {
    if (i + 1 < n) order.push(i + 1, i);
    else order.push(i);
  }
  const out = await PDFDocument.create();
  const pages = await out.copyPages(doc, order);
  for (const page of pages) out.addPage(page);
  return Buffer.from(await out.save());
}

/** The dealer's print-arrangement settings from buyers_guide_defaults. */
export function printArrangement(d: { flip_back_page?: boolean; back_page_first?: boolean } | null | undefined) {
  return { flipBack: d?.flip_back_page === true, backFirst: d?.back_page_first === true };
}
