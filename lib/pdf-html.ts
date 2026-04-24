// Server-only: builds an HTML string for Puppeteer to render as a PDF.
import { renderW } from '@/components/builder/widgetRenderer';
import type { Widget, PaperSize } from '@/components/builder/types';
import { formatOptionPrice } from '@/lib/option-price';
import { parsePhotos } from '@/lib/vehicles';
import type { VehicleRow } from '@/lib/vehicles';

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
}

export function buildPdfHtml({
  widgets,
  paperSize,
  fontScale,
  bgUrl,
  vehicle,
  options,
  disclaimer,
  dealerLogoUrl,
  customDims,
}: BuildPdfHtmlInput): string {
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
      const msrp = vehicle.MSRP ? parseFloat(vehicle.MSRP) : 0;
      const optTotal = (options ?? []).reduce((s, o) => s + (parseFloat(o.option_price) || 0), 0);
      const total = msrp + optTotal;
      if (total > 0) d.value = `$${total.toLocaleString()}`;
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

  return `<!DOCTYPE html>
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
}
