import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { copyRecordingToS3, recordingCopyEnabled, signRecordingKey } from "@/lib/crm/recordings";
import { fetchDialpadRecording } from "@/lib/crm/dialpad";

export const dynamic = "force-dynamic";

/**
 * GET /api/crm/calls/[id]/recording — staff-only playback. Our S3 copy →
 * redirect to a 15-minute signed URL; not copied yet → copy it now and
 * redirect; copying off → stream Dialpad's file through us (with our API key,
 * via a share link for admin recordings), so the browser never needs Dialpad auth.
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { error } = await requireCrmStaff();
  if (error) return error;

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: call } = await (admin as any)
    .from("crm_calls").select("company_id, recording_s3_key, recording_url, voicemail_url").eq("id", params.id).maybeSingle();
  if (!call) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (call.recording_s3_key) return NextResponse.redirect(await signRecordingKey(call.recording_s3_key), 302);

  const url = call.recording_url ?? call.voicemail_url;
  if (!url) return NextResponse.json({ error: "No recording" }, { status: 404 });
  if (recordingCopyEnabled()) {
    const key = await copyRecordingToS3(admin, params.id, call.company_id, url).catch(() => null);
    if (key) return NextResponse.redirect(await signRecordingKey(key), 302);
  }
  const upstream = await fetchDialpadRecording(url).catch(() => null);
  if (!upstream?.ok || !upstream.body) return NextResponse.json({ error: `Recording unavailable (${upstream?.status ?? "share link failed"})` }, { status: 502 });
  return new NextResponse(upstream.body as ReadableStream, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "audio/mpeg",
      "Cache-Control": "private, no-store",
    },
  });
}
