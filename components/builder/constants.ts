import type { PaperSize, Widget, CustomWidgetDef } from './types';

export const SNAP = 4;
export const MIN_W = 40;
export const MIN_H = 16;

export const BG_DEFAULT = 'https://new-addendum-backgrounds.s3.us-east-1.amazonaws.com/01_Addendum_Default.png';
export const IS_BG_DEFAULT = 'https://new-infosheet-backgrounds.s3.us-east-1.amazonaws.com/BaseTemplate.png';
export const IB_DEFAULT = 'https://new-infobox-images.s3.us-east-1.amazonaws.com/EPA_Infobox_Default.png';
// Vehicle Photo fallback — shown whenever ChromeData has no image for the
// VIN, the VIN is missing, or the SOAP/MediaGallery calls fail. Same bucket
// as the rest of the infobox imagery so dealers' allowlisted CDN paths still work.
export const VEHICLE_PHOTO_COMING_SOON =
  'https://new-infobox-images.s3.us-east-1.amazonaws.com/vehicle-photo-coming-soon.png';

export const PAPERS: Record<PaperSize, { w: number; h: number }> = {
  standard:  { w: 408,  h: 1056 },
  narrow:    { w: 300,  h: 1056 },
  wide:      { w: 816,  h: 1056 },
  infosheet: { w: 816,  h: 1056 },
};

export const LAYOUT: Record<string, { x: number; y: number; w: number; h: number }> = {
  logo:              { x: 32,  y: 48,  w: 348, h: 118 },
  vehicle:           { x: 40,  y: 168, w: 336, h: 72  },
  msrp:              { x: 40,  y: 248, w: 332, h: 32  },
  options:           { x: 40,  y: 280, w: 332, h: 175 },
  suggested_options: { x: 40,  y: 460, w: 332, h: 120 },
  suggested_price:   { x: 40,  y: 584, w: 332, h: 28  },
  subtotal:          { x: 40,  y: 608, w: 332, h: 28  },
  askbar:            { x: 36,  y: 636, w: 344, h: 45  },
  dealer:            { x: 40,  y: 676, w: 336, h: 80  },
  // bgimage occupies the old infobox slot — when a fresh template is created
  // it gets the EPA/DOT Fuel Economy default so the addendum prints something
  // sensible out of the box.
  bgimage:           { x: 28,  y: 760, w: 352, h: 240 },
  vehiclephoto:      { x: 60,  y: 780, w: 280, h: 200 },
  qrcode:            { x: 280, y: 280, w: 96,  h: 96  },
  barcode:           { x: 40,  y: 760, w: 256, h: 52  },
  // legacy alias — kept so old saved templates that still reference 'infobox'
  // land in the right place during the backward-compat conversion pass.
  infobox:           { x: 28,  y: 760, w: 352, h: 240 },
  // Disclaimer — narrow strip near the bottom by default. Resizable like
  // any other widget; group admins typically own the placement decision.
  disclaimer:        { x: 16,  y: 1020, w: 376, h: 28  },
};

export const LAYOUT_INFOSHEET: Record<string, { x: number; y: number; w: number; h: number }> = {
  logo:        { x: 64,  y: 44,  w: 440, h: 130 },
  vehicle:     { x: 72,  y: 196, w: 448, h: 80  },
  description: { x: 72,  y: 324, w: 628, h: 116 },
  features:    { x: 76,  y: 440, w: 664, h: 288 },
  askbar:      { x: 20,  y: 792, w: 728, h: 56  },
  qrcode:      { x: 528, y: 180, w: 120, h: 120 },
  barcode:     { x: 508, y: 868, w: 256, h: 52  },
  dealer:      { x: 536, y: 68,  w: 216, h: 60  },
  customtext:  { x: 40,  y: 944, w: 744, h: 60  },
  disclaimer:  { x: 40,  y: 1010, w: 744, h: 32 },
};

