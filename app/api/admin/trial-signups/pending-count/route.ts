// GET /api/admin/trial-signups/pending-count
//
// Feeds the admin topbar badge. super_admin only — the same gate as
// /admin/trial-signups, because a role that cannot act on the queue should not
// be nagged by a count of it.
//
// Counts only, never rows. Cached in lib/pending-signups (45s) so a topbar
// polling every 60s across several open admin tabs costs one DB head-count and
// one marketing call per window, not one per tab.

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import {
  getPendingSignupCounts, getCachedPendingCounts, setCachedPendingCounts,
} from "@/lib/pending-signups";

export async function GET(): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cached = getCachedPendingCounts();
  if (cached) return NextResponse.json({ ...cached, cached: true });

  const value = await getPendingSignupCounts();
  setCachedPendingCounts(value);
  return NextResponse.json({ ...value, cached: false });
}
