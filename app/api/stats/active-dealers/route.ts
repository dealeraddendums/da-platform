import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";

/**
 * GET /api/stats/active-dealers → { count }
 *
 * Read-only count of active, non-test dealers for the marketing OS admin
 * dashboard (its Supabase holds no dealer records). Authed with the same
 * shared secret the marketing site already uses for self-serve signup
 * (SELF_SERVE_API_KEY, X-API-Key header) — one secret between exactly these
 * two systems, no new env plumbing.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const configuredKey = process.env.SELF_SERVE_API_KEY;
  if (!configuredKey) {
    console.error("[stats/active-dealers] SELF_SERVE_API_KEY not configured — refusing");
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }
  if (req.headers.get("x-api-key") !== configuredKey) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminSupabaseClient();
  const { count, error } = await admin
    .from("dealers")
    .select("id", { count: "exact", head: true })
    .eq("active", true)
    .eq("is_test", false);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ count: count ?? 0 });
}
