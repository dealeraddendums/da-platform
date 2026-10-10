// Image Builder canvas renderer — the ONE drawing routine. The editor preview
// and the PNG export both call drawDesign(), so what staff see is what ships.
// Canvas rendering (not SVG→img) so self-hosted webfonts render in exports.
//
// Browser-only (uses CanvasRenderingContext2D / Image / document.fonts).

import {
  FONTS,
  IMAGE_TYPES,
  PPM_150_DPI,
  type DesignDoc,
  type DesignElement,
  type ImageType,
  type TextElement,
} from "./spec";
import { setPngPhys } from "./png-dpi";

export type ImageCache = Map<string, HTMLImageElement>;

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/** Stroke a rounded rect so the stroke lies entirely inside (x,y,w,h). */
function insideStroke(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, sw: number, color: string): void {
  if (sw <= 0) return;
  const half = sw / 2;
  roundRectPath(ctx, x + half, y + half, Math.max(0, w - sw), Math.max(0, h - sw), Math.max(0, r - half));
  ctx.lineWidth = sw;
  ctx.strokeStyle = color;
  ctx.stroke();
}

export function fontString(e: Pick<TextElement, "bold" | "size" | "font">): string {
  return `${e.bold ? 700 : 400} ${e.size}px ${FONTS[e.font].stack}`;
}

