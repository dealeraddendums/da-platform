import { NextRequest, NextResponse } from "next/server";
import { getServerProfile } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { billingConfigured, createCustomer, createTemplate } from "@/lib/billing";
import { boxConfigured, createDealerFolder, createGroupFolder } from "@/lib/box";
import { fireAndForget } from "@/lib/billing-sync";

// All QA-provisioned entities use this fixed password so the /qa/test
// page can display credentials inline. Testers never type the password
// directly elsewhere -- they paste it into an incognito window.
const QA_PASSWORD = "QATest2026!";

type EntityType = "dealer" | "group" | "user";
type Provisioned = {
  entity_type: EntityType;
  entity_id: string;
  role: string | null;
  email: string | null;
  display_name: string;
  created: boolean;
};

export async function POST(_req: NextRequest): Promise<NextResponse> {
  const ctx = await getServerProfile();
  if (!ctx?.profile) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx.profile.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();
  const out: Provisioned[] = [];

  // ---- 1. QA Test Group ----------------------------------------------------
  const groupName = "QA Test Group";
  const existingGroupResp = await (admin as any)
    .from("groups")
    .select("id, name, billing_customer_id, box_folder_id")
    .eq("test_account", true)
    .eq("name", groupName)
    .maybeSingle();
  let groupId: string | null = existingGroupResp.data?.id ?? null;
  let groupBillingCustomerId: string | null = existingGroupResp.data?.billing_customer_id ?? null;
  let groupBoxFolderId: string | null = existingGroupResp.data?.box_folder_id ?? null;
  let groupCreated = false;

  if (!groupId) {
    const groupInsertResp = await (admin as any)
      .from("groups")
      .insert({
        name: groupName,
        // Schema: groups uses primary_contact / primary_contact_email,
        // not contact_name / contact_email (which the first cut of this
        // route assumed).
        primary_contact: "QA Test Contact",
        primary_contact_email: "qa-group@test.dealeraddendums.com",
        phone: "8014159435",
        address: "277 E 4600 S",
        city: "Murray",
        state: "UT",
        zip: "84107",
        billing_contact: "QA Test Billing",
        billing_email: "qa-billing@test.dealeraddendums.com",
        billing_phone: "8014159435",
        test_account: true,
      })
      .select("id, billing_customer_id, box_folder_id")
      .single();
    if (groupInsertResp.error) {
      console.error("[qa/setup-environment] group insert failed:", groupInsertResp.error);
      return NextResponse.json({ error: `Group create failed: ${groupInsertResp.error.message}` }, { status: 500 });
    }
    groupId = groupInsertResp.data.id as string;
    groupBillingCustomerId = groupInsertResp.data.billing_customer_id ?? null;
    groupBoxFolderId = groupInsertResp.data.box_folder_id ?? null;
    groupCreated = true;
  }
  out.push({ entity_type: "group", entity_id: groupId!, role: null, email: null, display_name: groupName, created: groupCreated });
  await recordEnv(admin, "group", groupId!, null, null, groupName);

  // Group side effects (fire-and-forget): da-billing customer + Box folder.
  // Run on every setup pass when the corresponding column is null so we
  // re-attempt wiring that failed on a prior run.
  if (billingConfigured() && !groupBillingCustomerId) {
    fireAndForget(async () => {
      const created = await createCustomer({
        name: "QA Test Billing",
        company: groupName,
        email: "qa-billing@test.dealeraddendums.com",
        phone: "8014159435",
        address: "277 E 4600 S",
        state: "UT",
        isGroup: true,
      });
      const { error: updateErr } = await (admin as any)
        .from("groups")
        .update({ billing_customer_id: created.id })
        .eq("id", groupId!);
      if (updateErr) throw new Error(`groups update failed: ${updateErr.message} (billing customer ${created.id})`);
    }, {
      event: "billing.customer.create",
      groupId: groupId!,
      payload: { groupName, qa: true },
    });
  }
  if (boxConfigured() && !groupBoxFolderId) {
    fireAndForget(async () => {
      const folderId = await createGroupFolder(groupName);
      const { error: updateErr } = await (admin as any)
        .from("groups")
        .update({ box_folder_id: folderId })
        .eq("id", groupId!)
        .is("box_folder_id", null);
      if (updateErr) throw new Error(`groups update failed: ${updateErr.message} (folder ${folderId})`);
    }, {
      event: "box.folder.create",
      groupId: groupId!,
      payload: { groupName, entity: "group", qa: true },
    });
  }

  // ---- 2. QA Test Dealer A (standalone, sub-manual, billed to self) -------
  const dealerA = await provisionDealer(admin, {
    name: "QA Test Dealer A",
    dealer_id: "qa-test-dealer-a",
    group_id: null,
    account_type: "sub-manual",
    subscription_billed_to: "dealer",
    labels_billed_to: "dealer",
  });
  out.push({ entity_type: "dealer", entity_id: dealerA.entity_id, role: null, email: null, display_name: dealerA.display_name, created: dealerA.created });

  // Dealer A side effects: billing customer + template (sub-manual line),
  // and Box folder. Standalone billing so the customer + template are
  // mandatory for the seeded billing tests to pass.
  if (billingConfigured() && !dealerA.billing_customer_id) {
    fireAndForget(async () => {
      const created = await createCustomer({
        name: "QA Test Contact",
        company: dealerA.display_name,
        email: "qa-contact@test.dealeraddendums.com",
        phone: "8014159435",
        address: "277 E 4600 S",
        state: "UT",
        isGroup: false,
      });
      const { error: updateErr } = await (admin as any)
        .from("dealers")
        .update({ billing_customer_id: created.id })
        .eq("id", dealerA.entity_id);
      if (updateErr) throw new Error(`dealers update failed: ${updateErr.message} (billing customer ${created.id})`);

      // Recurring template with one sub-manual line item. DA Platform
      // never sends price -- da-billing resolves the canonical $100
      // from pricing.getPriceForProduct("sub-manual") at save time.
      await createTemplate({
        customerId: created.id,
        products: [{
          productId: "sub-manual",
          quantity: 1,
          lineItemDescription: `${dealerA.internal_id}::${dealerA.display_name}`,
        }],
      });
    }, {
      event: "billing.customer.create",
      dealerId: dealerA.entity_id,
      payload: { dealerName: dealerA.display_name, accountType: "sub-manual", qa: true },
    });
  }
  if (boxConfigured() && !dealerA.box_folder_id) {
    fireAndForget(async () => {
      const folderId = await createDealerFolder(dealerA.display_name);
      const { error: updateErr } = await (admin as any)
        .from("dealers")
        .update({ box_folder_id: folderId })
        .eq("id", dealerA.entity_id)
        .is("box_folder_id", null);
      if (updateErr) throw new Error(`dealers update failed: ${updateErr.message} (folder ${folderId})`);
    }, {
      event: "box.folder.create",
      dealerId: dealerA.entity_id,
      payload: { dealerName: dealerA.display_name, entity: "dealer", qa: true },
    });
  }

  // ---- 3. QA Test Dealer B (in group, sub-auto-web, billed to group) ------
  const dealerB = await provisionDealer(admin, {
    name: "QA Test Dealer B",
    dealer_id: "qa-test-dealer-b",
    group_id: groupId!,
    account_type: "sub-auto-web",
    subscription_billed_to: "group",
    labels_billed_to: "group",
  });
  out.push({ entity_type: "dealer", entity_id: dealerB.entity_id, role: null, email: null, display_name: dealerB.display_name, created: dealerB.created });

  // Dealer B side effects: Box folder only. Subscription lives on the
  // group's template so no per-dealer billing customer is created.
  if (boxConfigured() && !dealerB.box_folder_id) {
    fireAndForget(async () => {
      const folderId = await createDealerFolder(dealerB.display_name);
      const { error: updateErr } = await (admin as any)
        .from("dealers")
        .update({ box_folder_id: folderId })
        .eq("id", dealerB.entity_id)
        .is("box_folder_id", null);
      if (updateErr) throw new Error(`dealers update failed: ${updateErr.message} (folder ${folderId})`);
    }, {
      event: "box.folder.create",
      dealerId: dealerB.entity_id,
      payload: { dealerName: dealerB.display_name, entity: "dealer", qa: true },
    });
  }

  // ---- 4. Test user accounts ----------------------------------------------
  // profiles.dealer_id is TEXT and must hold dealers.dealer_id (the text code),
  // not dealers.id (UUID) — every other route that resolves a profile to its
  // dealer joins on dealers.dealer_id = profiles.dealer_id. Storing the UUID
  // here used to silently break the dealer relationship for every QA user.
  const users = [
    { email: "qa-dealer-admin@test.dealeraddendums.com",       role: "dealer_admin",      dealer_id: dealerA.dealer_id, group_id: null,    full_name: "QA Dealer Admin" },
    { email: "qa-dealer-user@test.dealeraddendums.com",        role: "dealer_user",       dealer_id: dealerA.dealer_id, group_id: null,    full_name: "QA Dealer User" },
    // Second dealer_user account (was dealer_restricted before -- that role
    // is not allowed by profiles.role's check constraint, so we provision
    // a second dealer_user instead and distinguish it by display name).
    { email: "qa-dealer-restricted@test.dealeraddendums.com",  role: "dealer_user",       dealer_id: dealerA.dealer_id, group_id: null,    full_name: "QA Dealer User 2" },
    { email: "qa-group-admin@test.dealeraddendums.com",        role: "group_admin",       dealer_id: null,              group_id: groupId, full_name: "QA Group Admin" },
  ];

  for (const u of users) {
    const provisioned = await provisionUser(admin, u);
    out.push({ entity_type: "user", ...provisioned });
  }

  // ---- 4b. Resync profile bindings ----------------------------------------
  // Self-healing pass: provisionUser short-circuits when a qa_test_environment
  // row already exists, so a pre-existing profile with the wrong (or null)
  // dealer_id/group_id wouldn't be corrected by re-running setup. Apply the
  // canonical bindings unconditionally here.
  for (const u of users) {
    const { error: syncErr } = await (admin as any)
      .from("profiles")
      .update({ dealer_id: u.dealer_id, group_id: u.group_id })
      .eq("email", u.email);
    if (syncErr) {
      console.error(`[qa/setup-environment] profile resync failed (${u.email}):`, syncErr);
    }
  }

  return NextResponse.json({ success: true, entities: out, password: QA_PASSWORD });
}

