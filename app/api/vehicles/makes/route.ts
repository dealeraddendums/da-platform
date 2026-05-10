import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

/**
 * GET /api/vehicles/makes
 * Returns approved NHTSA makes alphabetically. Used by the rules dropdowns
 * in the Add/Edit Product modal — any authenticated user can read. The
 * approved flag is set in migration 054; nhtsa_makes still carries the full
 * 12K-row catalog for VIN-decode lookups, but only ~50 retail manufacturers
 * surface here. The modal's "Enter Make" free-text fallback handles
 * anything not on the approved list.
 *
 * Falls back to the unfiltered list if the `approved` column doesn't exist
 * yet (i.e. migration 054 hasn't been applied) — the dropdown stays
 * functional with the full catalog until the column lands and tightens it.
 */
export async function GET(_req: NextRequest): Promise<NextResponse> {
  const { error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  const filtered = await admin
    .from("nhtsa_makes")
    .select("id, name")
    .eq("approved", true)
    .order("name", { ascending: true });

  if (!filtered.error) {
    return NextResponse.json({ data: filtered.data ?? [] });
  }

  // Column missing → run unfiltered until migration 054 is applied.
  const fallback = await admin
    .from("nhtsa_makes")
    .select("id, name")
    .order("name", { ascending: true });

  if (fallback.error) {
    return NextResponse.json({ error: fallback.error.message }, { status: 500 });
  }
  return NextResponse.json({ data: fallback.data ?? [], unfiltered: true });
}
