// Monthly ChromeData usage report builder.
//
// Finds dealers who (a) print with the Vehicle Photo widget, (b) printed > 10
// vehicles in the reported month, (c) are active + paid + not a test/demo
// account, then emits an .xlsx file matching the ChromeData billing template
// (Contract #9310). Used by both the monthly cron job and the manual-trigger
// button on the Reports page.
//
// CROSS-PLATFORM (2026-09-05). The first automated run reported "Locations
// reported: 0" because this builder only looked at 5.0 (Supabase) — and the
// dealers actually printing with vehicle photos are overwhelmingly still on
// 4.0, where the usage lives in Aurora. The report is now the UNION of:
//
//   • the 4.0 / Aurora branch — fetched from the ETL box's read-only
//     POST /chromedata-usage (da-platform has no network path to Aurora; its
//     AURORA_HOST env still names a decommissioned blue/green cluster), and
//   • the 5.0 / Supabase branch below,
//
// deduped so a dealer that exists on both platforms is counted exactly once.
// Both branches use the same > 10 threshold, the same half-open month window,
// and the same test/demo name exclusion.

import ExcelJS from "exceljs";
import { createAdminSupabaseClient } from "@/lib/db";

const CONTRACT_NUMBER = "9310";
const PRINT_THRESHOLD = 10;
// "demo" added 2026-09-05 — STARSHIELD DEMO ACCOUNT and Millennium Dealer
// Services DEMO Account are 4.0 demo rooftops that qualify on prints and must
// never be billed to ChromeData. Applied to BOTH platforms' dealer names
// (Aurora has no is_test flag, so the name is the cross-platform filter).
const EXCLUSION_RE = /(test|demo|allan)/i;

// Token strings we look for inside templates.template_json / group_templates.
// Both formats are valid: the new bare 'vehiclephoto' type and the legacy
// infobox-with-ibType-photo combo. Old saved templates that haven't been
// re-saved in the Builder still carry the legacy shape.
const VEHICLEPHOTO_TOKENS = [
  '"type":"vehiclephoto"',
  '"ibType":"photo"',
];

interface DealerReportRow {
  template_name: string;
  /**
   * The dealer identifier printed in ChromeData's "Dealer ID" column. This is
   * the Aurora-style DEALER_ID on both platforms (4.0: dealer_dim.DEALER_ID;
   * 5.0: dealers.inventory_dealer_id, which is the same value) so the sheet
   * keeps one ID convention — matching every report sent before this one.
   */
  dealer_id: string;
  dealer_name: string;
  print_count: number;
  /** Which platform this dealer's usage was counted on. */
  platform: "4.0" | "5.0";
}

/** One row as returned by the ETL box's read-only /chromedata-usage endpoint. */
interface LegacyUsageRow {
  dealer_id: string;
  dealer_name: string;
  account_type: string | null;
  template_name: string;
}

export interface ChromeReportResult {
  /** YYYY-MM of the reported month, e.g. "2026-04". */
  month: string;
  /** Pretty label, e.g. "April 2026". */
  monthLabel: string;
  /** First day of reported month, ISO date. */
  monthStart: string;
  /** First day of the FOLLOWING month, ISO date (exclusive upper bound). */
  monthEnd: string;
  /** Last day of reported month, ISO date (inclusive — used in the email body). */
  monthLastDay: string;
  /** Final filtered + sorted rows. */
  rows: DealerReportRow[];
  /** Excel file as a Buffer. */
  xlsxBuffer: Buffer;
  /** Suggested filename. */
  filename: string;
}

/** True if a template_json string contains any vehicle-photo widget marker. */
function templateUsesVehiclePhoto(templateJsonText: string): boolean {
  return VEHICLEPHOTO_TOKENS.some(token => templateJsonText.includes(token));
}

/**
 * Compute the previous calendar month from a reference date. Returns ISO
 * strings for the month start, end (exclusive), and last day (inclusive)
 * plus a pretty label. Pass an explicit YYYY-MM to override (used by the
 * manual-trigger button on the Reports page).
 */
export function resolveReportMonth(override?: string | null, now: Date = new Date()): {
  month: string;
  monthLabel: string;
  monthStart: string;
  monthEnd: string;
  monthLastDay: string;
} {
  let year: number;
  let month: number; // 0-indexed
  if (override && /^\d{4}-\d{2}$/.test(override)) {
    const [y, m] = override.split("-").map(s => parseInt(s, 10));
    year = y;
    month = m - 1;
  } else {
    // Previous calendar month relative to `now`.
    const ref = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    year = ref.getUTCFullYear();
    month = ref.getUTCMonth();
  }
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  const monthLabel = start.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    month: `${year}-${pad(month + 1)}`,
    monthLabel,
    monthStart: start.toISOString().slice(0, 10),
    monthEnd: end.toISOString().slice(0, 10),
    monthLastDay: lastDay.toISOString().slice(0, 10),
  };
}

