import { NextRequest, NextResponse } from "next/server";
import { requireAuth, type JwtClaims } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { aiConditionLabel, effectiveDescriptionModifiers, generateInfosheetDescription } from "@/lib/vehicle-description-ai";

export const dynamic = "force-dynamic";

/** Same dealer scope as the POST below and PATCH /api/dealer-vehicles/[id]. */
function sessionDealer(claims: JwtClaims): string | null {
  const isAdminLevel = (claims.role === "super_admin" || claims.role === "group_admin")
    && !claims.impersonating_dealer_id && !claims.is_ghost && !claims.active_dealer_id;
  const dealerId = claims.impersonating_dealer_id ?? claims.dealer_id;
  return isAdminLevel || !dealerId ? null : dealerId;
}

/**
 * GET /api/ai-content/vehicle-description?vehicleId= — what Edit Vehicle
 * pre-loads into its Infosheet description box when the dealer has saved
 * nothing: the vehicle's cached auto-generated AI description
 * (ai_content_cache, written at print time), plus whether AI content is on
 * for the dealer. Read-only — never generates, never writes.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  const dealerId = sessionDealer(claims);
  if (!dealerId) return NextResponse.json({ error: "Switch into a dealership to view descriptions." }, { status: 403 });
  const vehicleId = new URL(req.url).searchParams.get("vehicleId") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(vehicleId)) return NextResponse.json({ error: "vehicleId required" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data: v } = await admin.from("dealer_vehicles").select("vin").eq("id", vehicleId).eq("dealer_id", dealerId).maybeSingle();
  if (!v) return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
  const vin = String((v as { vin?: string | null }).vin ?? "").trim().toUpperCase();
  const [{ data: cached }, { data: settings }] = await Promise.all([
    vin
      ? admin.from("ai_content_cache").select("description, generated_at").eq("vin", vin).eq("dealer_id", dealerId).maybeSingle()
      : Promise.resolve({ data: null }),
    admin.from("dealer_settings").select("ai_content_default").eq("dealer_id", dealerId).maybeSingle(),
  ]);
  const c = cached as { description?: string | null; generated_at?: string | null } | null;
  return NextResponse.json({
    cachedDescription: c?.description?.trim() || null,
    cachedAt: c?.generated_at ?? null,
    aiEnabled: (settings as { ai_content_default?: boolean } | null)?.ai_content_default === true,
  }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * POST /api/ai-content/vehicle-description { vehicleId } — Edit Vehicle's
 * "Generate" for the INFOSHEET description (2026-10-09). Each call is a fresh
 * draft (re-roll); NOTHING is saved here — the dealer's Save in Edit Vehicle
 * writes dealer_vehicles.infosheet_ai_description via PATCH /api/dealer-vehicles/[id].
 *
 * Scope = the same as that PATCH: the session's dealer (impersonated / ghosted /
 * switched-into / own); a platform- or group-level admin with no dealer context
 * is refused. The vehicle must belong to that dealer. Vehicle facts and the
 * house-rule modifiers are read server-side — the client sends only the id.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  const dealerId = sessionDealer(claims);
  if (!dealerId) return NextResponse.json({ error: "Switch into a dealership to generate descriptions." }, { status: 403 });
  if (claims.role === "dealer_restricted") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // One AI call per click — keep it reasonable per user.
  if (!rateLimit(`vehicle-desc:${claims.sub}`, 20, 60_000)) {
    return NextResponse.json({ error: "Too many requests — wait a minute and try again." }, { status: 429 });
  }
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "AI content not configured" }, { status: 503 });

  const body = await req.json().catch(() => ({})) as { vehicleId?: unknown };
  const vehicleId = typeof body.vehicleId === "string" ? body.vehicleId : "";
  if (!/^[0-9a-f-]{36}$/i.test(vehicleId)) return NextResponse.json({ error: "vehicleId required" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data: v } = await admin.from("dealer_vehicles").select("*").eq("id", vehicleId).eq("dealer_id", dealerId).maybeSingle();
  if (!v) return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
  const row = v as Record<string, unknown>;
  const s = (k: string) => (row[k] == null || row[k] === "" ? null : String(row[k]));

  const mods = await effectiveDescriptionModifiers(admin, dealerId);
  try {
    const text = await generateInfosheetDescription({
      year: s("year"), make: s("make"), model: s("model"), trim: s("trim"),
      colorExt: s("exterior_color"), interiorColor: s("interior_color"),
      mileage: s("mileage"),
      condition: aiConditionLabel(row as never),
      engine: s("engine"), transmission: s("transmission"), drivetrain: s("drivetrain"),
      fuel: s("fuel"), bodyStyle: s("body_style"), cmpg: s("cmpg"), hmpg: s("hmpg"),
      options: s("options") ? String(row.options).split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean) : [],
    }, mods.lines);
    if (!text) return NextResponse.json({ error: "The AI returned nothing — try again." }, { status: 502 });
    return NextResponse.json({ description: text, modifiersApplied: mods.lines.length }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[vehicle-description] generation failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Generation failed — try again." }, { status: 502 });
  }
}
