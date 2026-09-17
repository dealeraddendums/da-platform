// GET /api/admin/trial-signups/pending-count
//
// Feeds the admin topbar badge. super_admin only — the same gate as
// /admin/trial-signups, because a role that cannot act on the queue should not
// be nagged by a count of it.
//
// Counts only, never rows. Cached in lib/pending-signups (45s) so a topbar
// polling every 60s across several open admin tabs costs one DB head-count and
// one marketing call per window, not one per tab.

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import {
  getPendingSignupCounts, getCachedPendingCounts, setCachedPendingCounts,
} from "@/lib/pending-signups";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ?fresh=1 skips the cache READ (it still refreshes it).
  //
  // The cache is per-PM2-worker and there are two workers, so a route that
  // invalidates after an approve/deny/dismiss only clears the worker that
  // happened to serve that POST — the badge's next poll can land on the other
  // one and redisplay a stale count for up to the TTL. Observed live: a
  // dismissal dropped the real total 5 -> 4 while the badge kept showing 5.
  // The deliberate post-action refresh therefore bypasses the cache; the
  // background 60s poll still uses it, which is what keeps the cost down.
  const fresh = req.nextUrl.searchParams.get("fresh") === "1";
  const cached = fresh ? null : getCachedPendingCounts();
  if (cached) return NextResponse.json({ ...cached, cached: true });

  const value = await getPendingSignupCounts();
  setCachedPendingCounts(value);
  return NextResponse.json({ ...value, cached: false });
}
