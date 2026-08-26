// Client for the da-pdf-service microservice (Phase 10b).
//
// Mirrors the three local rendering entry points so callers can swap
// the local Puppeteer path for the service path behind a single env
// flag (USE_PDF_SERVICE). Returns Buffer in every case so the existing
// route response contract (stream bytes back as application/pdf) holds
// without any UI change. Phase E will flip the UI to polling and let
// callers redirect to the signed URL directly.
//
// Wire format is documented in da-pdf-service/README.md.

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 120_000; // 2 min — covers a 200-vehicle bulk

/** Tag drives the S3 lifecycle rule. Defaults to "addendum" (180-day
 *  retention) — explicitly opt into the short-TTL classes for everything
 *  else. The service falls back to "addendum" on unknown input as a
 *  safety net, so the worst case of a missing docType is over-retention,
 *  not accidental same-day deletion of an addendum. */
export type PdfDocTypeTag = "addendum" | "infosheet" | "buyer_guide";

export interface RenderOpts {
  /** "standard" | "narrow" | "infosheet" | "buyers_guide" */
  paperSize?: string;
  customDims?: { widthIn: number; heightIn: number };
  /** Default false; pass true for Buyer's Guide which is a 2-page render. */
  allPages?: boolean;
  /** Drives the S3 object tag and therefore the lifecycle retention. */
  docType?: PdfDocTypeTag;
}

export interface BulkItem {
  html: string;
  paperSize?: string;
  customDims?: { widthIn: number; heightIn: number };
  allPages?: boolean;
  /** Optional per-vehicle S3 key. When set, the service uploads each
   *  rendered PDF to that key directly (saves a round-trip through
   *  da-platform). Per-item s3Key/signedUrl come back in the status
   *  response's `items[]` array. */
  s3Key?: string;
}

export interface BulkItemResult {
  s3Key: string | null;
  signedUrl?: string;
  error?: string;
}

interface StatusResponse {
  jobId: string;
  status: "pending" | "running" | "complete" | "failed";
  s3Key?: string;
  signedUrl?: string;
  /** Present on bulk jobs. Parallel to the items[] array sent in. */
  items?: BulkItemResult[];
  error?: string;
}

export function pdfServiceConfigured(): boolean {
  return Boolean(
    process.env.PDF_SERVICE_URL
      && process.env.PDF_SERVICE_API_KEY,
  );
}

/**
 * Phase D's gate. False unless USE_PDF_SERVICE is "1" / "true" AND the
 * URL + API key are present. Routes check this before calling into the
 * service; when false they fall back to the local Puppeteer code path.
 */
export function useService(): boolean {
  if (!pdfServiceConfigured()) return false;
  const flag = (process.env.USE_PDF_SERVICE ?? "").toLowerCase();
  return flag === "1" || flag === "true";
}

function baseUrl(): string {
  const url = process.env.PDF_SERVICE_URL;
  if (!url) throw new Error("PDF_SERVICE_URL not set");
  return url.replace(/\/$/, "");
}

function headers(): Record<string, string> {
  const key = process.env.PDF_SERVICE_API_KEY;
  if (!key) throw new Error("PDF_SERVICE_API_KEY not set");
  return { "Content-Type": "application/json", "X-API-Key": key };
}

async function postJson(path: string, body: unknown): Promise<{ jobId: string }> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`pdf-service ${path} returned ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json() as { jobId?: string; error?: string };
  if (!json.jobId) throw new Error(`pdf-service ${path}: missing jobId (${json.error ?? "no error"})`);
  return { jobId: json.jobId };
}

async function pollUntilDone(jobId: string): Promise<StatusResponse> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl()}/api/pdf/status/${encodeURIComponent(jobId)}`, {
      headers: headers(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`pdf-service status ${res.status}: ${text.slice(0, 200)}`);
    }
    const status = await res.json() as StatusResponse;
    if (status.status === "complete") return status;
    if (status.status === "failed") {
      throw new Error(`pdf-service render failed: ${status.error ?? "unknown"}`);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`pdf-service timed out after ${POLL_TIMEOUT_MS}ms (jobId=${jobId})`);
}

/**
 * Fetch the rendered PDF from S3 via the signed URL returned by the
 * service. Returns a Buffer so the caller can stream it back in the
 * existing response.
 */
