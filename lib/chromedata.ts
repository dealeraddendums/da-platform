// Server-only ChromeData media resolver.
//
// Two-step lookup per the legacy DA platform's PrintController:
//   1. SOAP to services.chromedata.com/Description/7c with the VIN → returns
//      a VehicleDescriptionResponse with one or more <style> elements, each
//      carrying a styleId and an exteriorColor with a colorCode.
//   2. HTTP GET (Basic Auth account:secret) to
//      media.chromedata.com/MediaGallery/service/style/{styleId}/.json
//      → returns a colorized image list; we pick the image with
//      backgroundDescription='Transparent', width=320, height=240,
//      shotCode='03' (driver-side profile) and the matching colorCode.
//
// All results — including null-image misses — are cached in Supabase
// (chromedata_vehicle_images) keyed by (vin, color_lookup) so a single
// fleet-wide print run doesn't hammer ChromeData.
//
// Credentials are NOT hard-coded. Set CHROMEDATA_ACCOUNT_ID and
// CHROMEDATA_MEDIA_SECRET in the runtime environment.

import { createAdminSupabaseClient } from "@/lib/db";

/**
 * The strongly-typed Database union in lib/db.ts is auto-generated from
 * Supabase introspection at build time; the new chromedata_vehicle_images
 * table won't be in it until that runs again. Cast through `as never` so
 * the runtime call succeeds and the type checker stays out of the way.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CacheClient = any;

const SOAP_URL  = "http://services.chromedata.com/Description/7c?wsdl";
const MEDIA_URL = "http://media.chromedata.com/MediaGallery/service/style";

// Cache freshness: don't re-fetch an existing row this much (in days). VIN
// styling is immutable; the photo URL itself is durable. 30d keeps the cache
// usable indefinitely while still allowing a refresh path on the rare miss.
const CACHE_TTL_DAYS = 30;

const ACCOUNT_ID = process.env.CHROMEDATA_ACCOUNT_ID ?? "";
const MEDIA_SECRET = process.env.CHROMEDATA_MEDIA_SECRET ?? "";

export interface ChromeImageResult {
  vin: string;
  color_lookup: string;
  style_id: string | null;
  color_code: string | null;
  image_url: string | null;
  source: "cache" | "fetched";
}

function normalizeColor(color: string | null | undefined): string {
  return (color ?? "").trim().toUpperCase();
}

function envOk(): boolean {
  return Boolean(ACCOUNT_ID && MEDIA_SECRET);
}

/**
 * Build the SOAP envelope expected by ChromeData's Description/7c service.
 * Mirrors the legacy PHP exactly — same accountInfo + vin element wrapping.
 */
