// Server-only: builds an HTML string for Puppeteer to render as a PDF.
import { renderW } from '@/components/builder/widgetRenderer';
import type { Widget, PaperSize } from '@/components/builder/types';
import { formatOptionPrice } from '@/lib/option-price';
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

type AnyOption = { option_name: string; option_price: string; active?: boolean; description?: string | null };

export interface BuildPdfHtmlInput {
  widgets: Widget[];
  paperSize: string;
  fontScale: number;
  bgUrl: string;
  vehicle?: VehicleRow;
  options?: AnyOption[];
  disclaimer?: string;
  dealerLogoUrl?: string | null;
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

  const enriched = widgets.map(w => {
    const d = { ...w.d };

    // Logo: always override saved template value with live dealer logo.
    // null = dealer has no logo → render blank. undefined = not provided → keep saved.
    if (w.type === 'logo' && dealerLogoUrl !== undefined) {
      d.imgUrl = dealerLogoUrl;
    }

    // MSRP / askbar / subtotal: always use live vehicle data, never saved template values.
    if (w.type === 'msrp' && vehicle?.MSRP) {
      const msrp = parseFloat(vehicle.MSRP);
      if (!isNaN(msrp)) d.value = `$${msrp.toLocaleString()}`;
    }
    if (w.type === 'askbar' && vehicle) {
      const msrp = vehicle.MSRP != null ? parseFloat(vehicle.MSRP) : null;
      if (paperSize === 'infosheet') {
        // Infosheet: asking price = MSRP only (no addendum options total)
        if (msrp != null && !isNaN(msrp) && msrp > 0) d.value = `$${msrp.toLocaleString()}`;
      } else {
        const optTotal = (options ?? []).reduce((s, o) => s + (parseFloat(o.option_price) || 0), 0);
        const total = (msrp ?? 0) + optTotal;
        if (total > 0) d.value = `$${total.toLocaleString()}`;
      }
    }
    if (w.type === 'subtotal') {
      const optTotal = (options ?? []).reduce((s, o) => s + (parseFloat(o.option_price) || 0), 0);
      if (optTotal > 0) d.value = `$${optTotal.toLocaleString()}`;
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
      d.items = options.filter(o => o.active !== false).map(o => ({
        name: o.option_name,
        desc: o.description ?? '',
        price: formatOptionPrice(o.option_price),
      }));
    }

    // Infosheet description: inject AI or DB vehicle description if widget has no custom content
    if (w.type === 'description') {
      const placeholder = 'Vehicle description will appear here.';
      if (d.text == null || d.text === placeholder) {
        // prefer DB when ai_content_default=false; prefer AI when true; fallback to whichever exists
        const text = aiEnabled
          ? (aiDescription || dbDescription || null)
          : (dbDescription || aiDescription || null);
        // empty string suppresses the placeholder without showing stray text
        d.text = text ?? '';
      }
    }

    // Infosheet features: inject AI features or DB options text if widget has no custom content
    if (w.type === 'features') {
      const rawItems = d.items as [string, string][] | null | undefined;
      const isDefault = !rawItems || rawItems.length === 0 || (
        rawItems.length === 1 && rawItems[0][0] === 'Feature' && rawItems[0][1] === 'Feature'
      );
      if (isDefault) {
        if (aiEnabled && aiFeatures && aiFeatures.length > 0) {
          d.items = aiFeatures;
        } else if (dbOptionsText) {
          const lines = dbOptionsText.split(/[\n\r,]+/).map((s: string) => s.trim()).filter(Boolean);
          if (lines.length > 0) {
            const pairs: [string, string][] = [];
            for (let i = 0; i < lines.length; i += 2) {
              pairs.push([lines[i], lines[i + 1] ?? '']);
            }
            d.items = pairs;
          } else {
            d.items = []; // suppress placeholder
          }
        } else if (!aiEnabled && aiFeatures && aiFeatures.length > 0) {
          // DB preferred but empty — use AI as fallback
          d.items = aiFeatures;
        } else {
          d.items = []; // no content available — suppress placeholder
        }
      }
    }

    return { ...w, d };
  });

  const widgetHtml = enriched
    .map(w => {
      const inner = renderW(w.type, w.d, fontScale);
      // overflow:visible matches the canvas — widget content is never clipped
      return `<div style="position:absolute;left:${w.x}px;top:${w.y}px;width:${w.w}px;height:${w.h}px;overflow:visible;z-index:10;background:transparent;">${inner}</div>`;
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
