import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerCustomSizeRow } from "@/lib/db";
import { resolveDealerForRequest } from "@/lib/dealer-authz";

/** GET /api/custom-sizes?dealer_id= — list dealer's custom sizes */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const authz = await resolveDealerForRequest(claims, req.nextUrl.searchParams.get("dealer_id"));
  if (!authz.ok) return authz.response;
  const dealerId = authz.dealerId;

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
  // Write action: dealer_user / dealer_restricted are read-only. dealer_admin,
  // a switched-in group_admin (active dealer), and super_admin may create.
  if (claims.role === "dealer_user" || claims.role === "dealer_restricted") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { name?: string; width_in?: number; height_in?: number; background_url?: string | null; dealer_id?: string; doc_type?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = body.name?.trim();
  const widthIn = Number(body.width_in);
  const heightIn = Number(body.height_in ?? 11);
  const backgroundUrl = body.background_url ?? null;
  const docType: 'addendum' | 'infosheet' = body.doc_type === 'infosheet' ? 'infosheet' : 'addendum';

  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (isNaN(widthIn) || widthIn <= 0 || widthIn > 24) {
    return NextResponse.json({ error: "width_in must be between 0 and 24 inches" }, { status: 400 });
  }

  // dealer_admin → own; group_admin → active dealer (group-verified); super_admin → body.dealer_id.
  const authz = await resolveDealerForRequest(claims, body.dealer_id);
  if (!authz.ok) return authz.response;
  const dealerId = authz.dealerId;

  const admin = createAdminSupabaseClient();
  const { data, error: dbErr } = await admin
    .from("dealer_custom_sizes")
    .insert({ dealer_id: dealerId, name, width_in: widthIn, height_in: heightIn, background_url: backgroundUrl, doc_type: docType })
    .select()
    .single<DealerCustomSizeRow>();

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data }, { status: 201 });
}
