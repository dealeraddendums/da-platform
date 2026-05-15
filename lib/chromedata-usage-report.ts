// Monthly ChromeData usage report builder.
//
// Finds dealers who (a) have a saved template containing the Vehicle Photo
// widget, (b) printed > 10 addendums in the reported month, (c) are active
// + paid + not flagged as a test account, then emits an .xlsx file matching
// the ChromeData billing template (Contract #9310). Used by both the
// monthly cron job and the manual-trigger button on the Reports page.

import * as XLSX from "xlsx";
import { createAdminSupabaseClient } from "@/lib/db";

const CONTRACT_NUMBER = "9310";
const PRINT_THRESHOLD = 10;
const EXCLUSION_RE = /(test|allan)/i;

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
  internal_id: string;
  dealer_name: string;
  print_count: number;
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
  const dealerTemplateMatches = new Map<string, string>(); // dealer_id (uuid) → template name
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
      // column. Could also collect all and pick the most recently updated —
      // ChromeData just wants ONE line per dealer, so first-wins is fine.
      if (t.dealer_id && !dealerTemplateMatches.has(t.dealer_id as string)) {
        dealerTemplateMatches.set(t.dealer_id as string, (t.name as string) ?? "(unnamed)");
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
    id: string; dealer_id: string; internal_id: string | null;
    name: string; group_id: string | null;
  }> = [];
  from = 0;
  while (true) {
    const { data, error } = await admin
      .from("dealers")
      .select("id, dealer_id, internal_id, name, group_id, active, is_test, account_type")
      .eq("active", true)
      .range(from, from + 999);
    if (error) throw new Error(`dealers fetch failed: ${error.message}`);
    const rows = data ?? [];
    for (const d of rows) {
      const r = d as { id: string; dealer_id: string; internal_id: string | null; name: string;
                       group_id: string | null; active: boolean; is_test: boolean | null;
                       account_type: string | null };
      if (r.is_test === true) continue;
      const accountType = (r.account_type ?? "").trim();
      if (!accountType || accountType === "Free" || accountType === "Trial") continue;
      if (EXCLUSION_RE.test(r.name ?? "")) continue;
      dealers.push({
        id: r.id, dealer_id: r.dealer_id, internal_id: r.internal_id,
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
    let templateName = dealerTemplateMatches.get(d.id);
    if (!templateName && d.group_id) {
      templateName = groupTemplateMatches.get(d.group_id);
    }
    if (!templateName) continue;
    candidates.push({
      template_name: templateName,
      internal_id: d.internal_id ?? d.dealer_id,
      dealer_name: d.name,
      print_count: 0,
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

  // ── 6. Apply the > 10 prints threshold + sort alphabetically ─────────────
  const finalRows: DealerReportRow[] = candidates
    .filter(c => c.print_count > PRINT_THRESHOLD)
    .map(({ template_name, internal_id, dealer_name, print_count }) => ({
      template_name, internal_id, dealer_name, print_count,
    }))
    .sort((a, b) => a.dealer_name.localeCompare(b.dealer_name));

  // ── 7. Build the .xlsx using SheetJS ─────────────────────────────────────
  const xlsxBuffer = renderXlsx(m, finalRows);
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
 * Dealer ID is stored as a number when the internal_id is purely numeric
 * (matches the existing template where IDs like 269, 1616 are right-aligned
 * integers). Falls back to a string for MP-style codes.
 */
function renderXlsx(m: { monthStart: string; monthLabel: string }, rows: DealerReportRow[]): Buffer {
  // Excel rows are 1-based; this array is 0-based, so index 0 = row 1.
  const aoa: Array<Array<string | number | Date | null>> = [];
  aoa.push([]);                                                  // row 1: blank
  aoa.push([]);                                                  // row 2: blank
  aoa.push(["DealerAddendums Inc"]);                             // row 3
  aoa.push([`Contract # ${CONTRACT_NUMBER}`]);                   // row 4
  aoa.push(["Please send to billing@chromedata.com, no later than the 10th of the month"]); // row 5
  aoa.push([]);                                                  // row 6: blank
  aoa.push(["Month Reporting:", new Date(m.monthStart + "T00:00:00Z")]); // row 7
  aoa.push(["Location TOTAL:", rows.length]);                    // row 8
  aoa.push([]);                                                  // row 9: blank
  aoa.push(["Template Name", "Dealer ID", "Dealership Name"]);   // row 10: header
  for (const r of rows) {
    // ChromeData's sample has Dealer ID as a right-aligned integer when
    // it's purely numeric; preserve that. MP-style codes stay as strings.
    const idValue: string | number = /^\d+$/.test(r.internal_id) ? Number(r.internal_id) : r.internal_id;
    aoa.push([r.template_name, idValue, r.dealer_name]);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 40 }, // Template Name
    { wch: 12 }, // Dealer ID
    { wch: 40 }, // Dealership Name
  ];
  // Format the Month Reporting cell as a date (mmm-yy matches the sample
  // where serial 45689 → Feb 2025). SheetJS picks up the number format
  // from the cell's `z` property.
  if (ws["B7"]) {
    (ws["B7"] as { z?: string }).z = "mmm-yy";
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}
