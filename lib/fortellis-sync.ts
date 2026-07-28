// Shared Fortellis sync engine — used by the admin routes (import / full-sync /
// fleet update) and the hourly delta cron. Writes Supabase dealer_vehicles ONLY.
//
// Sync semantics:
//   - importDealer   (install): full snapshot, INSERT-only vs existing VINs.
//   - fullSyncDealer (full-sync/fleet): snapshot reconcile — add new, update changed
//                     Fortellis/CDK-fed rows, mark VINs absent from the snapshot sold.
//   - deltaDealer    (hourly): modified-since window → add/update; a second deleted=true
//                     pass marks removals sold.
//
// Guardrails (parity with ETL Job 6 + the CDK path):
//   - Never overwrite a vehicle already marked printed (print_status = 1).
//   - Only update/mark-sold rows this feed owns (created_by in FORTELLIS_*/CDK_*);
//     never touch manually-created vehicles.
//   - Mark sold = status='inactive' (canonical; print history untouched).

import { createAdminSupabaseClient } from "@/lib/db";
import { sendMandrillEmail } from "@/lib/mandrill";
import {
  searchVehicles, mapVehicle, ping, getSubscriptions, isOutageErrorType,
  FortellisError, type DealerScope, type FortellisVehicle,
} from "@/lib/fortellis-api";

const CALL_TIMEOUT_MS = 30_000;
const FEED_CREATED_BY = /^(FORTELLIS_|CDK_)/i;

export const SUPPORT_EMAIL = "support@dealeraddendums.com";
export const ALLAN_EMAIL = "allan@dealeraddendums.com";

// ── Column clamps (identical to the CDK import) ───────────────────────────────
function clip(v: string | null | undefined, n: number): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > n ? s.slice(0, n) : s;
}
function clampInt(v: number | null, lo: number, hi: number): number | null {
  if (v == null) return null;
  return v < lo ? lo : v > hi ? hi : v;
}
function clampYear(v: number | null): number | null {
  return v == null ? null : (v < 1900 || v > 2100 ? null : v);
}
function clampMileage(v: number | null): number {
  return v == null ? 0 : (clampInt(v, 0, 2_000_000) ?? 0);
}
function clampMsrp(v: number | null): number | null {
  return v == null ? null : (v < 0 || v > 9_999_999.99 ? null : v);
}

type Admin = ReturnType<typeof createAdminSupabaseClient>;

export interface FortellisDealerRow {
  id: number;
  dealer_name: string;
  subscription_id: string;
  web_id: string | null;
  dealer_code: string | null;
  dealer_id: string | null;
  is_new: boolean;
  enabled: boolean;
  last_delta_at: string | null;
}

export type SyncErrorType = "auth_401" | "no_supabase_dealer" | "timeout" | "server" | "network" | "token" | "other";

export class DealerSyncError extends Error {
  type: SyncErrorType;
  constructor(type: SyncErrorType, message: string) { super(message); this.type = type; }
}

/** True only for errors meaning the API itself is unavailable (drives the DOWN state). */
export function isOutageSyncType(t: SyncErrorType): boolean {
  return t === "network" || t === "server" || t === "timeout" || t === "token";
}

export interface SyncResult {
  imported: number;
  updated: number;
  sold: number;
  skipped: number;
  found: number;
}

// ── Dealer resolution ─────────────────────────────────────────────────────────

/** Resolve the Supabase dealers.dealer_id text key for a Fortellis dealer row. */
export async function resolveDealerTextId(admin: Admin, row: FortellisDealerRow): Promise<string> {
  if (!row.dealer_id) throw new DealerSyncError("no_supabase_dealer", `No Supabase dealer linked for ${row.dealer_name}`);
  const { data } = await admin
    .from("dealers")
    .select("dealer_id")
    .or(`dealer_id.eq.${row.dealer_id},inventory_dealer_id.eq.${row.dealer_id}`)
    .maybeSingle<{ dealer_id: string }>();
  if (!data) throw new DealerSyncError("no_supabase_dealer", `No Supabase dealer for ${row.dealer_id}`);
  return data.dealer_id;
}

