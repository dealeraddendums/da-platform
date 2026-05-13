// Server-only: builds an HTML string for Puppeteer to render as a PDF.
import { renderW } from '@/components/builder/widgetRenderer';
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

const PAPER_DIMS: Record<string, { w: number; h: number }> = {
  standard: { w: 408, h: 1056 },
  narrow: { w: 300, h: 1056 },
  infosheet: { w: 816, h: 1056 },
};

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
  disclaimer?: string;
  dealerLogoUrl?: string | null;
  dealer?: { name?: string | null; address?: string | null; city?: string | null; state?: string | null; zip?: string | null; phone?: string | null };
  customDims?: { widthIn: number; heightIn: number };
  aiEnabled?: boolean;
  aiDescription?: string | null;
  aiFeatures?: [string, string][] | null;
  dbDescription?: string | null;
  dbOptionsText?: string | null;
}

export async function buildPdfHtml({
  widgets,
  paperSize,
  fontScale,
  bgUrl,
  vehicle,
  options,
  disclaimer,
  dealerLogoUrl,
  dealer,
  customDims,
  aiEnabled,
  aiDescription,
  aiFeatures,
  dbDescription,
  dbOptionsText,
}: BuildPdfHtmlInput): Promise<string> {
  const paper = customDims
    ? { w: Math.round(customDims.widthIn * 96), h: Math.round(customDims.heightIn * 96) }
    : (PAPER_DIMS[paperSize] ?? PAPER_DIMS.standard);

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

    // Logo: always override saved template value with live dealer logo.
    // null = dealer has no logo → render blank. undefined = not provided → keep saved.
    if (w.type === 'logo' && dealerLogoUrl !== undefined) {
      d.imgUrl = dealerLogoUrl;
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
    if (w.type === 'msrp' && msrpParsed != null) {
      d.value = formatCurrencyAmount(msrpParsed, decimals);
    }
    if (w.type === 'askbar' && vehicle) {
      if (paperSize === 'infosheet') {
        // Infosheet: asking price = MSRP only (no addendum options total)
        if (msrpParsed != null && msrpParsed > 0) {
          d.value = formatCurrencyAmount(msrpParsed, decimals);
          console.log('[pdf-html] infosheet askbar msrp:', msrpParsed, '→', d.value);
        }
      } else {
        // Asking price = MSRP + required options only
        if (askingTotal > 0) d.value = formatCurrencyAmount(askingTotal, decimals);
      }
    }
    if (w.type === 'subtotal') {
      // Subtotal = required options only
      if (requiredTotal > 0) d.value = formatCurrencyAmount(requiredTotal, decimals);
    }
    if (w.type === 'suggested_price' && vehicle) {
      // Suggested asking price = MSRP + all options (required + suggested)
      if (suggestedTotal > 0) d.value = formatCurrencyAmount(suggestedTotal, decimals);
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

    // Infosheet description: inject AI or DB vehicle description if widget has no custom content
    if (w.type === 'description') {
      // Detect all known placeholder variants (from DEFS default or widgetRenderer fallback)
      const isPlaceholder = d.text == null || d.text === '' ||
        (typeof d.text === 'string' && d.text.startsWith('Vehicle description will appear here'));
      if (isPlaceholder) {
        // prefer DB when ai_content_default=false; prefer AI when true; fallback to whichever exists
        const text = aiEnabled
          ? (aiDescription || dbDescription || null)
          : (dbDescription || aiDescription || null);
        // empty string suppresses the placeholder without showing stray text in PDF
        d.text = text ?? '';
      }
    }

    // Infosheet features: inject AI features or DB options text if widget has no custom content
    if (w.type === 'features') {
      const rawItems = d.items as [string, string][] | null | undefined;
      // Detect default placeholder: null/empty, or every row starts with 'Feature' (DEFS default pattern)
      const isDefault = !rawItems || rawItems.length === 0 || (
        Array.isArray(rawItems) &&
        rawItems.every(row => Array.isArray(row) && typeof row[0] === 'string' && row[0].startsWith('Feature'))
      );
      if (isDefault) {
        // Determine content: prefer based on aiEnabled, fallback to the other source
        const featuresContent = aiEnabled
          ? (aiFeatures?.length ? aiFeatures : null)
          : null;
        const dbContent = dbOptionsText
          ? (() => {
              const lines = dbOptionsText.split(/[\n\r,]+/).map((s: string) => s.trim()).filter(Boolean);
              if (!lines.length) return null;
              const pairs: [string, string][] = [];
              for (let i = 0; i < lines.length; i += 2) pairs.push([lines[i], lines[i + 1] ?? '']);
              return pairs;
            })()
          : null;

        const chosen = aiEnabled
          ? (featuresContent || dbContent || (aiFeatures?.length ? aiFeatures : null))
          : (dbContent || (aiFeatures?.length ? aiFeatures : null));

        d.items = chosen ?? []; // empty array suppresses placeholder; [] is truthy so || fallback won't fire
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

  const disclaimerHtml = disclaimer
    ? `<div style="position:absolute;bottom:4px;left:6px;right:6px;z-index:20;font-size:7px;line-height:1.3;color:#666;font-family:-apple-system,Roboto,Arial,sans-serif;">${disclaimer.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`
    : '';

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
.description-html ul { margin: 0; padding-left: 1.2em; list-style-type: disc; }
.description-html ul ul { list-style-type: circle; padding-left: 1.2em; }
.description-html ol { margin: 0; padding-left: 1.2em; }
.description-html li { margin: 0; padding: 0; }
</style>
</head>
<body>
<div class="paper">
  <div class="frame"><img src="${bgUrl}" alt=""></div>
  ${widgetHtml}
  ${disclaimerHtml}
</div>
</body>
</html>`;

  return inlineImagesInHtml(rawHtml);
}
