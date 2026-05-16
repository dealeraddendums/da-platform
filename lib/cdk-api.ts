// Server-only helpers for talking to the CDK PIP extract endpoint.
// Credentials must live in .env.production; never let them reach the browser.

const CDK_API_URL = process.env.CDK_API_URL
  ?? "https://3pa.dmotorworks.com/pip-extract/inventoryvehicleext/extract";
const CDK_USERNAME = process.env.CDK_API_USERNAME ?? "";
const CDK_PASSWORD = process.env.CDK_API_PASSWORD ?? "";

export function cdkBasicAuthHeader(): string {
  return "Basic " + Buffer.from(`${CDK_USERNAME}:${CDK_PASSWORD}`).toString("base64");
}

export function cdkCredsConfigured(): boolean {
  return Boolean(CDK_USERNAME && CDK_PASSWORD);
}

/**
 * Build the CDK extract URL for a single dealer + iCompany + deltaDate cutoff.
 * deltaDate must be ISO with timezone offset (CDK is picky about format —
 * "2026-02-15T00:00:00-0600" is what their docs show).
 */
export function buildCdkUrl(opts: { dealerId: string; iCompany: string; deltaDate: string }): string {
  const params = new URLSearchParams({
    qparamInvCompany: opts.iCompany,
    dealerId: opts.dealerId,
    queryId: "IVEH_Bulk",
    deltaDate: opts.deltaDate,
  });
  return `${CDK_API_URL}?${params.toString()}`;
}

/**
 * Format a Date as an ISO-8601-with-offset string matching CDK's expected
 * deltaDate shape, e.g. "2026-02-15T00:00:00-0600". CDK requires the
 * offset (no Z) so we emit Central time (-0600) since that's what the
 * sample payload from CDK's docs uses.
 */
export function formatCdkDeltaDate(d: Date): string {
  // Convert to Central Time (-06:00; ignore DST for simplicity — CDK
  // tolerates either offset and only treats deltaDate as a cutoff anyway).
  const off = -360; // minutes from UTC for CST
  const utc = d.getTime();
  const local = new Date(utc + (off + d.getTimezoneOffset()) * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = local.getFullYear();
  const m = pad(local.getMonth() + 1);
  const day = pad(local.getDate());
  const hh = pad(local.getHours());
  const mm = pad(local.getMinutes());
  const ss = pad(local.getSeconds());
  return `${y}-${m}-${day}T${hh}:${mm}:${ss}-0600`;
}

export interface CdkExtractResponse {
  status: number;
  bodyText: string;
  contentType: string | null;
}

/**
 * Make the raw CDK extract call. Returns body as text so callers can decide
 * how to parse it (the PIP endpoint returns XML in production; some test
 * dealers return JSON via the same URL).
 */
export async function fetchCdkExtract(opts: { dealerId: string; iCompany: string; deltaDate: string }): Promise<CdkExtractResponse> {
  if (!cdkCredsConfigured()) {
    throw new Error("CDK_API_USERNAME / CDK_API_PASSWORD not set in environment");
  }
  const url = buildCdkUrl(opts);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: cdkBasicAuthHeader(),
      Accept: "application/xml, application/json",
    },
  });
  const bodyText = await res.text();
  return { status: res.status, bodyText, contentType: res.headers.get("content-type") };
}

/**
 * Quick-and-dirty vehicle count for the Test button. The CDK IVEH_Bulk
 * response wraps each car in <InventoryVehicle>...</InventoryVehicle> under
 * an <InventoryVehicleExtract> root. Older PIP queries used <Vehicle> or
 * <ROW> — match either.
 */
export function countCdkVehicles(body: string): number {
  const trimmed = body.trim();
  if (!trimmed) return 0;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      const arr = parsed?.InventoryVehicle ?? parsed?.vehicles ?? parsed?.Vehicles ?? (Array.isArray(parsed) ? parsed : []);
      return Array.isArray(arr) ? arr.length : 0;
    } catch { return 0; }
  }
  // Try InventoryVehicle first (current IVEH_Bulk shape), fall back to
  // historical wrappers.
  for (const tag of ["InventoryVehicle", "Vehicle", "ROW"]) {
    const matches = body.match(new RegExp(`<${tag}\\b`, "gi")) ?? [];
    if (matches.length > 0) return matches.length;
  }
  return 0;
}

/** Pull a single tag value out of an XML chunk. Returns null if missing. */
function xmlTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  if (!m) return null;
  return m[1]
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .trim() || null;
}

