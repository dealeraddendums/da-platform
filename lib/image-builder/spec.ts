// Image Builder — shared types + image-type specs (migration 163).
//
// The Image Builder is ONLY for designing and saving images. Nothing in the
// print path imports from lib/image-builder — PDFs keep consuming the flat PNGs
// in the Image Library exactly as before.

export type ImageType = "infobox" | "addendum_bg_standard" | "addendum_bg_narrow" | "infosheet_bg";

export interface ImageTypeSpec {
  type: ImageType;
  label: string;
  width: number;
  height: number;
  maxBytes: number;
  /** The Image Library bucket (= tab) the rendered PNG is saved into. */
  bucket: "new-infobox-images" | "new-addendum-backgrounds" | "new-infosheet-backgrounds";
}

export const DPI = 150;
/** pHYs pixels-per-metre for 150 DPI: round(150 / 0.0254). */
export const PPM_150_DPI = 5906;

export const IMAGE_TYPES: Record<ImageType, ImageTypeSpec> = {
  infobox: {
    type: "infobox", label: "Infobox Image",
    width: 553, height: 339, maxBytes: 5 * 1024 * 1024, bucket: "new-infobox-images",
  },
  addendum_bg_standard: {
    type: "addendum_bg_standard", label: "Addendum Background — Standard",
    width: 638, height: 1650, maxBytes: 5 * 1024 * 1024, bucket: "new-addendum-backgrounds",
  },
  addendum_bg_narrow: {
    type: "addendum_bg_narrow", label: "Addendum Background — Narrow",
    width: 469, height: 1650, maxBytes: 5 * 1024 * 1024, bucket: "new-addendum-backgrounds",
  },
  infosheet_bg: {
    type: "infosheet_bg", label: "Infosheet Background",
    width: 2657, height: 3438, maxBytes: 10 * 1024 * 1024, bucket: "new-infosheet-backgrounds",
  },
};

export const IMAGE_TYPE_LIST: ImageTypeSpec[] = Object.values(IMAGE_TYPES);

export function isImageType(v: unknown): v is ImageType {
  return typeof v === "string" && v in IMAGE_TYPES;
}

// ── Design document ──────────────────────────────────────────────────────────

export type FontKey =
  | "sf-pro" | "inter" | "arial" | "helvetica" | "georgia" | "times" | "courier" | "impact";

/** CSS / canvas font stacks. "SF Pro" is the system stack — Apple's font files
 *  are never bundled (licence). "Inter" is self-hosted (public/fonts) under a
 *  private family name so a locally installed Inter can never substitute. */
