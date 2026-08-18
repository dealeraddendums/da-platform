import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import { migrateDealerRecord, type MigratableDealer } from "@/lib/migrate-dealer";

export const dynamic = "force-dynamic";
// The mandatory pre-migrate config sync runs full Aurora scans on the ETL box.
export const maxDuration = 600;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PER_CALL = 10; // sync is minutes-slow; the UI chunks bulk runs

/**
 * Self-service member-dealer migration for migrated, GROUP-BILLED
 * service-provider groups (driver: Dealer General, 2026-08-18).
 *
 * GET  /api/groups/[id]/self-migrate — gate + per-member migration status.
 * POST /api/groups/[id]/self-migrate — { dealer_ids: uuid[] } (1–10) →
 *      per dealer: mandatory final 4.0 config sync (ETL box) → flip to
 *      migrated via the canonical helper. NO per-dealer billing of any kind:
 *      no da-billing customer, no billingState change, no FreshBooks call —
 *      the group's existing DA-Billing subscription is the payer, untouched.
 *
 * Auth: super_admin (any group) or group_admin of THIS group. group_user
 * (regional managers) and out-of-group admins are 403'd server-side.
 * Gate (both verbs): groups.self_manages_migration = true (super_admin-set
 * trust toggle, migration 146) AND the group has a da-billing customer (the
 * "group is itself migrated + group-billed on DA-Billing" marker).
 */

type GroupRow = {
  id: string; name: string; active: boolean | null;
  billing_customer_id: string | null; etl_locked: boolean | null;
  self_manages_migration?: boolean | null;
};

async function authorizeAndLoadGroup(groupId: string): Promise<
  | { ok: true; claims: { sub: string; role: string }; group: GroupRow; admin: ReturnType<typeof createAdminSupabaseClient>; enabled: boolean; disabledReason: string | null }
  | { ok: false; res: NextResponse }
