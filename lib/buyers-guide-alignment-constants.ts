// Buyer's Guide alignment — DEFAULT field anchor positions (PDF points,
// origin bottom-left, page 612×792), client-importable (no pdf-lib).
//
// ⚠️ Values are copied from the calibrated tables in lib/buyers-guide-pdf.ts /
// da-pdf-service buyer-guide-overlay.js — keep all three in sync if the
// calibration ever changes. The pre-printed-label alignment tool renders these
// anchors as draggable chips; saved offsets are deltas from these positions.

export type BgFieldKind = "text" | "checkbox";
export interface BgFieldDef {
  key: string;
  label: string;
  page: 0 | 1; // 0 = front, 1 = back
  x: number;
  y: number;
  kind: BgFieldKind;
  /** only drawn for certain warranty configs; still adjustable */
  conditional?: boolean;
}

const VROW_Y = 646;

// Variant tables (front page). Key: `${lang}-${implied ? "implied" : "asis"}`.
const FRONT_VARIANTS: Record<string, Omit<BgFieldDef, "page">[]> = {
  "en-asis": [
    { key: "asIs",    label: "AS IS checkbox",            x: 92,  y: 585, kind: "checkbox" },
    { key: "dlrW",    label: "Dealer Warranty checkbox",  x: 92,  y: 535, kind: "checkbox", conditional: true },
    { key: "full",    label: "Full Warranty checkbox",    x: 99,  y: 510, kind: "checkbox", conditional: true },
    { key: "lim",     label: "Limited Warranty checkbox", x: 99,  y: 492, kind: "checkbox", conditional: true },
    { key: "labor",   label: "% Labor",                   x: 280, y: 489, kind: "text", conditional: true },
    { key: "parts",   label: "% Parts",                   x: 370, y: 489, kind: "text", conditional: true },
    { key: "systems", label: "Systems covered",           x: 68,  y: 419, kind: "text", conditional: true },
    { key: "duration",label: "Duration",                  x: 315, y: 419, kind: "text", conditional: true },
    { key: "mfrNew",  label: "Mfr new-warranty box",      x: 85,  y: 325, kind: "checkbox", conditional: true },
    { key: "mfrUsed", label: "Mfr used-warranty box",     x: 85,  y: 301, kind: "checkbox", conditional: true },
    { key: "othUsed", label: "Other used-warranty box",   x: 85,  y: 285, kind: "checkbox", conditional: true },
    { key: "svcCont", label: "Service contract box",      x: 85,  y: 235, kind: "checkbox", conditional: true },
  ],
  "en-implied": [
    { key: "implied", label: "Implied Only checkbox",     x: 92,  y: 586, kind: "checkbox" },
    { key: "dlrW",    label: "Dealer Warranty checkbox",  x: 92,  y: 536, kind: "checkbox", conditional: true },
    { key: "full",    label: "Full Warranty checkbox",    x: 99,  y: 511, kind: "checkbox", conditional: true },
    { key: "lim",     label: "Limited Warranty checkbox", x: 99,  y: 493, kind: "checkbox", conditional: true },
    { key: "labor",   label: "% Labor",                   x: 280, y: 490, kind: "text", conditional: true },
    { key: "parts",   label: "% Parts",                   x: 370, y: 490, kind: "text", conditional: true },
    { key: "systems", label: "Systems covered",           x: 68,  y: 420, kind: "text", conditional: true },
    { key: "duration",label: "Duration",                  x: 315, y: 420, kind: "text", conditional: true },
    { key: "mfrNew",  label: "Mfr new-warranty box",      x: 85,  y: 326, kind: "checkbox", conditional: true },
    { key: "mfrUsed", label: "Mfr used-warranty box",     x: 85,  y: 302, kind: "checkbox", conditional: true },
    { key: "othUsed", label: "Other used-warranty box",   x: 85,  y: 286, kind: "checkbox", conditional: true },
    { key: "svcCont", label: "Service contract box",      x: 85,  y: 236, kind: "checkbox", conditional: true },
  ],
  "es-asis": [
    { key: "asIs",    label: "COMO ESTÁ checkbox",        x: 92,  y: 585, kind: "checkbox" },
    { key: "dlrW",    label: "Dealer Warranty checkbox",  x: 92,  y: 508, kind: "checkbox", conditional: true },
    { key: "full",    label: "Full Warranty checkbox",    x: 99,  y: 510, kind: "checkbox", conditional: true },
    { key: "lim",     label: "Limited Warranty checkbox", x: 99,  y: 465, kind: "checkbox", conditional: true },
    { key: "labor",   label: "% Labor",                   x: 312, y: 462, kind: "text", conditional: true },
    { key: "parts",   label: "% Parts",                   x: 402, y: 462, kind: "text", conditional: true },
    { key: "systems", label: "Systems covered",           x: 68,  y: 392, kind: "text", conditional: true },
    { key: "duration",label: "Duration",                  x: 315, y: 392, kind: "text", conditional: true },
    { key: "mfrNew",  label: "Mfr new-warranty box",      x: 85,  y: 311, kind: "checkbox", conditional: true },
    { key: "mfrUsed", label: "Mfr used-warranty box",     x: 85,  y: 292, kind: "checkbox", conditional: true },
    { key: "othUsed", label: "Other used-warranty box",   x: 85,  y: 280, kind: "checkbox", conditional: true },
    { key: "svcCont", label: "Service contract box",      x: 85,  y: 235, kind: "checkbox", conditional: true },
  ],
  "es-implied": [
    { key: "implied", label: "Implied Only checkbox",     x: 92,  y: 586, kind: "checkbox" },
    { key: "dlrW",    label: "Dealer Warranty checkbox",  x: 92,  y: 536, kind: "checkbox", conditional: true },
    { key: "full",    label: "Full Warranty checkbox",    x: 99,  y: 511, kind: "checkbox", conditional: true },
    { key: "lim",     label: "Limited Warranty checkbox", x: 99,  y: 493, kind: "checkbox", conditional: true },
    { key: "labor",   label: "% Labor",                   x: 280, y: 490, kind: "text", conditional: true },
    { key: "parts",   label: "% Parts",                   x: 370, y: 490, kind: "text", conditional: true },
    { key: "systems", label: "Systems covered",           x: 68,  y: 420, kind: "text", conditional: true },
    { key: "duration",label: "Duration",                  x: 315, y: 420, kind: "text", conditional: true },
    { key: "mfrNew",  label: "Mfr new-warranty box",      x: 85,  y: 312, kind: "checkbox", conditional: true },
    { key: "mfrUsed", label: "Mfr used-warranty box",     x: 85,  y: 293, kind: "checkbox", conditional: true },
    { key: "othUsed", label: "Other used-warranty box",   x: 85,  y: 281, kind: "checkbox", conditional: true },
    { key: "svcCont", label: "Service contract box",      x: 85,  y: 236, kind: "checkbox", conditional: true },
  ],
};

