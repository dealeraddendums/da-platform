// Server-to-server only. The marketing site's /api/leads/confirm calls this with
// a shared X-API-Key AFTER Turnstile passed AND the applicant clicked the
// email-confirmation link. The browser never reaches this endpoint.
//
// ── The gate (added 2026-09-03 after two fake overnight trials auto-provisioned)
// Layers run cheapest-first, and EVERY outcome is written to
// self_serve_signups (migration 154) so overnight abuse volume is visible:
//
//   Layer 1  field sanity → per-IP rate limit (shared DB ledger) → disposable
//            domain / no-MX  ....................  lib/signup-guard.ts
//   Layer 2  business hours, 5 AM–9 PM Pacific, DST-safe  ..  lib/signup-guard.ts
//   Layer 3  AI legitimacy verdict  .............  lib/signup-legitimacy.ts
//
// Only a confident "legit" auto-provisions. suspicious / fake / AI-error all
// land in the review queue — we fail to a human, never to auto-allow.
//
// Layer 0 (email confirmation before any of this) lives on the marketing side:
// the lead is saved on submit, and this endpoint is only called once the
// address has proven it can receive mail.
//
// SCOPE: this is the PUBLIC path only. super_admin / group-admin dealer creation
// (POST /api/dealers) and existing-user logins are untouched by all of it.

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createAdminSupabaseClient } from "@/lib/db";
import { selfServeDuplicateExists, type Attribution } from "@/lib/provisioning";
import {
  fieldSanity, ipRateLimitExceeded, isDisposableDomain, domainHasMx,
  isWithinSignupHours, pacificHour, AFTER_HOURS_MESSAGE, IP_LIMIT, IP_WINDOW_MINUTES,
} from "@/lib/signup-guard";
import { evaluateSignupLegitimacy, shouldAutoProvision, type LegitimacyVerdict } from "@/lib/signup-legitimacy";
import { provisionSelfServe, type SelfServeInput } from "@/lib/self-serve-provision";
import { sendReviewRequestEmail } from "@/lib/self-serve-review-email";

interface Body {
  name?: string;
  email?: string;
  dealership?: string;
  phone?: string;
  zip?: string;
  accountKind?: "single" | "group";
  groupName?: string;
  attribution?: Attribution;
}

const PENDING_MESSAGE =
  "Thanks — we're reviewing your details and will activate your account shortly.";

