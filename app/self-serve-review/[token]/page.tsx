// Scanner-proof review page for a held self-serve trial signup.
//
// The notification email links HERE (a GET that only reads), and the Approve /
// Deny buttons POST to /api/self-serve/review. That split is deliberate: an
// email link scanner prefetching a one-click approve URL would provision a
// dealership by itself — the same class of problem that made the migration
// invites code-based rather than link-based.
//
// The token in the URL is the authorisation, so support can act straight from
// the inbox without a session; a signed-in super_admin is recorded by email.
// That is why this page has NO session gate and must keep none — narrowing it
// would break acting on a signup from the support inbox.
//
// The card body is the SAME component the admin modal renders
// (components/SelfServeReviewCard), so approve/deny exists in one place. Only
// the chrome differs: this standalone view has no queue around it, so there is
// no Back/Next — just a Close that goes to the queue.

import { createAdminSupabaseClient } from "@/lib/db";
import SelfServeReviewCard, { type ReviewRow } from "@/components/SelfServeReviewCard";

interface GateRow {
  id: string;
  created_at: string;
  email: string;
  contact_name: string | null;
  dealership: string | null;
  phone: string | null;
  zip: string | null;
  account_kind: string;
  source_ip: string | null;
  decision: string;
  decision_reason: string | null;
  ai_verdict: string | null;
  ai_confidence: number | null;
  ai_reasons: string[] | null;
  ai_model: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

export default async function SelfServeReviewPage({ params }: { params: { token: string } }) {
  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row } = await (admin as any)
    .from("self_serve_signups")
    .select("*")
    .eq("review_token", params.token)
    .maybeSingle() as { data: GateRow | null };

  const shell = (inner: React.ReactNode) => (
    <div style={{ fontFamily: "Roboto, system-ui, sans-serif", maxWidth: 640, margin: "48px auto", padding: "0 20px" }}>
      {inner}
    </div>
  );

  if (!row) {
    return shell(
      <div className="card" style={{ padding: 24, border: "1px solid #e0e0e0", background: "#fff" }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>This review link is no longer valid</h1>
        <p style={{ color: "#666", fontSize: 14 }}>
          The signup has already been approved or denied, or the link was mistyped.
          Open <strong>Admin → Trial Signups</strong> to see the current queue.
        </p>
        <a href="/admin/trial-signups"
           style={{ display: "inline-flex", alignItems: "center", height: 34, padding: "0 16px", background: "#fff", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13, fontWeight: 600, color: "#333", textDecoration: "none" }}>
          Go to the queue
        </a>
      </div>,
    );
  }

  return shell(
    <div style={{ background: "#fff", border: "1px solid #e0e0e0", padding: 24 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase", color: "#888", margin: 0 }}>
            {row.decision === "pending_review" ? "Trial signup — held for review" : `Trial signup — ${row.decision}`}
          </p>
          <h1 style={{ fontSize: 22, margin: "6px 0 18px", overflowWrap: "anywhere" }}>{row.dealership ?? row.email}</h1>
        </div>
        {/* Close, even standalone: this used to be a dead end with no way back. */}
        <a href="/admin/trial-signups" aria-label="Close" title="Close — back to the queue"
           style={{ fontSize: 22, color: "#888", textDecoration: "none", lineHeight: 1, flexShrink: 0 }}>×</a>
      </div>

      <SelfServeReviewCard row={row as unknown as ReviewRow} />

      <div style={{ marginTop: 20, paddingTop: 14, borderTop: "1px solid #eee" }}>
        <a href="/admin/trial-signups"
           style={{ display: "inline-flex", alignItems: "center", height: 34, padding: "0 16px", background: "#fff", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13, fontWeight: 600, color: "#333", textDecoration: "none" }}>
          Close
        </a>
        <span style={{ fontSize: 12, color: "#888", marginLeft: 10 }}>
          Opened from a link — use the queue to page through the rest.
        </span>
      </div>
    </div>,
  );
}
