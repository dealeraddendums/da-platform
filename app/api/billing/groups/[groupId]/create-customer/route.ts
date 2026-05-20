import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { createCustomer, billingConfigured } from "@/lib/billing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: { groupId: string } };

/**
 * POST /api/billing/groups/[groupId]/create-customer
 *
 * Manual fallback for groups that were created before the eager-create
 * path landed in /api/groups POST. Creates a da-billing customer with
 * isGroup=true, stores the returned id in groups.billing_customer_id, and
 * returns the customer record.
 *
 * No-op (returns the existing customer id) if billing_customer_id is
 * already set.
 */
export async function POST(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error || !claims) return error ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (claims.role !== "super_admin" && !(claims.role === "group_admin" && claims.group_id === params.groupId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!billingConfigured()) return NextResponse.json({ error: "Billing not configured" }, { status: 500 });

  const admin = createAdminSupabaseClient();
  const { data: group } = await admin
    .from("groups")
    .select("id, name, billing_customer_id, primary_contact, primary_contact_email, billing_email, billing_phone, billing_address, billing_state")
    .eq("id", params.groupId)
    .maybeSingle<{
      id: string;
      name: string;
      billing_customer_id: string | null;
      primary_contact: string | null;
      primary_contact_email: string | null;
      billing_email: string | null;
      billing_phone: string | null;
      billing_address: string | null;
      billing_state: string | null;
    }>();
  if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });

  if (group.billing_customer_id) {
    return NextResponse.json({ ok: true, billing_customer_id: group.billing_customer_id, created: false });
  }

  try {
    const created = await createCustomer({
      name: group.primary_contact ?? group.name,
      company: group.name,
      email: group.billing_email ?? group.primary_contact_email ?? undefined,
      phone: group.billing_phone ?? undefined,
      address: group.billing_address ?? undefined,
      state: group.billing_state ?? undefined,
      isGroup: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: updateErr } = await (admin as any)
      .from("groups")
      .update({ billing_customer_id: created.id })
      .eq("id", group.id);
    if (updateErr) {
      return NextResponse.json(
        { error: `Customer created (${created.id}) but Supabase update failed: ${updateErr.message}` },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true, billing_customer_id: created.id, created: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
