import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import type { UserRole } from "@/lib/db";
import { verifySetupCode } from "@/lib/invite-code";
import { rateLimit } from "@/lib/rate-limit";
import { getAuthUserIdByEmail } from "@/lib/last-sign-in";
import { fireProfileSync, fireDealerReliable } from "@/lib/sync-hubspot";
import { fireConversionWebhook } from "@/lib/marketing-webhook";
import { billingConfigured, getTemplate, activateTemplate } from "@/lib/billing";
import { fireAndForget } from "@/lib/billing-sync";
import { boxConfigured, createDealerFolder } from "@/lib/box";
import { sendMandrillEmail } from "@/lib/mandrill";

export const dynamic = "force-dynamic";

// Phase 13a.3 — BILLING-SENSITIVE system actions on the dealer's /migrate Confirm.
//
// On a single verified human Confirm:
//   1. Create the dealer's 5.0 login (password) + profile.            [account]
//   2. Apply contact corrections.                                     [non-billing]
//   3. migration_status='migrated' (ETL stops; 5.0 = source of truth).
//   4. account_type → correct Paid tier (+ converted_at).
//   5. da-billing: ACTIVATE the template with a FUTURE nextInvoiceDate
//      (no double-bill) — GATED by MIGRATION_AUTO_ACTIVATE (default OFF =
//      review-queue: migrate the dealer but leave billing for operator review).
//   6. HubSpot lifecycle + conversion webhook + contact sync.
//   7. FreshBooks recurring-stop: ALWAYS operator-queued (alert), never auto-run.
//   8. Consume the invite; audit-log + alert the team.
// Rollback (operator): migration_status back + template.active=false — see
// /api/migration/rollback.

const AUTO_ACTIVATE = process.env.MIGRATION_AUTO_ACTIVATE === "1" || process.env.MIGRATION_AUTO_ACTIVATE === "true";

type Inv = { id: string; email: string; first_name: string | null; last_name: string | null; dealer_id: string | null; expires_at: string; accepted_at: string | null; setup_code_hash: string | null; setup_code_expires_at: string | null; purpose?: string | null };

function paidTierFor(dms: boolean | null, provider: string | null): string {
  if (dms) return "Automatic DMS";
  if (provider && provider.trim()) return "Automatic Web";
  return "Manual";
}

// A safe FUTURE next-invoice date: keep the existing one if it's already in the
// future, else push ~one cycle out (30 days) so the cron doesn't fire an
// immediate catch-up invoice on the migration day.
function futureNextInvoice(existing: string | undefined, now: number): string {
  if (existing) { const t = Date.parse(existing); if (Number.isFinite(t) && t > now) return existing; }
  return new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();
}