function scopeOf(row: FortellisDealerRow): DealerScope {
  return { subscriptionId: row.subscription_id, webId: row.web_id, dealerCode: row.dealer_code };
}

/** Wrap a Fortellis API error into a tagged sync error, preserving the outage/auth distinction. */
function tag(err: unknown): DealerSyncError {
  if (err instanceof DealerSyncError) return err;
  if (err instanceof FortellisError) {
    // auth_401 only for a genuine HTTP 401 (dealer unsubscribed); token failures are outages.
    if (err.type === "auth_401" && err.httpStatus !== 401) return new DealerSyncError("server", err.message);
    return new DealerSyncError(err.type as SyncErrorType, err.message);
  }
  return new DealerSyncError("other", err instanceof Error ? err.message : String(err));
}

async function fetchWithTimeout(scope: DealerScope, extra: { modifiedSince?: Date; until?: Date; deleted?: boolean }): Promise<FortellisVehicle[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const raw = await searchVehicles({ ...scope, ...extra, signal: controller.signal });
    return raw.map(mapVehicle);
  } catch (err) {
    throw tag(err);
  } finally { clearTimeout(timer); }
}

// ── Insert builder ────────────────────────────────────────────────────────────
function buildInsert(v: FortellisVehicle, dealerTextId: string, createdBy: string, nowIso: string): Record<string, unknown> {
  const vin = (v.vin ?? "").trim().toUpperCase();
  return {
    dealer_id: dealerTextId,
    stock_number: clip(v.stock_number, 50) ?? vin,
    vin,
    year: clampYear(v.year),
    make: clip(v.make, 50),
    model: clip(v.model, 50),
    trim: clip(v.trim, 80),
    body_style: clip(v.body_style, 50),
    exterior_color: clip(v.ext_color, 50),
    interior_color: clip(v.int_color, 50),
    mileage: clampMileage(v.mileage),
    msrp: clampMsrp(v.msrp),
    internet_price: clip(v.internet_price, 16),
    condition: v.new_used === "Used" ? "Used" : "New",
    status: "active",
    certified: clip(v.certified, 10),
    created_by: createdBy,
    date_added: nowIso,
    date_in_stock: clip(v.date_in_stock, 20),
    input_date: nowIso.slice(0, 10),
  };
}

/** Changed-field patch for an existing feed-owned, unprinted row.
 *  Sets status back to 'active': a vehicle present in the feed and not sold is on
 *  the lot, so a previously sold-marked (or falsely sold-marked — see the
 *  pagination-skew note in fullSyncDealer) row resurrects on its next update. */
function buildUpdate(v: FortellisVehicle): Record<string, unknown> {
  return {
    status: "active",
    year: clampYear(v.year),
    make: clip(v.make, 50),
    model: clip(v.model, 50),
    trim: clip(v.trim, 80),
    body_style: clip(v.body_style, 50),
    exterior_color: clip(v.ext_color, 50),
    interior_color: clip(v.int_color, 50),
    mileage: clampMileage(v.mileage),
    msrp: clampMsrp(v.msrp),
    internet_price: clip(v.internet_price, 16),
    condition: v.new_used === "Used" ? "Used" : "New",
    certified: clip(v.certified, 10),
    updated_at: new Date().toISOString(),
  };
}

async function insertRows(admin: Admin, inserts: Array<Record<string, unknown>>): Promise<number> {
  let imported = 0;
  const BATCH = 500;
  for (let i = 0; i < inserts.length; i += BATCH) {
    const batch = inserts.slice(i, i + BATCH);
    const { error } = await admin.from("dealer_vehicles").insert(batch as never[]);
    if (error) {
      for (const row of batch) {
        const { error: rowErr } = await admin.from("dealer_vehicles").insert(row as never);
        if (rowErr) {
          const retry = { ...(row as Record<string, unknown>), stock_number: (row as Record<string, unknown>).vin };
          const { error: retry2 } = await admin.from("dealer_vehicles").insert(retry as never);
          if (!retry2) imported++;
        } else imported++;
      }
    } else imported += batch.length;
  }
  return imported;
}

