import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * POST /api/migration/freshbooks-stopped — Phase 13d (operator tracking).
 * super_admin marks (or un-marks) that a migrated dealer's legacy FreshBooks
 * recurring profile has been stopped — done MANUALLY in FreshBooks (the OAuth
 * token rotation makes auto-stop unsafe). Body: { dealerId, stopped: boolean }.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  let body: { dealerId?: string; stopped?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body.dealerId || typeof body.stopped !== "boolean") {
    return NextResponse.json({ error: "dealerId and stopped (boolean) required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbError } = await (admin as any)
    .from("dealers")
    .update({ freshbooks_stopped_at: body.stopped ? new Date().toISOString() : null })
    .eq("id", body.dealerId)
    .select("id, freshbooks_stopped_at")
    .single();

  if (dbError) {
    if (/freshbooks_stopped_at|column/i.test(dbError.message)) {
      return NextResponse.json({ error: "freshbooks_stopped_at column missing — apply migration 104." }, { status: 409 });
    }
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });
  return NextResponse.json({ ok: true, freshbooks_stopped_at: (data as { freshbooks_stopped_at: string | null }).freshbooks_stopped_at });
}
