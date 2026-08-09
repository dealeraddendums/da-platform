// Console Sync billing/config enrichment — apply side (2026-08-09).
//
// The ETL box's scoped /sync now returns read-only Aurora + FreshBooks facts
// per dealer (`enrichment` on each dealer result — see da-legacy-etl
// src/jobs/billingEnrichment.ts). This module turns those facts into the
// platform/da-billing continuity steps:
//
//   1. Feed Source → dealers.inventory_provider (+ inventory_provider_is_dms),
//      normalized onto lib/inventory-providers.ts; unknown values are copied
//      verbatim and flagged, never dropped.
//   2. Subscription continuity report — 4.0 ACCOUNT_TYPE is source of truth;
//      the ETL Dealers job already wrote it to dealers.account_type during the
//      sync, so this step just reports old → new.
//   3. da-billing plan check — the responsible customer's template sub-* line
//      vs the 4.0 tier. NEVER auto-rewrites money: mismatch = warning only.
//   4. FreshBooks billing contact → da-billing customer emails (primary if
//      empty, else additional invoice recipient; deduped case-insensitively).
//   5. FreshBooks recurring next_issue_date → template nextInvoiceDate:
//      Setup-Mode customers get it SET (billing cutover preserves the cycle);
//      Live customers get a mismatch warning only.
//
// Group-billed dealers resolve to the GROUP's da-billing customer and the
// group's FreshBooks linkage. Every step degrades to a status string — an
// enrichment failure must never fail the sync.

import {
  billingConfigured,
  getCustomer,
  updateCustomer,
  listCustomerEmails,
  addCustomerEmail,
  getTemplate,
  setTemplateStatus,
  subscriptionDescriptorFor,
  subscriptionTierLabel,
  type BillingCustomerDetail,
  type BillingProduct,
  type BillingTemplate,
} from "@/lib/billing";
import { normalizeInventoryProvider, isDmsProvider } from "@/lib/inventory-providers";

// ── ETL enrichment payload (mirrors da-legacy-etl src/jobs/billingEnrichment.ts) ──

export interface EtlFbRecurring {
  status: "ok" | "not_found" | "disabled" | "deleted" | "error";
  profile_id: string;
  next_issue_date: string | null;
  frequency: string | null;
  amount: string | null;
  auto_bill: boolean | null;
  lines: { name: string; qty: string; amount: string }[];
  error?: string;
}
export interface EtlFbClient {
  status: "ok" | "not_found" | "deleted" | "error";
  client_id: string;
  email: string | null;
  organization: string | null;
  error?: string;
}
export interface EtlFbEntity {
  source: "dealer" | "group";
  client_id: string | null;
  recurring_id: string | null;
  client: EtlFbClient | null;
  recurring: EtlFbRecurring | null;
}
export interface EtlDealerEnrichment {
  aurora: {
    account_type: string | null;
    feed_source: string | null;
    sub_billing_to: string | null;
    dealer_group: string | null;
    group_name: string | null;
    primary_contact_email: string | null;
    /** Aurora BILLING_ID (da-billing customer UUID for FreshBooks-era dealers)
     *  — Supabase's dealers.billing_id is immutable-on-update and can be
     *  stale/NULL, so the live Aurora value is a resolution candidate. */
    billing_id: string | null;
    group_billing_id: string | null;
  } | null;
  fb_token: "ok" | "expired" | "missing" | "error";
  dealer_fb: EtlFbEntity | null;
  group_fb: EtlFbEntity | null;
  error?: string;
}

// ── Report shape (returned to the console + summarized into migration_log) ──

export interface EnrichmentStep {
  status: string;
  detail?: string;
  warning?: boolean;
}
export interface EnrichmentReport {
  billedTo: "dealer" | "group";
  customerId: string | null;
  provider: EnrichmentStep;
  subscription: EnrichmentStep;
  planCheck: EnrichmentStep;
  contacts: EnrichmentStep;
  nextInvoice: EnrichmentStep;
}

export interface PreSyncDealerSnap {
  account_type: string | null;
  inventory_provider: string | null;
}

// ── date helpers ─────────────────────────────────────────────────────────────

