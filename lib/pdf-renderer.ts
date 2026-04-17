// Server-only: renders HTML to PDF via Puppeteer (headless Chrome).
import puppeteer from 'puppeteer';
import type { PaperSize } from '@/components/builder/types';

const PAPER_WIDTHS: Record<PaperSize, string> = {
  standard: '4.25in',
  narrow: '3.125in',
  infosheet: '8.5in',
};

const PAPER_CSS_WIDTHS: Record<PaperSize, number> = {
  standard: 408,
  narrow: 300,
  infosheet: 816,
};

export async function renderPdf(html: string, paperSize: PaperSize): Promise<Buffer> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({
      width: PAPER_CSS_WIDTHS[paperSize],
      height: 1056,
      deviceScaleFactor: 1.5625,
    });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30_000 });
    const pdfBuffer = await page.pdf({
      width: PAPER_WIDTHS[paperSize],
      height: '11in',
      printBackground: true,
      pageRanges: '1',
    });
    return Buffer.from(pdfBuffer);
  } finally {
    await browser.close();
  }
}
