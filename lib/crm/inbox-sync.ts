// DA-CRM Inbox sync, per mailbox and folder (Inbox, Sent Items):
//   • delta — walk Graph's delta chain from the saved deltaLink (or, the first
//     time, from `since`), fetch each new message by id and ingest it. Used by
//     the 90-day backfill script and the 10-minute fallback cron.
//   • subscriptions — create the change-notification subscriptions, renew
//     them before they expire (mail subscriptions last < 3 days), recreate any
//     Graph has dropped. Used by the renewal cron and the setup script.
// Fetches run 4 at a time — well inside Graph's per-mailbox limits.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createAdminSupabaseClient } from "@/lib/db";
import { createSubscription, getMessage, graphUserOf, initialDeltaUrl, renewSubscription, walkDelta, GraphError, type GraphFolder } from "./graph";
import { ingestGraphMessage, loadInboxContext, MAILBOX_COLS, type InboxContext, type Mailbox } from "./inbox-ingest";

export const FOLDERS: GraphFolder[] = ["inbox", "sentitems"];
const TOKEN_COL: Record<GraphFolder, string> = { inbox: "delta_token_inbox", sentitems: "delta_token_sent" };
const SUB_COL: Record<GraphFolder, [string, string]> = {
  inbox: ["graph_subscription_id", "subscription_expires_at"],
  sentitems: ["graph_subscription_id_sent", "subscription_sent_expires_at"],
};
/** Renew anything expiring within this window (the cron runs at most every 48h; subscriptions last ~70h). */
const RENEW_WITHIN_MS = 30 * 3_600_000;

export type FolderSyncStats = { mailbox: string; folder: GraphFolder; seen: number; stored: number; duplicate: number; skipped: number; failed: number; error?: string };

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/** Fetch + ingest one message id; never throws (counts instead). */
export async function ingestById(admin: any, mailbox: Mailbox, id: string, folder: GraphFolder, ctx: InboxContext, stats?: FolderSyncStats): Promise<void> {
  try {
    const { data: known } = await admin.from("crm_emails").select("id").eq("graph_message_id", id).maybeSingle();
    if (known) { if (stats) stats.duplicate++; return; }
    const msg = await getMessage(graphUserOf(mailbox), id);
    if (!msg) { if (stats) stats.skipped++; return; }
    const r = await ingestGraphMessage(admin, mailbox, msg, { folder, ctx });
    if (stats) stats[r.status === "stored" ? "stored" : r.status === "duplicate" ? "duplicate" : "skipped"]++;
  } catch (e) {
    if (stats) stats.failed++;
    console.error(`[crm-inbox] ${mailbox.address}/${folder} ${id.slice(0, 24)}…:`, e instanceof Error ? e.message : e);
  }
}

/**
 * Delta sync one folder. With no saved deltaLink (or `restart`) it starts at
 * `since`; the new deltaLink is saved at the end, so an interrupted run just
 * re-walks (ingest is idempotent).
 */
export async function syncFolder(admin: any, mailbox: Mailbox, folder: GraphFolder, opts: { since?: Date; restart?: boolean; ctx?: InboxContext } = {}): Promise<FolderSyncStats> {
  const ctx = opts.ctx ?? await loadInboxContext(admin);
  const stats: FolderSyncStats = { mailbox: mailbox.address, folder, seen: 0, stored: 0, duplicate: 0, skipped: 0, failed: 0 };
  const { data: row } = await admin.from("crm_mailboxes").select(TOKEN_COL[folder]).eq("id", mailbox.id).single();
  const saved: string | null = opts.restart ? null : row?.[TOKEN_COL[folder]] ?? null;
  try {
    const start = saved ?? initialDeltaUrl(graphUserOf(mailbox), folder, opts.since ?? new Date(Date.now() - 2 * 86_400_000));
    let link: string;
    try {
      link = await walkDelta(start, async (ids) => { stats.seen += ids.length; await pool(ids, 4, (id) => ingestById(admin, mailbox, id, folder, ctx, stats)); });
    } catch (e) {
      // An expired / invalid deltaLink (410 syncStateNotFound…) → start over from `since`.
      if (saved && e instanceof GraphError && (e.status === 410 || /syncState|resync/i.test(e.code ?? ""))) {
        link = await walkDelta(initialDeltaUrl(graphUserOf(mailbox), folder, opts.since ?? new Date(Date.now() - 7 * 86_400_000)),
          async (ids) => { stats.seen += ids.length; await pool(ids, 4, (id) => ingestById(admin, mailbox, id, folder, ctx, stats)); });
      } else throw e;
    }
    await admin.from("crm_mailboxes").update({ [TOKEN_COL[folder]]: link, last_synced_at: new Date().toISOString(), last_error: null }).eq("id", mailbox.id);
  } catch (e) {
    stats.error = e instanceof Error ? e.message : String(e);
    await admin.from("crm_mailboxes").update({ last_error: `${folder}: ${stats.error}`.slice(0, 500) }).eq("id", mailbox.id);
  }
  return stats;
}

