import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * POST /api/migration/force-hold — super_admin only.
 * Park (or un-park) a dealer so the team can leave it out of the force queue
 * without losing track of it. Body: { dealerId, hold: boolean, reason?: string }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  let body: { dealerId?: string; hold?: boolean; reason?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body.dealerId) return NextResponse.json({ error: "dealerId required" }, { status: 400 });
  if (typeof body.hold !== "boolean") return NextResponse.json({ error: "hold (boolean) required" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: upErr } = await (admin as any)
    .from("dealers")
    .update({ force_hold: body.hold, force_hold_reason: body.hold ? (body.reason ?? null) : null })
    .eq("id", body.dealerId);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  void (admin as any).from("migration_log").insert({
    dealer_id: body.dealerId,
    event: body.hold ? "force_hold_set" : "force_hold_cleared",
    performed_by: claims.sub,
    notes: body.reason ?? null,
  }).then?.(() => {});

  return NextResponse.json({ ok: true, hold: body.hold });
}
