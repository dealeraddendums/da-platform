// Admin "VIN / Stock Lookup" — everything we know about one VIN (or stock #),
// pulled from every place it can live, plus a plain-English verdict that
// answers "a dealer says this VIN is missing — why?".
//
// READ-ONLY end to end: Supabase selects only; S3 is anonymous HEADs against
// the public bucket; Aurora is reached through the ETL box's key-gated
// POST /vin-lookup (da-platform has no Aurora route — see the ETL box).
// Every list read is capped well under the PostgREST 1,000-row clamp.

import { createAdminSupabaseClient } from "@/lib/db";
import { getDealerFeedStatus, isFeedOwnedRow } from "@/lib/dealer-feed-status";

const S3_BASE = "https://dealer-addendums.s3.us-west-1.amazonaws.com";
const VIN_RE = /^[A-Z0-9]{17}$/i;
const MAX_VINS = 10; // a stock # can hit several vehicles; detail the first 10

export type LookupKind = "vin" | "stock";

export function detectKind(q: string): LookupKind {
  return VIN_RE.test(q.trim()) ? "vin" : "stock";
}

// Escape LIKE wildcards so an ilike behaves as a case-insensitive equals.
function likeExact(v: string): string {
  return v.replace(/[\\%_]/g, (c) => `\\${c}`);
}

type Tone = "green" | "amber" | "red" | "grey";

export interface DealerInfo {
  id: string;
  dealer_id: string;
  inventory_dealer_id: string | null;
  name: string;
  active: boolean;
  migration_status: string | null;
  is_native: boolean | null;
  is_test: boolean | null;
  inventory_provider: string | null;
  feed_source: string | null;
  last_synced_at: string | null;
}

export interface VehicleRow {
  id: string;
  dealer_id: string;
  dealer: DealerInfo | null;
  vin: string | null;
  stock_number: string | null;
  year: number | string | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  status: string | null;
  status_code: string | null;
  condition: string | null;
  certified: unknown;
  mileage: number | string | null;
  msrp: number | string | null;
  internet_price: number | string | null;
  electrification: string | null;
  created_by: string | null;
  date_added: string | null;
  updated_at: string | null;
  print_status: unknown;
  print_date: string | null;
  print_guide: unknown;
  print_info: unknown;
  print_user: string | null;
  print_queue: unknown;
  print_cleared_at: string | null;
  options_saved_at: string | null;
}

export interface ProductLine { name: string; price: string | null; source: string; active?: boolean }

export interface VehicleProducts {
  vehicle_id: string;
  saved: ProductLine[];
  legacy: ProductLine[]; // addendum_data fallback (deduped by item name, newest wins)
}

export interface PrintSummary {
  vehicle_id: string;
  count: number;
  last_at: string | null;
  last_by: string | null;
  last_doc: string | null;
}

export interface S3Object { key: string; exists: boolean; last_modified: string | null; size: number | null; url: string }

export interface FeedInfo {
  dealer_id: string;
  provider: string | null;
  feed_source: string | null;
  fortellis: { enabled: boolean; last_delta_at: string | null; last_status: string | null } | null;
  cdk: { new_flag: string | null; last_delta: string | null } | null;
  tekion: { last_update: string | null } | null;
  active_vehicles: number;
  has_live_feed: boolean;
  provenance: string[]; // distinct created_by across the dealer's active inventory
  last_vehicle_update: string | null;
  last_vehicle_update_by: string | null;
}

export interface AuroraRow {
  dealer_id: string | null;
  dealer_name: string | null;
  dealer_active: string | null;
  feed_source: string | null;
  migrated_to_v5: string | null;
  vin: string | null;
  stock: string | null;
  year: string | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  new_used: string | null;
  certified: string | null;
  mileage: string | null;
  msrp: string | null;
  internet_price: string | null;
  status: string | null;
  status_code: string | null;
  created_by: string | null;
  print_status: string | null;
  print_date: string | null;
  print_user: string | null;
  print_queue: number | null;
  updated_at: string | null;
  // resolved on our side: which 5.0 dealer this 4.0 DEALER_ID maps to
  v5_dealer: { dealer_id: string; name: string } | null;
}

export interface Verdict { tone: Tone; headline: string; notes: string[] }

export interface LookupReport {
  query: string;
  kind: LookupKind;
  dealer_filter: string | null;
  expected_dealers: DealerInfo[];
  vins: string[];
  truncated_vins: boolean;
  verdict: Verdict;
  vehicles: VehicleRow[];
  products: VehicleProducts[];
  prints: PrintSummary[];
  s3: Record<string, S3Object[]>;
  feeds: FeedInfo[];
  aurora: { ok: boolean; error: string | null; rows: AuroraRow[] };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

const DEALER_COLS =
  "id, dealer_id, inventory_dealer_id, name, active, migration_status, is_native, is_test, inventory_provider, feed_source, last_synced_at";

const VEHICLE_COLS =
  "id, dealer_id, vin, stock_number, year, make, model, trim, status, status_code, condition, certified, mileage, msrp, internet_price, electrification, created_by, date_added, updated_at, print_status, print_date, print_guide, print_info, print_user, print_queue, print_cleared_at, options_saved_at";

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true" || v === "t";
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "unknown date";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? String(iso) : d.toISOString().slice(0, 10);
}

