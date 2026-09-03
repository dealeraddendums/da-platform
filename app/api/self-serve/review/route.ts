// Approve or deny a held self-serve trial signup.
//
// POST-only and token-gated. POST (not GET) so an email link scanner cannot
// provision a dealership by prefetching — the emailed link opens a review page,
// and the page's buttons POST here. The token is single-use: it is cleared in
// the same UPDATE that records the decision, with a `review_token = token`
// predicate, so two concurrent clicks can't both win and a re-click after a
// decision does nothing.

import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { provisionSelfServe, stampProvisionResult, type SelfServeInput } from "@/lib/self-serve-provision";
import { getJwtClaims } from "@/lib/auth";

interface GateRow {
  id: string;
  email: string;
  contact_name: string | null;
  dealership: string | null;
  phone: string | null;
  zip: string | null;
  account_kind: "single" | "group";
  group_name: string | null;
  attribution: Record<string, string | null> | null;
  decision: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json().catch(() => null) as { token?: string; action?: "approve" | "deny" } | null;
  const token = body?.token?.trim();
  const action = body?.action;
  if (!token || (action !== "approve" && action !== "deny")) {
    return NextResponse.json({ error: "token and action (approve|deny) are required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row } = await (admin as any)
    .from("self_serve_signups")
    .select("id, email, contact_name, dealership, phone, zip, account_kind, group_name, attribution, decision")
    .eq("review_token", token)
    .maybeSingle() as { data: GateRow | null };

  if (!row) {
    // Either a bad token or one already consumed by a prior decision.
    return NextResponse.json({ error: "This review link is no longer valid — the signup has already been decided." }, { status: 410 });
  }
  if (row.decision !== "pending_review") {
    return NextResponse.json({ error: `Already ${row.decision}.` }, { status: 409 });
  }

  // Who acted. A signed-in super_admin is recorded by email; the token itself
  // is the authorisation, so an unauthenticated click from the support inbox
  // still works and is recorded as such.
  let actor = "review-link";
  try {
    const claims = await getJwtClaims();
    if (claims?.email) actor = claims.email;
  } catch { /* no session — token-only, fine */ }

  // Claim the row: consume the token and record the decision atomically. The
  // review_token predicate is what makes this single-use under concurrency.
  const nextDecision = action === "approve" ? "approved" : "denied";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: claimed } = await (admin as any)
    .from("self_serve_signups")
    .update({
      decision: nextDecision, review_token: null,
      reviewed_at: new Date().toISOString(), reviewed_by: actor,
      decision_reason: `${nextDecision} by ${actor}`,
    })
    .eq("review_token", token)
    .eq("decision", "pending_review")
    .select("id")
    .maybeSingle() as { data: { id: string } | null };

  if (!claimed) {
    return NextResponse.json({ error: "This signup was just decided by someone else." }, { status: 409 });
  }

  if (action === "deny") {
    console.log(`[self-serve] DENIED by ${actor} email=${row.email} dealership="${row.dealership}"`);
    return NextResponse.json({ ok: true, action: "denied" });
  }

  // Approve → provision through the SAME path an automatic signup uses.
  const input: SelfServeInput = {
    name: row.contact_name ?? row.email,
    email: row.email,
    dealership: row.dealership ?? row.email,
    phone: row.phone,
    zip: row.zip,
    accountKind: row.account_kind === "group" ? "group" : "single",
    groupName: row.group_name ?? row.dealership ?? row.email,
    attribution: row.attribution ?? null,
  };
  try {
    const result = await provisionSelfServe(input);
    await stampProvisionResult(row.id, result);
    console.log(`[self-serve] APPROVED+PROVISIONED by ${actor} email=${row.email} dealership="${row.dealership}"`);
    return NextResponse.json({ ok: true, action: "approved", result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    console.error("[self-serve] approval provisioning failed:", msg);
    // Put it back in the queue so the approval isn't silently lost.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).from("self_serve_signups")
      .update({ decision: "pending_review", decision_reason: `approval failed: ${msg}`, review_token: token })
      .eq("id", row.id);
    return NextResponse.json({ error: `Provisioning failed: ${msg}` }, { status: 500 });
  }
}
