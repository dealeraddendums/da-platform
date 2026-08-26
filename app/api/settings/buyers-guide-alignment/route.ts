import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import { authorizeDealerAction } from "@/lib/dealer-authz";

export const dynamic = "force-dynamic";

/**
 * Buyer's Guide pre-printed-label alignment config (migration 150).
 *   GET  ?dealer_id=  → { config }
 *   PUT  ?dealer_id=  body { enabled, global:{x,y}, fields:{key:{x,y}}, language, note }
 * Auth: super_admin any; dealer_admin own dealer; group_admin in-group
 * (authorizeDealerAction). Offsets are PDF points from the calibrated default
 * positions — the variable-field SET never changes (compliance), only
 * placement. This is a per-DEALER print setting (their physical label), so a
 * group-controlled-templates dealer still manages their own alignment.
 */

const FIELD_KEYS = new Set([
  "make", "model", "year", "vin",
  "asIs", "implied", "dlrW", "full", "lim",
  "labor", "parts", "systems", "duration",
  "mfrNew", "mfrUsed", "othUsed", "svcCont",
  "name", "addr", "phone", "email", "complaints",
]);
const MAX_OFFSET = 300; // pts — sanity clamp; a field can't leave the page

async function resolveDealer(req: NextRequest): Promise<{ dealerTextId: string } | { response: NextResponse }> {
  const { claims, error } = await requireAuth();
  if (error) return { response: error };
  if (!["super_admin", "dealer_admin", "group_admin"].includes(claims.role)) {
    return { response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  const param = req.nextUrl.searchParams.get("dealer_id")?.trim() || null;
  const dealerTextId = claims.role === "dealer_admin" ? (claims.dealer_id ?? null) : (param ?? claims.dealer_id ?? null);
  if (!dealerTextId) return { response: NextResponse.json({ error: "dealer_id required" }, { status: 400 }) };
  if (claims.role !== "super_admin") {
    const authz = await authorizeDealerAction(claims, dealerTextId);
    if (!authz.ok) return { response: authz.response };
  }
  return { dealerTextId };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const r = await resolveDealer(req);
  if ("response" in r) return r.response;
  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any)
    .from("dealer_settings")
    .select("bg_preprinted_config")
    .eq("dealer_id", r.dealerTextId)
    .maybeSingle();
  return NextResponse.json({ config: data?.bg_preprinted_config ?? null });
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  const r = await resolveDealer(req);
  if ("response" in r) return r.response;

  let body: { enabled?: boolean; global?: { x?: number; y?: number }; fields?: Record<string, { x?: number; y?: number }>; language?: string; note?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const clamp = (v: unknown) => Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, Number(v) || 0));
  const fields: Record<string, { x: number; y: number }> = {};
  for (const [k, v] of Object.entries(body.fields ?? {})) {
    if (!FIELD_KEYS.has(k) || !v || typeof v !== "object") continue;
    const x = clamp(v.x), y = clamp(v.y);
    if (x !== 0 || y !== 0) fields[k] = { x, y };
  }
  const config = {
    enabled: body.enabled === true,
    global: { x: clamp(body.global?.x), y: clamp(body.global?.y) },
    fields,
    language: body.language === "es" ? "es" : "en",
    note: typeof body.note === "string" ? body.note.slice(0, 500) : undefined,
    updated_at: new Date().toISOString(),
    updated_by: claims.sub,
  };

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: upErr } = await (admin as any)
    .from("dealer_settings")
    .upsert({ dealer_id: r.dealerTextId, bg_preprinted_config: config }, { onConflict: "dealer_id" });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fireWrite((admin as any).from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: "bg_preprinted_config_set",
    metadata: { dealer_id: r.dealerTextId, enabled: config.enabled, global: config.global, field_count: Object.keys(fields).length },
  }), "admin_audit bg_preprinted");

  return NextResponse.json({ ok: true, config });
}