const alert = (subject: string, html: string) =>
  sendMandrillEmail({ subject, from_email: "noreply@dealeraddendums.com", from_name: "DealerAddendums", to: [{ email: "support@dealeraddendums.com", name: "DA Support" }], html })
    .catch((e) => console.error("[migrate/confirm] alert email failed:", e instanceof Error ? e.message : e));

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!rateLimit(`migrate-confirm:${ip}`, 8, 60_000)) {
    return NextResponse.json({ error: "Too many attempts — please wait a moment." }, { status: 429 });
  }

  let body: { token?: string; code?: string; password?: string; corrections?: { phone?: string; primary_contact?: string; primary_contact_email?: string } };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const token = body.token?.trim();
  const code = body.code?.trim();
  const password = body.password;
  if (!token || !code) return NextResponse.json({ error: "token and code required" }, { status: 400 });
  if (!password || password.length < 8) return NextResponse.json({ error: "A password of at least 8 characters is required." }, { status: 400 });

  const admin = createAdminSupabaseClient();

  // ── Load + verify the migration invite (the scanner-proof gate; consume last) ─
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = admin as any;
  let invRes = await a.from("invitations").select("id, email, first_name, last_name, dealer_id, expires_at, accepted_at, setup_code_hash, setup_code_expires_at, purpose").eq("token", token).maybeSingle();
  if (invRes.error && /purpose/i.test(invRes.error.message ?? "")) {
    invRes = await a.from("invitations").select("id, email, first_name, last_name, dealer_id, expires_at, accepted_at, setup_code_hash, setup_code_expires_at").eq("token", token).maybeSingle();
  }
  const inv = invRes.data as Inv | null;
  const isMigration = inv && (inv.purpose === "migration" || (inv.purpose == null && !!inv.dealer_id));
  if (!inv || !isMigration) return NextResponse.json({ error: "Invalid migration link." }, { status: 404 });
  if (inv.accepted_at) return NextResponse.json({ error: "This migration has already been completed." }, { status: 410 });
  if (new Date(inv.expires_at) < new Date()) return NextResponse.json({ error: "This migration link has expired." }, { status: 410 });
  const codeExpired = inv.setup_code_expires_at ? new Date(inv.setup_code_expires_at) < new Date() : true;
  if (!inv.setup_code_hash || codeExpired) return NextResponse.json({ error: "Your code has expired. Ask us to resend it." }, { status: 410 });
  if (!verifySetupCode(code, inv.setup_code_hash)) return NextResponse.json({ error: "That code is incorrect." }, { status: 401 });

  const { data: dealer } = await admin
    .from("dealers")
    .select("id, dealer_id, name, group_id, subscription_billed_to, billing_customer_id, account_type, inventory_provider, inventory_provider_is_dms, box_folder_id")
    .eq("id", inv.dealer_id!)
    .maybeSingle<{ id: string; dealer_id: string; name: string; group_id: string | null; subscription_billed_to: string | null; billing_customer_id: string | null; account_type: string | null; inventory_provider: string | null; inventory_provider_is_dms: boolean | null; box_folder_id: string | null }>();
  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  const nowIso = new Date().toISOString();
  const fullName = `${inv.first_name ?? ""} ${inv.last_name ?? ""}`.trim() || inv.email;

  // ── 1. Create / resolve the 5.0 login (password) + profile (idempotent) ─────
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: inv.email, password, email_confirm: true,
    user_metadata: { full_name: fullName }, app_metadata: { role: "dealer_admin" },
  });
  let userId = created?.user?.id ?? null;
  if (!userId) {
    userId = await getAuthUserIdByEmail(inv.email);
    if (userId) await admin.auth.admin.updateUserById(userId, { password, app_metadata: { role: "dealer_admin" } }).catch(() => null);
  }
  if (!userId) {
    return NextResponse.json({ error: createErr?.message ?? "Could not create your login." }, { status: 400 });
  }
  const { error: profErr } = await admin.from("profiles").upsert({
    id: userId, email: inv.email, full_name: fullName, role: "dealer_admin" as UserRole, dealer_id: dealer.dealer_id, active: true,
  }, { onConflict: "id" });
  if (profErr) {
    console.error("[migrate/confirm] profile upsert failed:", profErr.message);
    return NextResponse.json({ error: "Failed to set up your account." }, { status: 500 });
  }
  fireProfileSync(userId);

  // ── 2-4. Corrections + migrated + Paid tier (single dealers update) ─────────
  const paidType = paidTierFor(dealer.inventory_provider_is_dms, dealer.inventory_provider);
  const corr = body.corrections ?? {};
  const dealerPatch: Record<string, unknown> = {
    migration_status: "migrated",
    account_type: paidType,
    converted_at: nowIso,
    downgraded_at: null,
  };
  if (typeof corr.phone === "string" && corr.phone.trim()) dealerPatch.phone = corr.phone.trim();
  if (typeof corr.primary_contact === "string" && corr.primary_contact.trim()) dealerPatch.primary_contact = corr.primary_contact.trim();
  if (typeof corr.primary_contact_email === "string" && corr.primary_contact_email.trim()) dealerPatch.primary_contact_email = corr.primary_contact_email.trim().toLowerCase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: dealerErr } = await (admin as any).from("dealers").update(dealerPatch).eq("id", dealer.id);
  if (dealerErr) {
    return NextResponse.json({ error: `Migration save failed: ${dealerErr.message}` }, { status: 500 });
  }

  // Provision a Box.com folder for the newly-migrated dealer (fire-and-forget,
  // same pattern as POST /api/dealers). ETL-created legacy dealers never got a
  // folder at row-creation time, so this is their first chance. Non-fatal — a
  // Box hiccup must never block a migration; failures land in
  // billing_sync_errors for retry.
  if (boxConfigured() && !dealer.box_folder_id) {
    fireAndForget(async () => {
      const folderId = await createDealerFolder(dealer.name);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: boxErr } = await (admin as any)
        .from("dealers")
        .update({ box_folder_id: folderId })
        .eq("id", dealer.id)
        .is("box_folder_id", null);
      if (boxErr) throw new Error(`dealers update failed: ${boxErr.message} (folder ${folderId})`);
    }, {
      event: "box.folder.create",
      dealerId: dealer.id,
      payload: { dealerName: dealer.name, entity: "dealer", source: "migrate-confirm" },
    });
  }

  // ── 5. Billing: activate the template (future nextInvoiceDate) — GATED ──────
  let billingState: "activated" | "review-queued" | "no-customer" | "error" = "no-customer";
  let billingDetail = "";
  const groupBilled = dealer.subscription_billed_to === "group";
  let customerId = dealer.billing_customer_id;
  if (groupBilled && dealer.group_id) {
    const { data: g } = await admin.from("groups").select("billing_customer_id").eq("id", dealer.group_id).maybeSingle<{ billing_customer_id: string | null }>();
    customerId = g?.billing_customer_id ?? null;
  }
  if (billingConfigured() && customerId) {
    if (AUTO_ACTIVATE) {
      try {
        const tmpl = await getTemplate(customerId);
        const next = futureNextInvoice(tmpl?.nextInvoiceDate, Date.now());
        await activateTemplate(customerId, next);
        billingState = "activated"; billingDetail = `active=true, nextInvoiceDate=${next}`;
      } catch (e) {
        billingState = "error"; billingDetail = e instanceof Error ? e.message : String(e);
        console.error("[migrate/confirm] template activation failed:", billingDetail);
      }
    } else {
      billingState = "review-queued";
      billingDetail = `customer ${customerId} — activation pending operator review (MIGRATION_AUTO_ACTIVATE off)`;
    }
  } else {
    billingDetail = groupBilled ? "group has no billing customer" : "dealer has no billing customer";
  }

  // ── 6. HubSpot lifecycle (now Paid) + marketing conversion + contact sync ───
  fireDealerReliable(dealer.id, "migration confirm — upgrade to Paid (Customer)");
  fireConversionWebhook({ dealerId: dealer.dealer_id, convertedAt: nowIso, plan: paidType });

  // ── 7. FreshBooks recurring-stop — ALWAYS operator-queued, never auto-run ───
  // (OAuth refresh token rotates on every use; a careful manual stop avoids the
  // dry-run-then-live token burn. Existing FreshBooks invoices stay DUE.)
  void alert(
    `⚠️ Queue FreshBooks recurring-stop — ${dealer.name}`,
    `<p><strong>${dealer.name}</strong> (${dealer.dealer_id}) just self-migrated. <strong>Operator action:</strong> stop their FreshBooks recurring profile (manually — do not dry-run-then-live). Leave existing FreshBooks invoices due.</p>`,
  );

  // ── 8. Consume the invite + log + summary alert ─────────────────────────────
  await a.from("invitations").update({ accepted_at: nowIso, setup_code_hash: null }).eq("id", inv.id);
  // Durable log = the team alert below (emailed) + this structured line in the
  // app logs. (No admin_audit table exists in this project; a queryable
  // migration_log is a 13b.3 status-tracking follow-up.)
  console.log(`[migrate/confirm] MIGRATED dealer=${dealer.dealer_id} (${dealer.name}) uuid=${dealer.id} plan=${paidType} billing=${billingState} (${billingDetail}) group_billed=${groupBilled} user=${userId}`);
  void alert(
    `✅ Self-migration complete — ${dealer.name}`,
    `<p><strong>${dealer.name}</strong> (${dealer.dealer_id}) migrated to 5.0.<br>Plan: ${paidType}<br>Billing: <strong>${billingState}</strong> — ${billingDetail}<br>FreshBooks recurring-stop: <strong>queued for operator</strong>.</p>`,
  );

  return NextResponse.json({
    ok: true,
    email: inv.email,
    plan: paidType,
    billing: billingState,
    message: billingState === "activated"
      ? "Your account is migrated and active on the new platform."
      : "Your account is migrated to the new platform. Our team is finalizing your billing — nothing is charged today.",
  });
}