// ---- helpers --------------------------------------------------------------

type DealerProvisioned = {
  entity_id: string;          // dealers.id (UUID) — primary key
  dealer_id: string;          // dealers.dealer_id (TEXT) — the value profiles.dealer_id must hold to join correctly
  display_name: string;
  internal_id: string;
  billing_customer_id: string | null;
  box_folder_id: string | null;
  created: boolean;
};

async function provisionDealer(
  admin: any,
  cfg: {
    name: string;
    dealer_id: string;
    group_id: string | null;
    account_type: string;
    subscription_billed_to: "dealer" | "group";
    labels_billed_to: "dealer" | "group";
  },
): Promise<DealerProvisioned> {
  const existing = await admin
    .from("dealers")
    .select("id, name, dealer_id, internal_id, billing_customer_id, box_folder_id")
    .eq("test_account", true)
    .eq("name", cfg.name)
    .maybeSingle();

  if (existing.data?.id) {
    await recordEnv(admin, "dealer", existing.data.id, null, null, cfg.name);
    return {
      entity_id: existing.data.id,
      dealer_id: existing.data.dealer_id ?? cfg.dealer_id,
      display_name: cfg.name,
      internal_id: String(existing.data.internal_id ?? ""),
      billing_customer_id: existing.data.billing_customer_id ?? null,
      box_folder_id: existing.data.box_folder_id ?? null,
      created: false,
    };
  }

  const internalId = String(Math.floor(Math.random() * 9_000_000) + 1_000_000);
  const insertResp = await admin
    .from("dealers")
    .insert({
      name: cfg.name,
      dealer_id: cfg.dealer_id,
      internal_id: internalId,
      inventory_dealer_id: cfg.dealer_id,
      account_type: cfg.account_type,
      group_id: cfg.group_id,
      subscription_billed_to: cfg.subscription_billed_to,
      labels_billed_to: cfg.labels_billed_to,
      active: true,
      test_account: true,
      country: "US",
      address: "277 E 4600 S",
      city: "Murray",
      state: "UT",
      zip: "84107",
      phone: "8014159435",
      primary_contact: "QA Test Contact",
      primary_contact_email: "qa-contact@test.dealeraddendums.com",
      shipping_name: cfg.name,
      shipping_address: "277 E 4600 S",
      shipping_city: "Murray",
      shipping_state: "UT",
      shipping_zip: "84107",
      shipping_country: "US",
      shipping_phone: "8014159435",
    })
    .select("id, internal_id, billing_customer_id, box_folder_id")
    .single();

  if (insertResp.error) {
    throw new Error(`Dealer create failed (${cfg.name}): ${insertResp.error.message}`);
  }
  const dealerId = insertResp.data.id as string;
  await recordEnv(admin, "dealer", dealerId, null, null, cfg.name);
  return {
    entity_id: dealerId,
    dealer_id: cfg.dealer_id,
    display_name: cfg.name,
    internal_id: String(insertResp.data.internal_id ?? internalId),
    billing_customer_id: insertResp.data.billing_customer_id ?? null,
    box_folder_id: insertResp.data.box_folder_id ?? null,
    created: true,
  };
}

