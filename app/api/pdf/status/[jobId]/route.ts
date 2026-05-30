import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { fetchJobStatus, useService as usePdfService } from "@/lib/pdf-service-client";

/**
 * GET /api/pdf/status/:jobId
 *
 * Server-side proxy to the PDF microservice's status endpoint. Browser
 * never talks directly to the service (its private IP isn't reachable
 * and the X-API-Key is a server secret).
 *
 * Auth is "any logged-in user" — jobIds are unguessable UUIDs so we
 * don't bother per-user ownership tracking yet. If a polling client
 * leaks a jobId, the worst case is someone else gets a 15-minute signed
 * URL to the same PDF; not great but not a real exposure either since
 * the PDF was about to land in front of them anyway.
 *
 * Returns the service response verbatim:
 *   { jobId, status: "pending" | "running" | "complete" | "failed",
 *     [s3Key, signedUrl] when complete, [error] when failed }
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { jobId: string } },
): Promise<NextResponse> {
  const { error } = await requireAuth();
  if (error) return error;

  if (!usePdfService()) {
    return NextResponse.json(
      { error: "PDF service disabled (USE_PDF_SERVICE=0)" },
      { status: 503 },
    );
  }

  try {
    const status = await fetchJobStatus(params.jobId);
    return NextResponse.json(status);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Status fetch failed";
    console.error("[pdf/status]", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
