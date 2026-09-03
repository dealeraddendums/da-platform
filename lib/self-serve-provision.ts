// The actual Trial provisioning step for the PUBLIC self-serve path, extracted
// so BOTH callers use exactly one implementation:
//
//   1. POST /api/self-serve/signup — when the gate auto-approves.
//   2. POST /api/self-serve/review — when a human approves a held signup.
//
// Keeping this in one place is what guarantees a manually-approved signup gets
// an identical account to an auto-approved one (same sample seed, same invite
// email, same HubSpot records, same Box folder).

import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import {
  createTrialDealer, createTrialGroup, createAdminUserWithInvite, type Attribution,
} from "@/lib/provisioning";
import { hubspotConfigured, upsertObject } from "@/lib/hubspot";

export interface SelfServeInput {
  name: string;
  email: string;
  dealership: string;
  phone: string | null;
  zip: string | null;
  accountKind: "single" | "group";
  groupName: string;
  attribution: Attribution;
}

export type ProvisionResult =
  | { kind: "group"; groupId: string }
  | { kind: "single"; dealerId: string; dealerUuid: string };

export async function provisionSelfServe(input: SelfServeInput): Promise<ProvisionResult> {
  const { name, email, dealership, phone, zip, accountKind, groupName, attribution } = input;

  if (accountKind === "group") {
    const { groupId } = await createTrialGroup({
      groupName, contactName: name, email, phone, zip, attribution,
    });
    await createAdminUserWithInvite({
      email, fullName: name, phone, role: "group_admin",
      groupId, entityName: groupName,
    });
    pushAttributionToHubspot(email, attribution);
    return { kind: "group", groupId };
  }

  const { dealerUuid, dealerId } = await createTrialDealer({
    dealership, contactName: name, email, phone, zip, attribution,
  });
  await createAdminUserWithInvite({
    email, fullName: name, phone, role: "dealer_admin",
    dealerTextId: dealerId, entityName: dealership,
  });
  pushAttributionToHubspot(email, attribution);
  return { kind: "single", dealerId, dealerUuid };
}

/** Record the provisioning result back onto the gate row. */
export async function stampProvisionResult(rowId: string, result: ProvisionResult): Promise<void> {
  const admin = createAdminSupabaseClient();
  const patch = result.kind === "group"
    ? { group_id: result.groupId }
    : { dealer_id: result.dealerId, dealer_uuid: result.dealerUuid };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fireWrite((admin as any).from("self_serve_signups").update(patch).eq("id", rowId), "self_serve_signups");
}

/**
 * Best-effort: stamp the acquisition source onto the HubSpot Contact as custom
 * properties. GATED OFF by default (HUBSPOT_ATTRIBUTION_ENABLED=1) because the
 * portal must have the matching custom contact properties first — otherwise
 * HubSpot 400s on unknown properties. The acquisition source is always stored
 * durably on the dealer/group row (jsonb), so this is purely additive.
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
