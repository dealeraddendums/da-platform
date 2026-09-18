import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";

/**
 * POST /api/help/jw/upload-proxy?to=<jw upload link> — super_admin only.
 *
 * FALLBACK ONLY. The browser PUTs straight to JW's pre-authorized S3 URL; this
 * exists because whether that S3 bucket answers a cross-origin PUT from
 * app.dealeraddendums.com is JW's configuration, not ours, and it is not
 * documented. If the direct PUT dies with an opaque network/CORS error the
 * editor retries through here rather than leaving the author with a dead
 * button. Confirm which path a real upload takes before trusting either.
 *
 * The body is STREAMED to JW (duplex: "half") — a 2 GB video must never be
 * buffered into this process's memory.
 */
export const maxDuration = 300;

// JW hands back an S3 upload link. Refuse to relay to anywhere else: this
// endpoint takes a caller-supplied URL, so without this it is an SSRF hole that
// happens to be authenticated.
function isJwUploadTarget(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:") return false;
  return /(^|\.)jwplayer\.com$/.test(u.hostname)
    || /(^|\.)jwplatform\.com$/.test(u.hostname)
    || /(^|\.)amazonaws\.com$/.test(u.hostname);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const to = req.nextUrl.searchParams.get("to") ?? "";
  if (!isJwUploadTarget(to)) return NextResponse.json({ error: "Not a JW upload target" }, { status: 400 });
  if (!req.body) return NextResponse.json({ error: "No body" }, { status: 400 });

  const contentType = req.headers.get("content-type") ?? "application/octet-stream";
  try {
    const res = await fetch(to, {
      method: "PUT",
      body: req.body,
      headers: { "Content-Type": contentType },
      // Required by undici to stream a request body.
      // @ts-expect-error -- `duplex` is valid at runtime, not yet in the DOM types
      duplex: "half",
    });
    if (!res.ok) return NextResponse.json({ error: `JW upload failed (HTTP ${res.status}).` }, { status: 502 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[help/jw/upload-proxy] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Upload to JW failed." }, { status: 502 });
  }
}
