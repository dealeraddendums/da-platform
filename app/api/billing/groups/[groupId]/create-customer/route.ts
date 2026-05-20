import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { createCustomer, billingConfigured } from "@/lib/billing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: { groupId: string } };

interface CreateBody {
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}

/**
 * POST /api/billing/groups/[groupId]/create-customer
 *
 * Manual fallback for groups that don't yet have a billing_customer_id —
 * either because they were created before the eager-create path landed
 * or because the eager-create call to da-billing failed (failures are
 * recorded in billing_sync_errors).
 *
 * Behavior:
 *  - Reads `billing_contact`, `billing_email`, `billing_phone`,
 *    `billing_address`, `billing_city`, `billing_state`, `billing_zip`,
 *    `billing_country` from the Supabase group row as defaults.
 *  - Optional JSON body fields override the Supabase values one-for-one,
 *    so the Billing tab can pass an in-flight edit through without first
 *    saving it to the group.
 *  - Creates the da-billing customer with isGroup=true, stores the
 *    returned id in groups.billing_customer_id, and marks every prior
 *    `billing.customer.create` error row for this group as resolved.
 *  - No-ops (returns the existing id) if billing_customer_id is already set.
 */
export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error || !claims) return error ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (claims.role !== "super_admin" && !(claims.role === "group_admin" && claims.group_id === params.groupId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!billingConfigured()) return NextResponse.json({ error: "Billing not configured" }, { status: 500 });

  let body: CreateBody = {};
  try { body = (await req.json().catch(() => ({}))) as CreateBody; }
  catch { body = {}; }

  const admin = createAdminSupabaseClient();
  const { data: group } = await admin
    .from("groups")
    .select(
      "id, name, billing_customer_id, " +
      "primary_contact, primary_contact_email, " +
      "billing_contact, billing_email, billing_phone, " +
      "billing_address, billing_city, billing_state, billing_zip, billing_country, " +
      "address, city, state, zip, country"
    )
    .eq("id", params.groupId)
    .maybeSingle<{
      id: string;
      name: string;
      billing_customer_id: string | null;
      primary_contact: string | null;
      primary_contact_email: string | null;
      billing_contact: string | null;
      billing_email: string | null;
      billing_phone: string | null;
      billing_address: string | null;
      billing_city: string | null;
      billing_state: string | null;
      billing_zip: string | null;
      billing_country: string | null;
      address: string | null;
      city: string | null;
      state: string | null;
      zip: string | null;
      country: string | null;
    }>();
  if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });

  if (group.billing_customer_id) {
    return NextResponse.json({ ok: true, billing_customer_id: group.billing_customer_id, created: false });
  }

  // Resolve each field with this fallback order:
  //   1. explicit POST body (form override)
  //   2. billing_* column (canonical billing copy)
  //   3. physical address column (groups whose billing == physical, never
  //      mirrored)
  //   4. primary_contact* for name/email
  //   5. group.name / undefined
  // country also defaults to "US" as a last resort.
  const name    = body.name?.trim()    || group.billing_contact || group.primary_contact      || group.name;
  const email   = body.email?.trim()   || group.billing_email   || group.primary_contact_email || undefined;
  const phone   = body.phone?.trim()   || group.billing_phone   || undefined;
  const address = body.address?.trim() || group.billing_address || group.address || undefined;
  const city    = body.city?.trim()    || group.billing_city    || group.city    || undefined;
  const stateF  = body.state?.trim()   || group.billing_state   || group.state   || undefined;
  const zip     = body.zip?.trim()     || group.billing_zip     || group.zip     || undefined;
  const country = body.country?.trim() || group.billing_country || group.country || "US";

  try {
    const created = await createCustomer({
      name,
      company: group.name,
      email,
      phone,
      address,
      state: stateF,
      isGroup: true,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: updateErr } = await (admin as any)
      .from("groups")
      .update({
        billing_customer_id: created.id,
        // Backfill the Supabase billing_* columns from whatever the user
        // supplied so future edits start from the same source of truth.
        ...(body.name    !== undefined ? { billing_contact: name } : {}),
        ...(body.email   !== undefined ? { billing_email: email } : {}),
        ...(body.phone   !== undefined ? { billing_phone: phone } : {}),
        ...(body.address !== undefined ? { billing_address: address } : {}),
        ...(body.city    !== undefined ? { billing_city: city } : {}),
        ...(body.state   !== undefined ? { billing_state: stateF } : {}),
        ...(body.zip     !== undefined ? { billing_zip: zip } : {}),
        ...(body.country !== undefined ? { billing_country: country } : {}),
      })
      .eq("id", group.id);
    if (updateErr) {
      return NextResponse.json(
        { error: `Customer created (${created.id}) but Supabase update failed: ${updateErr.message}` },
        { status: 500 },
      );
    }

    // Clear any prior failure rows for this group so the dashboard reflects
    // the recovered state. Best-effort — log and continue if it fails.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any)
        .from("billing_sync_errors")
        .update({ resolved: true, last_retry_at: new Date().toISOString() })
        .eq("group_id", group.id)
        .eq("event_type", "billing.customer.create")
        .eq("resolved", false);
    } catch (resolveErr) {
      console.warn("[create-customer] failed to mark prior errors resolved:", resolveErr instanceof Error ? resolveErr.message : resolveErr);
    }

    return NextResponse.json({ ok: true, billing_customer_id: created.id, created: true });
  } catch (err) {
    // Persist the failure so the dashboard surfaces it — same shape as
    // the eager fireAndForget path.
    const message = err instanceof Error ? err.message : String(err);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any).from("billing_sync_errors").insert({
        event_type: "billing.customer.create",
        payload: { groupName: group.name, name, email, phone, address, city, stateF, zip, country },
        error_message: message,
        group_id: group.id,
      });
    } catch (logErr) {
      console.error("[create-customer] failed to log error:", logErr instanceof Error ? logErr.message : logErr);
    }
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
