/* npm run test:crm-templates — DA-CRM email templates: variable rendering,
   HubSpot token conversion (fed the real token set from our HubSpot export),
   CSV parsing, import planning, Outlook-safe HTML, and composeEmail end to end
   against an in-memory fake database (signature always appended). */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { renderTemplate, findVariables, findUnknownTokens, convertHubspotTokens } from "../lib/crm/template-vars";
import { parseCsv, csvRecords } from "../lib/crm/csv";
import { planTemplateImport } from "../lib/crm/template-import";
import { toEmailHtml, sanitizeTemplateHtml, htmlToText, wrapEmail } from "../lib/crm/email-html";
import { composeEmail } from "../lib/crm/email-compose";

let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`}`);
}
const has = (name: string, hay: string, needle: string | RegExp, want = true) =>
  eq(name, typeof needle === "string" ? hay.includes(needle) : needle.test(hay), want);

async function main() {
  // ── Rendering ──────────────────────────────────────────────────────────────
  const ctx = { "contact.first_name": "Chris", "company.name": "Kia <One> & Co", "trial.day": 12, "staff.first_name": "Marlena" };
  eq("fills + escapes in HTML", renderTemplate("<p>Hi {{contact.first_name}}, {{company.name}}</p>", ctx, { html: true }),
    { text: "<p>Hi Chris, Kia &lt;One&gt; &amp; Co</p>", missing: [], unknown: [] });
  eq("subject renders plain", renderTemplate("Day {{ trial.day }} at {{company.name}}", ctx, { html: false }).text, "Day 12 at Kia <One> & Co");
  eq("fallback when empty", renderTemplate('Hi {{contact.last_name | "there"}}', ctx, { html: false }), { text: "Hi there", missing: [], unknown: [] });
  eq("missing reported, rendered empty", renderTemplate("Hi {{contact.title}}!", ctx, { html: false }), { text: "Hi !", missing: ["contact.title"], unknown: [] });
  eq("unknown left visible", renderTemplate("{{custom.thing}} ok", ctx, { html: false }), { text: "{{custom.thing}} ok", missing: [], unknown: ["custom.thing"] });
  eq("findVariables", findVariables("{{contact.first_name}} {{custom.x}}", "{{ company.name | 'x' }}"), ["company.name", "contact.first_name"]);
  eq("findUnknownTokens incl. HubL blocks", findUnknownTokens("{{contact.first_name}} {{if custom.y}} {% if x %}"), ["{{if custom.y}}", "{% if x %}"]);

  // ── HubSpot conversion (the 18 tokens in our real export) ─────────────────
  const hub = [
    "{{contact.firstname}}", "{{company.name}}", "{{company.city}}", "{{company.state}}", "{{contact.company}}",
    "{{contact.dealer_id}}", "{{contact.createdate}}", "{{custom.documentlink_id_24297284_skipform_false_allowdownload_true}}",
    "{{sender.firstname}}", "{{contact.lastname}}", "{{company.address}}", "{{company.zip}}",
    "{{if custom.documentexists_24297284}}", "{{end}}", "{{contact.address}}", "{{contact.city}}", "{{contact.state}}", "{{contact.zip}}",
  ].join(" ");
  const conv = convertHubspotTokens(hub);
  eq("converted text", conv.text,
    "{{contact.first_name}} {{company.name}} {{company.city}} {{company.state}} {{company.name}} {{company.dealer_id}} {{contact.createdate}} "
    + "{{custom.documentlink_id_24297284_skipform_false_allowdownload_true}} {{staff.first_name}} {{contact.last_name}} {{company.address}} {{company.zip}} "
    + "{{if custom.documentexists_24297284}} {{end}} {{company.address}} {{company.city}} {{company.state}} {{company.zip}}");
  eq("unmapped = the 4 tokens with no DA-CRM equivalent", conv.report.unmapped.map((u) => u.from), [
    "{{contact.createdate}}", "{{custom.documentlink_id_24297284_skipform_false_allowdownload_true}}", "{{if custom.documentexists_24297284}}", "{{end}}",
  ]);
  eq("approximated = contact address → company address", conv.report.approximated.map((a) => `${a.from}→${a.to}`),
    ["contact.address→company.address", "contact.city→company.city", "contact.state→company.state", "contact.zip→company.zip"]);
  eq("every converted token is a real DA-CRM variable", findUnknownTokens(conv.text).length, 4);
  eq("default() → fallback", convertHubspotTokens(`Hi {{ contact.firstname | default("there") }}`).text, `Hi {{contact.first_name | "there"}}`);
  eq("unknown filter left alone", convertHubspotTokens("{{ contact.firstname|upper }}").report.unmapped.length, 1);
  eq("HubL block tags reported", convertHubspotTokens("{% if contact.firstname %}x{% endif %}").report.unmapped.map((u) => u.from), ["{% if contact.firstname %}", "{% endif %}"]);
  eq("case-insensitive HubSpot keys", convertHubspotTokens("{{Contact.FirstName}}").text, "{{contact.first_name}}");
  eq("DA-CRM variables untouched", convertHubspotTokens("{{company.name}} {{trial.day}}").text, "{{company.name}} {{trial.day}}");

  // ── CSV ────────────────────────────────────────────────────────────────────
  eq("quotes, commas, newlines, CRLF, BOM", parseCsv('﻿name,body\r\n"A, b","<p>Hi ""you""</p>\n<p>x</p>"\r\nC,\r\n'),
    [["name", "body"], ["A, b", '<p>Hi "you"</p>\n<p>x</p>'], ["C", ""]]);
  eq("blank lines skipped", parseCsv("a\n\n\nb\n"), [["a"], ["b"]]);
  eq("headers normalized", csvRecords("Name,Subject Line,Body HTML,Folder\nx,y,z,w").headers, ["name", "subject_line", "body_html", "folder"]);

  // ── Import planning ────────────────────────────────────────────────────────
  const csv = [
    "name,subject,body_html,folder",
    `Trial day 7,"Day 7 for {{company.name}}","<p>Hi {{contact.firstname}},</p><p>{{if custom.documentexists_1}}doc{{end}}</p>",Trials`,
    `Welcome,Welcome {{contact.firstname}},"<p>Welcome aboard</p>",Onboarding`,
    `welcome,dup,"<p>x</p>",Onboarding`,
    `Empty,s,,X`,
    `Existing,s,"<p>y</p>",X`,
  ].join("\n");
  const plan = planTemplateImport(csv, new Set(["existing"]), { overwrite: false });
  eq("plan actions", plan.templates.map((t) => [t.name, t.action, t.problem ?? null]), [
    ["Trial day 7", "create", null], ["Welcome", "create", null], ["welcome", "skip", "Duplicate name in this file"],
    ["Empty", "skip", "Empty body"], ["Existing", "skip", "A template with this name already exists"],
  ]);
  eq("needs_review only where unmapped", plan.templates.map((t) => t.needs_review), [true, false, false, false, false]);
  eq("folder → category, converted subject", [plan.templates[0].category, plan.templates[0].subject], ["Trials", "Day 7 for {{company.name}}"]);
  eq("variables cached", plan.templates[0].variables, ["company.name", "contact.first_name"]);
  eq("file-level unmapped report", plan.unmappedTokens.map((u) => `${u.from}×${u.count}`), ["{{if custom.documentexists_1}}×1", "{{end}}×1"]);
  eq("overwrite turns existing into update", planTemplateImport(csv, new Set(["existing"]), { overwrite: true }).templates[4].action, "update");
  eq("missing columns", planTemplateImport("title,text\na,b", new Set(), { overwrite: false }).missingColumns, ["subject", "body_html"]);

  // ── Outlook-safe HTML ──────────────────────────────────────────────────────
  const dirty = `<p onclick="x()">Hi<script>alert(1)</script></p><ul><li>One</li></ul>
    <a href="javascript:alert(1)">bad</a><a href="https://x.com">ok</a>
    <img src="data:image/png;base64,AAAA"><img src="https://cdn.example.com/a.png" style="width: 240px; position: fixed">
    <style>p{color:red}</style><iframe src="https://evil"></iframe><p style="color: #c62828; behavior: url(x)">red</p>`;
  const out = toEmailHtml(dirty);
  has("script stripped", out, "<script", false);
  has("event handler stripped", out, "onclick", false);
  has("style block stripped", out, "<style", false);
  has("iframe stripped", out, "<iframe", false);
  has("javascript: link neutralized", out, "javascript:", false);
  has("data: image dropped", out, "data:image", false);
  has("https image kept with width attr", out, /<img[^>]*src="https:\/\/cdn\.example\.com\/a\.png"[^>]*width="240"|<img[^>]*width="240"[^>]*src="https:\/\/cdn\.example\.com\/a\.png"/);
  has("unsafe CSS dropped, safe kept", out, /style="margin:0 0 12px 0;color: #c62828"/);
  has("paragraph margins inlined", out, '<p style="margin:0 0 12px 0;">Hi</p>');
  has("list padding inlined", out, '<ul style="margin:0 0 12px 0;padding:0 0 0 24px;">');
  has("links get target", out, /<a [^>]*href="https:\/\/x\.com"[^>]*target="_blank"/);
  has("empty paragraphs keep their gap", toEmailHtml("<p>a</p><p></p><p>b</p>"), "&nbsp;</p>");
  has("template storage keeps {{variable}} hrefs", sanitizeTemplateHtml('<a href="{{company.website}}">site</a>'), 'href="{{company.website}}"');
  has("template storage drops javascript:", sanitizeTemplateHtml('<a href="javascript:x">s</a>'), "javascript", false);
  eq("plain text alternative", htmlToText('<p>Hi Chris,</p><ul><li>One</li><li>Two</li></ul><p><a href="https://x.com">Docs</a></p>'), "Hi Chris,\n\n• One\n• Two\n\nDocs (https://x.com)");
  has("wrapper declares font", wrapEmail("<p>x</p>", null), /^<div style="font-family:Arial, Helvetica, sans-serif;font-size:14px;/);

  // ── composeEmail end to end (fake DB) ─────────────────────────────────────
  const db: Record<string, any[]> = {
    crm_contacts: [{ id: "ct1", company_id: "co1", first_name: "Chris", last_name: "Hand", email: "chris@example.com", phone: "+18015550100", title: "GM", deleted_at: null }],
    crm_company_directory: [{ id: "co1", name: "Battleground Kia", dealer_text_id: "MP11922", city: "Vancouver", state: "WA", phone: "+13605550199",
      owner_staff_id: "s2", pipeline_stage: "trial", trial_started_at: new Date(Date.now() - 11 * 86400_000).toISOString(), dealer_id: "d1", group_id: null }],
    crm_companies: [{ id: "co1", website: "https://battlegroundkia.example.com" }],
    dealers: [{ id: "d1", address: "123 Main St", zip: "98682", trial_ends_at: null }],
    profiles: [{ id: "s1", full_name: "Marlena Tone", email: "marlena@dealeraddendums.com" }, { id: "s2", full_name: "Alex Smith", email: "alex@dealeraddendums.com" }],
    crm_staff_profiles: [{ staff_id: "s1", full_name: "Marlena Tone", dialpad_number: "+18014159435", email_signature_html: '<p><strong>Marlena Tone</strong><br>DealerAddendums</p><script>x</script>' }],
  };
  const fake = {
    from(table: string) {
      const filters: [string, unknown][] = [];
      const chain: any = {
        select: () => chain,
        eq: (c: string, v: unknown) => { filters.push([c, v]); return chain; },
        is: (c: string, v: unknown) => { filters.push([c, v]); return chain; },
        maybeSingle: async () => ({ data: (db[table] ?? []).find((r) => filters.every(([c, v]) => (r[c] ?? null) === v)) ?? null }),
      };
      return chain;
    },
  };
  const mail = await composeEmail({
    subject: "Day {{trial.day}} at {{company.name}}",
    bodyHtml: '<p>Hi {{contact.first_name | "there"}},</p><p>Visit <a href="{{company.website}}">your site</a>. {{owner.first_name}} owns your account.</p><p>{{custom.unknown}}</p>',
    contactId: "ct1", staffId: "s1",
  }, fake);
  eq("subject filled (trial day 12)", mail.subject, "Day 12 at Battleground Kia");
  has("body variables filled", mail.html, "Hi Chris,");
  has("variable href resolved", mail.html, 'href="https://battlegroundkia.example.com"');
  has("owner resolved", mail.html, "Alex owns your account");
  has("signature appended", mail.html, "<strong>Marlena Tone</strong>");
  has("signature sanitized", mail.html, "<script", false);
  eq("hasSignature", mail.hasSignature, true);
  eq("unknown token reported", mail.unknown, ["custom.unknown"]);
  has("plain text includes signature", mail.text, "Marlena Tone");
  const noSig = await composeEmail({ subject: "x", bodyHtml: "<p>{{staff.first_name}}</p>", staffId: "s2" }, fake);
  eq("no signature on file → flagged, still sends body", [noSig.hasSignature, noSig.html.includes("Alex")], [false, true]);

  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