/** Word-wrap `text` to `maxWidth` using the context's current font. Honours
 *  explicit newlines; a single word wider than the box breaks by character. */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const fits = (s: string) => ctx.measureText(s).width <= maxWidth;
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    let paraStart = true;
    for (const tok of para.split(/(\s+)/)) {
      if (tok === "") continue;
      if (/^\s+$/.test(tok)) {
        // keep indentation at a paragraph start; otherwise spaces only between words
        if (line !== "" || paraStart) line += tok;
        continue;
      }
      paraStart = false;
      if (fits(line + tok)) { line += tok; continue; }
      if (line.trim() !== "") { out.push(line.trimEnd()); line = ""; }
      if (fits(tok)) { line = tok; continue; }
      for (const ch of tok) {
        if (line !== "" && !fits(line + ch)) { out.push(line); line = ch; }
        else line += ch;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

function drawText(ctx: CanvasRenderingContext2D, e: TextElement): void {
  ctx.font = fontString(e);
  ctx.fillStyle = e.color;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = e.align;
  const lineBox = e.size * e.lineHeight;
  const lines = wrapText(ctx, e.text, e.w);
  const ax = e.align === "left" ? e.x : e.align === "center" ? e.x + e.w / 2 : e.x + e.w;
  lines.forEach((ln, i) => {
    const baseline = e.y + i * lineBox + (lineBox - e.size) / 2 + e.size * 0.8;
    ctx.fillText(ln, ax, baseline);
  });
}

function drawElement(ctx: CanvasRenderingContext2D, e: DesignElement, images: ImageCache): void {
  if (e.hidden) return;
  ctx.save();
  switch (e.type) {
    case "frame":
      insideStroke(ctx, e.x, e.y, e.w, e.h, e.radius, e.strokeWidth, e.stroke);
      break;
    case "box":
      ctx.globalAlpha = e.opacity;
      if (e.knockout) {
        // erase to transparent (opacity = how much is erased)
        ctx.globalCompositeOperation = "destination-out";
        roundRectPath(ctx, e.x, e.y, e.w, e.h, e.radius);
        ctx.fillStyle = "#000000";
        ctx.fill();
        break;
      }
      roundRectPath(ctx, e.x, e.y, e.w, e.h, e.radius);
      ctx.fillStyle = e.fill;
      ctx.fill();
      if (e.stroke) insideStroke(ctx, e.x, e.y, e.w, e.h, e.radius, e.strokeWidth, e.stroke);
      break;
    case "ellipse": {
      // Stroke sits INSIDE the box, matching frame/box.
      const sw = e.stroke ? Math.min(e.strokeWidth, e.w / 2, e.h / 2) : 0;
      const rx = Math.max(0, e.w / 2 - sw / 2), ry = Math.max(0, e.h / 2 - sw / 2);
      ctx.globalAlpha = e.opacity;
      ctx.beginPath();
      ctx.ellipse(e.x + e.w / 2, e.y + e.h / 2, Math.max(0, e.w / 2 - sw), Math.max(0, e.h / 2 - sw), 0, 0, Math.PI * 2);
      if (e.fill) { ctx.fillStyle = e.fill; ctx.fill(); }
      if (e.stroke && sw > 0) {
        ctx.beginPath();
        ctx.ellipse(e.x + e.w / 2, e.y + e.h / 2, rx, ry, 0, 0, Math.PI * 2);
        ctx.lineWidth = sw; ctx.strokeStyle = e.stroke; ctx.stroke();
      }
      break;
    }
    case "line": {
      if (e.strokeWidth <= 0) break;
      ctx.beginPath();
      if (e.w >= e.h) { ctx.moveTo(e.x, e.y + e.h / 2); ctx.lineTo(e.x + e.w, e.y + e.h / 2); }
      else { ctx.moveTo(e.x + e.w / 2, e.y); ctx.lineTo(e.x + e.w / 2, e.y + e.h); }
      ctx.lineWidth = e.strokeWidth; ctx.strokeStyle = e.stroke; ctx.lineCap = "butt"; ctx.stroke();
      break;
    }
    case "text":
      drawText(ctx, e);
      break;
    case "image": {
      const img = images.get(e.src);
      if (!img || !img.naturalWidth) break;
      ctx.globalAlpha = e.opacity;
      if (e.fit === "stretch") {
        ctx.drawImage(img, e.x, e.y, e.w, e.h);
      } else {
        const s = Math.min(e.w / img.naturalWidth, e.h / img.naturalHeight);
        const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
        ctx.drawImage(img, e.x + (e.w - dw) / 2, e.y + (e.h - dh) / 2, dw, dh);
      }
      break;
    }
  }
  ctx.restore();
}

/**
 * Paint `doc` onto `ctx`. `scale` maps document px → canvas px (1 for export;
 * the editor passes its zoom × devicePixelRatio). The canvas must already be
 * sized to width*scale × height*scale.
 */
export function drawDesign(ctx: CanvasRenderingContext2D, doc: DesignDoc, width: number, height: number, scale: number, images: ImageCache): void {
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (doc.background) {
    ctx.fillStyle = doc.background;
    ctx.fillRect(0, 0, width, height);
  }
  for (const e of doc.elements) drawElement(ctx, e, images);
}

/** Decode every embedded image (reusing `cache`). */
export async function loadImages(doc: DesignDoc, cache: ImageCache = new Map()): Promise<ImageCache> {
  const srcs = Array.from(new Set(doc.elements.flatMap((e) => (e.type === "image" ? [e.src] : []))));
  await Promise.all(
    srcs.filter((s) => !cache.has(s)).map(
      (src) =>
        new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => { cache.set(src, img); resolve(); };
          img.onerror = () => resolve();
          img.src = src;
        })
    )
  );
  return cache;
}

/** Make sure every font the design uses is loaded before we paint. */
export async function ensureFonts(doc: DesignDoc): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  const texts = doc.elements.filter((e): e is TextElement => e.type === "text");
  await Promise.all(texts.map((e) => document.fonts.load(fontString(e), e.text || "A").catch(() => [])));
  await document.fonts.ready;
}

/**
 * Render `doc` at exact document pixels and return PNG bytes tagged 150 DPI.
 * Throws if the browser produced the wrong size (should be impossible).
 */
export async function renderDesignPng(doc: DesignDoc, imageType: ImageType): Promise<Uint8Array> {
  const spec = IMAGE_TYPES[imageType];
  await ensureFonts(doc);
  const images = await loadImages(doc);
  const canvas = document.createElement("canvas");
  canvas.width = spec.width;
  canvas.height = spec.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D unavailable");
  drawDesign(ctx, doc, spec.width, spec.height, 1, images);
  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encode failed"))), "image/png")
  );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return setPngPhys(bytes, PPM_150_DPI);
}