async function fetchSigned(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`signed-url fetch failed: ${res.status}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

export async function renderViaService(
  html: string,
  opts: RenderOpts,
  s3Key: string,
): Promise<{ buffer: Buffer; s3Key: string }> {
  const { jobId } = await postJson("/api/pdf/generate", {
    html,
    paperSize: opts.paperSize ?? "standard",
    customDims: opts.customDims,
    allPages: opts.allPages ?? false,
    docType: opts.docType ?? "addendum",
    s3Key,
  });
  const done = await pollUntilDone(jobId);
  if (!done.signedUrl || !done.s3Key) {
    throw new Error("pdf-service complete but missing signedUrl/s3Key");
  }
  const buffer = await fetchSigned(done.signedUrl);
  return { buffer, s3Key: done.s3Key };
}

export async function renderBulkViaService(
  items: BulkItem[],
  s3Key: string,
  docType: PdfDocTypeTag = "addendum",
): Promise<{ buffer: Buffer; s3Key: string; items: BulkItemResult[] }> {
  const { jobId } = await postJson("/api/pdf/bulk", {
    jobs: items,
    docType,
    s3Key,
  });
  const done = await pollUntilDone(jobId);
  if (!done.signedUrl || !done.s3Key) {
    throw new Error("pdf-service bulk complete but missing signedUrl/s3Key");
  }
  const buffer = await fetchSigned(done.signedUrl);
  return { buffer, s3Key: done.s3Key, items: done.items ?? [] };
}

export async function renderBuyerGuideViaService(
  srcPdfBytes: Buffer | null,
  input: unknown,
  s3Key: string,
): Promise<{ buffer: Buffer; s3Key: string }> {
  // srcPdfBytes is null in pre-printed-label mode (input.preprinted set):
  // the service renders data-only on blank pages, no background needed.
  const { jobId } = await postJson("/api/pdf/buyer-guide", {
    ...(srcPdfBytes ? { srcPdfBase64: srcPdfBytes.toString("base64") } : {}),
    input,
    s3Key,
  });
  const done = await pollUntilDone(jobId);
  if (!done.signedUrl || !done.s3Key) {
    throw new Error("pdf-service buyer-guide complete but missing signedUrl/s3Key");
  }
  const buffer = await fetchSigned(done.signedUrl);
  return { buffer, s3Key: done.s3Key };
}

// ── Phase E: fire-and-poll helpers ───────────────────────────────────────────
//
// These return the jobId immediately instead of polling-and-streaming. The
// caller (a Next.js route in async mode) ships the jobId to the browser, the
// browser polls /api/pdf/status/:jobId on da-platform, da-platform proxies
// to the PDF service. Used when the client sends ?async=1.

export async function enqueueGenerate(
  html: string,
  opts: RenderOpts,
  s3Key: string,
): Promise<{ jobId: string }> {
  return postJson("/api/pdf/generate", {
    html,
    paperSize: opts.paperSize ?? "standard",
    customDims: opts.customDims,
    allPages: opts.allPages ?? false,
    docType: opts.docType ?? "addendum",
    s3Key,
  });
}

export async function enqueueBuyerGuide(
  srcPdfBytes: Buffer,
  input: unknown,
  s3Key: string,
): Promise<{ jobId: string }> {
  return postJson("/api/pdf/buyer-guide", {
    srcPdfBase64: srcPdfBytes.toString("base64"),
    input,
    s3Key,
  });
}

/**
 * Wait for an already-enqueued job to finish and return its buffer.
 * Used by the async route flow: enqueueGenerate returns the jobId
 * immediately (so the browser can start polling), then the route
 * fire-and-forgets this to complete the DB-logging pipeline.
 */
export async function awaitJobAndFetch(jobId: string): Promise<{ buffer: Buffer; s3Key: string }> {
  const done = await pollUntilDone(jobId);
  if (!done.signedUrl || !done.s3Key) {
    throw new Error("pdf-service complete but missing signedUrl/s3Key");
  }
  const buffer = await fetchSigned(done.signedUrl);
  return { buffer, s3Key: done.s3Key };
}

/**
 * Server-side proxy lookup for the job status. Called from
 * GET /api/pdf/status/:jobId on da-platform to keep the PDF service URL
 * private (the browser never sees 172.31.71.67).
 */
export async function fetchJobStatus(jobId: string): Promise<StatusResponse> {
  const res = await fetch(`${baseUrl()}/api/pdf/status/${encodeURIComponent(jobId)}`, {
    headers: headers(),
  });
  if (res.status === 404) {
    return { jobId, status: "failed", error: "Job not found or expired" };
  }
  if (!res.ok) {
    throw new Error(`pdf-service status ${res.status}`);
  }
  return res.json() as Promise<StatusResponse>;
}
