// Products spreadsheet export/import — shared by the dealer library
// (addendum_library) and group Corporate Products (group_options) surfaces.
// Server-only (exceljs + sanitizers).
//
// DESIGN CONSTRAINT (Allan, 2026-08-07): same-name product VARIATIONS are
// INTENTIONAL — e.g. "Key Replacement" ×4 (New/Used × a mileage breakpoint,
// each its own price). Therefore `product_id` is the ONLY identity: rows with
// an id UPDATE that product, rows without an id CREATE a new one, and nothing
// ever matches/dedupes/merges by name. The preview never warns about
// duplicate names. Export sorts name → vehicle_type → mileage rule so
// variations group into an editable block, and "copy a row, blank the id,
// tweak rules" is the first-class way to mint a new variation.
//
// Import can never delete: products absent from the sheet are left alone.

import ExcelJS from "exceljs";
import { sanitizeProductHtml, sanitizeProductDescription } from "@/lib/product-name";
import { FUEL_RULE_OPTIONS } from "@/lib/fuel-rule";

export type SheetKind = "dealer" | "group";

// ── Column catalog ───────────────────────────────────────────────────────────

type Col = { key: string; header: string; groupOnly?: boolean };

const COLS: Col[] = [
  { key: "product_id", header: "product_id" },
  { key: "name", header: "name" },
  { key: "description", header: "description" },
  { key: "price", header: "price" },
  { key: "product_type", header: "product_type" },       // required | suggested
  { key: "applies_to", header: "applies_to" },           // all | rules | none
  { key: "vehicle_type", header: "vehicle_type" },       // csv of New,Used,CPO
  { key: "make", header: "make" },
  { key: "make_mode", header: "make_mode" },             // in | not_in
  { key: "model", header: "model" },
  { key: "model_mode", header: "model_mode" },
  { key: "trim", header: "trim" },
  { key: "trim_mode", header: "trim_mode" },
  { key: "body_styles", header: "body_styles" },
  { key: "fuel", header: "fuel" },
  { key: "fuel_mode", header: "fuel_mode" },
  { key: "year_condition", header: "year_condition" },   // all | equal | before | after
  { key: "year_value", header: "year_value" },
  { key: "miles_condition", header: "miles_condition" }, // all | under | over
  { key: "miles_value", header: "miles_value" },
  { key: "msrp_condition", header: "msrp_condition" },   // all | under | over | between
  { key: "msrp_1", header: "msrp_1" },
  { key: "msrp_2", header: "msrp_2" },
  { key: "show_models_only", header: "show_models_only" },
  { key: "separator_above", header: "separator_above" },
  { key: "separator_below", header: "separator_below" },
  { key: "spaces", header: "spaces" },
  { key: "active", header: "active" },
  { key: "locked", header: "locked", groupOnly: true },
  { key: "assign_all_dealers", header: "assign_all_dealers", groupOnly: true },
];

export function sheetColumns(kind: SheetKind): Col[] {
  return COLS.filter((c) => !c.groupOnly || kind === "group");
}

// ── Enum maps (friendly sheet labels ↔ stored codes) ─────────────────────────

const YEAR_COND: Record<string, number> = { all: 0, equal: 1, before: 2, after: 3 };
const MILES_COND: Record<string, number> = { all: 0, under: 1, over: 2 };
const MSRP_COND: Record<string, number> = { all: 0, under: 1, over: 2, between: 3 };
const label = (map: Record<string, number>, code: number | null | undefined): string =>
  Object.entries(map).find(([, v]) => v === (code ?? 0))?.[0] ?? "all";
const parseCond = (map: Record<string, number>, raw: string, col: string, errors: string[]): number => {
  const t = raw.trim().toLowerCase();
  if (t === "") return 0;
  if (/^\d+$/.test(t)) {
    const n = parseInt(t, 10);
    if (Object.values(map).includes(n)) return n;
  } else if (t in map) return map[t];
  errors.push(`${col}: "${raw}" is not one of ${Object.keys(map).join("/")}`);
  return 0;
};

const KNOWN_FUEL_KEYWORDS = new Set(
  FUEL_RULE_OPTIONS.flatMap((o: { keywords: string[] }) => o.keywords.map((k) => k.toLowerCase())),
);

// ── DB row (either table) → sheet row ────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = Record<string, any>;

