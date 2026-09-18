import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createDirectUpload, JwError } from "@/lib/jwplayer";

// Client-side guardrails are mirrored here — the browser's limits are a
// courtesy, this is the gate.
const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB, comfortably inside JW's 5 GB direct limit
const ALLOWED_MIME = new Set(["video/mp4", "video/webm", "video/quicktime", "video/x-m4v"]);

/**
 * POST /api/help/jw/upload-init — super_admin only (the Help CMS).
 * Body: { filename, mimeType, size, title? }
 * → { mediaId, uploadLink, uploadOrigin }
 *
 * The JW secret signs this call server-side and never leaves the server;
 * `uploadLink` is JW's own short-lived pre-authorized S3 URL, which is what the
 * browser PUTs the bytes to (the same shape as an S3 presigned upload).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { filename?: string; mimeType?: string; size?: number; title?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const mimeType = (body.mimeType ?? "").trim().toLowerCase();
  if (!ALLOWED_MIME.has(mimeType)) {
    return NextResponse.json({ error: "Only MP4, WebM or MOV video files can be uploaded." }, { status: 422 });
  }
  if (!Number.isFinite(body.size) || (body.size as number) <= 0) {
    return NextResponse.json({ error: "Missing file size" }, { status: 400 });
  }
  if ((body.size as number) > MAX_BYTES) {
    return NextResponse.json({ error: "Video must be under 2 GB." }, { status: 422 });
  }

  const title = (body.title?.trim() || body.filename?.trim() || "Help Center video").slice(0, 200);

  try {
    const { mediaId, uploadLink } = await createDirectUpload({ title, mimeType });
    // The browser needs the upload target's ORIGIN to know whether its own CSP
    // will allow the PUT; it also lets us report a CORS failure precisely
    // instead of as a generic network error.
    let uploadOrigin = "";
    try { uploadOrigin = new URL(uploadLink).origin; } catch { /* leave blank */ }
    return NextResponse.json({ mediaId, uploadLink, uploadOrigin });
  } catch (err) {
    if (err instanceof JwError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error("[help/jw/upload-init] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't start the upload." }, { status: 502 });
  }
}
