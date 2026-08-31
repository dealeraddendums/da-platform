// FTP Feed Export — CSV generation for feed companies (V5.0 port of the
// DA 4.0 HUB Feeds section). Server-only.
//
// A feed company (Homenet, DealersLink, Vincue, …) has attached dealers
// (feed_company_dealers, keyed by dealers.id UUID plus the provider's own
// feed_dealer_id) and a column_mappings array [{recipientColumn, daField}].
// generateFeedCsv() walks every attached dealer's vehicles and emits one CSV
// row per vehicle with the recipient's column names.
//
// The effective option set per vehicle mirrors the print pipeline
// (pdf/generate): saved active vehicle_options gated by
// savedRowSurvivesLibraryRules, plus group options (assignment + rules +
// dismissal filtered), plus newlyAddedLibraryMatches — so the feed reports
// the same products an addendum would print. Group/assignment/dismissal
// reads are batched per dealer, not per vehicle.

import { createAdminSupabaseClient } from "@/lib/db";
import type { GroupOptionRow } from "@/lib/db";
import {
  matchesRulesRow,
  normalizeOptionName,
  newlyAddedLibraryMatches,
  savedRowSurvivesLibraryRules,
  autoMatchedLibraryRows,
  parseOptionPriceValue,
  isPipeExcludedPrice,
  libraryNameSet,
  pruneOrphanedDefaultRows,
} from "@/lib/options-engine";

export interface ColumnMapping {
  recipientColumn: string;
  daField: string;
}

export interface FeedCompanyRow {
  id: string;
  name: string;
  ftp_url: string;
  ftp_username: string;
  ftp_password: string;
  ftp_port: number;
  filename: string;
  protocol: "ftp" | "sftp";
  include_vehicles: "printed" | "all";
  push_schedule: "manual" | "hourly" | "daily";
  column_mappings: ColumnMapping[];
  last_push_at: string | null;
  last_push_status: string | null;
}

// ── DA field catalog ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dv = Record<string, any>;

const str = (v: unknown): string => (v == null ? "" : String(v));

/** Raw vehicle fields — 4.0 HUB names → V5.0 dealer_vehicles columns.
 *  DEALER_ID intentionally resolves to the PROVIDER's id for the dealer
 *  (feed_company_dealers.feed_dealer_id) — that's what the recipient keys on. */
const RAW_FIELD_EXTRACTORS: Record<string, (dv: Dv, ctx: { feedDealerId: string; dealerTextId: string }) => string> = {
  _ID:              (dv) => str(dv.id),
  BODYSTYLE:        (dv) => str(dv.body_style),
  CERTIFIED:        (dv) => (dv.condition === "CPO" ? "Yes" : "No"),
  CMPG:             (dv) => str(dv.cmpg),
  created_at:       (dv) => str(dv.date_added),
  CREATED_BY:       (dv) => str(dv.created_by),
  DATE_IN_STOCK:    (dv) => str(dv.date_in_stock ?? dv.date_added),
  DEALER_ID:        (_dv, ctx) => ctx.feedDealerId,
  DESCRIPTION:      (dv) => str(dv.description),
  DOORS:            (dv) => str(dv.doors),
  DRIVETRAIN:       (dv) => str(dv.drivetrain),
  EDIT_DATE:        (dv) => str(dv.edit_date),
  EDIT_STATUS:      (dv) => str(dv.edit_status),
  ENGINE:           (dv) => str(dv.engine),
  EXT_COLOR:        (dv) => str(dv.exterior_color),
  FUEL:             (dv) => str(dv.fuel),
  HMPG:             (dv) => str(dv.hmpg),
  INPUT_DATE:       (dv) => str(dv.input_date),
  INSP_NUMB:        (dv) => str(dv.insp_numb),
  INT_COLOR:        (dv) => str(dv.interior_color),
  INTERNET_PRICE:   (dv) => str(dv.internet_price),
  MAKE:             (dv) => str(dv.make),
  MILEAGE:          (dv) => str(dv.mileage),
  MODEL:            (dv) => str(dv.model),
  MPG:              (dv) => str(dv.mpg),
  MSRP:             (dv) => str(dv.msrp),
  MSRP_ADJUSTMENT:  (dv) => str(dv.msrp_adjustment),
  NEW_USED:         (dv) => str(dv.condition),
  OPTIONS:          (dv) => str(dv.options),
  OPTIONS_ADDED:    (dv) => str(dv.options_added),
  PHOTOS:           (dv) => str(dv.photos),
  PRINT_DATE:       (dv) => str(dv.print_date),
  PRINT_FLAG:       (dv) => str(dv.print_flag),
  PRINT_GUIDE:      (dv) => str(dv.print_guide),
  PRINT_INFO:       (dv) => str(dv.print_info),
  PRINT_QUEUE:      (dv) => str(dv.print_queue),
  PRINT_SMS:        (dv) => str(dv.print_sms),
  PRINT_STATUS:     (dv) => str(dv.print_status),
  PRINT_USER:       (dv) => str(dv.print_user),
  PT:               () => "",                       // 4.0-only column; no V5.0 equivalent
  RE_ORDER:         (dv) => str(dv.re_order),
  STATUS:           (dv) => str(dv.status),
  STATUS_CODE:      (dv) => str(dv.status_code),
  STOCK_NUMBER:     (dv) => str(dv.stock_number),
  TRANSMISSION:     (dv) => str(dv.transmission),
  TRIM:             (dv) => str(dv.trim),
  UPDATE_DATE:      (dv) => str(dv.updated_at),
  updated_at:       (dv) => str(dv.updated_at),
  VDP_LINK:         (dv) => str(dv.vdp_link),
  VIN_NUMBER:       (dv) => str(dv.vin),
  WARRANTY_EXPIRES: (dv) => str(dv.warranty_expires),
  YEAR:             (dv) => str(dv.year),
};

