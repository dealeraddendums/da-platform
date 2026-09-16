import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { createCompanyNote, hubspotConfigured } from "@/lib/hubspot";

export const dynamic = "force-dynamic";

/**
 * POST /api/hubspot/dealer-note — log a Note on a dealer's (or group's)
 * HubSpot Company record on behalf of another DA service.
 *
 * Built for da-billing's "Comp invoice" flow: da-billing knows the reason and
 * the money, DA Platform knows the HubSpot token and the billing-customer ->
 * dealer -> hubspot_company_id mapping. Keeping the token on this side means
 * da-billing never holds a HubSpot credential.
 *
 * Server-to-server only: X-Webhook-Secret = BILLING_CACHE_WEBHOOK_SECRET
 * (PLATFORM_WEBHOOK_SECRET on the da-billing box) — the same pair as
 * billing-cache/invalidate, dealer-names and billing/print-count. No new key.
 *
 * Body: { customerId?, internalId?, noteBody, source }
 *   customerId — da-billing customer id (dealers/groups.billing_customer_id)
 *   internalId — the never-changing platform billing id, used as the fallback
 *                key for customers the billing_customer_id link never got
 *   noteBody   — HTML, composed by the caller
 *
 * A dealer with no linked HubSpot Company (test/unlinked accounts) is a
 * 200 no-op with { skipped }, NEVER an error: the caller's action already
 * succeeded and must not be failed over a missing CRM link.
 */

interface Body {
  customerId?: string;
  internalId?: string | null;
  noteBody?: string;
  source?: string;
}

type Resolved = {
  kind: "dealer" | "group";
  id: string;
  name: string | null;
  hubspotCompanyId: string | null;
  matchedOn: string;
};

async function resolveEntity(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  customerId: string | null,
  internalId: string | null,
): Promise<Resolved | null> {
  // Ordered most-specific first: the billing_customer_id link is the direct
  // key; internal_id is the fallback for customers that link was never set on.
  const lookups: Array<{ table: "dealers" | "groups"; column: string; value: string }> = [];
  if (customerId) {
    lookups.push({ table: "dealers", column: "billing_customer_id", value: customerId });
    lookups.push({ table: "groups", column: "billing_customer_id", value: customerId });
  }
  if (internalId) {
    lookups.push({ table: "dealers", column: "internal_id", value: internalId });
    lookups.push({ table: "groups", column: "internal_id", value: internalId });
  }

  for (const { table, column, value } of lookups) {
    const { data } = await admin
      .from(table)
      .select("id, name, hubspot_company_id")
      .eq(column, value)
      .limit(1)
      .maybeSingle<{ id: string; name: string | null; hubspot_company_id: string | null }>();
    if (data) {
      return {
        kind: table === "dealers" ? "dealer" : "group",
        id: data.id,
        name: data.name,
        hubspotCompanyId: data.hubspot_company_id,
        matchedOn: `${table}.${column}`,
      };
    }
  }
  return null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.BILLING_CACHE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }
  if (req.headers.get("x-webhook-secret") !== secret) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const customerId = body.customerId?.trim() || null;
  const internalId = body.internalId?.trim() || null;
  const noteBody = typeof body.noteBody === "string" ? body.noteBody.trim() : "";
  const source = body.source?.trim() || "unknown";

  if (!noteBody) {
    return NextResponse.json({ error: "noteBody is required" }, { status: 400 });
  }
  if (!customerId && !internalId) {
    return NextResponse.json({ error: "customerId or internalId is required" }, { status: 400 });
  }
  if (!hubspotConfigured()) {
    return NextResponse.json({ ok: true, skipped: "hubspot_not_configured" });
  }

  const admin = createAdminSupabaseClient();
  const entity = await resolveEntity(admin, customerId, internalId);
  if (!entity) {
    console.warn(`[hubspot-note] source=${source} no dealer/group for customerId=${customerId} internalId=${internalId}`);
    return NextResponse.json({ ok: true, skipped: "no_matching_dealer_or_group" });
  }
  if (!entity.hubspotCompanyId) {
    console.warn(`[hubspot-note] source=${source} ${entity.kind} ${entity.id} has no hubspot_company_id`);
    return NextResponse.json({
      ok: true,
      skipped: "no_hubspot_company",
      entity: { type: entity.kind, id: entity.id, name: entity.name },
    });
  }

  try {
    const { id: noteId } = await createCompanyNote({ companyId: entity.hubspotCompanyId, body: noteBody });
    return NextResponse.json({
      ok: true,
      noteId,
      entity: { type: entity.kind, id: entity.id, name: entity.name, matchedOn: entity.matchedOn },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[hubspot-note] source=${source} createCompanyNote failed for ${entity.kind} ${entity.id}:`, message);
    // Same ledger every other HubSpot write failure lands in, so a note lost
    // to a CRM outage is reviewable/replayable rather than silently gone.
    try {
      await (admin as any).from("hubspot_sync_errors").insert({
        object_type: "company",
        object_id: entity.id,
        hubspot_id: entity.hubspotCompanyId,
        op: "create",
        error_message: `${source} note: ${message}`,
        payload: { source, customerId, internalId, noteBody: noteBody.slice(0, 2000) },
      });
    } catch { /* best-effort */ }
    return NextResponse.json({ error: `HubSpot note failed: ${message}` }, { status: 502 });
  }
}
