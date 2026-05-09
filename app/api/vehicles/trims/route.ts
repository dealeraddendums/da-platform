import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

/**
 * GET /api/vehicles/trims?model_id=456
 * Returns NHTSA trims for the given model, deduplicated by name and sorted
 * alphabetically. NHTSA stores year-specific trim rows so we collapse by
 * lower-cased name to give the modal a clean flat list.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireAuth();
  if (error) return error;

  const modelIdRaw = req.nextUrl.searchParams.get("model_id");
  const modelId = modelIdRaw ? parseInt(modelIdRaw, 10) : NaN;
  if (Number.isNaN(modelId)) {
    return NextResponse.json({ error: "model_id required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const { data, error: dbErr } = await admin
    .from("nhtsa_trims")
    .select("id, name, model_id")
    .eq("model_id", modelId)
    .order("name", { ascending: true });

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });

  const seen = new Set<string>();
  const deduped = (data ?? []).filter(t => {
    const key = (t.name ?? "").trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return NextResponse.json({ data: deduped });
}
