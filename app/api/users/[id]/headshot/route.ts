import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { authorizeUserTarget } from "@/lib/user-authz";
import { uploadLogo } from "@/lib/s3-upload";

export const dynamic = "force-dynamic";

/**
 * GET    /api/users/[id]/headshot                     — the current photo URL (or null)
 * POST   /api/users/[id]/headshot  (multipart "file") — save a square headshot
 * DELETE /api/users/[id]/headshot                     — remove it
 *
 * The image arrives already cropped square by the browser (HeadshotEditor);
 * it's shown inside a circle in the Steven chat header when this person takes
 * over a chat. Stored with the existing S3 logo upload (public, under
 * headshots/) — migration 172 profiles.headshot_url.
 *
 * Who: anyone for THEMSELVES; a managing admin (the Users-screen rule,
 * authorizeUserTarget) for someone else. dealer_user / dealer_restricted can
 * only change their own.
 */
const ADMIN_ROLES = new Set(["super_admin", "dealer_admin", "group_admin", "group_user"]);
const MAX = 2 * 1024 * 1024;
const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

async function authorize(rawId: string) {
  const { claims, error } = await requireAuth();
  if (error) return { error };
  const admin = createAdminSupabaseClient();
  const id = rawId === "me" ? claims.sub : rawId; // "me" = the signed-in user (My Profile)
  if (claims.sub !== id) {
    if (!ADMIN_ROLES.has(claims.role)) return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    const authz = await authorizeUserTarget(admin, claims, id);
    if (!authz.ok) return { error: authz.response };
  }
  return { error: null as null, admin, id };
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const a = await authorize(params.id);
  if (a.error) return a.error;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (a.admin as any).from("profiles").select("headshot_url").eq("id", a.id).maybeSingle();
  return NextResponse.json({ url: data?.headshot_url ?? null }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const a = await authorize(params.id);
  if (a.error) return a.error;
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof Blob)) return NextResponse.json({ error: "No image" }, { status: 400 });
  const ext = TYPES[file.type];
  if (!ext) return NextResponse.json({ error: "Use a JPG, PNG or WebP image" }, { status: 400 });
  if (file.size > MAX) return NextResponse.json({ error: "Image is too large (2 MB max)" }, { status: 400 });
  const url = await uploadLogo(Buffer.from(await file.arrayBuffer()), `headshots/${a.id}/${Date.now()}.${ext}`, file.type);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (a.admin as any).from("profiles").update({ headshot_url: url }).eq("id", a.id);
  if (error) return NextResponse.json({ error: "Could not save the photo" }, { status: 500 });
  return NextResponse.json({ ok: true, url });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const a = await authorize(params.id);
  if (a.error) return a.error;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (a.admin as any).from("profiles").update({ headshot_url: null }).eq("id", a.id);
  return NextResponse.json({ ok: true });
}
