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
 * Quick-and-dirty vehicle count for the Test button. Looks for VIN-bearing
 * elements in the XML payload — falls back to JSON if CDK returned JSON.
 */
export function countCdkVehicles(body: string): number {
  const trimmed = body.trim();
  if (!trimmed) return 0;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      // Common PIP JSON shapes: { vehicles: [...] } or { Vehicles: [...] }
      const arr = parsed?.vehicles ?? parsed?.Vehicles ?? (Array.isArray(parsed) ? parsed : []);
      return Array.isArray(arr) ? arr.length : 0;
    } catch { return 0; }
  }
  // XML — count top-level vehicle nodes. PIP standard uses <Vehicle> or
  // <ROW> wrappers depending on the queryId. Match either.
  const vehicleMatches = body.match(/<Vehicle\b/gi) ?? [];
  if (vehicleMatches.length > 0) return vehicleMatches.length;
  const rowMatches = body.match(/<ROW\b/gi) ?? [];
  return rowMatches.length;
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
  // Pull each <Vehicle>...</Vehicle> (or <ROW>...</ROW>) chunk.
  const chunkRe = /<(Vehicle|ROW)\b[^>]*>[\s\S]*?<\/\1>/gi;
  const chunks = trimmed.match(chunkRe) ?? [];
  const out: CdkVehicle[] = [];
  for (const chunk of chunks) {
    const year = xmlTag(chunk, "Year") ?? xmlTag(chunk, "ModelYear");
    const msrp = xmlTag(chunk, "Msrp") ?? xmlTag(chunk, "MSRP") ?? xmlTag(chunk, "ListPrice");
    const mileage = xmlTag(chunk, "Mileage") ?? xmlTag(chunk, "Odometer");
    out.push({
      vin: xmlTag(chunk, "Vin") ?? xmlTag(chunk, "VIN"),
      stock_number: xmlTag(chunk, "Stock") ?? xmlTag(chunk, "StockNumber"),
      year: year ? parseInt(year, 10) || null : null,
      make: xmlTag(chunk, "Make"),
      model: xmlTag(chunk, "Model"),
      trim: xmlTag(chunk, "Trim"),
      msrp: msrp ? parseFloat(msrp.replace(/[$,\s]/g, "")) || null : null,
      internet_price: xmlTag(chunk, "InternetPrice") ?? xmlTag(chunk, "AskingPrice"),
      mileage: mileage ? parseInt(mileage.replace(/[^\d]/g, ""), 10) || null : null,
      ext_color: xmlTag(chunk, "ExteriorColor") ?? xmlTag(chunk, "ExtColor"),
      int_color: xmlTag(chunk, "InteriorColor") ?? xmlTag(chunk, "IntColor"),
      new_used: xmlTag(chunk, "NewUsed") ?? xmlTag(chunk, "Condition"),
      body_style: xmlTag(chunk, "BodyStyle") ?? xmlTag(chunk, "Bodystyle"),
      date_in_stock: xmlTag(chunk, "DateInStock") ?? xmlTag(chunk, "DateInventoried"),
      certified: xmlTag(chunk, "Certified"),
    });
  }
  return out;
}