export function productToSheetRow(r: AnyRow, kind: SheetKind): Record<string, string | number | boolean | null> {
  const adTypes: string[] = Array.isArray(r.ad_types) && r.ad_types.length > 0 ? r.ad_types : [];
  const price = kind === "dealer" ? r.item_price : r.option_price;
  const required = typeof r.required === "boolean" ? r.required : !(r.is_suggested ?? false);
  const out: Record<string, string | number | boolean | null> = {
    product_id: r.id,
    name: r.option_name ?? "",
    description: r.description ?? "",
    price: price ?? "",
    product_type: required ? "required" : "suggested",
    applies_to: r.applies_to ?? "all",
    vehicle_type: adTypes.join(","),
    make: r.makes ?? "",
    make_mode: r.makes_not ? "not_in" : "in",
    model: r.models ?? "",
    model_mode: r.models_not ? "not_in" : "in",
    trim: r.trims ?? "",
    trim_mode: r.trims_not ? "not_in" : "in",
    body_styles: r.body_styles ?? "",
    fuel: r.fuel ?? "",
    fuel_mode: r.fuel_not ? "not_in" : "in",
    year_condition: label(YEAR_COND, r.year_condition),
    year_value: r.year_value ?? null,
    miles_condition: label(MILES_COND, r.miles_condition),
    miles_value: r.miles_value ?? null,
    msrp_condition: label(MSRP_COND, r.msrp_condition),
    msrp_1: r.msrp1 ?? null,
    msrp_2: r.msrp2 ?? null,
    show_models_only: r.show_models_only === true,
    separator_above: r.separator_above === true,
    separator_below: r.separator_below === true,
    spaces: r.spaces ?? 0,
    active: r.active !== false,
  };
  if (kind === "group") {
    out.locked = typeof r.locked === "boolean" ? r.locked : true;
    out.assign_all_dealers = r.assign_all_dealers !== false;
  }
  return out;
}

/** Export sort: name (decoded, case-insens) → vehicle_type → mileage rule, so
 *  same-name variations sit together as one editable block. */
export function exportSort(a: AnyRow, b: AnyRow): number {
  const plain = (s: unknown) => String(s ?? "").replace(/<[^>]*>/g, "").replace(/&[a-z#0-9]+;/gi, " ").trim().toLowerCase();
  const c = plain(a.option_name).localeCompare(plain(b.option_name));
  if (c !== 0) return c;
  const vt = (r: AnyRow) => (Array.isArray(r.ad_types) ? r.ad_types.join(",") : "");
  const v = vt(a).localeCompare(vt(b));
  if (v !== 0) return v;
  return (a.miles_value ?? 0) - (b.miles_value ?? 0);
}

export async function buildWorkbook(rows: AnyRow[], kind: SheetKind): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Products");
  const cols = sheetColumns(kind);
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: Math.max(12, c.header.length + 2) }));
  ws.getColumn("name").width = 44;
  ws.getColumn("description").width = 60;
  ws.getRow(1).font = { bold: true };
  for (const r of [...rows].sort(exportSort)) ws.addRow(productToSheetRow(r, kind));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ── File parsing (.xlsx via exceljs, .csv via RFC4180 parser) ────────────────

export interface ParsedSheetRow { rowNum: number; values: Record<string, string> }

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (typeof v === "object") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const o = v as any;
    if (o.richText) return o.richText.map((t: { text: string }) => t.text).join("");
    if (o.text) return String(o.text);
    if (o.result != null) return String(o.result);
    if (v instanceof Date) return v.toISOString();
    return String(v);
  }
  return String(v);
}

export async function parseUpload(filename: string, buf: Buffer, kind: SheetKind): Promise<ParsedSheetRow[]> {
  const wanted = sheetColumns(kind).map((c) => c.key);
  const rows: ParsedSheetRow[] = [];
  const pushRow = (rowNum: number, headerIdx: Map<string, number>, cells: string[]) => {
    const values: Record<string, string> = {};
    for (const key of wanted) {
      const idx = headerIdx.get(key);
      values[key] = idx == null ? "" : (cells[idx] ?? "").trim();
    }
    if (Object.values(values).some((s) => s !== "")) rows.push({ rowNum, values });
  };

  if (/\.csv$/i.test(filename)) {
    const table = parseCsv(buf.toString("utf8"));
    if (table.length === 0) return [];
    const headerIdx = new Map(table[0].map((h, i) => [h.trim().toLowerCase(), i] as [string, number]));
    for (let i = 1; i < table.length; i++) pushRow(i + 1, headerIdx, table[i]);
    return rows;
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const headerIdx = new Map<string, number>();
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headerIdx.set(cellText(cell.value).trim().toLowerCase(), colNumber - 1);
  });
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => { cells[colNumber - 1] = cellText(cell.value).trim(); });
    pushRow(rowNumber, headerIdx, cells);
  });
  return rows;
}

