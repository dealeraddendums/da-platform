import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { loadOrder, nudge, reassignOwner } from "@/lib/crm/feeds/orders";
import { UUID } from "@/lib/crm/feeds/http";
import { staffNames } from "@/lib/crm/queries";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * POST /api/crm/feeds/bulk { ids: [], action: nudge | reassign, owner_staff_id? }
 * Nudge picks dealer or supplier by status. Per-order results; one failure
 * doesn't stop the rest.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  const b = await req.json().catch(() => ({}));
  const ids: string[] = Array.isArray(b?.ids) ? b.ids.filter((x: unknown) => typeof x === "string" && UUID.test(x)).slice(0, 100) : [];
  if (!ids.length) return NextResponse.json({ error: "Pick some orders" }, { status: 400 });
  const admin = createAdminSupabaseClient() as any;
  if (b.action === "reassign" && b.owner_staff_id && !(await staffNames(admin))[b.owner_staff_id]) return NextResponse.json({ error: "Not a DA-CRM team member" }, { status: 400 });
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const id of ids) {
    try {
      if (b.action === "nudge") {
        const o = await loadOrder(admin, id);
        await nudge(admin, id, o.status === "awaiting_supplier" ? "supplier" : "dealer", claims.sub, true);
      } else if (b.action === "reassign") await reassignOwner(admin, id, b.owner_staff_id ?? null, claims.sub);
      else return NextResponse.json({ error: "Unknown action" }, { status: 400 });
      results.push({ id, ok: true });
    } catch (e) { results.push({ id, ok: false, error: e instanceof Error ? e.message : String(e) }); }
  }
  return NextResponse.json({ ok: results.every((r) => r.ok), results });
}
