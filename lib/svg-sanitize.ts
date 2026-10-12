// SVG intake guard (DA-LogoForge Phase 3, 2026-10-11).
//
// Every SVG the platform STORES or SERVES goes through sanitizeSvg() first. An
// SVG is an XML document that can carry scripts, event handlers, external
// references and entity tricks, and our logo buckets are public-read: an SVG
// opened directly from S3 runs in that origin. So this is an ALLOW-list
// sanitizer, a port of da-logoforge/app/library/sanitize.py (same element and
// attribute lists, same rules) — keep the two in step.
//
// It is a strict tokenizer, not a forgiving HTML parser: anything it does not
// understand (unquoted attributes, unknown entities, markup declarations,
// mismatched tags) rejects the whole document. The output is REBUILT from the
// allow-listed tokens with fresh escaping, so nothing the tokenizer didn't
// understand can survive into it.
//
//  * Rejected outright: DTD subsets / <!ENTITY (XXE, billion-laughs), malformed
//    XML, no <svg> root, oversized or absurdly deep documents. A plain DOCTYPE
//    line (Illustrator writes one) and the <?xml?> declaration are dropped.
//  * Elements outside ALLOWED_ELEMENTS are dropped with their subtree (script,
//    foreignObject, image, a, iframe, animate/set, metadata, title/desc,
//    editor namespaces, ...). Text is kept only inside <style>.
//  * Attributes outside ALLOWED_ATTRS are dropped, incl. every on* handler and
//    every namespaced attribute except xlink:href.
//  * href / xlink:href survive only as a same-document "#id" (as `href`).
//  * url(...) survives only as url(#id); @import, @-rules, expression(),
//    javascript: and similar are stripped from attributes and <style>.

export const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_NODES = 200_000;

const ALLOWED_ELEMENTS = new Set([
  "svg", "g", "defs", "symbol", "use", "switch",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "linearGradient", "radialGradient", "stop", "pattern",
  "clipPath", "mask", "style",
]);

const ALLOWED_ATTRS = new Set([
  "id", "class", "viewBox", "preserveAspectRatio", "width", "height", "x", "y",
  "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy", "fr", "d", "points",
  "transform", "pathLength", "version",
  "fill", "fill-rule", "fill-opacity", "stroke", "stroke-width", "stroke-linecap",
  "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset",
  "stroke-opacity", "opacity", "color", "display", "visibility", "overflow",
  "clip-path", "clip-rule", "mask", "style", "vector-effect", "shape-rendering",
  "paint-order", "mix-blend-mode", "isolation",
  "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform",
  "spreadMethod", "patternUnits", "patternContentUnits", "patternTransform",
  "clipPathUnits", "maskUnits", "maskContentUnits",
  "href",
]);

const FRAGMENT = /^#[A-Za-z_][\w.\-:]*$/;
const URL_RE = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
const DANGEROUS_CSS = /@import|expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding|@font-face/gi;
const NAME = /^[A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?$/;

export class SvgSanitizeError extends Error {}

export type SanitizeReport = { removedElements: string[]; removedAttrs: string[]; neutralized: string[] };

type Node = { name: string; attrs: [string, string][]; children: Node[]; text: string; ns: Map<string, string> };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);|&/g, (m, ent: string | undefined) => {
    if (!ent) throw new SvgSanitizeError("bare '&' in document");
    if (ent[0] === "#") {
      const cp = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) throw new SvgSanitizeError("bad character reference");
      return String.fromCodePoint(cp);
    }
    const named: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
    if (!(ent in named)) throw new SvgSanitizeError(`unknown entity &${ent};`);
    return named[ent];
  });
}

