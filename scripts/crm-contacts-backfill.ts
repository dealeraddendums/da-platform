/**
 * crm-contacts-backfill.ts — platform users (+ dealer / group record contacts) → crm_contacts, then re-run
 * contact matching on calls, Inbox threads and email activities. DRY RUN unless --apply. Idempotent: it is
 * the same reconcile the nightly crm-contacts-reconcile job runs.
 *
 *   npm run crm:contacts-backfill            dry run
 *   npm run crm:contacts-backfill -- --apply
 */
import { createClient } from "@supabase/supabase-js";
import { loadScriptEnv } from "./crm-env";
import { reconcileContacts } from "../lib/crm/contacts-sync";

loadScriptEnv();
const APPLY = process.argv.includes("--apply");

async function main() {
  const admin: any = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const r = await reconcileContacts(admin, { apply: APPLY });
  console.log(JSON.stringify(r, null, 2));
  console.log(APPLY ? "applied" : "dry run — nothing written (add --apply)");
}

main().catch((e) => { console.error(e); process.exit(1); });
