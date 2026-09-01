import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import {
  countFortellisCalls,
  monthRangeUtc,
  projectMonthEnd,
  readContractedCap,
  writeContractedCap,
  type FortellisMonthCounts,
} from "@/lib/fortellis-usage";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/fortellis/usage
 * super_admin. Live month-to-date Fortellis call counts (UTC calendar month —
 * how Fortellis bills) plus the contracted vehicle-search volume and a
 * month-end projection, for the Fortellis Dealers tab's usage meter.
 *
 * Counts are cached ~1h per PM2 worker (they move slowly and the monthly
 * rollup is the number of record). The cap is read fresh on every request so
 * an edit shows up immediately.
 *
 * PUT — set or clear the contracted monthly volume. Body `{ cap: number|null }`.
 */

const CACHE_MS = 60 * 60 * 1000;
let cache: { at: number; monthKey: string; data: FortellisMonthCounts } | null = null;

export async function GET(): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const now = new Date();
  const { key, startIso, endIso } = monthRangeUtc(now, 0);

  try {
    const admin = createAdminSupabaseClient();
    const cap = await readContractedCap(admin);

    let usage: FortellisMonthCounts;
    let cached = false;
    if (cache && cache.monthKey === key && Date.now() - cache.at < CACHE_MS) {
      usage = cache.data;
      cached = true;
    } else {
      usage = await countFortellisCalls(admin, key, startIso, endIso);
      cache = { at: Date.now(), monthKey: key, data: usage };
    }

    return NextResponse.json({
      usage,
      cap,
      // null in the first 48h of a month — too little signal to extrapolate.
      projected: projectMonthEnd(usage.vehicle_search, now),
      cached,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "usage count failed" },
      { status: 500 },
    );
  }
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  let body: { cap?: unknown };
  try {
    body = (await req.json()) as { cap?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = body.cap;
  let cap: number | null;
  if (raw === null || raw === "") {
    cap = null;
  } else {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n > 100_000_000) {
      return NextResponse.json(
        { error: "cap must be a positive number of calls, or null to clear" },
        { status: 400 },
      );
    }
    cap = Math.round(n);
  }

  try {
    const admin = createAdminSupabaseClient();
    const previous = await readContractedCap(admin);
    await writeContractedCap(admin, cap);

    fireWrite(
      admin.from("admin_audit").insert({
        admin_user_id: claims.sub,
        action: "fortellis_contracted_volume_set",
        metadata: { previous, cap },
      }),
      "admin_audit",
    );

    return NextResponse.json({ cap });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "save failed" },
      { status: 500 },
    );
  }
}
