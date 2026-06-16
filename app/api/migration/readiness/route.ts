import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { listBillingTemplatesByCustomer } from "@/lib/billing";
import { computeReadiness, type ReadinessDealer } from "@/lib/migration-readiness";

export const dynamic = "force-dynamic";

// Fetch every row of a table/column set, paging past PostgREST's 1000-row cap.
// `admin` is cast to any — this is a generic helper over arbitrary table names,
// which the typed client's literal-relation overloads reject.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAll<T>(admin: any, table: string, columns: string, filter?: (q: any) => any): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: T[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    let q = admin.from(table).select(columns).range(from, from + page - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...((data as T[]) ?? []));
    if (!data || data.length < page) break;
  }
  return out;
}

/**
 * GET /api/migration/readiness — Phase 13b step 1 (READ-ONLY).
 * super_admin only. Computes per-dealer migration readiness for real,
 * un-migrated dealers. No writes.
 */
export async function GET(_req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  const DEALER_COLS =
    "id, dealer_id, name, state, group_id, account_purpose, is_test, migration_status, " +
    "subscription_billed_to, billing_customer_id, logo_url, address, city, zip, inventory_dealer_id";
  const DEALER_COLS_WITH_FLAGS = DEALER_COLS + ", migration_complex, template_confirmed";

  // Real, not-yet-migrated dealers. Try with the migration_readiness flag columns
  // (migration 100); if they don't exist yet, fall back and default them false so
  // the console still renders pre-migration.
  const notMigrated = (q: any) => q.or("migration_status.is.null,migration_status.neq.migrated").neq("is_test", true); // eslint-disable-line @typescript-eslint/no-explicit-any
  let dealers: ReadinessDealer[];
  let flagsColumnPresent = true;
  try {
    dealers = await fetchAll<ReadinessDealer>(admin, "dealers", DEALER_COLS_WITH_FLAGS, notMigrated);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/migration_complex|template_confirmed|column/i.test(msg)) {
      flagsColumnPresent = false;
      const base = await fetchAll<Omit<ReadinessDealer, "migration_complex" | "template_confirmed">>(admin, "dealers", DEALER_COLS, notMigrated);
      dealers = base.map((d) => ({ ...d, migration_complex: false, template_confirmed: false }));
    } else {
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  // Groups: id → { name, billing_customer_id }.
  const groups = await fetchAll<{ id: string; name: string | null; billing_customer_id: string | null }>(
    admin, "groups", "id, name, billing_customer_id",
  );
  const groupById = new Map(groups.map((g) => [g.id, g]));

  // Warning signals (batched, whole-table — both small): which dealers have a
  // settings row, and which have synced products (vehicle_options ~12k rows).
  // dealer_vehicles (~1.6M) is NOT scanned — vehicle_options presence is the
  // cheap, meaningful "is this dealer set up" inventory signal.
  const settings = await fetchAll<{ dealer_id: string | null }>(admin, "dealer_settings", "dealer_id");
  const hasSettings = new Set(settings.map((s) => s.dealer_id).filter(Boolean) as string[]);
  const options = await fetchAll<{ dealer_id: string | null }>(admin, "vehicle_options", "dealer_id");
  const hasOptions = new Set(options.map((o) => o.dealer_id).filter(Boolean) as string[]);

  // Billing templates (bulk, one call) → customerId → { active, nextInvoiceDate }.
  const billingByCustomer = await listBillingTemplatesByCustomer();

  const now = Date.now();
  const rows = dealers.map((d) => {
    const group = d.group_id ? groupById.get(d.group_id) : undefined;
    return computeReadiness(d, {
      groupName: group?.name ?? null,
      groupBillingCustomerId: group?.billing_customer_id ?? null,
      hasSettings: hasSettings.has(d.dealer_id),
      hasOptions: hasOptions.has(d.dealer_id),
      billingByCustomer,
      now,
    });
  });

  rows.sort((a, b) => Number(b.ready) - Number(a.ready) || a.name.localeCompare(b.name));

  const summary = {
    total: rows.length,
    ready: rows.filter((r) => r.ready).length,
    eligible: rows.filter((r) => r.eligible).length,
    billingStaged: rows.filter((r) => r.billingStaged).length,
    templateConfirmed: rows.filter((r) => r.templateConfirmed).length,
    // "one toggle from ready" pool = billing-staged ∩ eligible (these flip to
    // Ready the moment template-confirmed is toggled; the already-confirmed
    // subset is `ready`).
    readyPool: rows.filter((r) => r.billingStaged && r.eligible).length,
    // warnings (informational — do not gate)
    settingsMissing: rows.filter((r) => r.settingsMissing).length,
    logoMissing: rows.filter((r) => r.logoMissing).length,
    zeroInventory: rows.filter((r) => r.zeroInventory).length,
  };

  return NextResponse.json({
    rows,
    summary,
    flagsColumnPresent, // false until migration 100 is applied (toggle disabled in the UI)
    billingTemplatesLoaded: billingByCustomer.size,
    note: "Ready = billing-template-staged + template-confirmed + eligible (HARD gates). Settings/logo/inventory are WARNINGS only — the migration creates a default settings row, a logo is addable later, and inventory syncs nightly. Inventory signal = synced products (vehicle_options); the 1.6M-row dealer_vehicles table is not scanned.",
  });
}
