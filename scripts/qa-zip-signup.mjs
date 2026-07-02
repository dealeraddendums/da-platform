// One-off: verify zip flows through the self-serve signup into dealers.zip,
// then fully clean up the throwaway trial dealer (HubSpot company, auth user,
// sample data, dealer row). Run on the da-platform box with shared env sourced.
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const KEY = process.env.SELF_SERVE_API_KEY;
const HS = process.env.HUBSPOT_PRIVATE_APP_TOKEN;

const ts = Date.now();
const email = `ziptest+${ts}@example.com`;
const dealership = `ZIP Verify Test ${ts}`;
const ZIP = "99501";

let dealerUuid = null, dealerTextId = null, hsCompany = null, authUserId = null;

try {
  const res = await fetch("http://127.0.0.1:3000/api/self-serve/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": KEY },
    body: JSON.stringify({ name: "ZIP Verify", email, dealership, phone: "555-000-0000", zip: ZIP, accountKind: "single" }),
  });
  const j = await res.json().catch(() => ({}));
  console.log("signup HTTP", res.status, JSON.stringify(j));

  const { data: d } = await admin.from("dealers")
    .select("id, dealer_id, name, zip, hubspot_company_id, account_type")
    .eq("primary_contact_email", email).maybeSingle();
  if (d) {
    dealerUuid = d.id; dealerTextId = d.dealer_id; hsCompany = d.hubspot_company_id;
    console.log(`DEALER created: ${d.name} (${d.dealer_id}, ${d.account_type}) — dealers.zip = ${JSON.stringify(d.zip)}`);
    console.log(d.zip === ZIP ? "✓ PASS — zip provisioned end-to-end" : "✗ FAIL — zip did not match");
  } else {
    console.log("✗ dealer not found by email — signup likely failed");
  }
  const { data: p } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
  authUserId = p?.id ?? null;
} catch (e) {
  console.log("ERROR:", e.message);
} finally {
  // ---- full cleanup ----
  try { if (hsCompany && HS) { const r = await fetch("https://api.hubapi.com/crm/v3/objects/companies/" + hsCompany, { method: "DELETE", headers: { Authorization: "Bearer " + HS } }); console.log("[cleanup] hubspot company:", r.status); } } catch (e) { console.log("[cleanup] hs err", e.message); }
  try { if (authUserId) { const r = await admin.auth.admin.deleteUser(authUserId); console.log("[cleanup] auth user:", r.error ? r.error.message : "deleted (cascades profile)"); } } catch (e) { console.log("[cleanup] user err", e.message); }
  if (dealerTextId) {
    for (const tbl of ["dealer_vehicles", "addendum_library", "dealer_settings", "pending_prints"]) {
      try { await admin.from(tbl).delete().eq("dealer_id", dealerTextId); } catch { /* table may not key on dealer_id / no rows */ }
    }
  }
  try { await admin.from("profiles").delete().eq("email", email); } catch { /* likely already cascaded */ }
  if (dealerUuid) { const r = await admin.from("dealers").delete().eq("id", dealerUuid); console.log("[cleanup] dealer row:", r.error ? r.error.message : "deleted"); }
  console.log("[cleanup] done");
}
process.exit(0);
