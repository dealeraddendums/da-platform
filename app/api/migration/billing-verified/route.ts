import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PATCH /api/migration/billing-verified — migration 145.
 * super_admin sets/clears the operator "DA-Billing verified" attestation for a
 * dealer. Body: { dealerId: <dealers.id UUID>, verified: boolean }.
 *
 * This checkbox IS the billing readiness gate (replacing the auto-detected
 * staging check) and gates the migration invite — the invite fires the billing
 * cutover (da-billing go-live + FreshBooks recurring pause) for self-billed
 * dealers, so a human attests da-billing is correct before any invite can move
 * money. Writes billing_verified_by/_at and an admin_audit row.
 */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  let body: { dealerId?: string; verified?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.dealerId || !UUID_RE.test(body.dealerId) || typeof body.verified !== "boolean") {
    return NextResponse.json({ error: "dealerId (UUID) and verified (boolean) required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbError } = await (admin as any)
    .from("dealers")
    .update({
      billing_verified: body.verified,
      billing_verified_by: body.verified ? claims.sub : null,
      billing_verified_at: body.verified ? new Date().toISOString() : null,
    })
    .eq("id", body.dealerId)
    .select("id, dealer_id, name, billing_verified")
    .single();

  if (dbError) {
    if (/billing_verified|column/i.test(dbError.message)) {
      return NextResponse.json(
        { error: "billing_verified column missing — apply migration 145_billing_verified.sql first." },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  fireWrite(admin.from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: "billing_verified_set",
    target_dealer_id: (data as { dealer_id: string }).dealer_id,
    metadata: { verified: body.verified, dealer_uuid: body.dealerId, dealer_name: (data as { name: string | null }).name },
  }), "admin_audit billing_verified_set");

  return NextResponse.json({ ok: true, dealerId: (data as { id: string }).id, billing_verified: (data as { billing_verified: boolean }).billing_verified });
}