export const FONTS: Record<FontKey, { label: string; stack: string }> = {
  "sf-pro":  { label: "SF Pro (system)", stack: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
  inter:     { label: "Inter",           stack: '"DA Inter", sans-serif' },
  arial:     { label: "Arial",           stack: "Arial, sans-serif" },
  helvetica: { label: "Helvetica",       stack: "Helvetica, Arial, sans-serif" },
  georgia:   { label: "Georgia",         stack: "Georgia, serif" },
  times:     { label: "Times New Roman", stack: '"Times New Roman", Times, serif' },
  courier:   { label: "Courier New",     stack: '"Courier New", Courier, monospace' },
  impact:    { label: "Impact",          stack: "Impact, sans-serif" },
};

interface ElementBase {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  hidden?: boolean;
}

/** Stroke-only rounded rect. The stroke sits fully INSIDE the element box. */
export interface FrameElement extends ElementBase {
  type: "frame";
  stroke: string;
  strokeWidth: number;
  radius: number;
}

/** Filled rounded rect with optional inside stroke. With `knockout`, the box
 *  instead punches a transparent hole through everything beneath it (the
 *  see-through window in an infobox shell). */
export interface BoxElement extends ElementBase {
  type: "box";
  knockout?: boolean;
  fill: string;
  opacity: number;          // 0..1
  radius: number;
  stroke: string | null;
  strokeWidth: number;
}

export interface TextElement extends ElementBase {
  type: "text";
  text: string;
  font: FontKey;
  size: number;             // px at document resolution
  bold: boolean;
  color: string;
  align: "left" | "center" | "right";
  lineHeight: number;       // multiplier of size
}

export interface ImageElement extends ElementBase {
  type: "image";
  /** data: URL only — keeps the design self-contained and the export canvas untainted. */
  src: string;
  fit: "contain" | "stretch";
  opacity: number;
}

export type DesignElement = FrameElement | BoxElement | TextElement | ImageElement;
export type ElementType = DesignElement["type"];

export interface DesignDoc {
  version: 1;
  /** Solid page colour, or null for a transparent PNG. */
  background: string | null;
  /** Bottom-to-top paint order. */
  elements: DesignElement[];
}

export interface DesignRow {
  id: string;
  dealer_uuid: string | null;
  image_type: ImageType;
  name: string;
  design_json: DesignDoc;
  is_template: boolean;
  exported_image_id: string | null;
  replaces_image_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Largest embedded image we accept (data URL length). Logos/watermarks only. */
export const MAX_EMBEDDED_IMAGE_BYTES = 3 * 1024 * 1024;
/** Hard cap on a whole design_json payload. */
export const MAX_DESIGN_JSON_BYTES = 12 * 1024 * 1024;

const HEX = /^#[0-9a-fA-F]{6}$/;

function num(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;
}

/**
 * Validate an untrusted design document. Returns an error string, or null when
 * valid. Server-side gate for every write; unknown element types are rejected.
 */
export function validateDesign(doc: unknown): string | null {
  if (!doc || typeof doc !== "object") return "design_json must be an object";
  const d = doc as Record<string, unknown>;
  if (d.version !== 1) return "design_json.version must be 1";
  if (d.background !== null && !(typeof d.background === "string" && HEX.test(d.background))) {
    return "background must be #rrggbb or null";
  }
  if (!Array.isArray(d.elements)) return "elements must be an array";
  if (d.elements.length > 500) return "too many elements (max 500)";
  const ids = new Set<string>();
  for (let i = 0; i < d.elements.length; i++) {
    const e = d.elements[i] as Record<string, unknown>;
    const at = `elements[${i}]`;
    if (!e || typeof e !== "object") return `${at} must be an object`;
    if (typeof e.id !== "string" || !e.id || ids.has(e.id)) return `${at}.id missing or duplicate`;
    ids.add(e.id);
    if (typeof e.name !== "string") return `${at}.name must be a string`;
    for (const k of ["x", "y"]) if (num(e[k], -20000, 20000) === null) return `${at}.${k} out of range`;
    for (const k of ["w", "h"]) if (num(e[k], 1, 20000) === null) return `${at}.${k} out of range`;
    switch (e.type) {
      case "frame":
        if (!HEX.test(String(e.stroke))) return `${at}.stroke must be #rrggbb`;
        if (num(e.strokeWidth, 0, 1000) === null || num(e.radius, 0, 10000) === null) return `${at} bad stroke/radius`;
        break;
      case "box":
        if (!HEX.test(String(e.fill))) return `${at}.fill must be #rrggbb`;
        if (e.stroke !== null && !HEX.test(String(e.stroke))) return `${at}.stroke must be #rrggbb or null`;
        if (e.knockout !== undefined && typeof e.knockout !== "boolean") return `${at}.knockout must be boolean`;
        if (num(e.opacity, 0, 1) === null || num(e.radius, 0, 10000) === null || num(e.strokeWidth, 0, 1000) === null) {
          return `${at} bad opacity/radius/stroke`;
        }
        break;
      case "text":
        if (typeof e.text !== "string" || e.text.length > 20000) return `${at}.text invalid`;
        if (!(typeof e.font === "string" && e.font in FONTS)) return `${at}.font unknown`;
        if (num(e.size, 1, 2000) === null || num(e.lineHeight, 0.5, 5) === null) return `${at} bad size/lineHeight`;
        if (typeof e.bold !== "boolean") return `${at}.bold must be boolean`;
        if (!HEX.test(String(e.color))) return `${at}.color must be #rrggbb`;
        if (!["left", "center", "right"].includes(String(e.align))) return `${at}.align invalid`;
        break;
      case "image":
        if (typeof e.src !== "string" || !/^data:image\/(png|jpeg);base64,/.test(e.src)) {
          return `${at}.src must be a PNG/JPG data URL`;
        }
        if (e.src.length > MAX_EMBEDDED_IMAGE_BYTES * 1.4) return `${at} image too large`;
        if (!["contain", "stretch"].includes(String(e.fit))) return `${at}.fit invalid`;
        if (num(e.opacity, 0, 1) === null) return `${at}.opacity invalid`;
        break;
      default:
        return `${at}.type unknown`;
    }
  }
  return null;
}
