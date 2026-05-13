import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

type Params = { params: { id: string } };

/**
 * GET /api/dealers/[id]/delete-preview
 *
 * Returns the row-count breakdown the Delete confirmation modal renders
 * before the user types-to-confirm. super_admin only. Counts only — no
 * mutations — so it's safe to call even on non-test dealers (the actual
 * DELETE is still gated on is_test).
 */
export async function GET(
  _req: NextRequest,
  { params }: Params,
): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  const { data: dealer, error: loadErr } = await admin
    .from("dealers")
    .select("id, dealer_id, name, is_test")
    .eq("id", params.id)
    .maybeSingle<{ id: string; dealer_id: string; name: string; is_test: boolean }>();
  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 });
  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  const [vehiclesC, addendumC, printC, optionsC, usersRes] = await Promise.all([
    admin.from("dealer_vehicles").select("id", { count: "exact", head: true }).eq("dealer_id", dealer.dealer_id),
    admin.from("addendum_data").select("id", { count: "exact", head: true }).eq("dealer_id", dealer.id),
    admin.from("print_history").select("id", { count: "exact", head: true }).eq("dealer_id", dealer.dealer_id),
    admin.from("vehicle_options").select("id", { count: "exact", head: true }).eq("dealer_id", dealer.dealer_id),
    admin.from("profiles").select("id", { count: "exact", head: true }).eq("dealer_id", dealer.dealer_id),
  ]);

  return NextResponse.json({
    dealer: { id: dealer.id, dealer_id: dealer.dealer_id, name: dealer.name, is_test: dealer.is_test },
    counts: {
      vehicles: vehiclesC.count ?? 0,
      addendum_line_items: addendumC.count ?? 0,
      print_records: printC.count ?? 0,
      options: optionsC.count ?? 0,
      users: usersRes.count ?? 0,
    },
  });
}
