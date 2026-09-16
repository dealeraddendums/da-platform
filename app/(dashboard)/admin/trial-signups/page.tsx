// Admin surface for the self-serve trial signup gate (migration 154):
// the review queue on top, then the recent decision log so overnight abuse
// volume is visible at a glance.

import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import { PageHeader } from "@/components/PageHeader";
import StuckLeadsPanel from "@/components/StuckLeadsPanel";
import TrialSignupsQueue, { type QueueRow } from "@/components/TrialSignupsQueue";
import EnrichmentBadge, { type EnrichRow } from "@/components/EnrichmentBadge";
import DecisionBadge from "@/components/DecisionBadge";
import { getStuckLeads } from "@/lib/pending-signups";

export const dynamic = "force-dynamic";
export const metadata = { title: "Trial Signups — DA Platform" };

interface Row {
  id: string;
  created_at: string;
  email: string;
  contact_name: string | null;
  dealership: string | null;
  zip: string | null;
  source_ip: string | null;
  decision: string;
  decision_reason: string | null;
  ai_verdict: string | null;
  ai_confidence: number | null;
  ai_reasons: string[] | null;
  review_token: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  dealer_id: string | null;
  dealer_uuid: string | null;
  // Also selected by `*` and needed by the review card:
  phone: string | null;
  account_kind: string | null;
  ai_model: string | null;
}

export default async function TrialSignupsPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login?next=/admin/trial-signups");

  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ role: string }>(admin, session, "role");
  const role = profile?.role
    ?? ((session.user.app_metadata as Record<string, unknown>)?.role as string | undefined);
  if (role !== "super_admin") redirect("/dashboard");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rows } = await (admin as any)
    .from("self_serve_signups")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200) as { data: Row[] | null };
  const all = rows ?? [];
  const pending = all.filter((r) => r.decision === "pending_review");

  // Bucket B: signups awaiting Layer 0 email confirmation. These rows live in
  // the marketing app's project, so this is an HTTP read that fails soft — the
  // page still renders the review queue if marketing is unreachable.
  const stuck = await getStuckLeads();

  // Enrichment findings for the dealers these signups provisioned (migration
  // 158). Read-only: this page decides nothing about enrichment, it just saves
  // an operator a trip into HubSpot to see whether the Google lookup landed.
  // Tolerates the table not existing yet (deploy ordering) — `?? []`.
  const dealerUuids = all.map((r) => r.dealer_uuid).filter((v): v is string => !!v);
  let enrichBy: Record<string, EnrichRow> = {};
  if (dealerUuids.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: enrichRows } = await (admin as any)
      .from("dealer_enrichment")
      .select("dealer_uuid, enrichment_status, enrichment_name_score, matched_name, notes")
      .in("dealer_uuid", dealerUuids) as { data: EnrichRow[] | null };
    enrichBy = Object.fromEntries((enrichRows ?? []).map((e) => [e.dealer_uuid, e]));
  }
  const enrichCounts = Object.values(enrichBy)
    .reduce<Record<string, number>>((acc, e) => { acc[e.enrichment_status] = (acc[e.enrichment_status] ?? 0) + 1; return acc; }, {});

  // Last 7 days by decision, for the "is this happening a lot?" question.
  const weekAgo = Date.now() - 7 * 86400_000;
  const counts = all.filter((r) => new Date(r.created_at).getTime() > weekAgo)
    .reduce<Record<string, number>>((acc, r) => { acc[r.decision] = (acc[r.decision] ?? 0) + 1; return acc; }, {});

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " PT";

  return (
    <div>
      <PageHeader
        title="Trial Signups"
        subtitle="Public self-serve signups: what the gate decided and why. Sign-ups are accepted 5 AM–9 PM Pacific; anything the AI doesn't clear lands here for review."
      />

      <div className="card mb-4" style={{ padding: 16 }}>
        <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}>
          Last 7 days
        </p>
        {Object.keys(counts).length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>No signup attempts in the last 7 days.</p>
        ) : (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([d, n]) => (
              <span key={d} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <DecisionBadge decision={d} /><strong style={{ fontSize: 14 }}>{n}</strong>
              </span>
            ))}
          </div>
        )}
      </div>

      <StuckLeadsPanel
        leads={stuck.leads}
        available={stuck.available}
        stuckAfterHours={stuck.stuckAfterHours}
      />

      {Object.keys(enrichCounts).length > 0 && (
        <div className="card mb-4" style={{ padding: 16 }}>
          <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}>
            Address/phone enrichment — signups shown below
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            {Object.entries(enrichCounts).sort((a, b) => b[1] - a[1]).map(([st, n]) => (
              <span key={st} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <EnrichmentBadge row={{ dealer_uuid: "", enrichment_status: st, enrichment_name_score: null, matched_name: null, notes: null }} />
                <strong style={{ fontSize: 14 }}>{n}</strong>
              </span>
            ))}
          </div>
          <p className="text-xs" style={{ color: "var(--text-muted)", marginTop: 8 }}>
            Looked up in Google Places after provisioning. <strong>Needs review</strong> = the address matched the signup ZIP but the listing carries a different name (a bought or renamed store looks exactly like this) — verify before anyone calls. Only <strong>confirmed</strong> findings fill a dealer&apos;s blank address/phone.
          </p>
        </div>
      )}

      {/* The two lists are a client component: clicking a row opens the review
          card in a modal over the queue (Back / Next / Close) instead of
          navigating away to the standalone token page, which was a dead end. */}
      <TrialSignupsQueue rows={all as QueueRow[]} enrichBy={enrichBy} />

    </div>
  );
}
