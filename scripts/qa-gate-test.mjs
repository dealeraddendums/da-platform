// Throwaway end-to-end test of the V5.0 access gate (app/(dashboard)/layout.tsx).
// Creates a non-migrated dealer + dealer_admin auth user DIRECTLY in Supabase
// (service-role → no app-level HubSpot/email side effects), mints real
// @supabase/ssr auth cookies, and curls the live app to observe the redirect.
// Then flips the dealer to migrated, then to ss_-native, to prove those pass.
// Deletes every row it created in a finally block.
//
// Run on the box from inside the current release dir:
//   set -a; . /var/www/da-platform/shared/.env.production; set +a
//   node scripts/qa-gate-test.mjs
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP = process.env.QA_APP_ORIGIN || "http://127.0.0.1:3000";
if (!URL || !ANON || !SERVICE) { console.error("Missing Supabase env"); process.exit(1); }

const admin = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });

const ts = Date.now().toString();
const email = `qa-gate-${ts}@example.com`;
const password = `Qa!${ts}xZ`;
const dealerTextId = `qagatetest${ts}`;   // NOT ss_ → not V5-native
const dealerName = `QA Gate Test ${ts}`;

let userId = null;
let dealerUuid = null;

// Build a Cookie header for the given session using @supabase/ssr's OWN encoder,
// so the cookie names/format exactly match what the server reads.
async function cookieHeaderFor(session) {
  const jar = {};
  const sb = createServerClient(URL, ANON, {
    cookies: {
      getAll: () => Object.entries(jar).map(([name, value]) => ({ name, value })),
      setAll: (arr) => arr.forEach(({ name, value }) => { jar[name] = value; }),
    },
  });
  await sb.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  return Object.entries(jar).map(([n, v]) => `${n}=${v}`).join("; ");
}

async function hitDashboard(cookie) {
  const res = await fetch(`${APP}/dashboard`, { headers: { cookie }, redirect: "manual" });
  return { status: res.status, location: res.headers.get("location") };
}

async function run() {
  // 1. Throwaway auth user (password login; the handle_new_user trigger also
  //    seeds a minimal profile row which we upsert below).
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { full_name: dealerName },
    app_metadata: { role: "dealer_admin" },
  });
  if (cErr || !created?.user) throw new Error(`createUser failed: ${cErr?.message}`);
  userId = created.user.id;

  // 2. Non-migrated dealer (migration_status null, dealer_id not ss_).
  const { data: d, error: dErr } = await admin.from("dealers").insert({
    dealer_id: dealerTextId,
    inventory_dealer_id: dealerTextId,
    name: dealerName,
    internal_id: ts,
    account_type: "Trial",
    migration_status: null,
  }).select("id, dealer_id, migration_status").single();
  if (dErr) throw new Error(`dealer insert failed: ${dErr.message}`);
  dealerUuid = d.id;

  // 3. Link the profile → dealer_admin of the new dealer (onConflict id per the
  //    codebase rule; the trigger already inserted the id row).
  const { error: pErr } = await admin.from("profiles").upsert(
    { id: userId, email, full_name: dealerName, role: "dealer_admin", dealer_id: dealerTextId, group_id: null },
    { onConflict: "id" },
  );
  if (pErr) throw new Error(`profile upsert failed: ${pErr.message}`);

  // 4. Real login → session → cookies.
  const anon = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data: signIn, error: sErr } = await anon.auth.signInWithPassword({ email, password });
  if (sErr || !signIn?.session) throw new Error(`signIn failed: ${sErr?.message}`);
  const cookie = await cookieHeaderFor(signIn.session);

  const results = [];

  // CASE A — non-migrated, non-ss_  → EXPECT redirect to /not-migrated
  let r = await hitDashboard(cookie);
  results.push({ case: "non-migrated dealer", ...r,
    pass: r.status >= 300 && r.status < 400 && (r.location || "").includes("/not-migrated") });

  // CASE B — flip to migration_status='migrated' → EXPECT no /not-migrated redirect
  await admin.from("dealers").update({ migration_status: "migrated" }).eq("id", dealerUuid);
  r = await hitDashboard(cookie);
  results.push({ case: "migrated dealer", ...r,
    pass: !(r.location || "").includes("/not-migrated") });

  // CASE C — V5-native (ss_ dealer_id), not migrated → EXPECT no /not-migrated redirect
  const ssId = `ss_qa${ts}`;
  await admin.from("dealers").update({ migration_status: null, dealer_id: ssId, inventory_dealer_id: ssId }).eq("id", dealerUuid);
  await admin.from("profiles").update({ dealer_id: ssId }).eq("id", userId);
  r = await hitDashboard(cookie);
  results.push({ case: "V5-native (ss_) dealer", ...r,
    pass: !(r.location || "").includes("/not-migrated") });

  console.log("\n=== V5.0 access-gate test results (app=" + APP + ") ===");
  for (const x of results) {
    console.log(`${x.pass ? "PASS" : "FAIL"}  ${x.case.padEnd(24)} → HTTP ${x.status}${x.location ? "  Location: " + x.location : ""}`);
  }
  const allPass = results.every(x => x.pass);
  console.log(`\nOVERALL: ${allPass ? "PASS ✅" : "FAIL ❌"}`);
  return allPass;
}

let ok = false;
try {
  ok = await run();
} catch (e) {
  console.error("ERROR:", e.message);
} finally {
  // Cleanup — remove every row we created.
  try { if (dealerUuid) await admin.from("dealers").delete().eq("id", dealerUuid); } catch {}
  try { if (userId) await admin.from("profiles").delete().eq("id", userId); } catch {}
  try { if (userId) await admin.auth.admin.deleteUser(userId); } catch {}
  console.log("[cleanup] removed test dealer + profile + auth user");
}
process.exit(ok ? 0 : 1);
