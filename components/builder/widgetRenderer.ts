import { IB_DEFAULT, VEHICLE_PHOTO_COMING_SOON } from './constants';
import { sanitizeProductHtml, sanitizeProductDescription } from '@/lib/product-name';

type D = Record<string, unknown>;

// Repair + allowlist dealer-authored rich text before it's interpolated raw
// into the addendum HTML. DOMPurify re-serializes to well-formed markup, so a
// malformed/typo'd tag (e.g. the "</b?>" that garbled a template) degrades
// gracefully instead of leaving an open tag that bleeds into the rest of the
// layout. Allowed inline formatting is preserved; disallowed tags are dropped
// but their text kept. Identical on the Builder canvas and the print path.
function rich(v: unknown): string {
  return sanitizeProductHtml(v == null ? '' : String(v));
}

function looksLikeHtml(s: string): boolean {
  return /<[a-z][^>]*>/i.test(s);
}

// Pick a readable text color for a solid background — dark text on light bars,
// white on dark. Luminance per ITU-R BT.601 (0.299r+0.587g+0.114b). Handles
// 3- and 6-digit hex (with or without '#'); falls back to white for anything
// unparseable. Shared by the canvas preview and the PDF via renderW.
function readableText(bg: string): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((bg || '').trim());
  if (!m) return '#fff';
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map(ch => ch + ch).join('');
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  return lum > 0.6 ? '#1a1916' : '#fff';
}