async function provisionUser(
  admin: any,
  cfg: { email: string; role: string; dealer_id: string | null; group_id: string | null; full_name: string },
): Promise<{ entity_id: string; role: string; email: string; display_name: string; created: boolean }> {
  // Check qa_test_environment first -- the auth user lookup by email
  // isn't directly available via the typed client.
  const envRow = await admin
    .from("qa_test_environment")
    .select("entity_id")
    .eq("entity_type", "user")
    .eq("email", cfg.email)
    .maybeSingle();
  if (envRow.data?.entity_id) {
    return { entity_id: envRow.data.entity_id, role: cfg.role, email: cfg.email, display_name: cfg.full_name, created: false };
  }

  const { data: authData, error: authErr } = await admin.auth.admin.createUser({
    email: cfg.email,
    password: QA_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: cfg.full_name },
    app_metadata:  { role: cfg.role },
  });
  if (authErr) {
    // Idempotency: if the user already exists in auth but we lost the env row,
    // Allan would teardown and retry. Surface the error for visibility.
    throw new Error(`Auth user create failed (${cfg.email}): ${authErr.message}`);
  }

  const userId = authData.user.id as string;
  const profileResp = await admin
    .from("profiles")
    .upsert({
      id:           userId,
      email:        cfg.email,
      full_name:    cfg.full_name,
      role:         cfg.role,
      dealer_id:    cfg.dealer_id,
      group_id:     cfg.group_id,
      test_account: true,
    }, { onConflict: "id" });

  if (profileResp.error) {
    void admin.auth.admin.deleteUser(userId);
    throw new Error(`Profile upsert failed (${cfg.email}): ${profileResp.error.message}`);
  }

  await recordEnv(admin, "user", userId, cfg.role, cfg.email, cfg.full_name);
  return { entity_id: userId, role: cfg.role, email: cfg.email, display_name: cfg.full_name, created: true };
}

async function recordEnv(
  admin: any,
  entity_type: EntityType,
  entity_id: string,
  role: string | null,
  email: string | null,
  display_name: string,
): Promise<void> {
  await admin
    .from("qa_test_environment")
    .upsert({ entity_type, entity_id, role, email, display_name }, { onConflict: "entity_type,entity_id" });
}
