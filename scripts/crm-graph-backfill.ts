/**
 * crm-graph-backfill.ts — DA-CRM Inbox backfill. DRY RUN unless --apply.
 * Walks Graph delta for each mailbox's Inbox and Sent Items from --days back
 * (default 90), fetches every message and ingests it (idempotent on the
 * immutable message id — safe to re-run), then saves the deltaLink the
 * 10-minute sync continues from.
 *
 *   npm run crm:graph-backfill                                  dry run: count messages per folder
 *   npm run crm:graph-backfill -- --apply                       backfill every active mailbox
 *   npm run crm:graph-backfill -- --mailbox feeds@dealeraddendums.com --days 30 --apply
 *   … --restart ignores a saved deltaLink and walks from --days again.
 */
import { createClient } from "@supabase/supabase-js";
import { graphConfigured, initialDeltaUrl, walkDelta } from "../lib/crm/graph";
import { activeMailboxes, FOLDERS, syncFolder } from "../lib/crm/inbox-sync";
import { loadInboxContext } from "../lib/crm/inbox-ingest";
import { loadScriptEnv } from "./crm-env";

loadScriptEnv();

/* eslint-disable @typescript-eslint/no-explicit-any */
const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const APPLY = has("--apply");
const DAYS = Math.min(3650, Math.max(1, Number(opt("--days")) || 90));

async function main() {
  if (!graphConfigured()) throw new Error("MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET not set");
  const admin: any = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const since = new Date(Date.now() - DAYS * 86_400_000);
  const mailboxes = await activeMailboxes(admin, opt("--mailbox"));
  if (!mailboxes.length) throw new Error("no active mailbox matches");
  const ctx = await loadInboxContext(admin, true);

  for (const mb of mailboxes) {
    for (const folder of FOLDERS) {
      if (!APPLY) {
        let n = 0;
        await walkDelta(initialDeltaUrl(mb.address, folder, since), async (ids) => { n += ids.length; });
        console.log(`[dry-run] ${mb.address} ${folder}: ${n} messages in the last ${DAYS} days`);
        continue;
      }
      const t0 = Date.now();
      const s = await syncFolder(admin, mb, folder, { since, restart: has("--restart"), ctx });
      console.log(`${mb.address} ${folder}: seen ${s.seen} · stored ${s.stored} · already had ${s.duplicate} · skipped ${s.skipped} · failed ${s.failed} · ${Math.round((Date.now() - t0) / 1000)}s${s.error ? ` · ERROR ${s.error}` : ""}`);
      if (s.error || s.failed) process.exitCode = 1;
    }
  }
  if (!APPLY) console.log("dry run — nothing written (add --apply)");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
