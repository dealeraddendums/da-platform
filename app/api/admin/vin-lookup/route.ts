// GET /api/admin/vin-lookup
//   ?q={VIN or stock #}&dealer={optional dealer id/name}   → per-vehicle report
//   ?dealer={dealer id/name}            (q empty)          → DEALER MODE:
//        feed status + a paged, searchable inventory list.
//        &page= &inv_q= &include_inactive=1 page/filter that list;
//        &inv_only=1 returns just the inventory slice (cheap paging — skips
//        recomputing feed status and the verdict).
// super_admin only. Read-only diagnostic — see lib/vin-lookup.ts.

import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { runVinLookup, runDealerLookup, fetchDealerInventory } from "@/lib/vin-lookup";
import { createAdminSupabaseClient } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const sp = req.nextUrl.searchParams;
  const q = (sp.get("q") ?? "").trim();
  const dealer = (sp.get("dealer") ?? "").trim() || null;

  if (q.length > 40 || (dealer && dealer.length > 100)) {
    return NextResponse.json({ error: "Input too long" }, { status: 400 });
  }

  // ── Dealer mode: dealer given, no VIN/stock ──────────────────────────────
  if (!q) {
    if (!dealer) {
      return NextResponse.json({ error: "Enter a VIN or stock #, or a dealer on its own" }, { status: 400 });
    }
    const page = Math.max(0, Number(sp.get("page") ?? 0) || 0);
    const search = (sp.get("inv_q") ?? "").trim() || null;
    const includeInactive = sp.get("include_inactive") === "1";
    if (search && search.length > 60) {
      return NextResponse.json({ error: "Search too long" }, { status: 400 });
    }

    try {
      // Paging/filtering an already-resolved dealer: return only the slice.
      const invOnlyFor = (sp.get("inv_only") ?? "").trim();
      if (invOnlyFor) {
        const db = createAdminSupabaseClient();
        const slice = await fetchDealerInventory(db, invOnlyFor, { page, search, includeInactive });
        return NextResponse.json({ mode: "inventory", ...slice, include_inactive: includeInactive, search });
      }
      return NextResponse.json(await runDealerLookup(dealer, { page, search, includeInactive }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[vin-lookup:dealer]", msg);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  // ── Per-vehicle report (unchanged) ───────────────────────────────────────
  try {
    const report = await runVinLookup(q, dealer);
    return NextResponse.json(report);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[vin-lookup]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
