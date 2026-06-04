#!/usr/bin/env node
/**
 * backfill-self-serve-roles.mjs
 *
 * Fixes self-serve provisioning users created before the createAdminUserWithInvite
 * `{ onConflict: "id" }` fix: the handle_new_user trigger inserted their profile
 * with the default role 'dealer_user' (ON CONFLICT DO NOTHING), and the upsert
 * didn't update it — so the account's admin can't manage billing.
 *
 * Targets ONLY the original admin of each self-serve entity (matched by the
 * dealer/group's primary_contact_email), so legitimately-invited dealer_user
 * employees are never touched.
 *   - self-serve single dealers (dealer_id LIKE 'ss_%')      → admin → dealer_admin
 *   - self-serve groups (account_type 'Trial', has primary_contact_email) → admin → group_admin
 *
 * Run on the box (reads .env.production):
 *   node --env-file=.env.production scripts/backfill-self-serve-roles.mjs            # dry run
 *   node --env-file=.env.production scripts/backfill-self-serve-roles.mjs --apply    # write
 */

import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const log = (...a) => console.log(...a);

async function fixOne(email, dealerId, groupId, wantRole, label) {
  if (!email) return { skipped: true };
  let q = sb.from("profiles").select("id, email, role, dealer_id, group_id").ilike("email", email);
  q = dealerId ? q.eq("dealer_id", dealerId) : q.eq("group_id", groupId);
  const { data: rows, error } = await q;
  if (error) { log(`  ! ${label} ${email}: lookup error ${error.message}`); return { error: true }; }
  if (!rows || rows.length === 0) { log(`  - ${label} ${email}: no matching profile`); return { missing: true }; }
  let changed = 0;
  for (const p of rows) {
    if (p.role === wantRole) { log(`  ✓ ${label} ${email}: already ${wantRole}`); continue; }
    log(`  → ${label} ${email}: ${p.role} → ${wantRole}${APPLY ? "" : "  (dry-run)"}`);
    if (APPLY) {
      const { error: upErr } = await sb.from("profiles").update({ role: wantRole }).eq("id", p.id);
      if (upErr) { log(`    ! update failed: ${upErr.message}`); continue; }
    }
    changed++;
  }
  return { changed };
}

let totalChanged = 0;

log(`=== self-serve single dealers (ss_*) → dealer_admin ${APPLY ? "[APPLY]" : "[dry-run]"} ===`);
const { data: dealers } = await sb
  .from("dealers")
  .select("dealer_id, name, primary_contact_email")
  .like("dealer_id", "ss_%");
for (const d of dealers ?? []) {
  const r = await fixOne(d.primary_contact_email, d.dealer_id, null, "dealer_admin", d.name);
  totalChanged += r.changed ?? 0;
}

log(`=== self-serve groups (Trial) → group_admin ===`);
const { data: groups } = await sb
  .from("groups")
  .select("id, name, primary_contact_email, account_type")
  .eq("account_type", "Trial");
for (const g of groups ?? []) {
  const r = await fixOne(g.primary_contact_email, null, g.id, "group_admin", g.name);
  totalChanged += r.changed ?? 0;
}

log(`\n${APPLY ? "Updated" : "Would update"} ${totalChanged} profile role(s).`);
if (!APPLY) log("Re-run with --apply to write.");
process.exit(0);
