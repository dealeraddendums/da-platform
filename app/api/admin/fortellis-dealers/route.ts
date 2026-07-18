import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

// fortellis_dealers is a new table (not in the generated Database types), so
// access goes through an `any`-cast admin client — same pattern as cdk_dealers.

interface FortellisRow {
  id: number;
  dealer_name: string;
  subscription_id: string;
  web_id: string | null;
  dealer_code: string | null;
  dealer_id: string | null;
  is_new: boolean;
  enabled: boolean;
  last_delta_at: string | null;
  last_full_sync_at: string | null;
  last_status: string | null;
  created_at: string | null;
}

/** GET /api/admin/fortellis-dealers — list all Fortellis dealer rows. super_admin only. */
export async function GET(): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbErr } = await (admin as any)
    .from("fortellis_dealers")
    .select("*")
    .order("dealer_name", { ascending: true });
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data: (data ?? []) as FortellisRow[] });
}

/** POST /api/admin/fortellis-dealers — create a new Fortellis dealer connection. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  let body: Partial<FortellisRow>;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const dealerName = (body.dealer_name ?? "").toString().trim();
  const subscriptionId = (body.subscription_id ?? "").toString().trim();
  if (!dealerName || !subscriptionId) {
    return NextResponse.json({ error: "dealer_name and subscription_id are required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbErr } = await (admin as any)
    .from("fortellis_dealers")
    .insert({
      dealer_name: dealerName,
      subscription_id: subscriptionId,
      web_id: (body.web_id ?? "").toString().trim() || null,
      dealer_code: (body.dealer_code ?? "").toString().trim() || null,
      dealer_id: (body.dealer_id ?? "").toString().trim() || null,
      is_new: true,
      enabled: body.enabled === false ? false : true,
    })
    .select("*")
    .single();
  if (dbErr) {
    const msg = /duplicate|unique/i.test(dbErr.message)
      ? "A dealer with that Subscription-Id already exists"
      : dbErr.message;
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  return NextResponse.json({ data: data as FortellisRow }, { status: 201 });
}