/** Resolve the optional dealer filter (5.0 dealer_id, inventory id, or name). */
async function resolveDealerFilter(db: Db, f: string): Promise<DealerInfo[]> {
  const exact = likeExact(f);
  const { data: byId } = await db
    .from("dealers")
    .select(DEALER_COLS)
    .or(`dealer_id.ilike."${exact}",inventory_dealer_id.ilike."${exact}"`)
    .limit(20);
  if (byId && byId.length) return byId as DealerInfo[];
  const { data: byName } = await db
    .from("dealers")
    .select(DEALER_COLS)
    .ilike("name", `%${exact}%`)
    .limit(20);
  return (byName ?? []) as DealerInfo[];
}

async function fetchAurora(body: Record<string, string>): Promise<{ ok: boolean; error: string | null; rows: AuroraRow[] }> {
  const url = process.env.ETL_SYNC_URL;
  const key = process.env.ETL_SYNC_API_KEY;
  if (!url || !key) return { ok: false, error: "ETL_SYNC_URL / ETL_SYNC_API_KEY not configured", rows: [] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/vin-lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": key },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    const json = (await res.json().catch(() => ({}))) as { rows?: AuroraRow[]; error?: string };
    if (!res.ok) return { ok: false, error: json.error ?? `ETL box HTTP ${res.status}`, rows: [] };
    return { ok: true, error: null, rows: (json.rows ?? []).map((r) => ({ ...r, v5_dealer: null })) };
  } catch (err) {
    const msg = err instanceof Error ? (err.name === "AbortError" ? "timed out after 20s" : err.message) : String(err);
    return { ok: false, error: `4.0 lookup failed: ${msg}`, rows: [] };
  } finally {
    clearTimeout(timer);
  }
}

async function headS3(vin: string): Promise<S3Object[]> {
  const V = vin.toUpperCase();
  const keys = [`${V}.pdf`, `${V}_infosheet.pdf`, `${V}_buyers_guide.pdf`];
  return Promise.all(
    keys.map(async (key) => {
      const url = `${S3_BASE}/${key}`;
      try {
        const res = await fetch(url, { method: "HEAD", cache: "no-store" });
        if (!res.ok) return { key, exists: false, last_modified: null, size: null, url };
        const lm = res.headers.get("last-modified");
        const len = res.headers.get("content-length");
        return {
          key,
          exists: true,
          last_modified: lm ? new Date(lm).toISOString() : null,
          size: len ? Number(len) : null,
          url,
        };
      } catch {
        return { key, exists: false, last_modified: null, size: null, url };
      }
    }),
  );
}

/**
 * Feed presence for one dealer. The single definition of "what feed is this
 * dealer on and is it alive" — used by the per-VIN report AND by dealer mode
 * (runDealerLookup), so the two can never drift apart.
 *
 * Roster keys mirror lib/dealer-feed-status: CDK on the text dealer_id, Tekion
 * on either id. hasLiveFeed/provenance come straight from getDealerFeedStatus
 * rather than being recomputed here.
 */
export async function buildFeedInfo(db: Db, d: DealerInfo): Promise<FeedInfo> {
  const ids = Array.from(new Set([d.dealer_id, d.inventory_dealer_id].filter((x): x is string => !!x)));
  const [fort, cdk, tek, latest, count, status] = await Promise.all([
    db.from("fortellis_dealers").select("enabled, last_delta_at, last_status").eq("dealer_id", d.dealer_id).limit(1),
    db.from("cdk_dealers").select("NEW, LAST_DELTA").eq("DEALER_ID", d.dealer_id).limit(1),
    db.from("tekion_dealers").select("last_update").in("dealer_id", ids).limit(1),
    db.from("dealer_vehicles").select("updated_at, created_by").eq("dealer_id", d.dealer_id).eq("status", "active")
      .order("updated_at", { ascending: false }).limit(1),
    db.from("dealer_vehicles").select("id", { count: "exact", head: true }).eq("dealer_id", d.dealer_id).eq("status", "active"),
    getDealerFeedStatus(db, d.dealer_id, d.inventory_dealer_id),
  ]);
  const f = (fort.data ?? [])[0];
  const c = (cdk.data ?? [])[0];
  const t = (tek.data ?? [])[0];
  const l = (latest.data ?? [])[0];
  return {
    dealer_id: d.dealer_id,
    provider: d.inventory_provider,
    feed_source: d.feed_source,
    fortellis: f ? { enabled: !!f.enabled, last_delta_at: f.last_delta_at ?? null, last_status: f.last_status ?? null } : null,
    cdk: c ? { new_flag: c.NEW == null ? null : String(c.NEW), last_delta: c.LAST_DELTA ?? null } : null,
    tekion: t ? { last_update: t.last_update ?? null } : null,
    active_vehicles: count.count ?? 0,
    has_live_feed: status.hasLiveFeed,
    provenance: status.signals.provenance,
    last_vehicle_update: l?.updated_at ?? null,
    last_vehicle_update_by: l?.created_by ?? null,
  };
}

