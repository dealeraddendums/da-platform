import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerCustomSizeRow } from "@/lib/db";
import { uploadBackground } from "@/lib/s3-upload";

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

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
 * Accepts multipart/form-data:
 *   name, width_in, height_in, dealer_id (super_admin only), file? (background PNG)
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role === "dealer_user" || claims.role === "group_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let formData: FormData;
  try { formData = await req.formData(); } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const name = (formData.get("name") as string | null)?.trim();
  const widthIn = parseFloat((formData.get("width_in") as string) ?? "");
  const heightIn = parseFloat((formData.get("height_in") as string) ?? "11");
  const file = formData.get("file") as File | null;
  const paramDealerId = formData.get("dealer_id") as string | null;

  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (isNaN(widthIn) || widthIn <= 0 || widthIn > 24) {
    return NextResponse.json({ error: "width_in must be between 0 and 24 inches" }, { status: 400 });
  }

  const dealerId = claims.role === "dealer_admin"
    ? (claims.dealer_id ?? "")
    : (paramDealerId ?? "");
  if (!dealerId) return NextResponse.json({ error: "dealer_id required" }, { status: 400 });

  let backgroundUrl: string | null = null;
  if (file && file.size > 0) {
    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ error: "Background image must be under 5 MB" }, { status: 400 });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const key = `custom/${dealerId}/${slugify(name)}_${Date.now()}.png`;
    backgroundUrl = await uploadBackground(buffer, key);
  }

  const admin = createAdminSupabaseClient();
  const { data, error: dbErr } = await admin
    .from("dealer_custom_sizes")
    .insert({ dealer_id: dealerId, name, width_in: widthIn, height_in: heightIn, background_url: backgroundUrl })
    .select()
    .single<DealerCustomSizeRow>();

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data }, { status: 201 });
}
