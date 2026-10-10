// Image Builder — pure document operations (no DOM). Unit-tested in
// scripts/image-builder-verify-unit.ts.

import type { DesignDoc, DesignElement, ElementType } from "./spec";

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return "el-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const LABELS: Record<ElementType, string> = { frame: "Frame", box: "Box", text: "Text", image: "Image", ellipse: "Circle", line: "Line" };

function nextName(doc: DesignDoc, type: ElementType): string {
  const n = doc.elements.filter((e) => e.type === type).length + 1;
  return `${LABELS[type]} ${n}`;
}

/** A new element with sensible defaults scaled to the document size. */
export function createElement(
  doc: DesignDoc, type: ElementType, W: number, H: number,
  image?: { src: string; naturalWidth: number; naturalHeight: number },
): DesignElement {
  const unit = Math.max(1, Math.round(Math.min(W, H) / 100));
  const base = { id: newId(), name: nextName(doc, type) };
  switch (type) {
    case "frame": {
      const m = unit * 4;
      return { ...base, type, x: m, y: m, w: W - 2 * m, h: H - 2 * m, stroke: "#000000", strokeWidth: unit * 2, radius: unit * 3 };
    }
    case "box": {
      const w = Math.round(W * 0.5), h = Math.round(H * 0.15);
      return { ...base, type, x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h,
        fill: "#e0e0e0", opacity: 1, radius: unit * 2, stroke: null, strokeWidth: unit };
    }
    case "text": {
      const size = Math.max(8, Math.round(Math.min(W, H) / 14));
      const w = Math.round(W * 0.8), h = Math.round(size * 1.2 * 2);
      return { ...base, type, x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h,
        text: "Text", font: "inter", size, bold: false, color: "#000000", align: "center", lineHeight: 1.2 };
    }
    case "ellipse": {
      const d = Math.round(Math.min(W, H) * 0.5);
      return { ...base, type, x: Math.round((W - d) / 2), y: Math.round((H - d) / 2), w: d, h: d,
        fill: null, opacity: 1, stroke: "#000000", strokeWidth: unit * 2 };
    }
    case "line": {
      const w = Math.round(W * 0.6), sw = Math.max(1, unit);
      const h = Math.max(4, sw * 4);
      return { ...base, type, x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h, stroke: "#000000", strokeWidth: sw };
    }
    case "image": {
      const nw = image?.naturalWidth || 100, nh = image?.naturalHeight || 100;
      const s = Math.min((W * 0.5) / nw, (H * 0.5) / nh, 1);
      const w = Math.max(1, Math.round(nw * s)), h = Math.max(1, Math.round(nh * s));
      return { ...base, type, x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h,
        src: image?.src ?? "", fit: "contain", opacity: 1 };
    }
  }
}

export function updateElement(doc: DesignDoc, id: string, patch: Partial<DesignElement>): DesignDoc {
  return { ...doc, elements: doc.elements.map((e) => (e.id === id ? ({ ...e, ...patch } as DesignElement) : e)) };
}

export function removeElement(doc: DesignDoc, id: string): DesignDoc {
  return { ...doc, elements: doc.elements.filter((e) => e.id !== id) };
}

/** Duplicate `id` directly above itself, offset by `offset` px. Returns the new doc + new id. */
export function duplicateElement(doc: DesignDoc, id: string, offset: number): { doc: DesignDoc; id: string | null } {
  const i = doc.elements.findIndex((e) => e.id === id);
  if (i < 0) return { doc, id: null };
  const src = doc.elements[i];
  const copy = { ...src, id: newId(), name: `${src.name} copy`, x: src.x + offset, y: src.y + offset } as DesignElement;
  const elements = [...doc.elements];
  elements.splice(i + 1, 0, copy);
  return { doc: { ...doc, elements }, id: copy.id };
}

/** Move `id` one step up (toward the top of the paint order) or down. */
export function reorder(doc: DesignDoc, id: string, dir: "up" | "down"): DesignDoc {
  const i = doc.elements.findIndex((e) => e.id === id);
  const j = dir === "up" ? i + 1 : i - 1;
  if (i < 0 || j < 0 || j >= doc.elements.length) return doc;
  const elements = [...doc.elements];
  [elements[i], elements[j]] = [elements[j], elements[i]];
  return { ...doc, elements };
}

export interface Rect { x: number; y: number; w: number; h: number }

/** Resize `r` by dragging `handle` by (dx, dy) in document px. Min size 1. */
export function resizeRect(r: Rect, handle: Handle, dx: number, dy: number): Rect {
  let { x, y, w, h } = r;
  if (handle.includes("w")) { const nw = Math.max(1, w - dx); x = x + (w - nw); w = nw; }
  if (handle.includes("e")) { w = Math.max(1, w + dx); }
  if (handle.includes("n")) { const nh = Math.max(1, h - dy); y = y + (h - nh); h = nh; }
  if (handle.includes("s")) { h = Math.max(1, h + dy); }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/** Deep-ish equality for dirty tracking / undo coalescing. */
export function sameDoc(a: DesignDoc, b: DesignDoc): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