export async function runVinLookup(rawQuery: string, rawDealer: string | null): Promise<LookupReport> {
  const db: Db = createAdminSupabaseClient();
  const query = rawQuery.trim();
  const kind = detectKind(query);
  const dealerFilter = rawDealer?.trim() || null;

  const expected = dealerFilter ? await resolveDealerFilter(db, dealerFilter) : [];
  const expectedIds = new Set(expected.map((d) => d.dealer_id));

  // ── 1) dealer_vehicles ────────────────────────────────────────────────────
  // VIN search always returns every dealer's row (a dup VIN across dealers is
  // itself a common "missing" cause). Stock # is per-dealer, so the dealer
  // filter narrows a stock search.
  let vq = db.from("dealer_vehicles").select(VEHICLE_COLS);
  vq = kind === "vin" ? vq.ilike("vin", likeExact(query)) : vq.ilike("stock_number", likeExact(query));
  if (kind === "stock" && expectedIds.size) vq = vq.in("dealer_id", Array.from(expectedIds));
  const { data: vrows, error: verr } = await vq.order("updated_at", { ascending: false }).limit(50);
  if (verr) throw new Error(`dealer_vehicles: ${verr.message}`);
  const vehicles = (vrows ?? []) as VehicleRow[];

  // ── 6) Aurora (4.0) — via the ETL box ─────────────────────────────────────
  const auroraBody: Record<string, string> =
    kind === "vin" ? { vin: query.toUpperCase() } : { stock: query };
  if (kind === "stock" && expected.length === 1 && expected[0].inventory_dealer_id) {
    auroraBody.dealer_id = expected[0].inventory_dealer_id;
  }
  const aurora = await fetchAurora(auroraBody);

  // VINs to detail: from 5.0 rows first, then 4.0-only ones (stock searches).
  const vinSet: string[] = [];
  for (const v of [...vehicles.map((r) => r.vin), ...aurora.rows.map((r) => r.vin)]) {
    const V = (v ?? "").trim().toUpperCase();
    if (V && !vinSet.includes(V)) vinSet.push(V);
  }
  if (kind === "vin" && !vinSet.includes(query.toUpperCase())) vinSet.unshift(query.toUpperCase());
  const truncated = vinSet.length > MAX_VINS;
  const vins = vinSet.slice(0, MAX_VINS);

  // ── Dealers referenced anywhere ───────────────────────────────────────────
  const v5DealerIds = Array.from(new Set(vehicles.map((v) => v.dealer_id).filter(Boolean)));
  const auroraDealerIds = Array.from(new Set(aurora.rows.map((r) => r.dealer_id).filter((x): x is string => !!x)));
  const dealerById = new Map<string, DealerInfo>();
  for (const d of expected) dealerById.set(d.dealer_id, d);
  if (v5DealerIds.length) {
    const { data } = await db.from("dealers").select(DEALER_COLS).in("dealer_id", v5DealerIds).limit(100);
    for (const d of (data ?? []) as DealerInfo[]) dealerById.set(d.dealer_id, d);
  }
  // Map 4.0 DEALER_ID → 5.0 dealer by inventory_dealer_id (case-insensitive,
  // the same matching the ETL uses).
  const invMap = new Map<string, DealerInfo>();
  for (const id of auroraDealerIds) {
    const { data } = await db
      .from("dealers")
      .select(DEALER_COLS)
      .ilike("inventory_dealer_id", likeExact(id))
      .limit(5);
    const hit = ((data ?? []) as DealerInfo[])[0];
    if (hit) {
      invMap.set(id.toLowerCase(), hit);
      dealerById.set(hit.dealer_id, hit);
    }
  }
  for (const r of aurora.rows) {
    const d = r.dealer_id ? invMap.get(r.dealer_id.toLowerCase()) : undefined;
    r.v5_dealer = d ? { dealer_id: d.dealer_id, name: d.name } : null;
  }
  for (const v of vehicles) v.dealer = dealerById.get(v.dealer_id) ?? null;

  // ── 2) Products ───────────────────────────────────────────────────────────
  const vehicleIds = vehicles.map((v) => v.id);
  const products: VehicleProducts[] = [];
  if (vehicleIds.length) {
    const { data: opts } = await db
      .from("vehicle_options")
      .select("vehicle_id, option_name, option_price, source, active, sort_order")
      .in("vehicle_id", vehicleIds)
      .order("sort_order", { ascending: true })
      .limit(500);
    const { data: ad } = await db
      .from("addendum_data")
      .select("legacy_dealer_id, vin_number, item_name, item_price, active, order_by, created_at")
      .in("vin_number", vins)
      .order("created_at", { ascending: false })
      .limit(500);
    for (const v of vehicles) {
      const saved = ((opts ?? []) as Array<Record<string, unknown>>)
        .filter((o) => o.vehicle_id === v.id)
        .map((o) => ({
          name: String(o.option_name ?? ""),
          price: o.option_price == null ? null : String(o.option_price),
          source: String(o.source ?? "—"),
          active: o.active !== false,
        }));
      const seen = new Set<string>();
      const legacy: ProductLine[] = [];
      for (const a of (ad ?? []) as Array<Record<string, unknown>>) {
        if (String(a.vin_number ?? "").toUpperCase() !== (v.vin ?? "").toUpperCase()) continue;
        if (a.legacy_dealer_id && String(a.legacy_dealer_id) !== v.dealer_id) continue;
        const k = String(a.item_name ?? "").toLowerCase();
        if (seen.has(k)) continue; // newest row per item name wins
        seen.add(k);
        legacy.push({
          name: String(a.item_name ?? ""),
          price: a.item_price == null ? null : String(a.item_price),
          source: "addendum_data",
          active: a.active !== false && a.active !== 0,
        });
      }
      products.push({ vehicle_id: v.id, saved, legacy });
    }
  }

  // ── 3) Print history ──────────────────────────────────────────────────────
  const prints: PrintSummary[] = [];
  if (vehicleIds.length) {
    const { data: ph } = await db
      .from("print_history")
      .select("vehicle_id, document_type, printed_by, created_at")
      .in("vehicle_id", vehicleIds)
      .order("created_at", { ascending: false })
      .limit(500);
    const rows = (ph ?? []) as Array<{ vehicle_id: string; document_type: string | null; printed_by: string | null; created_at: string }>;
    const printerIds = Array.from(new Set(rows.map((r) => r.printed_by).filter((x): x is string => !!x)));
    const who = new Map<string, string>();
    if (printerIds.length) {
      const { data: profs } = await db
        .from("profiles")
        .select("id, email, full_name")
        .in("id", printerIds.slice(0, 100))
        .limit(100);
      for (const p of (profs ?? []) as Array<Record<string, string | null>>) {
        const nm = p.full_name ?? "";
        who.set(String(p.id), nm ? `${nm} (${p.email ?? ""})` : String(p.email ?? p.id));
      }
    }
    for (const v of vehicles) {
      const mine = rows.filter((r) => r.vehicle_id === v.id);
      const last = mine[0];
      prints.push({
        vehicle_id: v.id,
        count: mine.length,
        last_at: last?.created_at ?? null,
        last_by: last?.printed_by ? (who.get(last.printed_by) ?? last.printed_by) : null,
        last_doc: last?.document_type ?? null,
      });
    }
  }

  // ── 4) S3 PDFs ────────────────────────────────────────────────────────────
  const s3: Record<string, S3Object[]> = {};
  await Promise.all(vins.map(async (v) => { s3[v] = await headS3(v); }));

  // ── 5) Feed presence per dealer ───────────────────────────────────────────
  const feedDealers = Array.from(dealerById.values()).filter(
    (d) => v5DealerIds.includes(d.dealer_id) || expectedIds.has(d.dealer_id) || Array.from(invMap.values()).some((x) => x.dealer_id === d.dealer_id),
  ).slice(0, 10);
  const feeds: FeedInfo[] = await Promise.all(feedDealers.map((d) => buildFeedInfo(db, d)));

  const verdict = buildVerdict({ kind, query, expected, vehicles, aurora, products, feeds });

  return {
    query,
    kind,
    dealer_filter: dealerFilter,
    expected_dealers: expected,
    vins,
    truncated_vins: truncated,
    verdict,
    vehicles,
    products,
    prints,
    s3,
    feeds,
    aurora,
  };
}

