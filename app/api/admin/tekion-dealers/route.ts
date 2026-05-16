import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

interface TekionRow {
  id: number;
  dealer_id: string | null;
  dealer_name: string | null;
  last_update?: string | null;
  created_at?: string | null;
}

/** GET /api/admin/tekion-dealers — list all Tekion dealer rows. */
export async function GET(): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbErr } = await (admin as any)
    .from("tekion_dealers")
    .select("*")
    .order("dealer_name", { ascending: true });
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data: (data ?? []) as TekionRow[] });
}

/** POST /api/admin/tekion-dealers — create new Tekion dealer row. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  let body: Partial<TekionRow>;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const dealerName = (body.dealer_name ?? "").toString().trim();
  const dealerId = (body.dealer_id ?? "").toString().trim();
  if (!dealerName || !dealerId) {
    return NextResponse.json({ error: "dealer_name and dealer_id are required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbErr } = await (admin as any)
    .from("tekion_dealers")
    .insert({ dealer_id: dealerId, dealer_name: dealerName })
    .select("*")
    .single();
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data }, { status: 201 });
}
