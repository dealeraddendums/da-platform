/* npm run test:crm-signature — the company email signature (lib/crm/signature.ts): rendering rules,
   CTA dates, Outlook safety, the once-only append, and a SNAPSHOT of the exact HTML that is sent
   (scripts/fixtures/crm-signature/*.snap.html; --update rewrites them after an intended change). */
import * as fs from "fs";
import * as path from "path";
import { DEFAULT_SIGNATURE_TEMPLATE, SIGNATURE_LOGO_URL, activeCta, renderSignature, signaturePhone } from "../lib/crm/signature";
import { toEmailHtml, wrapEmail } from "../lib/crm/email-html";
import { withoutSignature } from "../lib/crm/email-compose";

let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`}`);
}
const SNAP = path.join(__dirname, "fixtures/crm-signature");
function snapshot(name: string, html: string) {
  const f = path.join(SNAP, `${name}.snap.html`);
  if (process.argv.includes("--update") || !fs.existsSync(f)) { fs.writeFileSync(f, html + "\n"); console.log(`SNAP ${name} written`); return; }
  eq(`snapshot ${name}`, html, fs.readFileSync(f, "utf8").replace(/\n$/, ""));
}

const NOW = new Date("2027-12-01T18:00:00Z");
const staff = { full_name: "Dana Ruiz", title: "Customer Support", phone: "+18015550142" };
const nada = { text: "Come see us at NADA 2028 · Booth 1234", url: "https://dealeraddendums.com/nada", starts_on: "2027-11-15", ends_on: "2028-01-31" };

// ── Rendering ──────────────────────────────────────────────────────────────
const sent = toEmailHtml(renderSignature(DEFAULT_SIGNATURE_TEMPLATE, staff, nada, NOW));
snapshot("default-with-cta", sent);
snapshot("default-no-title-no-phone", toEmailHtml(renderSignature(DEFAULT_SIGNATURE_TEMPLATE, { full_name: "Pat Lee", title: null, phone: null }, null, NOW)));
eq("name, title, phone filled", ["Dana Ruiz", "Customer Support", "801-555-0142", "DealerAddendums LLC"].every((t) => sent.includes(t)), true);
eq("no direct line → main number", renderSignature(DEFAULT_SIGNATURE_TEMPLATE, { ...staff, phone: null }, null, NOW).includes("801-415-9435"), true);
eq("no title → its row is gone (no empty line)", /\{\{|Customer Support/.test(renderSignature(DEFAULT_SIGNATURE_TEMPLATE, { ...staff, title: "" }, null, NOW)), false);
eq("names are escaped", renderSignature(DEFAULT_SIGNATURE_TEMPLATE, { ...staff, full_name: "<b>x</b>" }, null, NOW).includes("&lt;b&gt;x&lt;/b&gt;"), true);
eq("phone formats", [signaturePhone("8014159435"), signaturePhone("+1 (801) 415-9435"), signaturePhone("ext 402"), signaturePhone(null)], ["801-415-9435", "801-415-9435", "ext 402", "801-415-9435"]);

// ── Outlook safety (after the send sanitizer) ──────────────────────────────
eq("logo: https S3 url, fixed width/height, alt", sent.includes(`src="${SIGNATURE_LOGO_URL}"`) && /width="72"/.test(sent) && /height="72"/.test(sent) && /alt="DealerAddendums"/.test(sent), true);
eq("no base64 images", /data:image/i.test(sent), false);
eq("table layout survives (cellpadding / valign / border-left)", /cellpadding="0"/.test(sent) && /valign="middle"/.test(sent) && /border-left:2px solid #4763ae/.test(sent), true);
eq("no <style> / class (Outlook ignores them)", /<style|class=/.test(sent), false);

// ── CTA ────────────────────────────────────────────────────────────────────
eq("CTA shown inside its dates, linked", sent.includes('href="https://dealeraddendums.com/nada"') && sent.includes("NADA 2028"), true);
eq("CTA hidden before start", activeCta(nada, new Date("2027-11-14T20:00:00Z")), null);
eq("CTA shown on its last day (Pacific)", activeCta(nada, new Date("2028-02-01T06:00:00Z"))?.text, nada.text);
eq("CTA hidden after end", activeCta(nada, new Date("2028-02-01T09:00:00Z")), null);
eq("empty CTA → no line", renderSignature(DEFAULT_SIGNATURE_TEMPLATE, staff, { text: " ", url: null, starts_on: null, ends_on: null }, NOW).includes("<a "), false);
eq("non-http CTA link → text only", renderSignature(DEFAULT_SIGNATURE_TEMPLATE, staff, { ...nada, url: "javascript:alert(1)" }, NOW).includes("javascript:"), false);

// ── Appended once ──────────────────────────────────────────────────────────
const body = toEmailHtml("<p>Hi Dana,</p><p>Thanks!</p>");
eq("a pasted copy in the body is removed", wrapEmail(withoutSignature(body + sent, sent), sent).split(sent).length - 1, 1);
eq("normal body untouched", withoutSignature(body, sent), body);

console.log(fail ? `\n${fail} failed` : "\nall passed");
process.exit(fail ? 1 : 0);
