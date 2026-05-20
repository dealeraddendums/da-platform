import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import {
  getCustomer,
  updateCustomer,
  listInvoices,
  billingConfigured,
  type BillingCustomerDetail,
  type BillingCustomerUpdate,
  type BillingInvoice,
} from "@/lib/billing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: { groupId: string } };

/**
 * Auth: super_admin sees any group; group_admin sees their own group only.
 */
async function authorize(groupId: string): Promise<
  | { ok: true }
  | { ok: false; res: NextResponse }
> {
  const { claims, error } = await requireAuth();
  if (error || !claims) return { ok: false, res: error ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (claims.role === "super_admin") return { ok: true };
  if (claims.role === "group_admin" && claims.group_id === groupId) return { ok: true };
  return { ok: false, res: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
}

async function loadGroup(groupId: string): Promise<
  | { id: string; name: string; billing_customer_id: string | null }
  | null
> {
  const admin = createAdminSupabaseClient();
  const { data } = await admin
    .from("groups")
    .select("id, name, billing_customer_id")
    .eq("id", groupId)
    .maybeSingle<{ id: string; name: string; billing_customer_id: string | null }>();
  return data ?? null;
}

interface GetResponse {
  group: { id: string; name: string; billing_customer_id: string | null };
  customer: BillingCustomerDetail | null;
  invoices: BillingInvoice[];
  outstandingAmount: number;
}

/**
 * GET /api/billing/groups/[groupId]
 * Returns the group's billing customer + invoice list, or { customer: null }
 * if the group has no billing_customer_id yet (e.g. created before the
 * eager-create path was wired).
 */
export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const auth = await authorize(params.groupId);
  if (!auth.ok) return auth.res;
  if (!billingConfigured()) return NextResponse.json({ error: "Billing not configured" }, { status: 500 });

  const group = await loadGroup(params.groupId);
  if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });

  if (!group.billing_customer_id) {
    const payload: GetResponse = { group, customer: null, invoices: [], outstandingAmount: 0 };
    return NextResponse.json(payload);
  }

  try {
    const [customer, invoiceResult] = await Promise.all([
      getCustomer(group.billing_customer_id),
      listInvoices(group.billing_customer_id),
    ]);
    const payload: GetResponse = {
      group,
      customer,
      invoices: invoiceResult.invoices,
      outstandingAmount: invoiceResult.outstandingAmount,
    };
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

/**
 * PUT /api/billing/groups/[groupId]
 * Updates billing contact fields on da-billing AND mirrors the relevant
 * columns into the Supabase `groups` table. Allowed fields:
 *   name (contact), email, phone, address, city, state, zip, country
 *
 * Note: the da-billing customer "company" field is treated as the group
 * name and is not editable here — to rename a group, use PATCH /api/groups/[id].
 */
export async function PUT(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const auth = await authorize(params.groupId);
  if (!auth.ok) return auth.res;
  if (!billingConfigured()) return NextResponse.json({ error: "Billing not configured" }, { status: 500 });

  const group = await loadGroup(params.groupId);
  if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });
  if (!group.billing_customer_id) {
    return NextResponse.json(
      { error: "Group has no billing customer — create one first via POST /api/billing/groups/[groupId]/create-customer" },
      { status: 409 },
    );
  }

  let body: BillingCustomerUpdate;
  try { body = await req.json() as BillingCustomerUpdate; }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  // Strip undefined/empty so partial updates don't blank fields out
  // accidentally.
  const fields: BillingCustomerUpdate = {};
  for (const k of ["name", "email", "phone", "address", "city", "state", "zip", "country"] as const) {
    if (body[k] !== undefined) fields[k] = body[k];
  }

  let updated: BillingCustomerDetail;
  try {
    updated = await updateCustomer(group.billing_customer_id, fields);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  // Mirror into Supabase `groups` columns (best-effort — the columns are
  // platform-side display copies, da-billing remains the source of truth).
  const admin = createAdminSupabaseClient();
  // Mirror to the platform's `groups` columns. The schema splits contact
  // and billing fields:
  //   contact name  → primary_contact
  //   contact email → both primary_contact_email and billing_email
  //   phone/address/city/state/zip/country live under billing_*
  const mirror: Record<string, unknown> = {};
  if (fields.name !== undefined) {
    mirror.primary_contact = fields.name;
    mirror.billing_contact = fields.name;
  }
  if (fields.email !== undefined) {
    mirror.primary_contact_email = fields.email;
    mirror.billing_email         = fields.email;
  }
  if (fields.phone !== undefined)   mirror.billing_phone   = fields.phone;
  if (fields.address !== undefined) mirror.billing_address = fields.address;
  if (fields.city !== undefined)    mirror.billing_city    = fields.city;
  if (fields.state !== undefined)   mirror.billing_state   = fields.state;
  if (fields.zip !== undefined)     mirror.billing_zip     = fields.zip;
  if (fields.country !== undefined) mirror.billing_country = fields.country;
  if (Object.keys(mirror).length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: mirrorErr } = await (admin as any)
      .from("groups")
      .update(mirror)
      .eq("id", group.id);
    if (mirrorErr) {
      // Da-billing already accepted the update — log and continue so the
      // caller doesn't see a partial-failure error.
      console.warn("[billing/groups PUT] supabase mirror failed:", mirrorErr.message);
    }
  }

  return NextResponse.json({ ok: true, customer: updated });
}
