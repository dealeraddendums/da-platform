/**
 * Product name/description escaped-markup normalization — committed,
 * deterministic unit tests (no DB, no network, no env).
 * Run: `npm run test:product-html`  (or `npx tsx scripts/product-html-normalize-unit.ts`)
 *
 * Regression coverage for 2026-09-17: a description stored with real tags AND
 * entity-escaped tag source in the same value (legacy-ETL rows that kept their
 * <br /> real, and operator-pasted HTML source that the editor stored as text
 * and auto-linked) printed the escaped fragment as visible tag source on the
 * addendum — 412 library + 374 vehicle_options rows fleet-wide. The 2026-08-05
 * whole-string peel couldn't touch those: it bails when a real "<" is present,
 * because a blanket decode would also collapse correctly-single-encoded body
 * text ("Paint &amp; Interior").
 *
 * Pins the contract of the fragment decoder:
 *   - mixed real/escaped values decode the escaped FRAGMENTS only
 *   - body-text entities outside a fragment keep their single encoding
 *   - an auto-linked src URL inside an escaped <img> is unwrapped, not broken
 *   - wholly-escaped values keep the proven whole-string peel
 *   - escaped DISPLAY text that isn't a tag ("Under &lt;$500&gt;") is untouched
 *   - decoded output is still sanitized (script/onerror/foreign-host img)
 */
import assert from "node:assert/strict";
import {
  normalizeProductHtmlSource,
  sanitizeProductDescription,
  sanitizeProductHtml,
} from "../lib/product-name";

let pass = 0;
function check(label: string, fn: () => void) {
  fn();
  pass++;
  console.log(`  ok  ${label}`);
}

const S3 = "https://addendum-product-images.s3.us-east-1.amazonaws.com/permaplate.png";

console.log("normalizeProductHtmlSource — mixed values");

check("escaped <img> beside real <br>/<u> decodes the fragment", () => {
  const raw = `<p>&lt;img src="${S3}" alt="permaplate" width="125" /&gt;<br><u>PermaPlate</u></p>`;
  const out = normalizeProductHtmlSource(raw);
  assert.ok(out.includes(`<img src="${S3}" alt="permaplate" width="125" />`), out);
  assert.ok(!out.includes("&lt;img"), out);
  assert.ok(out.includes("<u>PermaPlate</u>"), out);
});

check("auto-linked src URL inside the escaped fragment is unwrapped", () => {
  const raw =
    `<p>&lt;img src="<a target="_blank" rel="noopener noreferrer nofollow" href="${S3}">${S3}</a>" ` +
    `alt="permaplate" width="125" style="max-width:125px;" /&gt;<br><u>PermaPlate</u></p>`;
  const out = normalizeProductHtmlSource(raw);
  assert.ok(out.includes(`<img src="${S3}" alt="permaplate" width="125" style="max-width:125px;" />`), out);
  assert.ok(!/<a\b/i.test(out), out);
});

check("body-text entities OUTSIDE a fragment keep their single encoding", () => {
  const raw = `<p>&lt;u&gt;LoJack&lt;/u&gt;<br>1 Year Paint &amp; Interior Warranty</p>`;
  const out = normalizeProductHtmlSource(raw);
  assert.equal(out, `<p><u>LoJack</u><br>1 Year Paint &amp; Interior Warranty</p>`);
});

check("legacy escaped <div>/<ul>/<li> around real <br /> decodes", () => {
  const raw =
    `&lt;div style=&quot;line-height: .8em;&quot;&gt;&lt;ul&gt;&lt;li&gt;Paint Protection&lt;/li&gt;<br />\n` +
    `&lt;li&gt;Nitrogen Fill&lt;/li&gt;<br />\n&lt;/ul&gt;&lt;/div&gt;`;
  const out = normalizeProductHtmlSource(raw);
  assert.ok(out.includes(`<div style="line-height: .8em;">`), out);
  assert.ok(out.includes("<li>Paint Protection</li>"), out);
  assert.ok(!out.includes("&lt;"), out);
});

check("a fragment cannot run away past the next escaped tag", () => {
  // No closing &gt; on the first fragment: the &lt; of the next tag bounds it,
  // so nothing matches and the value is returned byte-identical.
  const raw = `<p>&lt;b unclosed &lt;i&gt;x</p>`;
  const out = normalizeProductHtmlSource(raw);
  assert.equal(out, `<p>&lt;b unclosed <i>x</p>`);
});

check("wholly-escaped <div>-only value decodes (probe fall-through)", () => {
  // The inline tag probe doesn't know <div>, so this whole class printed as tag
  // source until the fall-through to fragment decoding was added.
  const raw = `&lt;div style=&quot;line-height: 1em;&quot;&gt;Nationwide coverage.&lt;/div&gt;`;
  const out = normalizeProductHtmlSource(raw);
  assert.equal(out, `<div style="line-height: 1em;">Nationwide coverage.</div>`);
  const clean = sanitizeProductDescription(raw);
  assert.ok(!/<div/i.test(clean), clean);          // dropped by the allowlist
  assert.ok(clean.includes("Nationwide coverage."), clean);
});

check("entities OUTSIDE a div fragment keep their single encoding", () => {
  const raw = `&lt;div&gt;6&quot; Lift, Fender &amp; Cup Guards&lt;/div&gt;`;
  assert.equal(normalizeProductHtmlSource(raw), `<div>6&quot; Lift, Fender &amp; Cup Guards</div>`);
});