// ── Verdict ───────────────────────────────────────────────────────────────────
// Best-effort summary from the evidence above. Order matters: the first
// matching case is the headline; secondary clues go in notes.
function buildVerdict(x: {
  kind: LookupKind;
  query: string;
  expected: DealerInfo[];
  vehicles: VehicleRow[];
  aurora: { ok: boolean; error: string | null; rows: AuroraRow[] };
  products: VehicleProducts[];
  feeds: FeedInfo[];
}): Verdict {
  const notes: string[] = [];
  const label = x.kind === "vin" ? "VIN" : "Stock #";
  const dname = (v: VehicleRow) => v.dealer?.name ?? v.dealer_id;
  const active = x.vehicles.filter((v) => v.status === "active");
  const inactive = x.vehicles.filter((v) => v.status !== "active");
  const expectedIds = new Set(x.expected.map((d) => d.dealer_id));
  const au = x.aurora.rows;
  const auActive = au.filter((r) => r.status === "1");

  if (!x.aurora.ok) notes.push(`4.0 (Aurora) check unavailable: ${x.aurora.error}. Verdict is based on 5.0 data only.`);

  // The dealer the operator expected vs where the VIN actually lives.
  if (expectedIds.size && x.kind === "vin" && x.vehicles.length) {
    const atExpected = x.vehicles.filter((v) => expectedIds.has(v.dealer_id));
    if (!atExpected.length) {
      const where = Array.from(new Set(x.vehicles.map(dname))).join(", ");
      notes.push(`Not under the dealer you filtered on — it lives under ${where}.`);
      return {
        tone: "red",
        headline: `Under a DIFFERENT dealer than expected (${where}) — dealer_id / inventory id mismatch, or the vehicle belongs to another rooftop.`,
        notes: notes.concat(extraNotes(x, active, inactive)),
      };
    }
  }

  // A row whose dealer_id matches no 5.0 dealer is invisible to everyone, so
  // it never counts as "visible" — it only appears in the notes.
  const visible = active.filter((v) => v.dealer);
  const orphanActive = active.filter((v) => !v.dealer);
  const realInactive = inactive.filter((v) => v.dealer);

  if (visible.length) {
    const who = Array.from(new Set(visible.map(dname))).join(", ");
    const n = new Set(visible.map((v) => v.dealer_id)).size;
    const head = n > 1
      ? `Active in 5.0 under ${n} dealers (${who}) — duplicate VIN; each dealer sees its own copy.`
      : `Active in 5.0 for ${who} — should be visible.`;
    return { tone: "green", headline: head, notes: notes.concat(extraNotes(x, active, inactive)) };
  }

  if (realInactive.length) {
    // Prefer the dealer the operator expected, when one was given.
    const v = realInactive.find((r) => expectedIds.has(r.dealer_id)) ?? realInactive[0];
    const head = `Found but INACTIVE for ${dname(v)} (updated ${fmtDate(v.updated_at)}, created_by ${v.created_by ?? "unknown"}) — marked sold/deactivated.`;
    return { tone: "amber", headline: head, notes: notes.concat(extraNotes(x, active, inactive)) };
  }

  if (orphanActive.length) {
    const ids = Array.from(new Set(orphanActive.map((v) => v.dealer_id))).join(", ");
    return {
      tone: "red",
      headline: `Active in 5.0 ONLY under dealer_id ${ids}, which matches no 5.0 dealer — no one can see it (feed writing under an id with no dealer record).`,
      notes: notes.concat(extraNotes(x, active, inactive)),
    };
  }

  if (inactive.length) {
    const v = inactive[0];
    const head = `Found but INACTIVE for ${dname(v)} (updated ${fmtDate(v.updated_at)}, created_by ${v.created_by ?? "unknown"}) — marked sold/deactivated.`;
    return { tone: "amber", headline: head, notes: notes.concat(extraNotes(x, active, inactive)) };
  }

  if (au.length) {
    const r = auActive[0] ?? au[0];
    const status = r.status === "1" ? "active" : "inactive";
    const v5 = r.v5_dealer;
    if (!v5) {
      return {
        tone: "red",
        headline: `Not in 5.0. Found in 4.0 (${status}) for ${r.dealer_name ?? "?"} [4.0 DEALER_ID ${r.dealer_id}] — and NO 5.0 dealer has that inventory id, so it can never ingest (dealer_id / inventory id mismatch, or the dealer isn't on 5.0).`,
        notes: notes.concat(extraNotes(x, active, inactive)),
      };
    }
    return {
      tone: r.status === "1" ? "red" : "grey",
      headline: r.status === "1"
        ? `Not in 5.0 dealer_vehicles; found ACTIVE in 4.0 for ${v5.name} — not yet ingested/synced into 5.0.`
        : `Not in 5.0; in 4.0 for ${v5.name} but INACTIVE there too (sold/removed in 4.0) — nothing to ingest.`,
      notes: notes.concat(extraNotes(x, active, inactive)),
    };
  }

  return {
    tone: "grey",
    headline: x.aurora.ok
      ? `${label} not found anywhere (5.0 or 4.0).`
      : `${label} not found in 5.0 (4.0 could not be checked).`,
    notes: notes.concat(
      x.kind === "stock" ? ["Stock numbers are per-dealer and often re-used or re-formatted by feeds — try the VIN if you have it."] : [],
      x.kind === "vin" && !VIN_RE.test(x.query) ? ["That doesn't look like a 17-character VIN."] : [],
    ),
  };
}

