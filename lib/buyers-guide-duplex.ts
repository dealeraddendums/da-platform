import { PDFDocument, degrees } from "pdf-lib";

/**
 * Turn every BACK page of a printed Buyer's Guide 180° for double-sided
 * printing (dealer setting buyers_guide_defaults.flip_back_page, opt-in).
 *
 * Every guide renders as exactly 2 pages — front, then back — in every
 * variant (EN/ES, AS IS / IMPLIED / warranty, custom-uploaded backgrounds,
 * pre-printed labels), and the merged outputs (EN+ES, bulk) are those 2-page
 * guides back to back. So the backs are always the odd-indexed pages (1, 3,
 * 5…), which is exactly what a duplex printer puts on the reverse side.
 *
 * Applied ONLY to what is sent to the printer. The {VIN}_buyers_guide.pdf the
 * dealer website links stays upright (a rotated page reads upside down on
 * screen). Off = the caller never calls this, so output is byte-identical.
 */
export async function flipBackPages(buf: Buffer | Uint8Array): Promise<Buffer> {
  const doc = await PDFDocument.load(buf);
  doc.getPages().forEach((page, i) => {
    if (i % 2 === 1) page.setRotation(degrees((page.getRotation().angle + 180) % 360));
  });
  return Buffer.from(await doc.save());
}
