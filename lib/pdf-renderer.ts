// Server-only: renders HTML to PDF via Puppeteer (headless Chrome).
import puppeteer from 'puppeteer';
import type { Browser } from 'puppeteer';

type KnownSize = 'standard' | 'narrow' | 'infosheet' | 'buyers_guide';

const KNOWN_WIDTHS: Record<KnownSize, string> = {
  standard:     '4.25in',
  narrow:       '3.125in',
  infosheet:    '8.5in',
  buyers_guide: '8.5in',
};

const KNOWN_CSS_WIDTHS: Record<KnownSize, number> = {
  standard:     408,
  narrow:       300,
  infosheet:    816,
  buyers_guide: 816,
};

const KNOWN_CSS_HEIGHTS: Record<KnownSize, number> = {
  standard:     1056,
  narrow:       1056,
  infosheet:    1056,
  buyers_guide: 1056,
};

export interface PdfRenderOptions {
  /** custom paper dimensions in inches — overrides known sizes */
  customDims?: { widthIn: number; heightIn: number };
  /** render all pages instead of just page 1 (for Buyer's Guide 2-pager) */
  allPages?: boolean;
  /** shared browser instance for bulk generation; if omitted a new browser is launched */
  browser?: Browser;
}

export async function renderPdf(
  html: string,
  paperSize: string,
  opts: PdfRenderOptions = {},
): Promise<Buffer> {
  const { customDims, allPages = false, browser: sharedBrowser } = opts;

  let widthStr: string;
  let cssW: number;
  let cssH: number;

  if (customDims) {
    widthStr = `${customDims.widthIn}in`;
    cssW = Math.round(customDims.widthIn * 96);
    cssH = Math.round(customDims.heightIn * 96);
  } else {
    const known = KNOWN_WIDTHS[paperSize as KnownSize];
    widthStr = known ?? '4.25in';
    cssW = KNOWN_CSS_WIDTHS[paperSize as KnownSize] ?? 408;
    cssH = KNOWN_CSS_HEIGHTS[paperSize as KnownSize] ?? 1056;
  }

  const heightStr = customDims ? `${customDims.heightIn}in` : '11in';

  const ownsBrowser = !sharedBrowser;
  const browser = sharedBrowser ?? await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: cssW, height: cssH, deviceScaleFactor: 1.5625 });
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const pdfBuffer = await page.pdf({
      width: widthStr,
      height: heightStr,
      printBackground: true,
      ...(allPages ? {} : { pageRanges: '1' }),
    });
    await page.close();
    return Buffer.from(pdfBuffer);
  } finally {
    if (ownsBrowser) await browser.close();
  }
}
