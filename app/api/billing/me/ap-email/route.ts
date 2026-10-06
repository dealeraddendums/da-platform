// GET/PUT/DELETE /api/billing/me/ap-email — the dealer's Accounts Payable
// email, managed from My Profile → Billing.
//
// Stored on the dealer's OWN da-billing customer as an additional invoice
// recipient (customer_email record, label "Accounts Payable", receiveInvoices
// on). da-billing resolves every invoice send — new invoice, resend, the daily
// cron, generate-invoice — and the past-due suspension email through one
// choke point (resolveInvoiceRecipients) that includes those records, so
// nothing on the da-billing side changes. The Main Contact (customer.email),
// amounts and plans are never touched here.
//
// Self-billed dealers only. A group-billed dealer's invoices come from the
// group's customer, so there's nothing of theirs to CC — the UI shows a
// "billed by your group" note instead (GET reports billedBy:"group").
//
// Access: dealer_admin → own dealer; super_admin → ghosted dealer or
// ?dealer_id=; group_admin → a member dealer they're switched into (or
// ?dealer_id=), group-verified — the same parity the other Billing-tab writes
// use. dealer_user may view, not change.

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import type { JwtClaims } from "@/lib/auth";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import {
  BillingError, addCustomerEmail, billingConfigured, deleteCustomerEmail, getCustomer, listCustomerEmails,
  type BillingCustomerEmail,
} from "@/lib/billing";

const AP_LABEL = "Accounts Payable";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface DealerRow {
  id: string; dealer_id: string; name: string; group_id: string | null;
  billing_customer_id: string | null; internal_id: string | null; subscription_billed_to: "dealer" | "group" | null;
}

type Resolved =
  | { ok: true; dealer: DealerRow; canEdit: boolean }
  | { ok: false; response: NextResponse };

