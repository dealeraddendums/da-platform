// Content-seed: map a migrated dealer's LEGACY addendum config (Aurora
// `template_builder`, keyed by DEALER_ID) onto their NEW default builder
// template so it feels familiar on day one.
//
// SCOPE: content/config ONLY — labels, show/hide, address, the dealer's footer
// disclaimer. NOT layout. The 2026-06-16 read-only investigation
// (legacy-template-investigation-2026-06-16.md) established the legacy format is
// fixed-slot config (case d) with no mappable 2-D coordinates, so migrated
// dealers take the new DEFAULT (or group) template + their synced options and
// this seed pre-fills the familiar wording/toggles on top. Positions are NOT
// touched (Allan ground-truths those).
//
// Pure functions, no I/O. The future 13a `/migrate` flow calls buildContentSeed()
// with the dealer's legacy row (via the Aurora reader) then applyContentSeed()
// when creating the dealer's template_json.

// Subset of Aurora `template_builder` columns this seed reads.
export interface LegacyTemplateRow {
  DEALER_ID?: string;
  TEMPLATE_NAME?: string | null;
  TEMPLATE_FOR?: string | null;
  TOTALDESC?: string | null;     // → askbar label  ("Dealer Asking Price:")
  MSRPDESC?: string | null;      // → msrp label
  SUBTOTALDESC?: string | null;  // → subtotal label
  SECTIONDESC?: string | null;   // → options section label
  ADDRESS?: string | null;       // → dealer address block
  // vehicle-info show flags
  SHOWSTOCK?: number; SHOWVIN?: number; SHOWYEAR?: number; SHOWMAKE?: number;
  SHOWMODEL?: number; SHOWCOLOR?: number; SHOWTRIM?: number; SHOWMILEAGE?: number;
  // section show flags
  SHOWMSRP?: number; SHOWSUBTOTAL?: number; SHOWTOTAL?: number; SHOWLOGO?: number;
  SHOW_DECIMALS?: number;
  OPTIONPALIGN?: string | null;  // left | right
  // footer disclaimer (rich HTML in legacy)
  QR_FOOTER?: string | null;
  BAR_FOOTER?: string | null;
}

const VEHICLE_FIELD_FLAGS: Array<[keyof LegacyTemplateRow, string]> = [
  ['SHOWSTOCK', 'stock'], ['SHOWVIN', 'vin'], ['SHOWYEAR', 'year'],
  ['SHOWMAKE', 'make'], ['SHOWMODEL', 'model'], ['SHOWCOLOR', 'color'],
  ['SHOWTRIM', 'trim'], ['SHOWMILEAGE', 'mileage'],
];

export interface ContentSeed {
  labels: { askbar?: string; msrp?: string; subtotal?: string; optionsSection?: string };
  dealerAddress?: string;
  /** Which vehicle-info fields the dealer kept visible (subset of the 8). */
  vehicleFields?: string[];
  /** New-template widget TYPES to drop because the dealer hid them. */
  hide: string[];
  /** Plain-text disclaimer (legacy footer HTML flattened), or undefined. */
  disclaimerText?: string;
  showDecimals?: boolean;
  optionPriceAlign?: 'left' | 'right';
  source: { dealerId: string | null; templateName: string | null; templateFor: string | null };
}

const clean = (s: string | null | undefined): string | undefined => {
  const t = (s ?? '').trim();
  return t.length ? t : undefined;
};

// Legacy footer is rich HTML (<br/>, <strong>…). Flatten to plain text for the
// new disclaimer widget: <br> → newline, strip remaining tags, decode a couple
// of common entities, collapse whitespace.
function htmlToText(html: string | null | undefined): string | undefined {
  if (!html) return undefined;
  const txt = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.trim()).join('\n')
    .trim();
  return txt.length ? txt : undefined;
}

export function buildContentSeed(row: LegacyTemplateRow): ContentSeed {
  const on = (v: number | undefined) => v === undefined ? true : v === 1; // default-shown

  const vehicleFields = VEHICLE_FIELD_FLAGS.filter(([flag]) => on(row[flag] as number | undefined)).map(([, name]) => name);

  const hide: string[] = [];
  if (!on(row.SHOWMSRP)) hide.push('msrp');
  if (!on(row.SHOWSUBTOTAL)) hide.push('subtotal');
  if (!on(row.SHOWTOTAL)) hide.push('askbar');
  if (!on(row.SHOWLOGO)) hide.push('logo');

  return {
    labels: {
      askbar: clean(row.TOTALDESC),
      msrp: clean(row.MSRPDESC),
      subtotal: clean(row.SUBTOTALDESC),
      optionsSection: clean(row.SECTIONDESC),
    },
    dealerAddress: clean(row.ADDRESS),
    vehicleFields: vehicleFields.length ? vehicleFields : undefined,
    hide,
    disclaimerText: htmlToText(row.QR_FOOTER) ?? htmlToText(row.BAR_FOOTER),
    showDecimals: row.SHOW_DECIMALS === undefined ? undefined : row.SHOW_DECIMALS === 1,
    optionPriceAlign: row.OPTIONPALIGN === 'right' ? 'right' : row.OPTIONPALIGN === 'left' ? 'left' : undefined,
    source: { dealerId: row.DEALER_ID ?? null, templateName: row.TEMPLATE_NAME ?? null, templateFor: row.TEMPLATE_FOR ?? null },
  };
}

type Widget = { id: string; type: string; d?: Record<string, unknown> } & Record<string, unknown>;

/**
 * Overlay a ContentSeed onto a default template's widget map (id → widget).
 * Returns a NEW map; positions/sizes are untouched. Widgets the dealer hid are
 * removed. Unknown widgets pass through unchanged.
 */
export function applyContentSeed(
  widgets: Record<string, Widget>,
  seed: ContentSeed,
): Record<string, Widget> {
  const out: Record<string, Widget> = {};
  for (const [id, w] of Object.entries(widgets)) {
    if (seed.hide.includes(w.type)) continue; // dealer had this off
    const d = { ...(w.d ?? {}) };
    switch (w.type) {
      case 'askbar': if (seed.labels.askbar) d.label = seed.labels.askbar; break;
      case 'msrp': if (seed.labels.msrp) d.label = seed.labels.msrp; break;
      case 'subtotal': if (seed.labels.subtotal) d.label = seed.labels.subtotal; break;
      case 'options':
        if (seed.labels.optionsSection) d.sectionLabel = seed.labels.optionsSection;
        if (seed.optionPriceAlign) d.priceAlign = seed.optionPriceAlign;
        break;
      case 'vehicle': if (seed.vehicleFields) d.fields = seed.vehicleFields; break;
      case 'dealer': if (seed.dealerAddress) d.address = seed.dealerAddress; break;
      case 'disclaimer': if (seed.disclaimerText) d.text = seed.disclaimerText; break;
      default: break;
    }
    out[id] = { ...w, d };
  }
  return out;
}
