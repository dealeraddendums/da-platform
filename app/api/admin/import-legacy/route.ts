import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

interface LegacyGroup {
  legacy_id: number;
  internal_id: string;
  name: string;
  [key: string]: unknown;
}

interface LegacyDealer {
  legacy_id: number;
  dealer_group_legacy: string | null;
  [key: string]: unknown;
}

interface ImportPayload {
  exported_at?: string;
  groups: LegacyGroup[];
  dealers: LegacyDealer[];
}

/**
 * POST /api/admin/import-legacy
 * Accepts a parsed legacy-export JSON body and upserts groups + dealers into Supabase.
 * super_admin only.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let payload: ImportPayload;
  try {
    payload = await req.json() as ImportPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { groups, dealers } = payload;
  if (!Array.isArray(groups) || !Array.isArray(dealers)) {
    return NextResponse.json({ error: "Payload must have groups[] and dealers[] arrays" }, { status: 400 });
  }

  const start = Date.now();
  const admin = createAdminSupabaseClient();

  // ── Upsert groups ──────────────────────────────────────────────────────────
  if (groups.length > 0) {
    const { error: gErr } = await admin
      .from("groups")
      .upsert(groups as unknown as never[], { onConflict: "legacy_id" });
    if (gErr) {
      return NextResponse.json({ error: `Groups import failed: ${gErr.message}` }, { status: 500 });
    }
  }

  // ── Upsert dealers in chunks of 500 ───────────────────────────────────────
  const CHUNK = 500;
  let dealersImported = 0;
  for (let i = 0; i < dealers.length; i += CHUNK) {
    const chunk = dealers.slice(i, i + CHUNK);
    const { error: dErr } = await admin
      .from("dealers")
      .upsert(chunk as unknown as never[], { onConflict: "legacy_id" });
    if (dErr) {
      return NextResponse.json({ error: `Dealers import failed at offset ${i}: ${dErr.message}` }, { status: 500 });
    }
    dealersImported += chunk.length;
  }

  // ── Link dealers → groups via dealer_group_legacy ─────────────────────────
  const { data: unlinked } = await admin
    .from("dealers")
    .select("id, dealer_group_legacy")
    .not("dealer_group_legacy", "is", null)
    .is("group_id", null);

  if (unlinked?.length) {
    const { data: allGroups } = await admin.from("groups").select("id, name");
    const nameToId = new Map(
      (allGroups ?? []).map((g) => [g.name.toLowerCase().trim(), g.id])
    );
    for (const d of unlinked) {
      const gid = d.dealer_group_legacy
        ? nameToId.get(d.dealer_group_legacy.toLowerCase().trim())
        : undefined;
      if (gid) {
        await admin.from("dealers").update({ group_id: gid }).eq("id", d.id);
      }
    }
  }

  // ── Record sync timestamp ─────────────────────────────────────────────────
  const syncedAt = new Date().toISOString();
  await admin
    .from("admin_settings")
    .upsert({ key: "last_dealer_sync", value: syncedAt });

  return NextResponse.json({
    groups_imported: groups.length,
    dealers_imported: dealersImported,
    duration_ms: Date.now() - start,
    synced_at: syncedAt,
    source: "file",
    file_exported_at: payload.exported_at ?? null,
  });
}
