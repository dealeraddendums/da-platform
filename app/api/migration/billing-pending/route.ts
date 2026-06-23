import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { billingConfigured, listBillingTemplatesByCustomer } from "@/lib/billing";

export const dynamic = "force-dynamic";

interface DealerRow {
  id: string;
  name: string;
  group_id: string | null;
  subscription_billed_to: string | null;
  billing_customer_id: string | null;
  account_type: string | null;
}

/**
 * GET /api/migration/billing-pending — super_admin only.
 *
 * Dealers who finished self-migration (migration_status = 'migrated') but whose
 * da-billing recurring template is still paused (active=false) — i.e. billing
 * was never activated (MIGRATION_AUTO_ACTIVATE was OFF when they migrated).
 * These are exactly the rows the Billing Pending tab acts on via
 * POST /api/migration/activate-billing.
 *
 * NB: the readiness query deliberately EXCLUDES migrated dealers
 * (migration_status != 'migrated'), so this tab cannot be derived from
 * readiness rows — hence its own query here.
 *
 * Returns { dealers: [{ id, name, group_name, account_type, billing_customer_id }] }.
 */
export async function GET(): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  if (!billingConfigured()) {
    return NextResponse.json(
      { error: "Billing API not configured on this server" },
      { status: 503 },
    );
  }

  const admin = createAdminSupabaseClient();

  // Migrated, non-test dealers. `is_test IS NOT TRUE` matches false OR null
  // (the repo-wide test-account convention — see lib/bi.ts).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dErr } = await (admin
    .from("dealers")
    .select("id, name, group_id, subscription_billed_to, billing_customer_id, account_type") as any)
    .eq("migration_status", "migrated")
    .not("is_test", "is", true);

  if (dErr) {
    return NextResponse.json(
      { error: `Failed to load dealers: ${dErr.message}` },
      { status: 500 },
    );
  }
  const dealers = (data ?? []) as DealerRow[];

  // Resolve the groups referenced by group-billed dealers
  // (id → { name, billing_customer_id }).
  const groupIds = Array.from(
    new Set(dealers.map((d) => d.group_id).filter((g): g is string => Boolean(g))),
  );
  const groupById = new Map<string, { name: string | null; billing_customer_id: string | null }>();
  if (groupIds.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: groups } = await (admin
      .from("groups")
      .select("id, name, billing_customer_id") as any)
      .in("id", groupIds);
    for (const g of (groups ?? []) as Array<{ id: string; name: string | null; billing_customer_id: string | null }>) {
      groupById.set(g.id, { name: g.name, billing_customer_id: g.billing_customer_id });
    }
  }

  // One bulk call → map of customerId → { active, nextInvoiceDate }.
  // Degrades to an empty map on a billing hiccup (then nothing shows as pending).
  const templates = await listBillingTemplatesByCustomer();

  const out: Array<{
    id: string;
    name: string;
    group_name: string | null;
    account_type: string | null;
    billing_customer_id: string;
  }> = [];

  for (const d of dealers) {
    const group = d.group_id ? groupById.get(d.group_id) : undefined;
    const customerId =
      d.subscription_billed_to === "group" && d.group_id
        ? group?.billing_customer_id ?? null
        : d.billing_customer_id;

    if (!customerId) continue; // no billing customer linked → not actionable here

    const tpl = templates.get(customerId);
    // Pending = a template exists AND it's paused (active === false). Dealers
    // with no template, or an already-active template, are not "billing pending".
    if (tpl?.active === false) {
      out.push({
        id: d.id,
        name: d.name,
        group_name: group?.name ?? null,
        account_type: d.account_type,
        billing_customer_id: customerId,
      });
    }
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return NextResponse.json({ dealers: out });
}