function extraNotes(
  x: { vehicles: VehicleRow[]; aurora: { rows: AuroraRow[] }; products: VehicleProducts[]; feeds: FeedInfo[] },
  active: VehicleRow[],
  inactive: VehicleRow[],
): string[] {
  const out: string[] = [];
  const au = x.aurora.rows;
  for (const v of active) {
    const name = v.dealer?.name ?? v.dealer_id;
    if (!v.dealer) {
      out.push(`dealer_id "${v.dealer_id}": an ACTIVE copy (created_by ${v.created_by ?? "unknown"}) sits under an id that matches no 5.0 dealer — invisible to everyone (a feed writing under a 4.0/old id, or a dealer-id rename).`);
      continue;
    }
    {
      if (!v.dealer.active) out.push(`${name}: the dealer account itself is INACTIVE.`);
      if (v.dealer.is_test) out.push(`${name}: this is a test account.`);
      if (v.dealer.migration_status !== "migrated" && !v.dealer.is_native && !/^(ss|ga)_/.test(v.dealer.dealer_id)) {
        out.push(`${name}: dealer is not migrated (status ${v.dealer.migration_status ?? "legacy"}) — its staff may still be working in 4.0.`);
      }
    }
    if (truthy(v.print_status)) out.push(`${name}: already printed (${fmtDate(v.print_date)}) — hidden if the dealer filters to Unprinted.`);
    if (truthy(v.print_queue)) out.push(`${name}: sitting in the print queue.`);
    const p = x.products.find((pp) => pp.vehicle_id === v.id);
    if (p && p.saved.length === 0 && p.legacy.length === 0) {
      out.push(`${name}: no saved products and no 4.0 addendum_data — the addendum shows only library auto-match products (rules-based, computed at print).`);
    }
    const auHere = au.find((r) => r.v5_dealer?.dealer_id === v.dealer_id);
    if (auHere && auHere.status !== "1") out.push(`${name}: still active in 5.0 but INACTIVE in 4.0 (sold in 4.0) — the two platforms disagree.`);
  }
  for (const v of inactive) {
    const name = v.dealer?.name ?? v.dealer_id;
    const auHere = au.find((r) => r.v5_dealer?.dealer_id === v.dealer_id);
    if (auHere?.status === "1") out.push(`${name}: inactive in 5.0 but still ACTIVE in 4.0 — the 5.0 feed dropped it (or marked it sold) while 4.0 still has it.`);
    const f = x.feeds.find((ff) => ff.dealer_id === v.dealer_id);
    if (f && !f.has_live_feed) out.push(`${name}: dealer has NO live inventory feed (no Fortellis/CDK/Tekion roster row, no feed-created vehicles) — vehicles only arrive by CSV/manual add.`);
    else if (!isFeedOwnedRow(v.created_by)) out.push(`${name}: this row was created by "${v.created_by ?? "unknown"}" (not a feed) — a feed will not reactivate it.`);
    if (f?.has_live_feed && f.last_vehicle_update) {
      const days = (Date.now() - new Date(f.last_vehicle_update).getTime()) / 86400_000;
      if (days > 3) out.push(`${name}: the dealer's newest vehicle update is ${Math.floor(days)} days old (${fmtDate(f.last_vehicle_update)}) — the feed may have stopped delivering.`);
    }
  }
  // Dup VIN across dealers in 5.0, even if only one is active.
  const dealerSet = new Set(x.vehicles.map((v) => v.dealer_id));
  if (dealerSet.size > 1) out.push(`This VIN exists under ${dealerSet.size} dealers in 5.0 — check the dealer is looking at the right rooftop.`);
  // 4.0 dealers with no 5.0 match.
  for (const r of au) {
    if (!r.v5_dealer) out.push(`4.0 row under DEALER_ID ${r.dealer_id}${r.dealer_name ? ` (${r.dealer_name})` : " (no 4.0 dealer record either)"} has no matching 5.0 dealer (inventory_dealer_id).`);
  }
  return Array.from(new Set(out));
}

