import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { exec } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/cron/sync-vehicle-reference
 * EasyCron-callable wrapper around scripts/sync-nhtsa.ts. Same auth pattern as
 * the rest of /api/cron/* (x-cron-secret header, no super_admin session
 * needed). The shell-out happens fire-and-forget so the cron call returns
 * immediately; the script writes nhtsa_sync_log on completion which the
 * /admin/decoder UI surfaces. Schedule target: 0 2 1 * * (monthly, 02:00).
 *
 * Wraps the same logic as POST /api/admin/nhtsa-sync but uses cron-secret
 * auth instead of super_admin session auth.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminSupabaseClient();

  const { data: logEntry } = await admin
    .from("nhtsa_sync_log")
    .insert({ status: "in_progress", notes: "Triggered via cron wrapper" })
    .select("id")
    .single<{ id: string }>();
  const logId = logEntry?.id ?? null;

  const scriptPath = path.join(process.cwd(), "scripts", "sync-nhtsa.ts");
  exec(
    `npx tsx "${scriptPath}"`,
    { env: { ...process.env }, cwd: process.cwd() },
    async (err, stdout, stderr) => {
      if (logId) {
        const status = err ? "failed" : "success";
        const notes = err
          ? `Error: ${err.message}\n${stderr?.slice(0, 500)}`
          : stdout?.slice(0, 1000);
        await admin
          .from("nhtsa_sync_log")
          .update({ status, notes })
          .eq("id", logId);
      }
    }
  );

  // Return current counts so the cron caller has something useful to log.
  const [
    { count: makes },
    { count: models },
    { count: trims },
  ] = await Promise.all([
    admin.from("nhtsa_makes").select("*", { count: "exact", head: true }),
    admin.from("nhtsa_models").select("*", { count: "exact", head: true }),
    admin.from("nhtsa_trims").select("*", { count: "exact", head: true }),
  ]);

  return NextResponse.json({
    success: true,
    message: "Sync started in background",
    log_id: logId,
    counts: { makes: makes ?? 0, models: models ?? 0, trims: trims ?? 0 },
  });
}
