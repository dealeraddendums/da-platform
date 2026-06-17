import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/migration/waves — Phase 13b step 3 wave summaries. super_admin only.
 * Groups migration invitations by wave_id and counts, per wave, how many of
 * those dealers have since migrated (migration_status='migrated') vs are still
 * pending. Read-only; derived from invitations.wave_id + dealers.migration_status.
 */
export async function GET(_req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  // Migration invitations that carry a wave_id (resilient if migration 103 absent).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = admin as any;
  let res = await a.from("invitations").select("dealer_id, created_at, wave_id").eq("purpose", "migration").not("wave_id", "is", null);
  if (res.error && /wave_id|column/i.test(res.error.message ?? "")) {
    return NextResponse.json({ waves: [], note: "wave_id column not applied yet (migration 103)." });
  }
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
  const invites = (res.data ?? []) as { dealer_id: string | null; created_at: string | null; wave_id: string | null }[];

  const dealerIds = Array.from(new Set(invites.map((i) => i.dealer_id).filter(Boolean) as string[]));
  const migrated = new Set<string>();
  if (dealerIds.length) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (admin as any).from("dealers").select("id, migration_status").in("id", dealerIds);
    ((data ?? []) as { id: string; migration_status: string | null }[]).forEach((d) => { if (d.migration_status === "migrated") migrated.add(d.id); });
  }

  const byWave = new Map<string, { waveId: string; sentAt: string | null; sent: number; migrated: number }>();
  for (const iv of invites) {
    const w = iv.wave_id!;
    const cur = byWave.get(w) ?? { waveId: w, sentAt: iv.created_at, sent: 0, migrated: 0 };
    cur.sent += 1;
    if (iv.dealer_id && migrated.has(iv.dealer_id)) cur.migrated += 1;
    if (iv.created_at && (!cur.sentAt || iv.created_at < cur.sentAt)) cur.sentAt = iv.created_at;
    byWave.set(w, cur);
  }
  const waves = Array.from(byWave.values())
    .map((w) => ({ ...w, pending: w.sent - w.migrated }))
    .sort((a2, b2) => (b2.sentAt ?? "").localeCompare(a2.sentAt ?? ""))
    .slice(0, 20);

  return NextResponse.json({ waves });
}