export const WIDGET_LABELS: Record<string, string> = {
  logo: 'Logo', vehicle: 'Vehicle data', msrp: 'MSRP', options: 'Required Products',
  subtotal: 'Subtotal', askbar: 'Asking price', dealer: 'Dealer address',
  headerbar: 'Header bar', customtext: 'Custom text', sigline: 'Signature',
  infobox: 'Infobox', description: 'Description', features: 'Features',
  barcode: 'VIN Barcode', qrcode: 'QR Code', custom: 'Custom',
  bgimage: 'Background Image', vehiclephoto: 'Vehicle Photo',
  suggested_options: 'Suggested Products', suggested_price: 'Suggested Price',
  disclaimer: 'Disclaimer',
};

// One-instance-only widgets. QR Code, VIN Barcode, Background Image, and
// Vehicle Photo are explicitly multi-instance — drop them from this list so
// the palette lets the dealer drop as many as they want. Disclaimer is also
// single-instance — a template carries one disclaimer block.
export const UNIQUE_WIDGETS = [
  'logo','vehicle','msrp','options','subtotal','askbar','dealer',
  'description','features',
  'suggested_options','suggested_price',
  'disclaimer',
];

export const ADDENDUM_WIDGETS = [
  'logo','vehicle','msrp','options','subtotal','askbar','dealer',
  'headerbar','customtext','sigline','disclaimer',
  'suggested_options','suggested_price',
  // Dynamic content (replaces the old monolithic Infobox)
  'bgimage','qrcode','barcode','vehiclephoto',
];
export const INFOSHEET_WIDGETS = [
  'logo','vehicle','description','features','askbar',
  'qrcode','barcode','dealer','customtext','disclaimer',
  'bgimage','vehiclephoto',
];
// Addendum hides only infosheet-specific content widgets. qrcode/barcode are
// now first-class addendum widgets too.
export const PALETTE_HIDDEN_IN_ADDENDUM = ['description','features'];
// Infosheet hides addendum-only price math widgets. bgimage / vehiclephoto are
// available on infosheets too.
export const PALETTE_HIDDEN_IN_INFOSHEET = ['msrp','options','subtotal','suggested_options','suggested_price'];

export const DEFS: Record<string, Record<string, unknown>> = {
  logo: {
    label: 'Your Logo',
    showName: false,
    dealerName: '',
  },
  vehicle: {
    boxed: false,
    fields: ['stock','vin','year','color','make','trim','model','mileage'],
    showHeader: true,
    fontSize: 1.0,
    headerFontSize: 1.0,
  },
  msrp: { label: 'Manufacturer Retail Price:', value: '$27,100.00', divider: true, fontSize: 1.0 },
  options: {
    sectionLabel: 'Dealer Installed Products:',
    fontSize: 1.0,
    lineSpacing: 1.2,
    items: [
      { name: 'Lifetime Warranty CERAMIC TINT', desc: '', price: '$799.00' },
      { name: 'Door Edge & Cup Guards', desc: '', price: '$199.00' },
      { name: 'Llumar Screen Protector', desc: '', price: '$99.00' },
      { name: 'Subaru of North Tampa Advantage Package', desc: 'First Aid Kit, Window Sunshade, Wheel Locks, Key Chain', price: '$399.00' },
    ],
  },
  subtotal: { label: 'Subtotal:', value: '$1,496.00', fontSize: 1.0 },
  askbar: {
    label: 'Dealer Asking Price:',
    value: '$28,596.00',
    subtitle: "",
    labelColor: '#ffffff',
    valueColor: '#000000',
    labelFontSize: 1.0,
    valueFontSize: 1.0,
  },
  dealer: {
    text: 'Subaru of North Tampa\n11111 N Florida Ave\nTampa FL 33612\n8137973114',
    fontSize: 1.0,
  },
  headerbar: { text: 'PRE-OWNED VEHICLES', color: '#1a1916' },
  customtext: {
    text: 'Disclaimer: The information contained in this pricing sheet is provided for general informational purposes only. While we make every effort to ensure accuracy, some data may be AI-generated and should not be relied upon as definitive or guaranteed. Actual vehicle pricing, availability, and condition may vary and are subject to verification. Prices are subject to change without notice.',
    align: 'left',
    fs: 10,
  },
  sigline: { l1: 'Buyers Signature', l2: 'Date' },
  // Disclaimer — text is resolved at render time from group_disclaimers
  // matching the dealer's state + document_type. d.disclaimers is the
  // array injected by applyDisclaimerToWidgets (canvas) or pdf-html.ts
  // (PDF). Falls back to a placeholder when nothing is configured.
  disclaimer: { fontSize: 7, lineHeight: 1.3, align: 'left', disclaimers: [] },
  // Legacy monolithic infobox — kept in DEFS only so an old saved widget
  // dropped on the canvas before backward-compat conversion runs still has
  // sane defaults. New widgets should never use type='infobox'.
  infobox: { ibType: 'epa', imgUrl: IB_DEFAULT },
  // ── Dynamic content widgets (independent, multi-instance) ──────────────
  bgimage: { imgUrl: IB_DEFAULT, label: 'Background Image' },
  vehiclephoto: { angle: '03', label: 'Vehicle Photo' },
  description: {
    text: 'Vehicle description will appear here. AI or database content will be loaded at print time.',
    aiMode: 'db',
    fontSize: 1.0,
  },
  features: { items: [['Feature 1', 'Feature 2'], ['Feature 3', 'Feature 4']], aiMode: 'db', fontSize: 1.0 },
  barcode: { vin: '', stock: '' },
  qrcode: { url: 'https://dealeraddendums.com', label: 'Scan for more info', size: 120 },
  suggested_options: {
    sectionLabel: 'Suggested Products:',
    fontSize: 1.0,
    lineSpacing: 1.2,
    items: [],
  },
  suggested_price: { label: 'Suggested Asking Price:', value: '$29,000.00', labelColor: '#ffffff', valueColor: '#000000', labelFontSize: 1.0, valueFontSize: 1.0 },
};

