import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { loadReadinessRows } from "@/lib/migration-readiness-data";
import { sendMigrationInvite } from "@/lib/migration-invite-otp";
import { sendMandrillEmail } from "@/lib/mandrill";

export const dynamic = "force-dynamic";

const DEFAULT_CAP = 100; // weekly wave cap (spec: ~100/week)

/**
 * POST /api/migration/send-wave — Phase 13b step 2. super_admin only.
 * Body: { dealerIds: <dealers.id UUID>[], cap?: number }.
 *
 * Fires the 13a scanner-proof OTP migration invite to each selected dealer. Hard
 * guards: refuses if the wave exceeds the cap, and RE-VALIDATES readiness
 * server-side (billing-staged + template-confirmed + eligible) — any not-ready
 * dealer is BLOCKED, not invited. Inviting changes NOTHING on the dealer's
 * billing (da-billing activation happens on the dealer's own /migrate confirm).
 * Logs the wave + alerts the team.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  let body: { dealerIds?: string[]; cap?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const dealerIds = Array.isArray(body.dealerIds) ? Array.from(new Set(body.dealerIds.filter((x) => typeof x === "string"))) : [];
  const cap = typeof body.cap === "number" && body.cap > 0 ? Math.floor(body.cap) : DEFAULT_CAP;
  if (dealerIds.length === 0) return NextResponse.json({ error: "Select at least one dealer." }, { status: 400 });
  if (dealerIds.length > cap) {
    return NextResponse.json({ error: `Wave of ${dealerIds.length} exceeds the cap of ${cap}. Select ${cap} or fewer.` }, { status: 400 });
  }

  // Re-validate readiness server-side for exactly the submitted set.
  const { rows } = await loadReadinessRows({ dealerIds });
  const byId = new Map(rows.map((r) => [r.id, r]));

  const ready: string[] = [];
  const blocked: { id: string; name: string; reason: string }[] = [];
  for (const id of dealerIds) {
    const r = byId.get(id);
    if (!r) { blocked.push({ id, name: id, reason: "not found / not an un-migrated dealer" }); continue; }
    if (!r.ready) {
      const reason = !r.eligible ? r.eligibleReason : !r.billingStaged ? `billing not staged (${r.billingReason})` : !r.templateConfirmed ? "template not confirmed" : "not ready";
      blocked.push({ id, name: r.name, reason });
      continue;
    }
    ready.push(id);
  }

  // Resolve inventory_dealer_id (what sendMigrationInvite keys on) for the ready set.
  const admin = createAdminSupabaseClient();
  const invByDealerId = new Map<string, string>();
  if (ready.length) {
    const { data } = await admin.from("dealers").select("id, inventory_dealer_id").in("id", ready);
    (data ?? []).forEach((d: { id: string; inventory_dealer_id: string | null }) => { if (d.inventory_dealer_id) invByDealerId.set(d.id, d.inventory_dealer_id); });
  }

  const sent: { id: string; name: string; email: string | null }[] = [];
  const failed: { id: string; name: string; error: string }[] = [];
  for (const id of ready) {
    const r = byId.get(id)!;
    const invId = invByDealerId.get(id);
    if (!invId) { failed.push({ id, name: r.name, error: "no inventory_dealer_id" }); continue; }
    try {
      const res = await sendMigrationInvite(invId, claims.sub);
      if (res.emailSent) sent.push({ id, name: r.name, email: res.email });
      else failed.push({ id, name: r.name, error: res.warning ?? "email not sent" });
    } catch (e) {
      failed.push({ id, name: r.name, error: e instanceof Error ? e.message : String(e) });
    }
    await new Promise((r2) => setTimeout(r2, 120)); // gentle throttle
  }

  const summary = { requested: dealerIds.length, sent: sent.length, failed: failed.length, blocked: blocked.length };
  console.log(`[send-wave] by=${claims.sub} ${JSON.stringify(summary)}`);
  void sendMandrillEmail({
    subject: `Migration wave sent — ${sent.length} invite(s)`,
    from_email: "noreply@dealeraddendums.com", from_name: "DealerAddendums",
    to: [{ email: "support@dealeraddendums.com", name: "DA Support" }],
    html: `<p>A migration wave was sent.</p><p>Requested: ${summary.requested} · <strong>Sent: ${summary.sent}</strong> · Failed: ${summary.failed} · Blocked (not ready): ${summary.blocked}</p>${sent.length ? `<p>Invited:<br>${sent.map((s) => `${s.name} — ${s.email}`).join("<br>")}</p>` : ""}${failed.length ? `<p>Failed:<br>${failed.map((f) => `${f.name} — ${f.error}`).join("<br>")}</p>` : ""}`,
  }).catch(() => {});

  return NextResponse.json({ ok: true, summary, sent, failed, blocked });
}
