// POST /api/admin/trial-signups/dismiss-lead  { id?, email? }
//
// Retire a stuck trial lead that shouldn't be in the follow-up queue — a
// duplicate of a dealer we already have, an internal test, junk. Without this
// the queue could only grow, which kept the topbar count inflated and buried
// the real prospects.
//
// SOFT and recoverable, matching the platform's archive-don't-delete ethos
// (lib/hubspot archiveObject, lib/box deleteFolderIfEmpty): marketing flags the
// lead 'dismissed' and clears its confirmation token; the row is kept whole.
// super_admin only, the same gate as the queue itself.

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import { dismissStuckLead, invalidatePendingCounts } from "@/lib/pending-signups";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { id?: string; email?: string } | null;
  const id = body?.id?.trim();
  const email = body?.email?.trim();
  if (!id && !email) return NextResponse.json({ error: "id or email required" }, { status: 400 });

  const result = await dismissStuckLead({ id, email, actor: claims.email ?? claims.sub });

  // The lead row carries no dismissed_by/dismissed_at, so this IS the record of
  // who retired it and when. Written for every attempt, including failures.
  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fireWrite((admin as any).from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: "lead_dismissed",
    metadata: { lead_id: id ?? null, email: email ?? null, outcome: result.outcome },
  }), "admin_audit");

  // It has left the pending set — drop the cached count so the badge reflects it.
  invalidatePendingCounts();

  return NextResponse.json(result);
}
