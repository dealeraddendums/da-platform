/**
 * Product description cleanup — committed, deterministic unit tests (no DB,
 * no network). Run: `npm run test:product-description`
 *
 * Cases are the real shapes found by the 2026-10-23 fleet audit
 * (docs/products/description-audit-20261023.md), anonymized where needed.
 *
 * Pins the contract of lib/product-description-clean.ts:
 *   - output is the editor's own HTML shape (p / br / ul>li>p / strong / em)
 *   - editor-saved values and clean plain text are left byte-identical
 *   - escaped 4.0 markup, <div> blocks, stray breaks, empty edge paragraphs,
 *     double-encoded entities and &nbsp; are cleaned
 *   - output is a fixpoint of the print sanitizer (nothing in it gets stripped)
 *   - idempotent
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cleanProductDescription as clean, descriptionJunk } from "../lib/product-description-clean";
import { sanitizeProductDescription } from "../lib/product-name";

let pass = 0;
function check(label: string, fn: () => void) {
  fn();
  pass++;
  console.log(`  ok  ${label}`);
}
const S3 = "https://addendum-product-images.s3.us-east-1.amazonaws.com/logo.png";

console.log("unchanged");
check("editor-saved bullet list (Werner Hyundai shape) is left alone", () => {
  const v = "<ul><li><p>Exterior Paint Protection</p></li><li><p>Door Edge &amp; Cup Guards</p></li><li><p>Nitrogen-Filled Tires (5 FREE Re-fills)<br>+ $50 Tire Repair Credit</p></li></ul>";
  const r = clean(v);
  assert.equal(r.changed, false);
  assert.equal(r.cls, "clean");
});
check("editor span styles keep their own formatting", () => {
  const v = '<p><span style="font-size: 10pt;"><strong>Xzilon Appearance Protection ($813)</strong></span></p>';
  assert.equal(clean(v).changed, false);
});
check("clean plain text stays byte-identical", () => {
  assert.equal(clean("Nitrogen").changed, false);
  assert.equal(clean("Paint & Interior").changed, false);
});
check("authored blank line between paragraphs is kept", () => {
  const v = "<p>Line one</p><p></p><p>Line two</p>";
  assert.equal(clean(v).html, v);
});
check("empty string", () => assert.deepEqual([clean("").html, clean("").changed], ["", false]));

console.log("4.0 imports");
check("escaped list with real <br /> between items (Werner Kia shape)", () => {
  const v = '&lt;div style=&quot;line-height: .8em;&quot;&gt;&lt;ul style=&quot;display: inline; line-height: .8em; padding: 0px; list-style-position: outside;&quot;&gt;&lt;li&gt;Exterior Paint Protection&lt;/li&gt;<br />\n&lt;li&gt;Door Edge &amp; Cup Guards&lt;/li&gt;<br />\n&lt;li&gt;Nitrogen-Filled Tires<br />\n+ $50 Tire Repair Credit&lt;/li&gt;&lt;/ul&gt;&lt;/div&gt;';
  const r = clean(v);
  assert.equal(r.html, '<ul style="line-height: .8em"><li><p>Exterior Paint Protection</p></li><li><p>Door Edge &amp; Cup Guards</p></li><li><p>Nitrogen-Filled Tires<br>+ $50 Tire Repair Credit</p></li></ul>');
  assert.ok(r.flags.includes("escaped-markup") && r.flags.includes("stray-break") && r.flags.includes("dropped-blocks"));
  assert.equal(r.cls, "complex-html");
});
check("nl2br text becomes one paragraph", () => {
  const r = clean("3M Door Edge Guards<br />\n3M Handle Cavity Guards<br />\n* includes 10 year product warranty");
  assert.equal(r.html, "<p>3M Door Edge Guards<br>3M Handle Cavity Guards<br>* includes 10 year product warranty</p>");
  assert.equal(r.cls, "simple-html");
});
check("leading break and wide alignment spaces", () => {
  const r = clean("<br />\nS.W.A.T. GPS Theft Deterrent             $249.00<br />\n<br />\nAll-Weather Mats      $495.00");
  assert.equal(r.html, "<p>S.W.A.T. GPS Theft Deterrent $249.00<br><br>All-Weather Mats $495.00</p>");
});
check("plain text with entities printed them literally — decoded", () => {
  const r = clean("Interior Fabric / Vinyl &amp; Leather Protection, 12&#039; x 80&quot;");
  assert.equal(r.html, `Interior Fabric / Vinyl & Leather Protection, 12' x 80"`);
  assert.equal(r.cls, "plain-text");
  assert.ok(r.flags.includes("entities"));
});
check("double-encoded entity inside markup", () => {
  assert.equal(clean("<p>TRAILER HITCH &amp;amp; HARNESS</p>").html, "<p>TRAILER HITCH &amp; HARNESS</p>");
});
check("double-encoded bullets and nbsp", () => {
  const r = clean("&amp;#x2022; Key/Fob replacement.  <br />\n&amp;#x2022; Lifetime &amp;nbsp;&amp;nbsp;Powertrain");
  assert.equal(r.html, "<p>• Key/Fob replacement.<br>• Lifetime Powertrain</p>");
  assert.ok(r.flags.includes("double-encoded") && r.flags.includes("nbsp"));
});
check("escaped <u>/<i> become editor emphasis", () => {
  assert.equal(clean("• &lt;u&gt;Ocean For Life:&lt;/u&gt; &lt;i&gt;(term)&lt;/i&gt;").html, "<p>• <u>Ocean For Life:</u> <em>(term)</em></p>");
});
check("<ul> straight inside <ul> nests under the previous bullet", () => {
  const r = clean("<ul><li>Maintenance Package:</li><ul><li>3 Oil Changes</li><li>3 Inspections</li></ul><li>Ceramic Coating</li></ul>");
  assert.equal(r.html, "<ul><li><p>Maintenance Package:</p><ul><li><p>3 Oil Changes</p></li><li><p>3 Inspections</p></li></ul></li><li><p>Ceramic Coating</p></li></ul>");
});
check("cut-off trailing &lt;/li is dropped", () => {
  assert.equal(clean("&lt;li&gt;Grille Badging&lt;/li").html, "<ul><li><p>Grille Badging</p></li></ul>");
});
check("unbalanced quote in an escaped style still parses", () => {
  const r = clean('&lt;div style=&quot;width: 130%; line-height:&quot;1em;&quot;&gt;&lt;ul&gt;&lt;li&gt;A&lt;/li&gt;&lt;/ul&gt;');
  assert.equal(r.html, "<ul><li><p>A</p></li></ul>");
  assert.equal(r.needsReview, false);
});
check("plain text with newlines prints as lines", () => {
  const r = clean("Nitrogen Tire Fill\nClear Bra\n\nWheel Locks");
  assert.equal(r.html, "<p>Nitrogen Tire Fill<br>Clear Bra</p><p>Wheel Locks</p>");
  assert.ok(r.flags.includes("plain-newlines"));
});
check("trailing empty editor paragraph removed (prints a blank line)", () => {
  const r = clean("<ul><li><p>Tire Repair</p></li></ul><p></p>");
  assert.equal(r.html, "<ul><li><p>Tire Repair</p></li></ul>");
  assert.ok(r.flags.includes("empty-paragraphs"));
});
check("<div> blocks become paragraphs instead of running together", () => {
  assert.equal(clean("<div>Line A</div><div>Line B</div>").html, "<p>Line A</p><p>Line B</p>");
});

console.log("complex / unsafe");
check("escaped display text that is not a tag stays text", () => {
  const r = clean("Under &lt;$500&gt; value");
  assert.equal(r.html, "<p>Under &lt;$500&gt; value</p>");
});
check("img on our S3 is kept, foreign img dropped", () => {
  assert.equal(clean(`<p><img src="${S3}" style="width:150px">LLumar</p>`).html, `<p><img src="${S3}" style="width:150px">LLumar</p>`);
  const r = clean('<p><img src="https://example.com/x.png">LLumar</p>');
  assert.equal(r.html, "<p>LLumar</p>");
  assert.ok(r.flags.includes("image-dropped"));
});
check("script and style are removed with their content", () => {
  assert.equal(clean("<p>Ok<script>alert(1)</script></p><style>p{}</style>").html, "<p>Ok</p>");
});
check("heading becomes a bold paragraph; link unwrapped; font color kept", () => {
  assert.equal(clean('<h1>Title</h1><p><a href="x">site</a> <font color="red">red</font></p>').html, '<p><strong>Title</strong></p><p>site <span style="color: red">red</span></p>');
});
check("table flattened and flagged for review", () => {
  const r = clean("<table><tr><td>A</td><td>B</td></tr><tr><td>C</td></tr></table>");
  assert.equal(r.html, "<p>A B</p><p>C</p>");
  assert.equal(r.needsReview, true);
});
check("styles outside the print allowlist are trimmed", () => {
  const r = clean('<ul style="display:inline; line-height:1.3em; padding:0"><li>A</li></ul>');
  assert.equal(r.html, '<ul style="line-height:1.3em"><li><p>A</p></li></ul>');
  assert.ok(r.flags.includes("style-trimmed"));
});

console.log("invariants");
const corpus = [
  "<ul><li><p>A</p></li></ul><p></p>", "x<br />\ny", "&lt;li&gt;A&lt;/li&gt;<br />\n&lt;li&gt;B&lt;/li&gt;",
  "<div><b>Bold</b> <i>it</i></div>", "Line\nLine", "&amp;amp;", "<p>a &nbsp; b</p>", `<p><img src="${S3}"></p>`,
  "<ul><li>One<ul><li>Two</li></ul></li></ul>", "<span style='color:red'>R</span>ed",
];
check("idempotent", () => {
  for (const v of corpus) {
    const once = clean(v).html;
    assert.equal(clean(once).html, once, v);
  }
});
check("output survives the print sanitizer unchanged in text and tags", () => {
  const tags = (h: string) => (h.match(/<\/?[a-z]+/gi) ?? []).join(",");
  for (const v of corpus) {
    const out = clean(v).html;
    if (!/<[a-z]/i.test(out)) continue;
    assert.equal(tags(sanitizeProductDescription(out)), tags(out), v);
  }
});

console.log("nightly check rule");
check("editor output is never junk; 4.0 shapes are", () => {
  assert.deepEqual(descriptionJunk("<ul><li><p>A &amp; B</p></li></ul><p></p>"), []);
  assert.deepEqual(descriptionJunk("<p>a&nbsp; b</p><p></p><p></p>"), []);
  assert.ok(descriptionJunk("&lt;li&gt;A&lt;/li&gt;").includes("escaped-markup"));
  assert.ok(descriptionJunk("Vinyl &amp; Leather").includes("entities"));
  assert.ok(descriptionJunk("<p>A &amp;amp; B</p>").includes("double-encoded"));
  assert.ok(descriptionJunk("<div>A</div><div>B</div>").includes("dropped-blocks"));
  for (const v of corpus) assert.deepEqual(descriptionJunk(clean(v).html), [], v);
});

// The 4.0 → 5.0 Sync keeps a byte-identical copy (da-legacy-etl).
const etlCopy = path.resolve(__dirname, "../../da-legacy-etl/src/lib/productDescriptionClean.ts");
if (fs.existsSync(etlCopy)) {
  check("da-legacy-etl copy is identical", () => {
    assert.equal(fs.readFileSync(etlCopy, "utf8"), fs.readFileSync(path.resolve(__dirname, "../lib/product-description-clean.ts"), "utf8"));
  });
} else console.log("  --  da-legacy-etl checkout not beside this one — copy comparison skipped");

console.log(`\n${pass} checks passed`);
