import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { fortellisConfigured } from "@/lib/fortellis-api";
import { createAdminSupabaseClient } from "@/lib/db";
import { importDealer, DealerSyncError, markHealthy, markDown, isOutageSyncType, type FortellisDealerRow } from "@/lib/fortellis-sync";

/**
 * POST /api/admin/fortellis/import
 * Body: { id }  — the fortellis_dealers row id.
 *
 * Install pull for one dealer: full snapshot, insert-only against existing VINs,
 * flips is_new=false. super_admin only.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  if (!fortellisConfigured()) {
    return NextResponse.json({ error: "Fortellis credentials not configured" }, { status: 500 });
  }

  let body: { id?: number };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const id = Number(body.id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row } = await (admin as any).from("fortellis_dealers").select("*").eq("id", id).maybeSingle();
  if (!row) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  try {
    const r = await importDealer(admin, row as FortellisDealerRow);
    await markHealthy(admin).catch(() => {});
    return NextResponse.json({
      success: true,
      vehicles_found: r.found,
      vehicles_imported: r.imported,
      vehicles_skipped: r.skipped,
    });
  } catch (err) {
    const tagged = err instanceof DealerSyncError ? err : new DealerSyncError("other", err instanceof Error ? err.message : String(err));
    // Record run status on the dealer row.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).from("fortellis_dealers").update({ last_status: tagged.message.slice(0, 300) }).eq("id", id);
    if (isOutageSyncType(tagged.type)) {
      await markDown(admin, tagged.message).catch(() => {});
    }
    return NextResponse.json({ success: false, error: tagged.message, error_type: tagged.type }, { status: 200 });
  }
}
