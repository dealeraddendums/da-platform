// Nightly product-description check — flags any product description that holds
// 4.0-style junk again (escaped tag source, literal or double-encoded entities,
// <div>/table blocks the printer drops…), as defined by JUNK_FLAGS in
// lib/product-description-clean.ts. Ordinary editor HTML is not junk.
//
// The 2026-10-23 cleanup brought the fleet to zero; the 4.0 Sync and the editor
// paste handler both clean on the way in. Anything that shows up here came in
// some other way (an import path we missed, a direct API write) — the email
// names the rows so the path can be found.
//
// Read-only on the product tables. State + run lock live in admin_settings:
//   product_description_check  { at, total, byTable, flagged: { "<table>:<id>": since } }
// First run records the baseline without emailing (same rule as feed-health);
// after that, support@ + allan@ get one email listing only NEWLY flagged rows.
// Kicked daily from /api/cron/harvest-vin-trims; also POST /api/cron/description-check.

import { createAdminSupabaseClient } from "@/lib/db";
import { descriptionJunk } from "@/lib/product-description-clean";
import { sendMandrillEmail } from "@/lib/mandrill";

const STATE_KEY = "product_description_check";
const LOCK_KEY = "product_description_check_lock";
const LOCK_TTL_MS = 30 * 60_000;
const PAGE = 1000;               // PostgREST max-rows clamp — page with .range()
const MAX_TRACKED = 5000;        // cap the state blob; a flood is reported by count

type Table = "addendum_library" | "group_options" | "vehicle_options";
const TABLES: { table: Table; owner: string }[] = [
  { table: "addendum_library", owner: "dealer_id" },
  { table: "group_options", owner: "group_id" },
  { table: "vehicle_options", owner: "dealer_id" },
];

export type FlaggedRow = { table: Table; id: string; owner: string; option_name: string; flags: string[] };
export type DescriptionCheckResult = { total: number; byTable: Record<string, number>; newly: number; emailed: boolean; firstRun: boolean };

/** Every row whose description has junk. Only rows containing "<" or "&" can. */
export async function scanDescriptions(): Promise<FlaggedRow[]> {
  const admin = createAdminSupabaseClient();
  const out: FlaggedRow[] = [];
  for (const { table, owner } of TABLES) {
    for (let from = 0; ; from += PAGE) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (admin as any)
        .from(table)
        .select(`id, ${owner}, option_name, description`)
        .or("description.like.*<*,description.like.*&*")
        .order("id")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`${table}: ${error.message}`);
      const rows = (data ?? []) as Record<string, string | null>[];
      for (const r of rows) {
        const flags = descriptionJunk(r.description);
        if (flags.length) out.push({ table, id: String(r.id), owner: String(r[owner] ?? ""), option_name: String(r.option_name ?? ""), flags });
      }
      if (rows.length < PAGE) break;
    }
  }
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function runDescriptionCheck(): Promise<DescriptionCheckResult | { skipped: "locked" }> {
  const admin = createAdminSupabaseClient();
  const { data: lock } = await admin.from("admin_settings").select("value, updated_at").eq("key", LOCK_KEY).maybeSingle();
  if (lock?.value === "1" && lock.updated_at && Date.now() - new Date(lock.updated_at).getTime() < LOCK_TTL_MS) return { skipped: "locked" };
  await admin.from("admin_settings").upsert({ key: LOCK_KEY, value: "1", updated_at: new Date().toISOString() }, { onConflict: "key" });
  try {
    const rows = await scanDescriptions();
    const { data: st } = await admin.from("admin_settings").select("value").eq("key", STATE_KEY).maybeSingle();
    let prev: { flagged?: Record<string, string> } = {};
    try { prev = st?.value ? JSON.parse(st.value) : {}; } catch { prev = {}; }
    const firstRun = !st?.value;
    const prevFlagged = prev.flagged ?? {};

    const now = new Date().toISOString();
    const flagged: Record<string, string> = {};
    const newly: FlaggedRow[] = [];
    for (const r of rows) {
      const key = `${r.table}:${r.id}`;
      if (prevFlagged[key]) flagged[key] = prevFlagged[key];
      else { newly.push(r); if (Object.keys(flagged).length < MAX_TRACKED) flagged[key] = now; }
    }
    const byTable: Record<string, number> = {};
    for (const r of rows) byTable[r.table] = (byTable[r.table] ?? 0) + 1;

    let emailed = false;
    if (!firstRun && newly.length) {
      const list = newly.slice(0, 25).map((r) =>
        `<tr><td>${r.table}</td><td>${escapeHtml(r.owner)}</td><td>${escapeHtml(r.option_name.replace(/<[^>]+>/g, "")).slice(0, 80)}</td><td>${r.flags.join(", ")}</td><td style="font-family:monospace;font-size:11px">${r.id}</td></tr>`).join("");
      await sendMandrillEmail({
        subject: `Product descriptions: ${newly.length} new with 4.0-style HTML junk`,
        from_email: "noreply@dealeraddendums.com",
        from_name: "DealerAddendums",
        to: [{ email: "support@dealeraddendums.com", type: "to" }, { email: "allan@dealeraddendums.com", type: "to" }],
        html: `<p>The nightly description check found <b>${newly.length}</b> product description(s) that newly contain escaped tags, literal entities or blocks the printer drops (${rows.length} flagged in total).</p>
<p>Fix in place: open the product and Save — the editor stores clean HTML. Fleet fix: <code>scripts/description-cleanup-apply.ts</code>. Something is writing these without cleaning them — the rows below show where.</p>
<table border="1" cellpadding="4" style="border-collapse:collapse;font-size:12px"><tr><th>Table</th><th>Dealer / group</th><th>Product</th><th>Problem</th><th>Row id</th></tr>${list}</table>
${newly.length > 25 ? `<p>…and ${newly.length - 25} more.</p>` : ""}`,
      });
      emailed = true;
    }
    await admin.from("admin_settings").upsert(
      { key: STATE_KEY, value: JSON.stringify({ at: now, total: rows.length, byTable, flagged }), updated_at: now },
      { onConflict: "key" },
    );
    return { total: rows.length, byTable, newly: newly.length, emailed, firstRun };
  } finally {
    await admin.from("admin_settings").upsert({ key: LOCK_KEY, value: "0", updated_at: new Date().toISOString() }, { onConflict: "key" });
  }
}