> {
  const { claims, error } = await requireAuth();
  if (error) return { ok: false, res: error };
  if (!UUID_RE.test(groupId)) return { ok: false, res: NextResponse.json({ error: "Invalid group id" }, { status: 400 }) };

  // group_admin only for their OWN group; group_user (regional manager) and
  // dealer roles never; super_admin always (console parity).
  const isOwnGroupAdmin = claims.role === "group_admin" && claims.group_id === groupId;
  if (claims.role !== "super_admin" && !isOwnGroupAdmin) {
    return { ok: false, res: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  const admin = createAdminSupabaseClient();
  // self_manages_migration (migration 146) fetched tolerantly — a missing
  // column reads as gate-off, never an error.
  let group: GroupRow | null = null;
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (admin as any)
      .from("groups")
      .select("id, name, active, billing_customer_id, etl_locked, self_manages_migration")
      .eq("id", groupId)
      .maybeSingle();
    if (res.error && /self_manages_migration|column/i.test(res.error.message)) {
      const fb = await admin.from("groups").select("id, name, active, billing_customer_id, etl_locked").eq("id", groupId).maybeSingle<GroupRow>();
      group = fb.data ?? null;
    } else if (res.error) {
      return { ok: false, res: NextResponse.json({ error: res.error.message }, { status: 500 }) };
    } else {
      group = (res.data as GroupRow | null);
    }
  }
  if (!group) return { ok: false, res: NextResponse.json({ error: "Group not found" }, { status: 404 }) };

  let disabledReason: string | null = null;
  if (group.self_manages_migration !== true) disabledReason = "self-service migration is not enabled for this group";
  else if (!group.billing_customer_id) disabledReason = "group has no DA-Billing customer — group billing must be live first";
  return { ok: true, claims: { sub: claims.sub, role: claims.role }, group, admin, enabled: disabledReason === null, disabledReason };
}

type MemberRow = MigratableDealer & {
  active: boolean | null; is_test: boolean | null; migration_status: string | null;
  subscription_billed_to: string | null; etl_locked: boolean | null; last_synced_at: string | null;
};
const MEMBER_COLS = "id, dealer_id, name, active, is_test, migration_status, subscription_billed_to, etl_locked, last_synced_at, inventory_dealer_id, inventory_provider, inventory_provider_is_dms, box_folder_id";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const auth = await authorizeAndLoadGroup(params.id);
  if (!auth.ok) return auth.res;
  const { admin, group, enabled, disabledReason } = auth;

  if (!enabled) return NextResponse.json({ enabled: false, reason: disabledReason });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: members, error } = await (admin as any)
    .from("dealers")
    .select("id, dealer_id, name, active, is_test, migration_status, subscription_billed_to, last_synced_at")
    .eq("group_id", group.id)
    .order("name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    enabled: true,
    group: group.name,
    dealers: (members ?? []).map((m: MemberRow) => ({
      id: m.id,
      name: m.name,
      migration_status: m.migration_status ?? "legacy",
      migrated: m.migration_status === "migrated",
      active: m.active !== false,
      // A self-billed member can't take the lightweight path (billing cutover
      // needed) — UI disables its button with this hint.
      group_billed: m.subscription_billed_to === "group",
      is_test: m.is_test === true,
    })),
  });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const auth = await authorizeAndLoadGroup(params.id);
  if (!auth.ok) return auth.res;
  const { admin, group, claims, enabled, disabledReason } = auth;
  if (!enabled) return NextResponse.json({ error: `Forbidden — ${disabledReason}` }, { status: 403 });

  let body: { dealer_ids?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const dealerIds = Array.isArray(body.dealer_ids)
    ? Array.from(new Set(body.dealer_ids.filter((x) => typeof x === "string" && UUID_RE.test(x))))
    : [];
  if (dealerIds.length === 0) return NextResponse.json({ error: "dealer_ids required" }, { status: 400 });
  if (dealerIds.length > MAX_PER_CALL) return NextResponse.json({ error: `Max ${MAX_PER_CALL} dealers per call — send in batches.` }, { status: 400 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any).from("dealers").select(MEMBER_COLS).in("id", dealerIds);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = (data ?? []) as (MemberRow & { group_id?: string | null })[];
  // Group membership re-checked from the DB row, not the request.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: memberCheck } = await (admin as any).from("dealers").select("id").eq("group_id", group.id).in("id", dealerIds);
  const inGroup = new Set(((memberCheck ?? []) as { id: string }[]).map((m) => m.id));

  type RowResult = { id: string; name: string; status: "migrated" | "skipped" | "failed"; reason?: string };
  const results: RowResult[] = [];
  const toSync: MemberRow[] = [];
  const skipSync: MemberRow[] = []; // etl_locked — config is hand-managed truth; ETL refuses them by design
  const byId = new Map(rows.map((r) => [r.id, r]));

  for (const id of dealerIds) {
    const d = byId.get(id);
    if (!d || !inGroup.has(id)) { results.push({ id, name: d?.name ?? id, status: "failed", reason: "not a member of your group" }); continue; }
    if (d.migration_status === "migrated") { results.push({ id, name: d.name, status: "skipped", reason: "already migrated" }); continue; }
    if (d.active === false) { results.push({ id, name: d.name, status: "failed", reason: "deactivated dealer" }); continue; }
    if (d.subscription_billed_to !== "group") {
      results.push({ id, name: d.name, status: "failed", reason: "self-billed dealer — needs the operator migration path (billing cutover)" });
      continue;
    }
    if (d.etl_locked === true || group.etl_locked === true) skipSync.push(d);
    else toSync.push(d);
  }

  // ── Mandatory final 4.0 config sync (one batched ETL call) ─────────────────
  // Migrating FREEZES the config sync, so the dealer's current 4.0 products/
  // settings/logo must land first. A dealer whose sync fails is NOT flipped.
  const syncedOk = new Set<string>(skipSync.map((d) => d.id));
  if (toSync.length > 0) {
    const etlUrl = process.env.ETL_SYNC_URL;
    const etlKey = process.env.ETL_SYNC_API_KEY;
    if (!etlUrl || !etlKey) {
      for (const d of toSync) results.push({ id: d.id, name: d.name, status: "failed", reason: "config sync unavailable (ETL not configured)" });
    } else {
      const invByDealer = new Map(toSync.map((d) => [(d.inventory_dealer_id ?? d.dealer_id).trim(), d]));
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 570_000);
        let res: Response;
        try {
          res = await fetch(`${etlUrl.replace(/\/$/, "")}/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-API-Key": etlKey },
            body: JSON.stringify({ dealer_inventory_ids: Array.from(invByDealer.keys()) }),
            signal: controller.signal,
          });
        } finally { clearTimeout(timer); }
        const json = (await res.json().catch(() => null)) as { dealers?: { inventory_dealer_id: string; status: string; reason?: string }[]; error?: string } | null;
        if (!res.ok || !json?.dealers) {
          const msg = json?.error ?? `ETL sync failed (HTTP ${res.status})`;
          for (const d of toSync) results.push({ id: d.id, name: d.name, status: "failed", reason: `config sync failed: ${msg}` });
        } else {
          const nowIso = new Date().toISOString();
          for (const er of json.dealers) {
            const d = invByDealer.get(er.inventory_dealer_id);
            if (!d) continue;
            if (er.status === "synced") {
              syncedOk.add(d.id);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              fireWrite((admin as any).from("dealers").update({ last_synced_at: nowIso, last_synced_by: claims.sub }).eq("id", d.id), "self-migrate last_synced stamp");
            } else {
              results.push({ id: d.id, name: d.name, status: "failed", reason: `config sync ${er.status}${er.reason ? `: ${er.reason}` : ""} — dealer NOT migrated` });
            }
          }
          // Any toSync dealer the ETL response didn't mention at all.
          for (const d of toSync) {
            if (!syncedOk.has(d.id) && !results.some((r) => r.id === d.id)) {
              results.push({ id: d.id, name: d.name, status: "failed", reason: "config sync returned no result — dealer NOT migrated" });
            }
          }
        }
      } catch (e) {
        const msg = e instanceof Error && e.name === "AbortError" ? "ETL sync timed out" : e instanceof Error ? e.message : String(e);
        for (const d of toSync) results.push({ id: d.id, name: d.name, status: "failed", reason: `config sync failed: ${msg}` });
      }
    }
  }

  // ── Flip each synced dealer (canonical shared writes; NO billing) ──────────
  const nowIso = new Date().toISOString();
  for (const d of [...toSync, ...skipSync]) {
    if (!syncedOk.has(d.id)) continue;
    const res = await migrateDealerRecord(admin, d, {
      nowIso,
      hubspotContext: `group self-service migration (${group.name}) — upgrade to Paid`,
      // is_native: migrated legacy dealer, not 5.0-native.
      // freshbooks_stopped_at: group-billed members have NO individual
      // FreshBooks recurring (the group bills at group level) — nothing to
      // stop, so the console's FB-pending cleanup queue isn't flooded with
      // 200 false pendings. The group's own FreshBooks was handled at ITS
      // migration; this path never touches FreshBooks or da-billing.
      extraPatch: { is_native: false, freshbooks_stopped_at: nowIso },
    });
    if (!res.ok) { results.push({ id: d.id, name: d.name, status: "failed", reason: res.error ?? "update failed" }); continue; }
    results.push({ id: d.id, name: d.name, status: "migrated" });
    fireWrite(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (admin as any).from("migration_log").insert({
        dealer_id: d.id,
        event: "migrated",
        performed_by: claims.sub,
        billing_customer_id: group.billing_customer_id,
        notes: `self-service migration by group admin — ${group.name} (group-billed, no per-dealer billing; plan ${res.plan}${d.etl_locked || group.etl_locked ? "; sync skipped — ETL-locked hand-managed config" : "; final 4.0 config synced"})`,
      }),
      "migration_log self-service migrated",
    );
  }

  const summary = {
    requested: dealerIds.length,
    migrated: results.filter((r) => r.status === "migrated").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
  };
  console.log(`[self-migrate] group=${group.name} by=${claims.sub} (${claims.role}) ${JSON.stringify(summary)}`);
  return NextResponse.json({ ok: true, summary, results });
}
