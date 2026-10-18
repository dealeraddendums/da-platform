// GET /api/admin/vin-lookup?q={VIN or stock #}&dealer={optional dealer id/name}
// super_admin only. Read-only diagnostic — see lib/vin-lookup.ts.

import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { runVinLookup } from "@/lib/vin-lookup";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  const dealer = (req.nextUrl.searchParams.get("dealer") ?? "").trim() || null;
  if (!q) return NextResponse.json({ error: "Enter a VIN or stock #" }, { status: 400 });
  if (q.length > 40 || (dealer && dealer.length > 100)) {
    return NextResponse.json({ error: "Input too long" }, { status: 400 });
  }

  try {
    const report = await runVinLookup(q, dealer);
    return NextResponse.json(report);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[vin-lookup]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
