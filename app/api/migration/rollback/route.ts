import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { billingConfigured, deactivateTemplate } from "@/lib/billing";

export const dynamic = "force-dynamic";

/**
 * POST /api/migration/rollback — Phase 13a.3 safety net. super_admin only.
 * Reverses a self-migration: migration_status back to 'invited' (ETL resumes /
 * 5.0 no longer source-of-truth) AND pauses the da-billing template
 * (active=false) so no invoice is issued. Body: { dealerId: <dealers.id UUID> }.
 *
 * Does NOT delete the dealer's account or undo account_type — it stops the two
 * things that matter (ETL freeze + billing). Prices are never touched.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  let body: { dealerId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body.dealerId) return NextResponse.json({ error: "dealerId required" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data: dealer } = await admin
    .from("dealers")
    .select("id, dealer_id, name, group_id, subscription_billed_to, billing_customer_id, migration_status")
    .eq("id", body.dealerId)
    .maybeSingle<{ id: string; dealer_id: string; name: string; group_id: string | null; subscription_billed_to: string | null; billing_customer_id: string | null; migration_status: string | null }>();
  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  // 1. migration_status back to 'invited' (they were invited; ETL resumes).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: statusErr } = await (admin as any).from("dealers").update({ migration_status: "invited" }).eq("id", dealer.id);
  if (statusErr) return NextResponse.json({ error: statusErr.message }, { status: 500 });

  // 2. Pause the billing template (group-billed → the group's customer).
  let billing: "deactivated" | "no-customer" | "error" = "no-customer";
  let billingDetail = "";
  let customerId = dealer.billing_customer_id;
  if (dealer.subscription_billed_to === "group" && dealer.group_id) {
    const { data: g } = await admin.from("groups").select("billing_customer_id").eq("id", dealer.group_id).maybeSingle<{ billing_customer_id: string | null }>();
    customerId = g?.billing_customer_id ?? null;
  }
  if (billingConfigured() && customerId) {
    try { await deactivateTemplate(customerId); billing = "deactivated"; }
    catch (e) { billing = "error"; billingDetail = e instanceof Error ? e.message : String(e); }
  }

  return NextResponse.json({ ok: true, dealer: dealer.name, migration_status: "invited", billing, billingDetail });
}