/** Calendar date (YYYY-MM-DD) of a stored nextInvoiceDate in billing time
 *  (America/New_York). Bare dates pass through. */
export function easternDateOf(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** da-billing's nextInvoiceDate convention is an ISO instant at 23:00 ET.
 *  Build that instant for a bare YYYY-MM-DD, DST-aware (EDT −4 / EST −5). */
export function at11pmEasternIso(dateStr: string): string {
  for (const offset of ["-04:00", "-05:00"]) {
    const candidate = new Date(`${dateStr}T23:00:00${offset}`);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(candidate);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    if (`${get("year")}-${get("month")}-${get("day")}` === dateStr && get("hour") === "23") {
      return candidate.toISOString();
    }
  }
  // Unreachable for real dates; fall back to the EST construction.
  return new Date(`${dateStr}T23:00:00-05:00`).toISOString();
}

const stripPriceSuffix = (t: string | null | undefined): string => (t ?? "").split(" $")[0].trim();
const eq = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
const isSub = (p: BillingProduct): boolean => Boolean(p.productId?.startsWith?.("sub-"));

// ── main apply ───────────────────────────────────────────────────────────────

interface DealerPostSync {
  id: string;
  name: string | null;
  account_type: string | null;
  feed_source: string | null;
  inventory_provider: string | null;
  internal_id: string | null;
  billing_customer_id: string | null;
  billing_id: string | null;
  subscription_billed_to: string | null;
  group_id: string | null;
}

/** Per-request caches so a 25-dealer group sync doesn't re-fetch the group's
 *  customer/template/emails for every member. */
export interface EnrichmentContext {
  customers: Map<string, BillingCustomerDetail | null>;
  templates: Map<string, BillingTemplate | null>;
  emails: Map<string, { email: string }[]>;
}
export function newEnrichmentContext(): EnrichmentContext {
  return { customers: new Map(), templates: new Map(), emails: new Map() };
}

const step = (status: string, detail?: string, warning?: boolean): EnrichmentStep => ({
  status,
  ...(detail ? { detail } : {}),
  ...(warning ? { warning: true } : {}),
});

export async function applySyncEnrichment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  dealerUuid: string,
  pre: PreSyncDealerSnap,
  enrichment: EtlDealerEnrichment | undefined,
  ctx: EnrichmentContext,
): Promise<EnrichmentReport> {
  const report: EnrichmentReport = {
    billedTo: "dealer",
    customerId: null,
    provider: step("skipped"),
    subscription: step("skipped"),
    planCheck: step("skipped"),
    contacts: step("skipped"),
    nextInvoice: step("skipped"),
  };

  // Post-sync dealer row — the ETL Dealers job has just refreshed
  // account_type / feed_source from Aurora.
  const { data: dealer } = (await admin
    .from("dealers")
    .select(
      "id, name, account_type, feed_source, inventory_provider, internal_id, billing_customer_id, billing_id, subscription_billed_to, group_id",
    )
    .eq("id", dealerUuid)
    .maybeSingle()) as { data: DealerPostSync | null };
  if (!dealer) {
    const missing = step("error", "dealer row not found post-sync", true);
    return { ...report, provider: missing, subscription: missing };
  }

  // ── 1. Feed Source → Inventory Provider ───────────────────────────────────
  try {
    const rawFeed = dealer.feed_source ?? enrichment?.aurora?.feed_source ?? null;
    const norm = normalizeInventoryProvider(rawFeed);
    if (!norm) {
      report.provider = step("none", "no Feed Source on the 4.0 record");
    } else if (eq(dealer.inventory_provider, norm.provider)) {
      report.provider = step("match", norm.provider);
    } else {
      const { error: updErr } = await admin
        .from("dealers")
        .update({
          inventory_provider: norm.provider,
          inventory_provider_is_dms: isDmsProvider(norm.provider),
        })
        .eq("id", dealerUuid);
      if (updErr) {
        report.provider = step("error", `update failed: ${updErr.message}`, true);
      } else {
        report.provider = step(
          "set",
          `${dealer.inventory_provider ?? "—"} → ${norm.provider}${norm.known ? "" : " (unrecognized 4.0 value, copied verbatim)"}`,
          !norm.known,
        );
      }
    }
  } catch (e) {
    report.provider = step("error", e instanceof Error ? e.message : String(e), true);
  }

  // ── 2. Subscription continuity (4.0 → 5.0, already written by the ETL) ────
  const newAccountType = dealer.account_type ?? null;
  report.subscription = eq(pre.account_type, newAccountType)
    ? step("match", newAccountType ?? "—")
    : step("updated", `${pre.account_type ?? "—"} → ${newAccountType ?? "—"}`);

  // ── Resolve the responsible da-billing customer + FreshBooks entity ───────
  const billedToGroup = dealer.subscription_billed_to === "group";
  report.billedTo = billedToGroup ? "group" : "dealer";

  let customerId: string | null = null;
  if (billedToGroup) {
    if (dealer.group_id) {
      const { data: grp } = (await admin
        .from("groups")
        .select("billing_customer_id, billing_id")
        .eq("id", dealer.group_id)
        .maybeSingle()) as { data: { billing_customer_id: string | null; billing_id?: string | null } | null };
      customerId = await firstExistingCustomer(ctx, [
        grp?.billing_customer_id,
        grp?.billing_id,
        enrichment?.aurora?.group_billing_id,
      ]);
    }
  } else {
    // Legacy dealers are often linked only via billing_id (the FreshBooks-era
    // key the 2026-06 link audit proved exact) or internal_id (/api/billing/me
    // fallback) — try candidates in order, verified against da-billing.
    customerId = await firstExistingCustomer(ctx, [
      dealer.billing_customer_id,
      dealer.billing_id,
      enrichment?.aurora?.billing_id,
      dealer.internal_id,
    ]);
  }
  report.customerId = customerId;

  const fbEntity = billedToGroup ? enrichment?.group_fb : enrichment?.dealer_fb;
  const fbToken = enrichment?.fb_token ?? "error";
  const noEnrichment = !enrichment;
  const fbUnavailableDetail =
    fbToken === "expired"
      ? "FreshBooks token expired (legacy platform refreshes it) — re-sync later"
      : fbToken === "missing"
        ? "no FreshBooks token in legacy fb_keys"
        : "FreshBooks lookup unavailable";

  if (!billingConfigured()) {
    const off = step("skipped", "BILLING_API_KEY not configured");
    report.planCheck = off;
    report.contacts = off;
    report.nextInvoice = off;
    return report;
  }
  if (noEnrichment) {
    const off = step("skipped", "ETL box returned no enrichment payload (old box build?)");
    report.planCheck = await runPlanCheck(dealer, customerId, billedToGroup, ctx); // plan check needs no FB
    report.contacts = off;
    report.nextInvoice = off;
    return report;
  }

  // ── 3. da-billing plan check (warn-only) ──────────────────────────────────
  report.planCheck = await runPlanCheck(dealer, customerId, billedToGroup, ctx);

  // ── 4. FreshBooks billing contact → da-billing customer emails ────────────
  try {
    if (fbToken !== "ok") {
      report.contacts = step("fb_unavailable", fbUnavailableDetail);
    } else if (!fbEntity || !fbEntity.client_id) {
      report.contacts = step(
        "no_fb_client",
        billedToGroup ? "no FreshBooks client on the 4.0 group record" : "no FreshBooks client on the 4.0 record",
      );
    } else if (!fbEntity.client || fbEntity.client.status === "error") {
      report.contacts = step("error", `FreshBooks client lookup failed${fbEntity.client?.error ? `: ${fbEntity.client.error}` : ""}`, true);
    } else if (fbEntity.client.status !== "ok") {
      report.contacts = step("fb_client_gone", `FreshBooks client ${fbEntity.client_id} is ${fbEntity.client.status} in FreshBooks`);
    } else if (!fbEntity.client.email) {
      report.contacts = step("no_fb_email", "FreshBooks client has no billing email");
    } else {
      const fbEmail = fbEntity.client.email.trim();
      const customer = await cachedCustomer(ctx, customerId);
      if (!customerId || !customer) {
        report.contacts = step(
          "no_customer",
          `no da-billing customer yet — FreshBooks billing contact: ${fbEmail} (apply when the customer is staged)`,
          true,
        );
      } else if ((customer as { archived?: boolean }).archived) {
        report.contacts = step("customer_archived", "da-billing customer is archived — contacts not touched", true);
      } else if (!((customer.email ?? "").trim())) {
        await updateCustomer(customerId, { email: fbEmail });
        customer.email = fbEmail;
        report.contacts = step("primary_set", `primary billing email set: ${fbEmail}`);
      } else if (eq(customer.email, fbEmail)) {
        report.contacts = step("present", `already the primary billing email (${fbEmail})`);
      } else {
        const existing = await cachedEmails(ctx, customerId);
        if (existing.some((e) => eq(e.email, fbEmail))) {
          report.contacts = step("present", `already an invoice recipient (${fbEmail})`);
        } else {
          await addCustomerEmail(customerId, fbEmail, "FreshBooks billing contact");
          existing.push({ email: fbEmail });
          report.contacts = step("added", `added invoice recipient: ${fbEmail}`);
        }
      }
    }
  } catch (e) {
    report.contacts = step("error", e instanceof Error ? e.message : String(e), true);
  }

  // ── 5. Next-invoice-date continuity ───────────────────────────────────────
  try {
    if (fbToken !== "ok") {
      report.nextInvoice = step("fb_unavailable", fbUnavailableDetail);
    } else if (!fbEntity || !fbEntity.recurring_id) {
      report.nextInvoice = step(
        "no_fb_profile",
        billedToGroup
          ? "no FreshBooks recurring profile on the 4.0 group record"
          : "no FreshBooks recurring profile on the 4.0 record",
      );
    } else if (!fbEntity.recurring || fbEntity.recurring.status === "error") {
      report.nextInvoice = step("error", `FreshBooks profile lookup failed${fbEntity.recurring?.error ? `: ${fbEntity.recurring.error}` : ""}`, true);
    } else if (fbEntity.recurring.status === "not_found" || fbEntity.recurring.status === "deleted") {
      report.nextInvoice = step("fb_profile_gone", `FreshBooks recurring profile ${fbEntity.recurring_id} is ${fbEntity.recurring.status === "deleted" ? "deleted" : "gone"} (already stopped?)`);
    } else if (fbEntity.recurring.status === "disabled") {
      report.nextInvoice = step("fb_profile_disabled", "FreshBooks recurring profile is disabled/paused — da-billing left untouched");
    } else if (!fbEntity.recurring.next_issue_date) {
      report.nextInvoice = step("no_fb_date", "FreshBooks profile has no next issue date");
    } else {
      const fbDate = fbEntity.recurring.next_issue_date; // YYYY-MM-DD
      const customer = customerId ? await cachedCustomer(ctx, customerId) : null;
      const template = customerId ? await cachedTemplate(ctx, customerId) : null;
      if (!customerId || !customer) {
        report.nextInvoice = step("no_customer", `no da-billing customer — FreshBooks next invoice: ${fbDate}`, true);
      } else if (!template) {
        report.nextInvoice = step("no_template", `no billing template staged — FreshBooks next invoice: ${fbDate}`, true);
      } else {
        const currentDate = easternDateOf(template.nextInvoiceDate);
        const setupMode = customer.billingState === "setup" || template.active === false;
        if (currentDate === fbDate) {
          report.nextInvoice = step("match", fbDate);
        } else if (setupMode) {
          if (typeof template.active !== "boolean") {
            report.nextInvoice = step("error", "template active flag unreadable — nextInvoiceDate not set", true);
          } else {
            await setTemplateStatus(customerId, template.active, at11pmEasternIso(fbDate));
            template.nextInvoiceDate = at11pmEasternIso(fbDate);
            report.nextInvoice = step("set", `${currentDate ?? "—"} → ${fbDate} (from FreshBooks)`);
          }
        } else {
          report.nextInvoice = step(
            "mismatch",
            `Next invoice: FreshBooks says ${fbDate}, da-billing says ${currentDate ?? "—"} (customer is Live — not auto-changed)`,
            true,
          );
        }
      }
    }
  } catch (e) {
    report.nextInvoice = step("error", e instanceof Error ? e.message : String(e), true);
  }

  return report;
}

