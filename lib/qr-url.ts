/**
 * QR Code widget — custom URL template substitution.
 *
 * The ONE place a QR URL template ("https://dealer.com/[YEAR]-[MAKE]/[VIN]")
 * becomes a per-vehicle URL. Used by both pdf/generate and pdf/bulk, for the
 * qrcode widget and the legacy infobox-qr widget, and for the dealer-wide
 * default template (dealer_settings.qr_url_template) — so every print path
 * resolves a template identically.
 *
 * - Tokens: [VIN] [STOCK] [YEAR] [MAKE] [MODEL] [TRIM] (case-insensitive,
 *   every occurrence).
 * - Each substituted VALUE is encodeURIComponent'd ("Grand Cherokee" →
 *   "Grand%20Cherokee"); the surrounding template is left as authored.
 * - A missing value becomes "" — a literal "[TRIM]" never reaches a URL.
 */

export type QrVehicle = {
  vin?: string | null;
  stock_number?: string | null;
  year?: string | number | null;
  make?: string | null;
  model?: string | null;
  trim?: string | null;
};

export const QR_URL_TOKENS = ["VIN", "STOCK", "YEAR", "MAKE", "MODEL", "TRIM"] as const;

const TOKEN_RE = /\[(VIN|STOCK|YEAR|MAKE|MODEL|TRIM)\]/gi;

function tokenValue(token: string, v: QrVehicle): string {
  switch (token.toUpperCase()) {
    case "VIN": return v.vin ?? "";
    case "STOCK": return v.stock_number ?? "";
    case "YEAR": return v.year == null ? "" : String(v.year);
    case "MAKE": return v.make ?? "";
    case "MODEL": return v.model ?? "";
    case "TRIM": return v.trim ?? "";
    default: return "";
  }
}

/** Resolve a QR URL template for a vehicle. Blank/null template → null. */
export function resolveQrUrlTemplate(template: string | null | undefined, vehicle: QrVehicle): string | null {
  if (!template || !template.trim()) return null;
  return template.replace(TOKEN_RE, (_m, token: string) =>
    encodeURIComponent(tokenValue(token, vehicle).trim()),
  );
}
