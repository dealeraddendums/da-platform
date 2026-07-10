// GET /api/admin/bi/period-summary — fixed-window metrics grid (Today → YTD).
// super_admin only. No params: the windows are fixed relative to now.
// Semantics match buildBiReport (lib/bi.ts) — dedicated lifecycle timestamps,
// test accounts excluded.

import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { buildPeriodSummary } from "@/lib/bi";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  try {
    const summary = await buildPeriodSummary();
    return NextResponse.json(summary);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to build period summary" },
      { status: 500 },
    );
  }
}
