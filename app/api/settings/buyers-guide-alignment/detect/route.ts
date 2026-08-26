import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { requireAuth } from "@/lib/auth";
import { authorizeDealerAction } from "@/lib/dealer-authz";
import { bgFieldDefs, BG_PAGE_W, BG_PAGE_H } from "@/lib/buyers-guide-alignment-constants";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/settings/buyers-guide-alignment/detect — Phase 2 auto-approximate.
 * The dealer photographs the FRONT and BACK of their blank pre-printed FTC
 * label; Claude vision locates each standard field's fill-in position and the
 * form boundary on each photo; we map the normalized anchors into PDF points
 * and return SUGGESTED offsets (global = median delta, fields = residuals).
 * This is an approximation — the alignment tool + test print finish the job.
 * Photos are processed in-memory only, never stored.
 *
 * Body: { front: dataUrl, back?: dataUrl, language: "en"|"es", implied?: bool }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (!["super_admin", "dealer_admin", "group_admin"].includes(claims.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const param = req.nextUrl.searchParams.get("dealer_id")?.trim() || claims.dealer_id || null;
  if (claims.role !== "super_admin" && param) {
    const authz = await authorizeDealerAction(claims, param);
    if (!authz.ok) return authz.response;
  }

  // Vision calls are expensive — cap per user (per-worker limiter is fine for
  // an authed, low-volume calibration endpoint; the check-email precedent).
  if (!rateLimit(`bg-detect:${claims.sub}`, 10, 60_000)) {
    return NextResponse.json({ error: "Too many auto-detect attempts — wait a minute and try again (or align manually)." }, { status: 429 });
  }

  let body: { front?: string; back?: string; language?: string; implied?: boolean; flattened?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body.front) return NextResponse.json({ error: "front photo required" }, { status: 400 });

  const language = body.language === "es" ? "es" : "en";
  const defs = bgFieldDefs(language, body.implied === true);

  const parseImage = (dataUrl: string): { media_type: "image/jpeg" | "image/png" | "image/webp"; data: string } | null => {
    const m = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
    if (!m) return null;
    return { media_type: m[1] as "image/jpeg" | "image/png" | "image/webp", data: m[2] };
  };
  const front = parseImage(body.front);
  const back = body.back ? parseImage(body.back) : null;
  if (!front) return NextResponse.json({ error: "front must be a jpeg/png/webp data URL" }, { status: 400 });

  const frontKeys = defs.filter((d) => d.page === 0).map((d) => `${d.key} (${d.label})`).join(", ");
  const backKeys = defs.filter((d) => d.page === 1).map((d) => `${d.key} (${d.label})`).join(", ");

  const prompt = (side: "front" | "back", keys: string) => `This is a photo of the ${side} of a blank pre-printed FTC Used Car Buyers Guide label (language: ${language === "es" ? "Spanish" : "English"}). Locate:
1. "form": the bounding box of the printed FORM itself (the label's printed area, excluding photo background/table surface), as {left, top, right, bottom} in normalized 0-1 image coordinates (top-left origin).
2. For each of these fill-in fields, the anchor point where the FIRST TYPED CHARACTER of the variable data should be placed — this is INSIDE the blank space reserved for the answer, NOT on the printed caption/label text. For text fields: the left edge of the empty blank (just after the caption or under the column heading), at the height where typed text would sit on the ruled line. For checkbox fields: the exact CENTER of the empty checkbox square. Fields: ${keys}.
Return ONLY JSON: {"form": {"left":..,"top":..,"right":..,"bottom":..}, "fields": {"<key>": {"x":.., "y":..}, ...}} with normalized 0-1 coordinates (top-left origin). Omit any field you cannot find.`;

  const anthropic = new Anthropic();
  async function detectSide(img: { media_type: "image/jpeg" | "image/png" | "image/webp"; data: string }, side: "front" | "back", keys: string) {
    const resp = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1500,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } },
          { type: "text", text: prompt(side, keys) },
        ],
      }],
    });
    const text = resp.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`no JSON in vision response (${side})`);
    return JSON.parse(jsonMatch[0]) as { form: { left: number; top: number; right: number; bottom: number }; fields: Record<string, { x: number; y: number }> };
  }

  try {
    const [frontDet, backDet] = await Promise.all([
      detectSide(front, "front", frontKeys),
      back ? detectSide(back, "back", backKeys) : Promise.resolve(null),
    ]);

    // Map each normalized anchor into PDF points via the detected form bounds.
    // The model's "form" box is the PRINTED AREA, which on the FTC layout sits
    // inside 54pt (3/4") margins on a 612×792 page (measured from our own
    // form renders — both sides: 54,54 → 558,738). Mapping the detected box to
    // the FULL page stretched everything ~10% and skewed the deltas (the first
    // live run's systematic −50pt x bias); mapping to the printed rect makes a
    // straight-on photo of a standard label come out near-zero. Linear map —
    // the test print + manual nudge absorb residual perspective/skew.
    const PRINT = { left: 54, top: 54, right: 558, bottom: 738 };
    // Flattened images (the alignment tool since the corner-outline flow) ARE
    // the full label page — the printed area sits at the known 54pt margins,
    // so the form box is deterministic and the model's own box estimate (the
    // dominant noise source: ±40pt of global bias between runs on the same
    // true-zero form — the reported "fields drop an inch after straighten")
    // is discarded. Raw-photo callers keep the model-box path.
    const flattened = body.flattened === true;
    const FLAT_FORM = { left: PRINT.left / BG_PAGE_W, top: PRINT.top / BG_PAGE_H, right: PRINT.right / BG_PAGE_W, bottom: PRINT.bottom / BG_PAGE_H };
    const toPts = (det: { form: { left: number; top: number; right: number; bottom: number }; fields: Record<string, { x: number; y: number }> }, page: 0 | 1) => {
      const form = flattened ? FLAT_FORM : det.form;
      const fw = Math.max(form.right - form.left, 0.05);
      const fh = Math.max(form.bottom - form.top, 0.05);
      const out: Record<string, { x: number; y: number }> = {};
      for (const [k, a] of Object.entries(det.fields ?? {})) {
        const def = defs.find((d) => d.key === k && d.page === page);
        if (!def || typeof a?.x !== "number" || typeof a?.y !== "number") continue;
        const xTop = PRINT.left + ((a.x - form.left) / fw) * (PRINT.right - PRINT.left);
        const yTop = PRINT.top + ((a.y - form.top) / fh) * (PRINT.bottom - PRINT.top);
        out[k] = { x: xTop, y: BG_PAGE_H - yTop }; // flip to bottom-left origin
      }
      return out;
    };
    const detected: Record<string, { x: number; y: number }> = {
      ...toPts(frontDet, 0),
      ...(backDet ? toPts(backDet, 1) : {}),
    };

    // Deltas vs the calibrated defaults → suggested global (median) + residuals.
    const deltas: Record<string, { x: number; y: number }> = {};
    for (const def of defs) {
      const d = detected[def.key];
      if (!d) continue;
      deltas[def.key] = { x: Math.round(d.x - def.x), y: Math.round(d.y - def.y) };
    }
    // Low confidence: if the model located under a third of the known fields,
    // the photo is probably unusable (blur/glare/crop) — degrade to manual
    // rather than pre-filling garbage.
    if (Object.keys(deltas).length < Math.max(4, Math.floor(defs.length / 3))) {
      return NextResponse.json({
        error: `Couldn't auto-place enough fields (found ${Object.keys(deltas).length} of ${defs.length}) — the photo may be blurry, cropped, or glary. Retake it straight-on in good light, or align manually with the backdrop.`,
      }, { status: 422 });
    }

    const xs = Object.values(deltas).map((d) => d.x).sort((a, b) => a - b);
    const ys = Object.values(deltas).map((d) => d.y).sort((a, b) => a - b);
    const median = (arr: number[]) => (arr.length ? arr[Math.floor(arr.length / 2)] : 0);
    const global = { x: median(xs), y: median(ys) };
    const fields: Record<string, { x: number; y: number }> = {};
    // Per-field residual dead-zone: vision anchors carry ~16pt median noise
    // even on a perfectly-aligned form, so on flattened (geometry-exact)
    // images small residuals are noise — trust the calibrated default and
    // keep only genuine deviations (e.g. the %labor/%parts blanks at 80pt+).
    const deadZone = flattened ? 8 : 1;
    for (const [k, d] of Object.entries(deltas)) {
      const rx = d.x - global.x, ry = d.y - global.y;
      if (Math.abs(rx) > deadZone || Math.abs(ry) > deadZone) fields[k] = { x: rx, y: ry };
    }

    return NextResponse.json({ ok: true, global, fields, detected_count: Object.keys(deltas).length, total_fields: defs.length });
  } catch (e) {
    return NextResponse.json({ error: `Auto-detect failed: ${e instanceof Error ? e.message : String(e)} — use the manual backdrop alignment instead.` }, { status: 502 });
  }
}
