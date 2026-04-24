import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerCustomSizeRow } from "@/lib/db";

async function resolveDealerId(req: NextRequest, claims: { role: string; dealer_id?: string | null }): Promise<string | null> {
  if (claims.role === "dealer_admin") return claims.dealer_id ?? null;
  const param = req.nextUrl.searchParams.get("dealer_id");
  return param ?? null;
}

/** GET /api/custom-sizes?dealer_id= — list dealer's custom sizes */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const dealerId = await resolveDealerId(req, claims);
  if (!dealerId) return NextResponse.json({ error: "dealer_id required" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data, error: dbErr } = await admin
    .from("dealer_custom_sizes")
    .select("*")
    .eq("dealer_id", dealerId)
    .order("name");

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}

/**
 * POST /api/custom-sizes — create a custom size
 * Accepts JSON: { name, width_in, height_in, background_url?, dealer_id? }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role === "dealer_user" || claims.role === "group_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { name?: string; width_in?: number; height_in?: number; background_url?: string | null; dealer_id?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = body.name?.trim();
  const widthIn = Number(body.width_in);
  const heightIn = Number(body.height_in ?? 11);
  const backgroundUrl = body.background_url ?? null;

  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (isNaN(widthIn) || widthIn <= 0 || widthIn > 24) {
    return NextResponse.json({ error: "width_in must be between 0 and 24 inches" }, { status: 400 });
  }

  const dealerId = claims.role === "dealer_admin"
    ? (claims.dealer_id ?? "")
    : (body.dealer_id ?? "");
  if (!dealerId) return NextResponse.json({ error: "dealer_id required" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data, error: dbErr } = await admin
    .from("dealer_custom_sizes")
    .insert({ dealer_id: dealerId, name, width_in: widthIn, height_in: heightIn, background_url: backgroundUrl })
    .select()
    .single<DealerCustomSizeRow>();

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data }, { status: 201 });
}