async function runPlanCheck(
  dealer: DealerPostSync,
  customerId: string | null,
  billedToGroup: boolean,
  ctx: EnrichmentContext,
): Promise<EnrichmentStep> {
  try {
    const tierBase = stripPriceSuffix(dealer.account_type);
    const expected = subscriptionDescriptorFor(tierBase);
    if (!expected) {
      return step("n/a", `no paid tier for "${dealer.account_type ?? "—"}" (trial/free)`);
    }
    if (!customerId) {
      return step("no_customer", billedToGroup ? "no group da-billing customer" : "no da-billing customer");
    }
    const template = await cachedTemplate(ctx, customerId);
    if (!template) return step("no_template", "no billing template staged");
    const subLines = template.products.filter(isSub);
    const line = billedToGroup
      ? subLines.find((p) => p.lineItemDescription?.startsWith(`${dealer.internal_id ?? ""}::`))
      : subLines[0];
    if (!line) {
      return step(
        "no_sub_line",
        billedToGroup ? "no subscription line for this dealer on the group template" : "no subscription line on the template",
        true,
      );
    }
    if (line.productId === expected.key) {
      return step("match", subscriptionTierLabel(expected.key));
    }
    return step(
      "mismatch",
      `Billing plan mismatch: 4.0 says ${tierBase}, template is ${subscriptionTierLabel(line.productId)} (not auto-changed — fix in da-billing)`,
      true,
    );
  } catch (e) {
    return step("error", e instanceof Error ? e.message : String(e), true);
  }
}