function renderDescription(desc: string, fontPx: number): string {
  if (!desc) return '';
  const baseStyle = `font-size:${fontPx}px;color:#666;padding-left:8px;margin-top:1px`;
  if (looksLikeHtml(desc)) {
    return `<div class="description-html" style="${baseStyle}">${sanitizeProductDescription(desc)}</div>`;
  }
  // Escape plain text to keep parity with previous behavior.
  const escaped = desc.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div style="${baseStyle}">${escaped}</div>`;
}

/**
 * Render one product row with optional layout hints (used by the 'options'
 * and 'suggested_options' widgets). Per-row separator_above/below add
 * horizontal rules; spaces adds vertical blank space ABOVE the row.
 *
 * One row in font px = roughly 1.4 × font size (matches widget line-height).
 */
function renderProductRow(
  it: { name: string; desc: string; price: string; separator_above?: boolean; separator_below?: boolean; spaces?: number },
  sz: number,
  szm: number,
  ls: number,
  pricePadding: string = 'padding-left:6px',
): string {
  const lineHeightPx = Math.round(sz * 1.4);
  const spacesPx = (it.spaces && it.spaces > 0) ? it.spaces * lineHeightPx : 0;
  const spacerAbove = spacesPx > 0 ? `<div style="height:${spacesPx}px"></div>` : '';
  const sepAbove = it.separator_above ? `<hr style="border:none;border-top:1px solid #1a1916;margin:4px 0"/>` : '';
  const sepBelow = it.separator_below ? `<hr style="border:none;border-top:1px solid #1a1916;margin:4px 0"/>` : '';
  const row = `<div style="display:flex;justify-content:space-between;align-items:flex-start;padding:3px 0;border-bottom:1px solid #f0f0f0;line-height:${ls}"><div><div style="font-size:${sz}px;font-weight:700;color:#333">${rich(it.name)}</div>${renderDescription(it.desc, szm)}</div><div style="font-size:${sz}px;font-weight:700;color:#333;font-family:monospace;white-space:nowrap;${pricePadding};flex-shrink:0">${it.price}</div></div>`;
  return `${spacerAbove}${sepAbove}${row}${sepBelow}`;
}

export function renderW(type: string, d: D, fontScale: number): string {
  const fs = fontScale;

  if (type === 'logo') {
    if (d.imgUrl === null) return '';  // dealer has no logo — render blank
    if (d.imgUrl)
      return `<img style="width:100%;height:100%;object-fit:contain;object-position:left center;display:block;" src="${d.imgUrl}" alt="Logo">`;
    return `<div style="width:100%;height:100%;background:#f5f6f7;display:flex;align-items:center;justify-content:center;color:#78828c;font-size:12px;">Upload logo in Settings</div>`;
  }

  if (type === 'vehicle') {
    const vd = (d.vehicleData as Record<string, string>) || { stock: 'STOCK_TEST1', vin: '2HGFC3B96HH362096', year: '2017', color: 'White', make: 'Honda', trim: 'Touring', model: 'Civic', mileage: '10' };
    const lb: Record<string, string> = { stock: 'Stock:', vin: 'VIN:', year: 'Year:', color: 'Color:', make: 'Make:', trim: 'Trim:', model: 'Model:', mileage: 'Mileage:' };
    // Stock/VIN/Year/Make/Model are always rendered, even if a particular
    // record happens to be missing one — the dealer expects the row to be
    // there. Color / Trim / Mileage are hidden when the value is empty,
    // whitespace, or a zero-ish default ("0" or 0). All other field names
    // (custom additions) default to hiding when empty.
    const ALWAYS_SHOW = new Set(['stock', 'vin', 'year', 'make', 'model']);
    const isMeaningful = (field: string, raw: unknown): boolean => {
      if (ALWAYS_SHOW.has(field)) return true;
      if (raw == null) return false;
      const s = String(raw).trim();
      if (!s) return false;
      if (field === 'mileage' && (s === '0' || s === '0.0' || s === '0.00')) return false;
      return true;
    };

    const flds = ((d.fields as string[]) || Object.keys(vd)).filter(f => isMeaningful(f, vd[f]));
    const hdrFs = Math.round(13 * fs * ((d.headerFontSize as number) || 1));
    const detFs = Math.round(9 * fs * ((d.fontSize as number) || 1));
    // Header line: collapse to non-empty tokens so a missing trim doesn't
    // leave a trailing space and an empty year/make/model doesn't expand into
    // weird gaps. Always-show fields can still be empty for edge cases.
    const headerText = [vd.year, vd.make, vd.model, vd.trim]
      .map(v => (v == null ? '' : String(v).trim()))
      .filter(Boolean)
      .join(' ');
    const hdr = d.showHeader !== false && headerText
      ? `<div style="font-size:${hdrFs}px;font-weight:800;color:#1a1916;line-height:1.2;margin-bottom:3px;letter-spacing:-.01em">${headerText}</div>`
      : '';
    const pairs: string[][] = [];
    for (let i = 0; i < flds.length; i += 2) pairs.push([flds[i], flds[i + 1]].filter(Boolean));
    const rows = pairs.map(p =>
      `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:1px">${p.map(f =>
        `<div style="font-size:${detFs}px;color:#444">${lb[f] || f} <b style="color:#1a1916;font-weight:600">${(vd as Record<string,string>)[f] || ''}</b></div>`
      ).join('')}</div>`
    ).join('');
    return `<div style="padding:3px 0">${hdr}${rows}</div>`;
  }

  if (type === 'msrp') {
    const sz = Math.round(11 * fs * ((d.fontSize as number) || 1));
    const aboveLine = d.dividerAbove ? '<div style="height:1px;background:#1a1916;margin-bottom:3px"></div>' : '';
    return `<div style="padding:3px 0">${aboveLine}<div style="display:flex;justify-content:space-between;align-items:baseline"><span style="font-size:${sz}px;font-weight:700;color:#1a1916">${d.label}</span><span style="font-size:${sz}px;font-weight:700;color:#1a1916;font-family:monospace">${d.value}</span></div>${d.divider !== false ? '<div style="height:1px;background:#1a1916;margin-top:3px"></div>' : ''}</div>`;
  }

  if (type === 'divider') {
    // Horizontal rule. The line is centered vertically inside the widget box;
    // thickness/color/margins come from `d`. fontScale is irrelevant (no text).
    const thickness = Math.max(1, Number(d.thickness) || 1);
    const color = (d.color as string) || '#1a1916';
    const topMargin = Math.max(0, Number(d.topMargin) || 0);
    const bottomMargin = Math.max(0, Number(d.bottomMargin) || 0);
    return `<div style="display:flex;align-items:center;height:100%;box-sizing:border-box;padding:${topMargin}px 0 ${bottomMargin}px 0"><div style="width:100%;height:${thickness}px;background:${color}"></div></div>`;
  }

  if (type === 'options') {
    const sz = Math.round(10 * fs * ((d.fontSize as number) || 1));
    const szm = Math.round(9 * fs * ((d.fontSize as number) || 1));
    const ls = (d.lineSpacing as number) || 1.2;
    type OptItem = { name: string; desc: string; price: string; separator_above?: boolean; separator_below?: boolean; spaces?: number };
    const items = (d.items as OptItem[]) || [];
    return `<div style="padding:3px 0"><div style="font-size:${sz}px;color:#555;margin-bottom:4px">${rich(d.sectionLabel)}</div>${items.map(it =>
      renderProductRow(it, sz, szm, ls)
    ).join('')}</div>`;
  }

  if (type === 'suggested_options') {
    const sz = Math.round(10 * fs * ((d.fontSize as number) || 1));
    const szm = Math.round(9 * fs * ((d.fontSize as number) || 1));
    const ls = (d.lineSpacing as number) || 1.2;
    type OptItem = { name: string; desc: string; price: string; separator_above?: boolean; separator_below?: boolean; spaces?: number };
    const items = (d.items as OptItem[]) || [];
    if (items.length === 0) {
      return `<div style="padding:3px 0"><div style="font-size:${sz}px;color:#555;margin-bottom:4px">${rich(d.sectionLabel)}</div><div style="font-size:${szm}px;color:#bbb;font-style:italic">Suggested products will appear here at print time.</div></div>`;
    }
    return `<div style="padding:3px 0"><div style="font-size:${sz}px;color:#555;margin-bottom:4px">${rich(d.sectionLabel)}</div>${items.map(it =>
      renderProductRow(it, sz, szm, ls)
    ).join('')}</div>`;
  }

  // askbar + suggested_price are white-label bars overlaying a pre-printed bar
  // on the background image. Their style strings pin line-height:1.5 so the
  // top-aligned glyphs land at the SAME vertical offset in both renderers: the
  // Builder canvas inherits the app body line-height (globals.css: 1.5), but
  // pdf-html's <style> sets none, so it fell back to the browser default
  // `normal` (~1.2) and the bar text printed too high. 1.5 = no canvas change.
  if (type === 'suggested_price') {
    const lfs = Math.round(12 * fs * ((d.labelFontSize as number) || 1));
    const vfs = Math.round(13 * fs * ((d.valueFontSize as number) || 1));
    const lc = (d.labelColor as string) || '#ffffff';
    const vc = (d.valueColor as string) || '#000000';
    return `<div style="display:flex;justify-content:space-between;align-items:flex-start;width:100%;height:100%;padding:0 4px;line-height:1.5"><div style="vertical-align:top"><div style="font-size:${lfs}px;font-weight:800;color:${lc};letter-spacing:-.01em">${d.label}</div></div><div style="font-size:${vfs}px;font-weight:800;color:${vc};font-family:monospace;padding:2px 8px;border-radius:2px;min-width:110px;text-align:right;vertical-align:top">${d.value}</div></div>`;
  }

  if (type === 'subtotal') {
    const sz = Math.round(12 * fs * ((d.fontSize as number) || 1));
    return `<div style="padding:3px 0;display:flex;justify-content:flex-end;gap:12px"><span style="font-size:${sz}px;font-weight:700;color:#1a1916">${d.label}</span><span style="font-size:${sz}px;font-weight:700;color:#1a1916;font-family:monospace">${d.value}</span></div>`;
  }

  if (type === 'askbar') {
    const lfs = Math.round(12 * fs * ((d.labelFontSize as number) || 1));
    const vfs = Math.round(13 * fs * ((d.valueFontSize as number) || 1));
    const sfs = Math.round(8 * fs * ((d.labelFontSize as number) || 1));
    const lc = (d.labelColor as string) || '#ffffff';
    const vc = (d.valueColor as string) || '#000000';
    return `<div style="display:flex;justify-content:space-between;align-items:flex-start;width:100%;height:100%;padding:0 4px;line-height:1.5"><div style="vertical-align:top"><div style="font-size:${lfs}px;font-weight:800;color:${lc};letter-spacing:-.01em">${d.label}</div>${d.subtitle ? `<div style="font-size:${sfs}px;color:${lc};font-style:italic;margin-top:1px">${d.subtitle}</div>` : ''}</div><div style="font-size:${vfs}px;font-weight:800;color:${vc};font-family:monospace;padding:2px 8px;border-radius:2px;min-width:110px;text-align:right;vertical-align:top">${d.value}${(d.priceSuffix as string) || ''}</div></div>`;
  }

  if (type === 'dealer') {
    const sz = Math.round(10 * fs * ((d.fontSize as number) || 1));
    const ta = (d.textAlign as string) || 'left';
    const lh = (d.lineHeight as number) || 1.5;
    return `<div style="padding:4px 0"><div style="font-size:${sz}px;color:#1a1916;line-height:${lh};font-weight:700;text-align:${ta}">${((d.text as string) || '').replace(/\n/g, '<br>')}</div></div>`;
  }

  if (type === 'headerbar') {
    const bg = (d.color as string) || '#1a1916';
    const txt = readableText(bg);
    const hbSz = Math.round(11 * fs * ((d.fontSize as number) || 1));
    return `<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:${bg}"><div style="font-size:${hbSz}px;font-weight:700;color:${(d.fontColor as string) || txt};text-transform:uppercase;letter-spacing:.06em">${d.text || 'HEADER'}</div></div>`;
  }

  if (type === 'customtext') {
    const ta = (d.textAlign as string) || (d.align as string) || 'left';
    const lh = (d.lineHeight as number) || 1.5;
    const rawText = (d.text as string) || '';
    // Replace {{token}} patterns with grey italic placeholders for canvas preview.
    // At PDF time, pdf-html.ts pre-resolves these before calling renderW.
    const html = rawText
      .replace(/\n/g, '<br>')
      .replace(/\{\{([^}]+)\}\}/g, (_, key: string) =>
        `<em style="color:#bbb;font-style:italic">[${key.trim()}]</em>`);
    return `<div style="padding:4px 0"><div style="font-size:${d.fs || 10}px;text-align:${ta};color:#555;line-height:${lh}">${sanitizeProductHtml(html)}</div></div>`;
  }

  if (type === 'sigline') {
    return `<div style="padding:6px 0;width:100%"><div style="display:flex;gap:12px"><div style="flex:1"><div style="border-bottom:1px solid #1a1916;height:18px;margin-bottom:2px"></div><div style="font-size:8px;color:#888">${d.l1 || 'Buyers Signature'}</div></div><div style="flex:1"><div style="border-bottom:1px solid #1a1916;height:18px;margin-bottom:2px"></div><div style="font-size:8px;color:#888">${d.l2 || 'Date'}</div></div></div></div>`;
  }

  if (type === 'disclaimer') {
    // d.disclaimers is the resolved list, injected by applyDisclaimerToWidgets
    // (canvas) or pdf-html.ts (PDF) right before render. Both surfaces hit
    // this branch — keep parity strict.
    const list = (d.disclaimers as Array<{ text: string; locked?: boolean }> | undefined) ?? [];
    const sz = Math.round((d.fontSize as number || 7) * fs);
    const lh = (d.lineHeight as number) || 1.3;
    const ta = (d.align as string) || (d.textAlign as string) || 'left';
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (list.length === 0) {
      return `<div style="font-size:${sz}px;line-height:${lh};color:#bbb;font-style:italic;text-align:${ta}">Disclaimer text will appear here</div>`;
    }
    const blocks = list
      .map(r => `<div style="font-size:${sz}px;line-height:${lh};color:#666;text-align:${ta};margin-bottom:2px">${esc(r.text)}</div>`)
      .join('');
    return `<div style="width:100%">${blocks}</div>`;
  }

  // Background Image — full-width image layer, no content. Defaults to the
  // EPA/DOT Fuel Economy image so a new template prints something useful.
  if (type === 'bgimage') {
    const imgSt = 'width:100%;height:100%;object-fit:fill;display:block;mix-blend-mode:multiply';
    const phSt = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#f0f0f0;border:1px dashed #bbb';
    const src = (d.imgUrl as string) || '';
    const alt = ((d.label as string) || 'Background Image').replace(/"/g, '&quot;');
    if (src) return `<div style="width:100%;height:100%"><img src="${src}" style="${imgSt}" alt="${alt}"></div>`;
    return `<div style="${phSt}"><span style="font-size:11px;color:#999;font-weight:500">${alt}</span></div>`;
  }

  // Vehicle Photo — color-matched ChromeData image. The actual URL is
  // resolved server-side at PDF render time; d.imgUrl carries the resolved
  // value (or the Coming Soon fallback on a miss). The canvas preview shows
  // a placeholder until the dealer prints — the resolver runs server-side
  // because ChromeData credentials must not be exposed to the browser.
  if (type === 'vehiclephoto') {
    const imgSt = 'width:100%;height:100%;object-fit:contain;display:block';
    const phSt = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#fafafa;border:1px dashed #bbb';
    const src = (d.imgUrl as string) || '';
    if (src) return `<div style="width:100%;height:100%"><img src="${src}" style="${imgSt}" alt="Vehicle Photo"></div>`;
    return `<div style="${phSt}"><span style="font-size:11px;color:#999;font-weight:500;text-align:center;line-height:1.4">Vehicle Photo<br><span style="font-size:9px;color:#bbb">color-matched at print time<br>(falls back to "Coming Soon" if unavailable)</span></span></div>`;
  }

  // Legacy 'infobox' fallback — old saved templates may still reference this
  // type. Render through the new widget logic based on the saved ibType so
  // they look right even if BuilderPage's load-time converter hasn't run yet.
  if (type === 'infobox') {
    const ibType = (d.ibType as string) || 'epa';
    if (ibType === 'qr') return renderW('qrcode', { url: d.url, qrUrlTemplate: d.qrUrlTemplate, label: d.label, imgUrl: d.imgUrl }, fontScale);
    if (ibType === 'barcode') return renderW('barcode', { vin: d.vin }, fontScale);
    if (ibType === 'photo') return renderW('vehiclephoto', { imgUrl: d.imgUrl, label: 'Vehicle Photo' }, fontScale);
    return renderW('bgimage', { imgUrl: d.imgUrl || IB_DEFAULT, label: 'Background Image' }, fontScale);
  }

  if (type === 'description') {
    const sz = Math.round(10 * fs * ((d.fontSize as number) || 1));
    const badge = d.aiMode === 'ai'
      ? '<span style="font-size:8px;background:#e3f2fd;color:#1976d2;padding:1px 6px;border-radius:8px;font-weight:700;margin-left:5px">AI</span>'
      : '<span style="font-size:8px;background:#f0f0f0;color:#78828c;padding:1px 6px;border-radius:8px;font-weight:600;margin-left:5px">DB</span>';
    return `<div style="padding:3px 0;height:100%;box-sizing:border-box;overflow:hidden"><div style="font-size:8px;font-weight:700;color:#78828c;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px;display:flex;align-items:center">Description${badge}</div><div style="font-size:${sz}px;color:#222;line-height:1.6">${d.text != null ? d.text : 'Vehicle description will appear here.'}</div></div>`;
  }

  if (type === 'features') {
    const sz = Math.round(9 * fs * ((d.fontSize as number) || 1));
    const badge = d.aiMode === 'ai'
      ? '<span style="font-size:8px;background:#e3f2fd;color:#1976d2;padding:1px 6px;border-radius:8px;font-weight:700;margin-left:5px">AI</span>'
      : '<span style="font-size:8px;background:#f0f0f0;color:#78828c;padding:1px 6px;border-radius:8px;font-weight:600;margin-left:5px">DB</span>';
    const items = (d.items as Array<[string, string]>) || [['Feature', 'Feature']];
    const rows = items.map(p =>
      `<div style="display:flex"><div style="flex:1;font-size:${sz}px;color:#1a1916;padding:1.5px 4px 1.5px 0;border-bottom:1px solid #ececec;line-height:1.4">${p[0] || ''}</div><div style="flex:1;font-size:${sz}px;color:#1a1916;padding:1.5px 0 1.5px 4px;border-bottom:1px solid #ececec;border-left:1px solid #ececec;line-height:1.4">${p[1] || ''}</div></div>`
    ).join('');
    return `<div style="padding:3px 0;height:100%;box-sizing:border-box;overflow:hidden"><div style="font-size:8px;font-weight:700;color:#78828c;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px;display:flex;align-items:center">Features / Options${badge}</div><div style="border:1px solid #e0e0e0;border-radius:2px;overflow:hidden">${rows}</div></div>`;
  }

  // MPG — two numbers (city + highway) positioned over the EPA fuel-graphic
  // labels on the infosheet background. No labels here — the background
  // supplies them. Hide-if-empty rule: skip a missing number, render nothing
  // if both are empty. Order toggle reverses the pair.
  if (type === 'mpg') {
    const fontPx = Math.round(28 * fs * ((d.fontSize as number) || 1));
    const gapPx = (d.gap as number) ?? 120;
    const cmpgRaw = (d.cmpg as string | number | null | undefined);
    const hmpgRaw = (d.hmpg as string | number | null | undefined);
    const fmt = (v: string | number | null | undefined): string | null => {
      if (v == null) return null;
      const s = String(v).trim();
      if (!s || s === '0' || s === '0.0' || s === '0.00') return null;
      return s;
    };
    const city = fmt(cmpgRaw);
    const hwy = fmt(hmpgRaw);
    if (!city && !hwy) return '';
    const order = (d.order as string) === 'hwy_first' ? [hwy, city] : [city, hwy];
    const numStyle = `font-size:${fontPx}px;font-weight:800;color:#1a1916;font-family:'Arial Black','Helvetica',sans-serif;line-height:1;letter-spacing:-.02em`;
    const cells = order
      .map(n => n ? `<span style="${numStyle}">${n}</span>` : `<span style="${numStyle};visibility:hidden">0</span>`)
      .join(`<span style="display:inline-block;width:${gapPx}px"></span>`);
    return `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center">${cells}</div>`;
  }

  if (type === 'barcode') {
    const vin = (d.vin as string) || '5TFDYS3F11MX956768';
    const seed = vin.split('').map(c => c.charCodeAt(0));
    let bars = '';
    for (let i = 0; i < 3; i++) bars += '<div style="display:inline-block;width:2px;height:52px;background:#000;margin-right:1px;vertical-align:top"></div>';
    seed.forEach(v => {
      const n = 1 + (v % 2), w2 = 2 + (v % 3), s = 1 + ((v * 7) % 2);
      bars += `<div style="display:inline-block;width:${n}px;height:52px;background:#000;margin-right:${s}px;vertical-align:top"></div>`;
      bars += `<div style="display:inline-block;width:${w2}px;height:52px;background:#000;margin-right:${s}px;vertical-align:top"></div>`;
    });
    for (let i = 0; i < 4; i++) bars += '<div style="display:inline-block;width:2px;height:52px;background:#000;margin-right:1px;vertical-align:top"></div>';
    return `<div style="text-align:center;padding:4px 2px;background:#fff;height:100%;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center"><div style="line-height:0;padding:4px 6px;background:#fff;overflow:hidden">${bars}</div><div style="font-size:10px;font-family:monospace;margin-top:4px;letter-spacing:1px;color:#000">*${vin}*</div></div>`;
  }

  if (type === 'qrcode') {
    const url = encodeURIComponent((d.url as string) || 'https://dealeraddendums.com');
    // Distinguish "not set" (undefined/null → default placeholder) from
    // "explicitly cleared" (''/whitespace → render no label at all). Without
    // this the || fallback re-injected "Scan for more info" whenever the
    // dealer wiped the field.
    const rawLabel = d.label as string | null | undefined;
    const label = rawLabel == null ? 'Scan for more info' : rawLabel;
    const labelHtml = label.trim()
      ? `<div style="font-size:9px;color:#555;margin-top:3px;text-align:center;font-weight:600">${label}</div>`
      : '';
    // d.imgUrl is set at PDF render time to a pre-generated base64 data URL; falls back to external API for canvas preview
    const imgSrc = (d.imgUrl as string) || `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${url}&margin=2`;
    const imgHeight = labelHtml ? 'calc(100% - 20px)' : '100%';
    return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:4px;background:#fff;box-sizing:border-box"><img src="${imgSrc}" style="width:calc(100% - 4px);height:${imgHeight};object-fit:contain;display:block" alt="QR Code">${labelHtml}</div>`;
  }

  if (type === 'custom') {
    return '<div style="padding:8px;color:#999;font-size:11px;height:100%;display:flex;align-items:center;justify-content:center">Custom widget</div>';
  }

  return '';
}
