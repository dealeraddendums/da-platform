import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import { loadReadinessRows } from "@/lib/migration-readiness-data";
import { lastSignInByEmail } from "@/lib/last-sign-in";
import { migrateDealerRecord, futureNextInvoice } from "@/lib/migrate-dealer";
import { billingConfigured, getTemplate, activateTemplate, setBillingState } from "@/lib/billing";
import { fireGroupSync } from "@/lib/sync-hubspot";
import { sendMandrillEmail } from "@/lib/mandrill";

export const dynamic = "force-dynamic";

// Group-level migration (2026-07-17). One operator Confirm migrates every
// member dealer + optionally takes the GROUP's da-billing customer Live.
//
// Gates (server-side authority; the console dialog mirrors them):
//   A. ≥1 group_admin profile for the group has an ACTIVE 5.0 login (signed in
//      at least once — GoTrue last_sign_in via lib/last-sign-in).
//   B. Every ACTIVE member dealer is either already migrated or SYNCED +
//      billing-staged + template-confirmed. Self-serve ELIGIBILITY is NOT
//      required — group-managed dealers (service-provider model, no dealer
//      contact) migrate through exactly this path. Inactive / is_test members
//      are skipped, never migrated, never blockers.
//
// Executes per dealer: the canonical migrateDealerRecord writes (shared with
// /api/migrate/confirm) + a migration_log row. Group-level: optional da-billing
// go-Live (setBillingState 'active' + template activation with a FUTURE
// nextInvoiceDate — no invoices are sent beyond what Live implies), a
// group-level migration_log entry, HubSpot group sync, and ONE FreshBooks
// recurring-stop operator alert (manual task; surfaces via the existing
// FB-stop-pending counter, which derives from migrated && !freshbooks_stopped).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const alert = (subject: string, html: string) =>
  sendMandrillEmail({ subject, from_email: "noreply@dealeraddendums.com", from_name: "DealerAddendums", to: [{ email: "support@dealeraddendums.com", name: "DA Support" }], html })
    .catch((e) => console.error("[migrate-group] alert email failed:", e instanceof Error ? e.message : e));

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  let body: { group_id?: string; activate_billing?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const groupId = (body.group_id || "").trim();
  const activateBilling = body.activate_billing !== false;
  if (!UUID_RE.test(groupId)) return NextResponse.json({ error: "group_id (uuid) required" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data: group } = await admin
    .from("groups")
    .select("id, name, billing_customer_id")
    .eq("id", groupId)
    .maybeSingle<{ id: string; name: string; billing_customer_id: string | null }>();
  if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });

  // ── Gate A: an active group admin login ────────────────────────────────────
  const { data: adminProfiles } = await admin
    .from("profiles")
    .select("email, active")
    .eq("group_id", groupId)
    .eq("role", "group_admin");
  const signIns = await lastSignInByEmail();
  const activeAdmin = ((adminProfiles ?? []) as { email: string | null; active: boolean | null }[])
    .some((p) => p.email && p.active !== false && signIns.get(p.email.toLowerCase()));
  if (!activeAdmin) {
    return NextResponse.json({
      error: "No group admin has signed in to 5.0 yet. Invite an admin (Invite admins…) and wait for their first sign-in before migrating the group.",
    }, { status: 409 });
  }

  // ── Gate B: member readiness (self-serve eligibility NOT required) ──────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: members } = await (admin as any)
    .from("dealers")
    .select("id, dealer_id, name, active, is_test, migration_status, inventory_provider, inventory_provider_is_dms, box_folder_id, inventory_dealer_id")
    .eq("group_id", groupId);
  const allMembers = (members ?? []) as Array<{ id: string; dealer_id: string; name: string; active: boolean | null; is_test: boolean | null; migration_status: string | null; inventory_provider: string | null; inventory_provider_is_dms: boolean | null; box_folder_id: string | null; inventory_dealer_id: string | null }>;
  if (allMembers.length === 0) return NextResponse.json({ error: "Group has no member dealers." }, { status: 400 });

  const skipped: Array<{ name: string; reason: string }> = [];
  const candidates = allMembers.filter((m) => {
    if (m.is_test) { skipped.push({ name: m.name, reason: "test account" }); return false; }
    if (m.active === false) { skipped.push({ name: m.name, reason: "deactivated" }); return false; }
    if (m.migration_status === "migrated") { skipped.push({ name: m.name, reason: "already migrated" }); return false; }
    return true;
  });
  if (candidates.length === 0) {
    return NextResponse.json({ error: "Nothing to migrate — every member dealer is already migrated, deactivated, or a test account." }, { status: 409 });
  }

  const { rows } = await loadReadinessRows({ dealerIds: candidates.map((c) => c.id) });
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const blockers: Array<{ name: string; missing: string[] }> = [];
  for (const c of candidates) {
    const r = rowById.get(c.id);
    const missing: string[] = [];
    if (!r) { blockers.push({ name: c.name, missing: ["not in readiness data"] }); continue; }
    if (!r.synced) missing.push("not synced");
    if (!r.billingStaged) missing.push(`billing (${r.billingReason})`);
    if (!r.templateConfirmed) missing.push("template not confirmed");
    if (missing.length) blockers.push({ name: c.name, missing });
  }
  if (blockers.length) {
    return NextResponse.json({
      error: "Not every member dealer is ready.",
      blockers,
    }, { status: 409 });
  }

  // ── Execute: migrate each candidate (canonical shared writes) ───────────────
  const nowIso = new Date().toISOString();
  const migrated: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  for (const c of candidates) {
    const res = await migrateDealerRecord(admin, c, {
      nowIso,
      hubspotContext: `group migration (${group.name}) — upgrade to Paid`,
    });
    if (!res.ok) { failed.push({ name: c.name, error: res.error ?? "update failed" }); continue; }
    migrated.push(c.name);
    fireWrite(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (admin as any).from("migration_log").insert({
        dealer_id: c.id,
        event: "migrated",
        performed_by: claims.sub,
        billing_customer_id: group.billing_customer_id,
        notes: `group migration — ${group.name} (plan ${res.plan})`,
      }),
      "migration_log migrated (group)",
    );
  }

  // Group-level log entry. migration_log.dealer_id is NOT NULL, so the group
  // entry is anchored to the first migrated dealer with the group context in
  // the notes/event.
  const anchor = candidates.find((c) => migrated.includes(c.name));
  if (anchor) {
    fireWrite(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (admin as any).from("migration_log").insert({
        dealer_id: anchor.id,
        event: "group_migrated",
        performed_by: claims.sub,
        billing_customer_id: group.billing_customer_id,
        notes: `GROUP ${group.name} (${groupId}) migrated: ${migrated.length} dealers (${skipped.length} skipped)${failed.length ? `, ${failed.length} FAILED` : ""}`,
      }),
      "migration_log group_migrated",
    );
  }

  // ── Group billing go-Live (operator-confirmed via the dialog checkbox) ──────
  let billing = "skipped (checkbox off)";
  if (activateBilling) {
    if (!billingConfigured()) billing = "skipped (billing not configured)";
    else if (!group.billing_customer_id) billing = "skipped (group has no billing customer)";
    else {
      try {
        await setBillingState(group.billing_customer_id, "active");
        const tmpl = await getTemplate(group.billing_customer_id);
        const next = futureNextInvoice(tmpl?.nextInvoiceDate, Date.now());
        await activateTemplate(group.billing_customer_id, next);
        billing = `LIVE — template active, nextInvoiceDate=${next}`;
      } catch (e) {
        billing = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
        console.error("[migrate-group] billing activation failed:", billing);
      }
    }
  }

  fireGroupSync(groupId);

  // FreshBooks recurring-stop — ALWAYS a manual operator task (OAuth token
  // rotates on use; never automated). One alert for the whole group.
  void alert(
    `⚠️ Queue FreshBooks recurring-stop — GROUP ${group.name}`,
    `<p><strong>${group.name}</strong> just migrated as a group (${migrated.length} dealers).</p>
     <p><strong>Operator action:</strong> stop the FreshBooks recurring profile(s) covering these dealers (manually — do not dry-run-then-live). Existing FreshBooks invoices stay due.</p>
     <ul>${migrated.map((n) => `<li>${n}</li>`).join("")}</ul>
     <p>da-billing: ${billing}</p>`,
  );

  console.log(`[migrate-group] GROUP MIGRATED ${group.name} (${groupId}) — ${migrated.length} migrated, ${skipped.length} skipped, ${failed.length} failed; billing: ${billing}; by ${claims.sub}`);

  return NextResponse.json({
    ok: failed.length === 0,
    group: group.name,
    migrated,
    skipped,
    failed,
    billing,
    freshbooks: "recurring-stop queued for operator (see FB stop pending)",
  });
}