export const RAW_FIELDS = Object.keys(RAW_FIELD_EXTRACTORS);

export const COMPUTED_FIELDS = [
  "TOTAL_ADDS",
  "SELLING_PRICE",
  "OPTION_LIST",
  "OPTION_LIST_COMMA",
  "OPTION_PRICE",
  "OPTIONS_WITH_PRICE",
  "ADDED_MARKUP",
  "OPTIONS_WO_ADDED_MARKUP",
  "DEALER_DISCOUNTS",
  "DEALER_DISCOUNTS_NUM",
  "DEALER_DISCOUNTS_TEXT",
  "OP_PRICE_WO_DISCOUNT_MARKUP",
  "OPTIONS_WO_DISCOUNT_MARKUP",
  "ADDED_MARKUP_TEXT",
  "GRAND_TOTAL",
] as const;

export const ALL_DA_FIELDS = [...RAW_FIELDS, ...COMPUTED_FIELDS];

// ── Computed fields ──────────────────────────────────────────────────────────
//
// V5.0 pricing model (mirrors lib/pdf-html.ts): an option's price is parsed
// with parseOptionPriceValue; there is no separate markup concept on the new
// platform (ADDED_MARKUP* therefore report 0/empty), and dealer discounts are
// negative-priced option lines. So:
//   TOTAL_ADDS / OPTION_PRICE  = Σ positive option prices
//   DEALER_DISCOUNTS           = |Σ negative option prices|
//   SELLING_PRICE              = MSRP − DEALER_DISCOUNTS
//   GRAND_TOTAL                = MSRP + TOTAL_ADDS − DEALER_DISCOUNTS

interface EffectiveOption { name: string; price: number; rawPrice?: string }

// ── Custom-rule derived fields ────────────────────────────────────────────────
//
// A column can be mapped to a rule-filtered WO variant via a STABLE id-based
// reference `rule:{ruleId}:{variant}` (rename-safe — the display name never
// enters the stored mapping). Variants mirror the standard WO set: a price sum
// and a name list. (The standard WO set has no "with price" variant, so rules
// don't either.)
export const RULE_FIELD_VARIANTS = ["price", "list"] as const;
export type RuleFieldVariant = (typeof RULE_FIELD_VARIANTS)[number];

export function ruleFieldRef(ruleId: string, variant: RuleFieldVariant): string {
  return `rule:${ruleId}:${variant}`;
}