export async function activeMailboxes(admin: any, only?: string): Promise<Mailbox[]> {
  let q = admin.from("crm_mailboxes").select(MAILBOX_COLS).eq("active", true).order("address");
  if (only) q = q.eq("address", only.toLowerCase());
  const { data, error } = await q;
  if (error) throw new Error(`crm_mailboxes: ${error.message}`);
  return (data ?? []) as Mailbox[];
}

/** Fallback cron: delta every active mailbox, both folders. */
export async function syncAllMailboxes(admin: any = createAdminSupabaseClient()): Promise<FolderSyncStats[]> {
  const ctx = await loadInboxContext(admin, true);
  const out: FolderSyncStats[] = [];
  for (const mb of await activeMailboxes(admin)) for (const f of FOLDERS) out.push(await syncFolder(admin, mb, f, { ctx }));
  return out;
}

export type SubscriptionAction = { mailbox: string; folder: GraphFolder; action: "ok" | "renewed" | "created" | "would_create" | "would_renew" | "error"; expires?: string; error?: string };

/** Renew subscriptions expiring within 30h; create missing / dropped ones. `apply: false` = report only. */
export async function ensureSubscriptions(admin: any = createAdminSupabaseClient(), opts: { apply?: boolean; only?: string } = {}): Promise<SubscriptionAction[]> {
  const apply = opts.apply !== false;
  const out: SubscriptionAction[] = [];
  const { data: rows } = await admin.from("crm_mailboxes").select("*").eq("active", true).order("address");
  for (const mb of (rows ?? []).filter((r: any) => !opts.only || r.address === opts.only.toLowerCase())) {
    for (const folder of FOLDERS) {
      const [idCol, expCol] = SUB_COL[folder];
      const subId: string | null = mb[idCol];
      const exp = mb[expCol] ? new Date(mb[expCol]).getTime() : 0;
      try {
        if (subId && exp - Date.now() > RENEW_WITHIN_MS) { out.push({ mailbox: mb.address, folder, action: "ok", expires: mb[expCol] }); continue; }
        if (!apply) { out.push({ mailbox: mb.address, folder, action: subId ? "would_renew" : "would_create" }); continue; }
        let sub = subId ? await renewSubscription(subId) : null;
        const action: SubscriptionAction["action"] = sub ? "renewed" : "created";
        if (!sub) sub = await createSubscription(graphUserOf(mb), folder);
        await admin.from("crm_mailboxes").update({ [idCol]: sub.id, [expCol]: sub.expirationDateTime }).eq("id", mb.id);
        out.push({ mailbox: mb.address, folder, action, expires: sub.expirationDateTime });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        out.push({ mailbox: mb.address, folder, action: "error", error: msg });
        await admin.from("crm_mailboxes").update({ last_error: `subscription ${folder}: ${msg}`.slice(0, 500) }).eq("id", mb.id);
      }
    }
  }
  return out;
}

/** Which mailbox + folder a change-notification subscription belongs to. */
export async function mailboxForSubscription(admin: any, subscriptionId: string): Promise<{ mailbox: Mailbox; folder: GraphFolder } | null> {
  // Graph subscription ids are GUIDs; anything else never reaches the filter string.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subscriptionId)) return null;
  const { data } = await admin.from("crm_mailboxes").select(`${MAILBOX_COLS}, graph_subscription_id, graph_subscription_id_sent`)
    .or(`graph_subscription_id.eq.${subscriptionId},graph_subscription_id_sent.eq.${subscriptionId}`).maybeSingle();
  if (!data || !data.active) return null;
  return { mailbox: data as Mailbox, folder: data.graph_subscription_id === subscriptionId ? "inbox" : "sentitems" };
}