function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) out.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== "")) out.push(row);
  return out;
}

// ── Validation → per-row plan ────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AD_TYPES = new Set(["New", "Used", "CPO"]);

export interface RowPlan {
  rowNum: number;
  action: "update" | "create" | "unchanged" | "error";
  productId: string | null;
  /** Display name for the preview list. */
  name: string;
  /** DB patch (update) or full insert payload (create) — table-specific keys. */
  payload: AnyRow;
  changedFields: string[];
  errors: string[];
}

const parseBool = (raw: string, col: string, errors: string[], dflt: boolean): boolean => {
  const t = raw.trim().toLowerCase();
  if (t === "") return dflt;
  if (["true", "yes", "y", "1", "x"].includes(t)) return true;
  if (["false", "no", "n", "0"].includes(t)) return false;
  errors.push(`${col}: "${raw}" is not a yes/no value`);
  return dflt;
};
const parseIntOrNull = (raw: string, col: string, errors: string[]): number | null => {
  const t = raw.trim();
  if (t === "") return null;
  const n = parseInt(t.replace(/[,$\s]/g, ""), 10);
  if (Number.isNaN(n)) { errors.push(`${col}: "${raw}" is not a number`); return null; }
  return n;
};

/** Map one parsed sheet row to the table's column payload. Table-specific
 *  price/flag columns are chosen by `kind`. */
