import { createAdminSupabaseClient } from "@/lib/db";
import { listBillingTemplatesByCustomer } from "@/lib/billing";
import { computeReadiness, type ReadinessDealer, type ReadinessRow } from "@/lib/migration-readiness";

// Shared readiness loader — one source of truth for the /migration console
// (GET readiness) AND the wave-send validation. Computes per-dealer readiness
// for real, un-migrated dealers (optionally filtered to specific dealer UUIDs).
// READ-ONLY. See phase-13-self-serve-migration.md → "13b detailed".

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

async function fetchAll<T>(admin: Admin, table: string, columns: string, filter?: (q: Admin) => Admin): Promise<T[]> {
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

const DEALER_COLS =
  "id, dealer_id, name, state, group_id, account_purpose, is_test, migration_status, " +
  "subscription_billed_to, billing_customer_id, logo_url, primary_contact_email, address, city, zip, inventory_dealer_id";
const DEALER_COLS_WITH_FLAGS = DEALER_COLS + ", migration_complex, template_confirmed";

export interface ReadinessResult {
  rows: ReadinessRow[];
  flagsColumnPresent: boolean;
  billingTemplatesLoaded: number;
}

/**
 * Load + compute readiness rows. Pass `dealerIds` (dealers.id UUIDs) to scope to
 * a specific set (wave-send validation); omit for the whole un-migrated set.
 */
export async function loadReadinessRows(opts?: { dealerIds?: string[] }): Promise<ReadinessResult> {
  const admin = createAdminSupabaseClient();
  const ids = opts?.dealerIds;

  // Real, not-yet-migrated dealers (optionally a specific set). Resilient to the
  // migration_readiness flag columns (migration 100) not existing yet.
  const baseFilter = (q: Admin) => {
    let qq = q.or("migration_status.is.null,migration_status.neq.migrated").neq("is_test", true);
    if (ids && ids.length) qq = qq.in("id", ids);
    return qq;
  };
  let dealers: ReadinessDealer[];
  let flagsColumnPresent = true;
  try {
    dealers = await fetchAll<ReadinessDealer>(admin, "dealers", DEALER_COLS_WITH_FLAGS, baseFilter);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/migration_complex|template_confirmed|column/i.test(msg)) {
      flagsColumnPresent = false;
      const base = await fetchAll<Omit<ReadinessDealer, "migration_complex" | "template_confirmed">>(admin, "dealers", DEALER_COLS, baseFilter);
      dealers = base.map((d) => ({ ...d, migration_complex: false, template_confirmed: false }));
    } else {
      throw e;
    }
  }

  const groups = await fetchAll<{ id: string; name: string | null; billing_customer_id: string | null }>(admin, "groups", "id, name, billing_customer_id");
  const groupById = new Map(groups.map((g) => [g.id, g]));

  // Warning + contact signals (batched, whole-table — all small).
  const settings = await fetchAll<{ dealer_id: string | null }>(admin, "dealer_settings", "dealer_id");
  const hasSettings = new Set(settings.map((s) => s.dealer_id).filter(Boolean) as string[]);
  const options = await fetchAll<{ dealer_id: string | null }>(admin, "vehicle_options", "dealer_id");
  const hasOptions = new Set(options.map((o) => o.dealer_id).filter(Boolean) as string[]);
  const admins = await fetchAll<{ dealer_id: string | null }>(admin, "profiles", "dealer_id", (q: Admin) => q.eq("role", "dealer_admin"));
  const hasDealerAdmin = new Set(admins.map((p) => p.dealer_id).filter(Boolean) as string[]);

  const billingByCustomer = await listBillingTemplatesByCustomer();

  const now = Date.now();
  const rows = dealers.map((d) => {
    const group = d.group_id ? groupById.get(d.group_id) : undefined;
    return computeReadiness(d, {
      groupName: group?.name ?? null,
      groupBillingCustomerId: group?.billing_customer_id ?? null,
      hasSettings: hasSettings.has(d.dealer_id),
      hasOptions: hasOptions.has(d.dealer_id),
      hasDealerAdmin: hasDealerAdmin.has(d.dealer_id),
      billingByCustomer,
      now,
    });
  });
  rows.sort((a, b) => Number(b.ready) - Number(a.ready) || a.name.localeCompare(b.name));

  return { rows, flagsColumnPresent, billingTemplatesLoaded: billingByCustomer.size };
}
