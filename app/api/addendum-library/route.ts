import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { AddendumLibraryRow } from "@/lib/db";

/**
 * GET /api/addendum-library?dealer_id=XXX&page=1&per_page=25
 * Returns the dealer's Supabase-based option library.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const url = req.nextUrl;
  const dealerId = url.searchParams.get("dealer_id") ?? claims.dealer_id;
  if (!dealerId) {
    return NextResponse.json({ error: "dealer_id required" }, { status: 400 });
  }

  // Scope check: non-admins can only fetch their own dealer
  if (
    (claims.role === "dealer_admin" || claims.role === "dealer_user") &&
    claims.dealer_id !== dealerId
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const page = parseInt(url.searchParams.get("page") ?? "1", 10);
  const perPage = Math.min(parseInt(url.searchParams.get("per_page") ?? "25", 10), 100);
  const from = (page - 1) * perPage;

  const admin = createAdminSupabaseClient();
  const { data, error: dbError, count } = await admin
    .from("addendum_library")
    .select("*", { count: "exact" })
    .eq("dealer_id", dealerId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
    .range(from, from + perPage - 1);

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  return NextResponse.json({
    data: (data ?? []) as AddendumLibraryRow[],
    total: count ?? 0,
    page,
    per_page: perPage,
  });
}

/**
 * POST /api/addendum-library
 * Creates a new option in the dealer's library.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role !== "dealer_admin" && claims.role !== "dealer_user" && claims.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: Partial<AddendumLibraryRow>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const dealerId = claims.role === "super_admin" ? (body.dealer_id ?? claims.dealer_id) : claims.dealer_id;
  if (!dealerId) {
    return NextResponse.json({ error: "dealer_id required" }, { status: 400 });
  }

  if (!body.option_name?.trim()) {
    return NextResponse.json({ error: "option_name required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Set sort_order to end of list
  const { data: last } = await admin
    .from("addendum_library")
    .select("sort_order")
    .eq("dealer_id", dealerId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .single();
  const nextOrder = last ? (last.sort_order ?? 0) + 10 : 10;

  const { data, error: dbError } = await admin
    .from("addendum_library")
    .insert({
      dealer_id: dealerId,
      option_name: body.option_name.trim(),
      item_price: body.item_price ?? "",
      description: body.description ?? "",
      ad_type: body.ad_type ?? "Both",
      makes: body.makes ?? "",
      makes_not: body.makes_not ?? false,
      models: body.models ?? "",
      models_not: body.models_not ?? false,
      trims: body.trims ?? "",
      trims_not: body.trims_not ?? false,
      body_styles: body.body_styles ?? "",
      year_condition: body.year_condition ?? 0,
      year_value: body.year_value ?? null,
      miles_condition: body.miles_condition ?? 0,
      miles_value: body.miles_value ?? null,
      msrp_condition: body.msrp_condition ?? 0,
      msrp1: body.msrp1 ?? null,
      msrp2: body.msrp2 ?? null,
      sort_order: nextOrder,
      active: body.active ?? true,
      show_models_only: body.show_models_only ?? false,
      separator_above: body.separator_above ?? false,
      separator_below: body.separator_below ?? false,
      spaces: body.spaces ?? 2,
    })
    .select()
    .single();

  if (dbError || !data) {
    return NextResponse.json({ error: dbError?.message ?? "Insert failed" }, { status: 500 });
  }

  return NextResponse.json({ data: data as AddendumLibraryRow }, { status: 201 });
}
