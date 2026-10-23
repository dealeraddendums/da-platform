import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { createAdminSupabaseClient } from "@/lib/db";
import { crmEnv } from "@/lib/crm/env";
import { storeStatuses } from "@/lib/crm/billing-status";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * POST /api/crm/events — inbound activities from other DA systems (da-billing:
 * invoice sent, payment failed, card declined, …) onto a company timeline.
 *
 * Auth: Authorization: Bearer <CRM_EVENTS_TOKEN>.
 * Body: {
 *   event_id: "inv_123_sent",            // required, idempotency key
 *   type: "invoice_sent",                // free-form slug, kept in metadata
 *   company: { company_id? | dealer_uuid? | dealer_id? | internal_id? | billing_customer_id? | group_id? },
 *   subject: "Invoice #1042 sent ($149.00)",
 *   body?: "…", occurred_at?: ISO, metadata?: {…}, source?: "da-billing"
 * }
 * → 200 { ok, activity_id, duplicate? } · 401 bad token · 404 company not found.
 * Retries with the same event_id are no-ops. type billing.status_changed also stores
 * metadata.billing in crm_billing_status (migration 191).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const want = crmEnv("CRM_EVENTS_TOKEN");
  if (!want) return NextResponse.json({ error: "Not configured" }, { status: 503 });
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got), b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const e = await req.json().catch(() => null);
  const eventId = typeof e?.event_id === "string" ? e.event_id.trim().slice(0, 200) : "";
  const type = typeof e?.type === "string" ? e.type.trim().slice(0, 60) : "";
  const subject = typeof e?.subject === "string" ? e.subject.trim().slice(0, 300) : "";
  if (!eventId || !type || !subject) return NextResponse.json({ error: "event_id, type and subject required" }, { status: 400 });
  const occurredAt = e.occurred_at && !Number.isNaN(Date.parse(e.occurred_at)) ? new Date(e.occurred_at).toISOString() : new Date().toISOString();
  const source = typeof e.source === "string" && /^[a-z0-9-]{1,30}$/.test(e.source) ? e.source : "da-billing";

  const admin = createAdminSupabaseClient() as any;
  // DA-Billing status flips (billing.status_changed, metadata.billing = its status payload) refresh the
  // stored status every dealer billed by that customer reads — before the timeline write, so a company
  // that can't be resolved still gets the new status.
  if (type === "billing.status_changed" && e.metadata?.billing?.customer_id && e.metadata.billing.status) {
    await storeStatuses(admin, [e.metadata.billing], "event").catch(() => {});
  }
  const companyId = await resolveCompany(admin, e.company ?? {});
  if (!companyId) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const externalId = `${source}:${eventId}`;
  const { data, error } = await admin.from("crm_activities").insert({
    company_id: companyId,
    type: "status_change",
    direction: "inbound",
    subject,
    body: typeof e.body === "string" ? e.body.slice(0, 20_000) : null,
    metadata: { source, event_type: type, ...(e.metadata && typeof e.metadata === "object" ? { data: e.metadata } : {}) },
    external_id: externalId,
    occurred_at: occurredAt,
  }).select("id").single();
  if (error?.code === "23505") {
    const { data: prior } = await admin.from("crm_activities").select("id").eq("type", "status_change").eq("external_id", externalId).maybeSingle();
    return NextResponse.json({ ok: true, duplicate: true, activity_id: prior?.id ?? null });
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, activity_id: data.id });
}

async function resolveCompany(admin: any, c: Record<string, unknown>): Promise<string | null> {
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  if (s(c.company_id)) {
    const { data } = await admin.from("crm_companies").select("id").eq("id", s(c.company_id)).maybeSingle();
    return data?.id ?? null;
  }
  if (s(c.group_id)) {
    const { data } = await admin.from("crm_companies").select("id").eq("group_id", s(c.group_id)).maybeSingle();
    return data?.id ?? null;
  }
  let dq = admin.from("dealers").select("id");
  if (s(c.dealer_uuid)) dq = dq.eq("id", s(c.dealer_uuid));
  else if (s(c.dealer_id)) dq = dq.eq("dealer_id", s(c.dealer_id));
  else if (s(c.internal_id)) dq = dq.eq("internal_id", s(c.internal_id));
  else if (s(c.billing_customer_id)) {
    const id = s(c.billing_customer_id);
    const { data: d } = await admin.from("dealers").select("id").eq("billing_customer_id", id).limit(1).maybeSingle();
    if (d) dq = dq.eq("id", d.id);
    else {
      const { data: g } = await admin.from("groups").select("id").eq("billing_customer_id", id).limit(1).maybeSingle();
      if (!g) return null;
      const { data } = await admin.from("crm_companies").select("id").eq("group_id", g.id).maybeSingle();
      return data?.id ?? null;
    }
  } else return null;
  const { data: dealer } = await dq.limit(1).maybeSingle();
  if (!dealer) return null;
  const { data } = await admin.from("crm_companies").select("id").eq("dealer_id", dealer.id).maybeSingle();
  return data?.id ?? null;
}
