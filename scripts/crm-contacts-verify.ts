/* npm run test:crm-contacts — runs scripts/sql/crm-contacts-verify.sql against the database through the
   Supabase Management API. The SQL always aborts at the end, so its fixtures roll back.
   Token: SUPABASE_ACCESS_TOKEN, else (macOS) the Supabase CLI's keychain entry. Never printed.
   --unit runs only the TypeScript checks (no database).
   --with-migration prepends supabase/migrations/188_crm_contacts_from_users.sql (test before applying it). */
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { loadScriptEnv } from "./crm-env";
import { orderedAddresses, pickByAddresses, pickContact } from "../lib/crm/contact-rematch";
import { driftOf } from "../lib/crm/contacts-sync";

loadScriptEnv();
const PROJECT = process.env.SUPABASE_PROJECT_REF ?? "byouefbebqgffhtfdggu";

function token(): string {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN;
  if (process.platform === "darwin") {
    const raw = execSync('security find-generic-password -s "Supabase CLI" -a supabase -w', { encoding: "utf8" }).trim();
    return raw.startsWith("go-keyring-base64:") ? Buffer.from(raw.slice(18), "base64").toString("utf8") : raw;
  }
  throw new Error("Set SUPABASE_ACCESS_TOKEN");
}

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
  const root = path.resolve(__dirname, "..");
  let sql = fs.readFileSync(path.join(root, "scripts/sql/crm-contacts-verify.sql"), "utf8");
  if (process.argv.includes("--with-migration")) sql = fs.readFileSync(path.join(root, "supabase/migrations/188_crm_contacts_from_users.sql"), "utf8") + "\n" + sql;
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: "POST", headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: `begin;\n${sql}` }),
  });
  const body = await res.text();
  const m = body.match(/CRM_CONTACTS_TEST ([^"\\]*)/);
  if (!m) { console.error(`Unexpected response (${res.status}): ${body.slice(0, 500)}`); process.exit(1); }
  console.log(m[1]);
  if (!m[1].startsWith("all passed")) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
