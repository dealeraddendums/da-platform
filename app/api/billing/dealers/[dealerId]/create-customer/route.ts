import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { createCustomer, customerExists, searchCustomers, billingConfigured } from "@/lib/billing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: { dealerId: string } };

/**
 * POST /api/billing/dealers/[dealerId]/create-customer
 *
 * Manual fallback for dealers that don't yet have a billing_customer_id
 * — usually because the eager-create at dealer-create time was skipped
 * (legacy_id set) or failed. Reads contact + address fields from the
 * dealer row, creates a da-billing customer with isGroup=false, and
 * stores the returned id in dealers.billing_customer_id.
 *
 * No-ops (returns the existing id) if billing_customer_id is already set.
 * Super admin only.
 */
export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  if (!billingConfigured()) return NextResponse.json({ error: "Billing not configured" }, { status: 500 });

  let body: { linkCustomerId?: string; forceCreate?: boolean } = {};
  try { body = (await req.json().catch(() => ({}))) as typeof body; } catch { body = {}; }

  const admin = createAdminSupabaseClient();
  const { data: dealer } = await admin
    .from("dealers")
    .select(
      "id, name, billing_customer_id, billing_id, primary_contact, primary_contact_email, " +
      "phone, address, city, state, zip, country"
    )
    .eq("id", params.dealerId)
    .maybeSingle<{
      id: string;
      name: string;
      billing_customer_id: string | null;
      billing_id: string | null;
      primary_contact: string | null;
      primary_contact_email: string | null;
      phone: string | null;
      address: string | null;
      city: string | null;
      state: string | null;
      zip: string | null;
      country: string | null;
    }>();
  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  if (dealer.billing_customer_id) {
    return NextResponse.json({ ok: true, billing_customer_id: dealer.billing_customer_id, created: false });
  }

  // Link-don't-duplicate: a migrated dealer already carries its da-billing customer
  // UUID in billing_id. If it still resolves, LINK it instead of creating a dup.
  if (dealer.billing_id && (await customerExists(dealer.billing_id))) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: linkErr } = await (admin as any)
      .from("dealers").update({ billing_customer_id: dealer.billing_id }).eq("id", dealer.id);
    if (linkErr) return NextResponse.json({ error: `Link failed: ${linkErr.message}` }, { status: 500 });
    return NextResponse.json({ ok: true, billing_customer_id: dealer.billing_id, created: false, linked: true });
  }

  // Operator confirmed a soft-match candidate → link it (after verifying it exists).
  if (body.linkCustomerId) {
    if (!(await customerExists(body.linkCustomerId))) {
      return NextResponse.json({ error: "linkCustomerId not found in da-billing" }, { status: 400 });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: linkErr } = await (admin as any)
      .from("dealers").update({ billing_customer_id: body.linkCustomerId }).eq("id", dealer.id);
    if (linkErr) return NextResponse.json({ error: `Link failed: ${linkErr.message}` }, { status: 500 });
    return NextResponse.json({ ok: true, billing_customer_id: body.linkCustomerId, created: false, linked: true });
  }

  // Soft-match guard: no exact billing_id link. If an active da-billing customer
  // matches this dealer's email, BLOCK auto-create and surface candidates for
  // review (email/company is collision-prone — never auto-linked). The operator
  // links one via linkCustomerId or overrides with forceCreate.
  const searchEmail = (dealer.primary_contact_email ?? "").trim();
  if (!body.forceCreate && searchEmail) {
    const candidates = (await searchCustomers(searchEmail)).filter((c) => c.id);
    if (candidates.length > 0) {
      return NextResponse.json({
        error: "possible_existing_customer",
        message: `Found ${candidates.length} active da-billing customer(s) matching "${searchEmail}". Confirm one to link (linkCustomerId) or pass forceCreate to make a new customer.`,
        candidates: candidates.slice(0, 10).map((c) => ({ id: c.id, company: c.company ?? c.name ?? null, email: c.email ?? null })),
      }, { status: 409 });
    }
  }

  try {
    const created = await createCustomer({
      name: dealer.primary_contact ?? dealer.name,
      company: dealer.name,
      email: dealer.primary_contact_email ?? undefined,
      phone: dealer.phone ?? undefined,
      address: dealer.address ?? undefined,
      state: dealer.state ?? undefined,
      isGroup: false,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: updateErr } = await (admin as any)
      .from("dealers")
      .update({ billing_customer_id: created.id })
      .eq("id", dealer.id);
    if (updateErr) {
      return NextResponse.json(
        { error: `Customer created (${created.id}) but Supabase update failed: ${updateErr.message}` },
        { status: 500 },
      );
    }

    // Clear any prior unresolved create-customer error rows for this
    // dealer so the retry dashboard reflects the recovered state.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any)
        .from("billing_sync_errors")
        .update({ resolved: true, last_retry_at: new Date().toISOString() })
        .eq("dealer_id", dealer.id)
        .eq("event_type", "billing.customer.create")
        .eq("resolved", false);
    } catch (resolveErr) {
      console.warn("[dealer create-customer] mark resolved failed:", resolveErr instanceof Error ? resolveErr.message : resolveErr);
    }

    return NextResponse.json({ ok: true, billing_customer_id: created.id, created: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any).from("billing_sync_errors").insert({
        event_type: "billing.customer.create",
        payload: { dealerName: dealer.name, dealerId: dealer.id },
        error_message: message,
        dealer_id: dealer.id,
      });
    } catch (logErr) {
      console.error("[dealer create-customer] failed to log error:", logErr instanceof Error ? logErr.message : logErr);
    }
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
