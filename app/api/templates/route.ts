import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import type { JwtClaims } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

async function resolveDealerId(
  req: NextRequest,
  claims: JwtClaims
): Promise<{ dealerId: string } | { dealerError: NextResponse }> {
  if (claims.role === "dealer_admin" || claims.role === "dealer_user") {
    if (!claims.dealer_id) {
      return { dealerError: NextResponse.json({ error: "No dealer assigned" }, { status: 403 }) };
    }
    return { dealerId: claims.dealer_id };
  }
  const paramId = req.nextUrl.searchParams.get("dealer_id");
  if (!paramId) {
    return { dealerError: NextResponse.json({ error: "dealer_id param required" }, { status: 400 }) };
  }
  if (claims.role === "group_admin") {
    const admin = createAdminSupabaseClient();
    const { data: dealer } = await admin.from("dealers").select("group_id").eq("dealer_id", paramId).single();
    if (!dealer || dealer.group_id !== claims.group_id) {
      return { dealerError: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }
  }
  return { dealerId: paramId };
}

/**
 * GET /api/templates?dealer_id=xxx
 * Returns all templates for a dealer.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const resolved = await resolveDealerId(req, claims);
  if ("dealerError" in resolved) return resolved.dealerError;
  const { dealerId } = resolved;

  const admin = createAdminSupabaseClient();
  const { data, error: fetchErr } = await admin
    .from("templates")
    .select("*")
    .eq("dealer_id", dealerId)
    .order("created_at", { ascending: false });

  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  }

  return NextResponse.json({ data: data ?? [] });
}

/**
 * POST /api/templates
 * Creates a new template. dealer_admin+ only.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role === "dealer_user") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const resolved = await resolveDealerId(req, claims);
  if ("dealerError" in resolved) return resolved.dealerError;
  const { dealerId } = resolved;

  let body: { name?: string; document_type?: string; vehicle_types?: string[]; template_json?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (body.document_type !== "addendum" && body.document_type !== "infosheet") {
    return NextResponse.json({ error: "document_type must be addendum or infosheet" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const { data, error: insertErr } = await admin
    .from("templates")
    .insert({
      dealer_id: dealerId,
      name: body.name.trim(),
      document_type: body.document_type,
      vehicle_types: body.vehicle_types ?? [],
      template_json: body.template_json ?? {},
    })
    .select()
    .single();

  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  return NextResponse.json({ data }, { status: 201 });
}