/** Existing dealer_vehicles keyed by VIN, carrying the fields we need to guard on. */
interface ExistingRow { id: string; vin: string; print_status: number | null; created_by: string | null; status: string | null; }
async function loadExisting(admin: Admin, dealerTextId: string): Promise<Map<string, ExistingRow>> {
  const map = new Map<string, ExistingRow>();
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data } = await admin
      .from("dealer_vehicles")
      .select("id, vin, print_status, created_by, status")
      .eq("dealer_id", dealerTextId)
      .range(from, from + PAGE - 1);
    const rows = (data ?? []) as ExistingRow[];
    for (const r of rows) if (r.vin) map.set(r.vin.toUpperCase(), r);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return map;
}

// ── Install: insert-only ──────────────────────────────────────────────────────
export async function importDealer(admin: Admin, row: FortellisDealerRow): Promise<SyncResult> {
  const dealerTextId = await resolveDealerTextId(admin, row);
  const vehicles = await fetchWithTimeout(scopeOf(row), {});
  const nowIso = new Date().toISOString();
  const existing = await loadExisting(admin, dealerTextId);

  const inserts: Array<Record<string, unknown>> = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const v of vehicles) {
    const vin = (v.vin ?? "").trim().toUpperCase();
    if (!vin || v.sold) { skipped++; continue; }
    if (existing.has(vin) || seen.has(vin)) { skipped++; continue; }
    inserts.push(buildInsert(v, dealerTextId, "FORTELLIS_BULK", nowIso));
    seen.add(vin);
  }
  const imported = await insertRows(admin, inserts);
  await stampDealer(admin, row.id, { is_new: false, last_full_sync_at: nowIso, last_delta_at: nowIso, last_status: "ok" });
  return { imported, updated: 0, sold: 0, skipped, found: vehicles.length };
}

// ── Full-sync: reconcile add + update + mark sold ─────────────────────────────
export async function fullSyncDealer(admin: Admin, row: FortellisDealerRow): Promise<SyncResult> {
  const dealerTextId = await resolveDealerTextId(admin, row);
  const vehicles = await fetchWithTimeout(scopeOf(row), {});
  const nowIso = new Date().toISOString();
  const existing = await loadExisting(admin, dealerTextId);

  const inserts: Array<Record<string, unknown>> = [];
  const snapshotVins = new Set<string>();
  let updated = 0, skipped = 0;

  for (const v of vehicles) {
    const vin = (v.vin ?? "").trim().toUpperCase();
    if (!vin) { skipped++; continue; }
    snapshotVins.add(vin);
    const ex = existing.get(vin);
    if (!ex) {
      if (v.sold) { skipped++; continue; }
      inserts.push(buildInsert(v, dealerTextId, "FORTELLIS_BULK", nowIso));
    } else if (v.sold) {
      if (await markSold(admin, ex)) updated++; else skipped++;
    } else if (canUpdate(ex)) {
      const { error } = await admin.from("dealer_vehicles").update(buildUpdate(v) as never).eq("id", ex.id);
      if (!error) updated++; else skipped++;
    } else skipped++;
  }
  const imported = await insertRows(admin, inserts);

  // Reconcile removals: feed-owned rows still 'active' but absent from the snapshot → sold.
  // MVS2 pagination is limit/offset over an unstable sort, so a single snapshot can
  // MISS in-stock vehicles that shift across page boundaries mid-run (verified live
  // 2026-07-28: 3 in-stock demo-store vehicles skipped → falsely marked sold).
  // Confirm absence against a second snapshot before marking anything sold.
  let sold = 0;
  const absentCandidates: Array<[string, ExistingRow]> = [];
  for (const [vin, ex] of Array.from(existing.entries())) {
    if (snapshotVins.has(vin)) continue;
    if (ex.status !== "active") continue;
    if (!FEED_CREATED_BY.test(ex.created_by ?? "")) continue; // manual rows are never feed-reconciled
    absentCandidates.push([vin, ex]);
  }
  if (absentCandidates.length > 0) {
    const confirmVins = new Set<string>();
    for (const v of await fetchWithTimeout(scopeOf(row), {})) {
      const vin = (v.vin ?? "").trim().toUpperCase();
      if (vin) confirmVins.add(vin);
    }
    for (const [vin, ex] of absentCandidates) {
      if (confirmVins.has(vin)) continue; // present after all — pagination skew, leave active
      if (await markSold(admin, ex)) sold++;
    }
  }
  await stampDealer(admin, row.id, { is_new: false, last_full_sync_at: nowIso, last_delta_at: nowIso, last_status: "ok" });
  return { imported, updated, sold, skipped, found: vehicles.length };
}

