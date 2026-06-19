import { NextRequest, NextResponse } from "next/server";
import { requireAuth, type JwtClaims } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { authorizeDealerAction } from "@/lib/dealer-authz";
import { BG_KEYS, type BgKey } from "@/lib/buyers-guide-constants";
import {
  checkDealerPdfExists,
  deleteDealerPdf,
  getDealerPdfSignedUrl,
  uploadDealerPdf,
} from "@/lib/buyers-guide-storage";

type Params = { params: { id: string; key: string } };

function validateKey(key: string): key is BgKey {
  return (BG_KEYS as string[]).includes(key);
}

async function authorize(claims: JwtClaims, dealerId: string): Promise<{ dealerUuid: string } | { authError: NextResponse }> {
  const admin = createAdminSupabaseClient();
  const { data: dealer } = await admin
    .from("dealers")
    .select("id, dealer_id")
    .eq("id", dealerId)
    .maybeSingle();

  if (!dealer) return { authError: NextResponse.json({ error: "Dealer not found" }, { status: 404 }) };

  // Buyers-guide PDF management is an admin task — dealer_user / dealer_restricted
  // are excluded (preserves prior behavior; not loosened).
  if (claims.role === "dealer_user" || claims.role === "dealer_restricted") {
    return { authError: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  // super_admin → any; dealer_admin → own; group_admin → in-group (the
  // active dealer they've switched into). Mirrors the logo route's authz so a
  // group_admin operating an in-group dealer can manage its buyer's-guide PDFs.
  const authz = await authorizeDealerAction(claims, dealer.dealer_id as string);
  if (!authz.ok) return { authError: authz.response };

  return { dealerUuid: dealer.id as string };
}

export async function GET(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (!validateKey(params.key)) {
    return NextResponse.json({ error: "Invalid key" }, { status: 400 });
  }

  const auth = await authorize(claims, params.id);
  if ("authError" in auth) return auth.authError;

  const hasCustom = await checkDealerPdfExists(auth.dealerUuid, params.key);
  const url = hasCustom ? await getDealerPdfSignedUrl(auth.dealerUuid, params.key) : null;
  return NextResponse.json({ hasCustom, url });
}

export async function PUT(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (!validateKey(params.key)) {
    return NextResponse.json({ error: "Invalid key" }, { status: 400 });
  }

  const auth = await authorize(claims, params.id);
  if ("authError" in auth) return auth.authError;

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (file.type !== "application/pdf") {
    return NextResponse.json({ error: "File must be a PDF" }, { status: 400 });
  }
  if (file.size > 20 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 20MB)" }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  await uploadDealerPdf(auth.dealerUuid, params.key, buf);
  const url = await getDealerPdfSignedUrl(auth.dealerUuid, params.key);
  return NextResponse.json({ ok: true, url });
}

export async function DELETE(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (!validateKey(params.key)) {
    return NextResponse.json({ error: "Invalid key" }, { status: 400 });
  }

  const auth = await authorize(claims, params.id);
  if ("authError" in auth) return auth.authError;

  await deleteDealerPdf(auth.dealerUuid, params.key);
  return new NextResponse(null, { status: 204 });
}
