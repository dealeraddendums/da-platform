// Product description cleanup — converts a stored description (4.0 import,
// pasted HTML source, or editor output) into the canonical shape the 5.0
// rich-text editor (components/RichTextEditor.tsx, TipTap) itself saves:
//
//   <p>text<br>more</p>            paragraphs, line breaks
//   <ul><li><p>item</p></li></ul>  bullets / numbered lists (<ol>)
//   <strong> <em> <u> <sub> <sup>  emphasis (b → strong, i → em)
//   <span style="…">               color / size / line-height from the allowlist
//   <img src="https://…s3…">       product images on our S3 hosts only
//
// That is exactly what lib/product-name.tsx sanitizeProductDescription keeps,
// so a cleaned value renders the same on the Builder canvas, the PDF and the
// editor — minus the junk: entity-escaped tag source (&lt;li&gt;), <div>/<h1>/
// table blocks the sanitizer drops (which ran adjacent lines together), stray
// <br> between list items, empty leading/trailing paragraphs (each prints a
// blank line — `p:empty { min-height:1em }`), &nbsp; runs, and plain text whose
// newlines collapsed on print.
//
// Pure string code, no DOM and no dependencies, because the 4.0 → 5.0 Sync runs
// the SAME conversion on import. Two byte-identical copies:
//   da-platform     lib/product-description-clean.ts
//   da-legacy-etl   src/lib/productDescriptionClean.ts
// Change both (npm run test:product-description compares them when both
// checkouts sit side by side).
//
// Never touches anything but the description text. Idempotent:
// cleanProductDescription(clean(x).html).html === clean(x).html.

export type DescriptionClass =
  | "clean"            // already canonical — no change
  | "plain-text"       // no markup; entities and/or newlines to fix
  | "simple-html"      // p / br / b / strong / i / em / u / ul / ol / li only
  | "complex-html";    // styles, spans, divs, headings, tables, links, images, fonts

export type DescriptionFlag =
  | "escaped-markup"      // tag source stored entity-escaped (&lt;li&gt;)
  | "double-encoded"      // text entity encoded twice (&amp;amp;) — printed literally
  | "dropped-blocks"      // <div>/<h1>/<blockquote>… the print sanitizer drops
  | "table"               // table structure flattened to lines — review
  | "heading"             // <h1>…<h6> converted to a bold paragraph
  | "link"                // <a> unwrapped (links don't print)
  | "image-dropped"       // <img> not on our S3 hosts (never printed anyway)
  | "script-or-style"     // <script>/<style>/comment removed
  | "unknown-tag"         // font / o:p / other tags unwrapped
  | "style-trimmed"       // style props outside the allowlist removed
  | "stray-break"         // <br> between list items / at block edges
  | "empty-paragraphs"    // empty leading/trailing/repeated paragraphs
  | "nbsp"                // &nbsp; turned into ordinary spaces
  | "entities"            // plain text stored with entities — printed literally ("&amp;")
  | "whitespace"          // repeated whitespace / trim
  | "plain-newlines"      // plain text with line breaks → <p>…<br>…</p>
  | "visible-tag-text";   // after cleanup the TEXT still contains "<tag" — review

export type CleanResult = {
  html: string;
  changed: boolean;
  cls: DescriptionClass;
  flags: DescriptionFlag[];
  /** True when a person should look at the result before it is trusted. */
  needsReview: boolean;
};

// ── Tag tables ────────────────────────────────────────────────────────────

const SIMPLE_TAGS = new Set(["p", "br", "b", "strong", "i", "em", "u", "ul", "ol", "li"]);
// Tags whose escaped form we turn back into markup. Anything else stays text
// ("Under &lt;$500&gt;" is display text, not a tag).
const KNOWN_TAGS = new Set([
  "p", "br", "b", "strong", "i", "em", "u", "s", "strike", "sub", "sup", "span", "font",
  "div", "ul", "ol", "li", "img", "a", "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "center", "pre", "section", "article", "header", "footer",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "hr",
  "small", "big", "mark", "code", "label", "o:p", "style", "script",
]);
const BLOCK_TAGS = new Set([
  "div", "blockquote", "center", "pre", "section", "article", "header", "footer",
  "table", "thead", "tbody", "tfoot", "tr", "caption", "hr",
  "h1", "h2", "h3", "h4", "h5", "h6",
]);
const INLINE_MAP: Record<string, string> = { b: "strong", strong: "strong", i: "em", em: "em", u: "u", sub: "sub", sup: "sup" };
const VOID_TAGS = new Set(["br", "img", "hr"]);