/** Strict XML tokenizer → element tree. Throws on anything it doesn't understand. */
function parse(src: string): Node {
  let i = 0;
  const n = src.length;
  const rootHolder: Node = { name: "#doc", attrs: [], children: [], text: "", ns: new Map([["", ""]]) };
  const stack: Node[] = [rootHolder];
  let nodes = 0;

  while (i < n) {
    const lt = src.indexOf("<", i);
    const textEnd = lt === -1 ? n : lt;
    if (textEnd > i) {
      const raw = src.slice(i, textEnd);
      const top = stack[stack.length - 1];
      if (top === rootHolder) {
        if (raw.trim()) throw new SvgSanitizeError("text outside the root element");
      } else {
        top.text += decodeEntities(raw);
      }
      i = textEnd;
      continue;
    }
    // at '<'
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      if (end === -1) throw new SvgSanitizeError("unterminated comment");
      i = end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i + 9);
      if (end === -1) throw new SvgSanitizeError("unterminated CDATA");
      const top = stack[stack.length - 1];
      if (top === rootHolder) throw new SvgSanitizeError("CDATA outside the root element");
      top.text += src.slice(i + 9, end);
      i = end + 3;
      continue;
    }
    if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i + 2);
      if (end === -1) throw new SvgSanitizeError("unterminated processing instruction");
      i = end + 2; // <?xml …?> and any other PI: dropped
      continue;
    }
    if (src.startsWith("<!", i)) throw new SvgSanitizeError("markup declarations are not allowed");
    if (src.startsWith("</", i)) {
      const end = src.indexOf(">", i);
      if (end === -1) throw new SvgSanitizeError("unterminated end tag");
      const name = src.slice(i + 2, end).trim();
      const top = stack.pop();
      if (!top || top === rootHolder || top.name !== name) throw new SvgSanitizeError(`mismatched end tag </${name}>`);
      i = end + 1;
      continue;
    }
    // start tag
    let j = i + 1;
    const nameMatch = /^[A-Za-z_][\w.\-:]*/.exec(src.slice(j, j + 256));
    if (!nameMatch || !NAME.test(nameMatch[0])) throw new SvgSanitizeError("bad tag name");
    const name = nameMatch[0];
    j += name.length;
    const attrs: [string, string][] = [];
    let selfClose = false;
    for (;;) {
      const ws = /^\s*/.exec(src.slice(j, j + 4096))![0];
      j += ws.length;
      if (j >= n) throw new SvgSanitizeError("unterminated start tag");
      if (src.startsWith("/>", j)) { selfClose = true; j += 2; break; }
      if (src[j] === ">") { j += 1; break; }
      if (!ws) throw new SvgSanitizeError("attributes must be separated by whitespace");
      const am = /^([A-Za-z_][\w.\-:]*)\s*=\s*(["'])/.exec(src.slice(j, j + 512));
      if (!am || !NAME.test(am[1])) throw new SvgSanitizeError("malformed attribute (values must be quoted)");
      j += am[0].length;
      const close = src.indexOf(am[2], j);
      if (close === -1) throw new SvgSanitizeError("unterminated attribute value");
      const rawVal = src.slice(j, close);
      if (rawVal.includes("<")) throw new SvgSanitizeError("'<' in attribute value");
      attrs.push([am[1], decodeEntities(rawVal)]);
      j = close + 1;
    }
    const parent = stack[stack.length - 1];
    if (parent === rootHolder && parent.children.length) throw new SvgSanitizeError("more than one root element");
    if (stack.length > MAX_DEPTH) throw new SvgSanitizeError("document nested too deeply");
    if (++nodes > MAX_NODES) throw new SvgSanitizeError("document too large");
    const ns = new Map(parent.ns);
    for (const [k, v] of attrs) {
      if (k === "xmlns") ns.set("", v);
      else if (k.startsWith("xmlns:")) ns.set(k.slice(6), v);
    }
    const node: Node = { name, attrs, children: [], text: "", ns };
    parent.children.push(node);
    if (!selfClose) stack.push(node);
    i = j;
  }
  if (stack.length !== 1) throw new SvgSanitizeError("unclosed element");
  if (rootHolder.children.length !== 1) throw new SvgSanitizeError("no root element");
  return rootHolder.children[0];
}

function split(qname: string): [string, string] {
  const k = qname.indexOf(":");
  return k === -1 ? ["", qname] : [qname.slice(0, k), qname.slice(k + 1)];
}

/** The element's namespace + local name, or null if it isn't an SVG element. */
function svgLocal(node: Node): string | null {
  const [prefix, local] = split(node.name);
  const uri = node.ns.get(prefix);
  if (prefix && uri !== SVG_NS) return null;
  if (!prefix && uri && uri !== SVG_NS) return null;
  return local;
}

