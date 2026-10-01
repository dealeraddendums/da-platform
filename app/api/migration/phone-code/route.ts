import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { generateSetupCode, hashSetupCode } from "@/lib/invite-code";

export const dynamic = "force-dynamic";

/**
 * Migration Console "Phone code" (2026-10-01) — for a dealer whose invite email
 * never arrived (bounce / spam filtering), support reads them a code over the
 * phone and they type email + code at /migrate.
 *
 * Codes are stored ONLY as a SHA-256 hash (lib/invite-code.ts, scanner-proof
 * design), so the code that was emailed cannot be revealed. Instead the
 * operator generates a fresh code for ONE recipient's existing migration
 * invitation: it replaces that recipient's emailed code and is shown once, here.
 * It is never emailed (email is what's failing — Resend covers emailing).
 *
 *   GET  ?dealerId=<dealers.id>                   → the dealer's migration recipients (no codes)
 *   POST { dealerId, invitationId }               → rotate that one invitation's code, return it
 *
 * super_admin only, enforced here. Every generate writes an admin_audit row
 * (awaited, BEFORE the rotation — no audit, no code). The code value is never
 * logged and never stored in clear.
 */

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // same 14-day window as a sent invite

type InvRow = {
  id: string; email: string; first_name: string | null; last_name: string | null;
  dealer_id: string | null; purpose: string | null; expires_at: string; accepted_at: string | null;
  setup_code_hash: string | null; setup_code_expires_at: string | null;
};
const COLS = "id, email, first_name, last_name, dealer_id, purpose, expires_at, accepted_at, setup_code_hash, setup_code_expires_at";

const isMigration = (r: InvRow) => r.purpose === "migration" || (r.purpose == null && !!r.dealer_id);
const noStore = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  const dealerId = req.nextUrl.searchParams.get("dealerId");
  if (!dealerId) return NextResponse.json({ error: "dealerId required" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data: dealer } = await admin.from("dealers").select("id, name, migration_status").eq("id", dealerId)
    .maybeSingle<{ id: string; name: string; migration_status: string | null }>();
  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: qErr } = await (admin as any).from("invitations").select(COLS).eq("dealer_id", dealerId) as { data: InvRow[] | null; error: { message: string } | null };
  if (qErr) return NextResponse.json({ error: qErr.message }, { status: 500 });
  const now = Date.now();
  const recipients = (data ?? []).filter(isMigration).map(r => ({
    invitationId: r.id,
    email: r.email,
    name: [r.first_name, r.last_name].filter(Boolean).join(" ") || null,
    accepted: !!r.accepted_at,
    acceptedAt: r.accepted_at,
    expired: new Date(r.expires_at).getTime() < now,
    codeLive: !!r.setup_code_hash && !!r.setup_code_expires_at && new Date(r.setup_code_expires_at).getTime() >= now,
    codeExpiresAt: r.setup_code_expires_at,
  })).sort((a, b) => Number(a.accepted) - Number(b.accepted) || a.email.localeCompare(b.email));

  return NextResponse.json({ dealer: { id: dealer.id, name: dealer.name, migrationStatus: dealer.migration_status }, recipients }, { headers: noStore });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;
  let body: { dealerId?: string; invitationId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body.dealerId || !body.invitationId) return NextResponse.json({ error: "dealerId and invitationId required" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data: dealer } = await admin.from("dealers").select("id, dealer_id, name").eq("id", body.dealerId).maybeSingle();
  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inv = (admin as any).from("invitations");
  const { data: row } = await inv.select(COLS).eq("id", body.invitationId).maybeSingle() as { data: InvRow | null };
  // The invitation must belong to THIS dealer and be a migration invite — the
  // rotation touches exactly one row, never another dealer's or a staff invite.
  if (!row || row.dealer_id !== dealer.id || !isMigration(row)) {
    return NextResponse.json({ error: "No migration invitation for that recipient on this dealer. Send the invite first." }, { status: 404 });
  }
  if (row.accepted_at) {
    return NextResponse.json({ error: `${row.email} already accepted this invite — they sign in normally now.` }, { status: 409 });
  }

  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  const { error: auditErr } = await admin.from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: "migration_code_regenerated",
    target_dealer_id: dealer.dealer_id,
    metadata: {
      dealer_uuid: dealer.id,
      dealer_name: dealer.name,
      invitation_id: row.id,
      recipient_email: row.email,
      previous_code_live: !!row.setup_code_hash && !!row.setup_code_expires_at && new Date(row.setup_code_expires_at) >= new Date(),
      was_expired: new Date(row.expires_at) < new Date(),
      new_expires_at: expiresAt,
      channel: "phone",
    },
  });
  if (auditErr) {
    console.error("[migration/phone-code] audit write failed — code NOT generated:", auditErr.message);
    return NextResponse.json({ error: "Could not record the audit entry, so no code was generated. Try again." }, { status: 500 });
  }

  const code = generateSetupCode();
  const { data: updated, error: upErr } = await inv
    .update({ setup_code_hash: hashSetupCode(code), setup_code_expires_at: expiresAt, expires_at: expiresAt })
    .eq("id", row.id)
    .is("accepted_at", null)
    .select("id")
    .maybeSingle();
  if (upErr || !updated) {
    console.error("[migration/phone-code] rotation failed for invitation", row.id, upErr?.message ?? "row accepted meanwhile");
    return NextResponse.json({ error: "Could not set the new code (the invite may have just been accepted). Refresh and try again." }, { status: 409 });
  }

  return NextResponse.json({ code, email: row.email, expiresAt, dealerName: dealer.name }, { headers: noStore });
}