// Same lists as lib/product-name.tsx (DESCRIPTION_STYLE_PROPS + image hosts).
const STYLE_PROPS = new Set([
  "color", "font-weight", "font-style", "text-decoration", "background-color",
  "width", "height", "max-width", "max-height", "font-size", "line-height",
]);
const IMG_HOSTS = new Set([
  "addendum-product-images.s3.us-east-1.amazonaws.com",
  "addendum-product-images.s3.amazonaws.com",
  "dealer-addendums.s3.us-west-1.amazonaws.com",
  "dealer-addendums.s3.amazonaws.com",
]);

// ── Entities ──────────────────────────────────────────────────────────────

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  ndash: "–", mdash: "—", hellip: "…", trade: "™",
  reg: "®", copy: "©", deg: "°", bull: "•", middot: "·",
  frac12: "½", frac14: "¼", frac34: "¾", times: "×",
};

function decodeOnce(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const n = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    const v = NAMED[body.toLowerCase()];
    return v ?? m;
  });
}

/** Text as it should READ — decoded until no entity is left (double-encoded
 *  "&amp;amp;" printed literally before; nothing legitimate is double-encoded). */
function decodeText(s: string, flags: Set<DescriptionFlag>): string {
  let cur = decodeOnce(s);
  for (let i = 0; i < 3; i++) {
    const next = decodeOnce(cur);
    if (next === cur) break;
    flags.add("double-encoded");
    cur = next;
  }
  return cur;
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Step 1: turn entity-escaped tag source back into tags ─────────────────
// "&lt;li&gt;Paint&lt;/li&gt;" and the mixed shape (real <br /> between escaped
// tags) both come from 4.0. Only fragments whose name is a real HTML tag are
// decoded; the auto-linked src shape (`src="<a href="u">u</a>"`, from pasting
// HTML source into the editor) is unwrapped back to the URL.
const ESCAPED_TAG = /&lt;(\/?)([a-z][a-z0-9]*(?::[a-z]+)?)((?:(?!&lt;|&gt;)[\s\S])*?)(\/?)&gt;/gi;

function unescapeMarkup(s: string, flags: Set<DescriptionFlag>): string {
  // Peel a layer of &amp; first when the whole value is double-escaped markup.
  if (!/&lt;[a-z\/]/i.test(s) && /&amp;lt;\/?[a-z]/i.test(s)) {
    s = s.replace(/&amp;(lt|gt|quot|#0*39|amp);/gi, "&$1;");
  }
  // An unterminated bare tag token ("…Badging&lt;/li" at the very end, or
  // right before the next tag) — the 4.0 value was cut off. Drop it.
  s = s.replace(/&lt;\/?([a-z][a-z0-9]*)(?=\s*(?:$|<|&lt;))/gi, (m, name: string) =>
    KNOWN_TAGS.has(name.toLowerCase()) ? (flags.add("escaped-markup"), "") : m);
  return s.replace(ESCAPED_TAG, (m, slash: string, name: string, attrs: string, selfClose: string) => {
    const tag = name.toLowerCase();
    if (!KNOWN_TAGS.has(tag)) return m;
    if (attrs && !/^\s/.test(attrs)) return m;           // "&lt;lifetime&gt;" isn't a tag
    flags.add("escaped-markup");
    const a = attrs
      .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1")     // auto-linked URL inside src
      .replace(/&quot;/gi, '"').replace(/&#0*39;|&#x0*27;|&apos;/gi, "'").replace(/&amp;/gi, "&");
    return `<${slash}${tag}${a}${selfClose}>`;
  });
}

// ── Step 2: tokenize ──────────────────────────────────────────────────────

type Tok =
  | { t: "text"; v: string }
  | { t: "open"; name: string; attrs: Record<string, string>; rawStyle?: string; self: boolean }
  | { t: "close"; name: string };

// The last alternative tolerates one stray quote right before ">" — 4.0 has
// `line-height:"1em;"` inside a quoted style, which leaves the quotes unbalanced.
const TAG_RE = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-z][a-z0-9]*(?::[a-z]+)?)((?:"[^"]*"|'[^']*'|[^'">]|["'](?=\s*\/?>))*)>/gi;
const ATTR_RE = /([a-z_:][a-z0-9_:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gi;

function tokenize(s: string, flags: Set<DescriptionFlag>): Tok[] {
  const out: Tok[] = [];
  let last = 0;
  let skipUntil: string | null = null;
  for (const m of Array.from(s.matchAll(TAG_RE))) {
    const idx = m.index ?? 0;
    if (idx > last && !skipUntil) out.push({ t: "text", v: s.slice(last, idx) });
    last = idx + m[0].length;
    if (m[0].startsWith("<!--")) { flags.add("script-or-style"); continue; }
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    if (skipUntil) {
      if (closing && name === skipUntil) skipUntil = null;
      continue;
    }
    if (name === "script" || name === "style") {
      flags.add("script-or-style");
      if (!closing && !/\/\s*$/.test(m[3])) skipUntil = name;
      continue;
    }
    if (closing) { out.push({ t: "close", name }); continue; }
    const attrs: Record<string, string> = {};
    let rawStyle: string | undefined;
    const attrSrc = m[3].replace(/\/\s*$/, "");
    for (const am of Array.from(attrSrc.matchAll(ATTR_RE))) {
      const k = am[1].toLowerCase();
      const v = decodeOnce(am[2] ?? am[3] ?? am[4] ?? "");
      attrs[k] = v;
      if (k === "style") rawStyle = am[2] ?? am[3] ?? am[4] ?? "";
    }
    out.push({ t: "open", name, attrs, rawStyle, self: /\/\s*$/.test(m[3]) || VOID_TAGS.has(name) });
  }
  if (last < s.length && !skipUntil) out.push({ t: "text", v: s.slice(last) });
  return out;
}

// ── Step 3: rebuild in the editor's shape ─────────────────────────────────

function filterStyle(raw: string | undefined, flags: Set<DescriptionFlag>): string {
  if (!raw) return "";
  const decls = raw.split(";").map((d) => d.trim()).filter(Boolean);
  const kept: string[] = [];
  for (const d of decls) {
    const i = d.indexOf(":");
    if (i < 0) continue;
    const prop = d.slice(0, i).trim().toLowerCase();
    const value = d.slice(i + 1).trim();
    if (!STYLE_PROPS.has(prop) || !value || value.length > 100 || /url\s*\(|expression\s*\(|javascript:/i.test(value)) {
      flags.add("style-trimmed");
      continue;
    }
    kept.push(d);
  }
  // Keep the author's own formatting ("font-size: 12px") when nothing was
  // dropped, so editor-saved rows don't churn.
  if (kept.length === decls.length) return raw.trim();
  return kept.join("; ");
}

function safeImgSrc(src: string): boolean {
  try {
    const u = new URL(src);
    return u.protocol === "https:" && IMG_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

// Output model: a list of blocks. A block is a paragraph (inline html) or a
// list (items, each a list of blocks). Inline formatting is emitted as it
// streams; open inline tags are closed and re-opened across block breaks.
type Para = { kind: "p"; html: string; style: string };
type List = { kind: "list"; tag: "ul" | "ol"; style: string; items: Block[][] };
type Block = Para | List;

function build(toks: Tok[], flags: Set<DescriptionFlag>): Block[] {
  const root: Block[] = [];
  // Container stack: where new blocks go. Top-level root, or the current <li>.
  // Frames: block containers (root, a list item) and lists. Content that
  // lands directly in a list (between items) opens an item of its own.
  type Frame = { list: List } | { blocks: Block[] };
  const frames: Frame[] = [{ blocks: root }];
  const top = () => frames[frames.length - 1];
  const hasList = () => frames.some((f) => "list" in f);
  const popToList = () => { while (frames.length > 1 && !("list" in top())) frames.pop(); };
  let para = null as Para | null;
  // Open inline tags, outermost first: [outputTag, openingHtml].
  const inline: { src: string; out: string; open: string }[] = [];
  let pendingStyleForP = "";
  let explicitP = false;   // inside an authored <p> that has produced nothing yet

  const cur = (): Block[] => {
    const f = top();
    if ("blocks" in f) return f.blocks;
    const item: Block[] = [];
    f.list.items.push(item);
    frames.push({ blocks: item });
    return item;
  };
  const openPara = () => {
    explicitP = false;
    if (para) return para;
    para = { kind: "p", html: "", style: pendingStyleForP };
    pendingStyleForP = "";
    for (const it of inline) para.html += it.open;
    cur().push(para);
    return para;
  };
  const closePara = () => {
    if (!para) return;
    for (let i = inline.length - 1; i >= 0; i--) para.html += `</${inline[i].out}>`;
    para = null;
  };

  for (const tk of toks) {
    if (tk.t === "text") {
      let v = decodeText(tk.v, flags);
      if (/ /.test(v)) { flags.add("nbsp"); v = v.replace(/ /g, " "); }
      v = v.replace(/[\r\n\t ]+/g, " ");
      if (!v.trim() && !para) continue;               // whitespace between blocks
      openPara().html += escapeText(v);
      continue;
    }
    const name = tk.name;
    if (tk.t === "open") {
      if (name === "br") {
        if (para) para.html += "<br>";
        else if ("list" in top()) flags.add("stray-break");
        else openPara().html += "<br>";
        continue;
      }
      if (name === "p") {
        closePara();
        pendingStyleForP = filterStyle(tk.rawStyle, flags);
        explicitP = true;
        continue;
      }
      if (name === "ul" || name === "ol") {
        closePara();
        const list: List = { kind: "list", tag: name, style: filterStyle(tk.rawStyle, flags), items: [] };
        const t = top();
        if ("list" in t && t.list.items.length) {
          // <ul> straight inside <ul> (4.0 HTML) = a sub-list of the previous
          // bullet; the editor nests it inside that <li>.
          const prev = t.list.items[t.list.items.length - 1];
          prev.push(list);
          frames.push({ blocks: prev });
        } else cur().push(list);
        frames.push({ list });
        continue;
      }
      if (name === "li") {
        closePara();
        if (hasList()) popToList();                    // leave any previous item
        else {                                         // orphan <li> → its own bullet list
          const list: List = { kind: "list", tag: "ul", style: "", items: [] };
          cur().push(list);
          frames.push({ list });
        }
        const item: Block[] = [];
        (top() as { list: List }).list.items.push(item);
        frames.push({ blocks: item });
        continue;
      }
      if (BLOCK_TAGS.has(name)) {
        closePara();
        if (name === "table" || name === "tr" || name === "thead" || name === "tbody") flags.add("table");
        else if (/^h[1-6]$/.test(name)) flags.add("heading");
        else flags.add("dropped-blocks");
        if (/^h[1-6]$/.test(name)) {
          inline.push({ src: name, out: "strong", open: "<strong>" });
        }
        continue;
      }
      if (name === "td" || name === "th") {
        flags.add("table");
        if (para && para.html && !/ $/.test(para.html)) para.html += " ";
        continue;
      }
      if (INLINE_MAP[name] || name === "s" || name === "strike") {
        const out = INLINE_MAP[name] ?? "s";
        if (out === "s") { flags.add("unknown-tag"); continue; }
        const open = `<${out}>`;
        inline.push({ src: name, out, open });
        if (para) para.html += open;
        continue;
      }
      if (name === "span" || name === "font") {
        let style = filterStyle(tk.rawStyle, flags);
        if (name === "font") {
          flags.add("unknown-tag");
          if (tk.attrs.color && /^[#a-z0-9(),.\s%]+$/i.test(tk.attrs.color)) style = style ? `color: ${tk.attrs.color}; ${style}` : `color: ${tk.attrs.color}`;
        }
        if (!style) { inline.push({ src: name, out: "", open: "" }); continue; }
        const open = `<span style="${escapeAttr(style)}">`;
        inline.push({ src: name, out: "span", open });
        if (para) para.html += open;
        continue;
      }
      if (name === "img") {
        const src = tk.attrs.src ?? "";
        if (!safeImgSrc(src)) { flags.add("image-dropped"); continue; }
        let tag = `<img src="${escapeAttr(src)}"`;
        for (const k of ["alt", "width", "height", "title"]) if (tk.attrs[k]) tag += ` ${k}="${escapeAttr(tk.attrs[k])}"`;
        const st = filterStyle(tk.rawStyle, flags);
        if (st) tag += ` style="${escapeAttr(st)}"`;
        openPara().html += tag + ">";
        continue;
      }
      if (name === "a") { flags.add("link"); inline.push({ src: name, out: "", open: "" }); continue; }
      flags.add("unknown-tag");
      if (!tk.self) inline.push({ src: name, out: "", open: "" });
      continue;
    }
    // close
    if (name === "p") {
      // An authored empty paragraph is a deliberate blank line — keep it
      // (serialize drops it only at the edges).
      if (!para && explicitP) cur().push({ kind: "p", html: "", style: "" });
      closePara();
      explicitP = false;
      pendingStyleForP = "";
      continue;
    }
    if (name === "li") {
      closePara();
      if (hasList()) popToList();
      continue;
    }
    if (name === "ul" || name === "ol") {
      closePara();
      if (hasList()) { popToList(); frames.pop(); }
      continue;
    }
    if (BLOCK_TAGS.has(name)) {
      closePara();
      if (/^h[1-6]$/.test(name)) popInline(inline, name, null);
      continue;
    }
    if (name === "td" || name === "th" || name === "br" || name === "img") continue;
    popInline(inline, name, para);
  }
  closePara();
  return root;

  function popInline(stack: typeof inline, src: string, p: Para | null) {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].src === src || (INLINE_MAP[src] && stack[i].out === INLINE_MAP[src])) {
        if (p) for (let j = stack.length - 1; j >= i; j--) if (stack[j].out) p.html += `</${stack[j].out}>`;
        const reopen = stack.slice(i + 1);
        stack.splice(i);
        stack.push(...reopen);
        if (p) for (const r of reopen) p.html += r.open;
        return;
      }
    }
  }
}

// Trim a paragraph's inline html: leading/trailing breaks and spaces, runs of
// more than two breaks. Empty formatting wrappers count as empty.
function tidyInline(html: string, flags: Set<DescriptionFlag>): string {
  let h = html;
  const before = h;
  h = h.replace(/<(strong|em|u|sub|sup)><\/\1>/g, "").replace(/<span style="[^"]*"><\/span>/g, "");
  h = h.replace(/ {2,}/g, " ");
  h = h.replace(/(?:\s*<br>\s*){3,}/g, "<br><br>");
  h = h.replace(/^(?:\s|<br>)+/, (m) => (m.includes("<br>") ? (flags.add("stray-break"), "") : ""));
  h = h.replace(/(?:\s|<br>)+$/, (m) => (m.includes("<br>") ? (flags.add("stray-break"), "") : ""));
  // spaces just inside an inline wrapper at the edges
  h = h.replace(/^((?:<[^/>][^>]*>)+)\s+/, "$1").replace(/\s+((?:<\/[^>]+>)+)$/, "$1");
  h = h.replace(/\s+<br>/g, "<br>").replace(/<br>\s+/g, "<br>");
  if (h !== before && before.replace(/\s+/g, " ").trim() !== h) flags.add("whitespace");
  return h.trim();
}

function isEmptyInline(html: string): boolean {
  return html.replace(/<(?!img)[^>]+>/g, "").trim() === "" && !/<img/.test(html);
}

function serialize(blocks: Block[], flags: Set<DescriptionFlag>, inItem: boolean): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.kind === "p") {
      const h = tidyInline(b.html, flags);
      parts.push(isEmptyInline(h) ? "" : `<p${b.style ? ` style="${escapeAttr(b.style)}"` : ""}>${h}</p>`);
    } else {
      const items = b.items
        .map((it) => serialize(it, flags, true))
        .filter((s) => s !== "");
      if (!items.length) continue;
      parts.push(`<${b.tag}${b.style ? ` style="${escapeAttr(b.style)}"` : ""}>${items.map((s) => `<li>${s}</li>`).join("")}</${b.tag}>`);
    }
  }
  // Empty paragraphs: drop leading/trailing, keep at most one in a row inside.
  let start = 0, end = parts.length;
  while (start < end && parts[start] === "") start++;
  while (end > start && parts[end - 1] === "") end--;
  if (start > 0 || end < parts.length) flags.add("empty-paragraphs");
  const out: string[] = [];
  for (let i = start; i < end; i++) {
    const p = parts[i];
    if (p === "") {
      if (out[out.length - 1] === "<p></p>") { flags.add("empty-paragraphs"); continue; }
      out.push(inItem ? "" : "<p></p>");
      continue;
    }
    out.push(p);
  }
  return out.filter((s) => s !== "").join("");
}

// ── Public API ────────────────────────────────────────────────────────────

const HAS_TAG = /<\/?[a-z][a-z0-9]*(?::[a-z]+)?[\s/>]/i;

export function cleanProductDescription(raw: string | null | undefined): CleanResult {
  const original = raw ?? "";
  const flags = new Set<DescriptionFlag>();
  if (!original.trim()) {
    return { html: original === "" ? "" : "", changed: original !== "", cls: original === "" ? "clean" : "plain-text", flags: original ? ["whitespace"] : [], needsReview: false };
  }

  const unescaped = unescapeMarkup(original, flags);
  const isHtml = HAS_TAG.test(unescaped);

  let html: string;
  if (!isHtml) {
    // Plain text. Leave a clean single line exactly as it is; anything with
    // entities or line breaks becomes what the editor would save on open+Save.
    let text = decodeText(original, flags);
    if (text !== original && /&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/i.test(original)) flags.add("entities");
    if (/ /.test(text)) { flags.add("nbsp"); text = text.replace(/ /g, " "); }
    const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim());
    while (lines.length && !lines[0]) lines.shift();
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    if (lines.length > 1) {
      flags.add("plain-newlines");
      const paras: string[][] = [[]];
      for (const l of lines) {
        if (!l) { if (paras[paras.length - 1].length) paras.push([]); continue; }
        paras[paras.length - 1].push(escapeText(l));
      }
      html = paras.filter((p) => p.length).map((p) => `<p>${p.join("<br>")}</p>`).join("");
    } else {
      // One line. Clean plain text stays byte-identical (it renders fine:
      // the plain-text branch escapes it once). Otherwise store the decoded
      // text raw — storing "&amp;" in PLAIN text prints "&amp;" literally.
      const single = lines[0] ?? "";
      if (single === original) html = original;
      else if (single.includes("<")) html = `<p>${escapeText(single)}</p>`;
      else {
        html = single;
        if (!flags.size) flags.add("whitespace");
      }
    }
  } else {
    html = serialize(build(tokenize(unescaped, flags), flags), flags, false);
  }

  const changed = html !== original;
  if (!changed) return { html, changed, cls: "clean", flags: [], needsReview: false };

  // Visible-tag check: after cleanup, does the TEXT still say "<li" etc.?
  const visibleText = decodeOnce(html.replace(/<[^>]+>/g, " "));
  if (/<\/?[a-z][a-z0-9]*[\s/>]/i.test(visibleText) && Array.from(KNOWN_TAGS).some((t) => new RegExp(`</?${t}[\\s/>]`, "i").test(visibleText))) {
    flags.add("visible-tag-text");
  }

  const cls = classify(original, unescaped, isHtml);
  const needsReview = flags.has("table") || flags.has("visible-tag-text");
  return { html, changed, cls, flags: Array.from(flags).sort(), needsReview };
}

// Junk that prints wrong or comes from 4.0 / pasted source — what the nightly
// check (lib/description-check.ts) flags. Excludes what the editor itself can
// produce (spacing, empty paragraphs, &nbsp;), so editor saves never alarm.
export const JUNK_FLAGS: DescriptionFlag[] = [
  "escaped-markup", "double-encoded", "entities", "dropped-blocks", "table",
  "script-or-style", "unknown-tag", "heading", "link", "visible-tag-text",
];
export function descriptionJunk(raw: string | null | undefined): DescriptionFlag[] {
  return cleanProductDescription(raw).flags.filter((f) => JUNK_FLAGS.includes(f));
}

function classify(original: string, unescaped: string, isHtml: boolean): DescriptionClass {
  if (!isHtml) return "plain-text";
  const tags = new Set<string>();
  for (const m of Array.from(unescaped.matchAll(/<\/?([a-z][a-z0-9]*(?::[a-z]+)?)/gi))) tags.add(m[1].toLowerCase());
  const simple = Array.from(tags).every((t) => SIMPLE_TAGS.has(t)) && !/\sstyle\s*=/i.test(unescaped);
  void original;
  return simple ? "simple-html" : "complex-html";
}