check("unterminated BARE tag token is dropped, content kept", () => {
  const raw = `&lt;li&gt;VIN Etching&lt;/li&gt;<br />&lt;li&gt;Battery&lt;/li<br />&lt;li&gt;Roadside&lt;/li&gt;`;
  const out = normalizeProductHtmlSource(raw);
  assert.ok(!out.includes("&lt;"), out);
  assert.ok(!/<\/li[^>]/.test(out), out);
  for (const word of ["VIN Etching", "Battery", "Roadside"]) assert.ok(out.includes(word), out);
});

check("unterminated bare tag at end of value never renders", () => {
  // Wholly-escaped values take the whole-string peel, so the dangling "</li"
  // decodes to a malformed REAL close tag — which the HTML parser inside the
  // sanitizer discards. Either route, nothing prints.
  const raw = `&lt;li&gt;Tailgate Badging&lt;/li`;
  const clean = sanitizeProductDescription(raw);
  assert.ok(clean.includes("Tailgate Badging"), clean);
  assert.ok(!clean.includes("&lt;"), clean);
  assert.ok(!/<\/li[^>]|<\/li$/.test(clean.replace(/<\/li>/g, "")), clean);
  // and in the MIXED shape (a real <br /> in the value) the token is dropped
  const mixed = `&lt;li&gt;Badging&lt;/li<br />&lt;li&gt;Roadside&lt;/li&gt;`;
  const out = normalizeProductHtmlSource(mixed);
  assert.ok(!out.includes("&lt;"), out);
  assert.ok(out.includes("Badging") && out.includes("Roadside"), out);
});

check("an unterminated tag WITH attributes is left alone, not guessed at", () => {
  // The auto-linked <img> shape: a real "<" follows the open tag. Inserting a
  // terminator here would corrupt a value the fragment rule renders correctly.
  const raw = `<p>&lt;img src="<a href="${S3}">${S3}</a>" width="125" /&gt;</p>`;
  const out = normalizeProductHtmlSource(raw);
  assert.ok(out.includes(`<img src="${S3}" width="125" />`), out);
});

console.log("normalizeProductHtmlSource — values that must NOT change");

check("escaped display text that isn't a tag is untouched (mixed)", () => {
  const raw = `<p>Anything under &lt;$500&gt; qualifies</p>`;
  assert.equal(normalizeProductHtmlSource(raw), raw);
});

check("escaped display text that isn't a tag is untouched (wholly escaped)", () => {
  const raw = `Under &lt;$500&gt;`;
  assert.equal(normalizeProductHtmlSource(raw), raw);
});

check("a word merely STARTING with a tag name is not a fragment", () => {
  const raw = `<p>See &lt;item 4&gt; and &lt;brochure&gt;</p>`;
  assert.equal(normalizeProductHtmlSource(raw), raw);
});

check("clean authored HTML is byte-identical", () => {
  const raw = `<p><u>LoJack Kit</u><br><span style="color: red">Stolen Vehicle Recovery</span></p>`;
  assert.equal(normalizeProductHtmlSource(raw), raw);
});

check("plain text is byte-identical", () => {
  assert.equal(normalizeProductHtmlSource("Nitrogen Fill — 5 free refills"), "Nitrogen Fill — 5 free refills");
});

check("empty / null / undefined → empty string", () => {
  assert.equal(normalizeProductHtmlSource(""), "");
  assert.equal(normalizeProductHtmlSource(null), "");
  assert.equal(normalizeProductHtmlSource(undefined), "");
});

console.log("normalizeProductHtmlSource — wholly escaped (2026-08-05 behavior preserved)");

check("wholly-escaped name still peels one whole-string layer", () => {
  const raw = `&lt;img src=&quot;${S3}&quot; /&gt;LLumar`;
  const out = normalizeProductHtmlSource(raw);
  assert.equal(out, `<img src="${S3}" />LLumar`);
});

console.log("sanitize — the decoded value is still gated");

check("decoded <img> on an allow-listed S3 host survives sanitizing", () => {
  const raw = `<p>&lt;img src="${S3}" alt="permaplate" width="125" /&gt;<br><u>PermaPlate</u></p>`;
  const clean = sanitizeProductDescription(raw);
  assert.ok(clean.includes(`src="${S3}"`), clean);
  assert.ok(/<u>PermaPlate<\/u>/.test(clean), clean);
  assert.ok(!clean.includes("&lt;img"), clean);
});

check("decoded <img> on a FOREIGN host is dropped, text kept", () => {
  const raw = `<p>&lt;img src="https://evil.example.com/x.png" /&gt;<br>PermaPlate</p>`;
  const clean = sanitizeProductDescription(raw);
  assert.ok(!/<img/i.test(clean), clean);
  assert.ok(clean.includes("PermaPlate"), clean);
});

check("escaped <script> is never decoded and never rendered", () => {
  const raw = `<p>&lt;script&gt;alert(1)&lt;/script&gt;<br>ok</p>`;
  const clean = sanitizeProductDescription(raw);
  assert.ok(!/<script/i.test(clean), clean);
});

check("decoded img with onerror loses the handler", () => {
  const raw = `<p>&lt;img src="${S3}" onerror="alert(1)" /&gt;</p>`;
  const clean = sanitizeProductDescription(raw);
  assert.ok(!/onerror/i.test(clean), clean);
});

check("escaped <div> decodes then drops, content kept (name allowlist)", () => {
  const raw = `&lt;div&gt;Wheel Locks&lt;/div&gt;<br>x`;
  const clean = sanitizeProductHtml(raw);
  assert.ok(!/<div/i.test(clean), clean);
  assert.ok(clean.includes("Wheel Locks"), clean);
});

console.log(`\n${pass}/${pass} product-html normalization checks passed`);
