/* npm run test:crm-contacts — runs scripts/sql/crm-contacts-verify.sql against the database through the
   Supabase Management API. The SQL always aborts at the end, so its fixtures roll back.
   Token: see scripts/sql-test.ts.
   --unit runs only the TypeScript checks (no database).
   --with-migration prepends supabase/migrations/188_crm_contacts_from_users.sql (test before applying it). */
import { loadScriptEnv } from "./crm-env";
import { runSqlTest } from "./sql-test";
import { orderedAddresses, pickByAddresses, pickContact } from "../lib/crm/contact-rematch";
import { driftOf } from "../lib/crm/contacts-sync";

loadScriptEnv();

let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`}`);
}

function unit() {
  const h = (id: string, company_id: string, updated_at: string) => ({ id, company_id, updated_at });
  eq("one hit", pickContact([h("a", "c1", "2026-01-01")], null)?.id, "a");
  eq("two companies, no company given → ambiguous", pickContact([h("a", "c1", "2026-01-01"), h("b", "c2", "2026-02-01")], null), null);
  eq("two companies, company given → that one", pickContact([h("a", "c1", "2026-01-01"), h("b", "c2", "2026-02-01")], "c1")?.id, "a");
  eq("same company → newest", pickContact([h("a", "c1", "2026-01-01"), h("b", "c1", "2026-02-01")], null)?.id, "b");
  eq("company given, no hit there → none", pickContact([h("a", "c1", "2026-01-01")], "c9"), null);
  eq("addresses: from first, DA dropped, lowercased, unique",
    orderedAddresses([{ address: "cc@x.com", role: "cc" }, { address: "support@dealeraddendums.com", role: "to" }, { address: "Dana@X.com", role: "from" }, { address: "dana@x.com", role: "to" }]),
    ["dana@x.com", "cc@x.com"]);
  const byEmail = new Map([["cc@x.com", [h("k", "c1", "2026-01-01")]]]);
  eq("sender unknown → falls through to cc", pickByAddresses(["dana@x.com", "cc@x.com"], byEmail, null)?.id, "k");
  eq("drift: changes only", driftOf({ users: { unchanged: 3000, created: 2, moved: 1, skipped: 9, conflict: 1 }, records: { covered: 5, created: 1 } }),
    { total: 4, users: { created: 2, moved: 1 }, records: 1 });
  eq("drift: none", driftOf({ users: { unchanged: 1 }, records: { covered: 1 } }).total, 0);
}

async function main() {
  unit();
  if (fail) { console.log(`\n${fail} unit check(s) failed`); process.exit(1); }
  if (process.argv.includes("--unit")) return;
  const ok = await runSqlTest("scripts/sql/crm-contacts-verify.sql", "CRM_CONTACTS_TEST",
    process.argv.includes("--with-migration") ? ["supabase/migrations/188_crm_contacts_from_users.sql"] : []);
  if (!ok) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
