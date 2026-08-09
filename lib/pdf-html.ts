// Server-only: builds an HTML string for Puppeteer to render as a PDF.
import { renderW } from '@/components/builder/widgetRenderer';
import { PAPERS } from '@/components/builder/constants';
import type { Widget, PaperSize } from '@/components/builder/types';
import { formatOptionPrice, parseOptionPriceValue, priceSetUsesDecimals, formatCurrencyAmount } from '@/lib/option-price';
import { parsePhotos } from '@/lib/vehicles';
import type { VehicleRow } from '@/lib/vehicles';

async function fetchImageAsBase64(url: string): Promise<string> {
  if (!url || !url.startsWith('http')) return url;
  try {
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    const contentType = res.headers.get('content-type') || 'image/png';
    return `data:${contentType};base64,${Buffer.from(buf).toString('base64')}`;
  } catch (e) {
    console.error('[pdf-html] fetchImageAsBase64 failed:', url, e);
    return url;
  }
}

async function inlineImagesInHtml(html: string): Promise<string> {
  const re = /src="(https?:\/\/[^"]+)"/g;
  const urls = Array.from(html.matchAll(re), m => m[1]);
  if (urls.length === 0) return html;
  const unique = Array.from(new Set(urls));
  const entries = await Promise.all(unique.map(async url => [url, await fetchImageAsBase64(url)] as const));
  const map = Object.fromEntries(entries);
  return html.replace(re, (_, url) => `src="${map[url] || url}"`);
}

type AnyOption = {
  option_name: string;
  option_price: string;
  active?: boolean;
  description?: string | null;
  required?: boolean;
  separator_above?: boolean;
  separator_below?: boolean;
  spaces?: number;
};

export interface BuildPdfHtmlInput {
  widgets: Widget[];
  paperSize: string;
  fontScale: number;
  bgUrl: string;
  vehicle?: VehicleRow;
  options?: AnyOption[];
  /**
   * Effective group disclaimers for this dealer + document_type. Locked
   * (corporate-managed) entries come first. Injected into Disclaimer
   * widgets at render time — auto-bottom injection was removed in favor
   * of explicit widget placement (typically by group admins).
   */
  disclaimers?: Array<{ text: string; locked?: boolean }>;
  dealerLogoUrl?: string | null;
  /** True when the widgets came from a GROUP template. The Logo widget then
   *  always renders the PRINTING dealer's logo — any imgUrl stored on the
   *  widget is an authoring-time artifact (whatever dealer context the group
   *  author happened to have), never the printing dealer's choice. */
  forceDealerLogo?: boolean;
  dealer?: { name?: string | null; address?: string | null; city?: string | null; state?: string | null; zip?: string | null; phone?: string | null };
  customDims?: { widthIn: number; heightIn: number };
  aiEnabled?: boolean;
  aiDescription?: string | null;
  aiFeatures?: [string, string][] | null;
  dbDescription?: string | null;
  dbOptionsText?: string | null;  /** Print-Now-entered price for a Retail/Wholesale widget in 'ask' mode.
   *  Render-only — never persisted to the vehicle. Absent (bulk/mobile/cancel)
   *  ⇒ the widget renders a plain retail line with no strikethrough. */
  retailWholesalePrice?: number | null;
}

