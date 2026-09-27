import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { loadForceQueue } from "@/lib/force-migration";

export const dynamic = "force-dynamic";

/**
 * GET /api/migration/force-queue — super_admin only.
 * The Force Migration queue: invited dealers whose day-23 mandatory final
 * notice has been sent, each with its readiness gates, live Mandrill
 * deliverability, and a verdict. READ-ONLY.
 */
export async function GET(): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  try {
    const { rows, checkedEmails } = await loadForceQueue();
    const counts = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
      return acc;
    }, {});
    return NextResponse.json({ ok: true, rows, counts, checkedEmails });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Queue failed" }, { status: 500 });
  }
}