function buildSoapEnvelope(vin: string): string {
  const safeVin = vin.replace(/[^A-Z0-9]/gi, "");
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:urn="urn:description7c.services.chrome.com">
  <soapenv:Header/>
  <soapenv:Body>
    <urn:VehicleDescriptionRequest>
      <urn:accountInfo number="${ACCOUNT_ID}" secret="${MEDIA_SECRET}" country="US" language="en" behalfOf="?"/>
      <urn:vin>${safeVin}</urn:vin>
    </urn:VehicleDescriptionRequest>
  </soapenv:Body>
</soapenv:Envelope>`;
}

/**
 * Quick-and-dirty XML attribute extraction. We don't need a full XML parser
 * for this — every field we care about (styleId, colorCode) is an attribute
 * on an element. Pull them with a regex.
 */
function extractStyleAndColor(xml: string, requestedColor: string): { styleId: string | null; colorCode: string | null } {
  // First style element wins when no color match (matches legacy fallback).
  const styleMatch = xml.match(/<style\b[^>]*\bid\s*=\s*"(\d+)"/i);
  const styleId = styleMatch?.[1] ?? null;

  // exteriorColor elements look like:
  //   <exteriorColor colorCode="GAN" ... rgbValue="..." ... genericDesc="Black"/>
  // The legacy code picks the colorCode whose generic name or rgb matches
  // the dealer's EXT_COLOR. We do a simple substring match against name +
  // genericDesc + rgbValue.
  let colorCode: string | null = null;
  if (requestedColor) {
    const matches = Array.from(xml.matchAll(/<exteriorColor\b([^/>]*)\/>/gi));
    for (const m of matches) {
      const attrs = m[1];
      const fields = attrs.toUpperCase();
      if (fields.includes(requestedColor)) {
        const code = attrs.match(/colorCode\s*=\s*"([^"]+)"/i);
        if (code) { colorCode = code[1]; break; }
      }
    }
  }
  // Fallback: first colorCode if no match
  if (!colorCode) {
    const firstColor = xml.match(/<exteriorColor\b[^/>]*\bcolorCode\s*=\s*"([^"]+)"/i);
    colorCode = firstColor?.[1] ?? null;
  }

  return { styleId, colorCode };
}

interface JsonColorizedEntry {
  "@href"?: string;
  "@width"?: string;
  "@height"?: string;
  "@backgroundDescription"?: string;
  "@shotCode"?: string;
  "@primaryColorOptionCode"?: string;
}

/**
 * Pick the best matching image from the MediaGallery JSON listing.
 *
 * Precedence by content (most specific first):
 *   1. transparent shotCode=03 with primaryColorOptionCode = colorCode
 *   2. transparent shotCode=03 (any color)
 *   3. transparent any-shot (any color)
 *
 * Within each tier we prefer the highest resolution available (1280 > 640
 * > 320). ChromeData's MediaGallery listing returns one signed URL per
 * (size, shot, color) tuple — so we just pick the largest one. The URL
 * itself is HMAC-signed; we can't synthesize a higher-res URL by editing
 * the filename, so we have to find an entry that already exists.
 *
 * 2100×1575 is excluded as a candidate because it's only published for
 * 2016+ vehicles per ChromeData's docs — and 1280 is plenty for a 4×3
 * print at 300dpi.
 */
const PREFERRED_WIDTHS = ['1280', '640', '320'] as const;

function bestByWidth(entries: JsonColorizedEntry[]): JsonColorizedEntry | undefined {
  for (const w of PREFERRED_WIDTHS) {
    const hit = entries.find(e => e["@width"] === w);
    if (hit) return hit;
  }
  return entries[0];
}

function pickImage(entries: JsonColorizedEntry[], colorCode: string | null): string | null {
  if (!entries?.length) return null;
  const isTransparent = (e: JsonColorizedEntry) => e["@backgroundDescription"] === "Transparent";
  const transparent = entries.filter(isTransparent);
  if (transparent.length === 0) return null;

  if (colorCode) {
    const colorShot03 = transparent.filter(e =>
      e["@primaryColorOptionCode"] === colorCode && e["@shotCode"] === "03");
    const best = bestByWidth(colorShot03);
    if (best?.["@href"]) return best["@href"];
    const anyShotColor = transparent.filter(e => e["@primaryColorOptionCode"] === colorCode);
    const bestAny = bestByWidth(anyShotColor);
    if (bestAny?.["@href"]) return bestAny["@href"];
  }
  const shot03 = transparent.filter(e => e["@shotCode"] === "03");
  const bestShot03 = bestByWidth(shot03);
  if (bestShot03?.["@href"]) return bestShot03["@href"];
  return bestByWidth(transparent)?.["@href"] ?? null;
}

/**
 * Resolve a VIN+color to a ChromeData image URL, using the Supabase cache
 * when fresh. Returns image_url=null on hard failures (VIN not in Chrome,
 * no matching transparent image, etc.) — the null is also cached briefly to
 * avoid repeated network retries.
 */
export async function resolveChromeVehicleImage(
  vin: string,
  extColor: string | null | undefined,
): Promise<ChromeImageResult> {
  const vinUpper = (vin ?? "").trim().toUpperCase();
  const color_lookup = normalizeColor(extColor);
  const fallback: ChromeImageResult = {
    vin: vinUpper, color_lookup, style_id: null, color_code: null, image_url: null, source: "fetched",
  };

  if (!vinUpper || vinUpper.length < 11) return fallback;
  if (!envOk()) {
    console.warn("[chromedata] CHROMEDATA_ACCOUNT_ID / CHROMEDATA_MEDIA_SECRET not set — skipping");
    return fallback;
  }

  const admin = createAdminSupabaseClient() as CacheClient;

  // 1. Cache lookup
  const cacheRes = await admin
    .from("chromedata_vehicle_images")
    .select("style_id, color_code, image_url, fetched_at")
    .eq("vin", vinUpper)
    .eq("color_lookup", color_lookup)
    .maybeSingle();
  const cached = cacheRes.data as { style_id: string | null; color_code: string | null; image_url: string | null; fetched_at: string } | null;

  if (cached) {
    const ageDays = (Date.now() - new Date(cached.fetched_at).getTime()) / 86_400_000;
    if (ageDays < CACHE_TTL_DAYS) {
      return {
        vin: vinUpper,
        color_lookup,
        style_id: cached.style_id,
        color_code: cached.color_code,
        image_url: cached.image_url,
        source: "cache",
      };
    }
  }

  // 2. SOAP — resolve VIN → styleId + colorCode
  let styleId: string | null = null;
  let colorCode: string | null = null;
  try {
    const soapRes = await fetch(SOAP_URL, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "" },
      body: buildSoapEnvelope(vinUpper),
    });
    const xml = await soapRes.text();
    const parsed = extractStyleAndColor(xml, color_lookup);
    styleId = parsed.styleId;
    colorCode = parsed.colorCode;
  } catch (err) {
    console.error(`[chromedata] SOAP failed for ${vinUpper}:`, err instanceof Error ? err.message : err);
  }

  if (!styleId) {
    await admin.from("chromedata_vehicle_images").upsert(
      { vin: vinUpper, color_lookup, style_id: null, color_code: null, image_url: null, fetched_at: new Date().toISOString() },
      { onConflict: "vin,color_lookup" },
    );
    return fallback;
  }

  // 3. MediaGallery JSON — fetch colorized image list
  let imageUrl: string | null = null;
  try {
    const basicAuth = Buffer.from(`${ACCOUNT_ID}:${MEDIA_SECRET}`).toString("base64");
    const mediaRes = await fetch(`${MEDIA_URL}/${styleId}/.json`, {
      headers: { Authorization: `Basic ${basicAuth}` },
    });
    if (mediaRes.ok) {
      const json = await mediaRes.json() as { colorized?: JsonColorizedEntry[] };
      imageUrl = pickImage(json.colorized ?? [], colorCode);
    } else {
      console.warn(`[chromedata] media listing for style ${styleId} returned HTTP ${mediaRes.status}`);
    }
  } catch (err) {
    console.error(`[chromedata] media listing failed for style ${styleId}:`, err instanceof Error ? err.message : err);
  }

  // 4. Cache (whether hit or miss) and return
  await admin.from("chromedata_vehicle_images").upsert(
    { vin: vinUpper, color_lookup, style_id: styleId, color_code: colorCode, image_url: imageUrl, fetched_at: new Date().toISOString() },
    { onConflict: "vin,color_lookup" },
  );

  return { vin: vinUpper, color_lookup, style_id: styleId, color_code: colorCode, image_url: imageUrl, source: "fetched" };
}
