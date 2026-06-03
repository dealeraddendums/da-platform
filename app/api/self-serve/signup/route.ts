import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import {
  createTrialDealer,
  createTrialGroup,
  createAdminUserWithInvite,
  selfServeDuplicateExists,
  type Attribution,
} from "@/lib/provisioning";
import { hubspotConfigured, upsertObject } from "@/lib/hubspot";

// Server-to-server only. The marketing site's /api/leads calls this with a
// shared X-API-Key after it verifies Turnstile + saves the marketing_lead. The
// browser never reaches this endpoint. Creates a Trial dealer (or group) +
// admin user, fires the existing HubSpot reliable-create + passkey invite, and
// returns the new id so marketing can store it on the lead row.
//
// STOP-for-review feature: provisions real Trial accounts + writes HubSpot.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Body {
  name?: string;
  email?: string;
  dealership?: string;
  phone?: string;
  accountKind?: "single" | "group";
  groupName?: string;
  attribution?: Attribution;
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

  // ── Defensive rate-limit (real gate is the key + Turnstile upstream) ──────
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!rateLimit(`self-serve:${ip}`, 30, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
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
  const accountKind: "single" | "group" = body.accountKind === "group" ? "group" : "single";
  const attribution = body.attribution ?? null;

  if (!name || !email || !dealership) {
    return NextResponse.json({ error: "name, email, and dealership are required" }, { status: 400 });
  }
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "invalid email" }, { status: 400 });
  }
  // For a group the org name is groupName when given, else the dealership field.
  const groupName = (body.groupName?.trim() || dealership);
  const entityName = accountKind === "group" ? groupName : dealership;

  // ── Duplicate guard ───────────────────────────────────────────────────────
  try {
    if (await selfServeDuplicateExists({ email, name: entityName, kind: accountKind })) {
      return NextResponse.json({ ok: true, existing: true });
    }
  } catch (err) {
    console.error("[self-serve] duplicate check failed:", err instanceof Error ? err.message : err);
    // Fail safe: if the dup check itself errors, don't risk a duplicate create.
    return NextResponse.json({ error: "Signup temporarily unavailable" }, { status: 503 });
  }

  try {
    if (accountKind === "group") {
      const { groupId } = await createTrialGroup({
        groupName, contactName: name, email, phone, attribution,
      });
      await createAdminUserWithInvite({
        email, fullName: name, phone, role: "group_admin",
        groupId, entityName: groupName,
      });
      void pushAttributionToHubspot(email, attribution);
      return NextResponse.json({ ok: true, kind: "group", group_id: groupId }, { status: 201 });
    }

    const { dealerUuid, dealerId } = await createTrialDealer({
      dealership, contactName: name, email, phone, attribution,
    });
    await createAdminUserWithInvite({
      email, fullName: name, phone, role: "dealer_admin",
      dealerTextId: dealerId, entityName: dealership,
    });
    void pushAttributionToHubspot(email, attribution);
    return NextResponse.json({ ok: true, kind: "single", dealer_id: dealerId, dealer_uuid: dealerUuid }, { status: 201 });
  } catch (err) {
    console.error("[self-serve] provisioning failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Provisioning failed" }, { status: 500 });
  }
}

/**
 * Best-effort: stamp the acquisition source onto the HubSpot Contact as custom
 * properties. GATED OFF by default (HUBSPOT_ATTRIBUTION_ENABLED=1) because the
 * portal must have the matching custom contact properties first — otherwise
 * HubSpot 400s on unknown properties. The acquisition source is always stored
 * durably on the dealer/group row (jsonb), so this is purely additive. Isolated
 * fire-and-forget — never affects provisioning or the onboarding-trigger sync.
 */
function pushAttributionToHubspot(email: string, attribution: Attribution): void {
  if (process.env.HUBSPOT_ATTRIBUTION_ENABLED !== "1") return;
  if (!hubspotConfigured() || !attribution) return;
  const props: Record<string, string | null> = {};
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "referrer", "landing_page"]) {
    if (attribution[k] != null) props[k] = attribution[k];
  }
  if (Object.keys(props).length === 0) return;
  void (async () => {
    try {
      await upsertObject({
        object: "contacts",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        properties: { email, ...props } as any,
        existingHubspotId: null,
        searchProperty: "email",
        searchValue: email,
      });
    } catch (err) {
      console.error("[self-serve] HubSpot attribution push failed (non-fatal):", err instanceof Error ? err.message : err);
    }
  })();
}