export const DEFAULT_CUSTOM_WIDGETS: CustomWidgetDef[] = [
  {
    id: 'cw_lifetime_warranty',
    name: 'Lifetime Powertrain Warranty',
    desc: 'Dealer lifetime warranty block',
    scope: 'platform',
    category: 'content',
    defaultW: 336, defaultH: 52,
    contentType: 'html',
    html: '<div style="padding:5px 0"><div style="font-size:11px;font-weight:800;color:#1a1916;text-transform:uppercase;letter-spacing:.02em">&#10003; FREE Lifetime Powertrain Warranty</div><div style="font-size:9px;color:#666;margin-top:2px">Covers engine, transmission &amp; drivetrain — see dealer for details</div></div>',
    variables: [],
  },
  {
    id: 'cw_not_msrp',
    name: 'Not the MSRP Disclaimer',
    desc: 'Federal disclaimer text',
    scope: 'platform',
    category: 'structural',
    defaultW: 336, defaultH: 28,
    contentType: 'html',
    html: '<div style="font-size:9px;color:#555;text-align:center;padding:4px 0;font-style:italic">(This addendum has been added by the dealer, not the manufacturer, to reflect any additional charges for items added or services performed. This is not an authorized factory sticker.)</div>',
    variables: [],
  },
];

export function getPaperDims(
  size: string,
  customSizes?: { id: string; width_in: number; height_in: number }[]
): { w: number; h: number } {
  if (PAPERS[size as keyof typeof PAPERS]) return PAPERS[size as keyof typeof PAPERS];
  const cs = customSizes?.find(c => c.id === size);
  if (cs) return { w: Math.round(cs.width_in * 96), h: Math.round(cs.height_in * 96) };
  return PAPERS.standard;
}

export function snapV(v: number): number {
  return Math.round(v / SNAP) * SNAP;
}

export function makeWidget(
  type: string,
  id: string,
  x?: number, y?: number, w?: number, h?: number,
  isInfosheet?: boolean
): Widget {
  const layout = isInfosheet
    ? (LAYOUT_INFOSHEET[type] || { x: 12, y: 200, w: 384, h: 60 })
    : (LAYOUT[type] || { x: 12, y: 200, w: 384, h: 60 });
  return {
    id,
    type: type as Widget['type'],
    x: x ?? layout.x,
    y: y ?? layout.y,
    w: w ?? layout.w,
    h: h ?? layout.h,
    d: JSON.parse(JSON.stringify(DEFS[type] || {})),
  };
}