/** Parse a `rule:{id}:{variant}` daField, or null if it isn't one. */
export function parseRuleField(daField: string): { ruleId: string; variant: RuleFieldVariant } | null {
  const m = /^rule:([^:]+):(price|list)$/.exec(daField ?? "");
  if (!m) return null;
  return { ruleId: m[1], variant: m[2] as RuleFieldVariant };
}

/** Distinct rule ids referenced by a set of column mappings (for usage counts
 *  and the in-use delete guard). */
export function ruleIdsInMappings(mappings: Array<{ daField?: string }> | null | undefined): string[] {
  const ids = new Set<string>();
  for (const m of mappings ?? []) {
    const rf = parseRuleField(m?.daField ?? "");
    if (rf) ids.add(rf.ruleId);
  }
  return Array.from(ids);
}

function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, "");
}

export type RuleMode = "exclude" | "include";
export type RuleMatchType = "contains" | "exact";

/** Decode the common HTML entities operators' product names carry, so a
 *  pattern like "Doc Fee" matches "Doc Fee &amp; Handling". Mirrors the
 *  Products-page decodeNameEntities (client) — &amp; decoded last. */
function decodeEntities(s: string): string {
  if (!s) return "";
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'").replace(/&#x0*27;/gi, "'").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Build a name-matcher from a rule's patterns. `contains` = case-insensitive
 *  substring; `exact` = case-insensitive whole-name equality. Patterns OR
 *  together; empty pattern list matches nothing. Matches against the
 *  entity-decoded name. */
export function makeRuleMatcher(patterns: string[] | null | undefined, matchType: RuleMatchType = "contains"): (name: string) => boolean {
  const pats = (patterns ?? []).map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (pats.length === 0) return () => false;
  return (name: string) => {
    const hay = decodeEntities(name).trim().toLowerCase();
    return matchType === "exact" ? pats.some((p) => hay === p) : pats.some((p) => hay.includes(p));
  };
}

/**
 * Price + name list for a single rule, per mode.
 *   exclude — positive options that DON'T match (built-in negative/discount
 *     exclusion still applies; markup is always 0 on V5.0). Same semantics as
 *     the standard OP_PRICE_WO_DISCOUNT_MARKUP / OPTIONS_WO_DISCOUNT_MARKUP.
 *   include — ONLY the matching options, negatives included (built-in negative
 *     exclusion bypassed) so an "only Dealer Discounts" rule can surface
 *     negative lines; price sums the matched line values (negatives sum
 *     naturally).
 */
export function ruleFields(options: EffectiveOption[], matches: (name: string) => boolean, mode: RuleMode): { price: string; list: string } {
  const sel = mode === "include"
    ? options.filter((o) => matches(o.name))
    : options.filter((o) => o.price >= 0 && !matches(o.name));
  return { price: money(sel.reduce((s, o) => s + o.price, 0)), list: sel.map((o) => o.name).join(", ") };
}

// "Added Mark-Up" detection. The legacy 4.0 HUB feed split "Added Mark-Up"
// lines into the ADDED_MARKUP columns and excluded them from the WO fields,
// while regular options (incl. "market adjustment") stayed in WO. There is NO
// markup flag anywhere in the data — not in addendum_data (or_or_ad is uniformly
// 1 = "addendum") nor vehicle_options — so 4.0 keys purely on the item NAME.
// This regex reproduces 4.0 exactly across the Tuttle-Click fleet: it matches
// "Added Mark-Up" / "ADDED MARK-UP" / "…markup…" but NOT "market adjustment".
// Applied uniformly to every option source (legacy addendum_data and 5.0-native
// vehicle_options), since the distinction is name-based, not source-based — this
// is also what fixes the SA250377 leak where "ADDED MARK-UP" landed in the WO
// field with 0 in ADDED_MARKUP.
const ADDED_MARKUP_RE = /mark[\s-]?up/i;
function isAddedMarkup(name: string): boolean {
  return ADDED_MARKUP_RE.test(name || "");
}

/**
 * @param isCustomExcluded  drops matching products from the "without" (WO)
 *   computed outputs ONLY (price sums + option-name lists), on top of the
 *   built-in markup/discount exclusion. Non-WO fields (OPTION_LIST,
 *   OPTION_PRICE/TOTAL_ADDS, OPTIONS_WITH_PRICE, GRAND_TOTAL, SELLING_PRICE)
 *   are untouched — mirroring the existing symmetry where the WO fields exclude
 *   discounts (negatives) and the rest include everything.
 */
function computeFields(
  dv: Dv,
  options: EffectiveOption[],
  isCustomExcluded: (name: string) => boolean = () => false,
): Record<string, string> {
  // Classification (matches 4.0): a line is a DISCOUNT when its parsed price is
  // negative; an ADDED MARK-UP when its name matches the markup regex; otherwise
  // a regular positive option. Zero/|-excluded/NC lines (price 0) contribute to
  // nothing and never appear in the WO name list (this is the Doc Fee "|85|"
  // case — it must not leak into OPTIONS_WO_DISCOUNT_MARKUP).
  const positives = options.filter((o) => o.price > 0);
  const negatives = options.filter((o) => o.price < 0);
  const markups = positives.filter((o) => isAddedMarkup(o.name));
  const totalAdds = positives.reduce((s, o) => s + o.price, 0); // incl. markup
  const markupTotal = markups.reduce((s, o) => s + o.price, 0);
  const discounts = Math.abs(negatives.reduce((s, o) => s + o.price, 0));
  const msrp = typeof dv.msrp === "number" ? dv.msrp : parseFloat(String(dv.msrp ?? "")) || 0;

  // The "without discount & markup" set: positive options that are neither an
  // added-markup line nor dropped by a custom name-exclusion. (Discounts are
  // negative and already excluded.)
  const woPositives = positives.filter((o) => !isAddedMarkup(o.name) && !isCustomExcluded(o.name));
  const woTotal = woPositives.reduce((s, o) => s + o.price, 0);

  // Sanity guard (2026-08-05): with no base price there is no meaningful
  // GRAND_TOTAL or SELLING_PRICE — options-only math produced NEGATIVE grand
  // totals on unpriced vehicles (GRAND_TOTAL = -8000 when the row was just a
  // discount; Tuttle Tustin / Lincoln Irvine spot check). A BLANK cell tells
  // the provider "no value"; a negative or options-only number is wrong data.
  // Option/discount/markup/WO columns still emit — they're price-independent.
  const hasBase = msrp > 0;

  return {
    TOTAL_ADDS: money(totalAdds),
    SELLING_PRICE: hasBase ? money(msrp - discounts) : "",
    OPTION_LIST: options.map((o) => o.name).join("\n"),
    OPTION_LIST_COMMA: options.map((o) => o.name).join(", "),
    OPTION_PRICE: money(totalAdds),
    OPTIONS_WITH_PRICE: options.map((o) => `${o.name}: $${money(o.price)}`).join("\n"),
    ADDED_MARKUP: money(markupTotal),
    OPTIONS_WO_ADDED_MARKUP: money(woTotal),
    DEALER_DISCOUNTS: money(discounts),
    DEALER_DISCOUNTS_NUM: money(discounts),
    DEALER_DISCOUNTS_TEXT: negatives.map((o) => o.name).join(", "),
    OP_PRICE_WO_DISCOUNT_MARKUP: money(woTotal),
    OPTIONS_WO_DISCOUNT_MARKUP: woPositives.map((o) => o.name).join(", "),
    ADDED_MARKUP_TEXT: markups.map((o) => o.name).join(", "),
    GRAND_TOTAL: hasBase ? money(msrp + totalAdds - discounts) : "",
  };
}

// ── CSV helpers ──────────────────────────────────────────────────────────────

function csvCell(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// ── Vehicle shape for the rules engine (matches pdf/generate's vehicleData) ──

function toRulesVehicle(dv: Dv, dealerTextId: string) {
  return {
    id: 0 as const,
    DEALER_ID: dealerTextId,
    VIN_NUMBER: dv.vin ?? "",
    STOCK_NUMBER: dv.stock_number,
    YEAR: dv.year != null ? String(dv.year) : null,
    MAKE: dv.make,
    MODEL: dv.model,
    TRIM: dv.trim,
    BODYSTYLE: dv.body_style,
    EXT_COLOR: dv.exterior_color,
    INT_COLOR: dv.interior_color,
    ENGINE: dv.engine,
    FUEL: dv.fuel ?? null,
    DRIVETRAIN: dv.drivetrain,
    TRANSMISSION: dv.transmission,
    MILEAGE: dv.mileage != null ? String(dv.mileage) : null,
    DATE_IN_STOCK: dv.date_added,
    STATUS: "1" as const,
    MSRP: dv.msrp != null ? String(dv.msrp) : null,
    NEW_USED: dv.condition === "Used" ? "Used" : "New",
    CERTIFIED: dv.condition === "CPO" ? "Yes" : "No",
    OPTIONS: null,
    PHOTOS: null,
    DESCRIPTION: dv.description,
    PRINT_STATUS: "0" as const,
    HMPG: dv.hmpg ?? null,
    CMPG: dv.cmpg ?? null,
    MPG: dv.mpg ?? null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

async function fetchAllRows<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await q(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── Main generator ───────────────────────────────────────────────────────────

export interface FeedCsvResult {
  csv: string;
  vehicleCount: number;
  dealerCount: number;
}

export async function generateFeedCsv(feedId: string): Promise<FeedCsvResult> {
  const admin: Admin = createAdminSupabaseClient();

  const { data: feed } = await admin
    .from("feed_companies")
    .select("*")
    .eq("id", feedId)
    .maybeSingle() as { data: FeedCompanyRow | null };
  if (!feed) throw new Error("Feed company not found");

  const mappings: ColumnMapping[] = Array.isArray(feed.column_mappings)
    ? feed.column_mappings.filter((m) => m && m.recipientColumn && m.daField)
    : [];
  if (mappings.length === 0) throw new Error("No column mappings configured for this feed");

  // Custom-rule derived fields: any column mapped to `rule:{id}:{variant}` emits
  // a rule-filtered variant (exclude mode → WO-style: positives minus matches;
  // include mode → only matches, negatives included). Standard COMPUTED_FIELDS
  // stay built-in-only. Load every referenced rule up front; a mapping pointing
  // at a deleted rule fails the export loudly rather than silently emitting
  // unfiltered data.
  const referencedRuleIds = Array.from(new Set(
    mappings.map((m) => parseRuleField(m.daField)?.ruleId).filter((x): x is string => Boolean(x)),
  ));
  const ruleResolvers = new Map<string, { matches: (name: string) => boolean; mode: RuleMode }>();
  if (referencedRuleIds.length > 0) {
    const { data: ruleRows } = await admin
      .from("feed_exclusion_rules")
      .select("id, patterns, mode, match_type")
      .in("id", referencedRuleIds) as { data: Array<{ id: string; patterns: string[] | null; mode: RuleMode | null; match_type: RuleMatchType | null }> | null };
    const byId = new Map((ruleRows ?? []).map((r) => [r.id, r]));
    for (const id of referencedRuleIds) {
      const r = byId.get(id);
      if (!r) throw new Error(`Column mapping references a deleted custom rule (${id}). Fix the mapping before exporting.`);
      ruleResolvers.set(id, {
        matches: makeRuleMatcher(r.patterns ?? [], r.match_type ?? "contains"),
        mode: r.mode ?? "exclude",
      });
    }
  }

  const { data: feedDealers } = await admin
    .from("feed_company_dealers")
    .select("dealer_uuid, feed_dealer_id, dealers(id, dealer_id, name, group_id, migration_status)")
    .eq("feed_company_id", feedId) as {
      data: Array<{
        dealer_uuid: string;
        feed_dealer_id: string;
        dealers: { id: string; dealer_id: string; name: string; group_id: string | null; migration_status: string | null } | null;
      }> | null;
    };

  const rows: string[][] = [mappings.map((m) => m.recipientColumn)];
  let vehicleCount = 0;

  for (const fd of feedDealers ?? []) {
    const dealer = fd.dealers;
    if (!dealer) continue;
    const dealerTextId = dealer.dealer_id;
    const ctx = { feedDealerId: fd.feed_dealer_id, dealerTextId };

    // 1. Vehicles for this dealer (paginated; feed scope per include_vehicles).
    const vehicles = await fetchAllRows<Dv>((from, to) => {
      let q = admin
        .from("dealer_vehicles")
        .select("*")
        .eq("dealer_id", dealerTextId)
        .eq("status", "active")
        .order("id", { ascending: true })
        .range(from, to);
      if (feed.include_vehicles === "printed") q = q.eq("print_status", 1);
      return q;
    });
    if (vehicles.length === 0) continue;

    // 2. Dealer library (once) → rules-by-name map for the saved-row gate +
    //    the newly-added-matches merge, same as pdf/generate.
    const libRows = await fetchAllRows<Dv>((from, to) => admin
      .from("addendum_library")
      .select("id, option_name, item_price, required, active, created_at, applies_to, ad_types, makes, makes_not, models, models_not, trims, trims_not, body_styles, fuel, fuel_not, year_condition, year_value, miles_condition, miles_value, msrp_condition, msrp1, msrp2")
      .eq("dealer_id", dealerTextId)
      .range(from, to));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const libRulesByName = new Map<string, any[]>();
    for (const lr of libRows) {
      const name = normalizeOptionName(lr.option_name);
      const arr = libRulesByName.get(name) ?? [];
      arr.push(lr);
      libRulesByName.set(name, arr);
    }

    // 3. Saved options for all the dealer's vehicles (chunked IN on vehicle id).
    const vehicleIds = vehicles.map((v) => String(v.id));
    const savedByVehicle = new Map<string, Dv[]>();
    for (const ids of chunk(vehicleIds, 200)) {
      const opts = await fetchAllRows<Dv>((from, to) => admin
        .from("vehicle_options")
        .select("vehicle_id, option_name, option_price, source, active, created_at, updated_at")
        .in("vehicle_id", ids)
        .eq("active", true)
        .range(from, to));
      for (const o of opts) {
        const key = String(o.vehicle_id);
        const arr = savedByVehicle.get(key) ?? [];
        arr.push(o);
        savedByVehicle.set(key, arr);
      }
    }

    // 4. Group options — rows + assignments once per dealer, dismissals
    //    batched over all vehicle ids (in-memory per-vehicle filtering below).
    let groupRows: GroupOptionRow[] = [];
    let assignedIds = new Set<string>();
    const dismissedByVehicle = new Map<string, Set<string>>();
    if (dealer.group_id) {
      const { data: gRows } = await admin
        .from("group_options")
        .select("*")
        .eq("group_id", dealer.group_id)
        .eq("active", true)
        .order("sort_order") as { data: GroupOptionRow[] | null };
      groupRows = gRows ?? [];
      const selectScopeIds = groupRows.filter((r) => r.assign_all_dealers === false).map((r) => r.id);
      if (selectScopeIds.length > 0) {
        const { data: assigns } = await admin
          .from("dealer_option_assignments")
          .select("option_id")
          .eq("dealer_id", dealer.id)
          .eq("group_id", dealer.group_id)
          .eq("dealer_editable", false)
          .in("option_id", selectScopeIds) as { data: Array<{ option_id: string }> | null };
        assignedIds = new Set((assigns ?? []).map((a) => a.option_id));
      }
      if (groupRows.length > 0) {
        for (const ids of chunk(vehicleIds, 200)) {
          const { data: dismissals } = await admin
            .from("dealer_dismissed_group_options")
            .select("vehicle_id, group_option_id")
            .in("vehicle_id", ids) as { data: Array<{ vehicle_id: string; group_option_id: string }> | null };
          for (const d of dismissals ?? []) {
            const key = String(d.vehicle_id);
            const set = dismissedByVehicle.get(key) ?? new Set<string>();
            set.add(d.group_option_id);
            dismissedByVehicle.set(key, set);
          }
        }
      }
    }

    // 4b. Legacy addendum source. Unmigrated dealers (all of Tuttle-Click, etc.)
    //     have an EMPTY vehicle_options table — that's only populated by console
    //     Sync, never run for them — so the live widget/PDF and the 4.0 HUB read
    //     the vehicle's addendum from `addendum_data` (Aurora-synced nightly,
    //     Job 7). Mirror da-api-service getVehicleOptions: fetch once per dealer,
    //     group by VIN, dedup by item_name keeping the newest created_at (this
    //     table accumulates stale/duplicate rows from two ETL paths), order by
    //     order_by. Used ONLY as a per-vehicle fallback when the 5.0 pipeline
    //     yields nothing, so migrated/synced dealers are unaffected.
    const addendumByVin = new Map<string, EffectiveOption[]>();
    {
      const adRows = await fetchAllRows<Dv>((from, to) => admin
        .from("addendum_data")
        .select("vin_number, item_name, item_price, created_at, order_by")
        .eq("legacy_dealer_id", dealerTextId)
        .in("active", ["1", "yes"])
        .range(from, to));
      const byVinName = new Map<string, Map<string, Dv>>();
      for (const r of adRows) {
        const vin = String(r.vin_number ?? "").trim().toUpperCase();
        const name = String(r.item_name ?? "");
        if (!vin || !name) continue;
        const m = byVinName.get(vin) ?? new Map<string, Dv>();
        const prev = m.get(name);
        if (!prev || String(r.created_at ?? "") > String(prev.created_at ?? "")) m.set(name, r);
        byVinName.set(vin, m);
      }
      byVinName.forEach((m, vin) => {
        const items = (Array.from(m.values()) as Dv[]).sort((a, b) => (Number(a.order_by) || 0) - (Number(b.order_by) || 0));
        addendumByVin.set(vin, items.map((it) => ({ name: String(it.item_name), price: parseOptionPriceValue(it.item_price), rawPrice: String(it.item_price ?? "") })));
      });
    }

    // 5. Per-vehicle: effective options → computed fields → mapped CSV row.
    // Orphan gate: a saved source:"default" row whose library product was
    // deleted must not export (same prune as the print paths — Jenkins
    // Traverse 2026-08-31). Manual one-offs are kept.
    const libNames = libraryNameSet(libRows as Array<{ option_name?: string | null }>);

    for (const dv of vehicles) {
      const rulesVehicle = toRulesVehicle(dv, dealerTextId);
      const saved = pruneOrphanedDefaultRows(
        (savedByVehicle.get(String(dv.id)) ?? []) as Array<Dv & { option_name: string; source?: string | null }>,
        libNames,
      );

      const savedFiltered = saved.filter((r) =>
        savedRowSurvivesLibraryRules(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (libRulesByName.get(normalizeOptionName(r.option_name)) ?? []) as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          rulesVehicle as any,
          r.option_name,
        ),
      );
      const freshLib = newlyAddedLibraryMatches(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        libRows as any[],
        saved as Array<{ option_name: string; created_at?: string | null; updated_at?: string | null }>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rulesVehicle as any,
      );
      const dismissed = dismissedByVehicle.get(String(dv.id)) ?? new Set<string>();
      const groupEffective = groupRows
        .filter((r) => (r.assign_all_dealers !== false ? true : assignedIds.has(r.id)))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((r) => matchesRulesRow(r as any, rulesVehicle as any))
        .filter((r) => !dismissed.has(r.id));

      let effective: EffectiveOption[] = [
        ...groupEffective.map((g) => ({ name: g.option_name, price: parseOptionPriceValue(g.option_price), rawPrice: String(g.option_price ?? "") })),
        ...savedFiltered.map((s) => ({ name: String(s.option_name), price: parseOptionPriceValue(s.option_price), rawPrice: String(s.option_price ?? "") })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...freshLib.map((l: any) => ({ name: String(l.option_name), price: parseOptionPriceValue(l.item_price), rawPrice: String(l.item_price ?? "") })),
      ];

      // Legacy addendum_data items MERGE with the 5.0 rows for UNMIGRATED
      // dealers (2026-08-06, Tuttle Commercial FC470000 proof case): the old
      // either/or fallback fired only when the 5.0 pipeline yielded NOTHING,
      // so one leftover 5.0 row (a pipe-priced Doc Fee) suppressed the entire
      // legacy addendum — the MARATHON body vanished from the export while the
      // vehicle page's Legacy section promised it "appears in feeds".
      //
      // Merge rules:
      //   • 5.0 rows FIRST, then legacy items whose name doesn't match any 5.0
      //     row (case-insensitive, entity-decoded) — intentional 5.0 edits stay
      //     authoritative on name collisions.
      //   • Vehicle with ONLY legacy items ⇒ merge with empty 5.0 set = the old
      //     fallback output, unchanged.
      //   • Migrated dealers: NO merge, ever — their behavior is exactly the
      //     old either/or (5.0 rows, with the empty-set fallbacks below).
      //   • The pipe gate below applies to the merged set (pipe items from
      //     EITHER source stay out of the export).
      // The library seed (autoMatchedLibraryRows — never-saved 5.0 vehicles)
      // still only fires when BOTH sources are empty; addendum_data keeps
      // precedence over it (the 2026-07-31 lesson: the seed must not pre-empt
      // authoritative legacy data).
      const mergeLegacy = dealer.migration_status !== "migrated";
      const legacy = addendumByVin.get(String(dv.vin ?? "").trim().toUpperCase()) ?? [];
      const dedupeKey = (n: string) => decodeEntities(String(n)).trim().toLowerCase();
      if (mergeLegacy && legacy.length > 0) {
        const names50 = new Set(effective.map((o) => dedupeKey(o.name)));
        effective = [...effective, ...legacy.filter((l) => !names50.has(dedupeKey(l.name)))];
      } else if (effective.length === 0) {
        if (legacy.length > 0) {
          effective = legacy; // migrated-dealer fallback — unchanged behavior
        } else if (saved.length === 0 && !(dv as Record<string, unknown>).options_saved_at) {
          // options_saved_at set + zero rows = deliberately emptied — never re-seed.
          effective = autoMatchedLibraryRows(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            libRows as any[],
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            rulesVehicle as any,
          ).map((s) => ({ name: s.option_name, price: parseOptionPriceValue(s.option_price), rawPrice: String(s.option_price ?? "") }));
        }
      }

      // SINGLE SOURCE GATE: drop pipe-priced (`|N`) products from the export
      // entirely — Allan's rule is they "show on the addendum but never appear
      // in ANY exported field" (no WO/list/price/discount/markup column, no
      // custom-rule column, include OR exclude mode). Filtering here, before any
      // field computation, covers both data sources at once. (The printed
      // addendum still shows them — that path is unaffected; see 23d09ef.)
      effective = effective.filter((o) => !isPipeExcludedPrice(o.rawPrice));

      // Option names are stored as rich-text HTML (e.g. "SCELZI 11&#039; UTILTY").
      // The 4.0 HUB emits plain decoded text in the CSV; decode so name lists
      // (OPTIONS_WO_DISCOUNT_MARKUP, DEALER_DISCOUNTS_TEXT, ADDED_MARKUP_TEXT, …)
      // match rather than differing only by entity encoding.
      effective = effective.map((o) => ({ name: decodeEntities(o.name), price: o.price }));

      // Standard computed fields use built-in exclusion only (no custom rule).
      const computed = computeFields(dv, effective);
      // Per-rule WO variants, computed on demand and memoized per vehicle.
      const ruleFieldCache = new Map<string, string>();
      rows.push(mappings.map((m) => {
        const raw = RAW_FIELD_EXTRACTORS[m.daField];
        if (raw) return raw(dv, ctx);
        if (m.daField in computed) return computed[m.daField];
        const rf = parseRuleField(m.daField);
        if (rf) {
          const key = m.daField;
          if (!ruleFieldCache.has(key)) {
            const resolver = ruleResolvers.get(rf.ruleId)!; // presence guaranteed above
            const rfv = ruleFields(effective, resolver.matches, resolver.mode);
            ruleFieldCache.set(`rule:${rf.ruleId}:price`, rfv.price);
            ruleFieldCache.set(`rule:${rf.ruleId}:list`, rfv.list);
          }
          return ruleFieldCache.get(key) ?? "";
        }
        return "";
      }));
      vehicleCount++;
    }
  }

  return { csv: toCsv(rows), vehicleCount, dealerCount: (feedDealers ?? []).length };
}
