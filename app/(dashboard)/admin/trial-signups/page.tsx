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
  dealer_id: string | null;
  dealer_uuid: string | null;
}

/** Enrichment finding for a provisioned signup (migration 158), joined by dealer_uuid. */
interface EnrichRow {
  dealer_uuid: string;
  enrichment_status: string;
  enrichment_name_score: number | null;
  matched_name: string | null;
  notes: string | null;
}

const ENRICH_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  confirmed:    { bg: "#e8f5e9", fg: "#2e7d32", label: "Confirmed" },
  needs_review: { bg: "#fff8e1", fg: "#7a5c00", label: "Needs review" },
  no_match:     { bg: "#fafafa", fg: "#616161", label: "No match" },
  error:        { bg: "#ffebee", fg: "#b71c1c", label: "Lookup failed" },
};

/** Google-Places enrichment outcome for this signup's dealer, if any. */
function EnrichBadge({ row }: { row: EnrichRow | undefined }) {
  if (!row) return <span style={{ color: "var(--text-muted)", fontSize: 11 }}>—</span>;
  const s = ENRICH_STYLE[row.enrichment_status]
    ?? { bg: "#fafafa", fg: "#616161", label: row.enrichment_status };
  const score = row.enrichment_name_score != null ? Number(row.enrichment_name_score).toFixed(2) : null;
  return (
    <span
      title={[row.matched_name && `Google: ${row.matched_name}`, score && `name score ${score}`, row.notes]
        .filter(Boolean).join(" · ")}
      style={{ background: s.bg, color: s.fg, fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 3, whiteSpace: "nowrap" }}
    >
      {s.label}{score && row.enrichment_status !== "no_match" ? ` ${score}` : ""}
    </span>
  );
}

const DECISION_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  provisioned:        { bg: "#e8f5e9", fg: "#2e7d32", label: "Provisioned" },
  approved:           { bg: "#e8f5e9", fg: "#2e7d32", label: "Approved" },
  pending_review:     { bg: "#fff8e1", fg: "#7a5c00", label: "Pending review" },
  denied:             { bg: "#fafafa", fg: "#616161", label: "Denied" },
  blocked_afterhours: { bg: "#ede7f6", fg: "#4527a0", label: "After hours" },
  blocked_ratelimit:  { bg: "#ffebee", fg: "#b71c1c", label: "Rate limited" },
  blocked_domain:     { bg: "#ffebee", fg: "#b71c1c", label: "Bad domain" },
  blocked_invalid:    { bg: "#ffebee", fg: "#b71c1c", label: "Invalid" },
};

function Badge({ decision }: { decision: string }) {
  const s = DECISION_STYLE[decision] ?? { bg: "#fafafa", fg: "#616161", label: decision };
  return (
    <span style={{ background: s.bg, color: s.fg, fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 3, whiteSpace: "nowrap" }}>
      {s.label}
    </span>
  );
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
                <Badge decision={d} /><strong style={{ fontSize: 14 }}>{n}</strong>
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
                <EnrichBadge row={{ dealer_uuid: "", enrichment_status: st, enrichment_name_score: null, matched_name: null, notes: null }} />
                <strong style={{ fontSize: 14 }}>{n}</strong>
              </span>
            ))}
          </div>
          <p className="text-xs" style={{ color: "var(--text-muted)", marginTop: 8 }}>
            Looked up in Google Places after provisioning. <strong>Needs review</strong> = the address matched the signup ZIP but the listing carries a different name (a bought or renamed store looks exactly like this) — verify before anyone calls. Only <strong>confirmed</strong> findings fill a dealer&apos;s blank address/phone.
          </p>
        </div>
      )}

      {pending.length > 0 && (
        <div className="card mb-4" style={{ padding: 0, overflow: "hidden" }}>
          <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)", background: "#fff8e1" }}>
            <strong style={{ fontSize: 13, color: "#7a5c00" }}>{pending.length} signup{pending.length !== 1 ? "s" : ""} awaiting review</strong>
          </div>
          {pending.map((r) => (
            <div key={r.id} className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{r.dealership ?? r.email}</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {r.contact_name} · {r.email} · ZIP {r.zip || "—"} · {fmt(r.created_at)}
                </div>
                <div style={{ fontSize: 12, marginTop: 3 }}>
                  AI: <strong>{r.ai_verdict}</strong>{r.ai_confidence != null && ` (${r.ai_confidence})`}
                  {Array.isArray(r.ai_reasons) && r.ai_reasons.length > 0 && ` — ${r.ai_reasons.join("; ")}`}
                </div>
              </div>
              {r.review_token && (
                <Link href={`/self-serve-review/${r.review_token}`} className="btn btn-primary text-xs" style={{ height: 30, display: "inline-flex", alignItems: "center", padding: "0 14px" }}>
                  Review
                </Link>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
          <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}>
            Decision log — most recent 200
          </p>
        </div>
        {all.length === 0 ? (
          <p className="px-4 py-6 text-sm" style={{ color: "var(--text-muted)" }}>Nothing logged yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", textAlign: "left" }}>
                {["When (PT)", "Decision", "Dealership", "Email", "AI", "Enrichment", "Why", "IP"].map((h) => (
                  <th key={h} className="px-3 py-2" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {all.map((r) => (
                <tr key={r.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td className="px-3 py-2" style={{ whiteSpace: "nowrap", color: "var(--text-secondary)" }}>{fmt(r.created_at)}</td>
                  <td className="px-3 py-2"><Badge decision={r.decision} /></td>
                  <td className="px-3 py-2">{r.dealership ?? "—"}{r.dealer_id && <span style={{ color: "var(--text-muted)", fontSize: 11 }}> · {r.dealer_id}</span>}</td>
                  <td className="px-3 py-2" style={{ fontSize: 12 }}>{r.email}</td>
                  <td className="px-3 py-2" style={{ fontSize: 12 }}>{r.ai_verdict ?? "—"}{r.ai_confidence != null && ` ${r.ai_confidence}`}</td>
                  <td className="px-3 py-2"><EnrichBadge row={r.dealer_uuid ? enrichBy[r.dealer_uuid] : undefined} /></td>
                  <td className="px-3 py-2" style={{ fontSize: 12, color: "var(--text-muted)", maxWidth: 260 }}>{r.decision_reason ?? "—"}</td>
                  <td className="px-3 py-2" style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{r.source_ip ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
