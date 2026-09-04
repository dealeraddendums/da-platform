import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

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

  // 5.0-native dealers are never migration candidates (created here, no 4.0
  // account to move), so they must not land in an operator's batch. Filtered
  // SERVER-side rather than in the client: "Claim group" and "Assign to…" post
  // every member id in the group with no eligibility filter of their own, so a
  // group holding natives would otherwise assign them. Unassigning
  // (assignTo === null) is always allowed — that is how natives already sitting
  // in a batch get released.
  let targetIds = dealerIds;
  let skippedNative = 0;
  if (assignTo !== null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: natives, error: natErr } = await (admin as any)
      .from("dealers")
      .select("id")
      .in("id", dealerIds)
      .eq("is_native", true);
    if (natErr) return NextResponse.json({ error: natErr.message }, { status: 500 });
    const nativeIds = new Set((natives ?? []).map((n: { id: string }) => n.id));
    if (nativeIds.size > 0) {
      targetIds = dealerIds.filter((id) => !nativeIds.has(id));
      skippedNative = nativeIds.size;
    }
    if (targetIds.length === 0) {
      return NextResponse.json({
        ok: true, assigned: 0, assignTo, skippedNative,
        note: "Nothing assigned — every dealer selected was created on 5.0 and has nothing to migrate.",
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbError } = await (admin as any)
    .from("dealers")
    .update({ migration_assigned_to: assignTo })
    .in("id", targetIds)
    .select("id");
  if (dbError) {
    if (/migration_assigned_to|column/i.test(dbError.message)) {
      return NextResponse.json({ error: "migration_assigned_to column missing — apply migration 105." }, { status: 409 });
    }
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  // NOTE (2026-07-17): claim/assign no longer auto-stages. The nightly ETL is
  // reduced to discover-and-count (nothing overwrites claimed dealers anymore),
  // and 'pending' is set by the Sync action, which is what Ready now requires.
  return NextResponse.json({ ok: true, assigned: (data ?? []).length, assignTo, ...(skippedNative ? { skippedNative } : {}) });
}