/**
 * Fetch the 4.0 (Aurora) half of the report from the ETL box.
 *
 * da-platform cannot talk to Aurora directly: its AURORA_* env still names a
 * decommissioned blue/green cluster endpoint and, even with the live reader
 * hostname, the us-west-1 app box has no route to the legacy VPC's private
 * RDS address. The ETL box already holds read-only Aurora credentials and
 * already exposes X-API-Key machine endpoints to da-platform (/sync,
 * /freshbooks/recurring-pause), so the query lives there and we consume rows.
 *
 * This THROWS on any failure rather than degrading to a 5.0-only report: a
 * partial number sent to a vendor is worse than no send, and an under-count is
 * exactly the failure this whole fix exists to correct.
 */
async function fetchLegacyUsageRows(monthStart: string, monthEnd: string): Promise<LegacyUsageRow[]> {
  const etlUrl = process.env.ETL_SYNC_URL;
  const etlKey = process.env.ETL_SYNC_API_KEY;
  if (!etlUrl || !etlKey) {
    throw new Error(
      "ETL_SYNC_URL / ETL_SYNC_API_KEY not configured — the 4.0 half of the ChromeData report cannot be built.",
    );
  }
  const controller = new AbortController();
  // The Aurora query carries a correlated per-dealer COUNT over
  // dealer_inventory; it runs in seconds today but is not cheap.
  const timer = setTimeout(() => controller.abort(), 300_000);
  let res: Response;
  try {
    res = await fetch(`${etlUrl.replace(/\/$/, "")}/chromedata-usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": etlKey },
      body: JSON.stringify({ month_start: monthStart, month_end_exclusive: monthEnd }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`ETL /chromedata-usage request failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`ETL /chromedata-usage returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as { rows?: LegacyUsageRow[] };
  if (!Array.isArray(json.rows)) {
    throw new Error("ETL /chromedata-usage returned no rows array");
  }
  return json.rows;
}

/**
 * Normalise a dealer identifier for cross-platform matching. Aurora
 * DEALER_IDs and Supabase dealer_id/inventory_dealer_id are the same values
 * but drift in case and padding ("SURF CITY NISSAN", "mp23083").
 */
const normId = (v: string | null | undefined): string => (v ?? "").trim().toUpperCase();

/**
 * Build the full report for a given month. Returns the data rows + the
 * Excel buffer ready to attach to email / upload to S3.
 */
export async function buildChromeDataReport(monthOverride?: string | null): Promise<ChromeReportResult> {
  const m = resolveReportMonth(monthOverride);
  const admin = createAdminSupabaseClient();

  // ── 1. Find every dealer-level template that uses Vehicle Photo ───────────
  // template_json is jsonb and Supabase JS doesn't expose ::text casts via
  // PostgREST. Templates are bounded (~hundreds across the platform), so
  // pull them all and grep client-side.
  //
  // NOTE: templates.dealer_id is the TEXT dealer key (FK → dealers.dealer_id),
  // NOT the dealers.id UUID. This map is therefore keyed by the text id and
  // looked up with dealer.dealer_id in step 4. Keying it by UUID (as the
  // original did) meant the dealer-level branch never matched a single dealer
  // — only the group branch ever contributed.
  const dealerTemplateMatches = new Map<string, string>(); // dealers.dealer_id (text) → template name
  let from = 0;
  while (true) {
    const { data, error } = await admin
      .from("templates")
      .select("name, dealer_id, template_json")
      .eq("is_active", true)
      .range(from, from + 999);
    if (error) throw new Error(`templates fetch failed: ${error.message}`);
    const rows = data ?? [];
    for (const t of rows) {
      const txt = JSON.stringify(t.template_json ?? {});
      if (!templateUsesVehiclePhoto(txt)) continue;
      // The first matching template wins for the report's "Template Name"
      // column. ChromeData just wants ONE line per dealer, so first-wins is fine.
      const key = normId(t.dealer_id as string | null);
      if (key && !dealerTemplateMatches.has(key)) {
        dealerTemplateMatches.set(key, (t.name as string) ?? "(unnamed)");
      }
    }
    if (rows.length < 1000) break;
    from += 1000;
  }

  // ── 2. Find every group-level template that uses Vehicle Photo ───────────
  // Group templates implicitly cover all dealers in the group.
  const groupTemplateMatches = new Map<string, string>(); // group_id (uuid) → template name
  from = 0;
  while (true) {
    const { data, error } = await admin
      .from("group_templates")
      .select("name, group_id, template_json")
      .eq("is_active", true)
      .range(from, from + 999);
    if (error) throw new Error(`group_templates fetch failed: ${error.message}`);
    const rows = data ?? [];
    for (const t of rows) {
      const txt = JSON.stringify(t.template_json ?? {});
      if (!templateUsesVehiclePhoto(txt)) continue;
      if (t.group_id && !groupTemplateMatches.has(t.group_id as string)) {
        groupTemplateMatches.set(t.group_id as string, (t.name as string) ?? "(unnamed)");
      }
    }
    if (rows.length < 1000) break;
    from += 1000;
  }

  // ── 3. Load all qualifying-by-eligibility dealers ────────────────────────
  // active + paid + not test + name doesn't match exclusion regex
  const dealers: Array<{
    id: string; dealer_id: string; inventory_dealer_id: string | null;
    name: string; group_id: string | null;
  }> = [];
  from = 0;
  while (true) {
    const { data, error } = await admin
      .from("dealers")
      .select("id, dealer_id, inventory_dealer_id, name, group_id, active, is_test, account_type")
      .eq("active", true)
      .range(from, from + 999);
    if (error) throw new Error(`dealers fetch failed: ${error.message}`);
    const rows = data ?? [];
    for (const d of rows) {
      const r = d as { id: string; dealer_id: string; inventory_dealer_id: string | null; name: string;
                       group_id: string | null; active: boolean; is_test: boolean | null;
                       account_type: string | null };
      if (r.is_test === true) continue;
      const accountType = (r.account_type ?? "").trim();
      if (!accountType || accountType === "Free" || accountType === "Trial") continue;
      if (EXCLUSION_RE.test(r.name ?? "")) continue;
      dealers.push({
        id: r.id, dealer_id: r.dealer_id, inventory_dealer_id: r.inventory_dealer_id,
        name: r.name, group_id: r.group_id,
      });
    }
    if (rows.length < 1000) break;
    from += 1000;
  }

  // ── 4. Filter to dealers whose template OR whose group's template uses ───
  //      the Vehicle Photo widget, attaching the matched template name.
  const candidates: Array<DealerReportRow & { dealer_text_id: string }> = [];
  for (const d of dealers) {
    let templateName = dealerTemplateMatches.get(normId(d.dealer_id));
    if (!templateName && d.group_id) {
      templateName = groupTemplateMatches.get(d.group_id);
    }
    if (!templateName) continue;
    candidates.push({
      template_name: templateName,
      dealer_id: d.inventory_dealer_id ?? d.dealer_id,
      dealer_name: d.name,
      print_count: 0,
      platform: "5.0",
      dealer_text_id: d.dealer_id,
    });
  }

  // ── 5. Count prints in the reported month per dealer ────────────────────
  // dealer_vehicles.print_date is the canonical "this car was printed on
  // <date>" field, print_status=1 means printed (vs reset). Count rows
  // where print_date falls inside the reported month.
  const candidateDealerIds = candidates.map(c => c.dealer_text_id);
  if (candidateDealerIds.length > 0) {
    // Chunk the dealer IN list to avoid blowing past PostgREST URL limits.
    const CHUNK = 100;
    const countsByDealer = new Map<string, number>();
    for (let i = 0; i < candidateDealerIds.length; i += CHUNK) {
      const slice = candidateDealerIds.slice(i, i + CHUNK);
      // Pull every matching row in this slice and tally client-side. With
      // print_status=1 and a one-month window, this stays bounded per dealer.
      let pageFrom = 0;
      while (true) {
        const { data } = await admin
          .from("dealer_vehicles")
          .select("dealer_id, print_date")
          .in("dealer_id", slice)
          .eq("print_status", 1)
          .gte("print_date", m.monthStart)
          .lt("print_date", m.monthEnd)
          .range(pageFrom, pageFrom + 999);
        const rows = data ?? [];
        for (const r of rows) {
          const did = (r as { dealer_id: string }).dealer_id;
          countsByDealer.set(did, (countsByDealer.get(did) ?? 0) + 1);
        }
        if (rows.length < 1000) break;
        pageFrom += 1000;
      }
    }
    for (const c of candidates) {
      c.print_count = countsByDealer.get(c.dealer_text_id) ?? 0;
    }
  }

  // ── 6. Apply the > 10 prints threshold to the 5.0 side ───────────────────
  const platformRows: DealerReportRow[] = candidates
    .filter(c => c.print_count > PRINT_THRESHOLD)
    .map(({ template_name, dealer_id, dealer_name, print_count, platform }) => ({
      template_name, dealer_id, dealer_name, print_count, platform,
    }));

  // Every identifier the 5.0 side already accounts for. A migrated dealer can
  // exist in both dealer_dim and dealers; both its text id and its inventory
  // id go in so an Aurora DEALER_ID matches whichever convention it uses.
  const claimedBy50 = new Set<string>();
  for (const c of candidates) {
    if (c.print_count <= PRINT_THRESHOLD) continue;
    claimedBy50.add(normId(c.dealer_text_id));
    claimedBy50.add(normId(c.dealer_id));
  }

  // ── 7. Fold in the 4.0 (Aurora) side, deduped ────────────────────────────
  // The ETL box returns one row per (dealer, template) and already applies the
  // active / paid / > 10-prints / vehicle_image gates. Collapse to one row per
  // dealer, drop test+demo names, and skip anyone the 5.0 side already claimed.
  const legacyRows = await fetchLegacyUsageRows(m.monthStart, m.monthEnd);
  const legacyByDealer = new Map<string, DealerReportRow>();
  for (const r of legacyRows) {
    const key = normId(r.dealer_id);
    if (!key) continue;
    if (EXCLUSION_RE.test(r.dealer_name ?? "")) continue;
    if (claimedBy50.has(key)) continue;         // counted on 5.0 — never twice
    if (legacyByDealer.has(key)) continue;      // first template name wins
    legacyByDealer.set(key, {
      template_name: r.template_name || "(unnamed)",
      dealer_id: r.dealer_id,
      dealer_name: r.dealer_name,
      // The 4.0 branch qualifies on a > 10 count computed in SQL; the exact
      // number is not reported to ChromeData (the sheet has no count column).
      print_count: PRINT_THRESHOLD + 1,
      platform: "4.0",
    });
  }

  // ── 8. Union + sort alphabetically by dealership name ────────────────────
  const finalRows: DealerReportRow[] = [...platformRows, ...Array.from(legacyByDealer.values())]
    .sort((a, b) => a.dealer_name.trim().localeCompare(b.dealer_name.trim()));
  // ── 9. Build the .xlsx ───────────────────────────────────────────────────
  const xlsxBuffer = await renderXlsx(m, finalRows);
  const filename = `ChromeData_Usage_${m.month.replace("-", "_")}.xlsx`;
  return { ...m, rows: finalRows, xlsxBuffer, filename };
}

/**
 * Render the report rows to an .xlsx Buffer matching ChromeData's billing
 * template (verified against February 2025 sample, 3 columns + leading
 * blank rows):
 *
 *   Row  1: (blank)
 *   Row  2: (blank)
 *   Row  3: DealerAddendums Inc
 *   Row  4: Contract # 9310
 *   Row  5: Please send to billing@chromedata.com…
 *   Row  6: (blank)
 *   Row  7: Month Reporting: | <date>
 *   Row  8: Location TOTAL:  | <count>
 *   Row  9: (blank)
 *   Row 10: Template Name | Dealer ID | Dealership Name
 *   Row 11+: data rows, sorted alphabetically by dealership name
 *
 * Dealer ID is stored as a number when the dealer id is purely numeric
 * (matches the existing template where IDs like 269, 1616 are right-aligned
 * integers). Falls back to a string for MP-style codes.
 */
async function renderXlsx(m: { monthStart: string; monthLabel: string }, rows: DealerReportRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");

  // Rows are 1-based in ExcelJS. addRow advances by 1 each call.
  ws.addRow([]);                                                                       // row 1: blank
  ws.addRow([]);                                                                       // row 2: blank
  ws.addRow(["DealerAddendums Inc"]);                                                  // row 3
  ws.addRow([`Contract # ${CONTRACT_NUMBER}`]);                                        // row 4
  ws.addRow(["Please send to billing@chromedata.com, no later than the 10th of the month"]); // row 5
  ws.addRow([]);                                                                       // row 6: blank
  ws.addRow(["Month Reporting:", new Date(m.monthStart + "T00:00:00Z")]);              // row 7
  ws.addRow(["Location TOTAL:", rows.length]);                                         // row 8
  ws.addRow([]);                                                                       // row 9: blank
  ws.addRow(["Template Name", "Dealer ID", "Dealership Name"]);                        // row 10: header
  for (const r of rows) {
    // ChromeData's sample has Dealer ID as a right-aligned integer when it
    // is purely numeric; preserve that. MP-style codes stay as strings.
    const idValue: string | number = /^\d+$/.test(r.dealer_id) ? Number(r.dealer_id) : r.dealer_id;
    ws.addRow([r.template_name, idValue, r.dealer_name]);
  }

  ws.columns = [
    { width: 40 }, // Template Name
    { width: 12 }, // Dealer ID
    { width: 40 }, // Dealership Name
  ];

  // Format the Month Reporting date cell (B7) as "mmm-yy" — matches the
  // ChromeData sample where Feb 2025 displays as "Feb-25".
  ws.getCell("B7").numFmt = "mmm-yy";

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
