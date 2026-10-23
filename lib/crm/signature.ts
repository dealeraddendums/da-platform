// DA-CRM company email signature (migration 196). ONE template for the whole team, edited by crm_admin
// under Team → Signature; each sender fills it with their own name / title / phone (staff profile). The
// rendered block is appended once by composeEmail() — Inbox reply / compose, feed emails, automations.
//
// Outlook (Word engine) rules: a table layout, inline styles only, the logo as an https image with fixed
// width/height + alt (never base64), no CSS that Word drops (flex, max-width, border-radius on <td>).
// Pure — snapshot-tested in scripts/crm-signature-verify-unit.ts.

export const SIGNATURE_LOGO_URL = "https://dealer-addendums.s3.us-west-1.amazonaws.com/crm/email-assets/da-logo-circle-160.png";
export const SIGNATURE_FALLBACK_PHONE = "801-415-9435";
export const BRAND_BLUE = "#4763ae";

const FONT = "font-family:Arial, Helvetica, sans-serif";

/** The company template. Placeholders: {{staff.full_name}} {{staff.title}} {{staff.phone}} {{cta}} {{logo_url}}.
 *  {{cta}} is replaced by a whole table row (or nothing), so it sits between rows.
 *  Every cell declares its own font: Outlook doesn't inherit font-family into table cells (it falls back to
 *  Times New Roman). The rule between logo and text is a 2px cell with a background colour, not a border. */
export const DEFAULT_SIGNATURE_TEMPLATE = `<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;${FONT};color:#333333">
<tbody>
<tr>
<td valign="middle" width="86" style="padding:0 14px 0 0;vertical-align:middle;width:72px;${FONT}">
<img src="{{logo_url}}" width="72" height="72" alt="DealerAddendums" style="border:0;width:72px;height:72px">
</td>
<td valign="middle" width="2" bgcolor="${BRAND_BLUE}" style="width:2px;padding:0;background-color:${BRAND_BLUE};font-size:1px;line-height:1px;${FONT}">&nbsp;</td>
<td valign="middle" style="padding:0 0 0 14px;vertical-align:middle;${FONT}">
<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;${FONT}">
<tbody>
<tr><td style="padding:0;${FONT};font-size:18px;line-height:24px;font-weight:bold;color:${BRAND_BLUE}">{{staff.full_name}}</td></tr>
<tr><td style="padding:0;${FONT};font-size:14px;line-height:20px;color:#55595c">{{staff.title}}</td></tr>
<tr><td style="padding:0;${FONT};font-size:8px;line-height:8px">&nbsp;</td></tr>
<tr><td style="padding:0;${FONT};font-size:14px;line-height:20px;font-weight:bold;color:#333333">DealerAddendums LLC</td></tr>
<tr><td style="padding:0;${FONT};font-size:14px;line-height:20px;color:#333333">{{staff.phone}}</td></tr>
{{cta}}
</tbody>
</table>
</td>
</tr>
</tbody>
</table>`;

export type SignatureStaff = { full_name: string | null; title: string | null; phone: string | null };
export type SignatureCta = { text: string | null; url: string | null; starts_on: string | null; ends_on: string | null };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The CTA to show now, or null (empty text, or outside its dates — dates inclusive, Pacific calendar days). */
export function activeCta(cta: SignatureCta | null | undefined, now: Date = new Date()): SignatureCta | null {
  const text = (cta?.text ?? "").trim();
  if (!text) return null;
  const today = now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  if (cta?.starts_on && today < cta.starts_on) return null;
  if (cta?.ends_on && today > cta.ends_on) return null;
  return { text, url: cta?.url?.trim() || null, starts_on: cta?.starts_on ?? null, ends_on: cta?.ends_on ?? null };
}

/** "8014159435" / "+18014159435" → "801-415-9435"; anything else as typed. */
export function signaturePhone(raw: string | null | undefined): string {
  const d = (raw ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return (raw ?? "").trim() || SIGNATURE_FALLBACK_PHONE;
}

/** Fill the template for one sender. Missing title → its row disappears; no phone → the main line. */
export function renderSignature(template: string, staff: SignatureStaff, cta: SignatureCta | null, now: Date = new Date()): string {
  const a = activeCta(cta, now);
  const ctaRow = a
    ? `<tr><td style="padding:6px 0 0 0;${FONT};font-size:14px;line-height:20px;font-weight:bold;color:${BRAND_BLUE}">${a.url && /^https?:\/\//i.test(a.url)
      ? `<a href="${esc(a.url)}" style="${FONT};color:${BRAND_BLUE};text-decoration:underline">${esc(a.text!)}</a>`
      : esc(a.text!)}</td></tr>`
    : "";
  let html = template
    .replace(/\{\{\s*logo_url\s*\}\}/g, SIGNATURE_LOGO_URL)
    .replace(/\{\{\s*staff\.full_name\s*\}\}/g, esc((staff.full_name ?? "").trim() || "DealerAddendums Support"))
    .replace(/\{\{\s*staff\.phone\s*\}\}/g, esc(signaturePhone(staff.phone)))
    .replace(/\{\{\s*cta\s*\}\}/g, ctaRow);
  const title = (staff.title ?? "").trim();
  html = title
    ? html.replace(/\{\{\s*staff\.title\s*\}\}/g, esc(title))
    // No title: drop the row that held it rather than leaving an empty line.
    : html.replace(/<tr>\s*<td[^>]*>\s*\{\{\s*staff\.title\s*\}\}\s*<\/td>\s*<\/tr>\s*/g, "").replace(/\{\{\s*staff\.title\s*\}\}/g, "");
  return html;
}
