import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { fortellisConfigured } from "@/lib/fortellis-api";
import { createAdminSupabaseClient } from "@/lib/db";
import {
  fullSyncDealer, DealerSyncError, markHealthy, markDown, notify401Dealers, isOutageSyncType,
  type FortellisDealerRow, type SyncErrorType,
} from "@/lib/fortellis-sync";

const STATUS_KEY = "fortellis_sync_status";
const EXCLUSION_RE = /(test|allan)/i;

interface FleetError { subscription_id: string; dealer_name: string; error: string; error_type: string; }
interface FleetStatus {
  status: "running" | "completed" | "failed";
  started_at: string;
  completed_at?: string | null;
  total_dealers: number;
  completed: number;
  failed: number;
  current_dealer?: string | null;
  total_vehicles_imported: number;
  total_vehicles_updated: number;
  total_vehicles_sold: number;
  errors: FleetError[];
}

/**
 * POST /api/admin/fortellis/full-sync
 *  - Body { id }        → synchronous full-sync reconcile for ONE dealer (Full Sync button).
 *  - Body { fleet:true} → kicks off a background reconcile across all enabled dealers
 *                         (excluding test/allan). Returns immediately; poll the status route.
 * super_admin only.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  if (!fortellisConfigured()) {
    return NextResponse.json({ error: "Fortellis credentials not configured" }, { status: 500 });
  }

  let body: { id?: number; fleet?: boolean };
  try { body = await req.json(); } catch { body = {}; }

  const admin = createAdminSupabaseClient();

  // ── Single dealer ──────────────────────────────────────────────────────────
  if (body.id != null) {
    const id = Number(body.id);
    if (!Number.isFinite(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: row } = await (admin as any).from("fortellis_dealers").select("*").eq("id", id).maybeSingle();
    if (!row) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });
    try {
      const r = await fullSyncDealer(admin, row as FortellisDealerRow);
      await markHealthy(admin).catch(() => {});
      return NextResponse.json({ success: true, vehicles_found: r.found, vehicles_imported: r.imported, vehicles_updated: r.updated, vehicles_sold: r.sold, vehicles_skipped: r.skipped });
    } catch (err) {
      const tagged = err instanceof DealerSyncError ? err : new DealerSyncError("other", err instanceof Error ? err.message : String(err));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any).from("fortellis_dealers").update({ last_status: tagged.message.slice(0, 300) }).eq("id", id);
      if (isOutageSyncType(tagged.type)) await markDown(admin, tagged.message).catch(() => {});
      return NextResponse.json({ success: false, error: tagged.message, error_type: tagged.type }, { status: 200 });
    }
  }

  // ── Fleet ──────────────────────────────────────────────────────────────────
  // Refuse to start a second job while one is running.
  const { data: existing } = await admin.from("admin_settings").select("value").eq("key", STATUS_KEY).maybeSingle<{ value: string }>();
  if (existing?.value) {
    try {
      const parsed = JSON.parse(existing.value) as FleetStatus;
      if (parsed.status === "running") return NextResponse.json({ error: "A Fortellis update is already running", status: parsed }, { status: 409 });
    } catch { /* stale — overwrite */ }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: dealersRaw } = await (admin as any).from("fortellis_dealers").select("*").eq("enabled", true);
  const dealers = ((dealersRaw ?? []) as FortellisDealerRow[]).filter(d => !EXCLUSION_RE.test(d.dealer_name ?? ""));

  const initial: FleetStatus = {
    status: "running", started_at: new Date().toISOString(), total_dealers: dealers.length,
    completed: 0, failed: 0, current_dealer: null,
    total_vehicles_imported: 0, total_vehicles_updated: 0, total_vehicles_sold: 0, errors: [],
  };
  await writeStatus(admin, initial);

  void runFleet(dealers).catch(err => console.error("[fortellis-fleet] fatal:", err));
  return NextResponse.json({ ok: true, total_dealers: dealers.length, started_at: initial.started_at });
}

async function runFleet(dealers: FortellisDealerRow[]): Promise<void> {
  const admin = createAdminSupabaseClient();
  const status: FleetStatus = {
    status: "running", started_at: new Date().toISOString(), total_dealers: dealers.length,
    completed: 0, failed: 0, current_dealer: null,
    total_vehicles_imported: 0, total_vehicles_updated: 0, total_vehicles_sold: 0, errors: [],
  };
  let sawHealthy = false;
  for (const dealer of dealers) {
    status.current_dealer = dealer.dealer_name;
    await writeStatus(admin, status);
    try {
      const r = await fullSyncDealer(admin, dealer);
      status.total_vehicles_imported += r.imported;
      status.total_vehicles_updated += r.updated;
      status.total_vehicles_sold += r.sold;
      sawHealthy = true;
    } catch (err) {
      status.failed++;
      const tagged = err instanceof DealerSyncError ? err : new DealerSyncError("other", err instanceof Error ? err.message : String(err));
      status.errors.push({ subscription_id: dealer.subscription_id, dealer_name: dealer.dealer_name, error: tagged.message, error_type: tagged.type });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any).from("fortellis_dealers").update({ last_status: tagged.message.slice(0, 300) }).eq("id", dealer.id);
    }
    status.completed++;
    await writeStatus(admin, status);
  }
  status.status = "completed";
  status.current_dealer = null;
  status.completed_at = new Date().toISOString();
  await writeStatus(admin, status);

  // Health: any success means the API is up; a 100%-network/5xx run means down.
  try {
    if (sawHealthy) await markHealthy(admin);
    else if (status.errors.length > 0 && status.errors.every(e => isOutageSyncType(e.error_type as SyncErrorType))) {
      await markDown(admin, status.errors[status.errors.length - 1].error);
    }
  } catch { /* best-effort */ }

  // 401 notification (unsubscribed dealers).
  try {
    const auth401 = status.errors.filter(e => e.error_type === "auth_401");
    if (auth401.length) await notify401Dealers(auth401.map(e => ({ dealer_name: e.dealer_name, subscription_id: e.subscription_id })));
  } catch (e) { console.error("[fortellis-fleet] 401 email failed:", e); }
}

async function writeStatus(admin: ReturnType<typeof createAdminSupabaseClient>, status: FleetStatus): Promise<void> {
  await admin.from("admin_settings").upsert(
    { key: STATUS_KEY, value: JSON.stringify(status), updated_at: new Date().toISOString() },
    { onConflict: "key" },
  );
}
