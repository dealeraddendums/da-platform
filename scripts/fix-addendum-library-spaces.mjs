// scripts/fix-addendum-library-spaces.mjs
//
// ONE-TIME, idempotent: reset product-rule `spaces` from 2 -> 0 across the
// whole addendum_library table. The ETL (options.ts) and the platform create
// route both used to hardcode spaces=2 on every product, overriding the column
// DEFAULT 0 and forcing 2 separator spaces on every rendered product. Both code
// paths are now fixed (spaces=0); this corrects the existing data.
//
// "Apply spaces always" is unchanged — we only stop the unintended 2. A product
// with no intentional spacing should render 0 spaces. The renderer derives
// spacing from addendum_library.spaces via lib/options-engine.ts. NOTE: there is
// no `spaces` column on vehicle_options — addendum_library is the source.
//
// Backs up EVERY row to be changed (full row) to a timestamped JSON first, so
// the change is fully reversible (restore = set spaces=2 for those ids).
//
// Run ON the da-platform box (needs SUPABASE_* from env):
//   node --env-file=.env.production scripts/fix-addendum-library-spaces.mjs --dry-run
//   node --env-file=.env.production scripts/fix-addendum-library-spaces.mjs

import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const DRY = process.argv.includes("--dry-run");
const BACKUP_DIR = process.env.SPACES_BACKUP_DIR || "/var/www/da-platform/shared";
const PAGE = 1000;

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function headCount(value) {
  const { count, error } = await sb
    .from("addendum_library")
    .select("id", { count: "exact", head: true })
    .eq("spaces", value);
  if (error) throw new Error(`count(spaces=${value}) failed: ${error.message}`);
  return count ?? 0;
}

async function main() {
  console.log(`[fix-spaces] mode: ${DRY ? "DRY-RUN" : "LIVE"}`);

  const before2 = await headCount(2);
  const before0 = await headCount(0);
  console.log(`[fix-spaces] before: spaces=2 -> ${before2}, spaces=0 -> ${before0}`);

  if (before2 === 0) {
    console.log("[fix-spaces] nothing to do (no spaces=2 rows). Exiting.");
    return;
  }

  // Paginate-fetch all spaces=2 rows (1000-row select cap) for the backup.
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("addendum_library")
      .select("*")
      .eq("spaces", 2)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`fetch page @${from} failed: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  console.log(`[fix-spaces] fetched ${rows.length} rows for backup`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${BACKUP_DIR}/addendum-library-spaces-backup-${stamp}.json`;
  writeFileSync(backupPath, JSON.stringify({ when: new Date().toISOString(), criterion: "spaces=2", count: rows.length, rows }, null, 2));
  console.log(`[fix-spaces] backup written: ${backupPath}`);

  if (DRY) {
    console.log("[fix-spaces] DRY-RUN — no UPDATE performed.");
    return;
  }

  // Server-side bulk update (not subject to the 1000-row SELECT cap).
  const { error: upErr } = await sb
    .from("addendum_library")
    .update({ spaces: 0 })
    .eq("spaces", 2);
  if (upErr) throw new Error(`UPDATE failed: ${upErr.message}`);

  const after2 = await headCount(2);
  const after0 = await headCount(0);
  console.log(`[fix-spaces] after:  spaces=2 -> ${after2}, spaces=0 -> ${after0}`);
  console.log(`[fix-spaces] DONE. updated ${before2 - after2} rows (2 -> 0).`);
}

main().catch((e) => { console.error("[fix-spaces] FATAL:", e.message); process.exit(1); });