// ── Dealer mode ───────────────────────────────────────────────────────────────
// Entering a dealer with no VIN/stock answers a different question: "is this
// dealer's inventory flowing, and what's in it?". It reuses the same dealer
// resolution and the same buildFeedInfo signals as the per-VIN report — the
// only new work is the paged inventory list. Still READ-ONLY.

/** Dealer header fields beyond DealerInfo that only dealer mode shows. */
export interface DealerDetail extends DealerInfo {
  internal_id: string | null;
  account_type: string | null;
  group_id: string | null;
  group_name: string | null;
}

export interface InventoryRow {
  id: string;
  vin: string | null;
  stock_number: string | null;
  year: number | string | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  condition: string | null;
  certified: unknown;
  status: string | null;
  msrp: number | string | null;
  date_added: string | null;
  updated_at: string | null;
  created_by: string | null;
  print_status: unknown;
  print_date: string | null;
}

export interface DealerStats {
  active_vehicles: number;
  inactive_vehicles: number;
  newest_added: string | null;
  added_7d: number;
  last_update: string | null;
}

export interface DealerReport {
  mode: "dealer";
  dealer_filter: string;
  /** Populated (and dealer null) when the filter matched 0 or >1 dealers. */
  candidates: DealerInfo[];
  dealer: DealerDetail | null;
  feed: FeedInfo | null;
  stats: DealerStats | null;
  verdict: Verdict;
  /** dealer_id != inventory_dealer_id — a common silent cause of missing inventory. */
  id_mismatch: boolean;
  inventory: InventoryRow[];
  /** Total matching the current filters (exact count), vs. what was returned. */
  total: number;
  page: number;
  page_size: number;
  include_inactive: boolean;
  search: string | null;
}

