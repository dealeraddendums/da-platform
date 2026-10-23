/**
 * Product description audit — read-only. Runs every stored description through
 * lib/product-description-clean.ts and through the REAL print pipeline
 * (normalizeProductHtmlSource → sanitizeProductDescription, as widgetRenderer's
 * renderDescription does), before and after, and reports what would change.
 *
 * Input: a JSON array of { id, tbl, dealer_id, dealer_name, option_name, description }
 * Run:   npx tsx scripts/description-audit.ts <rows.json> <out.csv> [summary.json]
 */
import fs from "node:fs";
import { cleanProductDescription } from "../lib/product-description-clean";
import { normalizeProductHtmlSource, sanitizeProductDescription } from "../lib/product-name";

type Row = { id: string; tbl: string; dealer_id: string; dealer_name: string | null; option_name: string; description: string };

const [, , inPath, outCsv, outSummary] = process.argv;
const rows: Row[] = JSON.parse(fs.readFileSync(inPath, "utf8"));

// What prints today — mirrors components/builder/widgetRenderer.ts renderDescription.
function renderHtml(desc: string): string {
  if (!desc) return "";
  const src = normalizeProductHtmlSource(desc);
  if (/<[a-z][^>]*>/i.test(src)) return sanitizeProductDescription(src);
  return src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Printed lines, modelled on how the sanitized HTML lays out: adjacent blocks
// (p / li / ul) are ONE line break, each <br> is a line break, an empty <p>
// is a blank line (p:empty has min-height:1em). Images become a marker,
// entities are decoded once. Input is sanitizer output — well-formed, no DOM needed.
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function visibleLines(html: string): string[] {
  const text = html
    .replace(/\s+/g, " ")                                         // source newlines are spaces
    .replace(/<img\b[^>]*>/gi, "[img]")
    .replace(/<p\b[^>]*>(?:\s|<(?!\/p)[^>]*>)*<\/p>/gi, "\x01")   // empty paragraph
    .replace(/<br\s*\/?>/gi, "\x02")
    .replace(/<\/?(?:p|li|ul|ol|div)\b[^>]*>/gi, "\x03")
    .replace(/<[^>]+>/g, "")
    .replace(/\x03*\x01\x03*/g, "\n\n")
    .replace(/\x03+/g, "\n")
    .replace(/\x02/g, "\n")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, b: string) =>
      b[0] === "#" ? String.fromCodePoint(b[1].toLowerCase() === "x" ? parseInt(b.slice(2), 16) : parseInt(b.slice(1), 10)) : ENT[b.toLowerCase()] ?? m);
  return text.split("\n").map((l) => l.replace(/\s+/g, " ").trim());
}
const squash = (lines: string[]) => lines.join("").replace(/\s+/g, "");

type Out = Row & { cls: string; flags: string; needs_review: boolean; proposed: string; text_change: string };
const results: Out[] = [];
const idemFail: string[] = [];
const sanitizerStrips: string[] = [];
const tagSeq = (h: string) => (h.match(/<\/?[a-z]+/gi) ?? []).join(",");

for (const r of rows) {
  const res = cleanProductDescription(r.description);
  const again = cleanProductDescription(res.html);
  if (again.html !== res.html) idemFail.push(r.id);
  if (res.changed && /<[a-z]/i.test(res.html) && tagSeq(sanitizeProductDescription(res.html)) !== tagSeq(res.html)) sanitizerStrips.push(r.id);
  let textChange = "";
  if (res.changed) {
    const before = visibleLines(renderHtml(r.description));
    const after = visibleLines(renderHtml(res.html));
    // Lines are trimmed; leading/trailing empties are artifacts of the walk.
    const norm = (ls: string[]) => { const x = ls.map((l) => l.trim()); while (x.length && !x[0]) x.shift(); while (x.length && !x[x.length - 1]) x.pop(); return x; };
    const bn = norm(before), an = norm(after);
    const ne = (ls: string[]) => ls.filter(Boolean).join("\n");
    if (bn.join("\n") === an.join("\n")) textChange = "none";
    else if (ne(bn) === ne(an)) textChange = "blank-lines";
    else if (squash(bn) === squash(an)) textChange = "line-breaks";
    else textChange = "text";
  }
  results.push({ ...r, cls: res.cls, flags: res.flags.join(" "), needs_review: res.needsReview, proposed: res.html, text_change: textChange });
}

// ── CSV ──
const esc = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const header = ["table", "id", "dealer_id", "dealer", "product", "class", "changed", "needs_review", "flags", "print_change", "original", "proposed"];
const lines = [header.join(",")];
for (const r of results) {
  lines.push([r.tbl, r.id, r.dealer_id, r.dealer_name, r.option_name, r.cls, r.proposed !== r.description, r.needs_review, r.flags, r.text_change, r.description, r.proposed].map(esc).join(","));
}
fs.writeFileSync(outCsv, lines.join("\n") + "\n");

// ── Summary ──
const by = <K extends string>(xs: Out[], f: (x: Out) => K) => xs.reduce((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {} as Record<string, number>);
const summary: Record<string, unknown> = { rows: results.length, idempotence_failures: idemFail.length, idem_sample: idemFail.slice(0, 5), sanitizer_strips: sanitizerStrips.length, sanitizer_sample: sanitizerStrips.slice(0, 5) };
for (const tbl of Array.from(new Set(results.map((r) => r.tbl)))) {
  const xs = results.filter((r) => r.tbl === tbl);
  const changed = xs.filter((r) => r.proposed !== r.description);
  const dealers = by(changed, (r) => `${r.dealer_name ?? "?"} (${r.dealer_id})`);
  summary[tbl] = {
    rows: xs.length,
    by_class: by(xs, (r) => r.cls),
    changed: changed.length,
    needs_review: changed.filter((r) => r.needs_review).length,
    dealers_affected: Object.keys(dealers).length,
    print_change: by(changed, (r) => r.text_change),
    flags: changed.flatMap((r) => r.flags.split(" ")).reduce((m, f) => ((m[f] = (m[f] ?? 0) + 1), m), {} as Record<string, number>),
    top_dealers: Object.entries(dealers).sort((a, b) => b[1] - a[1]).slice(0, 20),
  };
}
if (outSummary) fs.writeFileSync(outSummary, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
