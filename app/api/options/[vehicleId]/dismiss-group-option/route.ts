import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

type Params = { params: { vehicleId: string } };

/**
 * POST /api/options/[vehicleId]/dismiss-group-option
 * Body: { groupOptionId: string }
 *
 * Records a per-vehicle dismissal of an unlocked corporate (group_options)
 * product. The product stays in the group library and stays applied to
 * every OTHER vehicle for this dealer — the dismissal is scoped to this
 * one vehicle.
 *
 * Server-side guard: refuse to dismiss locked products. The UI hides the
 * remove button for locked products, but a defensive check here ensures
 * a crafted request can't drop a locked product.
 */
export async function POST(
  req: NextRequest,
  { params }: Params,
): Promise<NextResponse> {
  const { error } = await requireAuth();
  if (error) return error;

  let body: { groupOptionId?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const groupOptionId = body.groupOptionId?.trim();
  if (!groupOptionId) {
    return NextResponse.json({ error: "groupOptionId is required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Confirm the group option exists AND is unlocked. Refuse to dismiss
  // locked products; the dealer shouldn't have surfaced a remove button for
  // those, but treat this as the system of record.
  const { data: opt } = await admin
    .from("group_options")
    .select("id, locked")
    .eq("id", groupOptionId)
    .maybeSingle<{ id: string; locked: boolean | null }>();
  if (!opt) {
    return NextResponse.json({ error: "Group option not found" }, { status: 404 });
  }
  if (opt.locked !== false) {
    return NextResponse.json(
      { error: "Cannot dismiss a locked corporate product" },
      { status: 403 },
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: insErr } = await (admin as any)
    .from("dealer_dismissed_group_options")
    .upsert(
      { vehicle_id: params.vehicleId, group_option_id: groupOptionId, dismissed_at: new Date().toISOString() },
      { onConflict: "vehicle_id,group_option_id" },
    );
  if (insErr) {
    return NextResponse.json({ error: insErr.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/options/[vehicleId]/dismiss-group-option?groupOptionId=…
 *
 * Restores a previously-dismissed corporate product on this vehicle. Used
 * if the dealer changes their mind. Idempotent — succeeds even if no
 * dismissal row exists.
 */
export async function DELETE(
  req: NextRequest,
  { params }: Params,
): Promise<NextResponse> {
  const { error } = await requireAuth();
  if (error) return error;

  const groupOptionId = req.nextUrl.searchParams.get("groupOptionId")?.trim();
  if (!groupOptionId) {
    return NextResponse.json({ error: "groupOptionId is required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: dbError } = await (admin as any)
    .from("dealer_dismissed_group_options")
    .delete()
    .eq("vehicle_id", params.vehicleId)
    .eq("group_option_id", groupOptionId);
  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
