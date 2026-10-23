/* Nightly Supabase → S3 backup, as its own process (lib/backup-supabase.ts).
 *
 *   npx tsx scripts/backup-supabase.ts [YYYY-MM-DD]
 *
 * Normally started by POST /api/cron/backup-supabase, which detaches it from the
 * PM2 worker (so deploys and memory restarts don't kill it) under an flock on
 * /tmp/da-backup-supabase.lock, logging to /var/log/da-platform/backup-supabase.log.
 * Run by hand under the same lock:
 *   flock -n /tmp/da-backup-supabase.lock npx tsx scripts/backup-supabase.ts
 * Exit code 0 only when every table backed up (status ok).
 */
import { loadScriptEnv } from "./crm-env";
import { runBackup } from "../lib/backup-supabase";

loadScriptEnv();

const date = process.argv[2];
if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error(`usage: backup-supabase.ts [YYYY-MM-DD] (got "${date}")`);
  process.exit(2);
}

runBackup(date).then(
  (r) => process.exit(r.status === "ok" ? 0 : 1),
  (e) => { console.error("[backup-supabase] run crashed:", e instanceof Error ? e.stack ?? e.message : e); process.exit(1); },
);
