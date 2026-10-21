/**
 * crm-graph-setup.ts — Microsoft Graph wiring for the DA-CRM Inbox. DRY RUN unless --apply.
 * Reads MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET / MS_GRAPH_WEBHOOK_SECRET from
 * /var/www/da-platform/.env.local (scripts/crm-env.ts); never prints them.
 *
 *   npm run crm:graph-setup -- --check        token works; each crm_mailboxes row is readable
 *                                             (and, with the access policy, nothing else is)
 *   npm run crm:graph-setup -- --subscribe    create / renew the Inbox + Sent Items change
 *                                             subscriptions (same logic as the renewal cron)
 *   … add --apply to write; --mailbox feeds@dealeraddendums.com limits to one mailbox;
 *   --outside someone@dealeraddendums.com probes a mailbox that should be BLOCKED.
 */
import { createClient } from "@supabase/supabase-js";
import { graphConfigured, graphToken, graphWebhookUrl, probeMailbox } from "../lib/crm/graph";
import { crmEnv } from "../lib/crm/env";
import { ensureSubscriptions } from "../lib/crm/inbox-sync";
import { loadScriptEnv } from "./crm-env";

loadScriptEnv();

/* eslint-disable @typescript-eslint/no-explicit-any */
const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const APPLY = has("--apply");
const ONLY = opt("--mailbox");

async function main() {
  if (!graphConfigured()) throw new Error("MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET not set");
  const admin: any = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

  if (has("--check")) {
    await graphToken();
    console.log("token: ok (client credentials)");
    console.log(`webhook: ${graphWebhookUrl()} · MS_GRAPH_WEBHOOK_SECRET ${crmEnv("MS_GRAPH_WEBHOOK_SECRET") ? "set" : "MISSING"}`);
    const { data: mbs } = await admin.from("crm_mailboxes").select("address, active").order("address");
    for (const m of (mbs ?? []).filter((x: any) => !ONLY || x.address === ONLY.toLowerCase())) {
      const r = await probeMailbox(m.address);
      console.log(`${m.address}${m.active ? "" : " (inactive)"}: ${r.ok ? "readable — " : "NOT readable — "}${r.detail}`);
      if (!r.ok) process.exitCode = 1;
    }
    const outside = opt("--outside");
    if (outside) {
      const r = await probeMailbox(outside);
      console.log(`${outside}: ${r.ok ? "READABLE — the access policy is not limiting the app" : "blocked (good) — " + r.detail}`);
      if (r.ok) process.exitCode = 1;
    }
  }

  if (has("--subscribe")) {
    for (const r of await ensureSubscriptions(admin, { apply: APPLY, only: ONLY })) {
      console.log(`${r.mailbox} ${r.folder}: ${r.action}${r.expires ? ` (expires ${r.expires})` : ""}${r.error ? ` — ${r.error}` : ""}`);
      if (r.action === "error") process.exitCode = 1;
    }
    if (!APPLY) console.log("dry run — nothing written (add --apply)");
  }
  if (!has("--check") && !has("--subscribe")) console.log("Pick --check and/or --subscribe (add --apply to write).");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
