import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { requireLogoScope } from "@/lib/logo-studio";
import { vectorizeLogo, LogoForgeError, logoForgeConfigured } from "@/lib/logoforge-client";
import { franchiseMakesForDealers, franchiseMakesForGroup } from "@/lib/logo-franchises";
import { sanitizeSvg, SvgSanitizeError } from "@/lib/svg-sanitize";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

const MAX_BYTES = 10 * 1024 * 1024;
const FORMATS = new Set(["png", "jpeg", "webp"]);

/**
 * POST /api/logo-studio/vectorize?scope=dealer|group[&group=<uuid>][&dealer=<expected text id>]
 * multipart `file` (PNG/JPG/WEBP) → { svg, regions, franchises } — a PREVIEW
 * only; nothing is stored until /api/logo-studio/save.
 *
 * Proxies to the private DA-LogoForge service (lib/logoforge-client.ts) with
 * library badge replacement constrained to the scope's franchise makes. The
 * returned SVG is already run through the platform intake guard.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const params = req.nextUrl.searchParams;
  const { claims, scope, error } = await requireLogoScope(params, params.get("dealer"));
  if (error) return error;
  if (!logoForgeConfigured()) return NextResponse.json({ error: "Logo cleanup isn't available right now." }, { status: 503 });
  if (!rateLimit(`logo-studio:${claims.sub}`, 12, 60_000)) {
    return NextResponse.json({ error: "Too many logo cleanups in a minute — wait a moment and try again." }, { status: 429 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof Blob)) return NextResponse.json({ error: "Choose an image to upload." }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "That image is larger than 10 MB." }, { status: 413 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Decide the format from the bytes, not the browser's MIME label.
  let format: string | undefined;
  try { format = (await sharp(bytes).metadata()).format; } catch { /* unreadable */ }
  if (!format || !FORMATS.has(format)) {
    return NextResponse.json({ error: "Upload a PNG, JPG or WEBP image. (Already have an SVG? Upload it directly with Change Logo.)" }, { status: 415 });
  }

  const franchises = scope.kind === "group"
    ? await franchiseMakesForGroup(scope.groupId)
    : await franchiseMakesForDealers([scope.dealerTextId]);

  try {
    const r = await vectorizeLogo(
      { bytes, type: `image/${format}`, name: (file as File).name || `logo.${format === "jpeg" ? "jpg" : format}` },
      franchises,
    );
    const { svg, report } = sanitizeSvg(r.svg);
    const replaced = r.regions.filter((x) => x.decision === "replaced" && x.make).map((x) => x.make as string);
    console.log(`[logo-studio] vectorize ${scope.kind}=${scope.kind === "group" ? scope.groupId : scope.dealerTextId} by=${claims.sub} `
      + `makes=[${franchises.join(",")}] replaced=[${replaced.join(",")}] ${r.durationMs}ms sanitizer_removed=${report.removedElements.length + report.removedAttrs.length}`);
    return NextResponse.json({ svg, width: r.width, height: r.height, franchises, replaced });
  } catch (e) {
    if (e instanceof LogoForgeError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof SvgSanitizeError) {
      console.error("[logo-studio] sanitizer rejected LogoForge output:", e.message);
      return NextResponse.json({ error: "The cleaned logo failed a safety check." }, { status: 502 });
    }
    console.error("[logo-studio] vectorize failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Logo cleanup failed." }, { status: 500 });
  }
}