// ── Hourly delta: modified window add/update + deleted pass ────────────────────
export async function deltaDealer(admin: Admin, row: FortellisDealerRow): Promise<SyncResult> {
  const dealerTextId = await resolveDealerTextId(admin, row);
  const since = row.last_delta_at ? new Date(row.last_delta_at) : new Date(Date.now() - 60 * 60 * 1000);
  const until = new Date();
  const scope = scopeOf(row);

  const changed = await fetchWithTimeout(scope, { modifiedSince: since, until });
  const removed = await fetchWithTimeout(scope, { modifiedSince: since, until, deleted: true });

  const nowIso = new Date().toISOString();
  const existing = await loadExisting(admin, dealerTextId);
  const inserts: Array<Record<string, unknown>> = [];
  let updated = 0, sold = 0, skipped = 0;
  const seen = new Set<string>();

  for (const v of changed) {
    const vin = (v.vin ?? "").trim().toUpperCase();
    if (!vin || seen.has(vin)) { skipped++; continue; }
    seen.add(vin);
    const ex = existing.get(vin);
    if (v.sold) {
      if (ex && await markSold(admin, ex)) sold++; else skipped++;
      continue;
    }
    if (!ex) {
      inserts.push(buildInsert(v, dealerTextId, "FORTELLIS_DELTA", nowIso));
    } else if (canUpdate(ex)) {
      const { error } = await admin.from("dealer_vehicles").update(buildUpdate(v) as never).eq("id", ex.id);
      if (!error) updated++; else skipped++;
    } else skipped++;
  }
  for (const v of removed) {
    const vin = (v.vin ?? "").trim().toUpperCase();
    if (!vin) continue;
    const ex = existing.get(vin);
    if (ex && await markSold(admin, ex)) sold++;
  }
  const imported = await insertRows(admin, inserts);
  await stampDealer(admin, row.id, { last_delta_at: until.toISOString(), last_status: "ok" });
  return { imported, updated, sold, skipped, found: changed.length + removed.length };
}

// ── Guards + helpers ──────────────────────────────────────────────────────────

/** Feed-owned and not printed → safe to overwrite. */
function canUpdate(ex: ExistingRow): boolean {
  if (ex.print_status === 1) return false;                 // never overwrite a printed vehicle
  if (!FEED_CREATED_BY.test(ex.created_by ?? "")) return false; // never touch manual/other-feed rows
  return true;
}

/** Mark a feed-owned row sold (status='inactive'). Print history untouched. Returns true if changed. */
async function markSold(admin: Admin, ex: ExistingRow): Promise<boolean> {
  if (!FEED_CREATED_BY.test(ex.created_by ?? "")) return false; // never mark manual vehicles sold
  if (ex.status === "inactive") return false;
  const { error } = await admin
    .from("dealer_vehicles")
    .update({ status: "inactive", updated_at: new Date().toISOString() } as never)
    .eq("id", ex.id);
  return !error;
}

async function stampDealer(admin: Admin, id: number, patch: Record<string, unknown>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from("fortellis_dealers").update(patch).eq("id", id);
}

// ── Availability state machine (admin_settings.fortellis_health) ──────────────
//
// Alert debounce (2026-07-28): transient Fortellis 502s self-heal in seconds and
// were producing DOWN/UP email pairs for every blip. Rule: only email when the API
// has been down for MORE THAN 5 MINUTES. On the up→down transition we record the
// state (the admin tab banner may go red immediately — that's fine) but send no
// email; a fire-and-forget re-probe ~5 min later confirms the outage before the
// first alert. Because health events are call-driven, every markDown while down
// also re-evaluates age — so a process restart mid-wait just delays the email to
// the next failing call. Recovery emails pair 1:1 with sent alerts: a blip that
// never alerted recovers silently.