/** One row per attempt: the audit log, the review queue, and the rate-limit ledger. */
async function logDecision(fields: Record<string, unknown>): Promise<string | null> {
  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .from("self_serve_signups").insert(fields).select("id").single();
  if (error) {
    // Never fail a signup because logging failed — but say so loudly.
    console.error("[self-serve] decision log insert failed:", error.message);
    return null;
  }
  return data?.id ?? null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Auth: shared secret, no user session ──────────────────────────────────
  const configuredKey = process.env.SELF_SERVE_API_KEY;
  if (!configuredKey) {
    console.error("[self-serve] SELF_SERVE_API_KEY not configured — refusing");
    return NextResponse.json({ error: "Provisioning not configured" }, { status: 503 });
  }
  if (req.headers.get("x-api-key") !== configuredKey) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = body.name?.trim();
  const email = body.email?.trim().toLowerCase();
  const dealership = body.dealership?.trim();
  const phone = body.phone?.trim() || null;
  const zip = body.zip?.trim() || null;
  const accountKind: "single" | "group" = body.accountKind === "group" ? "group" : "single";
  const attribution = body.attribution ?? null;
  // The applicant's browser IP, forwarded by the marketing site (which sits
  // directly on EC2 and therefore sees the real client address).
  const sourceIp = req.headers.get("x-signup-client-ip")?.trim()
    || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || null;

  if (!name || !email || !dealership) {
    return NextResponse.json({ error: "name, email, and dealership are required" }, { status: 400 });
  }
  const groupName = (body.groupName?.trim() || dealership);
  const entityName = accountKind === "group" ? groupName : dealership;

  const common = {
    email, contact_name: name, dealership, phone, zip,
    account_kind: accountKind, group_name: accountKind === "group" ? groupName : null,
    attribution, source_ip: sourceIp,
  };

  // ── Layer 1a — field sanity ───────────────────────────────────────────────
  const sanity = fieldSanity({ email, name, dealership, zip });
  if (!sanity.ok) {
    await logDecision({ ...common, decision: "blocked_invalid", decision_reason: sanity.reason });
    return NextResponse.json({ error: sanity.reason }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // ── Duplicate guard (unchanged behaviour: an existing account is a no-op) ──
  try {
    if (await selfServeDuplicateExists({ email, name: entityName, kind: accountKind })) {
      return NextResponse.json({ ok: true, existing: true });
    }
  } catch (err) {
    console.error("[self-serve] duplicate check failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Signup temporarily unavailable" }, { status: 503 });
  }

  // ── Layer 1b — per-IP rate limit, shared state ────────────────────────────
  const { exceeded, recent } = await ipRateLimitExceeded(admin, sourceIp);
  if (exceeded) {
    await logDecision({
      ...common, decision: "blocked_ratelimit",
      decision_reason: `${recent} attempts from ${sourceIp} in the last ${IP_WINDOW_MINUTES}m (limit ${IP_LIMIT})`,
    });
    console.warn(`[self-serve] BLOCKED ratelimit ip=${sourceIp} recent=${recent} email=${email}`);
    return NextResponse.json({ error: "Too many signup attempts — please try again later." }, { status: 429 });
  }

  // ── Layer 1c — disposable domain / undeliverable domain ───────────────────
  if (isDisposableDomain(email)) {
    await logDecision({ ...common, decision: "blocked_domain", decision_reason: "disposable email domain" });
    console.warn(`[self-serve] BLOCKED disposable-domain email=${email}`);
    return NextResponse.json({ error: "Please sign up with your dealership email address." }, { status: 400 });
  }
  const mx = await domainHasMx(email);
  if (!mx.ok) {
    await logDecision({ ...common, decision: "blocked_domain", decision_reason: "email domain has no MX record" });
    console.warn(`[self-serve] BLOCKED no-MX email=${email}`);
    return NextResponse.json({ error: "That email domain can't receive mail — please check the address." }, { status: 400 });
  }

  // ── Layer 2 — business hours (Pacific, DST-safe) ──────────────────────────
  if (!isWithinSignupHours()) {
    await logDecision({
      ...common, decision: "blocked_afterhours",
      decision_reason: `attempted at ${pacificHour()}:00 Pacific (open 5–21)`,
    });
    console.warn(`[self-serve] BLOCKED after-hours hour=${pacificHour()}PT email=${email} dealership="${dealership}"`);
    return NextResponse.json({ error: AFTER_HOURS_MESSAGE, afterHours: true }, { status: 403 });
  }

  // ── Layer 3 — AI legitimacy ───────────────────────────────────────────────
  const verdict: LegitimacyVerdict = await evaluateSignupLegitimacy({
    email, name, dealership, zip, phone, accountKind,
    groupName: accountKind === "group" ? groupName : null,
  });
  const aiFields = {
    ai_verdict: verdict.verdict, ai_confidence: verdict.confidence,
    ai_reasons: verdict.reasons, ai_model: verdict.model, ai_ms: verdict.ms,
  };
  const input: SelfServeInput = { name, email, dealership, phone, zip, accountKind, groupName, attribution };

  // ── Held for human review ─────────────────────────────────────────────────
  if (!shouldAutoProvision(verdict)) {
    const reviewToken = randomBytes(32).toString("hex");
    const rowId = await logDecision({
      ...common, ...aiFields, decision: "pending_review",
      decision_reason: verdict.verdict === "error"
        ? "AI evaluation unavailable — held for review (fail-safe)"
        : `AI verdict ${verdict.verdict} (confidence ${verdict.confidence})`,
      review_token: reviewToken,
    });
    console.warn(`[self-serve] QUEUED verdict=${verdict.verdict} conf=${verdict.confidence} email=${email} dealership="${dealership}" reasons=${JSON.stringify(verdict.reasons)}`);
    if (rowId) {
      void sendReviewRequestEmail({ rowId, reviewToken, input, verdict });
    }
    return NextResponse.json({ ok: true, pending: true, message: PENDING_MESSAGE }, { status: 202 });
  }

  // ── Auto-provision (legit, confident) ─────────────────────────────────────
  try {
    const result = await provisionSelfServe(input);
    const rowId = await logDecision({
      ...common, ...aiFields, decision: "provisioned",
      decision_reason: `AI verdict legit (confidence ${verdict.confidence})`,
      ...(result.kind === "group" ? { group_id: result.groupId } : { dealer_id: result.dealerId, dealer_uuid: result.dealerUuid }),
    });
    void rowId;
    console.log(`[self-serve] PROVISIONED conf=${verdict.confidence} email=${email} dealership="${dealership}"`);
    return result.kind === "group"
      ? NextResponse.json({ ok: true, kind: "group", group_id: result.groupId }, { status: 201 })
      : NextResponse.json({ ok: true, kind: "single", dealer_id: result.dealerId, dealer_uuid: result.dealerUuid }, { status: 201 });
  } catch (err) {
    console.error("[self-serve] provisioning failed:", err instanceof Error ? err.message : err);
    await logDecision({ ...common, ...aiFields, decision: "blocked_invalid", decision_reason: `provisioning failed: ${err instanceof Error ? err.message : "unknown"}` });
    return NextResponse.json({ error: "Provisioning failed" }, { status: 500 });
  }
}