export const INVENTORY_PAGE_SIZE = 100;

const INVENTORY_COLS =
  "id, vin, stock_number, year, make, model, trim, condition, certified, status, msrp, date_added, updated_at, created_by, print_status, print_date";

const DEALER_DETAIL_COLS = `${DEALER_COLS}, internal_id, account_type, group_id`;

/**
 * One page of a dealer's inventory. Paged server-side with .range() and an
 * exact count, so a dealer with thousands of vehicles never pulls an unbounded
 * set (and never meets the PostgREST 1,000-row clamp).
 */
export async function fetchDealerInventory(
  db: Db,
  dealerTextId: string,
  opts: { page?: number; search?: string | null; includeInactive?: boolean } = {},
): Promise<{ rows: InventoryRow[]; total: number; page: number; page_size: number }> {
  const page = Math.max(0, opts.page ?? 0);
  const from = page * INVENTORY_PAGE_SIZE;
  let q = db
    .from("dealer_vehicles")
    .select(INVENTORY_COLS, { count: "exact" })
    .eq("dealer_id", dealerTextId);
  if (!opts.includeInactive) q = q.eq("status", "active");
  const search = (opts.search ?? "").trim();
  if (search) {
    const e = likeExact(search);
    // Server-side so searching doesn't require loading the whole set first.
    q = q.or(`stock_number.ilike.%${e}%,vin.ilike.%${e}%,make.ilike.%${e}%,model.ilike.%${e}%`);
  }
  const { data, count } = await q
    .order("date_added", { ascending: false, nullsFirst: false })
    .range(from, from + INVENTORY_PAGE_SIZE - 1);
  return {
    rows: (data ?? []) as InventoryRow[],
    total: count ?? 0,
    page,
    page_size: INVENTORY_PAGE_SIZE,
  };
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

function buildDealerVerdict(d: DealerDetail, feed: FeedInfo, stats: DealerStats, idMismatch: boolean): Verdict {
  const notes: string[] = [];
  const src = feed.provenance.length ? feed.provenance.join(", ") : "no recorded source";
  const staleDays = daysSince(feed.last_vehicle_update ?? stats.newest_added);

  if (idMismatch) {
    notes.push(
      `dealer_id (${d.dealer_id}) and inventory_dealer_id (${d.inventory_dealer_id ?? "—"}) DISAGREE — ` +
      `vehicles are filed under dealer_id, but the feed publishes under the inventory id. This is a common silent cause of "inventory not showing".`,
    );
  }
  if (!d.active) notes.push("Dealer record is marked inactive.");
  if (d.is_test) notes.push("This is a test account.");
  if (feed.provider) notes.push(`Inventory provider on the dealer record: ${feed.provider}.`);
  if (stats.inactive_vehicles > 0) notes.push(`${stats.inactive_vehicles.toLocaleString()} inactive/sold rows also on this id.`);

  if (stats.active_vehicles === 0) {
    notes.push(
      feed.has_live_feed
        ? "A feed roster entry exists but no active vehicles are filed under this id — check the id the feed publishes under."
        : "No feed roster entry and no feed-created vehicles — inventory would only arrive by CSV or manual add.",
    );
    return { tone: "red", headline: `No active inventory under ${d.dealer_id}`, notes };
  }

  const head = `${feed.has_live_feed ? src : "No live feed"} — ${stats.active_vehicles.toLocaleString()} active`;
  const freshness = staleDays == null ? "" : staleDays === 0 ? ", updated today" : `, last updated ${staleDays}d ago`;
  const added = `, ${stats.added_7d} added in 7d`;

  if (!feed.has_live_feed) {
    notes.push("No Fortellis/CDK/Tekion roster row and no feed-created vehicles — these rows came from CSV or manual adds.");
    return { tone: "amber", headline: `${head}${freshness}${added} — no live feed`, notes };
  }
  if (staleDays != null && staleDays >= 14) {
    notes.push(`Nothing has changed in ${staleDays} days. For a live feed that usually means the feed stopped, or it now publishes under a different id.`);
    return { tone: "red", headline: `${head}${freshness}${added} — possibly stale`, notes };
  }
  if (staleDays != null && staleDays >= 3) {
    notes.push("A healthy feed normally touches inventory at least daily.");
    return { tone: "amber", headline: `${head}${freshness}${added} — slow`, notes };
  }
  if (stats.added_7d === 0) notes.push("No new vehicles in the last 7 days — normal for a small lot, worth a look on a large one.");
  return { tone: "green", headline: `${head}${freshness}${added} — healthy`, notes };
}

/** Dealer-only lookup: feed status + a paged, searchable inventory list. */
export async function runDealerLookup(
  rawDealer: string,
  opts: { page?: number; search?: string | null; includeInactive?: boolean } = {},
): Promise<DealerReport> {
  const db: Db = createAdminSupabaseClient();
  const dealerFilter = rawDealer.trim();

  const base: Omit<DealerReport, "verdict"> & { verdict?: Verdict } = {
    mode: "dealer",
    dealer_filter: dealerFilter,
    candidates: [],
    dealer: null,
    feed: null,
    stats: null,
    id_mismatch: false,
    inventory: [],
    total: 0,
    page: Math.max(0, opts.page ?? 0),
    page_size: INVENTORY_PAGE_SIZE,
    include_inactive: !!opts.includeInactive,
    search: (opts.search ?? "").trim() || null,
  };

  // Same resolution the per-VIN report's dealer field uses.
  const matches = await resolveDealerFilter(db, dealerFilter);
  if (matches.length === 0) {
    return { ...base, verdict: { tone: "grey", headline: `No dealer matches “${dealerFilter}”`, notes: ["Try the dealer_id, the inventory_dealer_id, or part of the dealer name."] } } as DealerReport;
  }
  if (matches.length > 1) {
    return {
      ...base,
      candidates: matches,
      verdict: {
        tone: "amber",
        headline: `“${dealerFilter}” matches ${matches.length} dealers — pick one`,
        notes: ["Enter an exact dealer_id or inventory_dealer_id to go straight to a single dealer."],
      },
    } as DealerReport;
  }

  const m = matches[0];
  const { data: detailRow } = await db.from("dealers").select(DEALER_DETAIL_COLS).eq("id", m.id).maybeSingle();
  const row = (detailRow ?? m) as DealerDetail & { group_id?: string | null };
  let groupName: string | null = null;
  if (row.group_id) {
    const { data: g } = await db.from("groups").select("name").eq("id", row.group_id).maybeSingle();
    groupName = (g as { name?: string } | null)?.name ?? null;
  }
  const dealer: DealerDetail = { ...(row as DealerDetail), group_name: groupName };

  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const [feed, inv, inactiveCount, newest, added7] = await Promise.all([
    buildFeedInfo(db, dealer),
    fetchDealerInventory(db, dealer.dealer_id, opts),
    db.from("dealer_vehicles").select("id", { count: "exact", head: true }).eq("dealer_id", dealer.dealer_id).neq("status", "active"),
    db.from("dealer_vehicles").select("date_added").eq("dealer_id", dealer.dealer_id).eq("status", "active")
      .order("date_added", { ascending: false, nullsFirst: false }).limit(1),
    db.from("dealer_vehicles").select("id", { count: "exact", head: true }).eq("dealer_id", dealer.dealer_id)
      .eq("status", "active").gte("date_added", sevenDaysAgo),
  ]);

  const stats: DealerStats = {
    active_vehicles: feed.active_vehicles,
    inactive_vehicles: inactiveCount.count ?? 0,
    newest_added: (newest.data ?? [])[0]?.date_added ?? null,
    added_7d: added7.count ?? 0,
    last_update: feed.last_vehicle_update,
  };

  const idMismatch = !!dealer.inventory_dealer_id && dealer.inventory_dealer_id !== dealer.dealer_id;

  return {
    ...base,
    dealer,
    feed,
    stats,
    id_mismatch: idMismatch,
    inventory: inv.rows,
    total: inv.total,
    page: inv.page,
    verdict: buildDealerVerdict(dealer, feed, stats, idMismatch),
  } as DealerReport;
}
