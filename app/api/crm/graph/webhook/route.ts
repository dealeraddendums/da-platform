import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { validClientState } from "@/lib/crm/graph";
import { loadInboxContext } from "@/lib/crm/inbox-ingest";
import { ingestById, mailboxForSubscription } from "@/lib/crm/inbox-sync";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * POST /api/crm/graph/webhook — Microsoft Graph change notifications for the
 * DA-CRM Inbox (new messages in each mailbox's Inbox / Sent Items).
 *
 * • Subscription validation: Graph POSTs ?validationToken=… and needs the
 *   token echoed as text/plain within 10 s.
 * • Notifications: each item's clientState must equal MS_GRAPH_WEBHOOK_SECRET
 *   (constant-time) and its subscriptionId must be one of ours; anything else
 *   is dropped. We answer 202 at once (Graph wants < 3 s) and fetch + ingest
 *   the messages in the background; the 10-minute delta sync catches any we
 *   miss.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const token = req.nextUrl.searchParams.get("validationToken");
  if (token !== null) {
    return new NextResponse(token.slice(0, 1024), { status: 200, headers: { "Content-Type": "text/plain" } });
  }

  const body: any = await req.json().catch(() => null);
  const items: any[] = Array.isArray(body?.value) ? body.value.slice(0, 200) : [];
  const valid = items.filter((n) => validClientState(n?.clientState) && typeof n?.subscriptionId === "string" && typeof n?.resourceData?.id === "string");
  if (items.length && !valid.length) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (valid.length) {
    handleNotifications(valid).catch((e) => console.error("[crm-graph-webhook]", e instanceof Error ? e.message : e));
  }
  return new NextResponse(null, { status: 202 });
}

async function handleNotifications(items: any[]): Promise<void> {
  const admin = createAdminSupabaseClient() as any;
  const ctx = await loadInboxContext(admin);
  for (const n of items) {
    if (n.lifecycleEvent) {
      // reauthorizationRequired / subscriptionRemoved / missed → the renewal
      // cron recreates and the delta sync backfills; just note it.
      console.log(`[crm-graph-webhook] lifecycle ${n.lifecycleEvent} for ${n.subscriptionId}`);
      continue;
    }
    const where = await mailboxForSubscription(admin, n.subscriptionId);
    if (!where) continue;
    await ingestById(admin, where.mailbox, n.resourceData.id, where.folder, ctx);
  }
}