const VEHICLE_ROW: Omit<BgFieldDef, "page">[] = [
  { key: "make",  label: "Vehicle Make",  x: 72,  y: VROW_Y, kind: "text" },
  { key: "model", label: "Vehicle Model", x: 190, y: VROW_Y, kind: "text" },
  { key: "year",  label: "Vehicle Year",  x: 310, y: VROW_Y, kind: "text" },
  { key: "vin",   label: "VIN",           x: 390, y: VROW_Y, kind: "text" },
];

const BACK_FIELDS: Omit<BgFieldDef, "page">[] = [
  { key: "name",       label: "Dealer Name",        x: 104, y: 197, kind: "text" },
  { key: "addr",       label: "Dealer Address",     x: 104, y: 175, kind: "text" },
  { key: "phone",      label: "Dealer Phone",       x: 104, y: 152, kind: "text" },
  { key: "email",      label: "Dealer Email",       x: 346, y: 152, kind: "text", conditional: true },
  { key: "complaints", label: "Complaints Contact", x: 104, y: 128, kind: "text", conditional: true },
];

/** All fields for a variant, page-tagged. */
export function bgFieldDefs(language: "en" | "es", implied: boolean): BgFieldDef[] {
  const variant = FRONT_VARIANTS[`${language}-${implied ? "implied" : "asis"}`];
  return [
    ...VEHICLE_ROW.map((f) => ({ ...f, page: 0 as const })),
    ...variant.map((f) => ({ ...f, page: 0 as const })),
    ...BACK_FIELDS.map((f) => ({ ...f, page: 1 as const })),
  ];
}

export const BG_PAGE_W = 612;
export const BG_PAGE_H = 792;