export async function buildPdfHtml({
  widgets,
  paperSize,
  fontScale,
  bgUrl,
  vehicle,
  options,
  disclaimers,
  dealerLogoUrl,
  forceDealerLogo,
  dealer,
  customDims,
  aiEnabled,
  aiDescription,
  aiFeatures,
  dbDescription,
  dbOptionsText,
  retailWholesalePrice,
}: BuildPdfHtmlInput): Promise<string> {
  // Use the SAME paper geometry as the Builder canvas (components/builder/
  // constants.ts PAPERS) so the PDF .paper width/height exactly matches the
  // canvas for every named size — standard/narrow/WIDE/infosheet. customDims
  // (a pre-resolved custom size) uses the identical *96 math as getPaperDims'
  // custom branch. Previously a local PAPER_DIMS copy here was missing 'wide'
  // (silently fell back to standard 408×1056), drifting the PDF from the canvas.
  const paper = customDims
    ? { w: Math.round(customDims.widthIn * 96), h: Math.round(customDims.heightIn * 96) }
    : (PAPERS[paperSize as keyof typeof PAPERS] ?? PAPERS.standard);

  // Split options into required vs suggested (default: all required for backward compat)
  const allOptions = (options ?? []).filter(o => o.active !== false);
  const requiredOptions = allOptions.filter(o => o.required !== false);
  const suggestedOptions = allOptions.filter(o => o.required === false);

  // ── Decimals policy ──────────────────────────────────────────────────────
  // If every price on this addendum is a whole dollar amount, drop the .00
  // suffix everywhere. As soon as one price has cents, render every price
  // with two decimals so the columns line up. The set must include each
  // product row, the subtotal, MSRP, asking price, and suggested price.
  const msrpParsed = (() => {
    const v = vehicle?.MSRP != null ? parseFloat(vehicle.MSRP) : null;
    return v != null && Number.isFinite(v) ? v : null;
  })();
  const optionNumericValues = allOptions.map(o => parseOptionPriceValue(o.option_price));
  const requiredTotal = requiredOptions.reduce((s, o) => s + parseOptionPriceValue(o.option_price), 0);
  const allOptionsTotal = allOptions.reduce((s, o) => s + parseOptionPriceValue(o.option_price), 0);
  const askingTotal = (msrpParsed ?? 0) + requiredTotal;
  const suggestedTotal = (msrpParsed ?? 0) + allOptionsTotal;
  const decimals = priceSetUsesDecimals([
    msrpParsed,
    requiredTotal,
    askingTotal,
    suggestedTotal,
    ...optionNumericValues,
  ]);

  const enriched = widgets.map(w => {
    const d = { ...w.d };

    // Logo: a specific image picked from the Choose Logo Image library is
    // persisted on the widget as imgUrl and must win — both the canvas and
    // the PDF need to render the user's selection. Only when the widget has
    // no chosen image do we fall back to the dealer's canonical logo_url
    // (undefined = caller did not pass dealerLogoUrl → keep whatever's there).
    if (w.type === 'logo' && forceDealerLogo) {
      // Group template: the printing dealer's identity wins unconditionally.
      d.imgUrl = dealerLogoUrl ?? '';
    } else if (w.type === 'logo' && dealerLogoUrl !== undefined) {
      const existing = typeof d.imgUrl === 'string' ? d.imgUrl : '';
      if (!existing) d.imgUrl = dealerLogoUrl;
    }

    // Dealer address: always inject live dealer data so PDF never shows template placeholder.
    if (w.type === 'dealer' && dealer) {
      const lines = [
        dealer.name,
        dealer.address,
        [dealer.city, dealer.state, dealer.zip].filter(Boolean).join(' '),
        dealer.phone,
      ].filter(Boolean) as string[];
      if (lines.length) d.text = lines.join('\n');
    }

    // MSRP / askbar / subtotal: always use live vehicle data, never saved template values.
    // MSRP marks live and clears the value when the vehicle has no price —
    // live + no value ⇒ the renderer draws NOTHING. Before this, a NULL-msrp
    // vehicle kept the widget's baked Builder SAMPLE (e.g. $27,100) on real
    // prints — a fabricated price on a real sticker (flagged 2026-07-22).
    if (w.type === 'msrp' && vehicle) {
      d.live = true;
      d.value = msrpParsed != null ? formatCurrencyAmount(msrpParsed, decimals) : null;
    }
    // Retail/Wholesale: real render always sets live + the raw MSRP number
    // (null included — the renderer then draws NOTHING, never a sample; the
    // 23d09ef rule). askPrice flows from Print Now's prompt for 'ask' mode.
    if (w.type === 'retail_wholesale') {
      d.live = true;
      d.msrpNum = msrpParsed;
      if (retailWholesalePrice != null && Number.isFinite(retailWholesalePrice)) d.askPrice = retailWholesalePrice;
    }
    // On a real vehicle render the COMPUTED value always wins — 0 is a
    // legitimate result (e.g. the only option is a |XX| doc-fee that's excluded
    // from the subtotal, or the vehicle has no includable options at all). The
    // old `> 0` guards treated 0 as "no data" and left the widget's baked
    // template SAMPLE value in place, leaking the Builder demo products
    // (Ceramic Tint/… = $1,496) into printed addendums. Sample values may only
    // survive when authoring with no vehicle context (vehicle == null).
    if (w.type === 'askbar' && vehicle) {
      if (paperSize === 'infosheet') {
        // Infosheet: asking price = MSRP only (no addendum options total).
        d.value = formatCurrencyAmount(msrpParsed ?? 0, decimals);
      } else {
        // Asking price = MSRP + required (includable) options only.
        d.value = formatCurrencyAmount(askingTotal, decimals);
      }
    }
    if (w.type === 'subtotal' && vehicle) {
      // Subtotal = required (includable) options only. $0 is valid.
      d.value = formatCurrencyAmount(requiredTotal, decimals);
    }
    if (w.type === 'suggested_price' && vehicle) {
      // Suggested asking price = MSRP + all includable options (required + suggested).
      d.value = formatCurrencyAmount(suggestedTotal, decimals);
    }

    if (vehicle) {
      if (w.type === 'vehicle') {
        d.vehicleData = {
          stock: vehicle.STOCK_NUMBER ?? '',
          vin: vehicle.VIN_NUMBER ?? '',
          year: vehicle.YEAR ?? '',
          color: vehicle.EXT_COLOR ?? '',
          make: vehicle.MAKE ?? '',
          trim: vehicle.TRIM ?? '',
          model: vehicle.MODEL ?? '',
          mileage: vehicle.MILEAGE ?? '',
        };
      }
      if (w.type === 'barcode') d.vin = vehicle.VIN_NUMBER;
      if (w.type === 'mpg') {
        // CMPG / HMPG flow in from VehicleRow → widget data so the renderer's
        // hide-if-empty rule decides what prints. Strings stay strings.
        d.cmpg = vehicle.CMPG ?? null;
        d.hmpg = vehicle.HMPG ?? null;
      }
      if (w.type === 'infobox' && (d.ibType as string) === 'photo') {
        const photos = parsePhotos(vehicle.PHOTOS ?? null);
        if (photos[0]) d.imgUrl = photos[0];
      }
    }

    if (options !== undefined && w.type === 'options') {
      d.items = requiredOptions.map(o => ({
        name: o.option_name,
        desc: o.description ?? '',
        price: formatOptionPrice(o.option_price, decimals),
        separator_above: o.separator_above === true,
        separator_below: o.separator_below === true,
        spaces: typeof o.spaces === 'number' ? o.spaces : 0,
      }));
    }
    if (options !== undefined && w.type === 'suggested_options') {
      d.items = suggestedOptions.map(o => ({
        name: o.option_name,
        desc: o.description ?? '',
        price: formatOptionPrice(o.option_price, decimals),
        separator_above: o.separator_above === true,
        separator_below: o.separator_below === true,
        spaces: typeof o.spaces === 'number' ? o.spaces : 0,
      }));
    }

    // Infosheet description: inject AI or DB vehicle description if widget has no custom content.
    // d.aiMode arrives carrying the dealer's PREFERENCE; we overwrite it
    // with the ACTUAL source picked so the rendered AI/DB pill matches the
    // text the dealer sees.
    if (w.type === 'description') {
      // Detect all known placeholder variants (from DEFS default or widgetRenderer fallback)
      const isPlaceholder = d.text == null || d.text === '' ||
        (typeof d.text === 'string' && d.text.startsWith('Vehicle description will appear here'));
      if (isPlaceholder) {
        // prefer DB when ai_content_default=false; prefer AI when true; fallback to whichever exists
        let text: string | null = null;
        let source: 'db' | 'ai' | null = null;
        if (aiEnabled) {
          if (aiDescription) { text = aiDescription; source = 'ai'; }
          else if (dbDescription) { text = dbDescription; source = 'db'; }
        } else {
          if (dbDescription) { text = dbDescription; source = 'db'; }
          else if (aiDescription) { text = aiDescription; source = 'ai'; }
        }
        d.text = text ?? '';
        if (source) d.aiMode = source;
      }
    }

    // Disclaimer: stuff the resolved list into the widget so renderW renders
    // identical output on canvas and in print. Auto-bottom injection is gone
    // — disclaimers only print when a Disclaimer widget is placed.
    if (w.type === 'disclaimer') {
      d.disclaimers = disclaimers ?? [];
    }

    // Infosheet features: inject AI features or DB options text if widget has no custom content.
    // Same pill-match logic as description — set d.aiMode to whatever source
    // ended up populating d.items.
    if (w.type === 'features') {
      const rawItems = d.items as [string, string][] | null | undefined;
      // Detect default placeholder: null/empty, or every row starts with 'Feature' (DEFS default pattern)
      const isDefault = !rawItems || rawItems.length === 0 || (
        Array.isArray(rawItems) &&
        rawItems.every(row => Array.isArray(row) && typeof row[0] === 'string' && row[0].startsWith('Feature'))
      );
      if (isDefault) {
        const aiPairs = aiFeatures?.length ? aiFeatures : null;
        const dbPairs = dbOptionsText
          ? (() => {
              const lines = dbOptionsText.split(/[\n\r,]+/).map((s: string) => s.trim()).filter(Boolean);
              if (!lines.length) return null;
              const pairs: [string, string][] = [];
              for (let i = 0; i < lines.length; i += 2) pairs.push([lines[i], lines[i + 1] ?? '']);
              return pairs;
            })()
          : null;
        let chosen: [string, string][] | null = null;
        let source: 'db' | 'ai' | null = null;
        if (aiEnabled) {
          if (aiPairs) { chosen = aiPairs; source = 'ai'; }
          else if (dbPairs) { chosen = dbPairs; source = 'db'; }
        } else {
          if (dbPairs) { chosen = dbPairs; source = 'db'; }
          else if (aiPairs) { chosen = aiPairs; source = 'ai'; }
        }
        d.items = chosen ?? []; // empty array suppresses placeholder
        if (source) d.aiMode = source;
      }
    }

    return { ...w, d };
  });

  const widgetHtml = [...enriched]
    .sort((a, b) => (a.z ?? 10) - (b.z ?? 10))
    .map(w => {
      const inner = renderW(w.type, w.d, fontScale);
      // overflow:visible matches the canvas — widget content is never clipped
      return `<div style="position:absolute;left:${w.x}px;top:${w.y}px;width:${w.w}px;height:${w.h}px;overflow:visible;z-index:${w.z ?? 10};background:transparent;">${inner}</div>`;
    })
    .join('\n');

  const rawHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { width: ${paper.w}px; height: ${paper.h}px; overflow: hidden; background: #fff; font-family: -apple-system, Roboto, Arial, sans-serif; }
.paper { position: relative; width: ${paper.w}px; height: ${paper.h}px; background: #fff; overflow: hidden; }
.frame { position: absolute; inset: 0; z-index: 2; pointer-events: none; }
.frame img { width: 100%; height: 100%; display: block; mix-blend-mode: multiply; }
.description-html p { margin: 0; }
.description-html p:empty { min-height: 1em; }
.description-html ul { margin: 0; padding-left: 1.2em; list-style-type: disc; }
.description-html ul ul { list-style-type: circle; padding-left: 1.2em; }
.description-html ol { margin: 0; padding-left: 1.2em; list-style-type: decimal; }
.description-html li { margin: 0; padding: 0; }
</style>
</head>
<body>
<div class="paper">
  <div class="frame"><img src="${bgUrl}" alt=""></div>
  ${widgetHtml}
</div>
</body>
</html>`;

  return inlineImagesInHtml(rawHtml);
}
