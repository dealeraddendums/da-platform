import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Public — returns the single currently-active platform banner, or null.
 * Consumed by the in-app <PlatformBanner> client wrapper (rendered for ALL
 * authenticated users), so it intentionally requires no auth and exposes only
 * safe fields (id, message, banner_type) for banners inside their active window.
 * Cached 60s at the browser/edge; a ~1 min lag on banner changes is acceptable.
 */
export async function GET(): Promise<NextResponse> {
  try {
    // platform_banners is newer than the generated Database types — cast like the
    // rest of the codebase does for post-typegen tables (e.g. user_tags in auth.ts).
    const admin = createAdminSupabaseClient() as any;
    const nowIso = new Date().toISOString();
    const { data, error } = await admin
      .from("platform_banners")
      .select("id, message, banner_type")
      .lte("starts_at", nowIso)
      .or(`ends_at.is.null,ends_at.gte.${nowIso}`)
      .order("starts_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return NextResponse.json(data ?? null, {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  } catch {
    // Table missing or a transient DB error must never break the app layout.
    return NextResponse.json(null, {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  }
}
