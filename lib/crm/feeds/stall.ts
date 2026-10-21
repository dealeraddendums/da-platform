// Daily feed-order stall job (POST /api/cron/crm-feed-stalls, business days
// only — weekends and US holidays are skipped, and ages count business days):
//   awaiting_dealer_approval > 2 bd → Dealer follow-up on the thread (once) · > 5 → task "Call approver"
//   awaiting_supplier > turnaround + 2 → Supplier follow-up (once)        · > turnaround + 5 → task "Call supplier"
//   needs_info > 3 bd with its task still open → task escalated to the feed_support group
// Also moves assigned orders to done once the first feed import lands.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createAdminSupabaseClient } from "@/lib/db";
import { businessDaysBetween, isBusinessDay, ptDate } from "../business-days";
import { stallActions } from "./state";
import { checkImport, createOrderTask, feedSupportAssignee, nudge, recordEvent, supplierSettings, SYSTEM } from "./orders";

export type StallRunResult = { skipped?: string; checked: number; followups: number; tasks: number; escalated: number; done: number; errors: number };

export async function runStallJob(admin: any = createAdminSupabaseClient(), now = new Date(), opts: { force?: boolean } = {}): Promise<StallRunResult> {
  const out: StallRunResult = { checked: 0, followups: 0, tasks: 0, escalated: 0, done: 0, errors: 0 };
  if (!opts.force && !isBusinessDay(ptDate(now))) return { ...out, skipped: "not a business day" };
  const { data: orders } = await admin.from("crm_feed_orders").select("*").in("status", ["needs_info", "awaiting_dealer_approval", "awaiting_supplier", "assigned"]).limit(2000);
  for (const o of orders ?? []) {
    out.checked++;
    try {
      if (o.status === "assigned") { if (await checkImport(admin, o)) out.done++; continue; }
      const settings = await supplierSettings(admin, o.supplier_company_id);
      const { data: tasks } = await admin.from("crm_tasks").select("kind, assigned_capability").eq("feed_order_id", o.id).eq("status", "open");
      const kinds = new Set((tasks ?? []).map((t: any) => t.kind));
      const age = businessDaysBetween(o.stall_timer_started_at, now);
      const actions = stallActions(o, age, settings?.typical_turnaround_days ?? 2, {
        callApproverTask: kinds.has("feed_call_approver"), callSupplierTask: kinds.has("feed_call_supplier"),
        needsInfoTaskOpen: kinds.has("feed_get_info"), escalated: (tasks ?? []).some((t: any) => t.kind === "feed_get_info" && t.assigned_capability === "feed_support"),
      });
      for (const a of actions) {
        if (a === "dealer_followup" || a === "supplier_followup") {
          try { await nudge(admin, o.id, a === "dealer_followup" ? "dealer" : "supplier", SYSTEM, false); out.followups++; }
          catch (e) {
            await createOrderTask(admin, o, { kind: a === "dealer_followup" ? "feed_call_approver" : "feed_call_supplier", title: `Follow-up couldn't send — ${a === "dealer_followup" ? "call the approver" : "call the supplier"}`, description: e instanceof Error ? e.message : String(e) }, SYSTEM);
            out.tasks++;
          }
        } else if (a === "task_call_approver") {
          await createOrderTask(admin, o, { kind: "feed_call_approver", title: `Call approver ${o.approver_name ?? ""}${o.approver_phone ? ` (${o.approver_phone})` : ""} — no approval after ${age} business days`.replace(/\s+/g, " ") }, SYSTEM); out.tasks++;
        } else if (a === "task_call_supplier") {
          await createOrderTask(admin, o, { kind: "feed_call_supplier", title: `Call the supplier — no Feed ID after ${age} business days` }, SYSTEM); out.tasks++;
        } else if (a === "escalate_needs_info") {
          const to = await feedSupportAssignee(admin);
          await admin.from("crm_tasks").update({ assigned_capability: "feed_support", ...(to ? { assigned_staff_id: to } : {}), title: "Escalated: get feed provider/approver — call the GM" })
            .eq("feed_order_id", o.id).eq("kind", "feed_get_info").eq("status", "open");
          await recordEvent(admin, o, "review", { note: `Needs info for ${age} business days — escalated to feed support` }, SYSTEM);
          out.escalated++;
        }
      }
    } catch (e) {
      out.errors++;
      console.error(`[crm-feed-stalls] order ${o.id}:`, e instanceof Error ? e.message : e);
    }
  }
  return out;
}
