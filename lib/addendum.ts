// Shared helpers for addendum/legacy API operations.
// Safe to import in server-side route handlers.

export const ADDENDUM_S3_BUCKET = "https://dealer-addendums.s3.amazonaws.com";

/** HEAD-check whether a PDF has been generated for this VIN. */
export async function checkPdfExists(vin: string): Promise<string | null> {
  const url = `${ADDENDUM_S3_BUCKET}/${vin.toUpperCase()}.pdf`;
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok ? url : null;
  } catch {
    return null;
  }
}

/** Build the standard download-button HTML embed. */
export function buildButtonHtml(theme: string, pdfUrl: string, text = "Download Addendum"): string {
  const safeTheme = theme.replace(/[^a-zA-Z0-9_-]/g, "");
  return `<div class="${safeTheme}"><a href="${pdfUrl}" class="dealer-addendums__button__download-button" target="_blank">${text}</a></div>`;
}
