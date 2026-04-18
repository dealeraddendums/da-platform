import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { exec } from "child_process";
import path from "path";

/**
 * POST /api/admin/nhtsa-sync
 * Triggers the NHTSA vPIC sync script.
 * super_admin only.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  void req;
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") {
    return NextResponse.json({ error: "super_admin only" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();

  // Insert in_progress log entry
  const { data: logEntry } = await admin
    .from("nhtsa_sync_log")
    .insert({ status: "in_progress", notes: "Triggered via admin UI" })
    .select("id")
    .single();

  const logId = logEntry?.id ?? null;

  // Fire-and-forget: run sync script
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

  return NextResponse.json({
    message: "Sync started in background",
    log_id: logId,
  });
}

/**
 * GET /api/admin/nhtsa-sync
 * Returns sync log + table counts.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  void req;
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") {
    return NextResponse.json({ error: "super_admin only" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();
  const [
    { data: logs },
    { count: makesCount },
    { count: modelsCount },
    { count: wmiCount },
    { count: patternsCount },
    { count: overridesCount },
  ] = await Promise.all([
    admin.from("nhtsa_sync_log").select("*").order("synced_at", { ascending: false }).limit(10),
    admin.from("nhtsa_makes").select("*", { count: "exact", head: true }),
    admin.from("nhtsa_models").select("*", { count: "exact", head: true }),
    admin.from("nhtsa_wmi").select("*", { count: "exact", head: true }),
    admin.from("nhtsa_vin_patterns").select("*", { count: "exact", head: true }),
    admin.from("nhtsa_overrides").select("*", { count: "exact", head: true }),
  ]);

  return NextResponse.json({
    logs: logs ?? [],
    counts: {
      makes: makesCount ?? 0,
      models: modelsCount ?? 0,
      wmi: wmiCount ?? 0,
      vin_patterns: patternsCount ?? 0,
      overrides: overridesCount ?? 0,
    },
  });
}
