import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { loadReadinessRows } from "@/lib/migration-readiness-data";

export const dynamic = "force-dynamic";

const DEFAULT_BATCH = 25;

/**
 * POST /api/migration/claim-next — grab the next batch of UNASSIGNED eligible
 * dealers for me. super_admin only. Body: { count?: number } (default 25).
 *
 * Prioritizes the one-toggle-from-ready set (billing-staged ∩ eligible) so the
 * first batches need only template-confirm + invite. Overlap-safe: the claiming
 * UPDATE is guarded by `migration_assigned_to IS NULL`, so two operators
 * claiming at once never get the same dealer (the loser simply claims fewer).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  let body: { count?: number };
  try { body = await req.json(); } catch { body = {}; }
  const count = typeof body.count === "number" && body.count > 0 ? Math.min(Math.floor(body.count), 100) : DEFAULT_BATCH;

  const { rows } = await loadReadinessRows();
  // Eligible + unassigned, one-toggle-from-ready (billing-staged) first.
  const candidates = rows
    .filter((r) => r.eligible && !r.assignedTo && r.inviteStatus !== "migrated")
    .sort((a, b) => Number(b.billingStaged) - Number(a.billingStaged) || a.name.localeCompare(b.name))
    .map((r) => r.id);
  if (candidates.length === 0) return NextResponse.json({ ok: true, claimed: 0, ids: [], note: "No unassigned eligible dealers left to claim." });

  const wanted = candidates.slice(0, count);
  const admin = createAdminSupabaseClient();
  // Guarded claim: only rows still unassigned become mine (no overlap).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbError } = await (admin as any)
    .from("dealers")
    .update({ migration_assigned_to: claims.sub })
    .in("id", wanted)
    .is("migration_assigned_to", null)
    .select("id");
  if (dbError) {
    if (/migration_assigned_to|column/i.test(dbError.message)) {
      return NextResponse.json({ error: "migration_assigned_to column missing — apply migration 105." }, { status: 409 });
    }
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }
  const ids = (data ?? []).map((d: { id: string }) => d.id);
  return NextResponse.json({ ok: true, claimed: ids.length, requested: count, ids });
}