const HEALTH_KEY = "fortellis_health";
const RE_ALERT_MS = 6 * 60 * 60 * 1000; // re-alert at most every 6h while down
// Overridable for tests; production default 5 minutes.
const ALERT_AFTER_MS = Number(process.env.FORTELLIS_ALERT_AFTER_MS ?? 5 * 60 * 1000);
// Confirm probe fires just past the alert threshold so a still-down probe emails immediately.
const CONFIRM_PROBE_DELAY_MS = ALERT_AFTER_MS + 15_000;

export interface FortellisHealth {
  state: "up" | "down";
  since?: string;
  last_error?: string;
  last_alert_at?: string;
  last_ok_at?: string;
  /** True once the "unavailable" email for the CURRENT outage has been sent. */
  alert_sent?: boolean;
}

export async function getHealth(admin: Admin): Promise<FortellisHealth> {
  const { data } = await admin.from("admin_settings").select("value").eq("key", HEALTH_KEY).maybeSingle<{ value: string }>();
  if (!data?.value) return { state: "up" };
  try { return JSON.parse(data.value) as FortellisHealth; } catch { return { state: "up" }; }
}

async function writeHealth(admin: Admin, h: FortellisHealth): Promise<void> {
  await admin.from("admin_settings").upsert(
    { key: HEALTH_KEY, value: JSON.stringify(h), updated_at: new Date().toISOString() },
    { onConflict: "key" },
  );
}

/** Record a healthy call. Sends a recovery email on a down→up transition ONLY when
 *  the outage actually alerted — a blip that never emailed recovers silently. */
export async function markHealthy(admin: Admin): Promise<void> {
  const cur = await getHealth(admin);
  const nowIso = new Date().toISOString();
  if (cur.state === "down") {
    await writeHealth(admin, { state: "up", last_ok_at: nowIso });
    if (cur.alert_sent) {
      await safeEmail(
        "✅ Fortellis API recovered",
        `<p>The Fortellis API is responding again as of <strong>${fmtPt(nowIso)}</strong>.</p>
         ${cur.since ? `<p>It was unavailable since ${fmtPt(cur.since)}.</p>` : ""}`,
      );
    }
  } else if (cur.last_ok_at == null || cur.state !== "up") {
    await writeHealth(admin, { state: "up", last_ok_at: nowIso });
  } else {
    await writeHealth(admin, { ...cur, last_ok_at: nowIso });
  }
}

/** Record an outage. No email on the up→down transition — the first alert goes out
 *  only once the outage is older than ALERT_AFTER_MS (confirmed by the scheduled
 *  re-probe, or by whichever failing call arrives first past the threshold). While
 *  down and alerted, re-alerts at most every 6h. */
export async function markDown(admin: Admin, lastError: string): Promise<void> {
  const cur = await getHealth(admin);
  const nowIso = new Date().toISOString();

  if (cur.state !== "down") {
    // Transition: record the outage, alert later if it survives the debounce window.
    await writeHealth(admin, { state: "down", since: nowIso, last_error: lastError, alert_sent: false });
    scheduleOutageConfirm();
    return;
  }

  if (!cur.alert_sent) {
    const sinceMs = cur.since ? new Date(cur.since).getTime() : 0;
    if (Date.now() - sinceMs > ALERT_AFTER_MS) {
      await writeHealth(admin, { ...cur, last_error: lastError, alert_sent: true, last_alert_at: nowIso });
      await safeEmail(
        "🚨 Fortellis API unavailable",
        `<p>The Fortellis API has been unavailable since <strong>${cur.since ? fmtPt(cur.since) : "unknown"}</strong> (more than ${Math.round(ALERT_AFTER_MS / 60_000)} minutes).</p>
         <p>Latest error: <code>${escapeHtml(lastError)}</code></p>
         <p>The Fortellis Dealers hourly delta cannot run until it recovers. A recovery email will follow.</p>`,
      );
    } else {
      await writeHealth(admin, { ...cur, last_error: lastError });
    }
    return;
  }

  const lastAlert = cur.last_alert_at ? new Date(cur.last_alert_at).getTime() : 0;
  if (Date.now() - lastAlert > RE_ALERT_MS) {
    await writeHealth(admin, { ...cur, last_error: lastError, last_alert_at: nowIso });
    await safeEmail(
      "🚨 Fortellis API still unavailable",
      `<p>The Fortellis API is <strong>still unavailable</strong> (since ${cur.since ? fmtPt(cur.since) : "unknown"}).</p>
       <p>Latest error: <code>${escapeHtml(lastError)}</code></p>`,
    );
  } else {
    await writeHealth(admin, { ...cur, last_error: lastError });
  }
}

