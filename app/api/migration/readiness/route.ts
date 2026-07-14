import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { loadReadinessRows } from "@/lib/migration-readiness-data";

export const dynamic = "force-dynamic";

/**
 * GET /api/migration/readiness — Phase 13b step 1 (READ-ONLY).
 * super_admin only. Per-dealer migration readiness for real, un-migrated dealers.
 * Ready = billing-staged ∩ template-confirmed ∩ eligible (HARD gates);
 * settings/logo/inventory are non-blocking warnings (softened 2026-06-16).
 */
export async function GET(_req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  const { rows, flagsColumnPresent, billingTemplatesLoaded } = await loadReadinessRows();

  // Operators (the team that divides the tail) = ACTIVE super_admin profiles,
  // for the "Assigned to" column/filter + the assign dropdown. active=false
  // keeps retired/duplicate operator accounts out of the dropdown (the
  // admin@/allan@ duplicate-Allan split, consolidated 2026-07-13).
  const admin = createAdminSupabaseClient();
  const { data: ops } = await admin.from("profiles").select("id, full_name, email").eq("role", "super_admin").eq("active", true);
  const operators = (ops ?? []).map((o: { id: string; full_name: string | null; email: string | null }) => ({ id: o.id, name: o.full_name || o.email || o.id }));

  const summary = {
    total: rows.length,
    ready: rows.filter((r) => r.ready).length,
    eligible: rows.filter((r) => r.eligible).length,
    billingStaged: rows.filter((r) => r.billingStaged).length,
    templateConfirmed: rows.filter((r) => r.templateConfirmed).length,
    readyPool: rows.filter((r) => r.billingStaged && r.eligible).length,
    settingsMissing: rows.filter((r) => r.settingsMissing).length,
    logoMissing: rows.filter((r) => r.logoMissing).length,
    zeroInventory: rows.filter((r) => r.zeroInventory).length,
    freshbooksStopPending: rows.filter((r) => r.freshbooksStopPending).length,
    unassigned: rows.filter((r) => r.eligible && !r.assignedTo).length,
  };

  return NextResponse.json({
    rows,
    summary,
    operators,
    currentUserId: claims.sub,
    flagsColumnPresent,
    billingTemplatesLoaded,
    note: "Ready = billing-template-staged + template-confirmed + eligible (HARD gates). Settings/logo/inventory are WARNINGS only. Eligible excludes white-glove groups, flagged-complex, and dealers with no self-serve contact (operator/group-managed).",
  });
}