/** First candidate id (in order) that resolves to a real da-billing customer.
 *  Bad/legacy candidates 404 → try the next; da-billing outage → null (steps
 *  degrade to "no da-billing customer" statuses without failing the sync). */
async function firstExistingCustomer(
  ctx: EnrichmentContext,
  candidates: Array<string | null | undefined>,
): Promise<string | null> {
  for (const c of candidates) {
    const id = (c ?? "").trim();
    if (!id) continue;
    try {
      if (await cachedCustomer(ctx, id)) return id;
    } catch {
      // transient billing error on this candidate — try the next
    }
  }
  return null;
}

async function cachedCustomer(ctx: EnrichmentContext, customerId: string | null): Promise<BillingCustomerDetail | null> {
  if (!customerId) return null;
  if (!ctx.customers.has(customerId)) ctx.customers.set(customerId, await getCustomer(customerId));
  return ctx.customers.get(customerId) ?? null;
}
async function cachedTemplate(ctx: EnrichmentContext, customerId: string): Promise<BillingTemplate | null> {
  if (!ctx.templates.has(customerId)) ctx.templates.set(customerId, await getTemplate(customerId));
  return ctx.templates.get(customerId) ?? null;
}
async function cachedEmails(ctx: EnrichmentContext, customerId: string): Promise<{ email: string }[]> {
  if (!ctx.emails.has(customerId)) {
    ctx.emails.set(customerId, (await listCustomerEmails(customerId)).map((e) => ({ email: e.email })));
  }
  return ctx.emails.get(customerId)!;
}

/** One-line human summary for migration_log notes + the console alert. */
export function summarizeEnrichment(r: EnrichmentReport): string {
  const part = (label: string, s: EnrichmentStep): string =>
    `${label}: ${s.detail ? `${s.status} — ${s.detail}` : s.status}`;
  return [
    part("provider", r.provider),
    part("subscription", r.subscription),
    part("plan", r.planCheck),
    part("contacts", r.contacts),
    part("next-invoice", r.nextInvoice),
  ].join("; ");
}

/** The warnings a report carries (amber lines for the console alert). */
export function enrichmentWarnings(r: EnrichmentReport): string[] {
  return [r.provider, r.subscription, r.planCheck, r.contacts, r.nextInvoice]
    .filter((s) => s.warning)
    .map((s) => s.detail ?? s.status);
}
