import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/migration/stage-dealer — stage a dealer for an upcoming wave.
 * super_admin only. Body: { dealer_id: <dealers.id UUID> } (dealerId also accepted).
 *
 * Sets dealers.migration_status = 'pending', which FREEZES the DA Legacy ETL
 * for this dealer immediately (runner excludes 'pending') so it stops
 * overwriting their settings before migration_status flips to 'migrated'.
 * Also writes a migration_log row (event = 'staged_for_migration').
 *
 * Idempotent and reversible: staging an already-staged dealer is a no-op; a
 * dealer can be un-staged by other flows (e.g. invite/migration progresses it
 * forward). We never stage an already-'migrated' dealer.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  let body: { dealer_id?: string; dealerId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const dealerId = (body.dealer_id ?? body.dealerId ?? "").trim();
  if (!UUID_RE.test(dealerId)) {
    return NextResponse.json({ error: "dealer_id must be a dealer UUID." }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Don't re-stage a fully-migrated dealer.
  const { data: dealer, error: readErr } = await admin
    .from("dealers")
    .select("id, migration_status")
    .eq("id", dealerId)
    .maybeSingle<{ id: string; migration_status: string | null }>();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!dealer) return NextResponse.json({ error: "Dealer not found." }, { status: 404 });
  if (dealer.migration_status === "migrated") {
    return NextResponse.json({ error: "Dealer is already migrated." }, { status: 409 });
  }

  const alreadyPending = dealer.migration_status === "pending";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: updErr } = await (admin as any)
    .from("dealers")
    .update({ migration_status: "pending" })
    .eq("id", dealerId);
  if (updErr) {
    if (/migration_status_chk|violates check/i.test(updErr.message)) {
      return NextResponse.json({ error: "'pending' rejected — apply migration 112." }, { status: 409 });
    }
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  // Audit log (best-effort; only when this call actually changed state).
  if (!alreadyPending) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).from("migration_log").insert({
      dealer_id: dealerId,
      event: "staged_for_migration",
      performed_by: claims.sub,
      notes: "ETL frozen (migration_status=pending) ahead of wave",
    }).then(() => {}).catch(() => {});
  }

  return NextResponse.json({ ok: true, staged: true, alreadyPending });
}