function rowToPayload(values: Record<string, string>, kind: SheetKind, errors: string[]): AnyRow {
  const name = values.name ?? "";
  if (!name.trim()) errors.push("name is required");
  // Same rich-text gate as the modals: sanitize on the way IN so an uploaded
  // sheet cannot become an XSS/broken-render vector. (Render paths sanitize
  // again — belt and suspenders.)
  const cleanName = sanitizeProductHtml(name);
  if (name.trim() && !cleanName.trim()) errors.push("name is empty after HTML sanitization");
  const cleanDesc = values.description ? sanitizeProductDescription(values.description) : "";

  const price = (values.price ?? "").trim();
  if (!price) errors.push("price is required (NC is valid for no-charge)");
  else if (price.length > 40) errors.push("price: too long");
  else if (!/^[\w\s.,$|^\-+%()/]*$/i.test(price)) errors.push(`price: "${price}" contains unsupported characters`);

  const pt = (values.product_type ?? "").trim().toLowerCase() || "required";
  if (!["required", "suggested"].includes(pt)) errors.push(`product_type: "${values.product_type}" must be required or suggested`);
  const appliesTo = (values.applies_to ?? "").trim().toLowerCase() || "all";
  if (!["all", "rules", "none"].includes(appliesTo)) errors.push(`applies_to: "${values.applies_to}" must be all/rules/none`);

  const adTypes = (values.vehicle_type ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    .map((s) => s.toLowerCase() === "cpo" ? "CPO" : s[0].toUpperCase() + s.slice(1).toLowerCase());
  for (const t of adTypes) if (!AD_TYPES.has(t)) errors.push(`vehicle_type: "${t}" must be New/Used/CPO`);
  const mode = (col: string): boolean => {
    const t = (values[col] ?? "").trim().toLowerCase();
    if (t === "" || t === "in") return false;
    if (t === "not_in" || t === "not in") return true;
    errors.push(`${col}: "${values[col]}" must be in or not_in`);
    return false;
  };

  const fuel = (values.fuel ?? "").trim();
  if (fuel) {
    const unknown = fuel.split(",").map((s) => s.trim().toLowerCase()).filter((k) => k && !KNOWN_FUEL_KEYWORDS.has(k));
    if (unknown.length) errors.push(`fuel: unknown keyword(s) ${unknown.join(", ")} — use keywords from the Fuel picker (e.g. gas, diesel, hybrid, electric)`);
  }

  const payload: AnyRow = {
    option_name: cleanName,
    description: cleanDesc,
    required: pt === "required",
    applies_to: appliesTo,
    ad_types: adTypes.length ? adTypes : ["New", "Used"],
    makes: (values.make ?? "").trim(),
    makes_not: mode("make_mode"),
    models: (values.model ?? "").trim(),
    models_not: mode("model_mode"),
    trims: (values.trim ?? "").trim(),
    trims_not: mode("trim_mode"),
    body_styles: (values.body_styles ?? "").trim(),
    fuel,
    fuel_not: mode("fuel_mode"),
    year_condition: parseCond(YEAR_COND, values.year_condition ?? "", "year_condition", errors),
    year_value: parseIntOrNull(values.year_value ?? "", "year_value", errors),
    miles_condition: parseCond(MILES_COND, values.miles_condition ?? "", "miles_condition", errors),
    miles_value: parseIntOrNull(values.miles_value ?? "", "miles_value", errors),
    msrp_condition: parseCond(MSRP_COND, values.msrp_condition ?? "", "msrp_condition", errors),
    msrp1: parseIntOrNull(values.msrp_1 ?? "", "msrp_1", errors),
    msrp2: parseIntOrNull(values.msrp_2 ?? "", "msrp_2", errors),
    show_models_only: parseBool(values.show_models_only ?? "", "show_models_only", errors, false),
    separator_above: parseBool(values.separator_above ?? "", "separator_above", errors, false),
    separator_below: parseBool(values.separator_below ?? "", "separator_below", errors, false),
    spaces: parseIntOrNull(values.spaces ?? "", "spaces", errors) ?? 0,
    active: parseBool(values.active ?? "", "active", errors, true),
  };
  if (kind === "dealer") {
    payload.item_price = price;
  } else {
    payload.option_price = price;
    payload.is_suggested = pt !== "required";
    payload.locked = parseBool(values.locked ?? "", "locked", errors, true);
    payload.assign_all_dealers = parseBool(values.assign_all_dealers ?? "", "assign_all_dealers", errors, true);
  }
  return payload;
}

/** Build the import plan. `existingById` = the target dealer's/group's current
 *  products keyed by id — an id not in the map is an unknown-id error (ids
 *  can't cross dealers/groups). IDENTITY IS THE ID ONLY: same-name rows are
 *  legitimate variations and are never matched or flagged by name. */
export function planImport(
  parsed: ParsedSheetRow[],
  existingById: Map<string, AnyRow>,
  kind: SheetKind,
): RowPlan[] {
  return parsed.map(({ rowNum, values }) => {
    const errors: string[] = [];
    const rawId = (values.product_id ?? "").trim();
    let productId: string | null = null;
    if (rawId) {
      if (!UUID_RE.test(rawId)) errors.push(`product_id: "${rawId}" is not a valid id (leave blank to create a new product)`);
      else if (!existingById.has(rawId)) errors.push(`product_id: ${rawId} does not exist on this ${kind === "dealer" ? "dealer" : "group"}`);
      else productId = rawId;
    }
    const payload = rowToPayload(values, kind, errors);
    const name = payload.option_name || values.name || "(unnamed)";
    if (errors.length) return { rowNum, action: "error" as const, productId: rawId || null, name, payload: {}, changedFields: [], errors };

    if (!productId) {
      return { rowNum, action: "create" as const, productId: null, name, payload, changedFields: Object.keys(payload), errors: [] };
    }
    const existing = existingById.get(productId)!;
    const patch: AnyRow = {};
    const changed: string[] = [];
    for (const [k, v] of Object.entries(payload)) {
      let cur = existing[k];
      // Rich-text fields: the sheet value was sanitized on parse, but stored
      // values may be RAW legacy HTML that the sanitizer merely normalizes
      // ("/>"→">", style formatting). Compare sanitized-vs-sanitized so an
      // untouched export→import round-trip is "unchanged", not a phantom
      // rewrite of every HTML name.
      if (k === "option_name") cur = sanitizeProductHtml(String(cur ?? ""));
      else if (k === "description") cur = sanitizeProductDescription(String(cur ?? ""));
      const same = Array.isArray(v)
        ? JSON.stringify(v) === JSON.stringify(Array.isArray(cur) && cur.length ? cur : v)
        : (cur ?? (typeof v === "boolean" ? cur : null)) === v || String(cur ?? "") === String(v ?? "");
      if (!same) { patch[k] = v; changed.push(k); }
    }
    if (changed.length === 0) return { rowNum, action: "unchanged" as const, productId, name, payload: {}, changedFields: [], errors: [] };
    return { rowNum, action: "update" as const, productId, name, payload: patch, changedFields: changed, errors: [] };
  });
}

export const IMPORT_ROW_CAP = 500;

/** Slim a plan row for the preview UI (no payload echo). */
export function planForClient(p: RowPlan) {
  return { rowNum: p.rowNum, action: p.action, name: p.name, productId: p.productId, changedFields: p.changedFields, errors: p.errors };
}
