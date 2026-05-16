import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

const STATUS_KEY = "cdk_bulk_update_status";

interface CdkBulkStatus {
  status: "running" | "completed" | "failed";
  started_at: string;
  completed_at?: string | null;
  delta_date: string;
  total_dealers: number;
  completed: number;
  failed: number;
  current_dealer?: string | null;
  total_vehicles_imported: number;
  total_vehicles_skipped: number;
  errors: Array<{ dealer_id: string; dealer_name: string; error: string }>;
}

/**
 * GET /api/admin/cdk/bulk-update/status
 * Returns the current bulk update job state, or { status: null } when idle.
 * super_admin only — same auth gate as the kickoff endpoint.
 */
export async function GET(): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient();
  const { data } = await admin
    .from("admin_settings")
    .select("value, updated_at")
    .eq("key", STATUS_KEY)
    .maybeSingle<{ value: string; updated_at: string }>();

  if (!data?.value) {
    return NextResponse.json({ status: null });
  }

  let parsed: CdkBulkStatus;
  try {
    parsed = JSON.parse(data.value) as CdkBulkStatus;
  } catch {
    return NextResponse.json({ status: null });
  }

  // Stalled-job detector: if status is still "running" but admin_settings
  // hasn't been touched in 5+ min, the worker is hung or dead. With a 30s
  // per-dealer timeout in place, 5 min of no progress is unambiguous.
  let stalled = false;
  if (parsed.status === "running" && data.updated_at) {
    const ageMs = Date.now() - new Date(data.updated_at).getTime();
    if (ageMs > 5 * 60 * 1000) stalled = true;
  }

  return NextResponse.json({ status: parsed, stalled });
}

/**
 * POST /api/admin/cdk/bulk-update/status
 * Body: { action: "dismiss" }
 *
 * Clears the stored job state. Used by the UI to dismiss a completed or
 * failed run, or to recover from a stalled "running" status after a worker
 * restart. Does not interrupt an in-flight job — the loop will write a
 * fresh status on its next iteration if still alive.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  let body: { action?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.action !== "dismiss") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  await admin.from("admin_settings").delete().eq("key", STATUS_KEY);
  return NextResponse.json({ ok: true });
}
