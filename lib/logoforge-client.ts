import "server-only";

// Client for DA-LogoForge (logo vectorize/clean service, Phase 3 2026-10-11).
//
// LogoForge is a PRIVATE service on its own EC2 (LOGOFORGE_URL, a private VPC
// address reachable only from this box's security group) gated by
// LOGOFORGE_API_KEY. Both stay server-side: the browser only ever talks to
// /api/logo-studio/*, the same proxy pattern as the pdf-service. The key and
// the private address must never reach a response body, a log line, or a
// client bundle (this module is server-only).
//
// Wire format: da-logoforge README → POST /api/vectorize (multipart).

const TIMEOUT_MS = 60_000; // library-on runs are ~2–7 s; CLIP warm-up after a restart ~10 s

export type LogoForgeRegion = {
  make: string | null;
  decision: string;   // "replaced" | "kept" | …
  tier?: string | null;
  asset_id?: string | null;
  reason?: string | null;
};

export type LogoForgeResult = {
  svg: string;
  width: number;
  height: number;
  regions: LogoForgeRegion[];
  durationMs: number;
};

export class LogoForgeError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function logoForgeConfigured(): boolean {
  return !!process.env.LOGOFORGE_URL && !!process.env.LOGOFORGE_API_KEY;
}

/**
 * Vectorize + clean a raster logo. `allowedMakes` = the dealer's / group's
 * franchises: OEM badge replacement runs ONLY when that list is non-empty, so a
 * library mark is placed only for a brand the account carries (the license
 * posture: OEM marks go only to that make's franchisees). Empty/null → pure
 * trace, no badge replacement at all.
 */
export async function vectorizeLogo(
  file: { bytes: Uint8Array; type: string; name: string },
  allowedMakes: string[] | null,
): Promise<LogoForgeResult> {
  if (!logoForgeConfigured()) throw new LogoForgeError("Logo cleanup isn't configured", 503);
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(file.bytes)], { type: file.type }), file.name || "logo.png");
  form.append("preset", "logo");
  form.append("output", "json");
  form.append("png", "false"); // the platform renders its own PNG from the SANITIZED svg
  const makes = (allowedMakes ?? []).filter(Boolean);
  form.append("library", makes.length ? "true" : "false");
  if (makes.length) form.append("allowed_makes", makes.join(","));

  let res: Response;
  try {
    res = await fetch(`${process.env.LOGOFORGE_URL!.replace(/\/+$/, "")}/api/vectorize`, {
      method: "POST",
      headers: { "X-API-Key": process.env.LOGOFORGE_API_KEY! },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    console.error("[logoforge] request failed:", e instanceof Error ? e.name : "error");
    throw new LogoForgeError("The logo service didn't respond — try again in a minute.", 502);
  }
  if (!res.ok) {
    // 415/413/422 carry a safe, user-facing `detail` (bad format, too big, nothing to trace).
    const j = await res.json().catch(() => ({})) as { detail?: unknown };
    const detail = typeof j.detail === "string" ? j.detail : "";
    console.error(`[logoforge] ${res.status} ${detail.slice(0, 200)}`);
    if (res.status === 413) throw new LogoForgeError("That image is too large.", 413);
    if (res.status === 415) throw new LogoForgeError("Upload a PNG, JPG or WEBP image.", 415);
    if (res.status === 422) throw new LogoForgeError("Couldn't find a logo to trace in that image.", 422);
    throw new LogoForgeError("The logo service couldn't process that image.", 502);
  }
  const j = await res.json() as {
    svg?: unknown; width?: unknown; height?: unknown; regions?: unknown; duration_ms?: unknown;
  };
  if (typeof j.svg !== "string" || !j.svg) throw new LogoForgeError("The logo service returned no SVG.", 502);
  const regions = Array.isArray(j.regions) ? (j.regions as Record<string, unknown>[]).map((r) => ({
    make: typeof r.make === "string" ? r.make : null,
    decision: typeof r.decision === "string" ? r.decision : "kept",
    tier: typeof r.tier === "string" ? r.tier : null,
    asset_id: typeof r.asset_id === "string" ? r.asset_id : null,
    reason: typeof r.reason === "string" ? r.reason : null,
  })) : [];
  return {
    svg: j.svg,
    width: Number(j.width) || 0,
    height: Number(j.height) || 0,
    regions,
    durationMs: Number(j.duration_ms) || 0,
  };
}
