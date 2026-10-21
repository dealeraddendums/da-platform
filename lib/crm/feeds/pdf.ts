// Feed-request PDFs (request_method = 'pdf'): fill the supplier's fillable
// PDF (crm_feed_supplier_settings.pdf_template_s3_key) from pdf_field_map —
// { "PdfFieldName": "{{company.name}}", "Approver": "{{approver.name}}" } —
// with the same variables as the email templates. The form is NOT flattened:
// the dealer still signs it. Pure apart from pdf-lib.

import { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown } from "pdf-lib";
import { renderTemplate, type TemplateContext } from "../template-vars";

export type PdfFillResult = { bytes: Buffer; filled: string[]; missingFields: string[]; emptyValues: string[]; unknownVars: string[] };

export async function fillRequestPdf(template: Uint8Array | Buffer, fieldMap: Record<string, string>, ctx: TemplateContext): Promise<PdfFillResult> {
  const doc = await PDFDocument.load(template);
  const form = doc.getForm();
  const names = new Set(form.getFields().map((f) => f.getName()));
  const filled: string[] = [], missingFields: string[] = [], emptyValues: string[] = [];
  const unknown = new Set<string>();
  for (const [field, tpl] of Object.entries(fieldMap)) {
    if (!names.has(field)) { missingFields.push(field); continue; }
    const r = renderTemplate(String(tpl ?? ""), ctx, { html: false });
    r.unknown.forEach((u) => unknown.add(u));
    const value = r.text.trim();
    if (!value) emptyValues.push(field);
    const f = form.getField(field);
    if (f instanceof PDFTextField) f.setText(value);
    else if (f instanceof PDFCheckBox) { if (/^(1|true|yes|x|on)$/i.test(value)) f.check(); else f.uncheck(); }
    else if (f instanceof PDFDropdown) { if (value && f.getOptions().includes(value)) f.select(value); }
    else { missingFields.push(field); continue; }
    filled.push(field);
  }
  return { bytes: Buffer.from(await doc.save()), filled, missingFields, emptyValues, unknownVars: Array.from(unknown) };
}

/** Fillable field names of a template PDF (supplier Settings tab helper). */
export async function pdfFieldNames(template: Uint8Array | Buffer): Promise<string[]> {
  const doc = await PDFDocument.load(template);
  return doc.getForm().getFields().map((f) => f.getName());
}

/** A small fillable sample authorization form (fixture + tests + "test render" without a real template). */
export async function samplePdfTemplate(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  page.drawText("Inventory Feed Authorization (sample)", { x: 50, y: 740, size: 18 });
  const rows: [string, string][] = [["Dealership", "dealership"], ["Address", "address"], ["Dealer ID", "dealer_id"], ["Authorized by", "approver_name"], ["Email", "approver_email"], ["Feed destination", "destination"]];
  rows.forEach(([label, name], i) => {
    const y = 690 - i * 40;
    page.drawText(label, { x: 50, y: y + 6, size: 11 });
    form.createTextField(name).addToPage(page, { x: 180, y, width: 360, height: 22 });
  });
  page.drawText("Signature", { x: 50, y: 416, size: 11 });
  form.createTextField("signature").addToPage(page, { x: 180, y: 410, width: 360, height: 22 });
  return Buffer.from(await doc.save());
}

export const SAMPLE_PDF_FIELD_MAP: Record<string, string> = {
  dealership: "{{company.name}}",
  address: "{{company.address}}, {{company.city}}, {{company.state}} {{company.zip}}",
  dealer_id: "{{company.dealer_id}}",
  approver_name: "{{approver.name}}",
  approver_email: "{{approver.email}}",
  destination: "DealerAddendums",
};
