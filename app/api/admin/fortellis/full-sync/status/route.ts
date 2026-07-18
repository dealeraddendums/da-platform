import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

const STATUS_KEY = "fortellis_sync_status";

interface FleetStatus { status: "running" | "completed" | "failed"; started_at: string; }

/**
 * GET /api/admin/fortellis/full-sync/status
 * Returns the current fleet Fortellis-update state (or { status: null } when idle).
 * Flags a stalled job (running but no progress for 5+ min). super_admin only.
 */
export async function GET(): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient();
  const { data } = await admin.from("admin_settings").select("value, updated_at").eq("key", STATUS_KEY).maybeSingle<{ value: string; updated_at: string }>();
  if (!data?.value) return NextResponse.json({ status: null });

  let parsed: FleetStatus;
  try { parsed = JSON.parse(data.value) as FleetStatus; } catch { return NextResponse.json({ status: null }); }

  let stalled = false;
  if (parsed.status === "running" && data.updated_at) {
    if (Date.now() - new Date(data.updated_at).getTime() > 5 * 60 * 1000) stalled = true;
  }
  return NextResponse.json({ status: parsed, stalled });
}

/**
 * POST /api/admin/fortellis/full-sync/status  Body: { action: "dismiss" }
 * Clears the stored fleet job state (dismiss completed/failed, or recover a stalled run).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  let body: { action?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.action !== "dismiss") return NextResponse.json({ error: "Unknown action" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  await admin.from("admin_settings").delete().eq("key", STATUS_KEY);
  return NextResponse.json({ ok: true });
}
