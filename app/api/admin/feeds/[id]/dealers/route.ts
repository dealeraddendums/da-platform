import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbErr } = await (admin as any)
    .from("feed_company_dealers")
    .select("id, dealer_uuid, feed_dealer_id, created_at, dealers(id, dealer_id, name)")
    .eq("feed_company_id", params.id)
    .order("created_at", { ascending: true });
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  let body: { dealer_id?: string; feed_dealer_id?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const dealerUuid = body.dealer_id?.trim();
  const feedDealerId = body.feed_dealer_id?.trim();
  if (!dealerUuid || !feedDealerId) {
    return NextResponse.json({ error: "dealer_id (platform UUID) and feed_dealer_id are required" }, { status: 400 });
  }
  const admin = createAdminSupabaseClient();
  const { data: dealer } = await admin
    .from("dealers").select("id, name").eq("id", dealerUuid).maybeSingle<{ id: string; name: string }>();
  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbErr } = await (admin as any)
    .from("feed_company_dealers")
    .insert({ feed_company_id: params.id, dealer_uuid: dealerUuid, feed_dealer_id: feedDealerId })
    .select("id, dealer_uuid, feed_dealer_id")
    .single();
  if (dbErr) {
    const msg = /duplicate|unique/i.test(dbErr.message) ? "That dealer is already in this feed" : dbErr.message;
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  return NextResponse.json({ data }, { status: 201 });
}
