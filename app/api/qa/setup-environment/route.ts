import { NextRequest, NextResponse } from "next/server";
import { getServerProfile } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

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
    .select("id, name")
    .eq("test_account", true)
    .eq("name", groupName)
    .maybeSingle();
  let groupId: string | null = existingGroupResp.data?.id ?? null;
  let groupCreated = false;

  if (!groupId) {
    const groupInsertResp = await (admin as any)
      .from("groups")
      .insert({
        name: groupName,
        contact_name: "QA Test Contact",
        contact_email: "qa-group@test.dealeraddendums.com",
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
      .select("id")
      .single();
    if (groupInsertResp.error) {
      console.error("[qa/setup-environment] group insert failed:", groupInsertResp.error);
      return NextResponse.json({ error: `Group create failed: ${groupInsertResp.error.message}` }, { status: 500 });
    }
    groupId = groupInsertResp.data.id as string;
    groupCreated = true;
  }
  out.push({ entity_type: "group", entity_id: groupId!, role: null, email: null, display_name: groupName, created: groupCreated });
  await recordEnv(admin, "group", groupId!, null, null, groupName);

  // ---- 2. QA Test Dealer A (standalone, sub-manual, billed to self) -------
  const dealerA = await provisionDealer(admin, {
    name: "QA Test Dealer A",
    dealer_id: "qa-test-dealer-a",
    group_id: null,
    account_type: "sub-manual",
    subscription_billed_to: "dealer",
    labels_billed_to: "dealer",
  });
  out.push({ entity_type: "dealer", ...dealerA });

  // ---- 3. QA Test Dealer B (in group, sub-auto-web, billed to group) ------
  const dealerB = await provisionDealer(admin, {
    name: "QA Test Dealer B",
    dealer_id: "qa-test-dealer-b",
    group_id: groupId!,
    account_type: "sub-auto-web",
    subscription_billed_to: "group",
    labels_billed_to: "group",
  });
  out.push({ entity_type: "dealer", ...dealerB });

  // ---- 4. Test user accounts ----------------------------------------------
  const users = [
    { email: "qa-dealer-admin@test.dealeraddendums.com",       role: "dealer_admin",      dealer_id: dealerA.entity_id, group_id: null,    full_name: "QA Dealer Admin" },
    { email: "qa-dealer-user@test.dealeraddendums.com",        role: "dealer_user",       dealer_id: dealerA.entity_id, group_id: null,    full_name: "QA Dealer User" },
    { email: "qa-dealer-restricted@test.dealeraddendums.com",  role: "dealer_restricted", dealer_id: dealerA.entity_id, group_id: null,    full_name: "QA Dealer Restricted" },
    { email: "qa-group-admin@test.dealeraddendums.com",        role: "group_admin",       dealer_id: null,              group_id: groupId, full_name: "QA Group Admin" },
  ];

  for (const u of users) {
    const provisioned = await provisionUser(admin, u);
    out.push({ entity_type: "user", ...provisioned });
  }

  return NextResponse.json({ success: true, entities: out, password: QA_PASSWORD });
}

// ---- helpers --------------------------------------------------------------

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
): Promise<{ entity_id: string; role: string | null; email: string | null; display_name: string; created: boolean }> {
  const existing = await admin
    .from("dealers")
    .select("id, name")
    .eq("test_account", true)
    .eq("name", cfg.name)
    .maybeSingle();

  if (existing.data?.id) {
    await recordEnv(admin, "dealer", existing.data.id, null, null, cfg.name);
    return { entity_id: existing.data.id, role: null, email: null, display_name: cfg.name, created: false };
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
    .select("id")
    .single();

  if (insertResp.error) {
    throw new Error(`Dealer create failed (${cfg.name}): ${insertResp.error.message}`);
  }
  const dealerId = insertResp.data.id as string;
  await recordEnv(admin, "dealer", dealerId, null, null, cfg.name);
  return { entity_id: dealerId, role: null, email: null, display_name: cfg.name, created: true };
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
    // try to recover by listing users -- in practice Allan would just teardown
    // and retry. Surface the error for visibility.
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
