import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getMediaStatus, isJwMediaId, JwError } from "@/lib/jwplayer";

/**
 * GET /api/help/jw/status/[mediaId] — super_admin only.
 * → { status: "created" | "processing" | "ready" | "failed" | "unknown" }
 *
 * Lets the editor flip a freshly uploaded video from "Processing…" to "Ready"
 * without the author reloading or guessing. Dealers never call this — by the
 * time an article is published the media is long since transcoded, and the
 * player handles a not-yet-ready item on its own.
 */
export async function GET(_req: NextRequest, { params }: { params: { mediaId: string } }): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  if (!isJwMediaId(params.mediaId)) return NextResponse.json({ error: "Not a JW media id" }, { status: 400 });

  try {
    return NextResponse.json({ status: await getMediaStatus(params.mediaId) });
  } catch (err) {
    if (err instanceof JwError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error("[help/jw/status] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't check the video status." }, { status: 502 });
  }
}
