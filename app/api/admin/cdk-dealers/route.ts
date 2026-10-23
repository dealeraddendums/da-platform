import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { cdkRosterStatuses } from "@/lib/feed-health";

// cdk_dealers table uses quoted UPPERCASE column names. PostgREST surfaces
// them as-is via the JS client so .select('"DEALER_NAME"') etc. just works.

interface CdkRow {
  id: number;
  DEALER_ID: string | null;
  ICOMPANY: string | null;
  DEALER_NAME: string | null;
  NEW: string | null;
  LAST_DELTA?: string | null;
  created_at?: string | null;
}

/** GET /api/admin/cdk-dealers — list all CDK dealer rows. super_admin only. */
export async function GET(): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbErr } = await (admin as any)
    .from("cdk_dealers")
    .select("*")
    .order("DEALER_NAME", { ascending: true });
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  // Feed health per row (lib/feed-health.ts). Best effort: the list still loads without it.
  // Per roster row: DEALER_ID isn't unique (3PA0003717 is two stores).
  const health = await cdkRosterStatuses(admin, data ?? []).catch(() => null);
  const byRow = new Map((health ?? []).map((h) => [h.rosterId, h]));
  const rows = ((data ?? []) as CdkRow[]).map((r) => ({ ...r, feed_health: byRow.get(r.id) ?? null }));
  return NextResponse.json({ data: rows });
}

/** POST /api/admin/cdk-dealers — create new CDK dealer row. super_admin only. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  let body: Partial<CdkRow>;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const dealerName = (body.DEALER_NAME ?? "").toString().trim();
  const dealerId = (body.DEALER_ID ?? "").toString().trim();
  const iCompany = (body.ICOMPANY ?? "").toString().trim();
  if (!dealerName || !dealerId || !iCompany) {
    return NextResponse.json({ error: "DEALER_NAME, DEALER_ID, ICOMPANY are required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbErr } = await (admin as any)
    .from("cdk_dealers")
    .insert({
      DEALER_ID: dealerId,
      ICOMPANY: iCompany,
      DEALER_NAME: dealerName,
      NEW: body.NEW === "Yes" ? "Yes" : "No",
    })
    .select("*")
    .single();
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data: data as CdkRow }, { status: 201 });
}
