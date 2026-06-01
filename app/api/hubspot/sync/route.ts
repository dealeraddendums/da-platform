// POST /api/hubspot/sync — manual on-demand HubSpot push for a dealer + its users.
//
// super_admin only (Allan 2026-05-31). Resolves the target dealer from
// the caller's ghost-context cookie if present, otherwise 403 — no
// dealer_admin / dealer_user / group_admin path. HubSpot is DA's
// internal CRM; we never expose this surface to dealer logins.
//
// Reuses syncDealerToHubspot + syncProfileToHubspot from lib/sync-hubspot.ts
// (the same functions that fire on event-driven create/update). Each step
// emits an SSE `data:` line so the client can render live progress.
//
// Wire format (one event per line):
//   { step: "start",   message: "Syncing {dealerName}…" }
//   { step: "company", status: "running" }
//   { step: "company", status: "done" | "error", hubspotId?: string }
//   { step: "contact", email, status: "running" }
//   { step: "contact", email, status: "done" | "error", hubspotId?: string }
//   { step: "done",    okCount: number, errorCount: number }

import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { verifyGhostToken } from "@/lib/ghost";
import { hubspotConfigured } from "@/lib/hubspot";
import { syncDealerToHubspot, syncProfileToHubspot } from "@/lib/sync-hubspot";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  // Nginx in front of PM2 buffers `text/event-stream` by default. The
  // X-Accel-Buffering header turns that off so each `enqueue` reaches
  // the browser as soon as it's flushed by Node.
  "X-Accel-Buffering": "no",
  Connection: "keep-alive",
};

export async function POST(req: NextRequest): Promise<Response> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  // super_admin only — server-side enforcement of the same gate the tab
  // hides with. dealer_admin / dealer_user / group_admin all 403.
  if (claims.role !== "super_admin") {
    return new Response(JSON.stringify({ error: "Forbidden — HubSpot sync is super_admin only" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!hubspotConfigured()) {
    return new Response(JSON.stringify({ error: "HubSpot not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Resolve target dealer from the ghost-context cookie. super_admin
  // sessions outside ghost mode don't have a dealer context, so they
  // can't trigger a sync from /profile — the tab is hidden in that
  // case (no dealer = no dealer-scoped tabs).
  const ghostCtx = verifyGhostToken(cookies().get("da_ghost_token")?.value ?? "");
  const ghostDealerTextId = ghostCtx?.dealer_text_id ?? null;
  if (!ghostDealerTextId) {
    return new Response(JSON.stringify({ error: "No dealer in context (ghost mode required)" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const admin = createAdminSupabaseClient();
  const { data: dealer } = await admin
    .from("dealers")
    .select("id, dealer_id, name, hubspot_company_id")
    .eq("dealer_id", ghostDealerTextId)
    .maybeSingle<{ id: string; dealer_id: string; name: string | null; hubspot_company_id: string | null }>();

  if (!dealer) {
    return new Response(JSON.stringify({ error: "Dealer not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Active users for this dealer — TEXT slug join (profiles.dealer_id is
  // the slug, not the UUID; see /lib/sync-hubspot.ts profileProps).
  const { data: profiles } = await admin
    .from("profiles")
    .select("id, email, hubspot_contact_id")
    .eq("dealer_id", dealer.dealer_id)
    .eq("active", true);
  const userList = profiles ?? [];

  // ── Build the SSE stream ───────────────────────────────────────────────────
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      let okCount = 0;
      let errorCount = 0;

      send({ step: "start", message: `Syncing ${dealer.name ?? dealer.dealer_id}…`, dealerId: dealer.id, userCount: userList.length });

      // 1. Company
      send({ step: "company", status: "running", name: dealer.name });
      try {
        await syncDealerToHubspot(dealer.id);
        // syncDealerToHubspot swallows its errors into hubspot_sync_errors
        // and returns void. Confirm success by reading the id back —
        // same pattern as syncDealerReliable's read-back loop.
        const { data: after } = await admin
          .from("dealers")
          .select("hubspot_company_id")
          .eq("id", dealer.id)
          .maybeSingle<{ hubspot_company_id: string | null }>();
        if (after?.hubspot_company_id) {
          send({ step: "company", status: "done", hubspotId: after.hubspot_company_id });
          okCount++;
        } else {
          send({ step: "company", status: "error", message: "hubspot_company_id not written — check hubspot_sync_errors" });
          errorCount++;
        }
      } catch (err) {
        send({ step: "company", status: "error", message: err instanceof Error ? err.message : String(err) });
        errorCount++;
      }

      // 2. Contacts
      for (const p of userList) {
        send({ step: "contact", email: p.email, status: "running" });
        try {
          await syncProfileToHubspot(p.id);
          const { data: after } = await admin
            .from("profiles")
            .select("hubspot_contact_id")
            .eq("id", p.id)
            .maybeSingle<{ hubspot_contact_id: string | null }>();
          if (after?.hubspot_contact_id) {
            send({ step: "contact", email: p.email, status: "done", hubspotId: after.hubspot_contact_id });
            okCount++;
          } else {
            send({ step: "contact", email: p.email, status: "error", message: "hubspot_contact_id not written" });
            errorCount++;
          }
        } catch (err) {
          send({ step: "contact", email: p.email, status: "error", message: err instanceof Error ? err.message : String(err) });
          errorCount++;
        }
      }

      send({ step: "done", okCount, errorCount });
      controller.close();
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
