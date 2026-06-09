// Shared file generation for the BI export + email routes. PDF goes through
// da-pdf-service (HTML→PDF, letter-size, all pages); Excel through exceljs.
// Both render from the same BiReport so the two files always reconcile.

import type { BiReport } from "@/lib/bi";
import { buildBiReportHtml } from "@/lib/bi-report-html";
import { buildBiExcel } from "@/lib/bi-excel";
import { renderViaService, useService } from "@/lib/pdf-service-client";

/** Filename stem like "da-bi-2026-05-01_2026-05-31". */
export function biFileStem(report: BiReport): string {
  return `da-bi-${report.period.from}_${report.period.to}`;
}

/**
 * Render the BI report HTML to a letter-size, multi-page PDF via
 * da-pdf-service. Throws if the service isn't enabled (no local fallback —
 * Phase 10b removed Puppeteer from da-platform).
 */
export async function generateBiPdf(report: BiReport): Promise<Buffer> {
  if (!useService()) {
    throw new Error("PDF service not configured (USE_PDF_SERVICE)");
  }
  const html = buildBiReportHtml(report);
  const s3Key = `bi-reports/${biFileStem(report)}_${Date.now()}.pdf`;
  const { buffer } = await renderViaService(
    html,
    { customDims: { widthIn: 8.5, heightIn: 11 }, allPages: true, docType: "addendum" },
    s3Key,
  );
  return buffer;
}

export async function generateBiExcel(report: BiReport): Promise<Buffer> {
  return buildBiExcel(report);
}

export const PDF_MIME = "application/pdf";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
