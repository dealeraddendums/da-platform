import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PATCH /api/migration/template-confirmed — Phase 13b step 1.
 * super_admin sets/clears the operator "template confirmed" flag for a dealer.
 * Body: { dealerId: <dealers.id UUID>, confirmed: boolean }.
 * The ONLY write in the readiness console (everything else is computed).
 */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  let body: { dealerId?: string; confirmed?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.dealerId || !UUID_RE.test(body.dealerId) || typeof body.confirmed !== "boolean") {
    return NextResponse.json({ error: "dealerId (UUID) and confirmed (boolean) required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  // Cast to any: template_confirmed (migration 100) isn't in the generated types yet.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbError } = await (admin as any)
    .from("dealers")
    .update({ template_confirmed: body.confirmed })
    .eq("id", body.dealerId)
    .select("id, template_confirmed")
    .single();

  if (dbError) {
    const msg = dbError.message;
    if (/template_confirmed|column/i.test(msg)) {
      return NextResponse.json(
        { error: "template_confirmed column missing — apply migration 100_migration_readiness.sql first." },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  return NextResponse.json({ ok: true, dealerId: data.id, template_confirmed: (data as { template_confirmed: boolean }).template_confirmed });
}
