import { NextRequest, NextResponse } from "next/server";
import { runDescriptionCheck, scanDescriptions } from "@/lib/description-check";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 300;

/**
 * POST /api/cron/description-check (X-Cron-Secret) — nightly product-description
 * junk check (lib/description-check.ts). Fire-and-forget: 200 at once, the scan
 * runs in the background and emails support@ + allan@ only for newly flagged rows.
 * Also kicked daily from /api/cron/harvest-vin-trims.
 *
 * ?report=1 — synchronous, READ-ONLY: every flagged row as JSON, no email, no state write.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (req.nextUrl.searchParams.get("report") === "1") {
    const rows = await scanDescriptions();
    return NextResponse.json({ generatedAt: new Date().toISOString(), total: rows.length, rows });
  }
  runDescriptionCheck().then(
    (r) => console.log("[description-check]:", JSON.stringify(r)),
    (e) => console.error("[description-check] failed:", e instanceof Error ? e.message : e),
  );
  return NextResponse.json({ status: "started" });
}