function cleanUrls(value: string, report: SanitizeReport, where: string): string {
  let out = value.replace(URL_RE, (_m, _q: string, target: string) => {
    const t = target.trim();
    if (FRAGMENT.test(t)) return `url(${t})`;
    report.neutralized.push(`${where}: external url()`);
    return "none";
  });
  if (new RegExp(DANGEROUS_CSS.source, "i").test(out)) {
    report.neutralized.push(`${where}: dangerous css`);
    out = out.replace(DANGEROUS_CSS, "");
  }
  return out;
}

function cleanStyleBlock(css: string, report: SanitizeReport): string {
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  if (css.includes("@")) {
    report.neutralized.push("style: @-rule");
    css = css.replace(/@[a-z-]+[^;{]*;/gi, "");
    css = css.replace(/@[a-z-]+[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/gi, "");
  }
  // CSS needs no '<'; dropping it means the block can't close an HTML <style>
  // even if this SVG is ever inlined somewhere.
  if (css.includes("<")) { report.neutralized.push("style: '<'"); css = css.replace(/</g, ""); }
  return cleanUrls(css, report, "style").trim();
}

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function cleanAttrs(node: Node, report: SanitizeReport): [string, string][] {
  const out: [string, string][] = [];
  for (const [qname, value] of node.attrs) {
    const [prefix, local] = split(qname);
    if (qname === "xmlns" || prefix === "xmlns") continue; // re-declared on the root only
    const prefixUri = prefix ? node.ns.get(prefix) : undefined;
    const isHref = local === "href" && (!prefix || prefixUri === XLINK_NS || prefix === "xlink");
    if (local.toLowerCase().startsWith("on") || (prefix && !isHref) || (!ALLOWED_ATTRS.has(local) && !isHref)) {
      report.removedAttrs.push(qname);
      continue;
    }
    if (isHref) {
      if (!FRAGMENT.test(value.trim())) { report.removedAttrs.push("href (external)"); continue; }
      out.push(["href", value.trim()]);
      continue;
    }
    let v = value;
    if (/url\(/i.test(v) || new RegExp(DANGEROUS_CSS.source, "i").test(v) || /javascript:/i.test(v)) {
      v = cleanUrls(v, report, local).replace(/javascript:/gi, "");
    }
    out.push([local, v]);
  }
  return out;
}

function serialize(node: Node, local: string, report: SanitizeReport, isRoot: boolean): string {
  const attrs = cleanAttrs(node, report);
  let s = `<${local}`;
  if (isRoot) s += ` xmlns="${SVG_NS}"`;
  for (const [k, v] of attrs) s += ` ${k}="${escAttr(v)}"`;
  let inner = "";
  if (local === "style") {
    inner = escText(cleanStyleBlock(node.text, report));
  } else {
    for (const child of node.children) {
      const cl = svgLocal(child);
      if (!cl || !ALLOWED_ELEMENTS.has(cl)) { report.removedElements.push(child.name); continue; }
      inner += serialize(child, cl, report, false);
    }
  }
  return inner ? `${s}>${inner}</${local}>` : `${s}/>`;
}

/** Sanitize an SVG document. Returns the rebuilt SVG text and what was removed.
 *  Throws SvgSanitizeError when the document can't be accepted at all. */
export function sanitizeSvg(input: string | Uint8Array): { svg: string; report: SanitizeReport } {
  const bytes = typeof input === "string" ? Buffer.byteLength(input) : input.byteLength;
  if (bytes > MAX_BYTES) throw new SvgSanitizeError("SVG too large");
  let text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  text = text.replace(/^﻿/, "");
  if (/<!ENTITY/i.test(text) || /<!DOCTYPE[^>]*\[/i.test(text)) {
    throw new SvgSanitizeError("DTD subsets / ENTITY declarations are not allowed");
  }
  const report: SanitizeReport = { removedElements: [], removedAttrs: [], neutralized: [] };
  if (/<!DOCTYPE/i.test(text)) report.neutralized.push("doctype removed");
  text = text.replace(/<!DOCTYPE[^>[]*>/gi, "");
  const root = parse(text);
  if (svgLocal(root) !== "svg") throw new SvgSanitizeError("root element is not <svg>");
  return { svg: serialize(root, "svg", report, true), report };
}

export function reportIsClean(r: SanitizeReport): boolean {
  return !(r.removedElements.length || r.removedAttrs.length || r.neutralized.length);
}