/**
 * Parse the CDK XML extract into a flat list of vehicle records. The PIP
 * IVEH_Bulk query returns one `<Vehicle>` element per car with child
 * elements for each field. Field names vary by configuration; this picks
 * the standard set seen in CDK PIP docs.
 */
export interface CdkVehicle {
  vin: string | null;
  stock_number: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  msrp: number | null;
  internet_price: string | null;
  mileage: number | null;
  ext_color: string | null;
  int_color: string | null;
  new_used: string | null;
  body_style: string | null;
  date_in_stock: string | null;
  certified: string | null;
}

export function parseCdkVehicles(body: string): CdkVehicle[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  // Pull every <InventoryVehicle>...</InventoryVehicle> chunk (current PIP
  // IVEH_Bulk shape verified against Visalia Hyundai 2026-05-16 sample).
  // Fall through to the older <Vehicle>/<ROW> wrappers in case a different
  // queryId is ever used.
  const chunkRe = /<(InventoryVehicle|Vehicle|ROW)\b[^>]*>[\s\S]*?<\/\1>/gi;
  const chunks = trimmed.match(chunkRe) ?? [];
  const out: CdkVehicle[] = [];
  for (const chunk of chunks) {
    // <UsedVehicleData /> is self-closing for new vehicles; when present
    // for used cars, mileage lives inside it. Search the whole chunk —
    // xmlTag will find <Mileage> wherever it sits.
    const year = xmlTag(chunk, "Year") ?? xmlTag(chunk, "ModelYear");
    // BaseRetailPrice is CDK's MSRP. BaseInvoicePrice is dealer cost (skip).
    const msrp = xmlTag(chunk, "BaseRetailPrice") ?? xmlTag(chunk, "Msrp") ?? xmlTag(chunk, "MSRP") ?? xmlTag(chunk, "ListPrice");
    const mileage = xmlTag(chunk, "Mileage") ?? xmlTag(chunk, "Odometer");
    // Used flag: <Wholesale>N</Wholesale> appears on both new and used. The
    // canonical signal is whether <UsedVehicleData> has content, but we can
    // approximate from the Year + presence of Mileage. A simpler proxy:
    // <Status>S</Status> = sold/inventoried, regardless of new/used. Use
    // mileage > 0 → Used, else New.
    const inferredUsed = mileage && parseInt(mileage.replace(/[^\d]/g, ""), 10) > 0 ? "Used" : "New";
    out.push({
      vin: xmlTag(chunk, "VIN") ?? xmlTag(chunk, "Vin"),
      // CDK PIP IVEH_Bulk doesn't always include a stock number in the
      // standard fields; some dealers store it in DealerDefined1/2. Try
      // both; fall back to VIN at insert time if missing.
      stock_number: xmlTag(chunk, "StockNumber") ?? xmlTag(chunk, "Stock") ?? xmlTag(chunk, "DealerDefined1"),
      year: year ? parseInt(year, 10) || null : null,
      make: xmlTag(chunk, "Make") ?? xmlTag(chunk, "Manufacturer"),
      // ModelName is the human-readable "Elantra"; Model is the code "ELAN".
      model: xmlTag(chunk, "ModelName") ?? xmlTag(chunk, "Model"),
      trim: xmlTag(chunk, "TrimLevel") ?? xmlTag(chunk, "Trim"),
      msrp: msrp ? parseFloat(msrp.replace(/[$,\s]/g, "")) || null : null,
      // AdvertisedPrice is CDK's customer-facing/internet price.
      internet_price: xmlTag(chunk, "AdvertisedPrice") ?? xmlTag(chunk, "InternetPrice") ?? xmlTag(chunk, "AskingPrice"),
      mileage: mileage ? parseInt(mileage.replace(/[^\d]/g, ""), 10) || null : null,
      // Exterior color = <Color>; interior = <InteriorColor>.
      ext_color: xmlTag(chunk, "Color") ?? xmlTag(chunk, "ExteriorColor") ?? xmlTag(chunk, "ExtColor"),
      int_color: xmlTag(chunk, "InteriorColor") ?? xmlTag(chunk, "IntColor"),
      new_used: xmlTag(chunk, "NewUsed") ?? xmlTag(chunk, "Condition") ?? inferredUsed,
      body_style: xmlTag(chunk, "BodyStyle") ?? xmlTag(chunk, "Bodystyle"),
      // EntryDate = when the car landed in inventory in CDK.
      date_in_stock: xmlTag(chunk, "EntryDate") ?? xmlTag(chunk, "DateInStock") ?? xmlTag(chunk, "DateInventoried"),
      certified: xmlTag(chunk, "Certified"),
    });
  }
  return out;
}
