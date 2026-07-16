import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/migration/assign — operator assignment. super_admin only.
 * Body: { dealerIds: <dealers.id UUID>[], assignTo?: <operator UUID> | null }.
 * Sets dealers.migration_assigned_to. assignTo omitted → assign to me (claims.sub);
 * assignTo: null → unassign. Additive; doesn't touch readiness.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  let body: { dealerIds?: string[]; assignTo?: string | null };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const dealerIds = Array.isArray(body.dealerIds) ? Array.from(new Set(body.dealerIds.filter((x) => typeof x === "string"))) : [];
  if (dealerIds.length === 0) return NextResponse.json({ error: "Select at least one dealer." }, { status: 400 });

  // assignTo: undefined → me; null → unassign; UUID → that operator.
  const assignTo = body.assignTo === undefined ? claims.sub : body.assignTo;
  if (assignTo !== null && !UUID_RE.test(assignTo)) {
    return NextResponse.json({ error: "assignTo must be an operator UUID or null." }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbError } = await (admin as any)
    .from("dealers")
    .update({ migration_assigned_to: assignTo })
    .in("id", dealerIds)
    .select("id");
  if (dbError) {
    if (/migration_assigned_to|column/i.test(dbError.message)) {
      return NextResponse.json({ error: "migration_assigned_to column missing — apply migration 105." }, { status: 409 });
    }
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  // Claiming implies staging: freeze the ETL (migration_status='pending') for
  // the claimed dealers so operator hand-config isn't overwritten by the
  // nightly sync. Only dealers untouched by the migration pipeline (NULL or
  // 'legacy') are staged — pending/invited/migrating/migrated/opted_out keep
  // their status. Unassigning (assignTo: null) never stages.
  let staged = 0;
  const assignedIds = ((data ?? []) as { id: string }[]).map((d) => d.id);
  if (assignTo !== null && assignedIds.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: stagedRows, error: stageErr } = await (admin as any)
      .from("dealers")
      .update({ migration_status: "pending" })
      .in("id", assignedIds)
      .or("migration_status.is.null,migration_status.eq.legacy")
      .select("id");
    if (stageErr) {
      console.error("[migration/assign] stage-on-assign failed:", stageErr.message);
    } else {
      staged = (stagedRows ?? []).length;
      for (const r of (stagedRows ?? []) as { id: string }[]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fireWrite((admin as any).from("migration_log").insert({
          dealer_id: r.id,
          event: "staged_for_migration",
          performed_by: claims.sub,
          notes: "auto-staged on claim/assign (ETL frozen)",
        }), "migration_log staged_for_migration");
      }
    }
  }

  return NextResponse.json({ ok: true, assigned: assignedIds.length, staged, assignTo });
}