// ── Outage confirmation (the active half of the debounce) ─────────────────────

let confirmTimer: ReturnType<typeof setTimeout> | null = null;

/** On the up→down transition, schedule a one-shot in-process re-probe just past the
 *  alert threshold. If the process restarts mid-wait, the passive age check in
 *  markDown covers it on the next failing call. */
function scheduleOutageConfirm(): void {
  if (confirmTimer) return;
  confirmTimer = setTimeout(() => {
    confirmTimer = null;
    confirmOutage().catch(err => console.error("[fortellis] outage confirm failed:", err instanceof Error ? err.message : err));
  }, CONFIRM_PROBE_DELAY_MS);
  // Don't hold the process open for the probe.
  (confirmTimer as { unref?: () => void }).unref?.();
}

async function confirmOutage(): Promise<void> {
  const admin = createAdminSupabaseClient();
  const cur = await getHealth(admin);
  if (cur.state !== "down" || cur.alert_sent) return; // recovered meanwhile, or already alerted
  const probe = await reprobe(admin);
  if (probe.ok) { await markHealthy(admin); return; }  // silent recovery — no alert was sent
  // Still down past the threshold — markDown's age check sends the alert.
  await markDown(admin, probe.error ?? "confirmation probe failed");
}

/** Availability probe (Layer-1 retry included via ping/getSubscriptions). Uses any
 *  configured dealer's scope for a real vehicle-search ping; falls back to the
 *  subscriptions endpoint when no dealers exist. A 4xx counts as UP — the API
 *  answered; config errors are not outages. */
async function reprobe(admin: Admin): Promise<{ ok: boolean; error?: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any)
    .from("fortellis_dealers")
    .select("subscription_id, web_id, dealer_code")
    .order("enabled", { ascending: false })
    .limit(1);
  const row = (data ?? [])[0] as { subscription_id: string; web_id: string | null; dealer_code: string | null } | undefined;
  if (row) {
    const r = await ping({ subscriptionId: row.subscription_id, webId: row.web_id, dealerCode: row.dealer_code });
    if (r.ok || !isOutageErrorType(r.errorType)) return { ok: true };
    return { ok: false, error: r.error };
  }
  try { await getSubscriptions(); return { ok: true }; }
  catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
}

// ── 401 support notification ──────────────────────────────────────────────────

export async function notify401Dealers(dealers: Array<{ dealer_name: string; subscription_id: string }>): Promise<void> {
  if (dealers.length === 0) return;
  const list = dealers
    .map(d => `<li>${escapeHtml(d.dealer_name)} <code style="color:#666;font-size:11px;">${escapeHtml(d.subscription_id)}</code></li>`)
    .join("\n");
  await safeEmail(
    `Fortellis Authorization Errors — ${dealers.length} dealer${dealers.length === 1 ? "" : "s"} need attention`,
    `<p>The following Fortellis dealers returned HTTP 401 during the latest run. They may have
      unsubscribed from DealerAddendums on the Fortellis Marketplace. Please review.</p>
     <ul>${list}</ul>`,
    [SUPPORT_EMAIL],
  );
}

// ── email helpers ──────────────────────────────────────────────────────────────

async function safeEmail(subject: string, html: string, to: string[] = [SUPPORT_EMAIL, ALLAN_EMAIL]): Promise<void> {
  try {
    await sendMandrillEmail({
      subject,
      from_email: "noreply@dealeraddendums.com",
      from_name: "DA Platform",
      to: to.map(email => ({ email, type: "to" as const })),
      html,
    });
  } catch (err) {
    console.error("[fortellis] email failed:", err instanceof Error ? err.message : err);
  }
}

function fmtPt(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short" });
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
