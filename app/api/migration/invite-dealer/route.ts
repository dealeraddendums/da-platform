import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { sendMigrationInvite } from "@/lib/migration-invite-otp";

/**
 * POST /api/migration/invite-dealer
 * Auth: super_admin JWT -OR- X-Migration-Token header matching MIGRATION_INVITE_TOKEN env var.
 * The token-based auth is used by the ETL dashboard (/da-legacy-etl) which has no user session.
 *
 * Body: { inventory_dealer_id: string }
 * Returns: MigrationInviteResult JSON.
 *
 * Phase 13a.1: SUPERSEDES the old magic-link path (lib/migration-invite.ts) —
 * sends a scanner-proof OTP code + inert /migrate link instead (Barracuda was
 * pre-consuming the magic link → otp_expired). Sets migration_status='invited'.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // Allow either super_admin JWT or shared migration token (for ETL dashboard)
  const migrationToken = process.env.MIGRATION_INVITE_TOKEN;
  const headerToken = req.headers.get("x-migration-token");
  const tokenAuth = migrationToken && headerToken === migrationToken;

  let adminUserId: string | undefined;
  if (!tokenAuth) {
    const { claims, error } = await requireSuperAdmin();
    if (error) return error;
    adminUserId = claims.sub;
  }

  let body: { inventory_dealer_id?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { inventory_dealer_id } = body;
  if (!inventory_dealer_id?.trim()) {
    return NextResponse.json({ error: "inventory_dealer_id required" }, { status: 400 });
  }

  try {
    const result = await sendMigrationInvite(inventory_dealer_id.trim(), adminUserId);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 404 });
  }
}