async function resolveDealer(req: NextRequest, claims: JwtClaims): Promise<Resolved> {
  const param = req.nextUrl.searchParams.get("dealer_id");
  let dealerTextId: string | null = null;
  if (claims.role === "dealer_admin" || claims.role === "dealer_user") {
    dealerTextId = claims.dealer_id ?? null; // pinned to own dealer; any param ignored
  } else if (claims.role === "super_admin" || claims.role === "group_admin") {
    dealerTextId = param ?? claims.dealer_id ?? null;
  } else {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  if (!dealerTextId) return { ok: false, response: NextResponse.json({ error: "No dealer assigned" }, { status: 403 }) };

  const admin = createAdminSupabaseClient();
  const { data: dealer } = await admin
    .from("dealers")
    .select("id, dealer_id, name, group_id, billing_customer_id, internal_id, subscription_billed_to")
    .eq("dealer_id", dealerTextId)
    .maybeSingle<DealerRow>();
  if (!dealer) return { ok: false, response: NextResponse.json({ error: "Dealer not found" }, { status: 404 }) };
  if (claims.role === "group_admin" && dealer.group_id !== claims.group_id) {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { ok: true, dealer, canEdit: claims.role !== "dealer_user" };
}

/** The dealer's own da-billing customer id — the same key the Billing tab
 *  reads (billing_customer_id, falling back to internal_id). */
async function ownCustomer(dealer: DealerRow) {
  const key = dealer.billing_customer_id ?? dealer.internal_id;
  if (!key) return null;
  const customer = await getCustomer(key);
  return customer ? { id: key, customer } : null;
}

const findAp = (emails: BillingCustomerEmail[]) =>
  emails.find((e) => (e.label ?? "").trim().toLowerCase() === AP_LABEL.toLowerCase()) ?? null;

function billingErrorResponse(err: unknown): NextResponse {
  if (err instanceof BillingError && err.status === 400) {
    let msg = "That email couldn't be saved.";
    try { msg = (JSON.parse(err.body) as { error?: string }).error ?? msg; } catch { /* keep default */ }
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  console.error("[billing/ap-email]", err instanceof Error ? err.message : err);
  return NextResponse.json({ error: "Billing is unavailable right now — please try again." }, { status: 502 });
}

type Ctx = { actor: string; dealer: DealerRow; canEdit: boolean; customerId: string; mainContact: string | null; ap: BillingCustomerEmail | null };

/** Shared preamble: auth → dealer → self-billed → own customer → AP record. */
async function load(req: NextRequest, write: boolean): Promise<{ ctx: Ctx } | { response: NextResponse }> {
  const { claims, error } = await requireAuth();
  if (error) return { response: error };
  const r = await resolveDealer(req, claims);
  if (!r.ok) return { response: r.response };
  if (write && !r.canEdit) return { response: NextResponse.json({ error: "Only a dealer admin can change the AP email." }, { status: 403 }) };
  if (r.dealer.subscription_billed_to === "group") {
    return { response: NextResponse.json({ billedBy: "group", error: "Billing for this dealership is managed by its group." }, { status: write ? 409 : 200 }) };
  }
  if (!billingConfigured()) return { response: NextResponse.json({ error: "Billing API not configured" }, { status: 500 }) };
  try {
    const own = await ownCustomer(r.dealer);
    if (!own) {
      return { response: NextResponse.json({ billedBy: "self", noCustomer: true, error: "This dealership doesn't have a billing account yet." }, { status: write ? 409 : 200 }) };
    }
    const ap = findAp(await listCustomerEmails(own.id));
    const main = typeof own.customer.email === "string" && own.customer.email.includes("@") ? own.customer.email : null;
    return { ctx: { actor: claims.sub, dealer: r.dealer, canEdit: r.canEdit, customerId: own.id, mainContact: main, ap } };
  } catch (err) {
    return { response: billingErrorResponse(err) };
  }
}

const view = (ctx: Ctx, apEmail: string | null) => ({
  billedBy: "self" as const, apEmail, mainContact: ctx.mainContact, canEdit: ctx.canEdit,
});

function audit(actor: string, dealer: DealerRow, from: string | null, to: string | null) {
  const admin = createAdminSupabaseClient();
  fireWrite(admin.from("admin_audit").insert({
    admin_user_id: actor,
    action: "billing_ap_email_set",
    target_dealer_id: dealer.id,
    metadata: { dealer_id: dealer.dealer_id, dealer_name: dealer.name, from, to },
  }), "admin_audit");
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const r = await load(req, false);
  if ("response" in r) return r.response;
  return NextResponse.json(view(r.ctx, r.ctx.ap?.email ?? null));
}

/** PUT { email } — add or replace the AP email. */
export async function PUT(req: NextRequest): Promise<NextResponse> {
  let body: { email?: unknown };
  try { body = await req.json(); } catch { body = {}; }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  const r = await load(req, true);
  if ("response" in r) return r.response;
  const { ctx } = r;
  if (ctx.ap && ctx.ap.email.trim().toLowerCase() === email.toLowerCase()) {
    return NextResponse.json(view(ctx, ctx.ap.email));
  }
  try {
    // Add the new address first, then drop the old one — a failure part-way
    // leaves an extra recipient, never a missing one.
    const added = await addCustomerEmail(ctx.customerId, email, AP_LABEL);
    if (ctx.ap) await deleteCustomerEmail(ctx.ap.id);
    audit(ctx.actor, ctx.dealer, ctx.ap?.email ?? null, added.email);
    return NextResponse.json(view(ctx, added.email));
  } catch (err) {
    return billingErrorResponse(err);
  }
}

/** DELETE — remove the AP email (the Main Contact keeps receiving invoices). */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const r = await load(req, true);
  if ("response" in r) return r.response;
  const { ctx } = r;
  if (!ctx.ap) return NextResponse.json(view(ctx, null));
  try {
    await deleteCustomerEmail(ctx.ap.id);
    audit(ctx.actor, ctx.dealer, ctx.ap.email, null);
    return NextResponse.json(view(ctx, null));
  } catch (err) {
    return billingErrorResponse(err);
  }
}
